const crypto = require("node:crypto");

const LOCAL_IDENTITY_SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

class LocalIdentityStore {
  constructor({ database, tenantManager, sessionSecret }) {
    this.database = database;
    this.tenantManager = tenantManager;
    this.sessionSecret = String(sessionSecret || "");
  }

  get enabled() {
    return Boolean(this.database?.enabled && this.tenantManager && this.sessionSecret);
  }

  async ensureIdentityForUser(businessId, localUserId) {
    this.requireEnabled();
    const cleanBusinessId = requiredId(businessId, "Business workspace is required");
    const cleanUserId = requiredId(localUserId, "Local account is required");
    const identityId = await this.database.transaction(async client => {
      const existing = await client.query(`
        SELECT i.id
        FROM local_identity_memberships m
        JOIN local_identities i ON i.id = m.identity_id
        WHERE m.business_id = $1 AND m.local_user_id = $2 AND i.status = 'active'
      `, [cleanBusinessId, cleanUserId]);
      if (existing.rows[0]) {
        await client.query(
          "UPDATE local_identities SET last_login_at = now(), updated_at = now() WHERE id = $1",
          [existing.rows[0].id]
        );
        return existing.rows[0].id;
      }

      const id = crypto.randomUUID();
      await client.query("INSERT INTO local_identities (id) VALUES ($1)", [id]);
      await client.query(`
        INSERT INTO local_identity_memberships (identity_id, business_id, local_user_id)
        VALUES ($1, $2, $3)
      `, [id, cleanBusinessId, cleanUserId]);
      return id;
    });
    return this.getIdentity(identityId);
  }

  async resolveIdentityForUser(token, businessId, localUserId) {
    const identity = await this.verifySession(token);
    if (identity && await this.hasMembership(identity.id, businessId, localUserId)) return identity;
    return this.ensureIdentityForUser(businessId, localUserId);
  }

  async getIdentity(identityId) {
    const result = await this.database.query(`
      SELECT id, status, created_at, updated_at, last_login_at
      FROM local_identities
      WHERE id = $1 AND status = 'active'
    `, [String(identityId || "")]);
    return result.rows[0] ? publicIdentity(result.rows[0]) : null;
  }

  createSession(identity) {
    return signSession({
      kind: "local_identity",
      identityId: identity.id,
      expiresAt: Date.now() + LOCAL_IDENTITY_SESSION_MAX_AGE_SECONDS * 1000
    }, this.sessionSecret);
  }

  async verifySession(token) {
    const payload = verifySession(token, this.sessionSecret, "local_identity");
    return payload ? this.getIdentity(payload.identityId) : null;
  }

  async hasMembership(identityId, businessId, localUserId) {
    const result = await this.database.query(`
      SELECT 1
      FROM local_identity_memberships
      WHERE identity_id = $1 AND business_id = $2 AND local_user_id = $3
    `, [String(identityId || ""), String(businessId || ""), String(localUserId || "")]);
    return Boolean(result.rowCount);
  }

  async linkJob(identityId, businessId, localUserId) {
    this.requireEnabled();
    const cleanIdentityId = requiredId(identityId, "Personal job profile is required");
    const cleanBusinessId = requiredId(businessId, "Business workspace is required");
    const cleanUserId = requiredId(localUserId, "Local account is required");

    await this.database.transaction(async client => {
      const identity = await client.query(
        "SELECT id FROM local_identities WHERE id = $1 AND status = 'active'",
        [cleanIdentityId]
      );
      if (!identity.rowCount) throw localIdentityError("Personal job profile is unavailable", 401, "local_identity_unavailable");

      const currentBusinessJob = await client.query(`
        SELECT local_user_id
        FROM local_identity_memberships
        WHERE identity_id = $1 AND business_id = $2
      `, [cleanIdentityId, cleanBusinessId]);
      if (currentBusinessJob.rows[0] && currentBusinessJob.rows[0].local_user_id !== cleanUserId) {
        throw localIdentityError(
          "This profile already has a different job at that business",
          409,
          "job_business_already_linked"
        );
      }

      const target = await client.query(`
        SELECT identity_id
        FROM local_identity_memberships
        WHERE business_id = $1 AND local_user_id = $2
      `, [cleanBusinessId, cleanUserId]);
      const previousIdentityId = String(target.rows[0]?.identity_id || "");
      if (previousIdentityId === cleanIdentityId) return;

      if (previousIdentityId) {
        await client.query(`
          UPDATE local_identity_memberships
          SET identity_id = $3, updated_at = now()
          WHERE business_id = $1 AND local_user_id = $2
        `, [cleanBusinessId, cleanUserId, cleanIdentityId]);
        await client.query(`
          DELETE FROM local_identities
          WHERE id = $1
            AND NOT EXISTS (
              SELECT 1 FROM local_identity_memberships WHERE identity_id = $1
            )
        `, [previousIdentityId]);
      } else {
        await client.query(`
          INSERT INTO local_identity_memberships (identity_id, business_id, local_user_id)
          VALUES ($1, $2, $3)
        `, [cleanIdentityId, cleanBusinessId, cleanUserId]);
      }
      await client.query(
        "UPDATE local_identities SET updated_at = now() WHERE id = $1",
        [cleanIdentityId]
      );
    });

    return this.getJob(cleanIdentityId, cleanBusinessId);
  }

  async listJobs(identityId) {
    this.requireEnabled();
    const result = await this.database.query(`
      SELECT m.business_id, m.local_user_id, m.linked_at,
             b.workspace_code, b.name AS business_name, b.reference_id
      FROM local_identity_memberships m
      JOIN local_identities i ON i.id = m.identity_id
      JOIN businesses b ON b.id = m.business_id
      WHERE m.identity_id = $1 AND i.status = 'active' AND b.status = 'active'
      ORDER BY b.name, b.workspace_code
    `, [String(identityId || "")]);
    const jobs = await Promise.all(result.rows.map(async row => {
      const context = await this.tenantManager.getContextById(row.business_id);
      const user = context?.accountStore.getUserById(row.local_user_id);
      if (!context || !user) return null;
      return publicJob(row, user);
    }));
    return jobs.filter(Boolean);
  }

  async getJob(identityId, businessId) {
    const jobs = await this.listJobs(identityId);
    return jobs.find(job => job.businessId === String(businessId || "")) || null;
  }

  async getActiveJob(identityId, businessId) {
    const job = await this.getJob(identityId, businessId);
    return job?.status === "active" ? job : null;
  }

  requireEnabled() {
    if (!this.enabled) throw localIdentityError("Personal job profiles are unavailable", 503, "local_identity_disabled");
  }
}

function publicIdentity(row) {
  return {
    id: String(row.id || ""),
    status: String(row.status || "active"),
    createdAt: dateText(row.created_at || row.createdAt),
    updatedAt: dateText(row.updated_at || row.updatedAt),
    lastLoginAt: dateText(row.last_login_at || row.lastLoginAt)
  };
}

function publicJob(row, user) {
  return {
    id: `local:${row.business_id}:${row.local_user_id}`,
    accountType: "local",
    businessId: String(row.business_id || ""),
    workspaceCode: String(row.workspace_code || ""),
    businessName: String(row.business_name || ""),
    referenceId: String(row.reference_id || ""),
    userId: String(row.local_user_id || ""),
    fullName: String(user.fullName || ""),
    role: String(user.role || "employee"),
    status: String(user.status || "disabled"),
    linkedAt: dateText(row.linked_at)
  };
}

function signSession(payload, secret) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${encoded}.${sign(encoded, secret)}`;
}

function verifySession(token, secret, kind) {
  if (!token || !String(token).includes(".") || !secret) return null;
  const [payload, signature] = String(token).split(".", 2);
  if (!safeEqual(signature, sign(payload, secret))) return null;
  try {
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (decoded.kind !== kind || Number(decoded.expiresAt || 0) <= Date.now()) return null;
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

function requiredId(value, message) {
  const cleaned = String(value || "").trim();
  if (!cleaned) throw localIdentityError(message, 400, "identity_target_required");
  return cleaned;
}

function dateText(value) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : "";
}

function localIdentityError(message, status, code) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

module.exports = {
  LocalIdentityStore,
  LOCAL_IDENTITY_SESSION_MAX_AGE_SECONDS,
  localIdentityError
};
