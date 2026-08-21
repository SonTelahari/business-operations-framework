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
    return (await this.loadVersioned()).data;
  }

  async loadVersioned() {
    const result = await this.database.query(
      "SELECT data, revision FROM app_documents WHERE document_key = $1",
      [this.documentKey]
    );
    return {
      data: result.rows[0]?.data || null,
      revision: revisionNumber(result.rows[0]?.revision)
    };
  }

  async save(data, expectedRevision = null) {
    const payload = JSON.stringify(data);
    const expected = optionalRevision(expectedRevision);
    const result = expected === null
      ? await this.database.query(`
          INSERT INTO app_documents (document_key, data, revision, updated_at)
          VALUES ($1, $2::jsonb, 1, now())
          ON CONFLICT (document_key) DO UPDATE
          SET data = EXCLUDED.data,
              revision = app_documents.revision + 1,
              updated_at = now()
          RETURNING revision
        `, [this.documentKey, payload])
      : expected === 0
        ? await this.database.query(`
            INSERT INTO app_documents (document_key, data, revision, updated_at)
            VALUES ($1, $2::jsonb, 1, now())
            ON CONFLICT (document_key) DO NOTHING
            RETURNING revision
          `, [this.documentKey, payload])
        : await this.database.query(`
            UPDATE app_documents
            SET data = $2::jsonb, revision = revision + 1, updated_at = now()
            WHERE document_key = $1 AND revision = $3
            RETURNING revision
          `, [this.documentKey, payload, expected]);
    if (!result.rowCount) throw new DocumentConflictError(this.documentKey, expected);
    return { revision: revisionNumber(result.rows[0].revision) };
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
    return (await this.loadVersioned()).data;
  }

  async loadVersioned() {
    const result = await this.database.query(`
      SELECT data, revision
      FROM tenant_documents
      WHERE business_id = $1 AND document_key = $2
    `, [this.businessId, this.documentKey]);
    return {
      data: result.rows[0]?.data || null,
      revision: revisionNumber(result.rows[0]?.revision)
    };
  }

  async save(data, expectedRevision = null) {
    const payload = JSON.stringify(data);
    const expected = optionalRevision(expectedRevision);
    const result = expected === null
      ? await this.database.query(`
          INSERT INTO tenant_documents (business_id, document_key, data, revision, updated_at)
          VALUES ($1, $2, $3::jsonb, 1, now())
          ON CONFLICT (business_id, document_key) DO UPDATE
          SET data = EXCLUDED.data,
              revision = tenant_documents.revision + 1,
              updated_at = now()
          RETURNING revision
        `, [this.businessId, this.documentKey, payload])
      : expected === 0
        ? await this.database.query(`
            INSERT INTO tenant_documents (business_id, document_key, data, revision, updated_at)
            VALUES ($1, $2, $3::jsonb, 1, now())
            ON CONFLICT (business_id, document_key) DO NOTHING
            RETURNING revision
          `, [this.businessId, this.documentKey, payload])
        : await this.database.query(`
            UPDATE tenant_documents
            SET data = $3::jsonb, revision = revision + 1, updated_at = now()
            WHERE business_id = $1 AND document_key = $2 AND revision = $4
            RETURNING revision
          `, [this.businessId, this.documentKey, payload, expected]);
    if (!result.rowCount) {
      throw new DocumentConflictError(`${this.businessId}:${this.documentKey}`, expected);
    }
    return { revision: revisionNumber(result.rows[0].revision) };
  }
}

class DocumentConflictError extends Error {
  constructor(documentKey, expectedRevision) {
    super(`Document ${documentKey} changed after revision ${expectedRevision}`);
    this.name = "DocumentConflictError";
    this.code = "document_revision_conflict";
    this.status = 409;
    this.documentKey = documentKey;
    this.expectedRevision = expectedRevision;
  }
}

function optionalRevision(value) {
  if (value === null || value === undefined) return null;
  const revision = Number(value);
  if (!Number.isInteger(revision) || revision < 0) {
    throw new TypeError("Document revision must be a non-negative integer");
  }
  return revision;
}

function revisionNumber(value) {
  const revision = Number(value || 0);
  return Number.isInteger(revision) && revision >= 0 ? revision : 0;
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

module.exports = {
  Database,
  PostgresDocumentRepository,
  TenantDocumentRepository,
  DocumentConflictError,
  poolOptions
};
