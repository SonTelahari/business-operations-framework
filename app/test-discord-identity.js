const assert = require("node:assert/strict");
const { newDb } = require("pg-mem");
const { Database } = require("./database");
const { DiscordIdentityStore } = require("./discord-identity");
const { TenantManager } = require("./tenant-manager");
const { defaultSetupConfiguration } = require("./setup-config");

async function run() {
  const memory = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true });
  const adapter = memory.adapters.createPg();
  const database = new Database({ pool: new adapter.Pool() });
  await database.initialize();

  try {
    const sessionSecret = "discord-identity-test-session-secret-32";
    const tenants = new TenantManager({ database, sessionSecret });
    const firstBusiness = await createBusiness(tenants, "Frontier Firearms", "23");
    const secondBusiness = await createBusiness(tenants, "Frontier Firearms", "23");
    const requests = [];
    const identities = new DiscordIdentityStore({
      database,
      sessionSecret,
      clientId: "test-client-id",
      clientSecret: "test-client-secret",
      redirectUri: "http://localhost/auth/discord/callback",
      apiBaseUrl: "https://discord.test/api/v10",
      authorizeUrl: "https://discord.test/oauth2/authorize",
      fetchImpl: async (url, options = {}) => {
        requests.push({ url, options });
        if (url.endsWith("/oauth2/token")) {
          assert.match(String(options.body), /code_verifier=/);
          return jsonResponse({ access_token: "test-access-token", token_type: "Bearer" });
        }
        if (url.endsWith("/users/@me")) {
          assert.equal(options.headers.authorization, "Bearer test-access-token");
          return jsonResponse({
            id: "123456789012345678",
            username: "ledger_tester",
            global_name: "Ledger Tester",
            avatar: "avatar-hash"
          });
        }
        return jsonResponse({ message: "not found" }, 404);
      }
    });

    assert.equal(identities.enabled, true);
    const authorizationUrl = new URL(await identities.beginAuthorization("/profile.html"));
    assert.equal(authorizationUrl.searchParams.get("scope"), "identify");
    assert.equal(authorizationUrl.searchParams.get("code_challenge_method"), "S256");
    const state = authorizationUrl.searchParams.get("state");
    const completed = await identities.completeAuthorization({ state, code: "authorization-code" });
    assert.equal(completed.identity.discordUserId, "123456789012345678");
    assert.equal(requests.length, 2);
    await assert.rejects(
      identities.completeAuthorization({ state, code: "replayed-code" }),
      error => error.code === "oauth_state_invalid"
    );

    const identityToken = identities.createIdentitySession(completed.identity);
    assert.equal((await identities.verifyIdentitySession(identityToken)).id, completed.identity.id);

    const character = await identities.createCharacter(completed.identity.id, {
      name: "William Winther",
      settingName: "Still Water"
    });
    await assert.rejects(
      identities.createCharacter(completed.identity.id, { name: "william winther" }),
      error => error.code === "character_name_taken"
    );
    const renamed = await identities.updateCharacter(completed.identity.id, character.id, {
      name: "William Winther",
      settingName: "Still Water RP"
    });
    assert.equal(renamed.settingName, "Still Water RP");

    const firstMembership = await identities.requestMembership(
      completed.identity.id,
      character.id,
      firstBusiness.business.workspaceCode
    );
    const secondMembership = await identities.requestMembership(
      completed.identity.id,
      character.id,
      secondBusiness.business.workspaceCode
    );
    assert.notEqual(firstMembership.id, secondMembership.id);
    assert.equal(firstMembership.status, "pending");
    assert.equal(secondMembership.status, "pending");

    const profile = await identities.listProfile(completed.identity.id);
    assert.equal(profile.characters.length, 1);
    assert.equal(profile.memberships.length, 2);
    assert.equal(await identities.getActiveMembership(
      completed.identity.id,
      firstMembership.id,
      firstBusiness.business.id
    ), null);

    const approved = await identities.manageMembership(
      firstBusiness.business.id,
      firstMembership.id,
      "approve",
      firstBusiness.owner
    );
    assert.equal(approved.status, "active");
    const promoted = await identities.manageMembership(
      firstBusiness.business.id,
      firstMembership.id,
      "promote",
      firstBusiness.owner
    );
    assert.equal(promoted.role, "manager");

    const active = await identities.recordMembershipLogin(
      completed.identity.id,
      firstMembership.id,
      firstBusiness.business.id
    );
    assert.equal(active.fullName, "William Winther");
    assert.equal(active.accountType, "discord");
    assert.ok(active.lastLoginAt);
    assert.ok((await identities.listBusinessMemberships(firstBusiness.business.id))[0].lastLoginAt);
    const membershipToken = identities.createMembershipSession(active);
    assert.equal((await identities.authenticateMembershipSession(membershipToken)).businessId, firstBusiness.business.id);
    assert.equal(await identities.getActiveMembership(
      completed.identity.id,
      firstMembership.id,
      secondBusiness.business.id
    ), null);

    const linked = await identities.activateLinkedMembership({
      identityId: completed.identity.id,
      characterId: character.id,
      businessId: secondBusiness.business.id,
      role: "admin",
      localUserId: secondBusiness.owner.id
    });
    assert.equal(linked.role, "admin");
    assert.equal(linked.status, "active");
    const secondStaff = await identities.listBusinessMemberships(secondBusiness.business.id);
    assert.equal(secondStaff[0].localUserId, secondBusiness.owner.id);

    await assert.rejects(
      identities.archiveCharacter(completed.identity.id, character.id),
      error => error.code === "character_in_use"
    );
    await identities.manageMembership(
      firstBusiness.business.id,
      firstMembership.id,
      "disable",
      firstBusiness.owner
    );
    assert.equal(await identities.authenticateMembershipSession(membershipToken), null);

    const linkedToken = identities.createMembershipSession(linked);
    assert.ok(await identities.authenticateMembershipSession(linkedToken));
    await database.query(
      "UPDATE discord_identities SET status = 'disabled' WHERE id = $1",
      [completed.identity.id]
    );
    assert.equal(await identities.verifyIdentitySession(identityToken), null);
    assert.equal(await identities.authenticateMembershipSession(linkedToken), null);

    console.log("Discord identity, character, membership, and OAuth state tests passed.");
  } finally {
    await database.close();
  }
}

async function createBusiness(tenants, name, referenceId) {
  const configuration = defaultSetupConfiguration();
  configuration.business.name = name;
  configuration.business.referenceId = referenceId;
  return tenants.createWorkspace({
    configuration,
    owner: { fullName: "Local Business Owner", password: "owner-password-123" }
  });
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" }
  });
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
