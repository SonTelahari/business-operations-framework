const SPREADSHEET_ID = '1TzMlaDaZuRmK8N_A0ZRACoHyU36DR2U-k_YgLqIuU1Y';
const RAW_SHEET = 'Raw Webhook Log';
const TRANSACTION_SHEET = 'Transactions';
const MANUAL_MOVEMENT_SHEET = 'Manual Movements';
const STOCK_COUNTS_SHEET = 'Stock Counts';
const CASH_COUNTS_SHEET = 'Cash Ledger Counts';
const PRODUCTS_SHEET = 'Products';
const TIME_CLOCK_SHEET = 'Timesheet';
const PAYROLL_PAYMENT_SHEET = 'Payroll Payments';
const WEBHOOK_EXCEPTION_SHEET = 'Webhook Exceptions';
const ITEM_MAPPING_SHEET = 'Webhook Item Mappings';
const SOURCE_NAME = 'Discord Bridge - Still Water';
const GUI_SOURCE_NAME = 'Frontier GUI - Still Water';
const TIMESTAMP_FORMAT = 'dd.mm.yyyy hh:mm';

function doGet(e) {
  const action = e && e.parameter ? String(e.parameter.action || '') : '';
  if (action === 'bootstrap') {
    return jsonResponse(readWorkbookSnapshot());
  }
  if (action === 'finance') {
    return jsonResponse(readFinanceSnapshot(e.parameter || {}));
  }

  return jsonResponse({
    ok: true,
    service: 'Frontier Firearms - Still Water webhook receiver',
    expectedMethod: 'POST',
    readActions: ['bootstrap', 'finance']
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

    const spreadsheet = SpreadsheetApp.openById(SPREADSHEET_ID);
    const event = applyStoredItemMapping(spreadsheet, normalizeEvent(payload));
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

    const occurredAt = eventDate(event);
    rawSheet.appendRow([
      occurredAt,
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

    if (event.reviewRequired) {
      const exception = writeWebhookException(spreadsheet, event, payload);
      const controls = writeWebhookControls(spreadsheet, event, { stock: false, ledger: true });
      return jsonResponse({
        ok: true,
        webhookId: event.webhookId,
        reviewRequired: true,
        reviewReason: event.reviewReason,
        exceptionWritten: exception.written,
        transactionWritten: false,
        stockControlWritten: false,
        ledgerControlWritten: controls.ledger
      });
    }

    if (event.item && event.qty) {
      writeTransaction(transactionSheet, event);
    }
    const controls = writeWebhookControls(spreadsheet, event);

    return jsonResponse({
      ok: true,
      webhookId: event.webhookId,
      transactionWritten: Boolean(event.item && event.qty),
      stockControlWritten: controls.stock,
      ledgerControlWritten: controls.ledger
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

  if (action === 'resolve_exception') {
    return resolveWebhookException(spreadsheet, payload.exception || {}, action);
  }

  if (action === 'ignore_exception') {
    return ignoreWebhookException(spreadsheet, payload.exception || {}, action);
  }

  throw new Error('Unknown GUI action: ' + action);
}

function writeWebhookException(spreadsheet, event, payload) {
  const sheet = requireOrCreateSheet(spreadsheet, WEBHOOK_EXCEPTION_SHEET, webhookExceptionHeaders());
  const existingRow = findRowByValue(sheet, 2, event.webhookId);
  if (existingRow) return { written: false, row: existingRow };

  const row = firstEmptyRow(sheet, 2, 1);
  sheet.getRange(row, 1, 1, 19).setValues([[
    eventDate(event),
    event.webhookId,
    'Open',
    event.reviewReason,
    event.discordTitle,
    event.discordItemName,
    event.discordItemLabel,
    event.type,
    event.direction,
    event.qty,
    event.unitPrice,
    event.ledgerBalance === null ? '' : event.ledgerBalance,
    event.currentItemTotal === null ? '' : event.currentItemTotal,
    '',
    '',
    '',
    '',
    JSON.stringify(payload),
    false
  ]]);
  formatTimestampCell(sheet, row);
  return { written: true, row };
}

function resolveWebhookException(spreadsheet, correction, action) {
  const sheet = requireOrCreateSheet(spreadsheet, WEBHOOK_EXCEPTION_SHEET, webhookExceptionHeaders());
  const webhookId = String(correction.webhookId || '');
  const row = findRowByValue(sheet, 2, webhookId);
  if (!row) throw new Error('Webhook exception not found.');

  const values = sheet.getRange(row, 1, 1, 19).getValues()[0];
  if (String(values[2]) !== 'Open') {
    return { ok: true, duplicate: true, action, webhookId, status: String(values[2]) };
  }

  const originalPayload = parseJsonObject(values[17]);
  const quantity = Number(correction.quantity);
  if (!Number.isFinite(quantity) || quantity <= 0) {
    throw new Error('Resolving an exception requires an item and positive quantity.');
  }
  const productResult = correction.newProduct && correction.newProduct.enabled
    ? ensureReviewedProduct(spreadsheet, correction.newProduct)
    : null;
  const itemName = productResult
    ? productResult.product.name
    : String(correction.itemName || '').trim();
  if (!itemName) {
    throw new Error('Resolving an exception requires an item and positive quantity.');
  }

  const event = normalizeEvent({
    ...originalPayload,
    webhook_id: webhookId,
    event_type: correction.eventType || values[7],
    direction: correction.direction || values[8],
    item_name: itemName,
    quantity,
    unit_price: correction.unitPrice === '' || correction.unitPrice === undefined
      ? values[10]
      : correction.unitPrice,
    review_required: false,
    review_reason: ''
  });
  event.reviewRequired = false;
  event.reviewReason = '';

  const transactionSheet = requireSheet(spreadsheet, TRANSACTION_SHEET);
  const transactionAlreadyWritten = alreadyRecordedInColumn(transactionSheet, 11, webhookId);
  if (!transactionAlreadyWritten) writeTransaction(transactionSheet, event);
  const controls = writeWebhookControls(spreadsheet, event, { stock: true, ledger: false });
  if (productResult && productResult.created) {
    controls.stock = establishReviewedProductStock(spreadsheet, event, productResult) || controls.stock;
  }
  const resolvedBy = String(correction.resolvedBy || GUI_SOURCE_NAME);
  if (correction.rememberMapping !== false) {
    rememberItemMapping(spreadsheet, {
      discordItemName: values[5],
      discordItemLabel: values[6],
      itemName,
      resolvedBy,
      webhookId
    });
  }

  sheet.getRange(row, 3).setValue('Resolved');
  sheet.getRange(row, 14, 1, 6).setValues([[
    itemName,
    new Date(),
    resolvedBy,
    String(correction.note || ''),
    values[17],
    true
  ]]);
  sheet.getRange(row, 15).setNumberFormat(TIMESTAMP_FORMAT);
  return {
    ok: true,
    action,
    webhookId,
    status: 'Resolved',
    itemName,
    productCreated: productResult ? productResult.created : false,
    productRow: productResult ? productResult.row : null,
    transactionWritten: !transactionAlreadyWritten,
    stockControlWritten: controls.stock
  };
}

function normalizeReviewedProduct(input) {
  const product = {
    name: String(input && input.name || '').trim(),
    label: String(input && input.label || '').trim(),
    tag: String(input && input.tag || '').trim(),
    category: String(input && input.category || 'Resale').trim() || 'Resale',
    price: Number(input && input.price)
  };
  if (!product.name || !product.label || !product.tag) {
    throw new Error('A new ware requires a product name, display label, and game item tag.');
  }
  if (![product.name, product.label, product.tag, product.category].every(value => value.length <= 120)) {
    throw new Error('New ware fields must be 120 characters or fewer.');
  }
  if (!Number.isFinite(product.price) || product.price < 0) {
    throw new Error('A new ware requires a valid non-negative catalog sale price.');
  }
  return product;
}

function ensureReviewedProduct(spreadsheet, input) {
  const product = normalizeReviewedProduct(input);
  const sheet = requireSheet(spreadsheet, PRODUCTS_SHEET);
  const rowCount = Math.max(0, sheet.getLastRow() - 1);
  const rows = rowCount ? sheet.getRange(2, 1, rowCount, 12).getValues() : [];
  const productNameKey = inventoryKey(product.name);
  const productLabelKey = inventoryKey(product.label);
  const productTagKey = inventoryKey(product.tag);

  for (let index = 0; index < rows.length; index += 1) {
    const existing = rows[index];
    const existingNameKey = inventoryKey(existing[0]);
    const existingLabelKey = inventoryKey(existing[1]);
    const existingTagKey = inventoryKey(existing[2]);
    const row = index + 2;
    if (existingNameKey === productNameKey) {
      if (existingLabelKey !== productLabelKey || existingTagKey !== productTagKey) {
        throw new Error('That product name already belongs to a different label or game item tag.');
      }
      return {
        created: false,
        row,
        product: {
          name: String(existing[0]),
          label: String(existing[1] || existing[0]),
          tag: String(existing[2] || ''),
          category: String(existing[3] || product.category),
          price: numberOrZero(existing[4])
        }
      };
    }
    if (productLabelKey && existingLabelKey === productLabelKey) {
      throw new Error('That display label already belongs to another product.');
    }
    if (productTagKey && existingTagKey === productTagKey) {
      throw new Error('That game item tag already belongs to another product.');
    }
  }

  const row = firstEmptyRow(sheet, 2, 1);
  sheet.getRange(row, 1, 1, 12).setValues([[
    product.name,
    product.label,
    product.tag,
    product.category,
    product.price,
    0,
    0,
    '=MAX(0,F' + row + '-G' + row + ')',
    true,
    '',
    '',
    'Webhook Review'
  ]]);
  sheet.getRange(row, 5).setNumberFormat('$0.00');
  return { created: true, row, product };
}

function reviewedProductInitialStock(event) {
  if (event.currentItemTotal !== null && event.currentItemTotal !== undefined) {
    return Math.max(0, numberOrZero(event.currentItemTotal));
  }
  const direction = inventoryKey(event.direction);
  const stockIn = direction === 'stock in'
    || direction === 'purchase'
    || direction === 'return'
    || direction === 'storage in';
  return stockIn ? Math.abs(numberOrZero(event.qty)) : 0;
}

function establishReviewedProductStock(spreadsheet, event, productResult) {
  const quantity = reviewedProductInitialStock(event);
  const productSheet = requireSheet(spreadsheet, PRODUCTS_SHEET);
  productSheet.getRange(productResult.row, 7).setValue(quantity);
  if (event.currentItemTotal !== null && event.currentItemTotal !== undefined) return false;

  const stockSheet = requireSheet(spreadsheet, STOCK_COUNTS_SHEET);
  const row = firstEmptyRow(stockSheet, 2, 1);
  stockSheet.getRange(row, 1, 1, 4).setValues([[
    eventDate(event),
    'Storefront',
    event.item,
    quantity
  ]]);
  stockSheet.getRange(row, 7, 1, 2).setValues([[
    false,
    joinNotes('Initial count for webhook-reviewed product', '[Webhook ' + event.webhookId + ']')
  ]]);
  formatTimestampCell(stockSheet, row);
  return true;
}

function ignoreWebhookException(spreadsheet, correction, action) {
  const sheet = requireOrCreateSheet(spreadsheet, WEBHOOK_EXCEPTION_SHEET, webhookExceptionHeaders());
  const webhookId = String(correction.webhookId || '');
  const row = findRowByValue(sheet, 2, webhookId);
  if (!row) throw new Error('Webhook exception not found.');
  const status = String(sheet.getRange(row, 3).getDisplayValue());
  if (status !== 'Open') return { ok: true, duplicate: true, action, webhookId, status };

  const resolvedBy = String(correction.resolvedBy || GUI_SOURCE_NAME);
  sheet.getRange(row, 3).setValue('Ignored');
  sheet.getRange(row, 14, 1, 6).setValues([[
    '',
    new Date(),
    resolvedBy,
    String(correction.note || ''),
    sheet.getRange(row, 18).getValue(),
    false
  ]]);
  sheet.getRange(row, 15).setNumberFormat(TIMESTAMP_FORMAT);
  return { ok: true, action, webhookId, status: 'Ignored' };
}

function applyStoredItemMapping(spreadsheet, event) {
  if (!event.reviewRequired || !String(event.reviewReason).includes('unknown_item')) return event;
  const sheet = spreadsheet.getSheetByName(ITEM_MAPPING_SHEET);
  if (!sheet || sheet.getLastRow() < 2) return event;

  const wantedName = inventoryKey(event.discordItemName);
  const wantedLabel = inventoryKey(event.discordItemLabel);
  const rows = sheet.getRange(2, 2, sheet.getLastRow() - 1, 3).getValues();
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    const nameMatches = wantedName && wantedName === inventoryKey(row[0]);
    const labelMatches = wantedLabel && wantedLabel === inventoryKey(row[1]);
    if (!nameMatches && !labelMatches) continue;
    event.item = String(row[2] || event.item);
    event.reviewReason = String(event.reviewReason)
      .split(',')
      .filter(reason => reason && reason !== 'unknown_item')
      .join(',');
    event.reviewRequired = Boolean(event.reviewReason);
    return event;
  }
  return event;
}

function rememberItemMapping(spreadsheet, mapping) {
  if (!mapping.discordItemName && !mapping.discordItemLabel) return;
  const sheet = requireOrCreateSheet(spreadsheet, ITEM_MAPPING_SHEET, [
    'Added At', 'Discord Item Name', 'Discord Item Label', 'Canonical Item', 'Added By', 'Source Webhook ID'
  ]);
  const rows = sheet.getLastRow() < 2 ? [] : sheet.getRange(2, 2, sheet.getLastRow() - 1, 2).getValues();
  const wantedName = inventoryKey(mapping.discordItemName);
  const wantedLabel = inventoryKey(mapping.discordItemLabel);
  const offset = rows.findIndex(row =>
    (wantedName && wantedName === inventoryKey(row[0])) ||
    (wantedLabel && wantedLabel === inventoryKey(row[1]))
  );
  const row = offset === -1 ? firstEmptyRow(sheet, 2, 1) : offset + 2;
  sheet.getRange(row, 1, 1, 6).setValues([[
    new Date(),
    String(mapping.discordItemName || ''),
    String(mapping.discordItemLabel || ''),
    String(mapping.itemName || ''),
    String(mapping.resolvedBy || ''),
    String(mapping.webhookId || '')
  ]]);
  formatTimestampCell(sheet, row);
}

function webhookExceptionHeaders() {
  return [
    'Received At', 'Webhook ID', 'Status', 'Reason', 'Discord Title', 'Discord Item Name',
    'Discord Item Label', 'Event Type', 'Direction', 'Quantity', 'Unit Price', 'Ledger Balance',
    'Current Item Total', 'Resolved Item', 'Resolved At', 'Resolved By', 'Resolution Note',
    'Original Payload', 'Transaction Written'
  ];
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
  const kind = String(entry.kind || '');
  const isTransfer = kind.includes('Transfer');
  const doesNotAffectStorefrontFormula = isTransfer || kind === 'Production Output';
  const signedQtyFormula = doesNotAffectStorefrontFormula
    ? 0
    : `=IF(E${row}="";"";IF(OR(D${row}="Stock In";D${row}="Purchase";D${row}="Return");F${row};-F${row}))`;
  const cashFlowFormula = `=IF(E${row}="";"";IF(OR(C${row}="Sale";D${row}="Cash In");F${row}*G${row};IF(OR(C${row}="Purchase";D${row}="Cash Out");-F${row}*G${row};0)))`;
  sheet.getRange(row, 1, 1, 9).setValues([[
    new Date(),
    GUI_SOURCE_NAME,
    movement.type,
    movement.direction,
    movement.item,
    movement.quantity,
    movement.unitPrice,
    signedQtyFormula,
    cashFlowFormula
  ]]);
  sheet.getRange(row, 10, 1, 3).setValues([[
    joinNotes(
      entry.note,
      entry.kind && entry.kind !== movement.type ? 'GUI type: ' + entry.kind : '',
      isTransfer ? 'Transferred qty: ' + numberOrZero(entry.quantity) : ''
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
  const signedAmount = numberOrZero(entry.amount);
  const totalAmount = Math.abs(signedAmount);
  const item = entry.itemName || entry.itemLabel || (kind === 'Payroll Payout' ? 'Payroll Payout' : 'Ledger Adjustment');
  const stockQuantity = item === 'Ledger Adjustment' || item === 'Payroll Payout' ? 1 : quantity;
  const unitPrice = stockQuantity ? totalAmount / stockQuantity : 0;

  if (kind === 'Owner Capital Deposit' || kind === 'Owner Withdrawal') {
    return {
      type: 'Owner Capital',
      direction: kind === 'Owner Capital Deposit' ? 'Cash In' : 'Cash Out',
      item: 'William Owner Capital',
      quantity: 1,
      unitPrice: totalAmount
    };
  }
  if (kind === 'Safekeeping Deposit' || kind === 'Safekeeping Withdrawal') {
    return {
      type: 'Safekeeping',
      direction: kind === 'Safekeeping Deposit' ? 'Cash In' : 'Cash Out',
      item: 'William Safekeeping Funds',
      quantity: 1,
      unitPrice: totalAmount
    };
  }

  if (kind === 'P2P Sale' || kind === 'Cash In') {
    return { type: 'Sale', direction: 'Stock Out', item, quantity: stockQuantity, unitPrice };
  }
  if (kind === 'P2P Purchase' || kind === 'Cash Out' || kind === 'Payroll Payout') {
    return { type: 'Purchase', direction: 'Purchase', item, quantity: stockQuantity, unitPrice };
  }
  if (kind === 'Correction') {
    return signedAmount >= 0
      ? { type: 'Sale', direction: 'Stock Out', item, quantity: stockQuantity, unitPrice }
      : { type: 'Purchase', direction: 'Purchase', item, quantity: stockQuantity, unitPrice };
  }
  if (kind === 'Production Use' || kind === 'Correction Out') {
    return { type: 'Stocking Movement', direction: 'Stock Out', item, quantity, unitPrice: 0 };
  }
  if (kind === 'Production Output') {
    return { type: 'Storage Movement', direction: 'Storage In', item, quantity, unitPrice: 0 };
  }
  if (kind === 'Storefront Transfer' || kind === 'Storage Transfer') {
    return {
      type: 'Adjustment',
      direction: kind === 'Storefront Transfer' ? 'Transfer to Storefront' : 'Transfer to Storage',
      item,
      quantity,
      unitPrice: 0
    };
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

function requireOrCreateSheet(spreadsheet, name, headers) {
  let sheet = spreadsheet.getSheetByName(name);
  if (sheet) return sheet;
  sheet = spreadsheet.insertSheet(name);
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  sheet.setFrozenRows(1);
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

function parseJsonObject(value) {
  try {
    const parsed = JSON.parse(String(value || '{}'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (error) {
    return {};
  }
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
  const reviewRequested = payload.review_required === true || String(payload.review_required || '').toLowerCase() === 'true';
  const rawType = firstValue(payload, ['event_type', 'type', 'action', 'event']);
  const type = normalizeType(rawType);
  const direction = normalizeDirection(
    firstValue(payload, ['direction', 'movement', 'stock_direction']),
    type
  );

  const item = String(firstValue(payload, reviewRequested
    ? ['proposed_item_name', 'item_name', 'item', 'name', 'product', 'product_name']
    : ['item_name', 'item', 'name', 'product', 'product_name']) || '');
  const qty = Number(firstValue(payload, reviewRequested
    ? ['proposed_quantity', 'qty', 'quantity', 'count', 'amount']
    : ['qty', 'quantity', 'count', 'amount']) || 0);
  const reviewReasons = String(firstValue(payload, ['review_reason']) || '')
    .split(',')
    .map(reason => reason.trim())
    .filter(Boolean);
  if (!item && !reviewReasons.includes('missing_item')) reviewReasons.push('missing_item');
  if (!(qty > 0) && !reviewReasons.includes('missing_quantity')) reviewReasons.push('missing_quantity');

  return {
    webhookId: String(firstValue(payload, ['webhook_id', 'id', 'event_id', 'discord_message_id', 'order_id', 'buy_order_id', 'receipt_id']) || Utilities.getUuid()),
    type,
    direction,
    item,
    qty,
    unitPrice: Number(firstValue(payload, ['unit_price', 'price', 'sale_price', 'buy_price']) || 0),
    currentItemTotal: nullableNumber(firstValue(payload, ['current_item_total', 'current_stock', 'stock_total'])),
    ledgerBalance: nullableNumber(firstValue(payload, ['shop_ledger', 'ledger_balance', 'current_ledger'])),
    occurredAt: String(firstValue(payload, ['timestamp', 'occurred_at', 'created_at']) || ''),
    actor: String(firstValue(payload, ['actor', 'customer', 'buyer', 'seller', 'player']) || ''),
    orderId: String(firstValue(payload, ['order_id', 'buy_order_id', 'receipt_id', 'transaction_id']) || ''),
    discordTitle: String(firstValue(payload, ['discord_title', 'title']) || ''),
    discordItemName: String(firstValue(payload, ['discord_item_name']) || ''),
    discordItemLabel: String(firstValue(payload, ['discord_item_label']) || ''),
    reviewRequired: reviewRequested || reviewReasons.length > 0,
    reviewReason: reviewReasons.join(',')
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

function nullableNumber(value) {
  if (value === '' || value === null || value === undefined) return null;
  const number = Number(String(value).replace(/[$,]/g, '').trim());
  return Number.isFinite(number) ? number : null;
}

function eventDate(event) {
  const parsed = new Date(event && event.occurredAt ? event.occurredAt : '');
  return isNaN(parsed.getTime()) ? new Date() : parsed;
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
    eventDate(event),
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

function writeWebhookControls(spreadsheet, event, options) {
  options = options || {};
  const result = { stock: false, ledger: false };
  const occurredAt = eventDate(event);

  if (options.stock !== false && event.item && event.currentItemTotal !== null) {
    const stockSheet = requireSheet(spreadsheet, STOCK_COUNTS_SHEET);
    const row = firstEmptyRow(stockSheet, 2, 1);
    stockSheet.getRange(row, 1, 1, 4).setValues([[
      occurredAt,
      'Storefront',
      event.item,
      event.currentItemTotal
    ]]);
    stockSheet.getRange(row, 7, 1, 2).setValues([[
      false,
      joinNotes('Storefront reported current item total', '[Webhook ' + event.webhookId + ']')
    ]]);
    formatTimestampCell(stockSheet, row);
    result.stock = true;
  }

  if (options.ledger !== false && event.ledgerBalance !== null) {
    const ledgerSheet = requireSheet(spreadsheet, CASH_COUNTS_SHEET);
    const row = firstEmptyRow(ledgerSheet, 2, 1);
    ledgerSheet.getRange(row, 1, 1, 3).setValues([[
      occurredAt,
      'Store Ledger',
      event.ledgerBalance
    ]]);
    ledgerSheet.getRange(row, 6, 1, 2).setValues([[
      false,
      joinNotes('Storefront reported current ledger', '[Webhook ' + event.webhookId + ']')
    ]]);
    formatTimestampCell(ledgerSheet, row);
    result.ledger = true;
  }

  return result;
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

// Public bootstrap exposes workbook structure and operational totals, never detailed payroll or transaction rows.
function readWorkbookSnapshot() {
  const spreadsheet = SpreadsheetApp.openById(SPREADSHEET_ID);
  backfillWebhookExceptions(spreadsheet);
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
    schemaVersion: 8,
    spreadsheetId: SPREADSHEET_ID,
    generatedAt: new Date().toISOString(),
    sheets,
    reviewExceptions: readWebhookExceptions(spreadsheet),
    inventory: readInventorySnapshot(spreadsheet)
  };
}

// Returns management-ready aggregates without exposing customer, actor, or employee identities.
function readFinanceSnapshot(parameters) {
  const spreadsheet = SpreadsheetApp.openById(SPREADSHEET_ID);
  const timezone = spreadsheet.getSpreadsheetTimeZone
    ? spreadsheet.getSpreadsheetTimeZone()
    : 'Europe/Oslo';
  const from = cleanFinanceDate(parameters && parameters.from) || '0000-01-01';
  const to = cleanFinanceDate(parameters && parameters.to) || '9999-12-31';
  const breakdown = {};
  const monthly = {};
  const totals = { revenue: 0, expenses: 0, profit: 0 };
  const balances = {
    ownerCapitalDeposits: 0,
    ownerWithdrawals: 0,
    ownerCapital: 0,
    safekeepingDeposits: 0,
    safekeepingWithdrawals: 0,
    safekeeping: 0
  };
  const coverage = {
    transactionsScanned: 0,
    storefrontSales: 0,
    storefrontPurchases: 0,
    manualMovementsScanned: 0,
    manualEntries: 0,
    ownerFundEntries: 0,
    safekeepingEntries: 0,
    payrollPayments: 0
  };

  function addEntry(entry) {
    const amount = Math.abs(numberOrZero(entry.amount));
    if (!amount) return;
    const date = financeDateKey(entry.date, timezone);
    const direction = inventoryKey(entry.direction);

    if (entry.type === 'Owner Capital') {
      if (direction === 'cash in') balances.ownerCapitalDeposits += amount;
      if (direction === 'cash out') balances.ownerWithdrawals += amount;
      balances.ownerCapital = balances.ownerCapitalDeposits - balances.ownerWithdrawals;
      return;
    }
    if (entry.type === 'Safekeeping') {
      if (direction === 'cash in') balances.safekeepingDeposits += amount;
      if (direction === 'cash out') balances.safekeepingWithdrawals += amount;
      balances.safekeeping = balances.safekeepingDeposits - balances.safekeepingWithdrawals;
      return;
    }
    if (!date || date < from || date > to) return;
    if (entry.type !== 'Revenue' && entry.type !== 'Expense') return;

    if (entry.type === 'Revenue') totals.revenue += amount;
    else totals.expenses += amount;
    const key = [entry.type, entry.category, entry.label, entry.source].join('|');
    if (!breakdown[key]) {
      breakdown[key] = {
        type: entry.type,
        category: String(entry.category || ''),
        label: String(entry.label || entry.category || ''),
        source: String(entry.source || ''),
        amount: 0,
        count: 0
      };
    }
    breakdown[key].amount += amount;
    breakdown[key].count += 1;

    const month = date.slice(0, 7);
    if (!monthly[month]) monthly[month] = { month, revenue: 0, expenses: 0, profit: 0 };
    if (entry.type === 'Revenue') monthly[month].revenue += amount;
    else monthly[month].expenses += amount;
  }

  const transactions = requireSheet(spreadsheet, TRANSACTION_SHEET);
  const transactionRows = Math.max(0, transactions.getLastRow() - 1);
  if (transactionRows) {
    transactions.getRange(2, 1, transactionRows, 11).getValues().forEach(row => {
      coverage.transactionsScanned += 1;
      const type = inventoryKey(row[2]);
      const amount = financeRowAmount(row);
      if (type === 'sale') {
        if (amount) coverage.storefrontSales += 1;
        addEntry({
          date: row[0], type: 'Revenue', category: 'Storefront Sales',
          label: row[4], source: row[1] || SOURCE_NAME, amount
        });
      }
      if (type === 'purchase') {
        if (amount) coverage.storefrontPurchases += 1;
        addEntry({
          date: row[0], type: 'Expense', category: 'Storefront Purchases',
          label: row[4], source: row[1] || SOURCE_NAME, amount
        });
      }
    });
  }

  const movements = requireSheet(spreadsheet, MANUAL_MOVEMENT_SHEET);
  const movementRows = Math.max(0, movements.getLastRow() - 1);
  if (movementRows) {
    movements.getRange(2, 1, movementRows, 12).getValues().forEach(row => {
      coverage.manualMovementsScanned += 1;
      const type = inventoryKey(row[2]);
      const kind = guiMovementKind(row[9]);
      const amount = financeRowAmount(row);
      const entryType = type === 'owner capital'
        ? 'Owner Capital'
        : type === 'safekeeping'
          ? 'Safekeeping'
          : type === 'sale'
            ? 'Revenue'
            : type === 'purchase'
              ? 'Expense'
              : '';
      if (!entryType || kind === 'Correction') return;
      if (amount) {
        coverage.manualEntries += 1;
        if (entryType === 'Owner Capital') coverage.ownerFundEntries += 1;
        if (entryType === 'Safekeeping') coverage.safekeepingEntries += 1;
      }
      const category = entryType === 'Revenue'
        ? kind === 'P2P Sale' ? 'P2P Sales' : kind === 'Cash In' ? 'Other Income' : 'Manual Sales'
        : entryType === 'Expense'
          ? kind === 'P2P Purchase' ? 'P2P Purchases' : kind === 'Cash Out' ? 'Operating Expenses' : 'Manual Purchases'
          : entryType;
      addEntry({
        date: row[0],
        type: entryType,
        category,
        label: row[4] || category,
        source: row[1] || GUI_SOURCE_NAME,
        direction: row[3],
        amount
      });
    });
  }

  const payroll = requireSheet(spreadsheet, PAYROLL_PAYMENT_SHEET);
  const payrollRows = Math.max(0, payroll.getLastRow() - 1);
  if (payrollRows) {
    payroll.getRange(2, 1, payrollRows, 9).getValues().forEach(row => {
      if (numberOrZero(row[4])) coverage.payrollPayments += 1;
      addEntry({
        date: row[0], type: 'Expense', category: 'Payroll', label: 'Employee Payroll',
        source: row[5] || 'Payroll', amount: row[4]
      });
    });
  }

  totals.revenue = roundMoney(totals.revenue);
  totals.expenses = roundMoney(totals.expenses);
  totals.profit = roundMoney(totals.revenue - totals.expenses);
  Object.keys(balances).forEach(key => { balances[key] = roundMoney(balances[key]); });
  Object.keys(monthly).forEach(key => {
    monthly[key].revenue = roundMoney(monthly[key].revenue);
    monthly[key].expenses = roundMoney(monthly[key].expenses);
    monthly[key].profit = roundMoney(monthly[key].revenue - monthly[key].expenses);
  });

  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    from: from === '0000-01-01' ? '' : from,
    to: to === '9999-12-31' ? '' : to,
    totals,
    balances,
    coverage,
    ledger: readLedgerSnapshot(spreadsheet),
    breakdown: Object.keys(breakdown).map(key => {
      breakdown[key].amount = roundMoney(breakdown[key].amount);
      return breakdown[key];
    }).sort((a, b) => a.type.localeCompare(b.type) || b.amount - a.amount || a.label.localeCompare(b.label)),
    monthly: Object.keys(monthly).map(key => monthly[key]).sort((a, b) => a.month.localeCompare(b.month))
  };
}

function financeRowAmount(row) {
  const cashFlow = Math.abs(numberOrZero(row && row[8]));
  if (cashFlow) return cashFlow;
  return Math.abs(numberOrZero(row && row[5]) * numberOrZero(row && row[6]));
}

function cleanFinanceDate(value) {
  const text = String(value || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : '';
}

function financeDateKey(value, timezone) {
  const date = value instanceof Date ? value : new Date(value);
  if (isNaN(date.getTime())) return '';
  return String(Utilities.formatDate(date, timezone, 'yyyy-MM-dd')).slice(0, 10);
}

function roundMoney(value) {
  return Math.round((numberOrZero(value) + Number.EPSILON) * 100) / 100;
}

function backfillWebhookExceptions(spreadsheet) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(2000)) return 0;
  try {
    const rawSheet = spreadsheet.getSheetByName(RAW_SHEET);
    if (!rawSheet || rawSheet.getLastRow() < 2) return 0;
    const rowCount = Math.min(1000, rawSheet.getLastRow() - 1);
    const startRow = Math.max(2, rawSheet.getLastRow() - rowCount + 1);
    const rows = rawSheet.getRange(startRow, 1, rowCount, 10).getValues();
    let recovered = 0;
    rows.forEach(row => {
      const payload = parseJsonObject(row[9]);
      const reviewRequested = payload.review_required === true || String(payload.review_required || '').toLowerCase() === 'true';
      if (!reviewRequested) return;
      const event = normalizeEvent(payload);
      const result = writeWebhookException(spreadsheet, event, payload);
      if (result.written) recovered += 1;
    });
    return recovered;
  } finally {
    lock.releaseLock();
  }
}

function readWebhookExceptions(spreadsheet) {
  const sheet = spreadsheet.getSheetByName(WEBHOOK_EXCEPTION_SHEET);
  if (!sheet || sheet.getLastRow() < 2) return [];
  const rowCount = Math.min(250, sheet.getLastRow() - 1);
  const startRow = Math.max(2, sheet.getLastRow() - rowCount + 1);
  return sheet.getRange(startRow, 1, rowCount, 19).getValues()
    .filter(row => row[1])
    .map(row => {
      const receivedAt = row[0] instanceof Date ? row[0] : new Date(row[0]);
      const resolvedAt = row[14] instanceof Date ? row[14] : new Date(row[14]);
      const originalPayload = parseJsonObject(row[17]);
      return {
        webhookId: String(row[1]),
        status: String(row[2] || 'Open'),
        reason: String(row[3] || ''),
        receivedAt: isNaN(receivedAt.getTime()) ? '' : receivedAt.toISOString(),
        discordTitle: String(row[4] || ''),
        discordItemName: String(row[5] || ''),
        discordItemLabel: String(row[6] || ''),
        eventType: String(row[7] || ''),
        direction: String(row[8] || ''),
        quantity: numberOrZero(row[9]),
        unitPrice: numberOrZero(row[10]),
        ledgerBalance: row[11] === '' ? null : numberOrZero(row[11]),
        currentItemTotal: row[12] === '' ? null : numberOrZero(row[12]),
        resolvedItem: String(row[13] || ''),
        resolvedAt: isNaN(resolvedAt.getTime()) ? '' : resolvedAt.toISOString(),
        resolvedBy: String(row[15] || ''),
        note: String(row[16] || ''),
        rawText: String(originalPayload.raw_payload || '').slice(0, 4000),
        transactionWritten: row[18] === true || String(row[18]).toLowerCase() === 'true'
      };
    })
    .sort((a, b) => new Date(b.receivedAt || 0) - new Date(a.receivedAt || 0));
}

// Exposes operational totals only; transaction and payroll rows stay private.
function readInventorySnapshot(spreadsheet) {
  const productsSheet = requireSheet(spreadsheet, PRODUCTS_SHEET);
  const materialsSheet = requireSheet(spreadsheet, 'Materials');
  const latestStorefrontCounts = readLatestStockCounts(spreadsheet, 'Storefront');
  const latestStorageCounts = readLatestStockCounts(spreadsheet, 'Storage');
  const storefrontMovements = readStockMovementDeltas(spreadsheet, 'Storefront', latestStorefrontCounts);
  const storageMovements = readStockMovementDeltas(spreadsheet, 'Storage', latestStorageCounts);
  const productRowCount = Math.max(0, productsSheet.getLastRow() - 1);
  const materialRowCount = Math.max(0, materialsSheet.getLastRow() - 1);
  const productRows = productRowCount
    ? productsSheet.getRange(2, 1, productRowCount, 12).getValues()
    : [];
  const materialRows = materialRowCount
    ? materialsSheet.getRange(2, 1, materialRowCount, 3).getValues()
    : [];

  const products = productRows
      .filter(row => row[0])
      .map(row => {
        const key = inventoryKey(row[0]);
        const latestCount = latestStorefrontCounts[key];
        return {
          itemName: String(row[0]),
          itemLabel: String(row[1] || row[0]),
          itemTag: String(row[2] || ''),
          category: String(row[3] || 'Resale'),
          salePrice: numberOrZero(row[4]),
          target: numberOrZero(row[5]),
          currentStock: Math.max(
            0,
            (latestCount ? latestCount.quantity : numberOrZero(row[6]))
              + numberOrZero(storefrontMovements.deltas[key])
          ),
          countedAt: latestCount ? latestCount.countedAt : '',
          active: row[8] === '' ? true : row[8] === true || String(row[8]).toLowerCase() === 'true',
          msrpLow: row[9] === '' ? null : numberOrZero(row[9]),
          msrpHigh: row[10] === '' ? null : numberOrZero(row[10]),
          pricingSource: String(row[11] || '')
        };
      });
  const materials = materialRows
      .filter(row => row[0])
      .map(row => {
        const key = inventoryKey(row[0]);
        const latestCount = latestStorageCounts[key];
        return {
          ingredient: String(row[0]),
          storageCount: Math.max(
            0,
            (latestCount ? latestCount.quantity : numberOrZero(row[2]))
              + numberOrZero(storageMovements.deltas[key])
          ),
          countedAt: latestCount ? latestCount.countedAt : ''
        };
      });
  const storageByKey = {};

  materials.forEach(material => {
    storageByKey[inventoryKey(material.ingredient)] = material;
  });
  Object.keys(latestStorageCounts).forEach(key => {
    const latestCount = latestStorageCounts[key];
    if (storageByKey[key]) return;
    storageByKey[key] = {
      ingredient: latestCount.itemName,
      storageCount: Math.max(0, latestCount.quantity + numberOrZero(storageMovements.deltas[key])),
      countedAt: latestCount.countedAt
    };
  });
  Object.keys(storageMovements.deltas).forEach(key => {
    if (storageByKey[key]) return;
    storageByKey[key] = {
      ingredient: storageMovements.names[key] || key,
      storageCount: Math.max(0, numberOrZero(storageMovements.deltas[key])),
      countedAt: ''
    };
  });

  return {
    products,
    materials,
    storage: Object.keys(storageByKey).map(key => storageByKey[key]),
    ledger: readLedgerSnapshot(spreadsheet),
    buyOrderPurchases: readBuyOrderPurchases(spreadsheet)
  };
}

// Sends only the purchase fields needed to reconcile storefront buy orders.
function readBuyOrderPurchases(spreadsheet) {
  const sheet = requireSheet(spreadsheet, TRANSACTION_SHEET);
  const rowCount = Math.max(0, sheet.getLastRow() - 1);
  if (!rowCount) return [];

  return sheet.getRange(2, 1, rowCount, 11).getValues()
    .filter(row => inventoryKey(row[2]) === 'purchase' && row[4] && numberOrZero(row[5]) > 0 && row[10])
    .map(row => {
      const occurredAt = row[0] instanceof Date ? row[0] : new Date(row[0]);
      return {
        eventId: String(row[10]),
        occurredAt: isNaN(occurredAt.getTime()) ? '' : occurredAt.toISOString(),
        itemName: String(row[4]),
        quantity: Math.abs(numberOrZero(row[5])),
        unitPrice: Math.max(0, numberOrZero(row[6]))
      };
    });
}

function readLedgerSnapshot(spreadsheet) {
  const baseline = readLatestLedgerCount(spreadsheet);
  let balance = baseline ? baseline.balance : 0;
  let netMovementSinceCount = 0;
  let lastActivityAt = baseline ? baseline.countedAt : '';
  const baselineTime = baseline ? baseline.sortTime : Number.NEGATIVE_INFINITY;

  function applyMovement(dateValue, amount) {
    const date = dateValue instanceof Date ? dateValue : new Date(dateValue);
    const sortTime = isNaN(date.getTime()) ? 0 : date.getTime();
    if (sortTime <= baselineTime || !amount) return;
    balance += amount;
    netMovementSinceCount += amount;
    if (!lastActivityAt || sortTime >= new Date(lastActivityAt).getTime()) {
      lastActivityAt = sortTime ? date.toISOString() : lastActivityAt;
    }
  }

  applyCashFlowRows(requireSheet(spreadsheet, TRANSACTION_SHEET), applyMovement);
  applyCashFlowRows(requireSheet(spreadsheet, MANUAL_MOVEMENT_SHEET), applyMovement);

  const payrollSheet = requireSheet(spreadsheet, PAYROLL_PAYMENT_SHEET);
  const payrollRows = Math.max(0, payrollSheet.getLastRow() - 1);
  if (payrollRows) {
    payrollSheet.getRange(2, 1, payrollRows, 6).getValues().forEach(row => {
      if (inventoryKey(row[5]) !== 'ledger') return;
      applyMovement(row[0], -Math.abs(numberOrZero(row[4])));
    });
  }

  return {
    balance,
    countedBalance: baseline ? baseline.balance : null,
    countedAt: baseline ? baseline.countedAt : '',
    netMovementSinceCount,
    lastActivityAt,
    source: baseline ? 'Latest ledger count plus subsequent cash movements' : 'Cash movements since records began'
  };
}

function readLatestLedgerCount(spreadsheet) {
  const sheet = requireSheet(spreadsheet, CASH_COUNTS_SHEET);
  const rowCount = Math.max(0, sheet.getLastRow() - 1);
  if (!rowCount) return null;

  let latest = null;
  sheet.getRange(2, 1, rowCount, 3).getValues().forEach(row => {
    if (inventoryKey(row[1]) !== 'store ledger') return;
    const countedDate = row[0] instanceof Date ? row[0] : new Date(row[0]);
    const sortTime = isNaN(countedDate.getTime()) ? 0 : countedDate.getTime();
    if (latest && latest.sortTime > sortTime) return;
    latest = {
      balance: numberOrZero(row[2]),
      countedAt: sortTime ? countedDate.toISOString() : '',
      sortTime
    };
  });
  return latest;
}

function applyCashFlowRows(sheet, applyMovement) {
  const rowCount = Math.max(0, sheet.getLastRow() - 1);
  if (!rowCount) return;

  sheet.getRange(2, 1, rowCount, 7).getValues().forEach(row => {
    const type = inventoryKey(row[2]);
    const direction = inventoryKey(row[3]);
    const amount = Math.abs(numberOrZero(row[5]) * numberOrZero(row[6]));
    if (type === 'sale' || direction === 'cash in') applyMovement(row[0], amount);
    else if (type === 'purchase' || direction === 'cash out') applyMovement(row[0], -amount);
  });
}

function readStockMovementDeltas(spreadsheet, location, latestCounts) {
  const deltas = {};
  const names = {};
  const wantedLocation = inventoryKey(location);

  function applyMovement(dateValue, itemValue, quantityDelta, baselineRequired) {
    const key = inventoryKey(itemValue);
    if (!key) return;
    names[key] = String(itemValue || names[key] || key);
    const baseline = latestCounts[key];
    if ((baselineRequired && !baseline) || !quantityDelta) return;
    const date = dateValue instanceof Date ? dateValue : new Date(dateValue);
    const sortTime = isNaN(date.getTime()) ? 0 : date.getTime();
    if (baseline && sortTime <= baseline.sortTime) return;
    deltas[key] = numberOrZero(deltas[key]) + quantityDelta;
  }

  if (wantedLocation === 'storefront') {
    const transactionSheet = requireSheet(spreadsheet, TRANSACTION_SHEET);
    const transactionRows = Math.max(0, transactionSheet.getLastRow() - 1);
    if (transactionRows) {
      transactionSheet.getRange(2, 1, transactionRows, 6).getValues().forEach(row => {
        const quantity = Math.abs(numberOrZero(row[5]));
        const direction = inventoryKey(row[3]);
        const delta = direction === 'stock in' || direction === 'purchase' || direction === 'return'
          ? quantity
          : -quantity;
        applyMovement(row[0], row[4], delta, true);
      });
    }
  }

  const movementSheet = requireSheet(spreadsheet, MANUAL_MOVEMENT_SHEET);
  const movementRows = Math.max(0, movementSheet.getLastRow() - 1);
  if (movementRows) {
    movementSheet.getRange(2, 1, movementRows, 10).getValues().forEach(row => {
      const delta = manualStockDelta(row, wantedLocation);
      applyMovement(row[0], row[4], delta, false);
    });
  }

  return { deltas, names };
}

function manualStockDelta(row, location) {
  const transferredMatch = String(row[9] || '').match(/Transferred qty:\s*(-?(?:\d+(?:\.\d+)?|\.\d+))/i);
  const transferredQuantity = transferredMatch ? numberOrZero(transferredMatch[1]) : 0;
  const quantity = Math.abs(numberOrZero(row[5]) || transferredQuantity);
  if (!quantity) return 0;
  const kind = guiMovementKind(row[9]);

  if (location === 'storefront') {
    if (kind === 'Storefront Transfer') return quantity;
    if (kind === 'Storage Transfer') return -quantity;
    return 0;
  }

  if (kind === 'P2P Sale' || kind === 'Production Use' || kind === 'Correction Out' || kind === 'Storefront Transfer') {
    return -quantity;
  }
  if (kind === 'P2P Purchase' || kind === 'Correction In' || kind === 'Production Output' || kind === 'Storage Transfer') {
    return quantity;
  }
  if (
    kind === 'Cash In' || kind === 'Cash Out' || kind === 'Payroll Payout' || kind === 'Correction'
    || kind === 'Owner Capital Deposit' || kind === 'Owner Withdrawal'
    || kind === 'Safekeeping Deposit' || kind === 'Safekeeping Withdrawal'
  ) return 0;

  const type = inventoryKey(row[2]);
  const direction = inventoryKey(row[3]);
  if (type === 'sale') return -quantity;
  if (type === 'purchase') return quantity;
  if (type === 'stocking movement' || type === 'adjustment') {
    return direction === 'stock out' ? -quantity : quantity;
  }
  return 0;
}

function guiMovementKind(notes) {
  const match = String(notes || '').match(/(?:^|\|)\s*GUI type:\s*([^|]+)/i);
  return match ? String(match[1] || '').trim() : '';
}

function readLatestStockCounts(spreadsheet, location) {
  const sheet = requireSheet(spreadsheet, STOCK_COUNTS_SHEET);
  const rowCount = Math.max(0, sheet.getLastRow() - 1);
  if (!rowCount) return {};

  const wantedLocation = inventoryKey(location);
  const latest = {};
  sheet.getRange(2, 1, rowCount, 4).getValues().forEach(row => {
    if (!row[2] || inventoryKey(row[1]) !== wantedLocation) return;
    const key = inventoryKey(row[2]);
    const countedDate = row[0] instanceof Date ? row[0] : new Date(row[0]);
    const sortTime = isNaN(countedDate.getTime()) ? 0 : countedDate.getTime();
    if (latest[key] && latest[key].sortTime > sortTime) return;
    latest[key] = {
      itemName: String(row[2]),
      quantity: numberOrZero(row[3]),
      countedAt: sortTime ? countedDate.toISOString() : '',
      sortTime
    };
  });
  return latest;
}

function inventoryKey(value) {
  const key = String(value || '').trim().toLowerCase();
  return key === 'wood' || key === 'soft wood' || key === 'softwood' ? 'softwood' : key;
}

function jsonResponse(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}
