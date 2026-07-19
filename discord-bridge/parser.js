const itemCatalog = require('../app/items');

function parseStillWaterEmbed(message) {
  const title = message.title || message.embeds?.[0]?.title || '';
  const description = message.description || message.embeds?.[0]?.description || '';
  const text = normalizeText(description);

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

  return {
    event_type: eventType,
    direction,
    discord_item_name: itemName,
    discord_item_label: itemLabel,
    item_name: mapDiscordItem(itemName, itemLabel),
    quantity,
    unit_price: unitPrice,
    shop_ledger: optionalMoneyValue(shopLedgerText),
    current_item_total: optionalNumberValue(currentItemTotalText),
    buy_order_id: buyOrderId,
    webhook_id: message.id || buyOrderId || '',
    raw_payload: description
  };
}

function normalizeText(value) {
  return String(value || '')
    .replace(/\*\*/g, '')
    .replace(/\r\n/g, '\n')
    .trim();
}

function matchLine(text, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = text.match(new RegExp(`^${escaped}:[ \\t]*(.*)$`, 'im'));
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

function mapDiscordItem(itemName, itemLabel) {
  const normalizedName = normalizeCatalogText(itemName);
  const normalizedLabel = normalizeCatalogText(itemLabel);
  const mappedByName = ITEM_NAME_MAP[normalizedName];
  if (mappedByName) return mappedByName;

  const mappedByLabel = ITEM_LABEL_MAP[normalizedLabel];
  if (mappedByLabel) return mappedByLabel;

  for (const [pattern, product] of LABEL_PATTERNS) {
    if (pattern.test(normalizedLabel)) return product;
  }

  return itemLabel || itemName;
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

const LABEL_PATTERNS = [];

module.exports = {
  parseStillWaterEmbed
};
