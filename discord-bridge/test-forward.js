const fs = require('fs');
const path = require('path');
const { parseStillWaterEmbed } = require('./parser');

loadEnvFile(path.join(__dirname, '.env'));

const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL;

if (!APPS_SCRIPT_URL) {
  console.error('Missing APPS_SCRIPT_URL. Add it to discord-bridge/.env first.');
  process.exit(1);
}

const payload = parseStillWaterEmbed({
  id: `still-water-bridge-test-${Date.now()}`,
  title: 'Deposit',
  description: `Shop Info:
Shop name: Frontier Firearms
Server: Still Water
Item Info:
Item name: weapon_test_rifle
Item label: Test Rifle
Deposit Amount: 1
Sell Price: $100.0`
});

forwardToSheet({
  ...payload,
  discord_message_id: payload.webhook_id,
  discord_channel_id: 'local-test',
  timestamp: new Date().toISOString()
}).catch((error) => {
  console.error(error);
  process.exit(1);
});

async function forwardToSheet(body) {
  const response = await fetch(APPS_SCRIPT_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });

  const text = await response.text();
  if (text.includes('Finner ikke skriptfunksjon: doPost') || text.includes('Script function not found: doPost')) {
    console.error('Apps Script URL is reachable, but the deployed web app does not have doPost().');
    console.error('Open Apps Script, paste/update webhook/Code.gs, save it, then create a new web app deployment.');
    console.error('Use the new /exec URL as APPS_SCRIPT_URL in discord-bridge/.env.');
    process.exit(1);
  }

  console.log(text);

  if (!response.ok) {
    process.exit(1);
  }

  try {
    const result = JSON.parse(text);
    if (result.ok === false) {
      console.error(`Apps Script rejected the test payload: ${result.error || text}`);
      process.exit(1);
    }
  } catch (error) {
    if (text.trim().startsWith('{')) throw error;
  }
}

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;

  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const separator = trimmed.indexOf('=');
    if (separator === -1) continue;

    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim().replace(/^['"]|['"]$/g, '');
    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}
