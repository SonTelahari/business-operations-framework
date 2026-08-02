const fs = require("node:fs");
const path = require("node:path");
const { Pool } = require("pg");

class Database {
  constructor({ connectionString = "", pool = null, migrationsDirectory = path.join(__dirname, "db", "migrations") } = {}) {
    this.connectionString = String(connectionString || "").trim();
    this.pool = pool || (this.connectionString ? new Pool(poolOptions(this.connectionString)) : null);
    this.migrationsDirectory = migrationsDirectory;
  }

  get enabled() {
    return Boolean(this.pool);
  }

  async initialize() {
    if (!this.pool) return;
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    const files = fs.readdirSync(this.migrationsDirectory)
      .filter(file => /^\d+.*\.sql$/i.test(file))
      .sort((left, right) => left.localeCompare(right));
    for (const file of files) {
      const alreadyApplied = await this.pool.query("SELECT 1 FROM schema_migrations WHERE id = $1", [file]);
      if (alreadyApplied.rowCount) continue;
      const sql = fs.readFileSync(path.join(this.migrationsDirectory, file), "utf8");
      await this.transaction(async client => {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (id) VALUES ($1)", [file]);
      });
    }
  }

  query(text, values = []) {
    if (!this.pool) throw new Error("DATABASE_URL is not configured");
    return this.pool.query(text, values);
  }

  async transaction(callback) {
    if (!this.pool) throw new Error("DATABASE_URL is not configured");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await callback(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async close() {
    if (this.pool) await this.pool.end();
  }
}

class PostgresDocumentRepository {
  constructor(database, documentKey) {
    this.database = database;
    this.documentKey = documentKey;
  }

  async load() {
    const result = await this.database.query(
      "SELECT data FROM app_documents WHERE document_key = $1",
      [this.documentKey]
    );
    return result.rows[0]?.data || null;
  }

  async save(data) {
    await this.database.query(`
      INSERT INTO app_documents (document_key, data, updated_at)
      VALUES ($1, $2::jsonb, now())
      ON CONFLICT (document_key) DO UPDATE
      SET data = EXCLUDED.data, updated_at = now()
    `, [this.documentKey, JSON.stringify(data)]);
  }
}

class TenantDocumentRepository {
  constructor(database, businessId, documentKey) {
    this.database = database;
    this.businessId = String(businessId || "").trim();
    this.documentKey = String(documentKey || "").trim();
    if (!this.businessId || !this.documentKey) {
      throw new Error("Tenant documents require a business ID and document key");
    }
  }

  async load() {
    const result = await this.database.query(`
      SELECT data
      FROM tenant_documents
      WHERE business_id = $1 AND document_key = $2
    `, [this.businessId, this.documentKey]);
    return result.rows[0]?.data || null;
  }

  async save(data) {
    await this.database.query(`
      INSERT INTO tenant_documents (business_id, document_key, data, updated_at)
      VALUES ($1, $2, $3::jsonb, now())
      ON CONFLICT (business_id, document_key) DO UPDATE
      SET data = EXCLUDED.data, updated_at = now()
    `, [this.businessId, this.documentKey, JSON.stringify(data)]);
  }
}

function poolOptions(connectionString) {
  const sslSetting = String(process.env.DATABASE_SSL || "").toLowerCase();
  const ssl = sslSetting === "require" || sslSetting === "true"
    ? { rejectUnauthorized: false }
    : undefined;
  return {
    connectionString,
    ssl,
    max: Math.max(1, Number(process.env.DATABASE_POOL_SIZE || 10)),
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000
  };
}

module.exports = { Database, PostgresDocumentRepository, TenantDocumentRepository, poolOptions };
