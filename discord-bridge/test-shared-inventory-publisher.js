const assert = require('node:assert/strict');
const {
  createSharedInventoryPublisher,
  normalizeDiscordIntegrations
} = require('./shared-inventory-publisher');

const normalized = normalizeDiscordIntegrations([
  {
    businessId: 'business-a',
    workspaceCode: 'AAAAA-BBBBB',
    status: 'active',
    eventChannelId: 'event-a',
    inventoryChannelId: 'inventory-a',
    alertChannelId: 'alerts-a'
  },
  {
    businessId: 'inactive',
    status: 'inactive',
    eventChannelId: 'event-inactive',
    inventoryChannelId: 'inventory-inactive'
  },
  {
    businessId: 'no-output',
    status: 'active',
    eventChannelId: 'event-no-output'
  }
]);
assert.equal(normalized.length, 1);
assert.equal(normalized[0].key, 'business-a');

async function runSharedPublisherChecks() {
  let directory = [
    {
      businessId: 'business-a',
      workspaceCode: 'AAAAA-BBBBB',
      businessName: 'Business A',
      status: 'active',
      eventChannelId: 'event-a',
      inventoryChannelId: 'inventory-a',
      alertChannelId: 'alerts-a'
    },
    {
      businessId: 'business-b',
      workspaceCode: 'CCCCC-DDDDD',
      businessName: 'Business B',
      status: 'active',
      eventChannelId: 'event-b',
      inventoryChannelId: 'inventory-b',
      alertChannelId: ''
    }
  ];
  const created = [];
  const logs = [];
  let directoryAuthorization = '';
  const publisher = createSharedInventoryPublisher({
    client: { user: { id: 'bot-1' } },
    apiBaseUrl: 'https://operations.example.test/',
    apiToken: 'bridge-test-token',
    refreshMs: 30000,
    directoryRefreshMs: 30000,
    fetchImpl: async (url, options) => {
      assert.equal(String(url), 'https://operations.example.test/api/integrations/discord/channels');
      directoryAuthorization = options.headers.authorization;
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, integrations: directory })
      };
    },
    publisherFactory: options => {
      const record = {
        options,
        startCount: 0,
        stopCount: 0,
        refreshes: [],
        interactions: 0,
        lastSuccessAt: new Date().toISOString(),
        lastError: ''
      };
      created.push(record);
      return {
        enabled: true,
        start: async () => { record.startCount += 1; },
        stop: () => { record.stopCount += 1; },
        refresh: async reason => {
          record.refreshes.push(reason);
          record.lastSuccessAt = new Date().toISOString();
          record.lastError = '';
        },
        requestRefresh: reason => record.refreshes.push(reason),
        handleInteraction: async interaction => {
          record.interactions += 1;
          return interaction.message?.id === options.inventoryChannelId;
        },
        health: () => ({
          inventory_channel_configured: Boolean(options.inventoryChannelId),
          alert_channel_configured: Boolean(options.alertChannelId),
          product_count: options.inventoryChannelId === 'inventory-a' ? 2 : 0,
          shortage_count: 1,
          last_success_at: record.lastSuccessAt,
          last_error: record.lastError
        })
      };
    },
    logger: {
      info: message => logs.push(message),
      warn: message => logs.push(message),
      error: message => logs.push(message)
    }
  });

  await publisher.start();
  assert.equal(directoryAuthorization, 'Bearer bridge-test-token');
  assert.equal(created.length, 2);
  assert(created.every(record => record.startCount === 1));
  assert.equal(
    created[0].options.snapshotUrl,
    'https://operations.example.test/api/integrations/discord/snapshot?discord_channel_id=event-a'
  );
  assert.equal(created[1].options.inventoryChannelId, 'inventory-b');
  assert.equal(publisher.health().integration_count, 2);
  assert.equal(publisher.health().inventory_channel_count, 2);
  assert.equal(publisher.health().alert_channel_count, 1);
  assert.equal(publisher.health().product_count, 2);

  publisher.requestRefresh('tester event', 'event-b');
  assert.deepEqual(created[0].refreshes, []);
  assert.deepEqual(created[1].refreshes, ['tester event']);

  const handled = await publisher.handleInteraction({ message: { id: 'inventory-b' } });
  assert.equal(handled, true);
  assert.equal(created[0].interactions, 1);
  assert.equal(created[1].interactions, 1);

  directory = [{
    ...directory[1],
    inventoryChannelId: 'inventory-b-new',
    alertChannelId: 'alerts-b'
  }];
  await publisher.refreshDirectory('configuration change');
  assert.equal(created.length, 3);
  assert.equal(created[0].stopCount, 1, 'removed business publisher should stop');
  assert.equal(created[1].stopCount, 1, 'changed business publisher should restart');
  assert.equal(created[2].startCount, 1);
  assert.equal(created[2].options.inventoryChannelId, 'inventory-b-new');
  assert.equal(publisher.health().integration_count, 1);
  assert(logs.some(message => message.includes('1 active businesses')));

  created[2].lastError = 'simulated stopped child timer';
  await publisher.refreshDirectory('watchdog check');
  assert(
    created[2].refreshes.includes('shared publisher watchdog: watchdog check'),
    'directory refresh should revive a child publisher reporting an error'
  );
  assert.equal(publisher.health().publisher_error_count, 0);
  assert(publisher.health().newest_publisher_success_at);

  publisher.stop();
  assert.equal(created[2].stopCount, 1);
  assert.equal(publisher.health().integration_count, 0);
}

runSharedPublisherChecks()
  .then(() => console.log('Shared Discord inventory publisher checks passed.'))
  .catch(error => {
    console.error(error);
    process.exit(1);
  });
