const assert = require("node:assert/strict");
const { once } = require("node:events");
const http = require("node:http");
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
    assert.equal(health.body.version, "0.2.0");
    assert.equal(health.body.release, "hosted-test-release");
    const serviceWorker = await fetch(`${baseUrl}/service-worker.js`).then(response => response.text());
    assert.match(serviceWorker, /\/\/ release:hosted-test-release\s*$/);

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
    if (discordServer.listening) await new Promise(resolve => discordServer.close(resolve));
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
