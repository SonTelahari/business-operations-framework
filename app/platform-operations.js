const crypto = require("node:crypto");

const INVITE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

class PlatformOperations {
  constructor({ database, secret }) {
    if (!database?.enabled) throw new Error("Platform operations require PostgreSQL");
    this.database = database;
    this.secret = String(secret || "");
  }

  get enabled() {
    return this.secret.length >= 24;
  }

  async createInvite(input = {}, actor = "Service operator") {
    this.requireEnabled();
    const id = crypto.randomUUID();
    const code = generateInviteCode();
    const label = cleanText(input.label, 120) || "Beta workspace invitation";
    const maxUses = Math.min(25, Math.max(1, Math.trunc(Number(input.maxUses) || 1)));
    const expiresAt = cleanFutureDate(input.expiresAt);
    await this.database.transaction(async client => {
      await client.query(`
        INSERT INTO beta_invites (
          id, code_hash, code_hint, label, max_uses, expires_at, metadata
        ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
      `, [id, this.hashInvite(code), code.slice(-4), label, maxUses, expiresAt, JSON.stringify({ beta: true })]);
      await insertAudit(client, {
        actor,
        action: "invite.created",
        details: { inviteId: id, label, maxUses, expiresAt: expiresAt || "" }
      });
    });
    return { id, code, codeHint: code.slice(-4), label, maxUses, useCount: 0, status: "active", expiresAt };
  }

  async listInvites() {
    const result = await this.database.query(`
      SELECT *
      FROM beta_invites
      ORDER BY created_at DESC
      LIMIT 250
    `);
    return result.rows.map(publicInvite);
  }

  async reserveInvite(code) {
    this.requireEnabled();
    const codeHash = this.hashInvite(code);
    const result = await this.database.query(`
      UPDATE beta_invites
      SET use_count = use_count + 1,
          last_used_at = now(),
          updated_at = now(),
          status = CASE WHEN use_count + 1 >= max_uses THEN 'exhausted' ELSE status END
      WHERE code_hash = $1
        AND status = 'active'
        AND use_count < max_uses
        AND (expires_at IS NULL OR expires_at > now())
      RETURNING id, label, max_uses, use_count, expires_at, status
    `, [codeHash]);
    if (!result.rowCount) throw platformError("The business invitation code is invalid or has already been used", 403, "workspace_invite_invalid");
    return {
      id: result.rows[0].id,
      label: result.rows[0].label,
      maxUses: Number(result.rows[0].max_uses),
      useCount: Number(result.rows[0].use_count),
      expiresAt: result.rows[0].expires_at ? new Date(result.rows[0].expires_at).toISOString() : "",
      status: result.rows[0].status
    };
  }

  async releaseInvite(inviteId) {
    if (!inviteId) return;
    await this.database.query(`
      UPDATE beta_invites
      SET use_count = GREATEST(0, use_count - 1),
          status = CASE WHEN status = 'exhausted' THEN 'active' ELSE status END,
          updated_at = now()
      WHERE id = $1
    `, [inviteId]);
  }

  async redeemInvite(inviteId, business, actor = "Workspace signup") {
    if (!inviteId || !business?.id) return;
    await this.database.transaction(async client => {
      await client.query(`
        INSERT INTO beta_invite_redemptions (id, invite_id, business_id, metadata)
        VALUES ($1, $2, $3, $4::jsonb)
        ON CONFLICT (business_id) DO NOTHING
      `, [crypto.randomUUID(), inviteId, business.id, JSON.stringify({ workspaceCode: business.workspaceCode })]);
      await insertAudit(client, {
        actor,
        action: "workspace.created",
        businessId: business.id,
        details: { inviteId, workspaceCode: business.workspaceCode, name: business.name }
      });
    });
  }

  async revokeInvite(inviteId, actor = "Service operator") {
    const result = await this.database.query(`
      UPDATE beta_invites SET status = 'revoked', updated_at = now()
      WHERE id = $1 AND status <> 'revoked'
      RETURNING *
    `, [cleanId(inviteId)]);
    if (!result.rowCount) throw platformError("Invitation was not found or is already revoked", 404, "invite_not_found");
    await this.recordAudit({ actor, action: "invite.revoked", details: { inviteId: result.rows[0].id } });
    return publicInvite(result.rows[0]);
  }

  async listWorkspaces() {
    const [businesses, catalogCounts, memberCounts, documentUpdates, webhookUpdates] = await Promise.all([
      this.database.query(`
        SELECT id, workspace_code, name, reference_id, status, created_at, updated_at, metadata
        FROM businesses
        ORDER BY created_at DESC
      `),
      this.database.query("SELECT business_id, COUNT(*)::int AS count FROM catalog_items GROUP BY business_id"),
      this.database.query("SELECT business_id, COUNT(*)::int AS count FROM business_memberships WHERE status = 'active' GROUP BY business_id"),
      this.database.query("SELECT business_id, MAX(updated_at) AS last_at FROM tenant_documents GROUP BY business_id"),
      this.database.query("SELECT business_id, MAX(recorded_at) AS last_at FROM webhook_events GROUP BY business_id")
    ]);
    const catalog = keyedNumber(catalogCounts.rows, "count");
    const members = keyedNumber(memberCounts.rows, "count");
    const documents = keyedDate(documentUpdates.rows);
    const webhooks = keyedDate(webhookUpdates.rows);
    return businesses.rows.map(row => ({
      id: String(row.id),
      code: String(row.workspace_code),
      name: String(row.name),
      referenceId: String(row.reference_id || ""),
      status: String(row.status),
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
      lastActivityAt: latestDate(row.updated_at, documents.get(row.id), webhooks.get(row.id)),
      catalogItems: catalog.get(row.id) || 0,
      activeDiscordMembers: members.get(row.id) || 0,
      continuity: String(row.metadata?.dataLifecycle || "persistent")
    }));
  }

  async setWorkspaceStatus(businessId, status, actor = "Service operator", reason = "") {
    if (!new Set(["active", "suspended"]).has(status)) throw platformError("Workspace status is invalid", 400, "workspace_status_invalid");
    const result = await this.database.query(`
      UPDATE businesses SET status = $2, updated_at = now()
      WHERE id = $1 AND status IN ('active', 'suspended')
      RETURNING id, workspace_code, name, reference_id, status, created_at, updated_at
    `, [cleanId(businessId), status]);
    if (!result.rowCount) throw platformError("Workspace was not found", 404, "workspace_not_found");
    await this.recordAudit({
      actor,
      action: status === "suspended" ? "workspace.suspended" : "workspace.reactivated",
      businessId,
      details: { reason: cleanText(reason, 300), workspaceCode: result.rows[0].workspace_code }
    });
    return {
      id: result.rows[0].id,
      code: result.rows[0].workspace_code,
      name: result.rows[0].name,
      status: result.rows[0].status,
      updatedAt: iso(result.rows[0].updated_at)
    };
  }

  async listAudit(limit = 200) {
    const safeLimit = Math.min(500, Math.max(1, Number(limit) || 200));
    const result = await this.database.query(`
      SELECT id, occurred_at, actor, action, business_id, details
      FROM platform_audit_events
      ORDER BY occurred_at DESC
      LIMIT $1
    `, [safeLimit]);
    return result.rows.map(row => ({
      id: row.id,
      occurredAt: iso(row.occurred_at),
      actor: row.actor,
      action: row.action,
      businessId: row.business_id || "",
      details: row.details || {}
    }));
  }

  async recordAudit(event) {
    await this.database.transaction(client => insertAudit(client, event));
  }

  hashInvite(code) {
    const normalized = normalizeInviteCode(code);
    if (!normalized) return "";
    return crypto.createHmac("sha256", this.secret).update(normalized).digest("hex");
  }

  requireEnabled() {
    if (!this.enabled) throw platformError("Platform operator access is not configured", 503, "operator_unavailable");
  }
}

async function insertAudit(client, event = {}) {
  await client.query(`
    INSERT INTO platform_audit_events (id, actor, action, business_id, details)
    VALUES ($1, $2, $3, $4, $5::jsonb)
  `, [
    crypto.randomUUID(),
    cleanText(event.actor, 120) || "Service operator",
    cleanText(event.action, 100) || "platform.action",
    cleanText(event.businessId, 100) || null,
    JSON.stringify(cleanDetails(event.details))
  ]);
}

function generateInviteCode() {
  const bytes = crypto.randomBytes(12);
  let value = "";
  for (let index = 0; index < 12; index += 1) value += INVITE_ALPHABET[bytes[index] % INVITE_ALPHABET.length];
  return `BETA-${value.slice(0, 4)}-${value.slice(4, 8)}-${value.slice(8)}`;
}

function normalizeInviteCode(value) {
  return String(value || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 80);
}

function cleanFutureDate(value) {
  if (!String(value || "").trim()) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.getTime() <= Date.now()) {
    throw platformError("Invitation expiry must be in the future", 400, "invite_expiry_invalid");
  }
  return date.toISOString();
}

function publicInvite(row) {
  return {
    id: String(row.id),
    codeHint: String(row.code_hint || row.codeHint || ""),
    label: String(row.label || ""),
    status: String(row.status || "active"),
    maxUses: Number(row.max_uses ?? row.maxUses ?? 1),
    useCount: Number(row.use_count ?? row.useCount ?? 0),
    redemptions: Number(row.redemption_count ?? row.redemptions ?? 0),
    expiresAt: row.expires_at || row.expiresAt ? iso(row.expires_at || row.expiresAt) : "",
    createdAt: row.created_at || row.createdAt ? iso(row.created_at || row.createdAt) : "",
    lastUsedAt: row.last_used_at || row.lastUsedAt ? iso(row.last_used_at || row.lastUsedAt) : ""
  };
}

function keyedNumber(rows, field) {
  return new Map(rows.map(row => [row.business_id, Number(row[field]) || 0]));
}

function keyedDate(rows) {
  return new Map(rows.map(row => [row.business_id, row.last_at ? iso(row.last_at) : ""]));
}

function latestDate(...values) {
  const valid = values.map(value => new Date(value || 0)).filter(value => Number.isFinite(value.getTime()));
  return valid.length ? new Date(Math.max(...valid.map(value => value.getTime()))).toISOString() : "";
}

function cleanDetails(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).slice(0, 30).map(([key, entry]) => [
    cleanText(key, 60),
    typeof entry === "boolean" || typeof entry === "number" ? entry : cleanText(entry, 500)
  ]));
}

function cleanText(value, maxLength) {
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, maxLength);
}

function cleanId(value) {
  return cleanText(value, 100);
}

function iso(value) {
  const date = new Date(value || 0);
  return Number.isFinite(date.getTime()) ? date.toISOString() : "";
}

function platformError(message, status, code) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

module.exports = { PlatformOperations, normalizeInviteCode, platformError };
