const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { embedToText, loadEnvFile, normalizeSnowflake } = require('./runtime-utils');

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
  console.log('Shared Discord runtime utility checks passed.');
} finally {
  delete process.env.RUNTIME_UTIL_NEW;
  if (originalExisting === undefined) delete process.env.RUNTIME_UTIL_EXISTING;
  else process.env.RUNTIME_UTIL_EXISTING = originalExisting;
  fs.rmSync(directory, { recursive: true, force: true });
}
