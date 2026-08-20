const assert = require("assert");
const {
  normalizeProductionSource,
  productionInventoryState,
  finishedStockReservations,
  reservationsByLocation,
  subtractInventoryReservations
} = require("./production-inventory");

assert.equal(normalizeProductionSource("Sales"), "Storefront");
assert.equal(normalizeProductionSource("store"), "Storefront");
assert.equal(normalizeProductionSource("warehouse"), "Storage");

const batch = {
  lines: [
    {
      id: "cigar-stage",
      itemName: "Cigar",
      itemLabel: "Cigar",
      requestedQuantity: 17,
      recipeYield: 5,
      outputLocation: "Storage",
      isIntermediate: true,
      recipe: [{ ingredient: "Tobacco", quantity: 2, sourceLocation: "Storage" }]
    },
    {
      id: "box-stage",
      itemName: "Cigar Box",
      itemLabel: "Cigar Box",
      requestedQuantity: 2,
      recipeYield: 1,
      outputLocation: "Storefront",
      isIntermediate: false,
      recipe: [{ ingredient: "Cigar", quantity: 10, sourceLocation: "Storage" }]
    }
  ]
};
const planned = productionInventoryState(batch, new Map([
  ["cigar-stage", 4],
  ["box-stage", 2]
]));
assert.equal(planned.uses.get("Storage:tobacco").quantity, 8);
assert.equal(planned.uses.get("Storage:tobacco").needed, 8);
assert.equal(planned.uses.get("Storage:cigar").quantity, 3);
assert.equal(planned.outputs.get("Storage:cigar").quantity, 3);
assert.equal(planned.outputs.get("Storage:cigar").rootOutput, false);
assert.equal(planned.outputs.get("Storefront:cigar box").quantity, 2);

const callbackState = productionInventoryState(batch, line => line.id === "cigar-stage" ? 1 : 1);
assert.equal(callbackState.uses.get("Storage:tobacco").quantity, 2);
assert.equal(callbackState.uses.get("Storage:cigar").quantity, 5);

const woodAlias = productionInventoryState({
  lines: [{
    id: "wood-item",
    itemName: "Stock",
    recipeYield: 1,
    recipe: [{ ingredient: "Wood", quantity: 2, sourceLocation: "Storage" }]
  }]
}, { "wood-item": 3 });
assert.equal(woodAlias.uses.get("Storage:softwood").itemName, "Softwood");
assert.equal(woodAlias.uses.get("Storage:softwood").quantity, 6);

const orders = [
  { id: "order-a", status: "Active" },
  { id: "order-b", status: "Completed" }
];
const customerBatch = {
  sourceType: "Customer Order",
  sourceId: "order-a",
  status: "In Progress",
  stockAllocations: [{ itemName: "Cigar", storageQuantity: 2, storefrontQuantity: 1 }],
  pendingProgress: { targets: [{ lineId: "gun-line", completedCrafts: 2 }] },
  lines: [{
    id: "gun-line",
    itemName: "Navy Revolver",
    requestedQuantity: 5,
    completedCrafts: 1,
    recipeYield: 3,
    outputLocation: "Storefront"
  }]
};
const reservations = finishedStockReservations({
  batches: [
    customerBatch,
    { ...customerBatch, sourceId: "order-b" },
    { ...customerBatch, sourceType: "Internal Craft" }
  ],
  orders
});
assert.equal(reservations.get("Storage:cigar"), 2);
assert.equal(reservations.get("Storefront:cigar"), 1);
assert.equal(reservations.get("Storefront:navy revolver"), 5);
assert.equal(finishedStockReservations({ batches: [customerBatch], orders, excludeOrderId: "order-a" }).size, 0);

const grouped = reservationsByLocation(reservations);
assert.equal(grouped.Storage.get("cigar"), 2);
assert.equal(grouped.Storefront.get("navy revolver"), 5);

const available = subtractInventoryReservations({
  counts: {
    Storage: new Map([["cigar", 5]]),
    Storefront: new Map([
      ["cigar", { quantity: 4, countedAt: "2026-08-20T12:00:00Z" }],
      ["navy revolver", 8]
    ])
  },
  reservations
});
assert.equal(available.Storage.get("cigar"), 3);
assert.deepEqual(available.Storefront.get("cigar"), {
  quantity: 3,
  countedAt: "2026-08-20T12:00:00Z"
});
assert.equal(available.Storefront.get("navy revolver"), 3);

console.log("Production inventory tests passed");
