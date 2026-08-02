const assert = require("node:assert/strict");
const { once } = require("node:events");
const { newDb } = require("pg-mem");
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
process.env.AUTH_SESSION_SECRET = "hosted-server-test-session-secret-with-32-characters";
process.env.BRIDGE_API_TOKEN = "hosted-server-test-bridge-secret";
process.env.PORT = "4296";
delete process.env.ADMIN_FULL_NAME;
delete process.env.ADMIN_PASSWORD;

const { server, startServer, database } = require("./server");
const baseUrl = `http://127.0.0.1:${process.env.PORT}`;

async function run() {
  try {
    const listening = once(server, "listening");
    await startServer();
    if (!server.listening) await listening;

    const health = await request("/health");
    assert.equal(health.body.hostedMode, true);
    assert.equal(health.body.tenantScoped, true);

    const setupStatus = await request("/api/setup/status");
    assert.equal(setupStatus.body.workspaceSignup.mode, "invite");
    assert.equal(setupStatus.body.workspaceSignup.inviteRequired, true);
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
      eventChannelId: "223456789012345671"
    });
    const second = await createBusiness("Frontier Firearms", "23", "William Winther");
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

    await configureDiscord(second.cookie, "123456789012345672", "223456789012345672");
    await forwardDeposit("first-deposit", "223456789012345671", 4);
    await forwardDeposit("second-deposit", "223456789012345672", 9);

    const firstSnapshot = await bridgeRequest(`/api/integrations/discord/snapshot?discord_channel_id=223456789012345671`);
    const secondSnapshot = await bridgeRequest(`/api/integrations/discord/snapshot?discord_channel_id=223456789012345672`);
    assert.equal(firstSnapshot.body.inventory.products[0].currentStock, 4);
    assert.equal(secondSnapshot.body.inventory.products[0].currentStock, 9);

    const unknownChannel = await bridgeRequest("/api/integrations/discord/events", {
      method: "POST",
      body: depositPayload("unknown-deposit", "223456789012345679", 1)
    });
    assert.equal(unknownChannel.status, 404);
    assert.equal(unknownChannel.body.code, "discord_channel_unregistered");

    console.log("Hosted workspace HTTP and Discord routing tests passed.");
  } finally {
    if (server.listening) await new Promise(resolve => server.close(resolve));
    await database.close();
    require.cache[pgPath].exports = originalPg;
  }
}

async function createBusiness(name, referenceId, ownerName, discordIntegration = null) {
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
  const response = await request("/api/setup/complete", {
    method: "POST",
    body: {
      inviteCode: process.env.HOSTED_SIGNUP_SECRET,
      discordIntegration,
      configuration,
      owner: { fullName: ownerName, password: "owner-password-123" }
    }
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  assert.ok(response.cookie);
  return response;
}

async function configureDiscord(cookie, guildId, eventChannelId) {
  const response = await request("/api/integrations/discord/configuration", {
    method: "POST",
    cookie,
    body: { guildId, eventChannelId }
  });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.integration.eventChannelId, eventChannelId);
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

async function request(path, { method = "GET", body = null, cookie = "", headers = {} } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
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
    cookie: String(response.headers.get("set-cookie") || "").split(";", 1)[0]
  };
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
