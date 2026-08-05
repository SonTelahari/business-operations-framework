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
        }, {
          id: "unpriced-widget", name: "Unpriced Widget", label: "Unpriced Widget", tag: "ITEM_UNPRICED_WIDGET",
          category: "Goods", salePrice: 0, target: 0
        }, {
          id: "rifle-ammo-express", name: "Rifle Ammo Express", label: "Rifle Ammo Express", tag: "ammorifleexpress",
          category: "Ammunition", salePrice: 2.25, target: 50
        }],
        recipes: [{
          id: "widget-recipe", productName: "Iron Widget", yield: 1,
          ingredients: [{ name: "Iron", quantity: 3 }]
        }]
      }
    });
    await store.syncCatalog(configuration);

    const addedMaterial = await store.handleGuiPayload({
      action: "catalog_item",
      item: {
        type: "material", name: "Glass Bottle", label: "Glass Bottle", category: "Containers",
        unit: "bottle", unitCost: 0.5, createdBy: "Ada Lovelace"
      }
    });
    assert.equal(addedMaterial.item.itemType, "material");
    const addedProduct = await store.handleGuiPayload({
      action: "catalog_item",
      item: {
        type: "product", name: "Imported Knife", label: "Imported Knife", category: "Resale",
        salePrice: 12, target: 2, createdBy: "Ada Lovelace"
      }
    });
    assert.equal(addedProduct.item.itemTag, "", "manual catalog goods may learn their game tag later");
    const addedDualPurposeGood = await store.handleGuiPayload({
      action: "catalog_item",
      item: {
        type: "both", name: "Raw Tobacco", label: "Raw Tobacco", category: "Tobacco",
        unit: "bundle", unitCost: 1.5, salePrice: 3, target: 8, createdBy: "Ada Lovelace"
      }
    });
    assert.equal(addedDualPurposeGood.item.itemType, "both");
    const updatedDualPurposeGood = await store.handleGuiPayload({
      action: "catalog_item_update",
      item: {
        id: addedDualPurposeGood.item.id,
        type: "both",
        name: "Raw Tobacco",
        label: "Raw Tobacco Leaf",
        category: "Tobacco Materials",
        unit: "bundle",
        unitCost: 1.75,
        salePrice: 3.25,
        target: 8,
        active: true,
        updatedBy: "Ada Lovelace"
      }
    });
    assert.equal(updatedDualPurposeGood.item.label, "Raw Tobacco Leaf");
    await store.handleGuiPayload({
      action: "recipe_upsert",
      recipe: {
        productName: "Imported Knife",
        yield: 2,
        ingredients: [{ name: "Raw Tobacco", quantity: 3, sourceLocation: "Storefront" }]
      }
    });
    await assert.rejects(
      () => store.handleGuiPayload({
        action: "catalog_item",
        item: { type: "product", name: "Another Knife", label: "Imported Knife" }
      }),
      error => error.code === "catalog_item_conflict"
    );

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
        id: "raw-tobacco-storefront-count", kind: "Stock Count", location: "Storefront", itemName: "Raw Tobacco",
        quantity: 5, createdAt: "2026-08-01T08:00:00.000Z"
      }
    });
    await store.handleGuiPayload({
      action: "manual_operation",
      entry: {
        id: "raw-tobacco-storage-count", kind: "Stock Count", location: "Storage", itemName: "Raw Tobacco",
        quantity: 12, createdAt: "2026-08-01T08:00:00.000Z"
      }
    });
    await store.handleGuiPayload({
      action: "stock_target",
      target: { itemName: "Raw Tobacco", target: 10 }
    });
    await store.handleGuiPayload({
      action: "manual_operation",
      entry: {
        id: "rifle-ammo-count", kind: "Stock Count", location: "Storefront", itemName: "Rifle Ammo Express",
        quantity: 48, createdAt: "2026-08-01T08:00:00.000Z"
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
    const saleResult = await store.ingestWebhook(sale);
    assert.equal(saleResult.stockControlWritten, false);
    assert.equal(saleResult.listingTotalObserved, true);
    assert.equal((await store.ingestWebhook(sale)).duplicate, true);

    const labelOnlySale = await store.ingestWebhook({
      webhook_id: "discord-label-sale-1",
      event_type: "Sale",
      direction: "Stock Out",
      discord_item_label: "Iron Widget",
      quantity: 1,
      unit_price: 25,
      current_item_total: 3,
      shop_ledger: 150,
      review_required: true,
      review_reason: "missing_item",
      occurred_at: "2026-08-01T10:30:00.000Z"
    });
    assert.equal(labelOnlySale.reviewRequired, undefined);
    assert.equal(labelOnlySale.transactionWritten, true);

    const implicitCatalogMatch = await store.ingestWebhook({
      webhook_id: "discord-beta-widget-1",
      event_type: "Stocking Movement",
      direction: "Stock In",
      discord_item_name: "ITEM_BETA_WIDGET",
      discord_item_label: "Iron Widget",
      item_name: "Iron Widget",
      quantity: 4,
      review_required: true,
      review_reason: "unknown_item",
      occurred_at: "2026-08-01T10:35:00.000Z"
    });
    assert.equal(implicitCatalogMatch.reviewRequired, true);
    assert.equal(implicitCatalogMatch.reviewReason, "unknown_item");
    assert.equal(implicitCatalogMatch.transactionWritten, false);
    assert.equal(
      (await store.snapshot()).inventory.products.find(item => item.itemName === "Iron Widget").currentStock,
      3,
      "an exact label must not silently connect a parser-unknown game item"
    );
    await store.handleGuiPayload({
      action: "resolve_exception",
      exception: {
        webhookId: "discord-beta-widget-1",
        itemName: "Iron Widget",
        quantity: 4,
        eventType: "Stocking Movement",
        direction: "Stock In",
        rememberMapping: true,
        resolvedBy: "Ada Lovelace"
      }
    });
    const mappedCatalogMatch = await store.ingestWebhook({
      webhook_id: "discord-beta-widget-2",
      event_type: "Stocking Movement",
      direction: "Stock In",
      discord_item_name: "ITEM_BETA_WIDGET",
      discord_item_label: "Iron Widget",
      item_name: "Iron Widget",
      quantity: 1,
      review_required: true,
      review_reason: "unknown_item",
      occurred_at: "2026-08-01T10:36:00.000Z"
    });
    assert.equal(mappedCatalogMatch.reviewRequired, undefined);
    assert.equal(mappedCatalogMatch.transactionWritten, true);

    await store.ingestWebhook({
      webhook_id: "discord-priced-stock-1",
      event_type: "Stocking Movement",
      direction: "Stock In",
      item_name: "Unpriced Widget",
      quantity: 1,
      unit_price: 12,
      current_item_total: 1,
      occurred_at: "2026-08-01T10:45:00.000Z"
    });

    await store.ingestWebhook({
      webhook_id: "discord-rifle-wrong-price",
      event_type: "Stocking Movement",
      direction: "Stock In",
      item_name: "Rifle Ammo Express",
      quantity: 2,
      unit_price: 2,
      occurred_at: "2026-08-01T10:46:00.000Z"
    });
    const rifleWithdrawal = await store.ingestWebhook({
      webhook_id: "discord-rifle-withdrawal",
      event_type: "Stocking Movement",
      direction: "Stock Out",
      item_name: "Rifle Ammo Express",
      quantity: 2,
      unit_price: 2,
      current_item_total: 0,
      occurred_at: "2026-08-01T10:47:00.000Z"
    });
    assert.equal(rifleWithdrawal.stockControlWritten, false);
    assert.equal(rifleWithdrawal.listingTotalObserved, true);
    assert.equal(rifleWithdrawal.reviewRequired, true);
    assert.equal(rifleWithdrawal.reviewReason, "stock_count_mismatch");
    assert.equal(rifleWithdrawal.appInventoryTotal, 48);
    assert.equal(rifleWithdrawal.reportedItemTotal, 0);
    assert.equal(rifleWithdrawal.stockVariance, 48);
    await store.ingestWebhook({
      webhook_id: "discord-rifle-correct-price",
      event_type: "Stocking Movement",
      direction: "Stock In",
      item_name: "Rifle Ammo Express",
      quantity: 2,
      unit_price: 2.25,
      occurred_at: "2026-08-01T10:48:00.000Z"
    });

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

    await store.ingestWebhook({
      webhook_id: "discord-unknown-material-1",
      event_type: "Stocking Movement",
      direction: "Stock In",
      discord_item_name: "ITEM_NATIVE_ORE",
      discord_item_label: "Native Ore",
      item_name: "Native Ore",
      quantity: 3,
      current_item_total: 3,
      review_required: true,
      review_reason: "unknown_item",
      occurred_at: "2026-08-01T12:05:00.000Z"
    });
    const resolvedMaterial = await store.handleGuiPayload({
      action: "resolve_exception",
      exception: {
        webhookId: "discord-unknown-material-1",
        itemName: "Native Ore",
        quantity: 3,
        eventType: "Stocking Movement",
        direction: "Stock In",
        rememberMapping: true,
        resolvedBy: "Ada Lovelace",
        newItem: {
          enabled: true,
          type: "material",
          name: "Native Ore",
          label: "Native Ore",
          tag: "ITEM_NATIVE_ORE",
          category: "Metals",
          unit: "ore",
          unitCost: 1.5
        }
      }
    });
    assert.equal(resolvedMaterial.catalogItem.itemType, "material");
    const mappedMaterial = await store.ingestWebhook({
      webhook_id: "discord-unknown-material-2",
      event_type: "Stocking Movement",
      direction: "Stock In",
      discord_item_name: "ITEM_NATIVE_ORE",
      discord_item_label: "Native Ore",
      quantity: 2,
      current_item_total: 5,
      review_required: true,
      review_reason: "unknown_item",
      occurred_at: "2026-08-01T12:06:00.000Z"
    });
    assert.equal(mappedMaterial.reviewRequired, undefined, "a reviewed material mapping must apply future webhooks");

    await store.ingestWebhook({
      webhook_id: "discord-manual-product-1",
      event_type: "Stocking Movement",
      direction: "Stock In",
      discord_item_name: "ITEM_IMPORTED_KNIFE",
      discord_item_label: "Native Trade Knife",
      quantity: 1,
      current_item_total: 1,
      review_required: true,
      review_reason: "unknown_item",
      occurred_at: "2026-08-01T12:07:00.000Z"
    });
    const linkedManualProduct = await store.handleGuiPayload({
      action: "resolve_exception",
      exception: {
        webhookId: "discord-manual-product-1",
        itemName: "Imported Knife",
        quantity: 1,
        eventType: "Stocking Movement",
        direction: "Stock In",
        rememberMapping: true,
        resolvedBy: "Ada Lovelace"
      }
    });
    assert.equal(linkedManualProduct.catalogItemCreated, false);
    const mappedManualProduct = await store.ingestWebhook({
      webhook_id: "discord-manual-product-2",
      event_type: "Stocking Movement",
      direction: "Stock In",
      discord_item_name: "ITEM_IMPORTED_KNIFE",
      discord_item_label: "Native Trade Knife",
      quantity: 1,
      current_item_total: 2,
      review_required: true,
      review_reason: "unknown_item",
      occurred_at: "2026-08-01T12:08:00.000Z"
    });
    assert.equal(mappedManualProduct.reviewRequired, undefined, "Review must link a Discord tag to a manually added good");

    await store.handleGuiPayload({
      action: "time_clock",
      entry: {
        id: "shift-1", employee: "Ada Lovelace",
        clockIn: "2026-08-01T08:00:00.000Z", clockOut: "2026-08-01T12:00:00.000Z", durationMinutes: 240
      }
    });

    const snapshot = await store.snapshot();
    assert.equal(snapshot.dataBackend, "postgresql");
    assert.equal(snapshot.inventory.products.find(item => item.itemName === "Iron Widget").currentStock, 8);
    assert.equal(snapshot.inventory.products.find(item => item.itemName === "Native Clock").currentStock, 2);
    assert.equal(snapshot.inventory.products.some(item => item.itemName === "Native Ore"), false);
    assert.equal(snapshot.inventory.products.find(item => item.itemName === "Imported Knife").target, 2);
    assert.equal(snapshot.inventory.products.find(item => item.itemName === "Imported Knife").currentStock, 2);
    assert.equal(snapshot.inventory.products.find(item => item.itemName === "Raw Tobacco").itemType, "both");
    assert.equal(snapshot.inventory.products.find(item => item.itemName === "Raw Tobacco").currentStock, 5);
    assert.equal(snapshot.inventory.products.find(item => item.itemName === "Raw Tobacco").target, 10);
    assert.equal(snapshot.inventory.products.find(item => item.itemName === "Unpriced Widget").salePrice, 12);
    assert.equal(snapshot.inventory.products.find(item => item.itemName === "Rifle Ammo Express").currentStock, 50);
    assert.equal(snapshot.inventory.products.find(item => item.itemName === "Rifle Ammo Express").salePrice, 2.25);
    assert.equal(snapshot.inventory.materials.find(item => item.ingredient === "Iron").storageCount, 25);
    assert.equal(snapshot.inventory.materials.find(item => item.ingredient === "Glass Bottle").unitCost, 0.5);
    assert.equal(snapshot.inventory.materials.find(item => item.ingredient === "Native Ore").category, "Metals");
    assert.equal(snapshot.inventory.materials.find(item => item.ingredient === "Raw Tobacco").itemType, "both");
    assert.equal(snapshot.inventory.materials.find(item => item.ingredient === "Raw Tobacco").storageCount, 12);
    assert.equal(snapshot.inventory.materials.find(item => item.ingredient === "Raw Tobacco").unitCost, 1.75);
    assert.equal(snapshot.recipes.find(recipe => recipe.productName === "Imported Knife").yield, 2);
    assert.equal(snapshot.recipes.find(recipe => recipe.productName === "Imported Knife").ingredients[0].sourceLocation, "Storefront");
    assert.equal(snapshot.inventory.storefront.find(item => item.itemName === "Native Ore").currentStock, 5);
    assert.equal(snapshot.inventory.ledger.balance, 140);
    assert.equal(snapshot.reviewExceptions.find(entry => entry.webhookId === "discord-unknown-1").status, "Resolved");
    const countDiscrepancy = snapshot.reviewExceptions.find(entry => entry.webhookId === "discord-rifle-withdrawal");
    assert.equal(countDiscrepancy.status, "Open");
    assert.equal(countDiscrepancy.reason, "stock_count_mismatch");
    assert.equal(countDiscrepancy.currentItemTotal, 0);
    assert.equal(countDiscrepancy.appInventoryTotal, 48);
    assert.equal(countDiscrepancy.stockVariance, 48);
    assert.equal(countDiscrepancy.transactionWritten, true);

    const listingWithdrawal = await database.query(`
      SELECT quantity_delta, absolute_quantity, metadata
      FROM inventory_events
      WHERE event_id = 'discord-rifle-withdrawal:stock'
    `);
    assert.equal(Number(listingWithdrawal.rows[0].quantity_delta), -2);
    assert.equal(listingWithdrawal.rows[0].absolute_quantity, null);
    assert.equal(listingWithdrawal.rows[0].metadata.listingItemTotal, 0);

    const acknowledgedDiscrepancy = await store.handleGuiPayload({
      action: "resolve_exception",
      exception: {
        webhookId: "discord-rifle-withdrawal",
        itemName: "Rifle Ammo Express",
        quantity: 2,
        eventType: "Stocking Movement",
        direction: "Stock Out",
        unitPrice: 2,
        rememberMapping: false,
        resolvedBy: "Ada Lovelace",
        note: "Price-specific listing total acknowledged"
      }
    });
    assert.equal(acknowledgedDiscrepancy.transactionAlreadyWritten, true);
    assert.equal((await store.snapshot()).inventory.products.find(item => item.itemName === "Rifle Ammo Express").currentStock, 50);

    const dismissedDiscrepancy = await store.ingestWebhook({
      webhook_id: "discord-unpriced-count-mismatch",
      event_type: "Stocking Movement",
      direction: "Stock In",
      item_name: "Unpriced Widget",
      quantity: 1,
      unit_price: 12,
      current_item_total: 0,
      occurred_at: "2026-08-01T13:00:00.000Z"
    });
    assert.equal(dismissedDiscrepancy.reviewRequired, true);
    await store.handleGuiPayload({
      action: "ignore_exception",
      exception: { webhookId: "discord-unpriced-count-mismatch", resolvedBy: "Ada Lovelace" }
    });
    const dismissedWebhook = await database.query(`
      SELECT status FROM webhook_events WHERE webhook_id = 'discord-unpriced-count-mismatch'
    `);
    assert.equal(dismissedWebhook.rows[0].status, "applied");
    assert.equal((await store.snapshot()).inventory.products.find(item => item.itemName === "Unpriced Widget").currentStock, 2);

    const finance = await store.finance({ from: "2026-08-01", to: "2026-08-31" });
    assert.deepEqual(finance.totals, { revenue: 50, expenses: 10, profit: 40 });
    assert.equal(finance.ledger.balance, 140);
    assert.equal(finance.coverage.storefrontSales, 2);

    await database.query("UPDATE catalog_items SET sale_price = 0 WHERE normalized_name = 'unpriced widget'");
    assert.deepEqual((await store.reconcileCatalogPricesFromWebhooks()).repaired, ["Unpriced Widget"]);
    assert.equal((await store.snapshot()).inventory.products.find(item => item.itemName === "Unpriced Widget").salePrice, 12);
    await store.syncCatalog(configuration);
    assert.equal((await store.snapshot()).inventory.products.find(item => item.itemName === "Unpriced Widget").salePrice, 12);

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
          }, {
            itemName: "Rolling Paper", itemLabel: "Rolling Paper", itemType: "both",
            category: "Tobacco", salePrice: 1, target: 20, currentStock: 10, active: true
          }],
          materials: [
            { ingredient: "Iron", storageCount: 30 },
            { ingredient: "Rolling Paper", itemType: "both", unit: "pack", unitCost: 0.25, storageCount: 40 }
          ],
          storage: [
            { ingredient: "Iron", storageCount: 30 },
            { ingredient: "Rolling Paper", storageCount: 40 }
          ],
          ledger: { balance: 200 }
        },
        reviewExceptions: [{
          webhookId: "legacy-open-sale",
          status: "Open",
          reason: "missing_item",
          receivedAt: "2026-08-01T12:30:00.000Z",
          discordItemLabel: "Iron Widget",
          eventType: "Sale",
          direction: "Stock Out",
          quantity: 1,
          unitPrice: 25,
          ledgerBalance: 200,
          currentItemTotal: 8,
          transactionWritten: false
        }, {
          webhookId: "legacy-auto-match",
          status: "Open",
          reason: "missing_item",
          receivedAt: "2026-08-01T12:31:00.000Z",
          discordItemLabel: "Iron Widget",
          eventType: "Stocking Movement",
          direction: "Stock In",
          quantity: 1,
          unitPrice: 25,
          currentItemTotal: 8,
          transactionWritten: false
        }]
      },
      finance: {
        breakdown: [
          { type: "Revenue", category: "Imported Sales", label: "Iron Widget", source: "Legacy", amount: 50, count: 2 },
          { type: "Expense", category: "Imported Costs", label: "Iron", source: "Legacy", amount: 20, count: 1 }
        ],
        balances: { ownerCapitalDeposits: 0, ownerWithdrawals: 10 }
      },
      audit: [{
        id: "owner-funds-1",
        createdAt: "2026-07-31T18:00:00.000Z",
        action: "finance.funds_recorded",
        details: { kind: "Owner Capital Deposit", amount: 75, note: "Opening capital" }
      }]
    };
    const imported = await store.importLegacySnapshot(legacyPayload);
    assert.equal(imported.duplicate, false);
    assert.equal((await store.importLegacySnapshot(legacyPayload)).duplicate, true);
    const importedSnapshot = await store.snapshot();
    assert.equal(importedSnapshot.inventory.products.find(item => item.itemName === "Iron Widget").currentStock, 8);
    assert.equal(importedSnapshot.inventory.materials.find(item => item.ingredient === "Iron").storageCount, 30);
    assert.equal(importedSnapshot.inventory.products.find(item => item.itemName === "Rolling Paper").itemType, "both");
    assert.equal(importedSnapshot.inventory.products.find(item => item.itemName === "Rolling Paper").currentStock, 10);
    assert.equal(importedSnapshot.inventory.materials.find(item => item.ingredient === "Rolling Paper").itemType, "both");
    assert.equal(importedSnapshot.inventory.materials.find(item => item.ingredient === "Rolling Paper").storageCount, 40);
    assert.equal(importedSnapshot.inventory.ledger.balance, 200);

    const importedFinance = await store.finance();
    assert.equal(importedFinance.balances.ownerCapitalDeposits, 75);
    assert.equal(importedFinance.balances.ownerWithdrawals, 10);
    assert.equal((await store.reconcileImportedFundAudit([{
      id: "legacy-owner-funds-1",
      createdAt: "2026-07-31T18:00:00.000Z",
      action: "finance.funds_recorded",
      details: { kind: "Owner Capital Deposit", amount: 75, note: "Opening capital" }
    }])).inserted, 0);

    const beforeResolution = await store.finance();
    const resolvedLegacy = await store.handleGuiPayload({
      action: "resolve_exception",
      exception: {
        webhookId: "legacy-open-sale",
        itemName: "Iron Widget",
        quantity: 1,
        eventType: "Sale",
        direction: "Stock Out",
        unitPrice: 25,
        resolvedBy: "Migration Test"
      }
    });
    assert.equal(resolvedLegacy.historyPreserved, true);
    assert.equal(resolvedLegacy.transactionWritten, false);
    assert.equal(
      (await store.snapshot()).inventory.products.find(item => item.itemName === "Iron Widget").currentStock,
      8
    );
    assert.deepEqual((await store.finance()).totals, beforeResolution.totals);
    assert.deepEqual((await store.reconcileImportedExceptions()).repaired, ["legacy-auto-match"]);
    const autoResolved = (await store.snapshot()).reviewExceptions.find(entry => entry.webhookId === "legacy-auto-match");
    assert.equal(autoResolved.status, "Resolved");
    assert.equal(autoResolved.transactionWritten, false);

    await store.handleGuiPayload({
      action: "manual_operation",
      entry: {
        id: "already-recorded-cash-out",
        kind: "Cash Transfer Out",
        location: "Ledger",
        amount: 5,
        createdAt: "2026-08-01T14:00:00.000Z"
      }
    });
    const afterTransfer = await store.finance();
    assert.deepEqual(afterTransfer.totals, beforeResolution.totals);
    assert.equal(afterTransfer.ledger.balance, 195);

    console.log("Standalone PostgreSQL workflow tests passed.");
  } finally {
    await database.close();
  }
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
