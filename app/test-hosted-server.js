const assert = require("node:assert/strict");
const { once } = require("node:events");
const http = require("node:http");
const { newDb } = require("pg-mem");
const { version: packageVersion } = require("../package.json");
const { parseStillWaterEmbed } = require("../discord-bridge/parser");
const { defaultSetupConfiguration } = require("./setup-config");

const memory = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true });
const adapter = memory.adapters.createPg();
const pgPath = require.resolve("pg");
const originalPg = require(pgPath);
require.cache[pgPath].exports = { ...originalPg, Pool: adapter.Pool };

process.env.DATABASE_URL = "postgresql://hosted-test/business";
process.env.HOSTED_MODE = "1";
process.env.HOSTED_SIGNUP_MODE = "invite";
process.env.HOSTED_SIGNUP_SECRET = "hosted-test-invitation-code";
process.env.PLATFORM_ADMIN_SECRET = "hosted-test-platform-operator-secret-42";
process.env.AUTH_SESSION_SECRET = "hosted-server-test-session-secret-with-32-characters";
process.env.BRIDGE_API_TOKEN = "hosted-server-test-bridge-secret";
process.env.PORT = "4296";
process.env.DISCORD_CLIENT_ID = "hosted-test-discord-client";
process.env.DISCORD_CLIENT_SECRET = "hosted-test-discord-secret";
process.env.DISCORD_REDIRECT_URI = "http://127.0.0.1:4296/auth/discord/callback";
process.env.DISCORD_API_BASE_URL = "http://127.0.0.1:4297/api/v10";
process.env.DISCORD_AUTHORIZE_URL = "http://127.0.0.1:4297/oauth2/authorize";
process.env.APP_RELEASE = "hosted-test-release";
delete process.env.ADMIN_FULL_NAME;
delete process.env.ADMIN_PASSWORD;

const { server, startServer, database } = require("./server");
const baseUrl = `http://127.0.0.1:${process.env.PORT}`;
const discordServer = createFakeDiscordServer();

async function run() {
  try {
    discordServer.listen(4297, "127.0.0.1");
    await once(discordServer, "listening");
    const listening = once(server, "listening");
    await startServer();
    if (!server.listening) await listening;

    const health = await request("/health");
    assert.equal(health.body.hostedMode, true);
    assert.equal(health.body.tenantScoped, true);
    assert.equal(health.body.multiReplicaDocumentWrites, true);
    assert.equal(health.body.materializedBalances, true);
    assert.equal(health.body.version, packageVersion);
    assert.equal(health.body.release, "hosted-test-release");
    const serviceWorker = await fetch(`${baseUrl}/service-worker.js`).then(response => response.text());
    assert.match(serviceWorker, /\/\/ release:hosted-test-release\s*$/);

    const setupStatus = await request("/api/setup/status");
    assert.equal(setupStatus.body.workspaceSignup.mode, "invite");
    assert.equal(setupStatus.body.workspaceSignup.inviteRequired, true);
    const operatorLogin = await request("/api/operator/login", {
      method: "POST",
      body: { secret: process.env.PLATFORM_ADMIN_SECRET }
    });
    assert.equal(operatorLogin.status, 200, JSON.stringify(operatorLogin.body));
    const operatorCookie = operatorLogin.cookie;
    const issuedInvite = await request("/api/operator/invites", {
      method: "POST",
      cookie: operatorCookie,
      body: { label: "Hosted test businesses", maxUses: 2 }
    });
    assert.equal(issuedInvite.status, 201, JSON.stringify(issuedInvite.body));
    assert.match(issuedInvite.body.invite.code, /^BETA-/);
    const failedConfiguration = defaultSetupConfiguration();
    failedConfiguration.business.name = "Failed Provisioning Test";
    const failedProvision = await request("/api/setup/complete", {
      method: "POST",
      body: {
        inviteCode: issuedInvite.body.invite.code,
        configuration: failedConfiguration,
        owner: { fullName: "Retry Owner", password: "short" }
      }
    });
    assert.equal(failedProvision.status, 400);
    assert.equal(failedProvision.body.code, "invalid_password");
    const rejectedSignup = await request("/api/setup/complete", {
      method: "POST",
      body: {
        inviteCode: "incorrect-code",
        configuration: defaultSetupConfiguration(),
        owner: { fullName: "Rejected Owner", password: "owner-password-123" }
      }
    });
    assert.equal(rejectedSignup.status, 403);
    assert.equal(rejectedSignup.body.code, "workspace_invite_invalid");

    const first = await createBusiness("Frontier Firearms", "23", "William Winther", {
      guildId: "123456789012345671",
      eventChannelId: "223456789012345671",
      storageLedgerChannelId: "423456789012345671"
    }, issuedInvite.body.invite.code);
    const second = await createBusiness("Frontier Firearms", "23", "William Winther", null, issuedInvite.body.invite.code);
    const exhaustedInvite = await request("/api/setup/complete", {
      method: "POST",
      body: {
        inviteCode: issuedInvite.body.invite.code,
        configuration: defaultSetupConfiguration(),
        owner: { fullName: "Third Owner", password: "owner-password-123" }
      }
    });
    assert.equal(exhaustedInvite.status, 403);
    assert.equal(exhaustedInvite.body.code, "workspace_invite_invalid");
    assert.equal(first.body.business.name, second.body.business.name);
    assert.equal(first.body.workspace.referenceId, second.body.workspace.referenceId);
    assert.notEqual(first.body.workspace.id, second.body.workspace.id);
    assert.notEqual(first.body.workspace.code, second.body.workspace.code);

    const firstConfig = await request(`/api/public/config?workspace=${first.body.workspace.code}`);
    const secondConfig = await request(`/api/public/config?workspace=${second.body.workspace.code}`);
    assert.equal(firstConfig.body.configured, true);
    assert.equal(secondConfig.body.configured, true);

    const firstSession = await request("/api/auth/session", { cookie: first.cookie });
    const secondSession = await request("/api/auth/session", { cookie: second.cookie });
    assert.equal(firstSession.body.workspace.id, first.body.workspace.id);
    assert.equal(secondSession.body.workspace.id, second.body.workspace.id);
    assert.equal(firstSession.body.jobProfile.accountType, "local");
    assert.equal(firstSession.body.jobProfile.jobs.length, 1);
    assert.equal(firstSession.body.jobProfile.jobs[0].role, "admin");
    const productionInventoryAsset = await fetch(`${baseUrl}/production-inventory.js`, {
      headers: { cookie: first.cookie }
    });
    assert.equal(productionInventoryAsset.status, 200);
    assert.match(await productionInventoryAsset.text(), /FRONTIER_PRODUCTION_INVENTORY/);

    const linkedSecondJob = await request("/api/workspaces/link", {
      method: "POST",
      cookie: joinCookies(first.cookie, firstSession.cookie),
      body: {
        workspaceCode: second.body.workspace.code,
        fullName: "William Winther",
        password: "owner-password-123"
      }
    });
    assert.equal(linkedSecondJob.status, 201, JSON.stringify(linkedSecondJob.body));
    assert.equal(linkedSecondJob.body.profile.jobs.length, 2);
    assert.equal(linkedSecondJob.body.job.businessId, second.body.workspace.id);

    const switchedToSecond = await request("/api/workspaces/select", {
      method: "POST",
      cookie: joinCookies(first.cookie, linkedSecondJob.cookie),
      body: { businessId: second.body.workspace.id }
    });
    assert.equal(switchedToSecond.status, 200, JSON.stringify(switchedToSecond.body));
    assert.equal(switchedToSecond.body.workspace.id, second.body.workspace.id);
    const switchedSession = await request("/api/auth/session", { cookie: switchedToSecond.cookie });
    assert.equal(switchedSession.body.workspace.id, second.body.workspace.id);
    assert.equal(switchedSession.body.jobProfile.jobs.length, 2);

    const operatorOverview = await request("/api/operator/overview", { cookie: operatorCookie });
    assert.equal(operatorOverview.status, 200, JSON.stringify(operatorOverview.body));
    assert.equal(operatorOverview.body.workspaces.length, 2);
    assert.equal(operatorOverview.body.invites[0].useCount, 2);
    assert.equal(operatorOverview.body.invites[0].status, "exhausted");
    const archiveExport = await request(`/api/operator/workspaces/${first.body.workspace.id}/export`, {
      cookie: operatorCookie
    });
    assert.equal(archiveExport.status, 200, JSON.stringify(archiveExport.body));
    assert.equal(archiveExport.body.format, "business-operations-archive");
    assert.equal(archiveExport.body.business.configuration.business.name, "Frontier Firearms");

    const suspended = await request(`/api/operator/workspaces/${second.body.workspace.id}/suspend`, {
      method: "POST",
      cookie: operatorCookie,
      body: { reason: "Hosted test" }
    });
    assert.equal(suspended.body.workspace.status, "suspended");
    const suspendedSession = await request("/api/auth/session", { cookie: second.cookie });
    assert.equal(suspendedSession.status, 200);
    assert.equal(suspendedSession.body.user, null);
    assert.equal(suspendedSession.body.workspace, null);
    const reactivated = await request(`/api/operator/workspaces/${second.body.workspace.id}/reactivate`, {
      method: "POST",
      cookie: operatorCookie,
      body: {}
    });
    assert.equal(reactivated.body.workspace.status, "active");
    const restoredSession = await request("/api/auth/session", { cookie: second.cookie });
    assert.equal(restoredSession.body.workspace.id, second.body.workspace.id);

    const discordAuthStatus = await request("/api/discord-auth/status");
    assert.equal(discordAuthStatus.body.enabled, true);
    const oauthStart = await request("/auth/discord", { redirect: "manual" });
    assert.equal(oauthStart.status, 302);
    const authorization = new URL(oauthStart.location);
    assert.equal(authorization.origin, "http://127.0.0.1:4297");
    assert.equal(authorization.searchParams.get("scope"), "identify");
    const oauthCallback = await request(
      `/auth/discord/callback?state=${encodeURIComponent(authorization.searchParams.get("state"))}&code=test-code`,
      { redirect: "manual" }
    );
    assert.equal(oauthCallback.status, 302);
    assert.equal(oauthCallback.location, "/profile.html");
    const identityCookie = oauthCallback.cookie;
    assert.match(identityCookie, /^discord_identity_session=/);
    const emptyProfile = await request("/api/profile", { cookie: identityCookie });
    assert.equal(emptyProfile.body.identity.discordUserId, "123456789012345678");
    assert.equal(emptyProfile.body.characters.length, 0);

    const characterResponse = await request("/api/profile/characters", {
      method: "POST",
      cookie: identityCookie,
      body: { name: "Arthur Morgan", settingName: "Still Water" }
    });
    assert.equal(characterResponse.status, 201, JSON.stringify(characterResponse.body));
    const characterId = characterResponse.body.character.id;
    const membershipRequest = await request("/api/profile/memberships", {
      method: "POST",
      cookie: identityCookie,
      body: { characterId, workspaceCode: first.body.workspace.code }
    });
    assert.equal(membershipRequest.status, 201, JSON.stringify(membershipRequest.body));
    assert.equal(membershipRequest.body.membership.status, "pending");

    const pendingStaff = await request("/api/admin/users", { cookie: first.cookie });
    const discordEmployee = pendingStaff.body.users.find(entry => entry.accountType === "discord");
    assert.equal(discordEmployee.fullName, "Arthur Morgan");
    await request(`/api/admin/users/${discordEmployee.id}/approve`, { method: "POST", cookie: first.cookie });
    const membershipSelect = await request("/api/profile/select", {
      method: "POST",
      cookie: identityCookie,
      body: { membershipId: discordEmployee.id, businessId: first.body.workspace.id }
    });
    assert.equal(membershipSelect.status, 200, JSON.stringify(membershipSelect.body));
    assert.match(membershipSelect.cookie, /^discord_membership_session=/);
    const discordBusinessSession = await request("/api/auth/session", { cookie: membershipSelect.cookie });
    assert.equal(discordBusinessSession.body.user.fullName, "Arthur Morgan");
    assert.equal(discordBusinessSession.body.user.accountType, "discord");
    assert.equal(discordBusinessSession.body.workspace.id, first.body.workspace.id);

    const secondMembershipRequest = await request("/api/profile/memberships", {
      method: "POST",
      cookie: identityCookie,
      body: { characterId, workspaceCode: second.body.workspace.code }
    });
    assert.equal(secondMembershipRequest.status, 201, JSON.stringify(secondMembershipRequest.body));
    const secondPendingStaff = await request("/api/admin/users", { cookie: second.cookie });
    const secondDiscordEmployee = secondPendingStaff.body.users.find(entry =>
      entry.accountType === "discord" && entry.fullName === "Arthur Morgan"
    );
    await request(`/api/admin/users/${secondDiscordEmployee.id}/approve`, {
      method: "POST",
      cookie: second.cookie
    });
    const discordJobs = await request("/api/workspaces", { cookie: membershipSelect.cookie });
    assert.equal(discordJobs.body.profile.accountType, "discord");
    assert.equal(discordJobs.body.profile.jobs.filter(job => job.status === "active").length, 2);
    const switchedDiscordJob = await request("/api/workspaces/select", {
      method: "POST",
      cookie: membershipSelect.cookie,
      body: {
        businessId: second.body.workspace.id,
        membershipId: secondDiscordEmployee.id
      }
    });
    assert.equal(switchedDiscordJob.status, 200, JSON.stringify(switchedDiscordJob.body));
    const switchedDiscordSession = await request("/api/auth/session", { cookie: switchedDiscordJob.cookie });
    assert.equal(switchedDiscordSession.body.workspace.id, second.body.workspace.id);
    assert.equal(switchedDiscordSession.body.user.role, "employee");

    const firstRegistration = await request("/api/auth/register", {
      method: "POST",
      body: { workspaceCode: first.body.workspace.code, fullName: "Arthur Morgan", password: "employee-password-1" }
    });
    const secondRegistration = await request("/api/auth/register", {
      method: "POST",
      body: { workspaceCode: second.body.workspace.code, fullName: "Arthur Morgan", password: "employee-password-1" }
    });
    assert.equal(firstRegistration.status, 201);
    assert.equal(secondRegistration.status, 201);

    await configureDiscord(second.cookie, "123456789012345672", "223456789012345672", "423456789012345672");
    await forwardDeposit("first-deposit", "223456789012345671", 4);
    await forwardDeposit("second-deposit", "223456789012345672", 9);

    const firstSnapshot = await bridgeRequest(`/api/integrations/discord/snapshot?discord_channel_id=223456789012345671`);
    const secondSnapshot = await bridgeRequest(`/api/integrations/discord/snapshot?discord_channel_id=223456789012345672`);
    assert.equal(firstSnapshot.body.inventory.products[0].currentStock, 4);
    assert.equal(secondSnapshot.body.inventory.products[0].currentStock, 9);

    await forwardDeposit("first-storage-deposit", "423456789012345671", 6);
    const parsedStorageManagerDeposit = parseStillWaterEmbed({
      id: "first-storage-manager-deposit",
      title: "Move to container Log",
      description: `Deposited
Steam name : Hosted Steam User
PlayerName: William Winther
Server ID 6
Steam ID: steam:hosted
Deposited 2 Hosted Product To Van Horn Gunsmith Inventory
Deposited · 08/17/26 09:04:36 AM`
    });
    assert.equal(parsedStorageManagerDeposit.item_name, "Hosted Product");
    assert.equal(parsedStorageManagerDeposit.quantity, 2);
    const storageManagerForward = await bridgeRequest("/api/integrations/discord/events", {
      method: "POST",
      body: {
        webhook_id: "first-storage-manager-deposit",
        discord_message_id: "first-storage-manager-deposit",
        // The movement text remains authoritative even if the channel was assigned
        // to the storefront field instead of the storage field.
        discord_channel_id: "223456789012345671",
        event_type: "Stocking Movement",
        direction: "Stock In",
        proposed_item_name: "",
        proposed_quantity: 0,
        item_name: "",
        quantity: 0,
        review_required: true,
        review_reason: "missing_item,missing_quantity",
        discord_title: parsedStorageManagerDeposit.discord_title,
        raw_payload: parsedStorageManagerDeposit.raw_payload,
        occurred_at: "2026-08-02T10:02:00.000Z"
      }
    });
    assert.equal(storageManagerForward.status, 200, JSON.stringify(storageManagerForward.body));
    assert.equal(storageManagerForward.body.transactionWritten, true);
    const ledgerControl = await bridgeRequest("/api/integrations/discord/events", {
      method: "POST",
      body: {
        webhook_id: "first-storage-ledger-control",
        discord_channel_id: "423456789012345671",
        event_type: "Adjustment",
        shop_ledger: 321,
        occurred_at: "2026-08-02T10:05:00.000Z"
      }
    });
    assert.equal(ledgerControl.status, 200, JSON.stringify(ledgerControl.body));
    assert.equal(ledgerControl.body.reviewRequired, undefined);
    assert.equal(ledgerControl.body.ledgerControlWritten, true);
    const firstBootstrapAfterStorage = await request("/api/bootstrap", { cookie: first.cookie });
    assert.equal(
      firstBootstrapAfterStorage.body.sheet.inventory.storage.find(item =>
        (item.ingredient || item.itemName) === "Hosted Product"
      ).storageCount,
      8
    );
    assert.equal(
      firstBootstrapAfterStorage.body.sheet.inventory.products.find(item => item.itemName === "Hosted Product").currentStock,
      4
    );
    assert.equal(firstBootstrapAfterStorage.body.sheet.inventory.ledger.balance, 321);
    const storageManagerLog = firstBootstrapAfterStorage.body.sheet.webhookLog.find(entry =>
      entry.webhookId === "first-storage-manager-deposit"
    );
    assert.equal(storageManagerLog.status, "applied");
    assert.equal(storageManagerLog.channelType, "storage-ledger");
    assert.equal(storageManagerLog.itemName, "Hosted Product");
    assert.equal(storageManagerLog.quantity, 2);
    assert.equal(storageManagerLog.actorName, "William Winther");
    const employeeBootstrapAfterStorage = await request("/api/bootstrap", { cookie: membershipSelect.cookie });
    assert.equal(employeeBootstrapAfterStorage.body.sheet.webhookLog, undefined);
    assert.equal((await database.query(
      "SELECT COUNT(*)::int AS count FROM finance_events WHERE business_id = $1",
      [first.body.workspace.id]
    )).rows[0].count, 0);

    const employeeCatalogAttempt = await request("/api/sync", {
      method: "POST",
      cookie: membershipSelect.cookie,
      body: {
        action: "catalog_item",
        item: { type: "material", name: "Hosted Iron", label: "Hosted Iron", category: "Materials" }
      }
    });
    assert.equal(employeeCatalogAttempt.status, 403);
    const ownerCatalogAddition = await request("/api/sync", {
      method: "POST",
      cookie: first.cookie,
      body: {
        action: "catalog_item",
        item: { type: "material", name: "Hosted Iron", label: "Hosted Iron", category: "Materials", unitCost: 2 }
      }
    });
    assert.equal(ownerCatalogAddition.body.ok, true, JSON.stringify(ownerCatalogAddition.body));
    const catalogBootstrap = await request("/api/bootstrap", { cookie: first.cookie });
    assert.equal(catalogBootstrap.body.materials.find(item => item.name === "Hosted Iron").price, 2);

    const hostedSupplyOrder = await request("/api/supply-orders", {
      method: "POST",
      cookie: first.cookie,
      body: {
        id: "hosted-supply-order",
        producer: "Hosted Supplier",
        status: "Ordered",
        lines: [{
          id: "hosted-component-line",
          name: "Hosted Component",
          label: "Hosted Component",
          quantity: 3,
          unitPrice: 2
        }]
      }
    });
    assert.equal(hostedSupplyOrder.status, 200, JSON.stringify(hostedSupplyOrder.body));
    await forwardStorageMovement({
      id: "hosted-supply-physically-received",
      channelId: "423456789012345671",
      direction: "Stock In",
      itemName: "Hosted Component",
      quantity: 3
    });
    const hostedSupplyReceipt = await request("/api/supply-orders/hosted-supply-order/receive", {
      method: "POST",
      cookie: first.cookie,
      body: { receipts: [{ lineId: "hosted-component-line", quantity: 3 }] }
    });
    assert.equal(hostedSupplyReceipt.status, 200, JSON.stringify(hostedSupplyReceipt.body));
    assert.equal(hostedSupplyReceipt.body.order.status, "Received");
    assert.equal(hostedSupplyReceipt.body.receipts[0].inventoryManagedExternally, true);
    const afterHostedSupplyReceipt = await request("/api/bootstrap", { cookie: first.cookie });
    assert.equal(storageCount(afterHostedSupplyReceipt.body, "Hosted Component"), 3);

    await forwardStorageMovement({
      id: "production-component-received",
      channelId: "423456789012345671",
      direction: "Stock In",
      itemName: "Hosted Component",
      quantity: 7
    });
    const productionOrder = await request("/api/sales-orders", {
      method: "POST",
      cookie: membershipSelect.cookie,
      body: {
        id: "hosted-production-order",
        customer: "Hosted Customer",
        handler: "Arthur Morgan",
        status: "Draft",
        priority: "Normal",
        lines: [{
          id: "hosted-product-line",
          name: "Hosted Product",
          label: "Hosted Product",
          category: "Products",
          quantity: 2,
          unitPrice: 20
        }]
      }
    });
    assert.equal(productionOrder.status, 200, JSON.stringify(productionOrder.body));
    const productionBatch = await request("/api/production-batches", {
      method: "POST",
      cookie: membershipSelect.cookie,
      body: {
        id: "hosted-production-batch",
        sourceType: "Customer Order",
        sourceId: productionOrder.body.order.id,
        reference: "Hosted webhook production",
        lines: [{ itemName: "Hosted Product", quantity: 2 }]
      }
    });
    assert.equal(productionBatch.status, 200, JSON.stringify(productionBatch.body));
    const productionLineId = productionBatch.body.batch.lines[0].id;
    await request("/api/production-batches/hosted-production-batch/start", {
      method: "POST",
      cookie: membershipSelect.cookie,
      body: {}
    });
    await forwardStorageMovement({
      id: "production-component-withdrawn",
      channelId: "423456789012345671",
      direction: "Stock Out",
      itemName: "Hosted Component",
      quantity: 4
    });
    const afterPhysicalMaterialWithdrawal = await request("/api/bootstrap", { cookie: first.cookie });
    assert.equal(storageCount(afterPhysicalMaterialWithdrawal.body, "Hosted Component"), 6);
    const completedHostedProduction = await request("/api/production-batches/hosted-production-batch/progress", {
      method: "POST",
      cookie: membershipSelect.cookie,
      body: { completions: [{ lineId: productionLineId, completedCrafts: 2 }] }
    });
    assert.equal(completedHostedProduction.status, 200, JSON.stringify(completedHostedProduction.body));
    assert.equal(completedHostedProduction.body.batch.status, "Completed");
    assert.equal(completedHostedProduction.body.order.status, "Ready");
    const afterProductionCompletion = await request("/api/bootstrap", { cookie: first.cookie });
    assert.equal(storageCount(afterProductionCompletion.body, "Hosted Component"), 6);
    assert.equal(storageCount(afterProductionCompletion.body, "Hosted Product"), 8);

    await forwardStorageMovement({
      id: "production-output-deposited",
      channelId: "423456789012345671",
      direction: "Stock In",
      itemName: "Hosted Product",
      quantity: 2
    });
    await forwardStorageMovement({
      id: "production-output-delivered",
      channelId: "423456789012345671",
      direction: "Stock Out",
      itemName: "Hosted Product",
      quantity: 2
    });
    const readyHostedOrder = completedHostedProduction.body.order;
    const deliveredHostedOrder = await request("/api/sales-orders", {
      method: "POST",
      cookie: membershipSelect.cookie,
      body: { ...readyHostedOrder, status: "Completed" }
    });
    assert.equal(deliveredHostedOrder.status, 200, JSON.stringify(deliveredHostedOrder.body));
    assert.equal(deliveredHostedOrder.body.order.status, "Completed");
    const afterHostedDelivery = await request("/api/bootstrap", { cookie: first.cookie });
    assert.equal(storageCount(afterHostedDelivery.body, "Hosted Component"), 6);
    assert.equal(storageCount(afterHostedDelivery.body, "Hosted Product"), 8);

    const employeeProfileAttempt = await request("/api/admin/business-profile", {
      method: "PUT",
      cookie: membershipSelect.cookie,
      body: { business: { name: "Unauthorized Rename" } }
    });
    assert.equal(employeeProfileAttempt.status, 403);
    assert.equal(employeeProfileAttempt.body.code, "admin_required");
    const profileUpdate = await request("/api/admin/business-profile", {
      method: "PUT",
      cookie: first.cookie,
      body: {
        business: {
          name: "Frontier Firearms Van Horn",
          description: "Arms, ammunition, and field equipment.",
          logoUrl: "https://example.com/frontier-firearms.png"
        }
      }
    });
    assert.equal(profileUpdate.status, 200, JSON.stringify(profileUpdate.body));
    assert.equal(profileUpdate.body.workspace.name, "Frontier Firearms Van Horn");
    const renamedPublicConfig = await request(`/api/public/config?workspace=${first.body.workspace.code}`);
    assert.equal(renamedPublicConfig.body.business.name, "Frontier Firearms Van Horn");
    const renamedProfile = await request("/api/profile", { cookie: identityCookie });
    assert.equal(
      renamedProfile.body.memberships.find(entry => entry.businessId === first.body.workspace.id).businessName,
      "Frontier Firearms Van Horn"
    );

    const unknownChannel = await bridgeRequest("/api/integrations/discord/events", {
      method: "POST",
      body: depositPayload("unknown-deposit", "223456789012345679", 1)
    });
    assert.equal(unknownChannel.status, 404);
    assert.equal(unknownChannel.body.code, "discord_channel_unregistered");

    const temporaryOwnerPassword = "temporary-owner-password-42";
    const ownerReset = await request(`/api/operator/workspaces/${first.body.workspace.id}/reset-owner`, {
      method: "POST",
      cookie: operatorCookie,
      body: { password: temporaryOwnerPassword }
    });
    assert.equal(ownerReset.status, 200, JSON.stringify(ownerReset.body));
    assert.equal(ownerReset.body.owner.fullName, "William Winther");
    const invalidatedOwnerSession = await request("/api/auth/session", { cookie: first.cookie });
    assert.equal(invalidatedOwnerSession.body.user, null);
    const recoveredOwner = await request("/api/auth/login", {
      method: "POST",
      body: {
        workspaceCode: first.body.workspace.code,
        fullName: "William Winther",
        password: temporaryOwnerPassword
      }
    });
    assert.equal(recoveredOwner.status, 200, JSON.stringify(recoveredOwner.body));
    const recoveryAudit = await request("/api/operator/overview", { cookie: operatorCookie });
    assert.equal(recoveryAudit.body.audit[0].action, "workspace.owner_password_reset");
    assert.equal(JSON.stringify(recoveryAudit.body).includes(temporaryOwnerPassword), false);
    const profileAudit = await request("/api/admin/audit?limit=1000", { cookie: recoveredOwner.cookie });
    assert(profileAudit.body.events.some(event => event.action === "business.profile_updated"));

    console.log("Hosted workspace HTTP and Discord routing tests passed.");
  } finally {
    if (server.listening) await new Promise(resolve => server.close(resolve));
    if (discordServer.listening) await new Promise(resolve => discordServer.close(resolve));
    await database.close();
    require.cache[pgPath].exports = originalPg;
  }
}

async function createBusiness(name, referenceId, ownerName, discordIntegration = null, inviteCode = process.env.HOSTED_SIGNUP_SECRET) {
  const configuration = defaultSetupConfiguration();
  configuration.business.name = name;
  configuration.business.referenceId = referenceId;
  configuration.catalog.products = [{
    name: "Hosted Product",
    label: "Hosted Product",
    tag: "hosted_product",
    category: "Products",
    salePrice: 20,
    target: 5,
    active: true
  }];
  configuration.catalog.materials = [{
    name: "Hosted Component",
    category: "Materials",
    unit: "unit",
    unitCost: 2,
    storageTarget: 0
  }];
  configuration.catalog.recipes = [{
    productName: "Hosted Product",
    yield: 1,
    ingredients: [{ name: "Hosted Component", quantity: 2, sourceLocation: "Storage" }]
  }];
  const response = await request("/api/setup/complete", {
    method: "POST",
    body: {
      inviteCode,
      discordIntegration,
      configuration,
      owner: { fullName: ownerName, password: "owner-password-123" }
    }
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  assert.ok(response.cookie);
  return response;
}

async function configureDiscord(cookie, guildId, eventChannelId, storageLedgerChannelId = "") {
  const response = await request("/api/integrations/discord/configuration", {
    method: "POST",
    cookie,
    body: { guildId, eventChannelId, storageLedgerChannelId }
  });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.integration.eventChannelId, eventChannelId);
  assert.equal(response.body.integration.storageLedgerChannelId, storageLedgerChannelId);
}

async function forwardDeposit(id, channelId, quantity) {
  const response = await bridgeRequest("/api/integrations/discord/events", {
    method: "POST",
    body: depositPayload(id, channelId, quantity)
  });
  assert.equal(response.status, 200, JSON.stringify(response.body));
}

function depositPayload(id, channelId, quantity) {
  return {
    webhook_id: id,
    discord_message_id: id,
    discord_channel_id: channelId,
    event_type: "Stocking Movement",
    direction: "Stock In",
    discord_item_name: "hosted_product",
    discord_item_label: "Hosted Product",
    item_name: "Hosted Product",
    quantity,
    current_item_total: quantity,
    unit_price: 20,
    occurred_at: "2026-08-02T10:00:00.000Z"
  };
}

function bridgeRequest(path, options = {}) {
  return request(path, {
    ...options,
    headers: { ...(options.headers || {}), authorization: `Bearer ${process.env.BRIDGE_API_TOKEN}` }
  });
}

async function forwardStorageMovement({ id, channelId, direction, itemName, quantity }) {
  const response = await bridgeRequest("/api/integrations/discord/events", {
    method: "POST",
    body: {
      webhook_id: id,
      discord_message_id: id,
      discord_channel_id: channelId,
      event_type: "Stocking Movement",
      direction,
      item_name: itemName,
      discord_item_name: itemName,
      discord_item_label: itemName,
      quantity,
      occurred_at: "2026-08-17T20:00:00.000Z"
    }
  });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.transactionWritten, true);
  return response.body;
}

function storageCount(bootstrap, itemName) {
  return Number(bootstrap.sheet.inventory.storage.find(item =>
    (item.ingredient || item.itemName) === itemName
  )?.storageCount || 0);
}

function joinCookies(...cookies) {
  return cookies.filter(Boolean).join("; ");
}

async function request(path, { method = "GET", body = null, cookie = "", headers = {}, redirect = "follow" } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    redirect,
    headers: {
      accept: "application/json",
      ...(body ? { "content-type": "application/json" } : {}),
      ...(cookie ? { cookie } : {}),
      ...headers
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text ? JSON.parse(text) : {},
    cookie: String(response.headers.get("set-cookie") || "").split(";", 1)[0],
    location: String(response.headers.get("location") || "")
  };
}

function createFakeDiscordServer() {
  return http.createServer(async (request, response) => {
    if (request.url === "/api/v10/oauth2/token" && request.method === "POST") {
      await readRequestBody(request);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ access_token: "hosted-test-access-token", token_type: "Bearer" }));
      return;
    }
    if (request.url === "/api/v10/users/@me" && request.method === "GET") {
      assert.equal(request.headers.authorization, "Bearer hosted-test-access-token");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        id: "123456789012345678",
        username: "hosted_tester",
        global_name: "Hosted Tester",
        avatar: "test-avatar"
      }));
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ message: "not found" }));
  });
}

function readRequestBody(request) {
  return new Promise(resolve => {
    let body = "";
    request.on("data", chunk => { body += chunk; });
    request.on("end", () => resolve(body));
  });
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
