const assert = require("node:assert/strict");
const { newDb } = require("pg-mem");
const { Database, PostgresDocumentRepository } = require("./database");
const { AccountStore } = require("./auth");
const { BusinessStore } = require("./business-store");
const { defaultSetupConfiguration } = require("./setup-config");

async function run() {
  const memory = newDb({
    autoCreateForeignKeyIndices: true,
    noAstCoverageCheck: true
  });
  const adapter = memory.adapters.createPg();
  const pool = new adapter.Pool();
  const database = new Database({ pool });

  try {
    await database.initialize();
    await database.initialize();

    const migrations = await database.query(
      "SELECT id FROM schema_migrations ORDER BY id"
    );
    assert.deepEqual(migrations.rows.map(row => row.id), [
      "001_initial.sql",
      "002_multitenancy.sql",
      "003_discord_identity.sql",
      "004_beta_operations.sql",
      "005_dual_purpose_catalog_items.sql",
      "006_recipe_source_locations.sql",
      "007_storage_targets.sql",
      "008_local_identity_jobs.sql",
      "009_storage_ledger_discord_channel.sql",
      "010_item_mapping_quantity_multiplier.sql"
    ]);

    const tables = await database.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
    `);
    const tableNames = new Set(tables.rows.map(row => row.table_name));
    for (const expected of [
      "app_documents",
      "businesses",
      "tenant_documents",
      "business_integrations",
      "discord_identities",
      "identity_characters",
      "business_memberships",
      "local_identities",
      "local_identity_memberships",
      "oauth_states",
      "beta_invites",
      "beta_invite_redemptions",
      "platform_audit_events",
      "catalog_items",
      "inventory_events",
      "ledger_events",
      "finance_events",
      "webhook_events",
      "time_entries"
    ]) {
      assert.equal(tableNames.has(expected), true, `${expected} was not created`);
    }

    const repository = new PostgresDocumentRepository(database, "test-document");
    assert.equal(await repository.load(), null);

    await repository.save({ version: 1, staff: [{ name: "Ada" }] });
    assert.deepEqual(await repository.load(), {
      version: 1,
      staff: [{ name: "Ada" }]
    });

    await repository.save({ version: 2, staff: [] });
    assert.deepEqual(await repository.load(), { version: 2, staff: [] });

    const accountRepository = new PostgresDocumentRepository(database, "accounts");
    const accounts = new AccountStore({
      repository: accountRepository,
      sessionSecret: "database-test-session-secret"
    });
    await accounts.initialize({ adminFullName: "Ada Lovelace", adminPassword: "correct-horse-42" });
    assert.equal(accounts.hasUsers(), true);

    const reloadedAccounts = new AccountStore({
      repository: accountRepository,
      sessionSecret: "database-test-session-secret"
    });
    await reloadedAccounts.initialize();
    assert.equal(reloadedAccounts.listUsers()[0].fullName, "Ada Lovelace");
    assert.equal(reloadedAccounts.listUsers()[0].role, "admin");

    const businessRepository = new PostgresDocumentRepository(database, "business");
    const businesses = new BusinessStore({ repository: businessRepository });
    await businesses.initialize();
    const setup = defaultSetupConfiguration();
    setup.business.name = "Test Business";
    await businesses.completeSetup(setup, { fullName: "Ada Lovelace" });

    const reloadedBusiness = new BusinessStore({ repository: businessRepository });
    await reloadedBusiness.initialize();
    assert.equal(reloadedBusiness.isConfigured(), true);
    assert.equal(reloadedBusiness.getConfiguration().completedBy, "Ada Lovelace");

    console.log("Database migration and repository tests passed.");
  } finally {
    await database.close();
  }
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
