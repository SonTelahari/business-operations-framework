const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "Code.gs"), "utf8");
const context = vm.createContext({
  console,
  Utilities: {
    getUuid: () => "generated-id",
    formatDate: date => date.toISOString()
  }
});
vm.runInContext(source, context);

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

const normalized = plain(context.normalizeEvent({
  event_type: "Sale",
  direction: "Stock Out",
  item_name: "Navy Revolver",
  quantity: 1,
  unit_price: 100,
  current_item_total: 0,
  shop_ledger: 0,
  timestamp: "2026-07-15T10:20:30.000Z",
  webhook_id: "control-zero"
}));
assert.equal(normalized.currentItemTotal, 0, "a reported zero stock total must remain an absolute control");
assert.equal(normalized.ledgerBalance, 0, "a reported zero ledger must remain an absolute control");
assert.equal(context.eventDate(normalized).toISOString(), "2026-07-15T10:20:30.000Z");

const reviewEvent = plain(context.normalizeEvent({
  event_type: "Sale",
  direction: "Stock Out",
  proposed_item_name: "Unknown Custom Navy",
  proposed_quantity: 5,
  unit_price: 105,
  review_required: true,
  review_reason: "unknown_item",
  discord_item_label: "Unknown Custom Navy",
  webhook_id: "review-1"
}));
assert.equal(reviewEvent.item, "Unknown Custom Navy");
assert.equal(reviewEvent.qty, 5);
assert.equal(reviewEvent.reviewRequired, true);
assert.equal(reviewEvent.reviewReason, "unknown_item");

const reviewedProduct = plain(context.normalizeReviewedProduct({
  name: "Antique High Roller Revolver",
  label: "High Roller Revolver",
  tag: "WEAPON_REVOLVER_HIGHROLLER",
  category: "Revolvers",
  price: 135
}));
assert.deepEqual(reviewedProduct, {
  name: "Antique High Roller Revolver",
  label: "High Roller Revolver",
  tag: "WEAPON_REVOLVER_HIGHROLLER",
  category: "Revolvers",
  price: 135
});
assert.throws(
  () => context.normalizeReviewedProduct({ name: "Incomplete", label: "", tag: "", price: 10 }),
  /requires a product name/
);
assert.throws(
  () => context.normalizeReviewedProduct({ name: "Bad Price", label: "Bad Price", tag: "bad", price: -1 }),
  /non-negative/
);
const existingProductsSheet = dataSheet([[
  "Existing Revolver", "Existing Revolver", "WEAPON_REVOLVER_EXISTING", "Revolvers", 90,
  0, 0, 0, true, 90, 90, "MSRP"
]]);
const existingReviewedProduct = plain(context.ensureReviewedProduct({
  getSheetByName: name => name === "Products" ? existingProductsSheet : null
}, {
  name: "Existing Revolver",
  label: "Existing Revolver",
  tag: "WEAPON_REVOLVER_EXISTING",
  category: "Revolvers",
  price: 90
}));
assert.equal(existingReviewedProduct.created, false, "an identical retry must reuse the existing product");
assert.throws(() => context.ensureReviewedProduct({
  getSheetByName: name => name === "Products" ? existingProductsSheet : null
}, {
  name: "Other Revolver",
  label: "Other Revolver",
  tag: "WEAPON_REVOLVER_EXISTING",
  category: "Revolvers",
  price: 95
}), /game item tag already belongs/);
assert.equal(context.reviewedProductInitialStock({
  direction: "Stock In",
  qty: 3,
  currentItemTotal: null
}), 3);
assert.equal(context.reviewedProductInitialStock({
  direction: "Stock Out",
  qty: 2,
  currentItemTotal: null
}), 0);
assert.equal(context.reviewedProductInitialStock({
  direction: "Stock Out",
  qty: 2,
  currentItemTotal: 7
}), 7);

const writes = {};
function fakeSheet(name) {
  writes[name] = [];
  return {
    getLastRow: () => 1,
    getMaxRows: () => 10,
    insertRowsAfter: () => {},
    getRange(row, column, rowCount = 1) {
      return {
        getValues: () => Array.from({ length: rowCount }, () => [""]),
        setValues(values) {
          writes[name].push({ row, column, values });
          return this;
        },
        setNumberFormat() {
          return this;
        }
      };
    }
  };
}

const sheets = {
  "Stock Counts": fakeSheet("Stock Counts"),
  "Cash Ledger Counts": fakeSheet("Cash Ledger Counts"),
  "Manual Movements": fakeSheet("Manual Movements")
};
const controlResult = plain(context.writeWebhookControls({
  getSheetByName: name => sheets[name] || null
}, normalized));
assert.deepEqual(controlResult, { stock: true, ledger: true });
assert.equal(writes["Stock Counts"][0].values[0][3], 0);
assert.equal(writes["Cash Ledger Counts"][0].values[0][2], 0);
assert.equal(writes["Stock Counts"][0].values[0][0].toISOString(), "2026-07-15T10:20:30.000Z");
const stockWritesBeforeLedgerOnly = writes["Stock Counts"].length;
const ledgerOnlyResult = plain(context.writeWebhookControls({
  getSheetByName: name => sheets[name] || null
}, normalized, { stock: false, ledger: true }));
assert.deepEqual(ledgerOnlyResult, { stock: false, ledger: true });
assert.equal(writes["Stock Counts"].length, stockWritesBeforeLedgerOnly);

const positiveCorrection = plain(context.normalizeManualMovement({ kind: "Correction", amount: 12.5 }));
const negativeCorrection = plain(context.normalizeManualMovement({ kind: "Correction", amount: -7.5 }));
assert.equal(positiveCorrection.type, "Sale");
assert.equal(positiveCorrection.unitPrice, 12.5);
assert.equal(negativeCorrection.type, "Purchase");
assert.equal(negativeCorrection.unitPrice, 7.5);
const ownerDeposit = plain(context.normalizeManualMovement({ kind: "Owner Capital Deposit", amount: 500 }));
const ownerWithdrawal = plain(context.normalizeManualMovement({ kind: "Owner Withdrawal", amount: 50 }));
const safekeepingDeposit = plain(context.normalizeManualMovement({ kind: "Safekeeping Deposit", amount: 200 }));
assert.deepEqual(ownerDeposit, {
  type: "Owner Capital", direction: "Cash In", item: "William Owner Capital", quantity: 1, unitPrice: 500
});
assert.equal(ownerWithdrawal.direction, "Cash Out");
assert.equal(safekeepingDeposit.type, "Safekeeping");
assert.equal(safekeepingDeposit.direction, "Cash In");
const productionOutput = plain(context.normalizeManualMovement({
  kind: "Production Output",
  itemName: "Navy Revolver",
  quantity: 2
}));
assert.deepEqual(productionOutput, {
  type: "Storage Movement", direction: "Storage In", item: "Navy Revolver", quantity: 2, unitPrice: 0
});
context.writeManualMovement({
  getSheetByName: name => sheets[name] || null
}, {
  id: "production-output-row",
  kind: "Production Output",
  location: "Storage",
  itemName: "Navy Revolver",
  quantity: 2,
  employee: "Test Worker"
}, "manual_operation");
assert.equal(writes["Manual Movements"][0].values[0][2], "Storage Movement");
assert.equal(writes["Manual Movements"][0].values[0][7], 0, "production output must not feed the storefront signed-quantity formula");

assert.equal(context.manualStockDelta(
  [new Date(), "", "Adjustment", "Transfer to Storefront", "Iron", 5, 0, 0, 0, "GUI type: Storefront Transfer"],
  "storefront"
), 5);
assert.equal(context.manualStockDelta(
  [new Date(), "", "Adjustment", "Transfer to Storefront", "Iron", 5, 0, 0, 0, "GUI type: Storefront Transfer"],
  "storage"
), -5);
assert.equal(context.manualStockDelta(
  [new Date(), "", "Sale", "Stock Out", "Ledger Adjustment", 1, 12.5, 0, 12.5, "GUI type: Correction"],
  "storage"
), 0);
assert.equal(context.manualStockDelta(
  [new Date(), "", "Storage Movement", "Storage In", "Navy Revolver", 2, 0, 0, 0, "GUI type: Production Output"],
  "storage"
), 2);
assert.equal(context.manualStockDelta(
  [new Date(), "", "Storage Movement", "Storage In", "Navy Revolver", 2, 0, 0, 0, "GUI type: Production Output"],
  "storefront"
), 0);

const ledgerAfterCashOut = plain(context.readLedgerSnapshot({
  getSheetByName(name) {
    if (name === "Cash Ledger Counts") {
      return dataSheet([[new Date("2026-07-15T23:44:00.000Z"), "Store Ledger", 1094.25]]);
    }
    if (name === "Transactions") {
      return dataSheet([[new Date("2026-07-15T23:44:00.000Z"), "", "Sale", "Stock Out", "Revolver Ammo Express", 5, 2.25]]);
    }
    if (name === "Manual Movements") {
      return dataSheet([[new Date("2026-07-15T23:50:00.000Z"), "", "Purchase", "Stock Out", "Ledger Adjustment", 1, 94.25]]);
    }
    if (name === "Payroll Payments") return dataSheet([]);
    return null;
  }
}));
assert.equal(ledgerAfterCashOut.countedBalance, 1094.25);
assert.equal(ledgerAfterCashOut.netMovementSinceCount, -94.25);
assert.equal(ledgerAfterCashOut.balance, 1000, "cash taken after the latest storefront ledger control must reduce the displayed balance");

function dataSheet(rows) {
  return {
    getLastRow: () => rows.length + 1,
    getRange: () => ({ getValues: () => rows })
  };
}

const financeSheets = {
  "Transactions": dataSheet([
    [new Date("2026-07-10T10:00:00.000Z"), "Still Water Discord", "Sale", "Stock Out", "Navy Revolver", 1, 100, -1, 100, 1100, "sale-finance"],
    [new Date("2026-07-11T10:00:00.000Z"), "Still Water Discord", "Purchase", "Purchase", "Nitrite", 20, 1, 20, -20, 1080, "purchase-finance"]
  ]),
  "Manual Movements": dataSheet([
    [new Date("2026-07-12T10:00:00.000Z"), "Still Water GUI", "Sale", "Stock Out", "P2P Sale", 1, 30, 0, 30, "GUI type: P2P Sale"],
    [new Date("2026-07-13T10:00:00.000Z"), "Still Water GUI", "Purchase", "Purchase", "Operating Cost", 1, 10, 0, -10, "GUI type: Cash Out"],
    [new Date("2026-07-14T10:00:00.000Z"), "Still Water GUI", "Owner Capital", "Cash In", "William Owner Capital", 1, 500, 0, 500, "GUI type: Owner Capital Deposit"],
    [new Date("2026-07-15T10:00:00.000Z"), "Still Water GUI", "Owner Capital", "Cash Out", "William Owner Capital", 1, 50, 0, -50, "GUI type: Owner Withdrawal"],
    [new Date("2026-07-16T10:00:00.000Z"), "Still Water GUI", "Safekeeping", "Cash In", "William Safekeeping Funds", 1, 200, 0, 200, "GUI type: Safekeeping Deposit"],
    [new Date("2026-07-17T10:00:00.000Z"), "Still Water GUI", "Safekeeping", "Cash Out", "William Safekeeping Funds", 1, 25, 0, -25, "GUI type: Safekeeping Withdrawal"],
    [new Date("2026-07-18T10:00:00.000Z"), "Still Water GUI", "Sale", "Stock Out", "Ledger Adjustment", 1, 50, 0, 50, "GUI type: Correction"]
  ]),
  "Payroll Payments": dataSheet([
    [new Date("2026-07-19T10:00:00.000Z"), "Employee", "2026-07-01", "2026-07-15", 15, "Ledger", "", "", "payroll-finance"]
  ]),
  "Cash Ledger Counts": dataSheet([
    [new Date("2026-07-01T00:00:00.000Z"), "Store Ledger", 1000]
  ])
};
context.SpreadsheetApp = {
  openById: () => ({
    getSpreadsheetTimeZone: () => "Europe/Oslo",
    getSheetByName: name => financeSheets[name] || null
  })
};
const finance = plain(context.readFinanceSnapshot({ from: "2026-07-01", to: "2026-07-31" }));
assert.deepEqual(finance.totals, { revenue: 130, expenses: 45, profit: 85 });
assert.deepEqual(finance.coverage, {
  transactionsScanned: 2,
  storefrontSales: 1,
  storefrontPurchases: 1,
  manualMovementsScanned: 7,
  manualEntries: 6,
  ownerFundEntries: 2,
  safekeepingEntries: 2,
  payrollPayments: 1
});
assert.equal(finance.balances.ownerCapitalDeposits, 500);
assert.equal(finance.balances.ownerWithdrawals, 50);
assert.equal(finance.balances.ownerCapital, 450);
assert.equal(finance.balances.safekeepingDeposits, 200);
assert.equal(finance.balances.safekeepingWithdrawals, 25);
assert.equal(finance.balances.safekeeping, 175);
assert.equal(finance.ledger.balance, 1760);
assert(finance.breakdown.some(row => row.category === "Storefront Sales" && row.amount === 100));
assert(finance.breakdown.some(row => row.category === "P2P Sales" && row.amount === 30));
assert(finance.breakdown.some(row => row.category === "Operating Expenses" && row.amount === 10));
assert(finance.breakdown.some(row => row.category === "Payroll" && row.amount === 15));
assert.equal(finance.breakdown.some(row => row.label === "Ledger Adjustment"), false, "corrections must not distort operating P&L");
assert.deepEqual(finance.monthly, [{ month: "2026-07", revenue: 130, expenses: 45, profit: 85 }]);
assert.equal(context.financeRowAmount(["", "", "Sale", "Stock Out", "Navy Revolver", 1, 0, -1, 105]), 105);

const mappedReviewEvent = plain(context.applyStoredItemMapping({
  getSheetByName(name) {
    if (name !== "Webhook Item Mappings") return null;
    return dataSheet([["Unknown Custom Navy", "Remington Custom", "Navy Crossover Revolver"]]);
  }
}, {
  ...reviewEvent,
  discordItemName: "Unknown Custom Navy",
  discordItemLabel: "Remington Custom"
}));
assert.equal(mappedReviewEvent.item, "Navy Crossover Revolver");
assert.equal(mappedReviewEvent.reviewRequired, false);
assert.equal(mappedReviewEvent.reviewReason, "");

const exceptionSnapshot = plain(context.readWebhookExceptions({
  getSheetByName(name) {
    if (name !== "Webhook Exceptions") return null;
    return dataSheet([[
      new Date("2026-07-15T10:00:00.000Z"), "review-1", "Open", "unknown_item", "Bought Item",
      "", "Unknown Custom Navy", "Sale", "Stock Out", 5, 105, 1094.25, 5, "", "", "", "",
      JSON.stringify({ raw_payload: "Item label: Unknown Custom Navy" }), false
    ]]);
  }
}));
assert.equal(exceptionSnapshot[0].webhookId, "review-1");
assert.equal(exceptionSnapshot[0].rawText, "Item label: Unknown Custom Navy");

const uncountedMovements = plain(context.readStockMovementDeltas({
  getSheetByName(name) {
    if (name === "Transactions") {
      return dataSheet([["2026-07-15T10:00:00.000Z", "", "Stocking Movement", "Stock In", "Navy Revolver", 5]]);
    }
    if (name === "Manual Movements") {
      return dataSheet([["2026-07-15T10:01:00.000Z", "", "Adjustment", "Transfer to Storefront", "Navy Revolver", 2, 0, 0, 0, "GUI type: Storefront Transfer"]]);
    }
    return null;
  }
}, "Storefront", {}));
assert.equal(uncountedMovements.deltas["navy revolver"], 2, "manual transfers must adjust products without a count baseline");

const controlledMovements = plain(context.readStockMovementDeltas({
  getSheetByName(name) {
    if (name === "Transactions") {
      return dataSheet([
        ["2026-07-15T10:00:00.000Z", "", "Sale", "Stock Out", "Navy Revolver", 1],
        ["2026-07-15T10:02:00.000Z", "", "Sale", "Stock Out", "Navy Revolver", 1]
      ]);
    }
    if (name === "Manual Movements") {
      return dataSheet([["2026-07-15T10:03:00.000Z", "", "Adjustment", "Transfer to Storefront", "Navy Revolver", 2, 0, 0, 0, "GUI type: Storefront Transfer"]]);
    }
    return null;
  }
}, "Storefront", {
  "navy revolver": { quantity: 8, sortTime: Date.parse("2026-07-15T10:00:00.000Z") }
}));
assert.equal(controlledMovements.deltas["navy revolver"], 1, "the control event must be excluded while later movements continue");

const buyOrderPurchases = plain(context.readBuyOrderPurchases({
  getSheetByName(name) {
    if (name !== "Transactions") return null;
    return dataSheet([
      [new Date("2026-07-15T10:00:00.000Z"), "", "Purchase", "Purchase", "Nitrite", 25, 1, 25, -25, "", "purchase-1"],
      [new Date("2026-07-15T10:01:00.000Z"), "", "Sale", "Stock Out", "Navy Revolver", 1, 105, -1, 105, "", "sale-1"]
    ]);
  }
}));
assert.deepEqual(buyOrderPurchases, [{
  eventId: "purchase-1",
  occurredAt: "2026-07-15T10:00:00.000Z",
  itemName: "Nitrite",
  quantity: 25,
  unitPrice: 1
}]);

console.log("Apps Script reconciliation checks passed.");
