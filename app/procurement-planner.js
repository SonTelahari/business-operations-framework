(function exposeProcurementPlanner(root, factory) {
  const productionPlanner = typeof module === "object" && module.exports
    ? require("./production-planner")
    : root?.BUSINESS_PRODUCTION_PLANNER;
  const planner = factory(productionPlanner);
  if (typeof module === "object" && module.exports) module.exports = planner;
  if (root) root.BUSINESS_PROCUREMENT_PLANNER = planner;
})(typeof window !== "undefined" ? window : globalThis, function createProcurementPlanner(productionPlanner) {
  "use strict";

  const SOURCE_NAMES = ["restock", "storage", "sales"];
  const LOCATIONS = ["Storage", "Storefront"];

  function planProcurement({
    demandBySource = {},
    recipes = {},
    recipeYields = {},
    counts = {},
    targetFloors = {},
    materialKeys = [],
    committed = new Map()
  } = {}) {
    if (!productionPlanner?.planProduction) throw new Error("Production planner is unavailable");

    const recipeNames = new Set(Object.keys(recipes).map(itemKey));
    const materials = new Set([...materialKeys].map(itemKey));
    const normalizedDemand = Object.fromEntries(SOURCE_NAMES.map(source => [
      source,
      normalizeLines(demandBySource[source])
    ]));
    const protectedCounts = protectTargetStock(counts, targetFloors);
    const combined = aggregateDemand(Object.values(normalizedDemand).flat(), {
      recipes,
      recipeYields,
      counts: protectedCounts,
      recipeNames,
      materials
    });
    const sourceDemand = Object.fromEntries(SOURCE_NAMES.map(source => [
      source,
      aggregateDemand(normalizedDemand[source], {
        recipes,
        recipeYields,
        counts: emptyCounts(),
        recipeNames,
        materials
      })
    ]));
    const committedCounts = countMap(committed);
    const keys = new Set([
      ...combined.materials.keys(),
      ...SOURCE_NAMES.flatMap(source => [...sourceDemand[source].materials.keys()])
    ]);

    return [...keys].map(key => {
      const line = combined.materials.get(key) || emptyMaterial(key);
      const gross = Object.fromEntries(SOURCE_NAMES.map(source => [
        source,
        Number(sourceDemand[source].materials.get(key)?.demand || 0)
      ]));
      const ordered = Number(committedCounts.get(key) || 0);
      return {
        ingredient: line.ingredient,
        demand: line.demand,
        available: line.available,
        shortage: line.shortage,
        ordered,
        missing: Math.max(0, line.shortage - ordered),
        restockDemand: gross.restock,
        storageDemand: gross.storage,
        salesDemand: gross.sales,
        intermediateCoverage: Math.max(0, gross.restock + gross.storage + gross.sales - line.demand)
      };
    }).sort((left, right) =>
      right.missing - left.missing
      || right.shortage - left.shortage
      || left.ingredient.localeCompare(right.ingredient)
    );
  }

  function aggregateDemand(lines, { recipes, recipeYields, counts, recipeNames, materials }) {
    const craftable = [];
    const direct = [];
    const issues = [];
    lines.forEach(line => {
      const key = itemKey(line.itemName);
      if (line.directMaterial) direct.push(line);
      else if (recipeNames.has(key)) craftable.push(line);
      else if (materials.has(key)) direct.push(line);
      else issues.push({ type: "missing_recipe", itemName: line.itemName });
    });

    const production = productionPlanner.planProduction({
      lines: craftable.map(line => ({ itemName: line.itemName, requestedQuantity: line.quantity })),
      recipes,
      recipeYields,
      counts,
      rootOutputLocation: "Storage"
    });
    const result = new Map();
    production.materials.forEach(line => addMaterial(result, {
      ingredient: line.ingredient,
      demand: Number(line.needed || 0),
      available: Math.max(0, Number(line.needed || 0) - Number(line.shortage || 0)),
      shortage: Number(line.shortage || 0)
    }));
    direct.forEach(line => addMaterial(result, {
      ingredient: line.itemName,
      demand: line.quantity,
      available: 0,
      shortage: line.quantity
    }));
    return { materials: result, issues: [...issues, ...production.issues] };
  }

  function addMaterial(target, line) {
    const key = itemKey(line.ingredient);
    if (!key) return;
    const current = target.get(key) || emptyMaterial(line.ingredient);
    current.demand += Number(line.demand || 0);
    current.available += Number(line.available || 0);
    current.shortage += Number(line.shortage || 0);
    target.set(key, current);
  }

  function protectTargetStock(counts, targetFloors) {
    return Object.fromEntries(LOCATIONS.map(location => {
      const available = countMap(counts[location]);
      const floors = countMap(targetFloors[location]);
      available.forEach((quantity, key) => {
        available.set(key, Math.max(0, quantity - Number(floors.get(key) || 0)));
      });
      return [location, available];
    }));
  }

  function normalizeLines(lines) {
    const combined = new Map();
    (Array.isArray(lines) ? lines : []).forEach(line => {
      const itemName = String(line?.itemName || line?.name || line?.itemLabel || "").trim();
      const quantity = Math.max(0, Number(line?.quantity ?? line?.requestedQuantity ?? line?.missing ?? 0));
      const directMaterial = Boolean(line?.directMaterial);
      const normalizedItemName = itemKey(itemName);
      if (!normalizedItemName || !quantity) return;
      const key = `${directMaterial ? "material" : "root"}:${normalizedItemName}`;
      const current = combined.get(key) || { itemName, quantity: 0, directMaterial };
      current.quantity += quantity;
      combined.set(key, current);
    });
    return [...combined.values()];
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

  function emptyCounts() {
    return { Storage: new Map(), Storefront: new Map() };
  }

  function emptyMaterial(ingredient) {
    return { ingredient: String(ingredient || ""), demand: 0, available: 0, shortage: 0 };
  }

  function itemKey(value) {
    return productionPlanner.itemKey(value);
  }

  return { planProcurement, protectTargetStock };
});
