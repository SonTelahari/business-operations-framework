const crypto = require("node:crypto");
const {
  defaultSetupConfiguration,
  normalizeSetupPayload
} = require("./setup-config");

const ARCHIVE_FORMAT = "business-operations-archive";
const ARCHIVE_VERSION = 1;
const SENSITIVE_KEY = /^(?:password|passwordHash|password_hash|token|accessToken|refreshToken|cookie|session|secret)$/i;

function createLegacyBusinessArchive({
  bootstrap,
  suppliers = [],
  supplyOrders = [],
  users = [],
  audit = [],
  finance = null,
  source = {},
  business = {},
  materialCosts = {},
  productPrices = {},
  warnings = []
}) {
  if (!bootstrap || typeof bootstrap !== "object") {
    throw archiveError("Legacy bootstrap data is required", "legacy_bootstrap_required");
  }
  const configuration = legacyConfiguration({
    bootstrap,
    suppliers,
    business,
    materialCosts,
    productPrices
  });
  const sheet = stripSensitive(bootstrap.sheet || null);
  const sourceUrl = cleanSourceUrl(source.url);
  const archive = {
    format: ARCHIVE_FORMAT,
    version: ARCHIVE_VERSION,
    exportedAt: new Date().toISOString(),
    source: {
      system: cleanText(source.system, 100) || "legacy-hosted-app",
      url: sourceUrl,
      schemaVersion: finiteNumber(sheet?.schemaVersion, null)
    },
    business: {
      configuration,
      salesOrders: cleanArray(bootstrap.salesOrders, 5000),
      supplyOrders: cleanArray(supplyOrders, 5000),
      suppliers: cleanArray(suppliers, 1000),
      storefrontBuyOrders: cleanArray(bootstrap.storefrontBuyOrders, 5000),
      productionBatches: cleanArray(bootstrap.productionBatches, 5000),
      dailyCloses: cleanArray(bootstrap.dailyCloses, 5000)
    },
    accounts: {
      users: cleanArray(users, 5000).map(sanitizePublicUser),
      audit: cleanArray(audit, 5000).map(sanitizeAuditEvent)
    },
    operations: {
      snapshot: sheet,
      finance: finance && typeof finance === "object" ? stripSensitive(finance) : null
    },
    coverage: buildCoverage({ bootstrap, suppliers, supplyOrders, users, audit, finance, warnings })
  };
  archive.fingerprint = archiveFingerprint(archive);
  return validateBusinessArchive(archive);
}

function createBusinessArchive({
  configuration,
  business = {},
  snapshot,
  finance = null,
  users = [],
  audit = [],
  source = {}
}) {
  if (!configuration || typeof configuration !== "object") {
    throw archiveError("Business configuration is required", "archive_configuration_missing");
  }
  if (!snapshot?.ok || !snapshot.inventory) {
    throw archiveError("A current inventory snapshot is required", "archive_snapshot_missing");
  }
  const normalizedConfiguration = normalizeSetupPayload(configuration);
  const archive = {
    format: ARCHIVE_FORMAT,
    version: ARCHIVE_VERSION,
    exportedAt: new Date().toISOString(),
    source: {
      system: cleanText(source.system, 100) || "business-operations-framework",
      url: cleanSourceUrl(source.url),
      schemaVersion: finiteNumber(snapshot.schemaVersion, null)
    },
    business: {
      configuration: normalizedConfiguration,
      salesOrders: cleanArray(business.salesOrders, 5000),
      supplyOrders: cleanArray(business.supplyOrders, 5000),
      suppliers: cleanArray(business.suppliers, 1000),
      storefrontBuyOrders: cleanArray(business.storefrontBuyOrders, 5000),
      productionBatches: cleanArray(business.productionBatches, 5000),
      dailyCloses: cleanArray(business.dailyCloses, 5000)
    },
    accounts: {
      users: cleanArray(users, 5000).map(sanitizePublicUser),
      audit: cleanArray(audit, 5000).map(sanitizeAuditEvent)
    },
    operations: {
      snapshot: stripSensitive(snapshot),
      finance: finance?.ok ? stripSensitive(finance) : null
    },
    coverage: {
      inventorySnapshot: true,
      financeSnapshot: Boolean(finance?.ok),
      rawTimeEntries: false,
      passwordCredentials: false,
      counts: {
        products: normalizedConfiguration.catalog.products.length,
        suppliers: Array.isArray(business.suppliers) ? business.suppliers.length : 0,
        supplyOrders: Array.isArray(business.supplyOrders) ? business.supplyOrders.length : 0,
        staffReferences: Array.isArray(users) ? users.length : 0,
        auditEvents: Array.isArray(audit) ? audit.length : 0,
        webhookExceptions: Array.isArray(snapshot.reviewExceptions) ? snapshot.reviewExceptions.length : 0
      },
      warnings: [
        "Account passwords and active sessions are intentionally excluded from portable archives.",
        "The hosted PostgreSQL database remains authoritative for complete beta history, including raw time entries."
      ]
    }
  };
  archive.fingerprint = archiveFingerprint(archive);
  return validateBusinessArchive(archive);
}

function validateBusinessArchive(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw archiveError("Business archive must be a JSON object", "invalid_archive");
  }
  if (input.format !== ARCHIVE_FORMAT) {
    throw archiveError("This is not a Business Operations archive", "invalid_archive_format");
  }
  if (Number(input.version) !== ARCHIVE_VERSION) {
    throw archiveError(`Archive version ${input.version} is not supported`, "unsupported_archive_version");
  }
  if (!input.business?.configuration) {
    throw archiveError("Archive does not contain business configuration", "archive_configuration_missing");
  }
  const configuration = normalizeSetupPayload(input.business.configuration);
  const snapshot = stripSensitive(input.operations?.snapshot || null);
  if (!snapshot?.ok || !snapshot.inventory || typeof snapshot.inventory !== "object") {
    throw archiveError("Archive does not contain a valid inventory snapshot", "archive_snapshot_missing");
  }
  const normalized = {
    format: ARCHIVE_FORMAT,
    version: ARCHIVE_VERSION,
    exportedAt: cleanDateTime(input.exportedAt) || new Date().toISOString(),
    source: {
      system: cleanText(input.source?.system, 100) || "unknown",
      url: cleanSourceUrl(input.source?.url),
      schemaVersion: finiteNumber(input.source?.schemaVersion, null)
    },
    business: {
      configuration,
      salesOrders: cleanArray(input.business.salesOrders, 5000),
      supplyOrders: cleanArray(input.business.supplyOrders, 5000),
      suppliers: cleanArray(input.business.suppliers, 1000),
      storefrontBuyOrders: cleanArray(input.business.storefrontBuyOrders, 5000),
      productionBatches: cleanArray(input.business.productionBatches, 5000),
      dailyCloses: cleanArray(input.business.dailyCloses, 5000)
    },
    accounts: {
      users: cleanArray(input.accounts?.users, 5000).map(sanitizePublicUser),
      audit: cleanArray(input.accounts?.audit, 5000).map(sanitizeAuditEvent)
    },
    operations: {
      snapshot,
      finance: input.operations?.finance && typeof input.operations.finance === "object"
        ? stripSensitive(input.operations.finance)
        : null
    },
    coverage: normalizeCoverage(input.coverage)
  };
  normalized.fingerprint = archiveFingerprint(normalized);
  if (input.fingerprint && !safeEqual(input.fingerprint, normalized.fingerprint)) {
    throw archiveError("Archive fingerprint does not match its contents", "archive_fingerprint_mismatch");
  }
  return normalized;
}

function archiveSummary(input) {
  const archive = validateBusinessArchive(input);
  const inventory = archive.operations.snapshot.inventory || {};
  return {
    fingerprint: archive.fingerprint,
    businessName: archive.business.configuration.business.name,
    products: archive.business.configuration.catalog.products.length,
    materials: archive.business.configuration.catalog.materials.length,
    recipes: archive.business.configuration.catalog.recipes.length,
    storefrontCounts: Array.isArray(inventory.products) ? inventory.products.length : 0,
    storageCounts: Array.isArray(inventory.storage) ? inventory.storage.length : 0,
    ledgerAvailable: Number.isFinite(Number(inventory.ledger?.balance)),
    salesOrders: archive.business.salesOrders.length,
    supplyOrders: archive.business.supplyOrders.length,
    suppliers: archive.business.suppliers.length,
    storefrontBuyOrders: archive.business.storefrontBuyOrders.length,
    productionBatches: archive.business.productionBatches.length,
    dailyCloses: archive.business.dailyCloses.length,
    legacyStaffReferences: archive.accounts.users.length,
    auditEvents: archive.accounts.audit.length,
    webhookExceptions: Array.isArray(archive.operations.snapshot.reviewExceptions)
      ? archive.operations.snapshot.reviewExceptions.length
      : 0,
    financeRows: Array.isArray(archive.operations.finance?.breakdown)
      ? archive.operations.finance.breakdown.length
      : 0,
    warnings: [...archive.coverage.warnings]
  };
}

function archiveFingerprint(input) {
  const payload = stripVolatileFields(stripSensitive(input));
  return crypto.createHash("sha256").update(stableStringify(payload)).digest("hex");
}

function legacyConfiguration({ bootstrap, suppliers, business, materialCosts, productPrices }) {
  const configuration = defaultSetupConfiguration();
  const sheetProducts = new Map((bootstrap.sheet?.inventory?.products || []).map(row => [
    inventoryKey(row.itemName || row.itemLabel),
    row
  ]));
  const sourceItems = Array.isArray(bootstrap.items) ? bootstrap.items : [];
  const products = sourceItems.map(item => {
    const name = cleanText(item.name || item.label, 100);
    const sheetProduct = sheetProducts.get(inventoryKey(name)) || {};
    return {
      name,
      label: cleanText(item.label || sheetProduct.itemLabel || name, 100),
      tag: cleanText(item.tag || sheetProduct.itemTag, 150),
      category: cleanText(item.category || sheetProduct.category, 60) || "Products",
      salePrice: firstFinite(
        productPrices[name]?.midpoint,
        productPrices[name],
        item.price?.midpoint,
        item.price,
        item.salePrice,
        sheetProduct.salePrice,
        0
      ),
      target: firstFinite(sheetProduct.target, item.target, 0),
      active: item.active !== false && sheetProduct.active !== false,
      aliases: Array.isArray(item.aliases) ? item.aliases : []
    };
  }).filter(product => product.name);
  const productNames = new Set(products.map(product => inventoryKey(product.name)));
  const supplierCosts = inferSupplierCosts(suppliers);
  const materialNames = new Map();
  const addMaterial = value => {
    const name = canonicalMaterialName(value);
    const key = inventoryKey(name);
    if (name && !productNames.has(key) && !materialNames.has(key)) materialNames.set(key, name);
  };
  Object.values(bootstrap.recipes || {}).forEach(recipe => {
    if (!Array.isArray(recipe)) return;
    recipe.forEach(ingredient => addMaterial(Array.isArray(ingredient) ? ingredient[0] : ingredient?.name));
  });
  (bootstrap.sheet?.inventory?.materials || []).forEach(row => addMaterial(row.ingredient || row.itemName || row.name));
  (bootstrap.sheet?.inventory?.storage || []).forEach(row => addMaterial(row.ingredient || row.itemName || row.itemLabel || row.name));
  const materials = [...materialNames.values()].map(name => ({
    name,
    category: "Materials",
    unit: "unit",
    unitCost: firstFinite(
      materialCosts[name]?.midpoint,
      materialCosts[name],
      supplierCosts.get(inventoryKey(name)),
      0
    )
  }));
  const canonicalProducts = new Map(products.map(product => [inventoryKey(product.name), product.name]));
  const canonicalIngredients = new Map([
    ...materials.map(material => [inventoryKey(material.name), material.name]),
    ...products.map(product => [inventoryKey(product.name), product.name])
  ]);
  if (canonicalIngredients.has("softwood")) canonicalIngredients.set("wood", canonicalIngredients.get("softwood"));
  const recipes = Object.entries(bootstrap.recipes || {}).map(([rawProductName, recipe]) => {
    const productName = canonicalProducts.get(inventoryKey(rawProductName));
    if (!productName || !Array.isArray(recipe) || !recipe.length) return null;
    const ingredients = recipe.map(ingredient => {
      const rawName = Array.isArray(ingredient) ? ingredient[0] : ingredient?.name;
      const quantity = Array.isArray(ingredient) ? ingredient[1] : ingredient?.quantity;
      const name = canonicalIngredients.get(inventoryKey(rawName));
      return name && Number(quantity) > 0 ? { name, quantity: Number(quantity) } : null;
    }).filter(Boolean);
    return ingredients.length ? {
      productName,
      yield: Math.max(1, firstFinite(bootstrap.recipeYields?.[rawProductName], 1)),
      ingredients
    } : null;
  }).filter(Boolean);

  configuration.business = {
    ...configuration.business,
    name: cleanText(business.name || bootstrap.business?.name, 100) || "Frontier Firearms",
    ledgerName: cleanText(business.ledgerName, 100) || "Store Ledger",
    location: cleanText(business.location, 100),
    referenceId: cleanText(business.referenceId, 100),
    description: cleanText(business.description, 1000),
    logoUrl: cleanText(business.logoUrl, 500),
    currency: cleanText(business.currency, 3).toUpperCase() || "USD",
    locale: cleanText(business.locale, 30) || "en-GB",
    timezone: cleanText(business.timezone, 80) || "Europe/Oslo"
  };
  configuration.catalog = {
    categories: [...new Set(products.map(product => product.category))],
    materials,
    products,
    recipes
  };
  return normalizeSetupPayload(configuration);
}

function inferSupplierCosts(suppliers) {
  const costs = new Map();
  (Array.isArray(suppliers) ? suppliers : []).forEach(supplier => {
    (Array.isArray(supplier?.products) ? supplier.products : []).forEach(product => {
      const key = inventoryKey(product.name || product.label);
      const price = Number(product.unitPrice);
      if (!key || !Number.isFinite(price) || price <= 0) return;
      if (!costs.has(key) || price < costs.get(key)) costs.set(key, price);
    });
  });
  return costs;
}

function buildCoverage({ bootstrap, suppliers, supplyOrders, users, audit, finance, warnings }) {
  const snapshot = bootstrap.sheet || {};
  const coverageWarnings = cleanArray(warnings, 100).map(value => cleanText(value, 300)).filter(Boolean);
  if (!finance?.ok) coverageWarnings.push("Detailed finance data was unavailable during export.");
  coverageWarnings.push("Raw historic timesheet rows are not exposed by the legacy app; finance payroll totals are preserved when available.");
  coverageWarnings.push("Legacy password hashes are intentionally excluded. Staff must reconnect with fresh credentials or Discord profiles.");
  return {
    inventorySnapshot: Boolean(snapshot.ok && snapshot.inventory),
    financeSnapshot: Boolean(finance?.ok),
    rawTimeEntries: false,
    passwordCredentials: false,
    counts: {
      products: Array.isArray(bootstrap.items) ? bootstrap.items.length : 0,
      suppliers: Array.isArray(suppliers) ? suppliers.length : 0,
      supplyOrders: Array.isArray(supplyOrders) ? supplyOrders.length : 0,
      staffReferences: Array.isArray(users) ? users.length : 0,
      auditEvents: Array.isArray(audit) ? audit.length : 0,
      webhookExceptions: Array.isArray(snapshot.reviewExceptions) ? snapshot.reviewExceptions.length : 0
    },
    warnings: [...new Set(coverageWarnings)]
  };
}

function normalizeCoverage(input) {
  const source = input && typeof input === "object" ? input : {};
  return {
    inventorySnapshot: Boolean(source.inventorySnapshot),
    financeSnapshot: Boolean(source.financeSnapshot),
    rawTimeEntries: Boolean(source.rawTimeEntries),
    passwordCredentials: false,
    counts: stripSensitive(source.counts && typeof source.counts === "object" ? source.counts : {}),
    warnings: cleanArray(source.warnings, 100).map(value => cleanText(value, 300)).filter(Boolean)
  };
}

function sanitizePublicUser(user) {
  return {
    id: cleanText(user?.id, 100),
    fullName: cleanText(user?.fullName, 100),
    role: cleanText(user?.role, 30),
    status: cleanText(user?.status, 30),
    createdAt: cleanDateTime(user?.createdAt),
    approvedAt: cleanDateTime(user?.approvedAt),
    approvedBy: cleanText(user?.approvedBy, 100),
    lastLoginAt: cleanDateTime(user?.lastLoginAt)
  };
}

function sanitizeAuditEvent(event) {
  return {
    id: cleanText(event?.id, 100),
    createdAt: cleanDateTime(event?.createdAt),
    category: cleanText(event?.category, 40),
    action: cleanText(event?.action, 80),
    actorId: cleanText(event?.actorId, 100),
    actorName: cleanText(event?.actorName, 100),
    subjectId: cleanText(event?.subjectId, 100),
    subjectName: cleanText(event?.subjectName, 100),
    details: stripSensitive(event?.details && typeof event.details === "object" ? event.details : {})
  };
}

function cleanArray(value, limit) {
  return (Array.isArray(value) ? value : []).slice(0, limit).map(stripSensitive);
}

function stripSensitive(value, depth = 0) {
  if (depth > 12 || value === null || value === undefined) return value ?? null;
  if (Array.isArray(value)) return value.map(entry => stripSensitive(entry, depth + 1));
  if (typeof value !== "object") return value;
  const output = {};
  Object.entries(value).forEach(([key, entry]) => {
    if (!SENSITIVE_KEY.test(key)) output[key] = stripSensitive(entry, depth + 1);
  });
  return output;
}

function stripVolatileFields(value) {
  const clone = stripSensitive(value);
  delete clone.fingerprint;
  delete clone.exportedAt;
  if (clone.operations?.snapshot) delete clone.operations.snapshot.generatedAt;
  if (clone.operations?.finance) delete clone.operations.finance.generatedAt;
  return clone;
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function cleanSourceUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return `${url.origin}${url.pathname === "/" ? "" : url.pathname.replace(/\/$/, "")}`.slice(0, 500);
  } catch {
    return "";
  }
}

function canonicalMaterialName(value) {
  const name = cleanText(value, 100);
  return inventoryKey(name) === "wood" ? "Softwood" : name;
}

function inventoryKey(value) {
  return cleanText(value, 200).toLocaleLowerCase("en-US").replace(/[^a-z0-9]+/g, "");
}

function firstFinite(...values) {
  for (const value of values) {
    if (value === null || value === undefined || value === "") continue;
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return 0;
}

function finiteNumber(value, fallback) {
  if (value === null || value === undefined || value === "") return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function cleanText(value, maxLength) {
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, maxLength);
}

function cleanDateTime(value) {
  const timestamp = new Date(value || "").getTime();
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : "";
}

function safeEqual(actual, expected) {
  const actualBuffer = Buffer.from(String(actual || ""));
  const expectedBuffer = Buffer.from(String(expected || ""));
  return actualBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

function archiveError(message, code) {
  const error = new Error(message);
  error.status = 400;
  error.code = code;
  return error;
}

module.exports = {
  ARCHIVE_FORMAT,
  ARCHIVE_VERSION,
  archiveFingerprint,
  archiveSummary,
  createBusinessArchive,
  createLegacyBusinessArchive,
  validateBusinessArchive
};
