const fs = require("node:fs");
const path = require("node:path");
const { BusinessStore } = require("../app/business-store");
const { Database, TenantDocumentRepository } = require("../app/database");
const { normalizeSetupPayload } = require("../app/setup-config");
const { StandaloneStore } = require("../app/standalone-store");

const commit = process.argv.includes("--commit");
const planPath = resolvePlanPath();

run().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});

async function run() {
  const plan = readPlan(planPath);
  const database = new Database({ connectionString: process.env.DATABASE_URL || "" });
  if (!database.enabled) throw new Error("DATABASE_URL is required.");
  try {
    await database.initialize();
    const business = await requireBusiness(database, plan);
    const before = await inspectBusiness(database, plan);
    validateDeleteSelectors(before.financeDeletes, plan.financeDeletes || []);
    printReport("before", { mode: commit ? "commit" : "dry-run", plan: path.basename(planPath), business, ...before });
    if (!commit) {
      console.log("Dry run only. Re-run with --commit after checking the expected counts and totals.");
      return;
    }

    await ensureRecipes(database, plan);
    await deleteFinanceRows(database, plan);
    await ensureDiscordIntegration(database, plan);
    const replay = await replayWebhooks(database, plan);
    const after = await inspectBusiness(database, plan);
    validateExpectedState(after, plan.expected || {});
    printReport("after", { mode: "commit", replay, ...after });
  } finally {
    await database.close();
  }
}

function resolvePlanPath() {
  const explicitIndex = process.argv.indexOf("--plan");
  const value = explicitIndex >= 0 ? process.argv[explicitIndex + 1] : process.env.BUSINESS_REPAIR_PATH;
  if (!value) throw new Error("Pass --plan <file> or set BUSINESS_REPAIR_PATH.");
  return path.resolve(value);
}

function readPlan(filePath) {
  if (!fs.existsSync(filePath)) throw new Error(`Repair plan not found: ${filePath}`);
  const plan = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (plan.schemaVersion !== 1 || !plan.businessId) throw new Error("Repair plan schemaVersion 1 and businessId are required.");
  return plan;
}

async function requireBusiness(database, plan) {
  const result = await database.query(`
    SELECT id, workspace_code, name, reference_id, status
    FROM businesses
    WHERE id = $1
  `, [plan.businessId]);
  if (!result.rowCount) throw new Error(`Business not found: ${plan.businessId}`);
  const business = result.rows[0];
  if (plan.expectedBusinessName && business.name !== plan.expectedBusinessName) {
    throw new Error(`Business name mismatch: expected ${plan.expectedBusinessName}, found ${business.name}`);
  }
  if (plan.expectedReferenceId && business.reference_id !== String(plan.expectedReferenceId)) {
    throw new Error(`Business reference mismatch: expected ${plan.expectedReferenceId}, found ${business.reference_id}`);
  }
  return business;
}

async function inspectBusiness(database, plan) {
  const store = new StandaloneStore(database, { businessId: plan.businessId });
  const [snapshot, finance, configurationResult, integrationResult] = await Promise.all([
    store.snapshot(),
    store.finance(),
    database.query(`
      SELECT data FROM tenant_documents
      WHERE business_id = $1 AND document_key = 'business'
    `, [plan.businessId]),
    database.query(`
      SELECT guild_id, event_channel_id, inventory_channel_id, alert_channel_id, status
      FROM business_integrations
      WHERE business_id = $1 AND provider = 'discord'
    `, [plan.businessId])
  ]);
  const configuration = configurationResult.rows[0]?.data?.configuration || null;
  const financeDeletes = [];
  for (const selector of plan.financeDeletes || []) {
    financeDeletes.push(await inspectFinanceSelector(database, plan.businessId, selector));
  }
  const webhookIds = (plan.webhookEvents || []).map(event => String(event.webhook_id || event.discord_message_id || ""));
  const existingWebhooks = webhookIds.length
    ? await database.query(`
        SELECT webhook_id, status FROM webhook_events
        WHERE business_id = $1 AND webhook_id = ANY($2::text[])
        ORDER BY occurred_at, webhook_id
      `, [plan.businessId, webhookIds])
    : { rows: [] };
  return {
    catalog: {
      products: snapshot.inventory.products.length,
      materials: snapshot.inventory.materials.length,
      recipes: Array.isArray(configuration?.catalog?.recipes) ? configuration.catalog.recipes.length : 0
    },
    inventory: {
      storefrontUnits: sum(snapshot.inventory.products, row => row.currentStock),
      storageUnits: sum(snapshot.inventory.storage, row => row.storageCount),
      ledgerBalance: nullableNumber(snapshot.inventory.ledger?.balance),
      products: Object.fromEntries(snapshot.inventory.products.map(row => [row.itemName, Number(row.currentStock || 0)]))
    },
    finance: finance.totals,
    financeDeletes,
    recipesPresent: (plan.recipes || []).map(recipe => ({
      output: recipe.productName,
      present: Boolean(configuration?.catalog?.recipes?.some(candidate => key(candidate.productName) === key(recipe.productName)))
    })),
    discordIntegration: integrationResult.rows[0] || null,
    replay: { planned: webhookIds.length, alreadyPresent: existingWebhooks.rows }
  };
}

async function inspectFinanceSelector(database, businessId, selector) {
  const { clause, values } = financeSelector(selector, businessId);
  const result = await database.query(`
    SELECT event_id, entry_type, category, label, source, amount
    FROM finance_events
    WHERE ${clause}
    ORDER BY event_id
  `, values);
  return {
    name: selector.name || "finance rows",
    count: result.rowCount,
    amount: money(sum(result.rows, row => row.amount)),
    rows: result.rows
  };
}

function financeSelector(selector, businessId) {
  const values = [businessId];
  const clauses = ["business_id = $1"];
  if (Array.isArray(selector.eventIds) && selector.eventIds.length) {
    values.push(selector.eventIds.map(String));
    clauses.push(`event_id = ANY($${values.length}::text[])`);
  }
  if (selector.category) {
    values.push(String(selector.category));
    clauses.push(`category = $${values.length}`);
  }
  if (selector.source) {
    values.push(String(selector.source));
    clauses.push(`source = $${values.length}`);
  }
  if (selector.importedAggregate === true) clauses.push("metadata->>'importedAggregate' = 'true'");
  if (clauses.length === 1) throw new Error(`Unsafe finance selector: ${selector.name || "unnamed"}`);
  return { clause: clauses.join(" AND "), values };
}

function validateDeleteSelectors(actual, expected) {
  actual.forEach((result, index) => {
    const selector = expected[index];
    if (selector.allowEmptyAfterApply === true && result.count === 0) return;
    if (selector.expectedCount !== undefined && result.count !== Number(selector.expectedCount)) {
      throw new Error(`${result.name}: expected ${selector.expectedCount} rows, found ${result.count}`);
    }
    if (selector.expectedAmount !== undefined && result.amount !== money(selector.expectedAmount)) {
      throw new Error(`${result.name}: expected ${money(selector.expectedAmount)}, found ${result.amount}`);
    }
  });
}

async function ensureRecipes(database, plan) {
  if (!(plan.recipes || []).length) return;
  const repository = new TenantDocumentRepository(database, plan.businessId, "business");
  const document = await repository.load();
  if (!document?.configuration) throw new Error("Business configuration document is missing.");
  const recipes = Array.isArray(document.configuration.catalog?.recipes)
    ? [...document.configuration.catalog.recipes]
    : [];
  for (const recipe of plan.recipes) {
    const index = recipes.findIndex(candidate => key(candidate.productName) === key(recipe.productName));
    if (index >= 0) {
      if (JSON.stringify(normalizeRecipeComparable(recipes[index])) !== JSON.stringify(normalizeRecipeComparable(recipe))) {
        throw new Error(`Recipe already exists with different ingredients: ${recipe.productName}`);
      }
      continue;
    }
    recipes.push(recipe);
  }
  const configuration = normalizeSetupPayload({
    ...document.configuration,
    catalog: { ...document.configuration.catalog, recipes }
  });
  configuration.completedAt = document.configuration.completedAt;
  configuration.completedBy = document.configuration.completedBy;
  await repository.save({ ...document, configuration });
  await new StandaloneStore(database, { businessId: plan.businessId }).syncCatalog(configuration);
}

async function deleteFinanceRows(database, plan) {
  for (const selector of plan.financeDeletes || []) {
    const { clause, values } = financeSelector(selector, plan.businessId);
    await database.query(`DELETE FROM finance_events WHERE ${clause}`, values);
  }
}

async function ensureDiscordIntegration(database, plan) {
  const input = plan.discordIntegration;
  if (!input?.eventChannelId) return;
  const ids = [input.guildId, input.eventChannelId, input.inventoryChannelId, input.alertChannelId]
    .map(value => String(value || "").trim());
  if (!/^\d{15,22}$/.test(ids[1])) throw new Error("Discord event channel ID is invalid.");
  await database.query(`
    INSERT INTO business_integrations (
      business_id, provider, guild_id, event_channel_id, inventory_channel_id,
      alert_channel_id, status, metadata, updated_at
    ) VALUES ($1, 'discord', $2, $3, $4, $5, 'active', $6::jsonb, now())
    ON CONFLICT (business_id, provider) DO UPDATE SET
      guild_id = EXCLUDED.guild_id,
      event_channel_id = EXCLUDED.event_channel_id,
      inventory_channel_id = EXCLUDED.inventory_channel_id,
      alert_channel_id = EXCLUDED.alert_channel_id,
      status = 'active',
      metadata = EXCLUDED.metadata,
      updated_at = now()
  `, [plan.businessId, ids[0], ids[1], ids[2], ids[3], JSON.stringify({ repairedBy: "repair-business.js" })]);
}

async function replayWebhooks(database, plan) {
  const store = new StandaloneStore(database, { businessId: plan.businessId });
  const results = [];
  for (const event of plan.webhookEvents || []) {
    const result = await store.ingestWebhook(event);
    if (result.reviewRequired) throw new Error(`Replay entered review instead of applying: ${result.webhookId}`);
    results.push({ webhookId: result.webhookId, duplicate: Boolean(result.duplicate), status: result.status || "applied" });
  }
  return {
    total: results.length,
    applied: results.filter(result => !result.duplicate).length,
    duplicates: results.filter(result => result.duplicate).length,
    results
  };
}

function validateExpectedState(actual, expected) {
  const checks = [
    ["storefront units", actual.inventory.storefrontUnits, expected.storefrontUnits],
    ["storage units", actual.inventory.storageUnits, expected.storageUnits],
    ["ledger balance", actual.inventory.ledgerBalance, expected.ledgerBalance],
    ["finance revenue", actual.finance.revenue, expected.finance?.revenue],
    ["finance expenses", actual.finance.expenses, expected.finance?.expenses],
    ["finance profit", actual.finance.profit, expected.finance?.profit]
  ];
  checks.forEach(([label, value, wanted]) => {
    if (wanted !== undefined && Number(value) !== Number(wanted)) {
      throw new Error(`Final ${label} mismatch: expected ${wanted}, found ${value}`);
    }
  });
  Object.entries(expected.products || {}).forEach(([name, quantity]) => {
    if (actual.inventory.products[name] !== Number(quantity)) {
      throw new Error(`Final stock mismatch for ${name}: expected ${quantity}, found ${actual.inventory.products[name]}`);
    }
  });
  if (actual.financeDeletes.some(selector => selector.count !== 0)) {
    throw new Error("One or more selected finance rows remain after repair.");
  }
  if (actual.recipesPresent.some(recipe => !recipe.present)) throw new Error("A required recipe is still missing.");
  if (expected.eventChannelId && actual.discordIntegration?.event_channel_id !== String(expected.eventChannelId)) {
    throw new Error("Discord event channel integration did not match the repair plan.");
  }
}

function normalizeRecipeComparable(recipe) {
  return {
    productName: String(recipe.productName || "").trim(),
    yield: Number(recipe.yield || 1),
    ingredients: (recipe.ingredients || []).map(ingredient => ({
      name: String(ingredient.name || "").trim(),
      quantity: Number(ingredient.quantity || 0)
    }))
  };
}

function printReport(stage, report) {
  console.log(JSON.stringify({ stage, ...report }, null, 2));
}

function sum(rows, selector) {
  return (Array.isArray(rows) ? rows : []).reduce((total, row) => total + Number(selector(row) || 0), 0);
}

function money(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}

function nullableNumber(value) {
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function key(value) {
  return String(value || "").trim().toLowerCase();
}
