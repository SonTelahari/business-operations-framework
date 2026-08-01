const { Database } = require("../app/database");
const { StandaloneStore } = require("../app/standalone-store");

const sourceUrl = String(process.env.LEGACY_APPS_SCRIPT_URL || "").trim();
const databaseUrl = String(process.env.DATABASE_URL || "").trim();
const commit = process.argv.includes("--commit");

run().catch(error => {
  console.error(error.message || error);
  process.exitCode = 1;
});

async function run() {
  if (!sourceUrl) throw new Error("Set LEGACY_APPS_SCRIPT_URL to the old Apps Script /exec URL");
  const [snapshot, finance] = await Promise.all([
    fetchLegacy("bootstrap"),
    fetchLegacy("finance")
  ]);
  const summary = {
    products: snapshot.inventory?.products?.length || 0,
    materials: snapshot.inventory?.materials?.length || 0,
    storageCounts: snapshot.inventory?.storage?.length || 0,
    ledgerAvailable: Number.isFinite(Number(snapshot.inventory?.ledger?.balance)),
    financeRows: finance.breakdown?.length || 0
  };
  if (!commit) {
    console.log(JSON.stringify({ ok: true, mode: "dry-run", summary }, null, 2));
    console.log("Dry run only. Re-run with --commit after checking the totals.");
    return;
  }
  if (!databaseUrl) throw new Error("Set DATABASE_URL before committing an import");

  const database = new Database({ connectionString: databaseUrl });
  try {
    await database.initialize();
    const store = new StandaloneStore(database);
    const result = await store.importLegacySnapshot({
      snapshot,
      finance,
      actor: process.env.IMPORT_ACTOR || "Legacy Apps Script import"
    });
    console.log(JSON.stringify({ ...result, mode: "commit" }, null, 2));
  } finally {
    await database.close();
  }
}

async function fetchLegacy(action) {
  const url = new URL(sourceUrl);
  url.searchParams.set("action", action);
  const response = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(60000)
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Legacy ${action} request failed (${response.status})`);
  let result;
  try {
    result = JSON.parse(text);
  } catch {
    throw new Error(`Legacy ${action} request returned non-JSON content`);
  }
  if (!result?.ok) throw new Error(result?.error || `Legacy ${action} data is unavailable`);
  return result;
}
