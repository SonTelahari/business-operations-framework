const assert = require("node:assert/strict");

global.window = {};
const pricing = require("./pricing");
require("./recipes");
const items = require("./items");

const recipes = global.window.FRONTIER_RECIPES;
const yields = global.window.FRONTIER_RECIPE_YIELDS;

assertUnique(items.map(item => item.name), "item names");
assertUnique(items.map(item => item.label), "item labels");
assertUnique(items.map(item => item.tag).filter(Boolean), "item tags");
assert.deepEqual(
  Object.keys(recipes).filter(name => name !== "Fabric" && !items.some(item => item.name === name)),
  [],
  "Every sellable recipe should have one catalog item"
);
assert.deepEqual(
  items.filter(item => !recipes[item.name]).map(item => item.name),
  [],
  "Every catalog item should have one recipe"
);

assert.deepEqual(recipes["Gun Cleaning Kit"], [
  ["Refined Oil", 1],
  ["Glass Bottle", 5],
  ["Fabric", 2]
]);
assert.deepEqual(recipes["Weapon Repair Kit"], [
  ["Refined Oil", 1],
  ["Glass Bottle", 1],
  ["Hard wood", 5],
  ["Bolts", 5],
  ["Fabric", 1]
]);
assert.deepEqual(recipes.Fabric, [["Flax", 2]]);
assert.equal(yields["Gun Cleaning Kit"], 5);
assert.equal(items.find(item => item.name === "Gun Cleaning Kit").category, "Tools");
assert.equal(items.find(item => item.name === "Weapon Repair Kit").category, "Tools");
assert.equal(pricing.products["Gun Cleaning Kit"], undefined);
assert.equal(pricing.products["Weapon Repair Kit"], undefined);

assertCost("Fabric", 0.06, 0.1, 0.08);
assertCost("Gun Cleaning Kit", 0.8, 1, 0.9);
assertCost("Weapon Repair Kit", 2.17, 2.58, 2.375);
assertClose(recipeCost("Gun Cleaning Kit", "midpoint") / yields["Gun Cleaning Kit"], 0.18);

console.log("Still Water kit recipes, yields, and live-MSRP manufacturing costs passed.");

function assertCost(name, low, high, midpoint) {
  assertClose(recipeCost(name, "low"), low);
  assertClose(recipeCost(name, "high"), high);
  assertClose(recipeCost(name, "midpoint"), midpoint);
}

function recipeCost(name, priceField) {
  return recipes[name].reduce((total, [ingredient, quantity]) => {
    return total + Number(quantity) * Number(pricing.materials[ingredient]?.[priceField] || 0);
  }, 0);
}

function assertClose(actual, expected) {
  assert.ok(Math.abs(actual - expected) < 1e-9, `Expected ${expected}, received ${actual}`);
}

function assertUnique(values, label) {
  const normalized = values.map(value => String(value).trim().toLowerCase());
  assert.equal(new Set(normalized).size, normalized.length, `Duplicate ${label} found`);
}
