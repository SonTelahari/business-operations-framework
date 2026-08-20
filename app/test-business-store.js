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
    const legacyCustomer = await store.saveCustomer({
      id: "customer-legacy",
      name: "Legacy Customer",
      customerType: "Individual"
    }, actor);
    assert.equal(legacyCustomer.stats.orderCount, 1, "matching historical customer names are linked on registration");
    const renamedLegacyCustomer = await store.saveCustomer({
      ...legacyCustomer,
      name: "Legacy Client"
    }, actor);
    assert.equal(renamedLegacyCustomer.stats.orderCount, 1, "stable customer IDs preserve history after a rename");
    assert.equal(store.getSalesOrder("legacy-sale").customer, "Legacy Customer", "historical order names remain snapshots");

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

    const customer = await store.saveCustomer({
      id: "customer-arthur",
      name: "Arthur Morgan",
      customerType: "Individual",
      pricingTier: "Reseller",
      location: "Valentine",
      telegram: "SW-184",
      notes: "Prefers rifles"
    }, actor);
    assert.equal(customer.name, "Arthur Morgan");
    assert.equal(customer.pricingTier, "Reseller");
    assert.equal(customer.stats.orderCount, 0);
    await assert.rejects(() => store.saveCustomer({
      name: " arthur MORGAN "
    }, actor), error => error.code === "customer_name_exists");

    await store.saveSalesOrder({
      id: "customer-completed-sale",
      orderType: "Customer Sale",
      customerId: customer.id,
      customer: "Stale name ignored",
      pricingTier: "Reseller",
      status: "Completed",
      deposit: 0,
      lines: [
        { name: "Bolt Action Rifle", label: "Bolt Action Rifle", quantity: 1, unitPrice: 225 },
        { name: "Rifle Ammo Express", label: "Rifle Ammo Express", quantity: 2, unitPrice: 2.25 }
      ]
    }, actor);
    const activeCustomerOrder = await store.saveSalesOrder({
      id: "customer-active-order",
      orderType: "Customer Sale",
      customerId: customer.id,
      status: "Reserved",
      deposit: 50,
      lines: [{ name: "Navy Revolver", label: "Navy Revolver", quantity: 2, unitPrice: 105 }]
    }, actor);
    assert.equal(activeCustomerOrder.pricingTier, "Storefront", "orders without an explicit tier remain on storefront pricing");
    assert.equal(store.getSalesOrder("customer-completed-sale").pricingTier, "Reseller");

    const customerWithHistory = store.getCustomer(customer.id);
    assert.equal(customerWithHistory.stats.orderCount, 2);
    assert.equal(customerWithHistory.stats.completedSales, 1);
    assert.equal(customerWithHistory.stats.activeOrders, 1);
    assert.equal(customerWithHistory.stats.lifetimeSales, 229.5);
    assert.equal(customerWithHistory.stats.outstandingBalance, 160);
    assert.equal(customerWithHistory.stats.unitsPurchased, 3);
    assert.equal(customerWithHistory.stats.topItems[0].label, "Rifle Ammo Express");

    const counterSale = await store.saveSalesOrder({
      id: "counter-cash-sale",
      orderType: "Counter Sale",
      customerId: customer.id,
      customer: customer.name,
      status: "Draft",
      priority: "Expedite",
      deliveryDate: "2026-07-30",
      deposit: 0,
      lines: [{ name: "Gun Cleaning Kit", label: "Gun Cleaning Kit", quantity: 2, unitPrice: 15 }]
    }, actor);
    assert.equal(counterSale.status, "Completed");
    assert.equal(counterSale.customerId, "");
    assert.equal(counterSale.customer, "");
    assert.equal(counterSale.priority, "Normal");
    assert.equal(counterSale.deliveryDate, "");
    assert.equal(counterSale.deposit, 30);
    assert.equal(counterSale.paymentMethod, "Cash");
    assert.equal(store.getCustomer(customer.id).stats.orderCount, 2, "counter sales must not inflate a named customer's history");
    await assert.rejects(() => store.createProductionBatch({
      sourceType: "Customer Order",
      sourceId: counterSale.id,
      lines: [{ itemName: "Gun Cleaning Kit", requestedQuantity: 2, recipe: [{ ingredient: "Oil", quantity: 1 }] }]
    }, actor), error => error.code === "counter_sale_production_forbidden");

    const removedCustomer = await store.removeCustomer(customer.id);
    assert.equal(removedCustomer.stats.orderCount, 2);
    assert.equal(store.listCustomers().length, 1);
    assert.equal(store.getSalesOrder("customer-completed-sale").customer, "Arthur Morgan", "historical sales retain the customer snapshot");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }

  console.log("Business-store receipt, customer, and counter-sale checks passed.");
}

run().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});

