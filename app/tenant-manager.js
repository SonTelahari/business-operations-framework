const crypto = require("node:crypto");
const { AccountStore } = require("./auth");
const { BusinessStore } = require("./business-store");
const { TenantDocumentRepository } = require("./database");
const { StandaloneStore } = require("./standalone-store");
const { normalizeSetupPayload } = require("./setup-config");
const { createBusinessArchive, validateBusinessArchive } = require("./business-archive");

const WORKSPACE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const WORKSPACE_CODE_LENGTH = 10;
const BUSINESS_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

class TenantManager {
  constructor({ database, sessionSecret }) {
    if (!database?.enabled) throw new Error("TenantManager requires PostgreSQL");
    this.database = database;
    this.sessionSecret = sessionSecret;
    this.contexts = new Map();
  }

  async createWorkspace({ configuration, owner, discordIntegration = null, metadata = {} }) {
    return this.provisionWorkspace({ configuration, owner, discordIntegration, metadata });
  }

  async createWorkspaceFromArchive({ archive, owner, actor = "Business archive import", allowDuplicate = false }) {
    const normalizedArchive = validateBusinessArchive(archive);
    if (!allowDuplicate) {
      const existing = await this.database.query(`
        SELECT b.workspace_code, b.name
        FROM import_batches i
        JOIN businesses b ON b.id = i.business_id
        WHERE i.source_fingerprint = $1 AND b.status = 'active'
        LIMIT 1
      `, [normalizedArchive.fingerprint]);
      if (existing.rowCount) {
        throw tenantError(
          `This archive was already imported into ${existing.rows[0].name} (${existing.rows[0].workspace_code})`,
          409,
          "archive_already_imported"
        );
      }
    }
    return this.provisionWorkspace({
      configuration: normalizedArchive.business.configuration,
      owner,
      afterSetup: async ({ context, administrator }) => {
        const actorUser = { ...administrator, fullName: cleanReferenceId(actor) || administrator.fullName };
        const businessDocuments = await context.businessStore.importArchiveData(
          normalizedArchive.business,
          actorUser
        );
        const operations = await context.standaloneStore.importLegacySnapshot({
          snapshot: normalizedArchive.operations.snapshot,
          finance: normalizedArchive.operations.finance,
          audit: normalizedArchive.accounts.audit,
          actor: actorUser.fullName,
          fingerprint: normalizedArchive.fingerprint
        });
        const accounts = await context.accountStore.importAuditHistory({
          ...normalizedArchive.accounts,
          fingerprint: normalizedArchive.fingerprint
        }, administrator);
        const [catalogPricing, importedExceptions] = await Promise.all([
          context.standaloneStore.reconcileCatalogPricesFromWebhooks(),
          context.standaloneStore.reconcileImportedExceptions()
        ]);
        return {
          fingerprint: normalizedArchive.fingerprint,
          businessDocuments,
          operations: operations.summary,
          accounts,
          catalogPricing,
          importedExceptions,
          coverage: normalizedArchive.coverage
        };
      }
    });
  }

  async provisionWorkspace({ configuration, owner, discordIntegration = null, afterSetup = null, metadata = {} }) {
    const normalized = normalizeSetupPayload(configuration);
    const businessId = crypto.randomUUID();
    const workspaceCode = await this.allocateWorkspaceCode();
    const referenceId = cleanReferenceId(normalized.business.referenceId);
    await this.database.query(`
      INSERT INTO businesses (id, workspace_code, name, reference_id, status, metadata)
      VALUES ($1, $2, $3, $4, 'provisioning', $5::jsonb)
    `, [businessId, workspaceCode, normalized.business.name, referenceId, JSON.stringify({
      identityVersion: 1,
      dataLifecycle: "persistent",
      archiveVersion: 1,
      ...cleanMetadata(metadata)
    })]);

    try {
      const context = await this.buildContext({
        id: businessId,
        workspace_code: workspaceCode,
        name: normalized.business.name,
        reference_id: referenceId,
        status: "provisioning",
        created_at: new Date().toISOString()
      });
      const administrator = await context.accountStore.provisionInitialAdmin(owner?.fullName, owner?.password);
      const savedConfiguration = await context.businessStore.completeSetup(normalized, administrator);
      await context.standaloneStore.syncCatalog(savedConfiguration);
      const migration = typeof afterSetup === "function"
        ? await afterSetup({ context, administrator, configuration: savedConfiguration })
        : null;
      await this.database.query(`
        UPDATE businesses
        SET name = $2, reference_id = $3, status = 'active', updated_at = now()
        WHERE id = $1
      `, [businessId, normalized.business.name, referenceId]);
      context.business = {
        ...context.business,
        name: normalized.business.name,
        referenceId,
        status: "active"
      };
      this.contexts.set(businessId, context);
      if (String(discordIntegration?.eventChannelId || "").trim()) {
        await this.saveDiscordIntegration(businessId, discordIntegration);
      }
      return { business: structuredClone(context.business), owner: administrator, context, migration };
    } catch (error) {
      this.contexts.delete(businessId);
      await this.removeProvisioningWorkspace(businessId).catch(() => {});
      throw error;
    }
  }

  async getContextById(businessId) {
    const id = String(businessId || "").trim();
    if (!id) return null;
    const cached = this.contexts.get(id);
    if (cached) return cached.business.status === "active" ? cached : null;
    const result = await this.database.query(`
      SELECT id, workspace_code, name, reference_id, status, created_at
      FROM businesses
      WHERE id = $1
    `, [id]);
    const row = result.rows[0];
    if (!row || row.status !== "active") return null;
    const context = await this.buildContext(row);
    this.contexts.set(id, context);
    return context;
  }

  async getContextByWorkspaceCode(workspaceCode) {
    const code = normalizeWorkspaceCode(workspaceCode);
    if (!code) return null;
    const result = await this.database.query(`
      SELECT id
      FROM businesses
      WHERE upper(workspace_code) = $1 AND status = 'active'
    `, [code]);
    return result.rows[0] ? this.getContextById(result.rows[0].id) : null;
  }

  invalidateContext(businessId) {
    this.contexts.delete(String(businessId || "").trim());
  }

  async updateWorkspaceIdentity(businessId, businessProfile = {}) {
    const id = String(businessId || "").trim();
    const name = String(businessProfile.name || "").trim().replace(/\s+/g, " ").slice(0, 100);
    const referenceId = cleanReferenceId(businessProfile.referenceId);
    if (!id || !name) throw tenantError("Business workspace identity is incomplete", 400, "invalid_workspace_identity");
    const result = await this.database.query(`
      UPDATE businesses
      SET name = $2, reference_id = $3, updated_at = now()
      WHERE id = $1 AND status = 'active'
      RETURNING id, workspace_code, name, reference_id, status, created_at
    `, [id, name, referenceId]);
    if (!result.rowCount) throw tenantError("Business workspace not found", 404, "workspace_not_found");
    const updated = publicBusiness(result.rows[0]);
    const cached = this.contexts.get(id);
    if (cached) cached.business = updated;
    return structuredClone(updated);
  }

  async exportWorkspace(businessId, source = {}) {
    const id = String(businessId || "").trim();
    const result = await this.database.query(`
      SELECT id, workspace_code, name, reference_id, status, created_at
      FROM businesses
      WHERE id = $1 AND status IN ('active', 'suspended')
    `, [id]);
    if (!result.rowCount) throw tenantError("Business workspace not found", 404, "workspace_not_found");
    const cached = this.contexts.get(id);
    const context = cached || await this.buildContext(result.rows[0]);
    const [snapshot, finance] = await Promise.all([
      context.standaloneStore.snapshot(),
      context.standaloneStore.finance()
    ]);
    const business = context.businessStore.getArchiveData();
    return createBusinessArchive({
      configuration: business.configuration,
      business,
      snapshot,
      finance,
      users: context.accountStore.listUsers(),
      audit: context.accountStore.listAudit(1000),
      source
    });
  }

  async resetWorkspaceOwner(businessId, password, actorName = "Service operator") {
    const id = String(businessId || "").trim();
    const result = await this.database.query(`
      SELECT id, workspace_code, name, reference_id, status, created_at
      FROM businesses
      WHERE id = $1 AND status IN ('active', 'suspended')
    `, [id]);
    if (!result.rowCount) throw tenantError("Business workspace not found", 404, "workspace_not_found");
    const context = this.contexts.get(id) || await this.buildContext(result.rows[0]);
    const owner = context.accountStore.listUsers()
      .filter(user => user.role === "admin" && user.status === "active")
      .sort((left, right) => new Date(left.createdAt) - new Date(right.createdAt))[0];
    if (!owner) throw tenantError("Workspace has no active local administrator to reset", 409, "workspace_owner_unavailable");
    const reset = await context.accountStore.resetPassword(owner.id, password, actorName);
    if (result.rows[0].status === "active") this.contexts.set(id, context);
    return reset;
  }

  async resolveDiscordChannel(channelId) {
    return (await this.resolveDiscordChannelRoute(channelId))?.context || null;
  }

  async resolveDiscordChannelRoute(channelId) {
    const cleanChannelId = cleanDiscordId(channelId);
    if (!cleanChannelId) return null;
    const result = await this.database.query(`
      SELECT business_id,
        CASE WHEN event_channel_id = $1 THEN 'storefront' ELSE 'storage-ledger' END AS channel_type
      FROM business_integrations
      WHERE provider = 'discord'
        AND status = 'active'
        AND (event_channel_id = $1 OR storage_ledger_channel_id = $1)
      LIMIT 1
    `, [cleanChannelId]);
    if (!result.rows[0]) return null;
    const context = await this.getContextById(result.rows[0].business_id);
    return context ? { context, channelType: result.rows[0].channel_type } : null;
  }

  async saveDiscordIntegration(businessId, input = {}) {
    const context = await this.getContextById(businessId);
    if (!context) throw tenantError("Business workspace not found", 404, "workspace_not_found");
    const guildId = cleanDiscordId(input.guildId);
    const eventChannelId = cleanDiscordId(input.eventChannelId);
    const storageLedgerChannelId = cleanDiscordId(input.storageLedgerChannelId);
    const inventoryChannelId = cleanDiscordId(input.inventoryChannelId);
    const alertChannelId = cleanDiscordId(input.alertChannelId);
    if (!eventChannelId) {
      throw tenantError("Select the Discord channel that receives storefront events", 400, "event_channel_required");
    }
    if (storageLedgerChannelId && storageLedgerChannelId === eventChannelId) {
      throw tenantError("Use separate channels for storefront and storage/ledger events", 400, "discord_event_channels_must_differ");
    }
    try {
      const conflict = await this.database.query(`
        SELECT business_id
        FROM business_integrations
        WHERE provider = 'discord'
          AND status = 'active'
          AND business_id <> $1
          AND (
            ($2 <> '' AND (event_channel_id = $2 OR storage_ledger_channel_id = $2))
            OR ($3 <> '' AND (event_channel_id = $3 OR storage_ledger_channel_id = $3))
          )
        LIMIT 1
      `, [businessId, eventChannelId, storageLedgerChannelId]);
      if (conflict.rowCount) {
        throw tenantError("That Discord event channel is already connected to another business", 409, "discord_channel_taken");
      }
      const result = await this.database.query(`
        INSERT INTO business_integrations (
          business_id, provider, guild_id, event_channel_id, storage_ledger_channel_id,
          inventory_channel_id, alert_channel_id, status, metadata, updated_at
        ) VALUES ($1, 'discord', $2, $3, $4, $5, $6, 'active', $7::jsonb, now())
        ON CONFLICT (business_id, provider) DO UPDATE SET
          guild_id = EXCLUDED.guild_id,
          event_channel_id = EXCLUDED.event_channel_id,
          storage_ledger_channel_id = EXCLUDED.storage_ledger_channel_id,
          inventory_channel_id = EXCLUDED.inventory_channel_id,
          alert_channel_id = EXCLUDED.alert_channel_id,
          status = 'active',
          metadata = EXCLUDED.metadata,
          updated_at = now()
        RETURNING guild_id, event_channel_id, storage_ledger_channel_id,
          inventory_channel_id, alert_channel_id, status, updated_at
      `, [
        businessId, guildId, eventChannelId, storageLedgerChannelId,
        inventoryChannelId, alertChannelId, JSON.stringify(cleanMetadata(input.metadata))
      ]);
      return publicIntegration(result.rows[0]);
    } catch (error) {
      if (error.code === "23505" || /unique/i.test(error.message)) {
        throw tenantError("That Discord event channel is already connected to another business", 409, "discord_channel_taken");
      }
      throw error;
    }
  }

  async getDiscordIntegration(businessId) {
    const result = await this.database.query(`
      SELECT guild_id, event_channel_id, storage_ledger_channel_id,
        inventory_channel_id, alert_channel_id, status, updated_at
      FROM business_integrations
      WHERE business_id = $1 AND provider = 'discord'
    `, [businessId]);
    return result.rows[0] ? publicIntegration(result.rows[0]) : null;
  }

  async listDiscordIntegrations() {
    const result = await this.database.query(`
      SELECT i.business_id, b.workspace_code, b.name, i.guild_id, i.event_channel_id,
             i.storage_ledger_channel_id,
             i.inventory_channel_id, i.alert_channel_id, i.status, i.updated_at
      FROM business_integrations i
      JOIN businesses b ON b.id = i.business_id
      WHERE i.provider = 'discord' AND i.status = 'active' AND b.status = 'active'
      ORDER BY b.created_at
    `);
    return result.rows.map(row => ({
      businessId: row.business_id,
      workspaceCode: row.workspace_code,
      businessName: row.name,
      ...publicIntegration(row)
    }));
  }

  async allocateWorkspaceCode() {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const compact = randomWorkspaceCode();
      const code = `${compact.slice(0, 5)}-${compact.slice(5)}`;
      const result = await this.database.query(
        "SELECT 1 FROM businesses WHERE upper(workspace_code) = $1",
        [code]
      );
      if (!result.rowCount) return code;
    }
    throw tenantError("Unable to allocate a unique workspace code", 503, "workspace_code_unavailable");
  }

  async buildContext(row) {
    const business = publicBusiness(row);
    const accountStore = new AccountStore({
      sessionSecret: this.sessionSecret,
      businessId: business.id,
      repository: new TenantDocumentRepository(this.database, business.id, "accounts")
    });
    const businessStore = new BusinessStore({
      repository: new TenantDocumentRepository(this.database, business.id, "business")
    });
    await Promise.all([accountStore.initialize(), businessStore.initialize()]);
    const standaloneStore = new StandaloneStore(this.database, { businessId: business.id });
    await Promise.all([
      standaloneStore.reconcileImportedFundAudit(accountStore.listAudit(1000)),
      standaloneStore.reconcileCatalogPricesFromWebhooks(),
      standaloneStore.reconcileImportedExceptions()
    ]);
    return {
      business,
      businessId: business.id,
      accountStore,
      businessStore,
      standaloneStore
    };
  }

  async removeProvisioningWorkspace(businessId) {
    const tables = [
      "recipe_ingredients", "recipe_definitions", "catalog_items", "operation_receipts",
      "inventory_events", "ledger_events", "finance_events", "webhook_exceptions",
      "webhook_events", "item_mappings", "time_entries", "import_batches"
    ];
    await this.database.transaction(async client => {
      for (const table of tables) {
        await client.query(`DELETE FROM ${table} WHERE business_id = $1`, [businessId]);
      }
      await client.query("DELETE FROM businesses WHERE id = $1", [businessId]);
    });
  }
}

function publicBusiness(row) {
  return {
    id: String(row.id || ""),
    workspaceCode: String(row.workspace_code || row.workspaceCode || ""),
    name: String(row.name || ""),
    referenceId: String(row.reference_id || row.referenceId || ""),
    status: String(row.status || ""),
    createdAt: new Date(row.created_at || row.createdAt || Date.now()).toISOString()
  };
}

function publicIntegration(row) {
  return {
    guildId: String(row.guild_id || row.guildId || ""),
    eventChannelId: String(row.event_channel_id || row.eventChannelId || ""),
    storageLedgerChannelId: String(row.storage_ledger_channel_id || row.storageLedgerChannelId || ""),
    inventoryChannelId: String(row.inventory_channel_id || row.inventoryChannelId || ""),
    alertChannelId: String(row.alert_channel_id || row.alertChannelId || ""),
    status: String(row.status || "active"),
    updatedAt: row.updated_at || row.updatedAt ? new Date(row.updated_at || row.updatedAt).toISOString() : ""
  };
}

function randomWorkspaceCode() {
  const bytes = crypto.randomBytes(WORKSPACE_CODE_LENGTH);
  let result = "";
  for (let index = 0; index < WORKSPACE_CODE_LENGTH; index += 1) {
    result += WORKSPACE_ALPHABET[bytes[index] % WORKSPACE_ALPHABET.length];
  }
  return result;
}

function normalizeWorkspaceCode(value) {
  const compact = String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (compact === "PRIMARY") return "PRIMARY";
  if (compact.length !== WORKSPACE_CODE_LENGTH) return "";
  return `${compact.slice(0, 5)}-${compact.slice(5)}`;
}

function cleanReferenceId(value) {
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, 100);
}

function cleanDiscordId(value) {
  const cleaned = String(value || "").trim();
  return /^\d{15,22}$/.test(cleaned) || cleaned === "local-test" ? cleaned : "";
}

function cleanMetadata(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).slice(0, 20).map(([key, entry]) => [
    String(key).slice(0, 60),
    typeof entry === "boolean" || typeof entry === "number" ? entry : String(entry || "").slice(0, 300)
  ]));
}

function tenantError(message, status, code) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

module.exports = {
  TenantManager,
  BUSINESS_ID_PATTERN,
  normalizeWorkspaceCode,
  publicBusiness,
  tenantError
};
