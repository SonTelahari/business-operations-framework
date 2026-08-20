const assert = require("assert");
const { planProduction, normalizeLocation } = require("./production-planner");

assert.equal(normalizeLocation("Store"), "Storefront");

const recipes = {
  Cigar: [["Tobacco", 2, "Storage"]],
  "Cigar Box": [["Cigar", 10, "Storage"]]
};

const nested = planProduction({
  lines: [{ itemName: "Cigar Box", requestedQuantity: 2 }],
  recipes,
  recipeYields: { Cigar: 1, "Cigar Box": 1 },
  counts: { Storage: new Map([["cigar", 3], ["tobacco", 100]]) }
});
assert.deepEqual(nested.buildLines.map(line => ({
  name: line.name,
  quantity: line.requestedQuantity,
  stage: line.stage,
  intermediate: line.isIntermediate
})), [
  { name: "Cigar", quantity: 17, stage: 1, intermediate: true },
  { name: "Cigar Box", quantity: 2, stage: 2, intermediate: false }
]);
assert.deepEqual(nested.materials, [{
  ingredient: "Tobacco",
  sourceLocation: "Storage",
  needed: 34,
  available: 100,
  shortage: 0
}]);
assert.equal(nested.components.find(line => line.ingredient === "Cigar").fromStock, 3);
assert.equal(nested.components.find(line => line.ingredient === "Cigar").toProduce, 17);

const deep = planProduction({
  lines: [{ itemName: "Cigar Box", requestedQuantity: 1 }],
  recipes: {
    "Cigar Box": [["Cigar", 10, "Storage"]],
    Cigar: [["Filler", 2, "Storage"]],
    Filler: [["Tobacco", 3, "Storage"]]
  },
  counts: { Storage: { tobacco: 100 } }
});
assert.deepEqual(deep.buildLines.map(line => [line.name, line.stage]), [
  ["Filler", 1],
  ["Cigar", 2],
  ["Cigar Box", 3]
]);
assert.equal(deep.materials[0].needed, 60);

const yielded = planProduction({
  lines: [{ itemName: "Cigar Box", requestedQuantity: 2 }],
  recipes,
  recipeYields: { Cigar: 5, "Cigar Box": 1 },
  counts: { Storage: { cigar: 3, tobacco: 100 } }
});
const cigarStage = yielded.buildLines.find(line => line.name === "Cigar");
assert.equal(cigarStage.requestedQuantity, 17);
assert.equal(cigarStage.plannedCrafts, 4);
assert.equal(cigarStage.producedQuantity, 20);
assert.equal(yielded.materials[0].needed, 8);

const storefrontSource = planProduction({
  lines: [{ itemName: "Cigar Box", requestedQuantity: 1 }],
  recipes,
  recipeYields: { Cigar: 1, "Cigar Box": 1 },
  counts: {
    Storage: { cigar: 0, tobacco: 100 },
    Storefront: { cigar: 8 }
  },
  ingredientSources: { cigar: "Storefront" }
});
assert.equal(storefrontSource.buildLines.find(line => line.name === "Cigar").requestedQuantity, 2);
assert.equal(storefrontSource.buildLines.find(line => line.name === "Cigar").outputLocation, "Storefront");

const shared = planProduction({
  lines: [
    { itemName: "Cigar Box", requestedQuantity: 1 },
    { itemName: "Gift Pack", requestedQuantity: 1 }
  ],
  recipes: { ...recipes, "Gift Pack": [["Cigar", 4, "Storage"]] },
  recipeYields: { Cigar: 5, "Cigar Box": 1, "Gift Pack": 1 },
  counts: { Storage: { cigar: 2, tobacco: 100 } }
});
assert.equal(shared.buildLines.filter(line => line.name === "Cigar").length, 1);
assert.equal(shared.buildLines.find(line => line.name === "Cigar").requestedQuantity, 12);
assert.equal(shared.buildLines.find(line => line.name === "Cigar").producedQuantity, 15);

const cyclic = planProduction({
  lines: [{ itemName: "A", requestedQuantity: 1 }],
  recipes: { A: [["B", 1]], B: [["A", 1]] }
});
assert.equal(cyclic.issues[0].type, "recipe_cycle");
assert.deepEqual(cyclic.issues[0].path, ["A", "B", "A"]);

console.log("Production planner tests passed");
