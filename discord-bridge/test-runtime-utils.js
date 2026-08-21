const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  createBridgeTelemetry,
  embedToText,
  loadEnvFile,
  normalizeSnowflake,
  prepareSheetPayload,
  resolveCaptureMode
} = require('./runtime-utils');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'still-water-runtime-'));
const envPath = path.join(directory, '.env');
const originalExisting = process.env.RUNTIME_UTIL_EXISTING;

try {
  process.env.RUNTIME_UTIL_EXISTING = 'keep-me';
  fs.writeFileSync(envPath, [
    '# ignored',
    'RUNTIME_UTIL_NEW="loaded value"',
    'RUNTIME_UTIL_EXISTING=replace-me',
    'INVALID_LINE'
  ].join('\n'));
  loadEnvFile(envPath);

  assert.equal(process.env.RUNTIME_UTIL_NEW, 'loaded value');
  assert.equal(process.env.RUNTIME_UTIL_EXISTING, 'keep-me');
  assert.equal(normalizeSnowflake('id1510695972798201967'), '1510695972798201967');
  assert.equal(embedToText({
    description: 'Shop Info',
    fields: [{ name: 'Item Info', value: 'Item name: test' }]
  }), 'Shop Info\nItem Info:\nItem name: test');
  assert.deepEqual(prepareSheetPayload({
    item_name: 'Unknown Custom Label',
    quantity: 5,
    review_required: true
  }), {
    item_name: '',
    quantity: 0,
    proposed_item_name: 'Unknown Custom Label',
    proposed_quantity: 5,
    review_required: true
  });
  assert.deepEqual(prepareSheetPayload({ item_name: 'Iron', quantity: 5 }), { item_name: 'Iron', quantity: 5 });

  assert.deepEqual(resolveCaptureMode({ CAPTURE_ONLY: '1' }), { captureOnly: true, source: 'explicit' });
  assert.deepEqual(resolveCaptureMode({ CAPTURE_ONLY: 'false' }), { captureOnly: false, source: 'explicit' });
  assert.deepEqual(resolveCaptureMode({
    BUSINESS_API_URL: 'https://operations.example.test',
    BRIDGE_API_TOKEN: 'secret'
  }), { captureOnly: false, source: 'api-configured-default' });
  assert.deepEqual(resolveCaptureMode({}), { captureOnly: true, source: 'capture-safe-default' });
  assert.throws(() => resolveCaptureMode({ CAPTURE_ONLY: 'maybe' }), /must be 1 or 0/);

  let tick = 0;
  const telemetry = createBridgeTelemetry(() => `time-${++tick}`);
  telemetry.discordReady();
  telemetry.messageSeen({ id: 'message-1', channelId: 'channel-1' });
  telemetry.messageRelevant();
  telemetry.forwardAttempt();
  telemetry.forwardFailure(new Error('temporary failure'));
  telemetry.forwardAttempt();
  telemetry.forwardSuccess();
  const health = telemetry.health();
  assert.equal(health.seen_messages, 1);
  assert.equal(health.relevant_messages, 1);
  assert.equal(health.failed_payloads, 1);
  assert.equal(health.forwarded_payloads, 1);
  assert.equal(health.last_forward_error, '');
  assert.equal(health.last_message_id, 'message-1');
  assert.equal(health.last_channel_id, 'channel-1');
  console.log('Shared Discord runtime utility checks passed.');
} finally {
  delete process.env.RUNTIME_UTIL_NEW;
  if (originalExisting === undefined) delete process.env.RUNTIME_UTIL_EXISTING;
  else process.env.RUNTIME_UTIL_EXISTING = originalExisting;
  fs.rmSync(directory, { recursive: true, force: true });
}
