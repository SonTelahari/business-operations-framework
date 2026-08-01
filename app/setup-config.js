const crypto = require("node:crypto");

const MODULE_DEFAULTS = Object.freeze({
  production: true,
  suppliers: true,
  storefrontBuyOrders: true,
  payroll: true,
  finance: true,
  discord: false
});

const DEFAULT_LOCATIONS = Object.freeze([
  Object.freeze({ id: "storefront", name: "Storefront", type: "sales" }),
  Object.freeze({ id: "storage", name: "Storage", type: "storage" })
]);

function defaultSetupConfiguration() {
  return {
    version: 1,
    completedAt: "",
    business: {
      name: "",
      ledgerName: "Business Ledger",
      location: "",
      description: "",
      logoUrl: "",
      currency: "USD",
      locale: "en-US",
      timezone: "UTC"
    },
    terminology: {
      salesLocation: "Storefront",
      storageLocation: "Storage",
      salesOrder: "Sales Order"
    },
    locations: DEFAULT_LOCATIONS.map(location => ({ ...location })),
    modules: { ...MODULE_DEFAULTS },
    catalog: {
      categories: [],
      materials: [],
      products: [],
      recipes: []
    }
  };
}

function normalizeSetupPayload(input) {
  const source = input && typeof input === "object" ? input : {};
  const businessInput = source.business && typeof source.business === "object" ? source.business : {};
  const name = cleanText(businessInput.name, 100);
  if (name.length < 2) throw setupError("Enter a business name", "business_name_required");

  const currency = cleanText(businessInput.currency, 3).toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw setupError("Currency must be a three-letter code", "invalid_currency");
  const locale = cleanText(businessInput.locale, 30) || "en-US";
  const timezone = cleanText(businessInput.timezone, 80) || "UTC";
  try {
    new Intl.DateTimeFormat(locale, { timeZone: timezone }).format(new Date());
  } catch {
    throw setupError("Enter a valid locale and timezone", "invalid_locale_or_timezone");
  }

  const logoUrl = cleanText(businessInput.logoUrl, 500);
  if (logoUrl && !/^https:\/\//i.test(logoUrl)) {
    throw setupError("Logo URL must use HTTPS", "invalid_logo_url");
  }

  const locations = normalizeLocations(source.locations);
  const terminologyInput = source.terminology && typeof source.terminology === "object" ? source.terminology : {};
  const salesLocation = cleanText(terminologyInput.salesLocation, 50)
    || locations.find(location => location.type === "sales")?.name
    || "Storefront";
  const storageLocation = cleanText(terminologyInput.storageLocation, 50)
    || locations.find(location => location.type === "storage")?.name
    || "Storage";

  const catalogInput = source.catalog && typeof source.catalog === "object" ? source.catalog : {};
  const materials = normalizeMaterials(catalogInput.materials);
  const products = normalizeProducts(catalogInput.products);
  assertCatalogNamesDoNotOverlap(materials, products);
  const categories = uniqueTexts([
    ...(Array.isArray(catalogInput.categories) ? catalogInput.categories : []),
    ...products.map(product => product.category)
  ], 60);
  const recipes = normalizeRecipes(catalogInput.recipes, products, materials);

  return {
    version: 1,
    completedAt: cleanDateTime(source.completedAt),
    business: {
      name,
      ledgerName: cleanText(businessInput.ledgerName, 100) || `${name} Ledger`,
      location: cleanText(businessInput.location, 100),
      description: cleanMultilineText(businessInput.description, 1000),
      logoUrl,
      currency,
      locale,
      timezone
    },
    terminology: {
      salesLocation,
      storageLocation,
      salesOrder: cleanText(terminologyInput.salesOrder, 50) || "Sales Order"
    },
    locations,
    modules: normalizeModules(source.modules),
    catalog: { categories, materials, products, recipes }
  };
}

function configurationToCatalogData(configuration) {
  const config = normalizeSetupPayload(configuration);
  const recipes = {};
  const recipeYields = {};
  config.catalog.recipes.forEach(recipe => {
    recipes[recipe.productName] = recipe.ingredients.map(ingredient => [ingredient.name, ingredient.quantity]);
    recipeYields[recipe.productName] = recipe.yield;
  });
  const pricing = {
    source: { title: `${config.business.name} configured costs`, policy: "configured" },
    products: {},
    materials: {}
  };
  config.catalog.products.forEach(product => {
    pricing.products[product.name] = fixedPrice(product.salePrice);
  });
  config.catalog.materials.forEach(material => {
    pricing.materials[material.name] = fixedPrice(material.unitCost);
  });
  return {
    categories: [...config.catalog.categories],
    items: config.catalog.products.map(product => ({
      name: product.name,
      label: product.label,
      tag: product.tag,
      category: product.category,
      price: product.salePrice,
      target: product.target,
      active: product.active,
      aliases: [...product.aliases]
    })),
    materials: config.catalog.materials.map(material => ({
      name: material.name,
      label: material.name,
      category: material.category,
      unit: material.unit,
      price: material.unitCost
    })),
    recipes,
    recipeYields,
    pricing
  };
}

function normalizeLocations(input) {
  const source = Array.isArray(input) && input.length ? input : DEFAULT_LOCATIONS;
  const seen = new Set();
  const seenIds = new Set();
  const locations = source.slice(0, 20).map((location, index) => {
    const name = cleanText(location?.name, 60);
    if (!name) throw setupError(`Location ${index + 1} needs a name`, "invalid_location");
    const key = normalizeKey(name);
    if (seen.has(key)) throw setupError(`Location names must be unique: ${name}`, "duplicate_location");
    seen.add(key);
    const type = new Set(["sales", "storage", "production", "other"]).has(location?.type)
      ? location.type
      : "other";
    const id = cleanId(location?.id) || `${slug(name) || "location"}-${index + 1}`;
    if (seenIds.has(id)) throw setupError(`Location identifiers must be unique: ${id}`, "duplicate_location_id");
    seenIds.add(id);
    return {
      id,
      name,
      type
    };
  });
  if (!locations.some(location => location.type === "sales")) {
    throw setupError("Add at least one sales location", "sales_location_required");
  }
  if (!locations.some(location => location.type === "storage")) {
    throw setupError("Add at least one storage location", "storage_location_required");
  }
  return locations;
}

function normalizeModules(input) {
  const source = input && typeof input === "object" ? input : {};
  return Object.fromEntries(Object.entries(MODULE_DEFAULTS).map(([key, defaultValue]) => [
    key,
    source[key] === undefined ? defaultValue : Boolean(source[key])
  ]));
}

function normalizeMaterials(input) {
  const seen = new Set();
  return (Array.isArray(input) ? input : []).slice(0, 1000).map((material, index) => {
    const name = cleanText(material?.name, 100);
    if (!name) throw setupError(`Material ${index + 1} needs a name`, "invalid_material");
    assertUnique(seen, name, "material");
    return {
      id: cleanId(material?.id) || crypto.randomUUID(),
      name,
      category: cleanText(material?.category, 60) || "Materials",
      unit: cleanText(material?.unit, 30) || "unit",
      unitCost: nonnegativeNumber(material?.unitCost, `Material cost for ${name}`)
    };
  });
}

function normalizeProducts(input) {
  const seen = new Set();
  const seenLabels = new Set();
  const seenTags = new Set();
  return (Array.isArray(input) ? input : []).slice(0, 1000).map((product, index) => {
    const name = cleanText(product?.name, 100);
    if (!name) throw setupError(`Product ${index + 1} needs a name`, "invalid_product");
    assertUnique(seen, name, "product");
    const label = cleanText(product?.label, 100) || name;
    const tag = cleanText(product?.tag, 150);
    assertUnique(seenLabels, label, "product label");
    if (tag) assertUnique(seenTags, tag, "item tag");
    return {
      id: cleanId(product?.id) || crypto.randomUUID(),
      name,
      label,
      tag,
      category: cleanText(product?.category, 60) || "Products",
      salePrice: nonnegativeNumber(product?.salePrice, `Sale price for ${name}`),
      target: nonnegativeNumber(product?.target, `Stock target for ${name}`),
      active: product?.active !== false,
      aliases: uniqueTexts(Array.isArray(product?.aliases) ? product.aliases : [], 100).slice(0, 20)
    };
  });
}

function assertCatalogNamesDoNotOverlap(materials, products) {
  const materialNames = new Set(materials.map(material => normalizeKey(material.name)));
  const overlap = products.find(product => materialNames.has(normalizeKey(product.name)));
  if (overlap) {
    throw setupError(`A product and material cannot share the same name: ${overlap.name}`, "catalog_name_conflict");
  }
}

function normalizeRecipes(input, products, materials) {
  const productNames = new Map(products.map(product => [normalizeKey(product.name), product.name]));
  const ingredientNames = new Map([
    ...materials.map(material => [normalizeKey(material.name), material.name]),
    ...products.map(product => [normalizeKey(product.name), product.name])
  ]);
  const seen = new Set();
  return (Array.isArray(input) ? input : []).slice(0, 1000).map((recipe, index) => {
    const productKey = normalizeKey(recipe?.productName);
    const productName = productNames.get(productKey);
    if (!productName) throw setupError(`Recipe ${index + 1} must use a catalog product`, "invalid_recipe_product");
    assertUnique(seen, productName, "recipe");
    const ingredients = (Array.isArray(recipe?.ingredients) ? recipe.ingredients : []).slice(0, 100).map((ingredient, ingredientIndex) => {
      const ingredientKey = normalizeKey(ingredient?.name);
      const name = ingredientNames.get(ingredientKey);
      if (!name) {
        throw setupError(
          `Ingredient ${ingredientIndex + 1} for ${productName} is not in the material or product catalog`,
          "unknown_recipe_ingredient"
        );
      }
      const quantity = positiveNumber(ingredient?.quantity, `Ingredient quantity for ${name}`);
      return { name, quantity };
    });
    if (!ingredients.length) throw setupError(`${productName} needs at least one recipe ingredient`, "empty_recipe");
    return {
      id: cleanId(recipe?.id) || crypto.randomUUID(),
      productName,
      yield: positiveNumber(recipe?.yield, `Recipe yield for ${productName}`, 1),
      ingredients
    };
  });
}

function fixedPrice(value) {
  const amount = Number(value || 0);
  return { low: amount, high: amount, midpoint: amount, source: "Business setup" };
}

function nonnegativeNumber(value, label) {
  const number = value === "" || value === null || value === undefined ? 0 : Number(value);
  if (!Number.isFinite(number) || number < 0) throw setupError(`${label} must be zero or greater`, "invalid_number");
  return number;
}

function positiveNumber(value, label, fallback = null) {
  const number = value === "" || value === null || value === undefined ? fallback : Number(value);
  if (!Number.isFinite(number) || number <= 0) throw setupError(`${label} must be greater than zero`, "invalid_number");
  return number;
}

function assertUnique(seen, value, noun) {
  const key = normalizeKey(value);
  const codeNoun = noun.replace(/\s+/g, "_");
  if (seen.has(key)) throw setupError(`${noun[0].toUpperCase()}${noun.slice(1)} names must be unique: ${value}`, `duplicate_${codeNoun}`);
  seen.add(key);
}

function uniqueTexts(values, maxLength) {
  const seen = new Set();
  return values.map(value => cleanText(value, maxLength)).filter(value => {
    const key = normalizeKey(value);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function cleanText(value, maxLength) {
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, maxLength);
}

function cleanMultilineText(value, maxLength) {
  return String(value || "").replace(/\r/g, "").trim().slice(0, maxLength);
}

function cleanId(value) {
  return String(value || "").trim().replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 100);
}

function cleanDateTime(value) {
  const text = String(value || "").trim();
  return text && Number.isFinite(new Date(text).getTime()) ? new Date(text).toISOString() : "";
}

function normalizeKey(value) {
  return cleanText(value, 200).toLocaleLowerCase("en-US");
}

function slug(value) {
  return normalizeKey(value).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50);
}

function setupError(message, code) {
  const error = new Error(message);
  error.status = 400;
  error.code = code;
  return error;
}

module.exports = {
  DEFAULT_LOCATIONS,
  MODULE_DEFAULTS,
  configurationToCatalogData,
  defaultSetupConfiguration,
  normalizeSetupPayload,
  setupError
};
