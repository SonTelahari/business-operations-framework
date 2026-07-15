const { Client, GatewayIntentBits, Partials } = require('discord.js');
const http = require('http');
const path = require('path');
const { appendCaptureRecord, createCaptureRecord, serializeCaptureRecord } = require('./capture');
const { parseStillWaterEmbed } = require('./parser');
const { embedToText, loadEnvFile, normalizeSnowflake } = require('./runtime-utils');

loadEnvFile(path.join(__dirname, '.env'));

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const DISCORD_CHANNEL_ID = normalizeSnowflake(process.env.DISCORD_CHANNEL_ID);
const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL;
const CAPTURE_ONLY = process.env.CAPTURE_ONLY !== '0';
const DEBUG_DISCORD = process.env.DEBUG_DISCORD !== '0';
const PORT = numberValue(process.env.PORT);
const CAPTURE_FILE = path.join(__dirname, 'captures', 'events.jsonl');

if (!DISCORD_TOKEN || !DISCORD_CHANNEL_ID || (!CAPTURE_ONLY && !APPS_SCRIPT_URL)) {
  console.error('Missing DISCORD_TOKEN or DISCORD_CHANNEL_ID. APPS_SCRIPT_URL is also required when CAPTURE_ONLY=0.');
  process.exit(1);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  partials: [Partials.Channel]
});

client.once('clientReady', () => {
  logInfo(`Frontier Firearms - Still Water bridge logged in as ${client.user.tag}`);
  logInfo(`Watching Discord channel ID: ${DISCORD_CHANNEL_ID}`);
  logInfo(`Parser mode: ${CAPTURE_ONLY ? 'capture only' : 'forward to sheet'}`);
  logInfo(`Discord debug logging: ${DEBUG_DISCORD ? 'on' : 'off'}`);
  startHealthServer();
});

client.on('messageCreate', async (message) => {
  if (DEBUG_DISCORD) {
    logInfo(
      `Saw message channel=${message.channelId} author=${message.author?.tag || 'unknown'} webhook=${message.webhookId || 'none'} embeds=${message.embeds.length}`
    );
  }

  if (message.channelId !== DISCORD_CHANNEL_ID) {
    if (DEBUG_DISCORD) {
      logInfo(`Ignored channel ${message.channelId}; expected ${DISCORD_CHANNEL_ID}`);
    }
    return;
  }

  if (!message.embeds.length && !message.content) {
    logWarn(`Skipped empty message in watched channel: ${message.id}`);
    return;
  }

  const sources = message.embeds.length
    ? message.embeds.map((embed, index) => ({
        id: message.embeds.length > 1 ? `${message.id}-${index + 1}` : message.id,
        title: embed.title,
        description: embedToText(embed)
      }))
    : [{
        id: message.id,
        title: '',
        description: message.content
      }];

  if (CAPTURE_ONLY) {
    for (const source of sources) {
      const record = createCaptureRecord(message, source);
      appendCaptureRecord(CAPTURE_FILE, record);
      logInfo(`CAPTURE ${serializeCaptureRecord(record)}`);
    }
    return;
  }

  const payloads = sources.map(parseStillWaterEmbed);

  for (const payload of payloads) {
    if (!payload.item_name || !payload.quantity) {
      logWarn(`Skipped message because it did not parse into an item movement: ${message.id}`);
      continue;
    }

    try {
      await forwardToSheet({
        ...payload,
        discord_message_id: message.id,
        discord_channel_id: message.channelId,
        timestamp: message.createdAt.toISOString()
      });
    } catch (error) {
      logError(`Failed to forward Discord message ${message.id}: ${error.message}`);
    }
  }
});

client.on('error', (error) => {
  logError(`Discord client error: ${error.message}`);
});

client.on('shardDisconnect', (event) => {
  logWarn(`Discord disconnected: code=${event.code} reason=${event.reason || 'none'}`);
});

client.on('shardReconnecting', () => {
  logInfo('Discord reconnecting...');
});

async function forwardToSheet(payload) {
  const response = await fetch(APPS_SCRIPT_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Apps Script rejected payload (${response.status}): ${body}`);
  }

  const resultText = await response.text().catch(() => '');
  const result = parseJson(resultText);
  if (result && result.ok === false) {
    throw new Error(`Apps Script rejected payload: ${result.error || resultText}`);
  }

  const controls = [
    payload.current_item_total !== null && payload.current_item_total !== undefined
      ? `stock control=${payload.current_item_total}`
      : "",
    payload.shop_ledger !== null && payload.shop_ledger !== undefined
      ? `ledger control=$${payload.shop_ledger}`
      : ""
  ].filter(Boolean).join(", ");
  logInfo(`Forwarded ${payload.event_type} for ${payload.item_name} x${payload.quantity}${controls ? ` / ${controls}` : ""}: ${resultText}`);
}

function startHealthServer() {
  if (!PORT) return;

  const server = http.createServer((request, response) => {
    if (request.url === '/health' || request.url === '/') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        ok: true,
        service: 'frontier-firearms-still-water-discord-bridge',
        mode: CAPTURE_ONLY ? 'capture' : 'forward',
        parser_profile: 'still-water',
        capture_journal: CAPTURE_ONLY,
        discord_ready: client.isReady(),
        uptime_seconds: Math.round(process.uptime())
      }));
      return;
    }

    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: false, error: 'not found' }));
  });

  server.listen(PORT, () => {
    logInfo(`Health server listening on port ${PORT}`);
  });
}

function numberValue(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function logInfo(message) {
  console.log(`[${new Date().toISOString()}] INFO ${message}`);
}

function logWarn(message) {
  console.warn(`[${new Date().toISOString()}] WARN ${message}`);
}

function logError(message) {
  console.error(`[${new Date().toISOString()}] ERROR ${message}`);
}

client.login(DISCORD_TOKEN);
