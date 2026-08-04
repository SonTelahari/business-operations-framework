const assert = require("node:assert/strict");
const { normalizeKey, resolveCatalogItem, selectLatestCounts, selectCurrentLedger } = require("./inventory-counts");
const pricing = require("./pricing");

global.window = {};
require("./recipes");
const recipes = global.window.FRONTIER_RECIPES;
delete global.window;

assert.equal(normalizeKey("Wood"), "softwood");
assert.equal(normalizeKey("Soft Wood"), "softwood");
assert.equal(pricing.materials.Softwood.midpoint, 0.175);
assert(Object.values(recipes).flat().every(([ingredient]) => ingredient !== "Wood"));

const navyItems = [
  { name: "Navy Crossover Revolver", label: "Revolver Navy Crossover", tag: "WEAPON_REVOLVER_NAVY_CROSSOVER", category: "Revolvers" },
  { name: "Navy Revolver", label: "Revolver Navy", tag: "WEAPON_REVOLVER_NAVY", category: "Revolvers" }
];
assert.equal(
  resolveCatalogItem(navyItems, "Revolver Navy").name,
  "Navy Revolver",
  "an exact stock label must win over an earlier partial label match"
);
assert.equal(resolveCatalogItem(navyItems, "WEAPON_REVOLVER_NAVY").name, "Navy Revolver");

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

const completeStorageCount = selectLatestCounts({
  location: "Storage",
  inventory: {
    materials: [{ ingredient: "Iron", storageCount: 20 }],
    storage: [
      { ingredient: "Iron", storageCount: 25 },
      { ingredient: "Navy Revolver", storageCount: 2 }
    ]
  },
  operations: []
});
assert.equal(completeStorageCount.get("iron"), 25, "the complete storage snapshot must take precedence over materials-only data");
assert.equal(completeStorageCount.get("navy revolver"), 2, "counted finished goods in storage must be preserved");

const completeStorefrontCount = selectLatestCounts({
  location: "Storefront",
  inventory: {
    products: [{ itemName: "Navy Revolver", currentStock: 2 }],
    storefront: [
      { itemName: "Navy Revolver", itemType: "product", currentStock: 2 },
      { itemName: "Native Ore", itemType: "material", currentStock: 5 }
    ]
  },
  operations: []
});
assert.equal(completeStorefrontCount.get("native ore"), 5, "reviewed materials in the storefront must remain countable");

const pendingTransferStorefront = selectLatestCounts({
  location: "Storefront",
  inventory: { products: [{ itemName: "Navy Revolver", currentStock: 5, countedAt: "2026-07-13T10:00:00.000Z" }] },
  snapshotGeneratedAt: "2026-07-13T10:00:30.000Z",
  operations: [{
    kind: "Storefront Transfer",
    itemName: "Navy Revolver",
    quantity: 2,
    createdAt: "2026-07-13T10:01:00.000Z",
    syncStatus: "Pending sheet sync"
  }]
});
assert.equal(pendingTransferStorefront.get("navy revolver"), 7, "a pending storefront transfer must appear immediately");

const pendingTransferStorage = selectLatestCounts({
  location: "Storage",
  inventory: { storage: [{ ingredient: "Navy Revolver", storageCount: 1, countedAt: "2026-07-13T10:00:00.000Z" }] },
  snapshotGeneratedAt: "2026-07-13T10:00:30.000Z",
  operations: [{
    kind: "Storefront Transfer",
    itemName: "Navy Revolver",
    quantity: 2,
    createdAt: "2026-07-13T10:01:00.000Z",
    syncStatus: "Pending sheet sync"
  }]
});
assert.equal(pendingTransferStorage.get("navy revolver"), 0, "a pending storefront transfer must reduce storage without going negative");

const pendingProductionAndPurchase = selectLatestCounts({
  location: "Storage",
  inventory: { materials: [{ ingredient: "Iron", storageCount: 20, countedAt: "2026-07-13T10:00:00.000Z" }] },
  snapshotGeneratedAt: "2026-07-13T10:00:30.000Z",
  operations: [
    { kind: "P2P Purchase", itemName: "Iron", quantity: 3, createdAt: "2026-07-13T10:02:00.000Z", syncStatus: "Pending sheet sync" },
    { kind: "Production Use", itemName: "Iron", quantity: 5, createdAt: "2026-07-13T10:01:00.000Z", syncStatus: "Pending sheet sync" }
  ]
});
assert.equal(pendingProductionAndPurchase.get("iron"), 18, "production and P2P stock movements must be applied in order");

const pendingProductionOutput = selectLatestCounts({
  location: "Storage",
  inventory: { storage: [{ ingredient: "Navy Revolver", storageCount: 1, countedAt: "2026-07-13T10:00:00.000Z" }] },
  snapshotGeneratedAt: "2026-07-13T10:00:30.000Z",
  operations: [
    { kind: "Production Output", itemName: "Navy Revolver", quantity: 2, createdAt: "2026-07-13T10:01:00.000Z", syncStatus: "Pending sheet sync" }
  ]
});
assert.equal(pendingProductionOutput.get("navy revolver"), 3, "customer production output must remain Storage-only");
const productionOutputStorefront = selectLatestCounts({
  location: "Storefront",
  inventory: { products: [{ itemName: "Navy Revolver", currentStock: 1, countedAt: "2026-07-13T10:00:00.000Z" }] },
  snapshotGeneratedAt: "2026-07-13T10:00:30.000Z",
  operations: [
    { kind: "Production Output", itemName: "Navy Revolver", quantity: 2, createdAt: "2026-07-13T10:01:00.000Z", syncStatus: "Pending sheet sync" }
  ]
});
assert.equal(productionOutputStorefront.get("navy revolver"), 1, "production output must never change Storefront stock");

const snapshotBoundary = selectLatestCounts({
  location: "Storage",
  inventory: { materials: [{ ingredient: "Iron", storageCount: 20, countedAt: "2026-07-13T10:00:00.000Z" }] },
  snapshotGeneratedAt: "2026-07-13T10:20:00.000Z",
  operations: [
    { kind: "P2P Purchase", itemName: "Iron", quantity: 4, createdAt: "2026-07-13T10:05:00.000Z", syncedAt: "2026-07-13T10:19:00.000Z", syncStatus: "Synced" },
    { kind: "P2P Purchase", itemName: "Iron", quantity: 3, createdAt: "2026-07-13T10:06:00.000Z", syncedAt: "2026-07-13T10:21:00.000Z", syncStatus: "Synced" }
  ]
});
assert.equal(snapshotBoundary.get("iron"), 23, "only synced operations newer than the snapshot may be applied locally");

const countResetsMovements = selectLatestCounts({
  location: "Storage",
  inventory: { materials: [{ ingredient: "Iron", storageCount: 20, countedAt: "2026-07-13T10:00:00.000Z" }] },
  snapshotGeneratedAt: "2026-07-13T10:00:30.000Z",
  operations: [
    { kind: "Correction Out", itemName: "Iron", quantity: 2, createdAt: "2026-07-13T10:04:00.000Z", syncStatus: "Pending sheet sync" },
    { kind: "Stock Count", location: "Storage", itemName: "Iron", quantity: 50, createdAt: "2026-07-13T10:03:00.000Z", syncStatus: "Pending sheet sync" },
    { kind: "Production Use", itemName: "Iron", quantity: 5, createdAt: "2026-07-13T10:02:00.000Z", syncStatus: "Pending sheet sync" }
  ]
});
assert.equal(countResetsMovements.get("iron"), 48, "a count must reset earlier movements while later movements continue from it");

const ledgerWithPendingMovement = selectCurrentLedger({
  ledger: {
    balance: 1000,
    countedBalance: 900,
    countedAt: "2026-07-13T10:00:00.000Z",
    netMovementSinceCount: 100,
    lastActivityAt: "2026-07-13T10:15:00.000Z"
  },
  snapshotGeneratedAt: "2026-07-13T10:20:00.000Z",
  operations: [
    { kind: "Cash In", amount: 50, createdAt: "2026-07-13T10:21:00.000Z", syncStatus: "Pending sheet sync" },
    { kind: "Cash In", amount: 25, createdAt: "2026-07-13T10:05:00.000Z", syncedAt: "2026-07-13T10:21:00.000Z", syncStatus: "Synced" },
    { kind: "Cash In", amount: 500, createdAt: "2026-07-13T10:10:00.000Z", syncStatus: "Synced" }
  ]
});
assert.equal(ledgerWithPendingMovement.balance, 1075, "only cash movements not represented by the snapshot may be applied locally");
assert.equal(ledgerWithPendingMovement.netMovementSinceCount, 175);

const ledgerWithLocalCount = selectCurrentLedger({
  ledger: { balance: 1000, countedBalance: 900, netMovementSinceCount: 100 },
  snapshotGeneratedAt: "2026-07-13T10:20:00.000Z",
  operations: [
    { kind: "Cash Out", amount: 200, createdAt: "2026-07-13T10:22:00.000Z", syncStatus: "Pending sheet sync" },
    { kind: "Ledger Count", amount: 1200, createdAt: "2026-07-13T10:21:00.000Z", syncStatus: "Pending sheet sync" }
  ]
});
assert.equal(ledgerWithLocalCount.balance, 1000, "a newer local ledger count must reset the balance before later movements");
assert.equal(ledgerWithLocalCount.countedBalance, 1200);
assert.equal(ledgerWithLocalCount.netMovementSinceCount, -200);

const payrollLedger = selectCurrentLedger({
  ledger: { balance: 1000 },
  snapshotGeneratedAt: "2026-07-13T10:20:00.000Z",
  operations: [
    { kind: "Payroll Payment", amount: 150, paymentMethod: "Ledger", createdAt: "2026-07-13T10:21:00.000Z", syncStatus: "Pending sheet sync" },
    { kind: "Payroll Payment", amount: 300, paymentMethod: "Cash", createdAt: "2026-07-13T10:22:00.000Z", syncStatus: "Pending sheet sync" }
  ]
});
assert.equal(payrollLedger.balance, 850, "ledger payroll must reduce the ledger while cash payroll remains separate");

const correctedLedger = selectCurrentLedger({
  ledger: { balance: 1000 },
  snapshotGeneratedAt: "2026-07-13T10:20:00.000Z",
  operations: [
    { kind: "Correction", amount: -35, createdAt: "2026-07-13T10:21:00.000Z", syncStatus: "Pending sheet sync" },
    { kind: "Correction", amount: 10, createdAt: "2026-07-13T10:22:00.000Z", syncStatus: "Pending sheet sync" }
  ]
});
assert.equal(correctedLedger.balance, 975, "signed corrections must support both additions and deductions");

console.log("Inventory count precedence checks passed.");
