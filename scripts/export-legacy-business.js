const fs = require("node:fs");
const path = require("node:path");
const { archiveSummary } = require("../app/business-archive");
const { exportLegacyBusiness } = require("../app/legacy-export-client");

run().catch(error => {
  console.error(error.message || error);
  process.exitCode = 1;
});

async function run() {
  const pricing = loadPricing(process.env.LEGACY_PRICING_PATH);
  const archive = await exportLegacyBusiness({
    appUrl: process.env.LEGACY_APP_URL,
    fullName: process.env.LEGACY_ADMIN_NAME,
    password: process.env.LEGACY_ADMIN_PASSWORD,
    business: {
      name: process.env.LEGACY_BUSINESS_NAME || "Frontier Firearms",
      ledgerName: process.env.LEGACY_LEDGER_NAME || "Store Ledger",
      location: process.env.LEGACY_BUSINESS_LOCATION || "Van Horn",
      referenceId: process.env.LEGACY_BUSINESS_REFERENCE_ID || "23",
      description: process.env.LEGACY_BUSINESS_DESCRIPTION || "",
      logoUrl: process.env.LEGACY_LOGO_URL || "",
      currency: process.env.LEGACY_CURRENCY || "USD",
      locale: process.env.LEGACY_LOCALE || "en-GB",
      timezone: process.env.LEGACY_TIMEZONE || "Europe/Oslo"
    },
    materialCosts: pricing.materials,
    productPrices: pricing.products
  });
  const outputPath = resolveOutputPath(process.env.BUSINESS_ARCHIVE_PATH, archive);
  await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.promises.writeFile(outputPath, `${JSON.stringify(archive, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({
    ok: true,
    outputPath,
    summary: archiveSummary(archive)
  }, null, 2));
}

function loadPricing(filePath) {
  if (!String(filePath || "").trim()) return { products: {}, materials: {} };
  const absolutePath = path.resolve(filePath);
  const pricing = require(absolutePath);
  return {
    products: pricing?.products && typeof pricing.products === "object" ? pricing.products : {},
    materials: pricing?.materials && typeof pricing.materials === "object" ? pricing.materials : {}
  };
}

function resolveOutputPath(requestedPath, archive) {
  if (String(requestedPath || "").trim()) return path.resolve(requestedPath);
  const slug = archive.business.configuration.business.name
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "business";
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.resolve("exports", `${slug}-${timestamp}.business-archive.json`);
}
