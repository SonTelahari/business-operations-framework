const itemCatalog = require('../app/items');
const pricingCatalog = require('../app/pricing');

function parseStillWaterEmbed(message) {
  const title = message.title || message.embeds?.[0]?.title || '';
  const description = message.description || message.embeds?.[0]?.description || '';
  const text = normalizeText(description);
  const ledgerCash = parseLedgerCashText(text);
  if (ledgerCash) {
    return {
      event_type: 'Cash Movement',
      direction: ledgerCash.direction,
      discord_title: title,
      discord_item_name: '',
      discord_item_label: '',
      item_name: '',
      quantity: ledgerCash.amount,
      cash_amount: ledgerCash.amount,
      unit_price: 0,
      shop_ledger: null,
      current_item_total: null,
      buy_order_id: '',
      webhook_id: message.id || '',
      raw_payload: description,
      actor: ledgerCash.actor,
      ledger_name: ledgerCash.ledgerName,
      catalog_matched: true,
      review_required: true,
      review_reason: 'cash_classification_required'
    };
  }
  const storageMovement = parseStorageManagerText(text);
  if (storageMovement) {
    return {
      event_type: 'Stocking Movement',
      direction: storageMovement.direction,
      discord_title: title,
      discord_item_name: storageMovement.itemName,
      discord_item_label: storageMovement.itemName,
      item_name: storageMovement.itemName,
      quantity: storageMovement.quantity,
      unit_price: 0,
      shop_ledger: null,
      current_item_total: null,
      buy_order_id: '',
      webhook_id: message.id || '',
      raw_payload: description,
      actor: storageMovement.actor,
      container_name: storageMovement.containerName,
      catalog_matched: true,
      review_required: false,
      review_reason: ''
    };
  }

  const itemName = matchLine(text, 'Item name');
  const itemLabel = matchLine(text, 'Item label');
  const shopLedgerText = matchLine(text, 'Shop Ledger');
  const currentItemTotalText = matchLine(text, 'Current Item Total');
  const depositAmount = numberValue(matchLine(text, 'Deposit Amount'));
  const withdrawnAmount = numberValue(matchLine(text, 'Amount Withdrawn'));
  const boughtAmount = numberValue(matchLine(text, 'Amount Bought'));
  const soldAmount = firstNumberValue(
    matchLine(text, 'Sold Amount'),
    matchLine(text, 'Amount Sold'),
    matchLine(text, 'Amount Filled'),
    matchLine(text, 'Amount Purchased')
  );
  const sellPrice = moneyValue(matchLine(text, 'Sell Price'));
  const buyPrice = firstMoneyValue(
    matchLine(text, 'Buy Price'),
    matchLine(text, 'Purchase Price'),
    matchLine(text, 'Price')
  );
  const buyOrderId = firstTextValue(
    matchLine(text, 'Buy Order ID'),
    matchLine(text, 'Order ID')
  );

  const isDeposit = /deposit/i.test(title) || depositAmount > 0;
  const isWithdraw = /withdraw/i.test(title) || withdrawnAmount > 0;
  const isBought = /bought item/i.test(title) || boughtAmount > 0;
  const isBuyOrderFill =
    /buy order|sold to shop|sold item|customer sell/i.test(title) ||
    soldAmount > 0 ||
    Boolean(buyOrderId && soldAmount > 0);

  const eventType = isBought ? 'Sale' : (isBuyOrderFill ? 'Purchase' : 'Stocking Movement');
  const direction = isWithdraw || isBought ? 'Stock Out' : (isBuyOrderFill ? 'Purchase' : 'Stock In');
  const quantity = isBought
    ? boughtAmount
    : (isBuyOrderFill ? soldAmount : (isWithdraw ? withdrawnAmount : depositAmount));

  const pricedQuantity = isBought ? boughtAmount : (isBuyOrderFill ? soldAmount : 1);
  const unitPrice = (isBought || isBuyOrderFill) && pricedQuantity > 1 && sellPrice
    ? sellPrice / pricedQuantity
    : sellPrice || buyPrice;
  const resolvedItem = resolveDiscordItem(itemName, itemLabel);
  const reviewReasons = [];
  if (!itemName && !itemLabel) reviewReasons.push('missing_item');
  else if (!resolvedItem.matched) reviewReasons.push('unknown_item');
  if (!quantity) reviewReasons.push('missing_quantity');

  return {
    event_type: eventType,
    direction,
    discord_title: title,
    discord_item_name: itemName,
    discord_item_label: itemLabel,
    item_name: resolvedItem.itemName,
    quantity,
    unit_price: unitPrice,
    shop_ledger: optionalMoneyValue(shopLedgerText),
    current_item_total: optionalNumberValue(currentItemTotalText),
    buy_order_id: buyOrderId,
    webhook_id: message.id || buyOrderId || '',
    raw_payload: description,
    catalog_matched: resolvedItem.matched,
    review_required: reviewReasons.length > 0,
    review_reason: reviewReasons.join(',')
  };
}

function parseStorageManagerText(value) {
  const text = normalizeText(value);
  const movement = parseStorageContainerMovement(text);
  if (!movement) return null;
  return {
    ...movement,
    actor: matchLine(text, 'PlayerName')
  };
}

function parseLedgerCashText(value) {
  const text = normalizeText(value);
  const match = text.match(
    /\b(Withdrawn|Deposited)\s+An\s+Amount\s+Of\s+\$?([\d,]+(?:\.\d+)?)\s+(?:From|To)\s+(.+?)\s+Ledger\b/i
  );
  if (!match) return null;
  return {
    direction: /^deposited$/i.test(match[1]) ? 'Cash In' : 'Cash Out',
    amount: Number(String(match[2]).replace(/,/g, '')),
    ledgerName: String(match[3] || '').trim(),
    actor: matchLine(text, 'PlayerName')
  };
}

function parseStorageContainerMovement(text) {
  const movements = [
    {
      direction: 'Stock Out',
      pattern: /\bHas\s+Taken\s+([\d,]+(?:\.\d+)?)\s+(.+?)\s+From\s+(.+?)\s+Inventory\b/i
    },
    {
      direction: 'Stock In',
      pattern: /\bDeposited\s+([\d,]+(?:\.\d+)?)\s+(.+?)\s+To\s+(.+?)\s+Inventory\b/i
    }
  ];
  for (const movement of movements) {
    const match = text.match(movement.pattern);
    if (!match) continue;
    return {
      direction: movement.direction,
      quantity: Number(String(match[1]).replace(/,/g, '')),
      itemName: String(match[2] || '').trim(),
      containerName: String(match[3] || '').trim()
    };
  }
  return null;
}

function normalizeText(value) {
  return String(value || '')
    .replace(/\*\*/g, '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/[\u00A0\u202F]/g, ' ')
    .replace(/\r\n?/g, '\n')
    .trim();
}

function matchLine(text, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = text.match(new RegExp(`^${escaped}[ \\t]*:[ \\t]*(.*)$`, 'im'));
  return match ? String(match[1] || '').trim() : '';
}

function numberValue(value) {
  const match = String(value || '').match(/-?(?:\d+(?:\.\d+)?|\.\d+)/);
  return match ? Number(match[0]) : 0;
}

function moneyValue(value) {
  const match = String(value || '').replace(/,/g, '').match(/-?(?:\d+(?:\.\d+)?|\.\d+)/);
  return match ? Number(match[0]) : 0;
}

function optionalNumberValue(value) {
  return String(value || '').trim() ? numberValue(value) : null;
}

function optionalMoneyValue(value) {
  return String(value || '').trim() ? moneyValue(value) : null;
}

function firstNumberValue(...values) {
  for (const value of values) {
    const parsed = numberValue(value);
    if (parsed) return parsed;
  }
  return 0;
}

function firstMoneyValue(...values) {
  for (const value of values) {
    const parsed = moneyValue(value);
    if (parsed) return parsed;
  }
  return 0;
}

function firstTextValue(...values) {
  return values.find((value) => String(value || '').trim()) || '';
}

function resolveDiscordItem(itemName, itemLabel) {
  const normalizedName = normalizeCatalogText(itemName);
  const normalizedLabel = normalizeCatalogText(itemLabel);
  const mappedByName = ITEM_NAME_MAP[normalizedName];
  if (mappedByName) return { itemName: mappedByName, matched: true };

  const mappedByLabel = ITEM_LABEL_MAP[normalizedLabel];
  if (mappedByLabel) return { itemName: mappedByLabel, matched: true };

  const material = MATERIAL_MAP[normalizedName] || MATERIAL_MAP[normalizedLabel];
  if (material) return { itemName: material, matched: true };

  for (const [pattern, product] of LABEL_PATTERNS) {
    if (pattern.test(normalizedLabel)) return { itemName: product, matched: true };
  }

  return { itemName: itemLabel || itemName, matched: false };
}

function normalizeCatalogText(value) {
  return String(value || '').trim().toLowerCase();
}

const ITEM_NAME_MAP = itemCatalog.reduce((map, item) => {
  const key = normalizeCatalogText(item.tag);
  if (key) map[key] = item.name;
  return map;
}, {});

const ITEM_LABEL_MAP = itemCatalog.reduce((map, item) => {
  [item.name, item.label, ...(Array.isArray(item.aliases) ? item.aliases : [])].forEach(value => {
    const key = normalizeCatalogText(value);
    if (key && !map[key]) map[key] = item.name;
  });
  return map;
}, {});

const MATERIAL_MAP = Object.keys(pricingCatalog.materials || {}).reduce((map, material) => {
  map[normalizeCatalogText(material)] = material;
  return map;
}, {});

const LABEL_PATTERNS = [];

module.exports = {
  parseStillWaterEmbed,
  parseStorageManagerText,
  parseLedgerCashText
};
