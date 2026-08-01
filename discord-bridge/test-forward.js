const path = require('path');
const { parseStillWaterEmbed } = require('./parser');
const { loadEnvFile } = require('./runtime-utils');

loadEnvFile(path.join(__dirname, '.env'));

const BUSINESS_API_URL = String(process.env.BUSINESS_API_URL || '').trim().replace(/\/+$/, '');
const BRIDGE_API_TOKEN = String(process.env.BRIDGE_API_TOKEN || '').trim();

if (!BUSINESS_API_URL || !BRIDGE_API_TOKEN) {
  console.error('Missing BUSINESS_API_URL or BRIDGE_API_TOKEN. Add both to discord-bridge/.env first.');
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

forwardToBusinessApi({
  ...payload,
  discord_message_id: payload.webhook_id,
  discord_channel_id: 'local-test',
  timestamp: new Date().toISOString()
}).catch((error) => {
  console.error(error);
  process.exit(1);
});

async function forwardToBusinessApi(body) {
  const response = await fetch(`${BUSINESS_API_URL}/api/integrations/discord/events`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${BRIDGE_API_TOKEN}`
    },
    body: JSON.stringify(body)
  });

  const text = await response.text();
  console.log(text);

  if (!response.ok) {
    process.exit(1);
  }

  try {
    const result = JSON.parse(text);
    if (result.ok === false) {
      console.error(`Business API rejected the test payload: ${result.error || text}`);
      process.exit(1);
    }
  } catch (error) {
    if (text.trim().startsWith('{')) throw error;
  }
}
