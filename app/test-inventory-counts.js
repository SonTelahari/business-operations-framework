const assert = require("node:assert/strict");
const { normalizeKey, selectLatestCounts } = require("./inventory-counts");
const pricing = require("./pricing");

global.window = {};
require("./recipes");
const recipes = global.window.FRONTIER_RECIPES;
delete global.window;

assert.equal(normalizeKey("Wood"), "softwood");
assert.equal(normalizeKey("Soft Wood"), "softwood");
assert.equal(pricing.materials.Softwood.midpoint, 0.175);
assert(Object.values(recipes).flat().every(([ingredient]) => ingredient !== "Wood"));

const staleSheet = selectLatestCounts({
  location: "Storage",
  inventory: { materials: [{ ingredient: "Iron", storageCount: 0 }] },
  operations: [{
    kind: "Stock Count",
    location: "Storage",
    itemName: "Iron",
    quantity: 129,
    createdAt: "2026-07-13T10:35:00.000Z"
  }]
});
assert.equal(staleSheet.get("iron"), 129, "a local count must override a stale untimed Sheet value");

const softwoodAlias = selectLatestCounts({
  location: "Storage",
  inventory: { materials: [{ ingredient: "Wood", storageCount: 0 }] },
  operations: [{
    kind: "Stock Count",
    location: "Storage",
    itemName: "Soft Wood",
    quantity: 64,
    createdAt: "2026-07-13T10:35:00.000Z"
  }]
});
assert.equal(softwoodAlias.get("softwood"), 64, "wood spelling variants must share one stock count");

const latestManualCount = selectLatestCounts({
  location: "Storage",
  inventory: { materials: [{ ingredient: "Hard wood", storageCount: 0 }] },
  operations: [
    { kind: "Stock Count", location: "Storage", itemName: "Hard wood", quantity: 235, createdAt: "2026-07-13T10:39:00.000Z" },
    { kind: "Stock Count", location: "Storage", itemName: "Hard wood", quantity: 100, createdAt: "2026-07-13T10:35:00.000Z" }
  ]
});
assert.equal(latestManualCount.get("hard wood"), 235, "the newest manual count must win");

const newerSheetCount = selectLatestCounts({
  location: "Storage",
  inventory: {
    materials: [{ ingredient: "Nitrite", storageCount: 221, countedAt: "2026-07-13T10:40:00.000Z" }]
  },
  operations: [{
    kind: "Stock Count",
    location: "Storage",
    itemName: "Nitrite",
    quantity: 100,
    createdAt: "2026-07-13T10:30:00.000Z"
  }]
});
assert.equal(newerSheetCount.get("nitrite"), 221, "a newer shared Sheet count must beat an older browser count");

const crossDeviceCount = selectLatestCounts({
  location: "Storage",
  inventory: {
    materials: [{ ingredient: "Shell Casing", storageCount: 1000, countedAt: "2026-07-13T10:40:00.000Z" }]
  },
  operations: []
});
assert.equal(crossDeviceCount.get("shell casing"), 1000, "shared Sheet counts must work without browser history");

console.log("Inventory count precedence checks passed.");
