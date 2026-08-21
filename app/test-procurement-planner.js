const assert = require("assert");
const { planProcurement, protectTargetStock } = require("./procurement-planner");

const recipes = {
  Cigarettes: [["Rolling Paper", 1, "Storage"], ["Indian Tobacco", 1, "Storage"]],
  "Rolling Paper": [["Flax", 1, "Storage"]]
};

const tobacconist = planProcurement({
  demandBySource: {
    restock: [{ itemName: "Cigarettes", quantity: 200 }],
    storage: [{ itemName: "Rolling Paper", quantity: 100 }]
  },
  recipes,
  materialKeys: ["Flax", "Indian Tobacco"]
});
const flax = tobacconist.find(line => line.ingredient === "Flax");
const tobacco = tobacconist.find(line => line.ingredient === "Indian Tobacco");
assert.equal(flax.demand, 300, "storefront and storage production must combine into absolute flax demand");
assert.equal(flax.restockDemand, 200);
assert.equal(flax.storageDemand, 100);
assert.equal(tobacco.demand, 200);
assert.equal(tobacco.restockDemand, 200);

const protectedStock = planProcurement({
  demandBySource: {
    restock: [{ itemName: "Cigarettes", quantity: 200 }],
    sales: [{ itemName: "Cigarettes", quantity: 50 }]
  },
  recipes,
  counts: { Storage: new Map([["Rolling Paper", 150]]), Storefront: new Map() },
  targetFloors: { Storage: new Map([["Rolling Paper", 100]]), Storefront: new Map() },
  materialKeys: ["Flax", "Indian Tobacco"]
});
const protectedFlax = protectedStock.find(line => line.ingredient === "Flax");
assert.equal(protectedFlax.demand, 200, "only stock above its target floor may offset downstream production");
assert.equal(protectedFlax.intermediateCoverage, 50);
assert.equal(protectedFlax.salesDemand, 50);

const directMaterialTarget = planProcurement({
  demandBySource: {
    restock: [{ itemName: "Rolling Paper", quantity: 100 }],
    storage: [{ itemName: "Flax", quantity: 30 }]
  },
  recipes,
  counts: { Storage: new Map([["Flax", 20]]), Storefront: new Map() },
  targetFloors: { Storage: new Map([["Flax", 50]]), Storefront: new Map() },
  materialKeys: ["Flax"]
});
const directFlax = directMaterialTarget.find(line => line.ingredient === "Flax");
assert.equal(directFlax.demand, 130, "raw-material storage gaps must be added directly to production demand");
assert.equal(directFlax.missing, 130);

const ordered = planProcurement({
  demandBySource: { storage: [{ itemName: "Flax", quantity: 30 }] },
  materialKeys: ["Flax"],
  committed: new Map([["Flax", 12]])
});
assert.equal(ordered[0].missing, 18, "incoming supply orders must cover the consolidated shortage once");

const queuedBaseMaterial = planProcurement({
  demandBySource: { sales: [{ itemName: "Rolling Paper", quantity: 40, directMaterial: true }] },
  recipes,
  materialKeys: ["Flax", "Rolling Paper"]
});
assert.equal(queuedBaseMaterial[0].ingredient, "Rolling Paper");
assert.equal(queuedBaseMaterial[0].missing, 40, "saved production batches must contribute only their remaining direct material uses");
assert.equal(queuedBaseMaterial.some(line => line.ingredient === "Flax"), false);

const protectedCounts = protectTargetStock(
  { Storage: new Map([["Flax", 80]]), Storefront: new Map([["Cigarettes", 12]]) },
  { Storage: new Map([["Flax", 50]]), Storefront: new Map([["Cigarettes", 10]]) }
);
assert.equal(protectedCounts.Storage.get("flax"), 30);
assert.equal(protectedCounts.Storefront.get("cigarettes"), 2);

console.log("Procurement planner tests passed: recursive source demand, target protection, direct material gaps, and commitments.");
