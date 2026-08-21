const assert = require("node:assert/strict");
const { newDb } = require("pg-mem");
const { Database } = require("./database");
const { readSessionIdentity } = require("./auth");
const { TenantManager, BUSINESS_ID_PATTERN } = require("./tenant-manager");
const { defaultSetupConfiguration } = require("./setup-config");

async function run() {
  const memory = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true });
  const adapter = memory.adapters.createPg();
  const database = new Database({ pool: new adapter.Pool() });
  const sessionSecret = "tenant-test-session-secret-with-more-than-32-characters";

  try {
    await database.initialize();
    const tenants = new TenantManager({ database, sessionSecret });
    const first = await tenants.createWorkspace(workspaceInput("Frontier Firearms", "23", "William Winther"));
    const second = await tenants.createWorkspace(workspaceInput("Frontier Firearms", "23", "William Winther"));

    assert.match(first.business.id, BUSINESS_ID_PATTERN);
    assert.match(second.business.id, BUSINESS_ID_PATTERN);
    assert.notEqual(first.business.id, second.business.id);
    assert.notEqual(first.business.workspaceCode, second.business.workspaceCode);
    assert.equal(first.business.name, second.business.name);
    assert.equal(first.business.referenceId, second.business.referenceId);

    assert.equal(
      (await tenants.getContextByWorkspaceCode(first.business.workspaceCode.toLowerCase().replace("-", ""))).businessId,
      first.business.id
    );
    assert.equal((await tenants.getContextById(second.business.id)).businessId, second.business.id);

    const firstSession = first.context.accountStore.createSession(first.owner);
    const identity = readSessionIdentity(firstSession, sessionSecret);
    assert.equal(identity.businessId, first.business.id);
    assert.equal(first.context.accountStore.verifySession(firstSession).fullName, "William Winther");
    assert.equal(second.context.accountStore.verifySession(firstSession), null);

    await first.context.accountStore.register("Arthur Morgan", "employee-password-1");
    await second.context.accountStore.register("Arthur Morgan", "employee-password-1");
    assert.equal(first.context.accountStore.listUsers().length, 2);
    assert.equal(second.context.accountStore.listUsers().length, 2);

    const otherReplica = new TenantManager({ database, sessionSecret });
    const firstReplicaContext = await otherReplica.getContextById(first.business.id);
    await Promise.all([
      first.context.accountStore.register("Sadie Adler", "employee-password-2"),
      firstReplicaContext.accountStore.register("Charles Smith", "employee-password-3")
    ]);
    await first.context.accountStore.refresh();
    assert.deepEqual(
      first.context.accountStore.listUsers().map(user => user.fullName).sort(),
      ["Arthur Morgan", "Charles Smith", "Sadie Adler", "William Winther"]
    );

    await first.context.standaloneStore.handleGuiPayload({
      action: "manual_operation",
      entry: {
        id: "first-count",
        kind: "Stock Count",
        location: "Storefront",
        itemName: "Shared Product",
        quantity: 8,
        employee: "William Winther"
      }
    });
    assert.equal((await first.context.standaloneStore.snapshot()).inventory.products[0].currentStock, 8);
    assert.equal((await second.context.standaloneStore.snapshot()).inventory.products[0].currentStock, 0);

    const firstIntegration = await tenants.saveDiscordIntegration(first.business.id, {
      guildId: "123456789012345678",
      eventChannelId: "223456789012345678",
      storageLedgerChannelId: "423456789012345678",
      inventoryChannelId: "323456789012345678"
    });
    assert.equal(firstIntegration.eventChannelId, "223456789012345678");
    assert.equal(firstIntegration.storageLedgerChannelId, "423456789012345678");
    assert.equal((await tenants.resolveDiscordChannel("223456789012345678")).businessId, first.business.id);
    const storefrontRoute = await tenants.resolveDiscordChannelRoute("223456789012345678");
    const storageRoute = await tenants.resolveDiscordChannelRoute("423456789012345678");
    assert.equal(storefrontRoute.channelType, "storefront");
    assert.equal(storageRoute.channelType, "storage-ledger");
    assert.equal(storageRoute.context.businessId, first.business.id);
    await assert.rejects(
      tenants.saveDiscordIntegration(second.business.id, { eventChannelId: "223456789012345678" }),
      error => error.code === "discord_channel_taken"
    );
    await assert.rejects(
      tenants.saveDiscordIntegration(second.business.id, { eventChannelId: "423456789012345678" }),
      error => error.code === "discord_channel_taken"
    );
    await assert.rejects(
      tenants.saveDiscordIntegration(first.business.id, {
        eventChannelId: "223456789012345678",
        storageLedgerChannelId: "223456789012345678"
      }),
      error => error.code === "discord_event_channels_must_differ"
    );

    console.log("Hosted tenant identity and isolation tests passed.");
  } finally {
    await database.close();
  }
}

function workspaceInput(name, referenceId, ownerName) {
  const configuration = defaultSetupConfiguration();
  configuration.business.name = name;
  configuration.business.referenceId = referenceId;
  configuration.catalog.products = [{
    name: "Shared Product",
    label: "Shared Product",
    tag: "shared_product",
    category: "Products",
    salePrice: 10,
    target: 5,
    active: true
  }];
  return {
    configuration,
    owner: { fullName: ownerName, password: "owner-password-123" }
  };
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
