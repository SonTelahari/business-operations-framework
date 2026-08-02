const crypto = require("node:crypto");

const IDENTITY_SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
const MEMBERSHIP_SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;
const OAUTH_STATE_MAX_AGE_MINUTES = 10;

class DiscordIdentityStore {
  constructor({
    database,
    sessionSecret,
    clientId = "",
    clientSecret = "",
    redirectUri = "",
    apiBaseUrl = "https://discord.com/api/v10",
    authorizeUrl = "https://discord.com/oauth2/authorize",
    fetchImpl = globalThis.fetch
  }) {
    this.database = database;
    this.sessionSecret = String(sessionSecret || "");
    this.clientId = String(clientId || "").trim();
    this.clientSecret = String(clientSecret || "").trim();
    this.redirectUri = String(redirectUri || "").trim();
    this.apiBaseUrl = String(apiBaseUrl || "https://discord.com/api/v10").replace(/\/$/, "");
    this.authorizeUrl = String(authorizeUrl || "https://discord.com/oauth2/authorize");
    this.fetchImpl = fetchImpl;
  }

  get enabled() {
    return Boolean(this.database?.enabled && this.sessionSecret && this.clientId && this.clientSecret && this.redirectUri);
  }

  async beginAuthorization(returnTo = "/profile.html") {
    this.requireEnabled();
    const state = crypto.randomBytes(32).toString("base64url");
    const verifier = crypto.randomBytes(48).toString("base64url");
    const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
    await this.database.query("DELETE FROM oauth_states WHERE expires_at <= now()");
    await this.database.query(`
      INSERT INTO oauth_states (state_hash, code_verifier, return_to, expires_at)
      VALUES ($1, $2, $3, now() + interval '10 minutes')
    `, [hashState(state), verifier, cleanReturnTo(returnTo)]);
    const url = new URL(this.authorizeUrl);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", this.clientId);
    url.searchParams.set("redirect_uri", this.redirectUri);
    url.searchParams.set("scope", "identify");
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    return url.toString();
  }

  async completeAuthorization({ state, code }) {
    this.requireEnabled();
    const authorization = await this.consumeState(state);
    if (!authorization || !String(code || "").trim()) {
      throw identityError("Discord authorization expired or was not recognized", 400, "oauth_state_invalid");
    }
    const tokenResponse = await this.fetchImpl(`${this.apiBaseUrl}/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: String(code),
        client_id: this.clientId,
        client_secret: this.clientSecret,
        redirect_uri: this.redirectUri,
        code_verifier: authorization.codeVerifier
      })
    });
    const token = await readDiscordResponse(tokenResponse, "Discord did not accept the authorization code");
    if (!token.access_token) throw identityError("Discord did not return an access token", 502, "oauth_token_missing");
    const userResponse = await this.fetchImpl(`${this.apiBaseUrl}/users/@me`, {
      headers: { authorization: `Bearer ${token.access_token}`, accept: "application/json" }
    });
    const profile = await readDiscordResponse(userResponse, "Discord profile lookup failed");
    const identity = await this.upsertDiscordIdentity(profile);
    return { identity, returnTo: authorization.returnTo };
  }

  async consumeState(state) {
    const stateHash = hashState(String(state || ""));
    return this.database.transaction(async client => {
      const result = await client.query(`
        DELETE FROM oauth_states
        WHERE state_hash = $1 AND expires_at > now()
        RETURNING code_verifier, return_to
      `, [stateHash]);
      const row = result.rows[0];
      return row ? { codeVerifier: row.code_verifier, returnTo: cleanReturnTo(row.return_to) } : null;
    });
  }

  async upsertDiscordIdentity(profile) {
    const discordUserId = cleanDiscordUserId(profile?.id);
    const username = cleanShortText(profile?.username, 100);
    if (!discordUserId || !username) {
      throw identityError("Discord returned an incomplete profile", 502, "discord_profile_invalid");
    }
    const result = await this.database.query(`
      INSERT INTO discord_identities (
        id, discord_user_id, username, global_name, avatar_hash, last_login_at, metadata
      ) VALUES ($1, $2, $3, $4, $5, now(), $6::jsonb)
      ON CONFLICT (discord_user_id) DO UPDATE SET
        username = EXCLUDED.username,
        global_name = EXCLUDED.global_name,
        avatar_hash = EXCLUDED.avatar_hash,
        updated_at = now(),
        last_login_at = now(),
        metadata = EXCLUDED.metadata
      RETURNING *
    `, [
      crypto.randomUUID(),
      discordUserId,
      username,
      cleanShortText(profile?.global_name, 100),
      cleanShortText(profile?.avatar, 200),
      JSON.stringify({ discriminator: cleanShortText(profile?.discriminator, 10) })
    ]);
    return publicIdentity(result.rows[0]);
  }

  async getIdentity(identityId) {
    const result = await this.database.query(
      "SELECT * FROM discord_identities WHERE id = $1 AND status = 'active'",
      [String(identityId || "")]
    );
    return result.rows[0] ? publicIdentity(result.rows[0]) : null;
  }

  createIdentitySession(identity) {
    return signSession({
      kind: "discord_identity",
      identityId: identity.id,
      expiresAt: Date.now() + IDENTITY_SESSION_MAX_AGE_SECONDS * 1000
    }, this.sessionSecret);
  }

  async verifyIdentitySession(token) {
    const payload = verifySession(token, this.sessionSecret, "discord_identity");
    return payload ? this.getIdentity(payload.identityId) : null;
  }

  createMembershipSession(membership) {
    return signSession({
      kind: "discord_membership",
      identityId: membership.identityId,
      membershipId: membership.id,
      businessId: membership.businessId,
      expiresAt: Date.now() + MEMBERSHIP_SESSION_MAX_AGE_SECONDS * 1000
    }, this.sessionSecret);
  }

  readMembershipSession(token) {
    return verifySession(token, this.sessionSecret, "discord_membership");
  }

  async authenticateMembershipSession(token) {
    const payload = this.readMembershipSession(token);
    if (!payload) return null;
    return this.getActiveMembership(payload.identityId, payload.membershipId, payload.businessId);
  }

  async listProfile(identityId) {
    const identity = await this.getIdentity(identityId);
    if (!identity) throw identityError("Discord account is unavailable", 401, "identity_unavailable");
    const characters = await this.database.query(`
      SELECT * FROM identity_characters
      WHERE identity_id = $1
      ORDER BY status, name
    `, [identityId]);
    const memberships = await this.database.query(`
      SELECT m.*, c.identity_id, c.name AS character_name, c.setting_name,
             b.workspace_code, b.name AS business_name, b.reference_id
      FROM business_memberships m
      JOIN identity_characters c ON c.id = m.character_id
      JOIN businesses b ON b.id = m.business_id
      WHERE c.identity_id = $1 AND b.status = 'active'
      ORDER BY b.name, c.name
    `, [identityId]);
    return {
      identity,
      characters: characters.rows.map(publicCharacter),
      memberships: memberships.rows.map(publicMembership)
    };
  }

  async createCharacter(identityId, input = {}) {
    const name = validateCharacterName(input.name);
    const result = await this.database.query(`
      INSERT INTO identity_characters (
        id, identity_id, name, normalized_name, setting_name, metadata
      ) VALUES ($1, $2, $3, $4, $5, $6::jsonb)
      RETURNING *
    `, [
      crypto.randomUUID(),
      identityId,
      name,
      normalizeName(name),
      cleanShortText(input.settingName, 100),
      JSON.stringify(cleanMetadata(input.metadata))
    ]).catch(error => {
      if (error.code === "23505" || /unique/i.test(error.message)) {
        throw identityError("That character already exists in your profile", 409, "character_name_taken");
      }
      throw error;
    });
    return publicCharacter(result.rows[0]);
  }

  async updateCharacter(identityId, characterId, input = {}) {
    const name = validateCharacterName(input.name);
    const result = await this.database.query(`
      UPDATE identity_characters
      SET name = $3, normalized_name = $4, setting_name = $5, updated_at = now()
      WHERE id = $1 AND identity_id = $2 AND status = 'active'
      RETURNING *
    `, [characterId, identityId, name, normalizeName(name), cleanShortText(input.settingName, 100)]).catch(error => {
      if (error.code === "23505" || /unique/i.test(error.message)) {
        throw identityError("That character already exists in your profile", 409, "character_name_taken");
      }
      throw error;
    });
    if (!result.rows[0]) throw identityError("Character not found", 404, "character_not_found");
    return publicCharacter(result.rows[0]);
  }

  async archiveCharacter(identityId, characterId) {
    const memberships = await this.database.query(`
      SELECT 1 FROM business_memberships
      WHERE character_id = $1 AND status IN ('pending', 'active')
    `, [characterId]);
    if (memberships.rowCount) {
      throw identityError("Leave or disable this character's business memberships before archiving it", 409, "character_in_use");
    }
    const result = await this.database.query(`
      UPDATE identity_characters
      SET status = 'archived', updated_at = now()
      WHERE id = $1 AND identity_id = $2
      RETURNING *
    `, [characterId, identityId]);
    if (!result.rows[0]) throw identityError("Character not found", 404, "character_not_found");
    return publicCharacter(result.rows[0]);
  }

  async requestMembership(identityId, characterId, workspaceCode) {
    const membershipId = await this.database.transaction(async client => {
      const business = await client.query(
        "SELECT id FROM businesses WHERE upper(workspace_code) = $1 AND status = 'active'",
        [normalizeWorkspaceCode(workspaceCode)]
      );
      const character = await client.query(`
        SELECT id FROM identity_characters
        WHERE id = $1 AND identity_id = $2 AND status = 'active'
      `, [characterId, identityId]);
      if (!business.rows[0] || !character.rows[0]) {
        throw identityError("Workspace or character was not found", 404, "membership_target_not_found");
      }
      const result = await client.query(`
        INSERT INTO business_memberships (id, business_id, character_id, role, status)
        VALUES ($1, $2, $3, 'employee', 'pending')
        ON CONFLICT (business_id, character_id) DO UPDATE SET
          status = CASE WHEN business_memberships.status = 'rejected' THEN 'pending' ELSE business_memberships.status END,
          requested_at = CASE WHEN business_memberships.status = 'rejected' THEN now() ELSE business_memberships.requested_at END,
          updated_at = now()
        RETURNING id
      `, [crypto.randomUUID(), business.rows[0].id, character.rows[0].id]);
      return result.rows[0].id;
    });
    return this.getMembershipForIdentity(identityId, membershipId);
  }

  async activateLinkedMembership({ identityId, characterId, businessId, role, localUserId }) {
    const character = await this.database.query(`
      SELECT id FROM identity_characters
      WHERE id = $1 AND identity_id = $2 AND status = 'active'
    `, [characterId, identityId]);
    if (!character.rows[0]) throw identityError("Character not found", 404, "character_not_found");
    const result = await this.database.query(`
      INSERT INTO business_memberships (
        id, business_id, character_id, role, status, approved_at, approved_by, metadata
      ) VALUES ($1, $2, $3, $4, 'active', now(), 'Linked local account', $5::jsonb)
      ON CONFLICT (business_id, character_id) DO UPDATE SET
        role = EXCLUDED.role,
        status = 'active',
        approved_at = now(),
        approved_by = EXCLUDED.approved_by,
        metadata = EXCLUDED.metadata,
        updated_at = now()
      RETURNING id
    `, [
      crypto.randomUUID(), businessId, characterId, role,
      JSON.stringify({ localUserId: String(localUserId || "") })
    ]);
    return this.getMembershipForIdentity(identityId, result.rows[0].id);
  }

  async getMembershipForIdentity(identityId, membershipId) {
    const result = await this.database.query(`${membershipSelect()}
      WHERE m.id = $1 AND c.identity_id = $2
    `, [membershipId, identityId]);
    return result.rows[0] ? publicMembership(result.rows[0]) : null;
  }

  async getActiveMembership(identityId, membershipId, businessId) {
    const result = await this.database.query(`${membershipSelect()}
      WHERE m.id = $1 AND c.identity_id = $2 AND m.business_id = $3
        AND m.status = 'active' AND c.status = 'active'
        AND i.status = 'active' AND b.status = 'active'
    `, [membershipId, identityId, businessId]);
    return result.rows[0] ? publicAuthenticatedMembership(result.rows[0]) : null;
  }

  async recordMembershipLogin(identityId, membershipId, businessId) {
    const membership = await this.getActiveMembership(identityId, membershipId, businessId);
    if (!membership) return null;
    const result = await this.database.query(`
      UPDATE business_memberships
      SET last_login_at = now(), updated_at = now()
      WHERE id = $1 AND business_id = $2 AND status = 'active'
      RETURNING last_login_at
    `, [membershipId, businessId]);
    if (!result.rows[0]) return null;
    return { ...membership, lastLoginAt: dateText(result.rows[0].last_login_at) };
  }

  async listBusinessMemberships(businessId) {
    const result = await this.database.query(`${membershipSelect()}
      WHERE m.business_id = $1 AND m.status <> 'rejected'
      ORDER BY CASE m.status WHEN 'pending' THEN 0 WHEN 'active' THEN 1 ELSE 2 END, c.name
    `, [businessId]);
    return result.rows.map(publicMembershipUser);
  }

  async getBusinessMembership(businessId, membershipId) {
    const result = await this.database.query(`${membershipSelect()}
      WHERE m.business_id = $1 AND m.id = $2
    `, [businessId, membershipId]);
    return result.rows[0] ? publicMembershipUser(result.rows[0]) : null;
  }

  async manageMembership(businessId, membershipId, action, actor) {
    const target = await this.getBusinessMembership(businessId, membershipId);
    if (!target) throw identityError("Membership not found", 404, "membership_not_found");
    if (target.id === actor.id) throw identityError("You cannot change your own membership", 400, "self_membership_change");
    if (actor.role !== "admin" && !(actor.role === "manager" && target.role === "employee")) {
      throw identityError("You cannot manage this membership", 403, "staff_access_denied");
    }
    let status = target.status;
    let role = target.role;
    if (action === "approve") status = "active";
    else if (action === "disable") status = "disabled";
    else if (action === "reject") {
      if (status !== "pending") throw identityError("Only pending requests can be rejected", 400, "not_pending");
      status = "rejected";
    } else if (action === "promote" || action === "demote") {
      if (actor.role !== "admin") throw identityError("Admin access required to change roles", 403, "admin_required");
      if (status !== "active") throw identityError("Only active memberships can change roles", 400, "inactive_role_change");
      if (target.role === "admin") throw identityError("Admin memberships cannot be changed here", 400, "admin_role_change");
      role = action === "promote" ? "manager" : "employee";
    } else {
      throw identityError("Unsupported membership action", 400, "membership_action_invalid");
    }
    const result = await this.database.query(`
      UPDATE business_memberships
      SET status = $3, role = $4,
          approved_at = CASE WHEN $3 = 'active' THEN now() ELSE approved_at END,
          approved_by = CASE WHEN $3 = 'active' THEN $5 ELSE approved_by END,
          updated_at = now()
      WHERE business_id = $1 AND id = $2
      RETURNING *
    `, [businessId, membershipId, status, role, actor.fullName]);
    if (!result.rows[0]) throw identityError("Membership not found", 404, "membership_not_found");
    return this.getBusinessMembership(businessId, membershipId);
  }

  requireEnabled() {
    if (!this.enabled) throw identityError("Discord login is not configured", 503, "discord_login_unavailable");
  }
}

function membershipSelect() {
  return `
    SELECT m.*, c.identity_id, c.name AS character_name, c.setting_name,
           i.discord_user_id, i.username AS discord_username, i.global_name, i.avatar_hash,
           b.workspace_code, b.name AS business_name, b.reference_id
    FROM business_memberships m
    JOIN identity_characters c ON c.id = m.character_id
    JOIN discord_identities i ON i.id = c.identity_id
    JOIN businesses b ON b.id = m.business_id
  `;
}

function publicIdentity(row) {
  return {
    id: String(row.id || ""),
    discordUserId: String(row.discord_user_id || row.discordUserId || ""),
    username: String(row.username || ""),
    globalName: String(row.global_name || row.globalName || ""),
    avatarHash: String(row.avatar_hash || row.avatarHash || ""),
    avatarUrl: discordAvatarUrl(row.discord_user_id || row.discordUserId, row.avatar_hash || row.avatarHash),
    status: String(row.status || "active"),
    createdAt: dateText(row.created_at || row.createdAt),
    lastLoginAt: dateText(row.last_login_at || row.lastLoginAt)
  };
}

function publicCharacter(row) {
  return {
    id: String(row.id || ""),
    name: String(row.name || ""),
    settingName: String(row.setting_name || row.settingName || ""),
    status: String(row.status || "active"),
    createdAt: dateText(row.created_at || row.createdAt),
    updatedAt: dateText(row.updated_at || row.updatedAt)
  };
}

function publicMembership(row) {
  return {
    id: String(row.id || ""),
    businessId: String(row.business_id || row.businessId || ""),
    characterId: String(row.character_id || row.characterId || ""),
    identityId: String(row.identity_id || row.identityId || ""),
    characterName: String(row.character_name || row.characterName || ""),
    settingName: String(row.setting_name || row.settingName || ""),
    businessName: String(row.business_name || row.businessName || ""),
    workspaceCode: String(row.workspace_code || row.workspaceCode || ""),
    referenceId: String(row.reference_id || row.referenceId || ""),
    role: String(row.role || "employee"),
    status: String(row.status || "pending"),
    requestedAt: dateText(row.requested_at || row.requestedAt),
    approvedAt: dateText(row.approved_at || row.approvedAt),
    approvedBy: String(row.approved_by || row.approvedBy || "")
  };
}

function publicMembershipUser(row) {
  const membership = publicMembership(row);
  const metadata = row.metadata && typeof row.metadata === "object" ? row.metadata : {};
  return {
    id: membership.id,
    fullName: membership.characterName,
    role: membership.role,
    status: membership.status,
    createdAt: membership.requestedAt,
    approvedAt: membership.approvedAt,
    approvedBy: membership.approvedBy,
    lastLoginAt: dateText(row.last_login_at || row.lastLoginAt),
    accountType: "discord",
    identityId: membership.identityId,
    characterId: membership.characterId,
    discordUserId: String(row.discord_user_id || ""),
    discordUsername: String(row.discord_username || ""),
    discordGlobalName: String(row.global_name || ""),
    avatarUrl: discordAvatarUrl(row.discord_user_id, row.avatar_hash),
    settingName: membership.settingName,
    localUserId: String(metadata.localUserId || "")
  };
}

function publicAuthenticatedMembership(row) {
  const user = publicMembershipUser(row);
  return {
    ...user,
    businessId: String(row.business_id || ""),
    membershipId: user.id,
    accountManagement: true
  };
}

function signSession(payload, secret) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${encoded}.${sign(encoded, secret)}`;
}

function verifySession(token, secret, expectedKind) {
  if (!token || !String(token).includes(".") || !secret) return null;
  const [payload, signature] = String(token).split(".", 2);
  if (!safeEqual(signature, sign(payload, secret))) return null;
  try {
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (decoded.kind !== expectedKind || Number(decoded.expiresAt || 0) <= Date.now()) return null;
    return decoded;
  } catch {
    return null;
  }
}

function sign(payload, secret) {
  return crypto.createHmac("sha256", secret).update(payload).digest("base64url");
}

function safeEqual(actual, expected) {
  const left = Buffer.from(String(actual));
  const right = Buffer.from(String(expected));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function hashState(state) {
  return crypto.createHash("sha256").update(String(state || "")).digest("hex");
}

async function readDiscordResponse(response, fallbackMessage) {
  const text = await response.text();
  let payload = {};
  try { payload = text ? JSON.parse(text) : {}; } catch { payload = {}; }
  if (!response.ok) {
    throw identityError(cleanShortText(payload.error_description || payload.message, 200) || fallbackMessage, 502, "discord_oauth_failed");
  }
  return payload;
}

function validateCharacterName(value) {
  const cleaned = String(value || "").trim().replace(/\s+/g, " ");
  if (cleaned.length < 3 || cleaned.length > 80 || !cleaned.includes(" ")) {
    throw identityError("Enter the character's first and last name", 400, "character_name_invalid");
  }
  return cleaned;
}

function normalizeWorkspaceCode(value) {
  const compact = String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 10);
  if (compact === "PRIMARY") return "PRIMARY";
  return compact.length === 10 ? `${compact.slice(0, 5)}-${compact.slice(5)}` : compact;
}

function normalizeName(value) {
  return String(value || "").trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}

function cleanDiscordUserId(value) {
  const cleaned = String(value || "").trim();
  return /^\d{15,22}$/.test(cleaned) || cleaned.startsWith("test-") ? cleaned : "";
}

function cleanReturnTo(value) {
  const cleaned = String(value || "");
  return cleaned.startsWith("/") && !cleaned.startsWith("//") ? cleaned.slice(0, 300) : "/profile.html";
}

function cleanShortText(value, maximum) {
  return String(value || "").trim().slice(0, maximum);
}

function cleanMetadata(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).slice(0, 20).map(([key, entry]) => [
    cleanShortText(key, 60),
    typeof entry === "boolean" || typeof entry === "number" ? entry : cleanShortText(entry, 300)
  ]));
}

function discordAvatarUrl(userId, avatarHash) {
  return userId && avatarHash ? `https://cdn.discordapp.com/avatars/${userId}/${avatarHash}.png?size=128` : "";
}

function dateText(value) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

function identityError(message, status, code) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

module.exports = {
  DiscordIdentityStore,
  IDENTITY_SESSION_MAX_AGE_SECONDS,
  MEMBERSHIP_SESSION_MAX_AGE_SECONDS,
  identityError,
  publicIdentity,
  publicMembership,
  verifySession
};
