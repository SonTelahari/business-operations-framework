const assert = require("node:assert/strict");
const { newDb } = require("pg-mem");
const { Database } = require("./database");
const { LocalIdentityStore } = require("./local-identity");
const { TenantManager } = require("./tenant-manager");
const { defaultSetupConfiguration } = require("./setup-config");

async function run() {
  const memory = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true });
  const adapter = memory.adapters.createPg();
  const database = new Database({ pool: new adapter.Pool() });
  const sessionSecret = "local-job-profile-test-secret-with-32-characters";

  try {
    await database.initialize();
    const tenants = new TenantManager({ database, sessionSecret });
    const gunstore = await createBusiness(tenants, "Frontier Firearms", "William Winther");
    const saloon = await createBusiness(tenants, "Loose Ends Saloon", "Hosea Matthews");
    const tobacconist = await createBusiness(tenants, "Lakefront Tobacco", "Mary Linton");

    const saloonJob = await approvedUser(saloon, "William Winther", "saloon-password-123", "employee");
    const tobaccoJob = await approvedUser(tobacconist, "William Winther", "tobacco-password-123", "manager");
    const identities = new LocalIdentityStore({ database, tenantManager: tenants, sessionSecret });

    const primaryIdentity = await identities.ensureIdentityForUser(gunstore.business.id, gunstore.owner.id);
    const separateSaloonIdentity = await identities.ensureIdentityForUser(saloon.business.id, saloonJob.id);
    const staleSaloonToken = identities.createSession(separateSaloonIdentity);
    assert.notEqual(primaryIdentity.id, separateSaloonIdentity.id);

    await identities.linkJob(primaryIdentity.id, saloon.business.id, saloonJob.id);
    assert.equal(await identities.verifySession(staleSaloonToken), null, "the merged one-job profile should be retired");
    await identities.linkJob(primaryIdentity.id, tobacconist.business.id, tobaccoJob.id);

    const jobs = await identities.listJobs(primaryIdentity.id);
    assert.equal(jobs.length, 3);
    assert.deepEqual(
      Object.fromEntries(jobs.map(job => [job.businessName, job.role])),
      {
        "Frontier Firearms": "admin",
        "Lakefront Tobacco": "manager",
        "Loose Ends Saloon": "employee"
      }
    );
    assert.equal((await identities.getActiveJob(primaryIdentity.id, saloon.business.id)).userId, saloonJob.id);

    const identityToken = identities.createSession(primaryIdentity);
    assert.equal((await identities.verifySession(identityToken)).id, primaryIdentity.id);
    assert.equal(
      (await identities.resolveIdentityForUser(identityToken, gunstore.business.id, gunstore.owner.id)).id,
      primaryIdentity.id
    );

    const otherSaloonUser = await approvedUser(saloon, "Arthur Morgan", "other-saloon-password-123", "employee");
    await assert.rejects(
      identities.linkJob(primaryIdentity.id, saloon.business.id, otherSaloonUser.id),
      error => error.code === "job_business_already_linked"
    );

    await saloon.context.accountStore.disable(saloonJob.id, saloon.owner);
    assert.equal(await identities.getActiveJob(primaryIdentity.id, saloon.business.id), null);
    assert.equal((await identities.getJob(primaryIdentity.id, saloon.business.id)).status, "disabled");

    console.log("Local personal job profiles and business switching checks passed.");
  } finally {
    await database.close();
  }
}

async function createBusiness(tenants, name, ownerName) {
  const configuration = defaultSetupConfiguration();
  configuration.business.name = name;
  return tenants.createWorkspace({
    configuration,
    owner: { fullName: ownerName, password: "owner-password-123" }
  });
}

async function approvedUser(business, name, password, role) {
  const user = await business.context.accountStore.register(name, password);
  await business.context.accountStore.approve(user.id, business.owner);
  if (role === "manager") await business.context.accountStore.setRole(user.id, "manager", business.owner);
  return business.context.accountStore.getUserById(user.id);
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
