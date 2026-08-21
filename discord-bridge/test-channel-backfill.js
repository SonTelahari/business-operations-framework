const assert = require('node:assert/strict');
const {
  createRegisteredChannelBackfill,
  normalizeBackfillLimit,
  registeredInputChannelIds
} = require('./channel-backfill');

assert.equal(normalizeBackfillLimit(undefined), 100);
assert.equal(normalizeBackfillLimit('25'), 25);
assert.equal(normalizeBackfillLimit('0'), 0);
assert.equal(normalizeBackfillLimit('500'), 100);
assert.deepEqual(registeredInputChannelIds([
  { status: 'active', eventChannelId: 'event-a', storageLedgerChannelId: 'storage-a' },
  { status: 'active', eventChannelId: 'event-a', storageLedgerChannelId: 'storage-b' },
  { status: 'inactive', eventChannelId: 'event-inactive', storageLedgerChannelId: 'storage-inactive' },
  { status: 'active', inventoryChannelId: 'output-only' }
]), ['event-a', 'storage-a', 'storage-b']);

async function runBackfillChecks() {
  const processed = [];
  const logs = [];
  const messages = {
    'event-a': new Map([
      ['newer', { id: 'newer', createdTimestamp: 200 }],
      ['older', { id: 'older', createdTimestamp: 100 }]
    ]),
    'storage-a': new Map([
      ['storage', { id: 'storage', createdTimestamp: 150 }]
    ])
  };
  const client = {
    channels: {
      fetch: async channelId => ({
        messages: { fetch: async options => {
          assert.equal(options.limit, 50);
          return messages[channelId];
        } }
      })
    }
  };
  const backfill = createRegisteredChannelBackfill({
    client,
    apiBaseUrl: 'https://operations.example.test/',
    apiToken: 'bridge-token',
    limit: 50,
    fetchImpl: async (url, options) => {
      assert.equal(String(url), 'https://operations.example.test/api/integrations/discord/channels');
      assert.equal(options.headers.authorization, 'Bearer bridge-token');
      return {
        ok: true,
        json: async () => ({
          ok: true,
          integrations: [{
            status: 'active',
            eventChannelId: 'event-a',
            storageLedgerChannelId: 'storage-a'
          }]
        })
      };
    },
    processMessage: async (message, options) => {
      assert.equal(options.backfill, true);
      assert.equal(options.trackTelemetry, false);
      assert.equal(options.quietDuplicate, true);
      processed.push(message.id);
      if (message.id === 'older') return { payloads: 1, duplicates: 1 };
      if (message.id === 'newer') return { payloads: 1, applied: 1 };
      return { payloads: 1, review: 1 };
    },
    logger: {
      info: message => logs.push(message),
      warn: message => logs.push(message),
      error: message => logs.push(message)
    }
  });

  const summary = await backfill.run();
  assert.deepEqual(processed, ['older', 'newer', 'storage']);
  assert.deepEqual(summary, {
    channelCount: 2,
    messageCount: 3,
    payloadCount: 3,
    duplicateCount: 1,
    appliedCount: 1,
    reviewCount: 1,
    errorCount: 0
  });
  assert.equal(backfill.health().last_error, '');
  assert(backfill.health().last_success_at);
  assert(logs.some(message => message.includes('1 applied')));
}

runBackfillChecks()
  .then(() => console.log('Discord registered-channel catch-up checks passed.'))
  .catch(error => {
    console.error(error);
    process.exit(1);
  });
