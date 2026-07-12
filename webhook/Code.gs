const SPREADSHEET_ID = '1TzMlaDaZuRmK8N_A0ZRACoHyU36DR2U-k_YgLqIuU1Y';
const RAW_SHEET = 'Raw Webhook Log';
const TRANSACTION_SHEET = 'Transactions';
const MANUAL_MOVEMENT_SHEET = 'Manual Movements';
const STOCK_COUNTS_SHEET = 'Stock Counts';
const CASH_COUNTS_SHEET = 'Cash Ledger Counts';
const PRODUCTS_SHEET = 'Products';
const TIME_CLOCK_SHEET = 'Timesheet';
const PAYROLL_PAYMENT_SHEET = 'Payroll Payments';
const SOURCE_NAME = 'Discord Bridge - Still Water';
const GUI_SOURCE_NAME = 'Frontier GUI - Still Water';
const TIMESTAMP_FORMAT = 'dd.mm.yyyy hh:mm';

function doGet(e) {
  if (e && e.parameter && e.parameter.action === 'bootstrap') {
    return jsonResponse(readWorkbookSnapshot());
  }

  return jsonResponse({
    ok: true,
    service: 'Frontier Firearms - Still Water webhook receiver',
    expectedMethod: 'POST',
    readActions: ['bootstrap']
  });
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);

  try {
    const payload = parsePayload(e);
    if (payload.source === 'frontier-gui') {
      return jsonResponse(writeGuiPayload(payload));
    }

    const event = normalizeEvent(payload);

    const spreadsheet = SpreadsheetApp.openById(SPREADSHEET_ID);
    const rawSheet = spreadsheet.getSheetByName(RAW_SHEET);
    const transactionSheet = spreadsheet.getSheetByName(TRANSACTION_SHEET);

    if (!rawSheet || !transactionSheet) {
      throw new Error('Required sheet tabs are missing.');
    }

    if (event.webhookId && alreadyProcessed(rawSheet, event.webhookId)) {
      return jsonResponse({
        ok: true,
        duplicate: true,
        webhookId: event.webhookId
      });
    }

    rawSheet.appendRow([
      new Date(),
      event.webhookId,
      event.type,
      event.direction,
      event.item,
      event.qty,
      event.unitPrice,
      event.actor,
      event.orderId,
      JSON.stringify(payload)
    ]);
    formatTimestampCell(rawSheet, rawSheet.getLastRow());

    if (event.item && event.qty) {
      writeTransaction(transactionSheet, event);
    }

    return jsonResponse({
      ok: true,
      webhookId: event.webhookId,
      transactionWritten: Boolean(event.item && event.qty)
    });
  } catch (error) {
    return jsonResponse({
      ok: false,
      error: error.message
    });
  } finally {
    lock.releaseLock();
  }
}

function writeGuiPayload(payload) {
  const spreadsheet = SpreadsheetApp.openById(SPREADSHEET_ID);
  const action = String(payload.action || '');

  if (action === 'manual_operation') {
    return writeManualOperation(spreadsheet, payload.entry || {}, action);
  }

  if (action === 'stock_target') {
    return writeStockTarget(spreadsheet, payload.target || {}, action);
  }

  if (action === 'time_clock') {
    return writeTimeClockEntry(spreadsheet, payload.entry || {}, action);
  }

  throw new Error('Unknown GUI action: ' + action);
}

function writeManualOperation(spreadsheet, entry, action) {
  const kind = String(entry.kind || '');
  if (!entry.id) throw new Error('Manual operation is missing an entry ID.');

  if (kind === 'Stock Count') {
    const sheet = requireSheet(spreadsheet, STOCK_COUNTS_SHEET);
    if (alreadyRecordedInColumn(sheet, 8, entry.id)) {
      return { ok: true, duplicate: true, action, entryId: entry.id };
    }

    const row = firstEmptyRow(sheet, 2, 1);
    const note = joinNotes(entry.note, entry.employee ? 'Counted by ' + entry.employee : '', guiReference(entry.id));
    sheet.getRange(row, 1, 1, 4).setValues([[
      new Date(),
      entry.location || 'Other',
      entry.itemName || entry.itemLabel || '',
      numberOrZero(entry.quantity)
    ]]);
    sheet.getRange(row, 7, 1, 2).setValues([[false, note]]);
    formatTimestampCell(sheet, row);
    return { ok: true, action, entryId: entry.id, sheet: STOCK_COUNTS_SHEET, row };
  }

  if (kind === 'Ledger Count') {
    const sheet = requireSheet(spreadsheet, CASH_COUNTS_SHEET);
    if (alreadyRecordedInColumn(sheet, 7, entry.id)) {
      return { ok: true, duplicate: true, action, entryId: entry.id };
    }

    const row = firstEmptyRow(sheet, 2, 1);
    const note = joinNotes(entry.note, entry.employee ? 'Counted by ' + entry.employee : '', guiReference(entry.id));
    sheet.getRange(row, 1, 1, 3).setValues([[
      new Date(),
      entry.location === 'Ledger' ? 'Store Ledger' : (entry.location || 'Store Ledger'),
      numberOrZero(entry.amount)
    ]]);
    sheet.getRange(row, 6, 1, 2).setValues([[false, note]]);
    formatTimestampCell(sheet, row);
    return { ok: true, action, entryId: entry.id, sheet: CASH_COUNTS_SHEET, row };
  }

  if (kind === 'Payroll Payment') {
    return writePayrollPayment(spreadsheet, entry, action);
  }

  return writeManualMovement(spreadsheet, entry, action);
}

function writePayrollPayment(spreadsheet, entry, action) {
  const sheet = requireSheet(spreadsheet, PAYROLL_PAYMENT_SHEET);
  if (alreadyRecordedInColumn(sheet, 7, entry.id)) {
    return { ok: true, duplicate: true, action, entryId: entry.id };
  }
  if (!entry.payee || !entry.payPeriodStart || !entry.payPeriodEnd || numberOrZero(entry.amount) <= 0) {
    throw new Error('Payroll payment requires an employee, pay period, and positive amount.');
  }

  const row = firstEmptyRow(sheet, 2, 1);
  sheet.getRange(row, 1, 1, 9).setValues([[
    new Date(),
    entry.payee,
    entry.payPeriodStart,
    entry.payPeriodEnd,
    numberOrZero(entry.amount),
    entry.paymentMethod || 'Ledger',
    joinNotes(entry.reference, guiReference(entry.id)),
    entry.note || '',
    entry.employee || GUI_SOURCE_NAME
  ]]);
  formatTimestampCell(sheet, row);
  return { ok: true, action, entryId: entry.id, sheet: PAYROLL_PAYMENT_SHEET, row };
}

function writeManualMovement(spreadsheet, entry, action) {
  const sheet = requireSheet(spreadsheet, MANUAL_MOVEMENT_SHEET);
  if (alreadyRecordedInColumn(sheet, 12, entry.id)) {
    return { ok: true, duplicate: true, action, entryId: entry.id };
  }

  const movement = normalizeManualMovement(entry);
  const row = firstEmptyRow(sheet, 2, 1);
  sheet.getRange(row, 1, 1, 7).setValues([[
    new Date(),
    GUI_SOURCE_NAME,
    movement.type,
    movement.direction,
    movement.item,
    movement.quantity,
    movement.unitPrice
  ]]);
  sheet.getRange(row, 10, 1, 3).setValues([[
    joinNotes(
      entry.note,
      entry.kind && entry.kind !== movement.type ? 'GUI type: ' + entry.kind : '',
      String(entry.kind || '').includes('Transfer') ? 'Transferred qty: ' + numberOrZero(entry.quantity) : ''
    ),
    entry.employee || '',
    entry.id
  ]]);
  formatTimestampCell(sheet, row);
  return { ok: true, action, entryId: entry.id, sheet: MANUAL_MOVEMENT_SHEET, row };
}

function normalizeManualMovement(entry) {
  const kind = String(entry.kind || 'Correction');
  const quantity = Math.max(0, numberOrZero(entry.quantity));
  const totalAmount = Math.abs(numberOrZero(entry.amount));
  const item = entry.itemName || entry.itemLabel || (kind === 'Payroll Payout' ? 'Payroll Payout' : 'Ledger Adjustment');
  const stockQuantity = item === 'Ledger Adjustment' || item === 'Payroll Payout' ? 1 : quantity;
  const unitPrice = stockQuantity ? totalAmount / stockQuantity : 0;

  if (kind === 'P2P Sale' || kind === 'Cash In') {
    return { type: 'Sale', direction: 'Stock Out', item, quantity: stockQuantity, unitPrice };
  }
  if (kind === 'P2P Purchase' || kind === 'Cash Out' || kind === 'Payroll Payout') {
    return { type: 'Purchase', direction: 'Purchase', item, quantity: stockQuantity, unitPrice };
  }
  if (kind === 'Production Use' || kind === 'Correction Out') {
    return { type: 'Stocking Movement', direction: 'Stock Out', item, quantity, unitPrice: 0 };
  }
  if (kind === 'Storefront Transfer' || kind === 'Storage Transfer') {
    return { type: 'Adjustment', direction: 'Stock In', item, quantity: 0, unitPrice: 0 };
  }
  return { type: 'Adjustment', direction: 'Stock In', item, quantity, unitPrice: 0 };
}

function writeStockTarget(spreadsheet, target, action) {
  const sheet = requireSheet(spreadsheet, PRODUCTS_SHEET);
  const itemName = String(target.itemName || target.itemLabel || '');
  if (!itemName) throw new Error('Stock target is missing an item name.');

  const row = findRowByValue(sheet, 1, itemName);
  if (!row) throw new Error('Product not found for stock target: ' + itemName);
  sheet.getRange(row, 6).setValue(numberOrZero(target.target));
  return { ok: true, action, itemName, sheet: PRODUCTS_SHEET, row };
}

function writeTimeClockEntry(spreadsheet, entry, action) {
  const sheet = requireSheet(spreadsheet, TIME_CLOCK_SHEET);
  if (!entry.id || !entry.employee || !entry.clockIn) {
    throw new Error('Time clock entry requires an ID, employee, and clock-in time.');
  }

  const existingRow = findRowByValue(sheet, 1, entry.id);
  const row = existingRow || firstEmptyRow(sheet, 2, 1);
  sheet.getRange(row, 1, 1, 4).setValues([[
    entry.id,
    entry.employee,
    toLocalDateTimeText(entry.clockIn),
    entry.clockOut ? toLocalDateTimeText(entry.clockOut) : ''
  ]]);

  if (!existingRow) {
    sheet.getRange(row, 9).setValue(false);
    sheet.getRange(row, 12).setValue(GUI_SOURCE_NAME);
  }

  return { ok: true, action, entryId: entry.id, updated: Boolean(existingRow), sheet: TIME_CLOCK_SHEET, row };
}

function requireSheet(spreadsheet, name) {
  const sheet = spreadsheet.getSheetByName(name);
  if (!sheet) throw new Error('Required sheet tab is missing: ' + name);
  return sheet;
}

function findRowByValue(sheet, column, value) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return 0;
  const values = sheet.getRange(2, column, lastRow - 1, 1).getDisplayValues();
  const wanted = String(value);
  const offset = values.findIndex(row => String(row[0]) === wanted);
  return offset === -1 ? 0 : offset + 2;
}

function alreadyRecordedInColumn(sheet, column, entryId) {
  if (!entryId) return false;
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return false;
  return sheet.getRange(2, column, lastRow - 1, 1).getDisplayValues()
    .some(row => String(row[0] || '').includes(String(entryId)));
}

function numberOrZero(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function guiReference(entryId) {
  return '[GUI ' + entryId + ']';
}

function joinNotes() {
  return Array.prototype.slice.call(arguments).filter(Boolean).join(' | ');
}

function toLocalDateTimeText(value) {
  const date = new Date(value);
  if (isNaN(date.getTime())) return String(value || '');
  return Utilities.formatDate(date, 'Europe/Oslo', "yyyy-MM-dd'T'HH:mm:ss");
}

function parsePayload(e) {
  if (e && e.postData && e.postData.contents) {
    const text = e.postData.contents;
    try {
      return JSON.parse(text);
    } catch (error) {
      return { raw_body: text };
    }
  }

  if (e && e.parameter) {
    return e.parameter;
  }

  return {};
}

function normalizeEvent(payload) {
  const rawType = firstValue(payload, ['event_type', 'type', 'action', 'event']);
  const type = normalizeType(rawType);
  const direction = normalizeDirection(
    firstValue(payload, ['direction', 'movement', 'stock_direction']),
    type
  );

  return {
    webhookId: String(firstValue(payload, ['webhook_id', 'id', 'event_id', 'discord_message_id', 'order_id', 'buy_order_id', 'receipt_id']) || Utilities.getUuid()),
    type,
    direction,
    item: String(firstValue(payload, ['item_name', 'item', 'name', 'product', 'product_name']) || ''),
    qty: Number(firstValue(payload, ['qty', 'quantity', 'count', 'amount']) || 0),
    unitPrice: Number(firstValue(payload, ['unit_price', 'price', 'sale_price', 'buy_price']) || 0),
    actor: String(firstValue(payload, ['actor', 'customer', 'buyer', 'seller', 'player']) || ''),
    orderId: String(firstValue(payload, ['order_id', 'buy_order_id', 'receipt_id', 'transaction_id']) || '')
  };
}

function firstValue(object, keys) {
  for (const key of keys) {
    if (object[key] !== undefined && object[key] !== null && object[key] !== '') {
      return object[key];
    }
  }
  return '';
}

function normalizeType(value) {
  const text = String(value || '').toLowerCase();
  if (text.includes('sale') || text.includes('sold') || text.includes('sell')) return 'Sale';
  if (text.includes('purchase') || text.includes('bought') || text.includes('buy')) return 'Purchase';
  if (text.includes('stock') || text.includes('movement') || text.includes('restock')) return 'Stocking Movement';
  if (text.includes('craft')) return 'Craft';
  return 'Adjustment';
}

function normalizeDirection(value, type) {
  const text = String(value || '').toLowerCase();
  if (text.includes('in')) return 'Stock In';
  if (text.includes('out')) return 'Stock Out';
  if (type === 'Sale') return 'Stock Out';
  if (type === 'Purchase') return 'Purchase';
  if (type === 'Craft') return 'Stock In';
  return 'Stock In';
}

function alreadyProcessed(rawSheet, webhookId) {
  const lastRow = rawSheet.getLastRow();
  if (lastRow < 2) return false;

  const ids = rawSheet.getRange(2, 2, lastRow - 1, 1).getValues().flat();
  return ids.some(id => String(id) === String(webhookId));
}

function writeTransaction(sheet, event) {
  const row = firstEmptyRow(sheet, 2, 1);
  const signedQtyFormula = `=IF(E${row}="";"";IF(OR(D${row}="Stock In";D${row}="Purchase";D${row}="Return");F${row};-F${row}))`;
  const cashFlowFormula = `=IF(E${row}="";"";IF(C${row}="Sale";F${row}*G${row};IF(C${row}="Purchase";-F${row}*G${row};0)))`;

  sheet.getRange(row, 1, 1, 11).setValues([[
    new Date(),
    SOURCE_NAME,
    event.type,
    event.direction,
    event.item,
    event.qty,
    event.unitPrice,
    signedQtyFormula,
    cashFlowFormula,
    event.actor || event.orderId,
    event.webhookId
  ]]);
  formatTimestampCell(sheet, row);
}

function formatTimestampCell(sheet, row) {
  sheet.getRange(row, 1).setNumberFormat(TIMESTAMP_FORMAT);
}

function firstEmptyRow(sheet, startRow, column) {
  const values = sheet.getRange(startRow, column, sheet.getMaxRows() - startRow + 1, 1).getValues();
  const offset = values.findIndex(row => row[0] === '' || row[0] === null);
  if (offset !== -1) return startRow + offset;

  const nextRow = sheet.getMaxRows() + 1;
  sheet.insertRowsAfter(sheet.getMaxRows(), 1);
  return nextRow;
}

// Public bootstrap exposes workbook structure, never payroll or transaction rows.
function readWorkbookSnapshot() {
  const spreadsheet = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheets = spreadsheet.getSheets().map(sheet => {
    const lastRow = sheet.getLastRow();
    const lastColumn = sheet.getLastColumn();
    const headers = lastColumn ? sheet.getRange(1, 1, 1, lastColumn).getDisplayValues()[0] : [];

    return {
      name: sheet.getName(),
      lastRow,
      lastColumn,
      headers
    };
  });

  return {
    ok: true,
    spreadsheetId: SPREADSHEET_ID,
    generatedAt: new Date().toISOString(),
    sheets
  };
}

function jsonResponse(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}
