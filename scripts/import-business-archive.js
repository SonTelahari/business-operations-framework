const fs = require("node:fs");
const path = require("node:path");
const { archiveSummary, validateBusinessArchive } = require("../app/business-archive");
const { Database } = require("../app/database");
const { TenantManager } = require("../app/tenant-manager");

const commit = process.argv.includes("--commit");
const allowDuplicate = process.argv.includes("--allow-duplicate");

run().catch(error => {
  console.error(error.message || error);
  process.exitCode = 1;
});

async function run() {
  const archivePath = path.resolve(String(process.env.BUSINESS_ARCHIVE_PATH || "").trim());
  if (!process.env.BUSINESS_ARCHIVE_PATH) throw new Error("Set BUSINESS_ARCHIVE_PATH to the exported archive JSON file");
  const archive = validateBusinessArchive(JSON.parse(await fs.promises.readFile(archivePath, "utf8")));
  const summary = archiveSummary(archive);
  if (!commit) {
    console.log(JSON.stringify({ ok: true, mode: "dry-run", archivePath, summary }, null, 2));
    console.log("Dry run only. Re-run with --commit after checking the totals and warnings.");
    return;
  }

  const databaseUrl = String(process.env.DATABASE_URL || "").trim();
  const sessionSecret = String(process.env.AUTH_SESSION_SECRET || "").trim();
  const ownerName = String(process.env.IMPORT_OWNER_NAME || "").trim();
  const ownerPassword = String(process.env.IMPORT_OWNER_PASSWORD || "");
  if (!databaseUrl) throw new Error("Set DATABASE_URL before committing an import");
  if (sessionSecret.length < 32) throw new Error("Set AUTH_SESSION_SECRET to at least 32 characters");
  if (!ownerName || !ownerPassword) throw new Error("Set IMPORT_OWNER_NAME and IMPORT_OWNER_PASSWORD for the new owner login");

  const database = new Database({ connectionString: databaseUrl });
  try {
    await database.initialize();
    const tenants = new TenantManager({ database, sessionSecret });
    const result = await tenants.createWorkspaceFromArchive({
      archive,
      owner: { fullName: ownerName, password: ownerPassword },
      actor: process.env.IMPORT_ACTOR || ownerName,
      allowDuplicate
    });
    console.log(JSON.stringify({
      ok: true,
      mode: "commit",
      business: result.business,
      migration: result.migration,
      verification: summary
    }, null, 2));
  } finally {
    await database.close();
  }
}
