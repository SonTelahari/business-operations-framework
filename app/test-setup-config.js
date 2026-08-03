const assert = require("node:assert/strict");
const {
  configurationToCatalogData,
  defaultSetupConfiguration,
  normalizeSetupPayload
} = require("./setup-config");

const defaults = defaultSetupConfiguration();
assert.equal(defaults.locations.length, 2);
assert.equal(defaults.modules.production, true);

const configuration = normalizeSetupPayload({
  business: {
    name: "Copper & Pine",
    ledgerName: "Copper & Pine Works",
    location: "Blackwater",
    currency: "USD",
    locale: "en-US",
    timezone: "America/New_York"
  },
  terminology: { salesLocation: "Showroom", storageLocation: "Warehouse" },
  locations: [
    { name: "Showroom", type: "sales" },
    { name: "Warehouse", type: "storage" }
  ],
  modules: { discord: true },
  catalog: {
    materials: [
      { name: "Copper", category: "Metals", unit: "bar", unitCost: 2.5 },
      { name: "Copper Sheet", category: "Metals", unit: "sheet", unitCost: 5 }
    ],
    products: [{ name: "Copper Pan", category: "Cookware", salePrice: 15, target: 4 }],
    recipes: [
      { productName: "Copper Pan", yield: 1, ingredients: [{ name: "Copper", quantity: 3 }] },
      { productName: "Copper Sheet", yield: 1, ingredients: [{ name: "Copper", quantity: 2 }] }
    ]
  }
});

assert.equal(configuration.business.name, "Copper & Pine");
assert.equal(configuration.modules.discord, true);
assert.equal(configuration.modules.finance, true);
assert.equal(configuration.catalog.categories[0], "Cookware");

const catalog = configurationToCatalogData(configuration);
assert.equal(catalog.items[0].price, 15);
assert.deepEqual(catalog.recipes["Copper Pan"], [["Copper", 3]]);
assert.equal(catalog.recipeYields["Copper Pan"], 1);
assert.deepEqual(catalog.recipes["Copper Sheet"], [["Copper", 2]]);
assert.equal(catalog.pricing.materials.Copper.midpoint, 2.5);

assert.throws(
  () => normalizeSetupPayload({
    business: { name: "Test", currency: "USD", locale: "en-US", timezone: "UTC" },
    catalog: {
      products: [{ name: "Widget" }],
      recipes: [{ productName: "Widget", ingredients: [{ name: "Missing", quantity: 1 }] }]
    }
  }),
  error => error.code === "unknown_recipe_ingredient"
);

assert.throws(
  () => normalizeSetupPayload({
    business: { name: "Test", currency: "USD", locale: "en-US", timezone: "UTC" },
    locations: [{ name: "Warehouse", type: "storage" }]
  }),
  error => error.code === "sales_location_required"
);

assert.throws(
  () => normalizeSetupPayload({
    business: { name: "Test", currency: "USD", locale: "en-US", timezone: "UTC" },
    catalog: {
      products: [
        { name: "First Widget", label: "Widget" },
        { name: "Second Widget", label: "Widget" }
      ]
    }
  }),
  error => error.code === "duplicate_product_label"
);

assert.throws(
  () => normalizeSetupPayload({
    business: { name: "Test", currency: "USD", locale: "en-US", timezone: "UTC" },
    catalog: {
      materials: [{ name: "Widget" }],
      products: [{ name: "Widget" }]
    }
  }),
  error => error.code === "catalog_name_conflict"
);

console.log("First-launch business configuration checks passed.");
