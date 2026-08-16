const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { BusinessStore } = require("./business-store");

async function run() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "still-water-business-"));
  const filePath = path.join(directory, "business.json");
  fs.writeFileSync(filePath, JSON.stringify({
    version: 6,
    salesOrders: [{
      id: "legacy-sale",
      customer: "Legacy Customer",
      status: "Draft",
      priority: "Normal",
      deposit: 5,
      lines: [{ name: "Legacy Good", quantity: 1, unitPrice: 12 }],
      revision: 1,
      createdAt: "2026-07-10T10:00:00.000Z",
      updatedAt: "2026-07-10T10:00:00.000Z"
    }],
    suppliers: [],
    storefrontBuyOrders: [],
    productionBatches: [],
    dailyCloses: [],
    supplyOrders: [{
      id: "legacy-supply",
      producer: "Van Horn Foundry",
      status: "Partially Received",
      createdAt: "2026-07-10T10:00:00.000Z",
      updatedAt: "2026-07-12T12:00:00.000Z",
      lines: [{
        id: "iron-line",
        name: "Iron",
        label: "Iron",
        quantity: 10,
        unitPrice: 2.5,
        receivedQuantity: 5
      }]
    }]
  }));

  try {
    const store = new BusinessStore({ filePath });
    await store.initialize();
    assert.equal(store.getSalesOrder("legacy-sale").orderType, "Customer Sale");
    const migrated = store.getSupplyOrder("legacy-supply");
    assert.equal(migrated.lines[0].receipts.length, 1);
    assert.deepEqual(migrated.lines[0].receipts[0], {
      id: "legacy-receipt:legacy-supply:iron-line",
      receivedAt: "2026-07-12T12:00:00.000Z",
      quantity: 5,
      unitPrice: 2.5
    });

    const updated = await store.receiveSupplyLine("legacy-supply", "iron-line", 2, { fullName: "William Winther" }, {
      id: "supply-receipt:legacy-supply:iron-line:7",
      receivedAt: "2026-07-22T09:00:00.000Z",
      unitPrice: 2.5
    });
    assert.equal(updated.lines[0].receivedQuantity, 7);
    assert.equal(updated.lines[0].receipts.length, 2);
    assert.equal(updated.lines[0].receipts[1].quantity, 2);
    assert.equal(updated.lines[0].receipts[1].receivedAt, "2026-07-22T09:00:00.000Z");

    const actor = { fullName: "William Winther" };
    const internalOrder = await store.saveSalesOrder({
      id: "internal-stock-build",
      orderType: "Internal Craft",
      customer: "Must be removed",
      status: "Reserved",
      priority: "Normal",
      deposit: 100,
      label: "Build reserve stock",
      lines: [{ name: "Crafted Good", quantity: 2, unitPrice: 75 }]
    }, actor);
    assert.equal(internalOrder.customer, "");
    assert.equal(internalOrder.deposit, 0);
    assert.equal(internalOrder.lines[0].unitPrice, 0);

    await assert.rejects(() => store.createProductionBatch({
      sourceType: "Internal Craft",
      sourceId: internalOrder.id,
      stockAllocations: [{ itemName: "Crafted Good", storageQuantity: 2 }]
    }, actor), error => error.code === "internal_craft_stock_allocation_forbidden");

    const internalBatch = await store.createProductionBatch({
      id: "internal-stock-production",
      sourceType: "Internal Craft",
      sourceId: internalOrder.id,
      reference: internalOrder.label,
      lines: [{
        itemName: "Crafted Good",
        requestedQuantity: 2,
        recipeYield: 1,
        recipe: [{ ingredient: "Iron", quantity: 1, sourceLocation: "Storage" }]
      }]
    }, actor);
    assert.equal(store.getSalesOrder(internalOrder.id).status, "In Production");
    await store.beginProductionProgress(internalBatch.id, {
      id: "internal-progress",
      targets: [{ lineId: internalBatch.lines[0].id, completedCrafts: 2 }],
      operations: [{
        id: "internal-output",
        kind: "Production Output",
        location: "Storage",
        itemName: "Crafted Good",
        quantity: 2,
        employee: actor.fullName
      }]
    }, actor);
    await store.commitProductionProgress(internalBatch.id, "internal-progress", actor);
    assert.equal(store.getSalesOrder(internalOrder.id).status, "Completed");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }

  console.log("Business-store receipt history migration checks passed.");
}

run().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});

