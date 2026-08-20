const assert = require("node:assert/strict");
const {
  configurationToCatalogData,
  defaultSetupConfiguration,
  normalizeSetupPayload
} = require("./setup-config");

const defaults = defaultSetupConfiguration();
assert.equal(defaults.locations.length, 2);
assert.equal(defaults.modules.production, true);
assert.equal(defaults.navigation.sections.workbench, true);
assert.equal(defaults.navigation.sections.finance, true);

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
  navigation: { sections: { review: false } },
  catalog: {
    materials: [
      { name: "Copper", category: "Metals", unit: "bar", unitCost: 2.5, storageTarget: 30 },
      { name: "Copper Sheet", category: "Metals", unit: "sheet", unitCost: 5 }
    ],
    products: [{ name: "Copper Pan", category: "Cookware", salePrice: 15, resellerPrice: 12, target: 4, storageTarget: 2 }],
    recipes: [
      { productName: "Copper Pan", yield: 1, ingredients: [{ name: "Copper", quantity: 3 }] },
      { productName: "Copper Sheet", yield: 1, ingredients: [{ name: "Copper", quantity: 2 }] }
    ]
  }
});

assert.equal(configuration.business.name, "Copper & Pine");
assert.equal(configuration.modules.discord, true);
assert.equal(configuration.modules.finance, true);
assert.equal(configuration.navigation.sections.review, false);
assert.equal(configuration.navigation.sections.store, true);
assert.equal(configuration.catalog.categories[0], "Cookware");

const legacyModuleNavigation = normalizeSetupPayload({
  business: { name: "Legacy Ledger", currency: "USD", locale: "en-US", timezone: "UTC" },
  modules: { production: false, finance: false }
});
assert.equal(legacyModuleNavigation.navigation.sections.production, false);
assert.equal(legacyModuleNavigation.navigation.sections.finance, false);
assert.equal(legacyModuleNavigation.navigation.sections.store, true);

const explicitNavigationOverride = normalizeSetupPayload({
  business: { name: "Modern Ledger", currency: "USD", locale: "en-US", timezone: "UTC" },
  modules: { finance: false },
  navigation: { sections: { finance: true } }
});
assert.equal(explicitNavigationOverride.navigation.sections.finance, true);

const catalog = configurationToCatalogData(configuration);
assert.equal(catalog.items[0].price, 15);
assert.equal(catalog.items[0].resellerPrice, 12);
assert.equal(configuration.catalog.products[0].resellerPrice, 12);
assert.equal(catalog.items[0].storageTarget, 2);
assert.equal(catalog.materials.find(material => material.name === "Copper").storageTarget, 30);
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
