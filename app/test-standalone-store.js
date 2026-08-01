const assert = require("node:assert/strict");
const { newDb } = require("pg-mem");
const { Database } = require("./database");
const { StandaloneStore } = require("./standalone-store");
const { normalizeSetupPayload } = require("./setup-config");

async function run() {
  const memory = newDb({ autoCreateForeignKeyIndices: true, noAstCoverageCheck: true });
  const adapter = memory.adapters.createPg();
  const database = new Database({ pool: new adapter.Pool() });
  await database.initialize();
  const store = new StandaloneStore(database);

  try {
    const configuration = normalizeSetupPayload({
      business: { name: "Copper & Pine", currency: "USD", locale: "en-US", timezone: "UTC" },
      catalog: {
        materials: [{ id: "iron", name: "Iron", category: "Metals", unit: "bar", unitCost: 2 }],
        products: [{
          id: "widget", name: "Iron Widget", label: "Iron Widget", tag: "ITEM_IRON_WIDGET",
          category: "Goods", salePrice: 25, target: 4
        }],
        recipes: [{
          id: "widget-recipe", productName: "Iron Widget", yield: 1,
          ingredients: [{ name: "Iron", quantity: 3 }]
        }]
      }
    });
    await store.syncCatalog(configuration);

    await store.handleGuiPayload({
      action: "manual_operation",
      entry: {
        id: "sales-count", kind: "Stock Count", location: "Storefront", itemName: "Iron Widget",
        quantity: 5, createdAt: "2026-08-01T08:00:00.000Z"
      }
    });
    await store.handleGuiPayload({
      action: "manual_operation",
      entry: {
        id: "storage-count", kind: "Stock Count", location: "Storage", itemName: "Iron",
        quantity: 20, createdAt: "2026-08-01T08:00:00.000Z"
      }
    });
    await store.handleGuiPayload({
      action: "manual_operation",
      entry: {
        id: "ledger-count", kind: "Ledger Count", location: "Ledger", amount: 100,
        createdAt: "2026-08-01T08:00:00.000Z"
      }
    });
    const duplicateCount = await store.handleGuiPayload({
      action: "manual_operation",
      entry: { id: "sales-count", kind: "Stock Count", location: "Storefront", itemName: "Iron Widget", quantity: 999 }
    });
    assert.equal(duplicateCount.duplicate, true);

    const sale = {
      webhook_id: "discord-sale-1",
      event_type: "Sale",
      direction: "Stock Out",
      item_name: "Iron Widget",
      quantity: 1,
      unit_price: 25,
      current_item_total: 4,
      shop_ledger: 125,
      occurred_at: "2026-08-01T10:00:00.000Z"
    };
    assert.equal((await store.ingestWebhook(sale)).stockControlWritten, true);
    assert.equal((await store.ingestWebhook(sale)).duplicate, true);

    await store.handleGuiPayload({
      action: "manual_operation",
      entry: {
        id: "p2p-purchase", kind: "P2P Purchase", location: "Storage", itemName: "Iron",
        quantity: 5, amount: 10, createdAt: "2026-08-01T11:00:00.000Z"
      }
    });

    const review = await store.ingestWebhook({
      webhook_id: "discord-unknown-1",
      event_type: "Stocking Movement",
      direction: "Stock In",
      discord_item_name: "ITEM_NATIVE_CLOCK",
      discord_item_label: "Native Clock",
      item_name: "Native Clock",
      quantity: 2,
      current_item_total: 2,
      review_required: true,
      review_reason: "unknown_item",
      occurred_at: "2026-08-01T12:00:00.000Z"
    });
    assert.equal(review.reviewRequired, true);
    const resolved = await store.handleGuiPayload({
      action: "resolve_exception",
      exception: {
        webhookId: "discord-unknown-1",
        itemName: "Native Clock",
        quantity: 2,
        eventType: "Stocking Movement",
        direction: "Stock In",
        rememberMapping: true,
        resolvedBy: "Ada Lovelace",
        newProduct: {
          enabled: true,
          name: "Native Clock",
          label: "Native Clock",
          tag: "ITEM_NATIVE_CLOCK",
          category: "Resale",
          price: 40
        }
      }
    });
    assert.equal(resolved.productCreated, true);

    await store.handleGuiPayload({
      action: "time_clock",
      entry: {
        id: "shift-1", employee: "Ada Lovelace",
        clockIn: "2026-08-01T08:00:00.000Z", clockOut: "2026-08-01T12:00:00.000Z", durationMinutes: 240
      }
    });

    const snapshot = await store.snapshot();
    assert.equal(snapshot.dataBackend, "postgresql");
    assert.equal(snapshot.inventory.products.find(item => item.itemName === "Iron Widget").currentStock, 4);
    assert.equal(snapshot.inventory.products.find(item => item.itemName === "Native Clock").currentStock, 2);
    assert.equal(snapshot.inventory.materials.find(item => item.ingredient === "Iron").storageCount, 25);
    assert.equal(snapshot.inventory.ledger.balance, 115);
    assert.equal(snapshot.reviewExceptions[0].status, "Resolved");

    const finance = await store.finance({ from: "2026-08-01", to: "2026-08-31" });
    assert.deepEqual(finance.totals, { revenue: 25, expenses: 10, profit: 15 });
    assert.equal(finance.ledger.balance, 115);
    assert.equal(finance.coverage.storefrontSales, 1);

    const timeEntries = await database.query("SELECT * FROM time_entries");
    assert.equal(timeEntries.rowCount, 1);
    assert.equal(timeEntries.rows[0].employee_name, "Ada Lovelace");

    const legacyPayload = {
      fingerprint: "legacy-test-snapshot-1",
      actor: "Migration Test",
      snapshot: {
        ok: true,
        generatedAt: "2026-08-01T13:00:00.000Z",
        inventory: {
          products: [{
            itemName: "Iron Widget", itemLabel: "Iron Widget", itemTag: "ITEM_IRON_WIDGET",
            category: "Goods", salePrice: 25, target: 4, currentStock: 8, active: true
          }],
          materials: [{ ingredient: "Iron", storageCount: 30 }],
          storage: [{ ingredient: "Iron", storageCount: 30 }],
          ledger: { balance: 200 }
        }
      },
      finance: {
        breakdown: [
          { type: "Revenue", category: "Imported Sales", label: "Iron Widget", source: "Legacy", amount: 50, count: 2 },
          { type: "Expense", category: "Imported Costs", label: "Iron", source: "Legacy", amount: 20, count: 1 }
        ],
        balances: { ownerCapitalDeposits: 100, ownerWithdrawals: 10 }
      }
    };
    const imported = await store.importLegacySnapshot(legacyPayload);
    assert.equal(imported.duplicate, false);
    assert.equal((await store.importLegacySnapshot(legacyPayload)).duplicate, true);
    const importedSnapshot = await store.snapshot();
    assert.equal(importedSnapshot.inventory.products[0].currentStock, 8);
    assert.equal(importedSnapshot.inventory.materials[0].storageCount, 30);
    assert.equal(importedSnapshot.inventory.ledger.balance, 200);

    console.log("Standalone PostgreSQL workflow tests passed.");
  } finally {
    await database.close();
  }
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
