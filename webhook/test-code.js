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

function dataSheet(rows) {
  return {
    getLastRow: () => rows.length + 1,
    getRange: () => ({ getValues: () => rows })
  };
}

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

console.log("Apps Script reconciliation checks passed.");
