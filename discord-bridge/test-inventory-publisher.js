const assert = require('node:assert/strict');
const {
  ALERT_MARKER,
  INVENTORY_MARKER,
  INVENTORY_NEXT_ID,
  buildInventoryPages,
  createInventoryPublisher,
  normalizeInventorySnapshot,
  stockAlertMessagePayload
} = require('./inventory-publisher');

const rawProducts = Array.from({ length: 21 }, (_, index) => ({
  itemName: `Product ${index + 1}`,
  itemLabel: index === 0 ? '@everyone Special' : `Product ${index + 1}`,
  itemTag: `product_${index + 1}`,
  category: index < 12 ? 'Revolvers' : 'Ammunition',
  currentStock: index === 0 ? 0 : index,
  target: 5,
  salePrice: index + 1,
  active: true
}));
rawProducts.push({
  itemName: 'No Target Product',
  currentStock: 100,
  target: 0,
  active: true
});
rawProducts.push({
  itemName: 'Missing Target Product',
  currentStock: 100,
  active: true
});
rawProducts.push({
  itemName: 'Inactive Product',
  currentStock: 100,
  target: 100,
  active: false
});

const snapshot = normalizeInventorySnapshot({
  ok: true,
  workspace: { name: 'Test Outfit' },
  schemaVersion: 8,
  generatedAt: '2026-07-29T08:00:00.000Z',
  inventory: { products: rawProducts }
});
assert.equal(snapshot.products.length, 21);
assert.equal(snapshot.businessName, 'Test Outfit');
assert.equal(buildInventoryPages(snapshot)[0].title, 'Test Outfit - Storefront Stock');
assert.equal(snapshot.products.find(product => product.name === 'Product 1').missing, 5);
assert.equal(snapshot.products.some(product => product.name === 'No Target Product'), false);
assert.equal(snapshot.products.some(product => product.name === 'Missing Target Product'), false);
assert.equal(snapshot.products.some(product => product.name === 'Inactive Product'), false);

const noTargets = normalizeInventorySnapshot({
  ok: true,
  inventory: {
    products: [
      { itemName: 'No Target', currentStock: 10, target: 0, active: true },
      { itemName: 'Target Missing', currentStock: 10, active: true }
    ]
  }
});
assert.equal(noTargets.products.length, 0);
assert.match(buildInventoryPages(noTargets)[0].fields[0].value, /No storefront targets/);
assert.match(stockAlertMessagePayload(noTargets).embeds[0].description, /Set storefront targets/);

const pages = buildInventoryPages(snapshot, 8);
assert.equal(pages.length, 3);
assert(pages[0].footer.text.includes(INVENTORY_MARKER));
assert(pages.every(page => page.fields.length <= 25));
assert(pages.flatMap(page => page.fields).every(field => field.value.length <= 1024));
assert(
  pages.flatMap(page => page.fields).some(field => field.value.includes('@\u200beveryone')),
  'catalog labels must not create Discord mentions'
);

const alerts = stockAlertMessagePayload(snapshot);
assert(alerts.embeds[0].footer.text.includes(ALERT_MARKER));
assert.equal(alerts.embeds[0].title, 'Test Outfit - Stock Alerts');
assert.match(alerts.embeds[0].description, /below target/);
assert.equal(alerts.allowedMentions.parse.length, 0);

const allClear = stockAlertMessagePayload(normalizeInventorySnapshot({
  ok: true,
  inventory: {
    products: [{ itemName: 'Ready', currentStock: 5, target: 5, active: true }]
  }
}));
assert.match(allClear.embeds[0].description, /No storefront restock action/);

const largeAlert = stockAlertMessagePayload(normalizeInventorySnapshot({
  ok: true,
  inventory: {
    products: Array.from({ length: 100 }, (_, index) => ({
      itemName: `Long shortage product ${index + 1} ${'x'.repeat(90)}`,
      currentStock: 0,
      target: 100,
      active: true
    }))
  }
}));
const alertCharacters = JSON.stringify(largeAlert.embeds[0]).length;
assert(alertCharacters < 6000, 'the alert embed must stay under Discord total character limits');
assert(largeAlert.embeds[0].fields.some(field => field.name === 'Additional shortages'));

class FakeMessage {
  constructor(id, botId, payload) {
    this.id = id;
    this.author = { id: botId };
    this.editCount = 0;
    this.apply(payload);
  }

  apply(payload) {
    this.embeds = payload.embeds || [];
    this.components = payload.components || [];
  }

  async edit(payload) {
    this.editCount += 1;
    this.apply(payload);
    return this;
  }
}

class FakeChannel {
  constructor(id, botId) {
    this.id = id;
    this.botId = botId;
    this.sent = [];
    this.messageMap = new Map();
    this.messages = {
      fetch: async argument => {
        if (typeof argument === 'string') return this.messageMap.get(argument) || null;
        const values = [...this.messageMap.values()];
        return { find: predicate => values.find(predicate) };
      }
    };
  }

  isTextBased() {
    return true;
  }

  async send(payload) {
    const message = new FakeMessage(`${this.id}-${this.sent.length + 1}`, this.botId, payload);
    this.sent.push(message);
    this.messageMap.set(message.id, message);
    return message;
  }
}

async function runPublisherChecks() {
  const botId = 'bot-1';
  const inventoryChannel = new FakeChannel('inventory', botId);
  const alertChannel = new FakeChannel('alerts', botId);
  const channels = new Map([
    [inventoryChannel.id, inventoryChannel],
    [alertChannel.id, alertChannel]
  ]);
  const client = {
    user: { id: botId },
    channels: { fetch: async id => channels.get(id) }
  };
  const logs = [];
  let requestedUrl = '';
  let requestedAuthorization = '';
  const publisher = createInventoryPublisher({
    client,
    snapshotUrl: 'https://example.test/api/integrations/discord/snapshot',
    requestHeaders: { authorization: 'Bearer inventory-test-token' },
    inventoryChannelId: inventoryChannel.id,
    alertChannelId: alertChannel.id,
    refreshMs: 30000,
    fetchImpl: async (url, options) => {
      requestedUrl = String(url);
      requestedAuthorization = options.headers.authorization;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          schemaVersion: 8,
          generatedAt: '2026-07-29T08:00:00.000Z',
          inventory: { products: rawProducts }
        })
      };
    },
    logger: {
      info: message => logs.push(message),
      warn: message => logs.push(message),
      error: message => logs.push(message)
    }
  });

  await publisher.refresh('test');
  assert.equal(inventoryChannel.sent.length, 1);
  assert.equal(alertChannel.sent.length, 1);
  assert.equal(publisher.health().product_count, 21);
  assert.equal(publisher.health().shortage_count, snapshot.products.filter(product => product.missing > 0).length);
  assert.equal(publisher.health().last_error, '');
  assert.equal(requestedUrl, 'https://example.test/api/integrations/discord/snapshot');
  assert.equal(requestedAuthorization, 'Bearer inventory-test-token');

  let interactionPayload = null;
  const handled = await publisher.handleInteraction({
    customId: INVENTORY_NEXT_ID,
    message: { id: inventoryChannel.sent[0].id },
    isButton: () => true,
    update: async payload => { interactionPayload = payload; }
  });
  assert.equal(handled, true);
  assert(interactionPayload.embeds[0].footer.text.includes('Page 2/2'));

  await publisher.refresh('second test');
  assert.equal(inventoryChannel.sent.length, 1, 'refreshes must edit the managed overview message');
  assert.equal(alertChannel.sent.length, 1, 'refreshes must edit the managed alert message');
  assert.equal(inventoryChannel.sent[0].editCount, 1);
  assert(logs.some(message => message.includes('21 products')));
  publisher.stop();
}

runPublisherChecks()
  .then(() => console.log('Discord storefront inventory publisher checks passed.'))
  .catch(error => {
    console.error(error);
    process.exit(1);
  });
