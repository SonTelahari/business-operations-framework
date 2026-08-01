const fs = require('fs');
const path = require('path');
const { parseStillWaterEmbed } = require('./parser');
const { loadEnvFile } = require('./runtime-utils');

loadEnvFile(path.join(__dirname, '.env'));

const BUSINESS_API_URL = String(process.env.BUSINESS_API_URL || '').trim().replace(/\/+$/, '');
const BRIDGE_API_TOKEN = String(process.env.BRIDGE_API_TOKEN || '').trim();
const CAPTURE_FILE = path.join(__dirname, 'captures', 'events.jsonl');
const commit = process.argv.includes('--commit');

if (!BUSINESS_API_URL || !BRIDGE_API_TOKEN) {
  console.error('Missing BUSINESS_API_URL or BRIDGE_API_TOKEN in discord-bridge/.env.');
  process.exit(1);
}

if (!fs.existsSync(CAPTURE_FILE)) {
  console.error(`Capture journal not found: ${CAPTURE_FILE}`);
  process.exit(1);
}

run().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});

async function run() {
  const records = readUniqueRecords(CAPTURE_FILE);
  const payloads = records.map(toPayload);
  const invalid = payloads.filter(payload => !payload.item_name || !payload.quantity);
  if (invalid.length) {
    throw new Error(`${invalid.length} captured records did not parse into item movements.`);
  }

  const summary = summarize(payloads);
  if (!commit) {
    console.log(JSON.stringify({ mode: 'dry-run', records: payloads.length, ...summary }));
    console.log('Dry run only. Re-run with --commit to post journal records.');
    return;
  }

  let written = 0;
  let duplicates = 0;
  for (const payload of payloads) {
    const result = await forwardToBusinessApi(payload);
    if (result.duplicate) duplicates += 1;
    else if (result.transactionWritten) written += 1;
  }

  console.log(JSON.stringify({ mode: 'commit', records: payloads.length, written, duplicates, ...summary }));
}

function readUniqueRecords(filePath) {
  const unique = new Map();
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const record = JSON.parse(line);
    const id = String(record.discord_message_id || '');
    if (!id) throw new Error('Capture journal contains a record without a Discord message ID.');
    if (!unique.has(id)) unique.set(id, record);
  }
  return [...unique.values()];
}

function toPayload(record) {
  const payload = parseStillWaterEmbed({
    id: record.discord_message_id,
    title: record.title,
    description: record.description
  });
  return {
    ...payload,
    discord_message_id: record.discord_message_id,
    discord_channel_id: record.discord_channel_id,
    timestamp: record.timestamp
  };
}

function summarize(payloads) {
  return payloads.reduce((summary, payload) => {
    summary.quantity += Number(payload.quantity || 0);
    summary.events[payload.event_type] = (summary.events[payload.event_type] || 0) + 1;
    summary.items[payload.item_name] = (summary.items[payload.item_name] || 0) + Number(payload.quantity || 0);
    return summary;
  }, { quantity: 0, events: {}, items: {} });
}

async function forwardToBusinessApi(payload) {
  const response = await fetch(`${BUSINESS_API_URL}/api/integrations/discord/events`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      authorization: `Bearer ${BRIDGE_API_TOKEN}`
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30000)
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Business API ${response.status}: ${text}`);

  let result;
  try {
    result = JSON.parse(text);
  } catch {
    throw new Error(`Business API returned non-JSON content: ${text.slice(0, 200)}`);
  }
  if (result.ok === false) throw new Error(result.error || text);
  return result;
}
