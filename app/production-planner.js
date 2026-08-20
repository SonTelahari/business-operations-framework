(function exposeProductionPlanner(root, factory) {
  const planner = factory();
  if (typeof module === "object" && module.exports) module.exports = planner;
  if (root) root.BUSINESS_PRODUCTION_PLANNER = planner;
})(typeof window !== "undefined" ? window : globalThis, function createProductionPlanner() {
  "use strict";

  function planProduction({
    lines = [],
    recipes = {},
    recipeYields = {},
    counts = {},
    ingredientSources = {},
    rootOutputLocation = "Storage",
    maxLines = 100
  } = {}) {
    const recipeNames = new Map(Object.keys(recipes).map(name => [itemKey(name), name]));
    const yieldNames = new Map(Object.keys(recipeYields).map(name => [itemKey(name), name]));
    const sources = new Map(Object.entries(ingredientSources || {}).map(([name, location]) => [
      itemKey(name),
      normalizeLocation(location)
    ]));
    const available = {
      Storage: countMap(counts.Storage),
      Storefront: countMap(counts.Storefront)
    };
    const initial = {
      Storage: new Map(available.Storage),
      Storefront: new Map(available.Storefront)
    };
    const generated = { Storage: new Map(), Storefront: new Map() };
    const buildLines = new Map();
    const materials = new Map();
    const components = new Map();
    const issues = [];

    const recipeFor = name => {
      const canonical = recipeNames.get(itemKey(name));
      const recipe = canonical ? recipes[canonical] : null;
      return Array.isArray(recipe) && recipe.length ? { canonical, recipe } : null;
    };
    const yieldFor = name => {
      const canonical = yieldNames.get(itemKey(name));
      return Math.max(1, Number(canonical ? recipeYields[canonical] : 1) || 1);
    };
    const sourceFor = (ingredient, fallback) => sources.get(itemKey(ingredient)) || normalizeLocation(fallback);

    function addIssue(type, itemName, path) {
      const key = `${type}:${itemKey(itemName)}:${path.map(itemKey).join(">")}`;
      if (issues.some(issue => issue.key === key)) return;
      issues.push({ key, type, itemName, path: [...path] });
    }

    function addComponent(ingredient, sourceLocation, quantity, fromStock, toProduce, craftable) {
      const key = `${sourceLocation}:${itemKey(ingredient)}`;
      const current = components.get(key) || {
        ingredient,
        sourceLocation,
        needed: 0,
        fromStock: 0,
        toProduce: 0,
        craftable
      };
      current.needed += quantity;
      current.fromStock += fromStock;
      current.toProduce += toProduce;
      current.craftable = current.craftable || craftable;
      components.set(key, current);
    }

    function addMaterial(ingredient, sourceLocation, quantity) {
      const key = `${sourceLocation}:${itemKey(ingredient)}`;
      const current = materials.get(key) || { ingredient, sourceLocation, needed: 0 };
      current.needed += quantity;
      materials.set(key, current);
    }

    function requireItem(ingredient, quantity, sourceLocation, path) {
      const needed = Math.max(0, Number(quantity || 0));
      if (!needed) return 0;
      const location = normalizeLocation(sourceLocation);
      const key = itemKey(ingredient);
      const stock = Number(available[location].get(key) || 0);
      const fromStock = Math.min(stock, needed);
      const generatedStock = Number(generated[location].get(key) || 0);
      const fromGenerated = Math.min(generatedStock, fromStock);
      const fromExisting = fromStock - fromGenerated;
      available[location].set(key, stock - fromStock);
      generated[location].set(key, generatedStock - fromGenerated);
      if (fromGenerated > 0) {
        const build = buildLines.get(`intermediate:${location}:${key}`);
        if (build) build.requestedQuantity += fromGenerated;
      }
      const shortage = needed - fromStock;
      const craftable = Boolean(recipeFor(ingredient));
      addComponent(ingredient, location, needed, fromExisting, fromGenerated + shortage, craftable);
      if (!craftable) {
        addMaterial(ingredient, location, needed);
        return 0;
      }
      if (!shortage) return 0;
      return produceItem(ingredient, shortage, location, true, path);
    }

    function produceItem(itemName, quantity, outputLocation, intermediate, path) {
      const requestedQuantity = Math.max(0, Number(quantity || 0));
      if (!requestedQuantity) return 0;
      const resolved = recipeFor(itemName);
      if (!resolved) {
        addIssue("missing_recipe", itemName, [...path, itemName]);
        return 0;
      }
      const itemNameKey = itemKey(resolved.canonical);
      if (path.map(itemKey).includes(itemNameKey)) {
        addIssue("recipe_cycle", resolved.canonical, [...path, resolved.canonical]);
        return 0;
      }
      if (buildLines.size >= maxLines) {
        addIssue("line_limit", resolved.canonical, [...path, resolved.canonical]);
        return 0;
      }

      const nextPath = [...path, resolved.canonical];
      const recipeYield = yieldFor(resolved.canonical);
      const plannedCrafts = Math.ceil(requestedQuantity / recipeYield);
      let stage = 1;
      resolved.recipe.forEach(component => {
        const ingredient = component?.ingredient ?? component?.[0];
        const componentQuantity = Number(component?.quantity ?? component?.[1] ?? 0);
        const defaultSource = component?.sourceLocation ?? component?.[2];
        if (!ingredient || componentQuantity <= 0) return;
        const childStage = requireItem(
          ingredient,
          componentQuantity * plannedCrafts,
          sourceFor(ingredient, defaultSource),
          nextPath
        );
        stage = Math.max(stage, childStage + 1);
      });

      const location = normalizeLocation(outputLocation);
      const buildKey = `${intermediate ? "intermediate" : "root"}:${location}:${itemNameKey}`;
      const current = buildLines.get(buildKey) || {
        name: resolved.canonical,
        requestedQuantity: 0,
        recipeYield,
        plannedCrafts: 0,
        producedQuantity: 0,
        outputLocation: location,
        isIntermediate: intermediate,
        stage
      };
      current.requestedQuantity += requestedQuantity;
      current.plannedCrafts += plannedCrafts;
      current.producedQuantity += plannedCrafts * recipeYield;
      current.stage = Math.max(current.stage, stage);
      buildLines.set(buildKey, current);

      const surplus = (plannedCrafts * recipeYield) - requestedQuantity;
      if (intermediate && surplus > 0) {
        const key = itemKey(resolved.canonical);
        available[location].set(key, Number(available[location].get(key) || 0) + surplus);
        generated[location].set(key, Number(generated[location].get(key) || 0) + surplus);
      }
      return stage;
    }

    const rootLines = new Map();
    (Array.isArray(lines) ? lines : []).forEach(line => {
      const itemName = String(line?.itemName || line?.name || line?.itemLabel || "").trim();
      const quantity = Math.max(0, Number(line?.requestedQuantity ?? line?.quantity ?? 0));
      if (!itemName || !quantity) return;
      const key = itemKey(itemName);
      const current = rootLines.get(key) || { itemName, quantity: 0 };
      current.quantity += quantity;
      rootLines.set(key, current);
    });
    rootLines.forEach(line => produceItem(
      line.itemName,
      line.quantity,
      normalizeLocation(rootOutputLocation),
      false,
      []
    ));

    const materialRows = [...materials.values()].map(material => {
      const key = itemKey(material.ingredient);
      const count = Number(initial[material.sourceLocation].get(key) || 0);
      return {
        ...material,
        available: count,
        shortage: Math.max(0, material.needed - count)
      };
    }).sort((left, right) =>
      right.shortage - left.shortage
      || left.sourceLocation.localeCompare(right.sourceLocation)
      || left.ingredient.localeCompare(right.ingredient)
    );

    return {
      buildLines: [...buildLines.values()].sort((left, right) =>
        left.stage - right.stage
        || Number(right.isIntermediate) - Number(left.isIntermediate)
        || left.name.localeCompare(right.name)
      ),
      materials: materialRows,
      components: [...components.values()].sort((left, right) =>
        Number(right.craftable) - Number(left.craftable)
        || left.ingredient.localeCompare(right.ingredient)
      ),
      issues: issues.map(({ key, ...issue }) => issue)
    };
  }

  function countMap(value) {
    const result = new Map();
    const entries = value instanceof Map ? [...value.entries()] : Object.entries(value || {});
    entries.forEach(([name, count]) => {
      const quantity = typeof count === "object" && count !== null ? count.quantity : count;
      result.set(itemKey(name), Math.max(0, Number(quantity || 0)));
    });
    return result;
  }

  function normalizeLocation(value) {
    const key = itemKey(value);
    return key === "sales" || key.includes("store") ? "Storefront" : "Storage";
  }

  function itemKey(value) {
    const key = String(value || "").trim().toLowerCase();
    return key === "wood" || key === "soft wood" || key === "softwood" ? "softwood" : key;
  }

  return { planProduction, itemKey, normalizeLocation };
});
