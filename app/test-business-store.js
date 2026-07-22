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
    salesOrders: [],
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
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }

  console.log("Business-store receipt history migration checks passed.");
}

run().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});

