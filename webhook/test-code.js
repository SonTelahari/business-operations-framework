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

const writes = {};
function fakeSheet(name) {
  writes[name] = [];
  return {
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
  "Cash Ledger Counts": fakeSheet("Cash Ledger Counts")
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
