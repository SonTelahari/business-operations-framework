const { Client, GatewayIntentBits, Partials } = require('discord.js');
const http = require('http');
const path = require('path');
const { appendCaptureRecord, createCaptureRecord, serializeCaptureRecord } = require('./capture');
const { createInventoryPublisher } = require('./inventory-publisher');
const { createSharedInventoryPublisher } = require('./shared-inventory-publisher');
const { parseStillWaterEmbed } = require('./parser');
const { embedToText, loadEnvFile, normalizeSnowflake, prepareSheetPayload } = require('./runtime-utils');

loadEnvFile(path.join(__dirname, '.env'));

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const DISCORD_CHANNEL_ID = normalizeSnowflake(process.env.DISCORD_CHANNEL_ID);
const SHARED_BUSINESS_MODE = process.env.SHARED_BUSINESS_MODE === '1';
const BUSINESS_API_URL = String(process.env.BUSINESS_API_URL || '').trim().replace(/\/+$/, '');
const BRIDGE_API_TOKEN = String(process.env.BRIDGE_API_TOKEN || '').trim();
const EVENT_API_URL = BUSINESS_API_URL ? `${BUSINESS_API_URL}/api/integrations/discord/events` : '';
const SNAPSHOT_API_URL = BUSINESS_API_URL
  ? `${BUSINESS_API_URL}/api/integrations/discord/snapshot${!SHARED_BUSINESS_MODE && DISCORD_CHANNEL_ID ? `?discord_channel_id=${encodeURIComponent(DISCORD_CHANNEL_ID)}` : ''}`
  : '';
const CAPTURE_ONLY = process.env.CAPTURE_ONLY !== '0';
const DEBUG_DISCORD = process.env.DEBUG_DISCORD !== '0';
const INVENTORY_CHANNEL_ID = normalizeSnowflake(process.env.INVENTORY_CHANNEL_ID);
const STOCK_ALERT_CHANNEL_ID = normalizeSnowflake(process.env.STOCK_ALERT_CHANNEL_ID);
const INVENTORY_MESSAGE_ID = normalizeSnowflake(process.env.INVENTORY_MESSAGE_ID);
const STOCK_ALERT_MESSAGE_ID = normalizeSnowflake(process.env.STOCK_ALERT_MESSAGE_ID);
const INVENTORY_REFRESH_SECONDS = numberValue(process.env.INVENTORY_REFRESH_SECONDS) || 300;
const PORT = numberValue(process.env.PORT);
const CAPTURE_FILE = path.join(__dirname, 'captures', 'events.jsonl');
const INVENTORY_PUBLISHING_REQUESTED = Boolean(INVENTORY_CHANNEL_ID || STOCK_ALERT_CHANNEL_ID);

if (!DISCORD_TOKEN || (!SHARED_BUSINESS_MODE && !DISCORD_CHANNEL_ID)
  || ((!CAPTURE_ONLY || INVENTORY_PUBLISHING_REQUESTED || SHARED_BUSINESS_MODE) && (!BUSINESS_API_URL || !BRIDGE_API_TOKEN))) {
  console.error(
    'Missing DISCORD_TOKEN or channel configuration. Shared mode needs BUSINESS_API_URL and BRIDGE_API_TOKEN; single-business mode also needs DISCORD_CHANNEL_ID.'
  );
  process.exit(1);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  partials: [Partials.Channel]
});
const publisherLogger = { info: logInfo, warn: logWarn, error: logError };
const inventoryPublisher = SHARED_BUSINESS_MODE
  ? createSharedInventoryPublisher({
      client,
      apiBaseUrl: BUSINESS_API_URL,
      apiToken: BRIDGE_API_TOKEN,
      refreshMs: INVENTORY_REFRESH_SECONDS * 1000,
      directoryRefreshMs: Math.min(INVENTORY_REFRESH_SECONDS, 60) * 1000,
      logger: publisherLogger
    })
  : createInventoryPublisher({
      client,
      snapshotUrl: SNAPSHOT_API_URL,
      requestHeaders: { authorization: `Bearer ${BRIDGE_API_TOKEN}` },
      inventoryChannelId: INVENTORY_CHANNEL_ID,
      alertChannelId: STOCK_ALERT_CHANNEL_ID,
      inventoryMessageId: INVENTORY_MESSAGE_ID,
      alertMessageId: STOCK_ALERT_MESSAGE_ID,
      refreshMs: INVENTORY_REFRESH_SECONDS * 1000,
      logger: publisherLogger
    });

client.once('clientReady', () => {
  logInfo(`Frontier Firearms - Still Water bridge logged in as ${client.user.tag}`);
  logInfo(SHARED_BUSINESS_MODE ? 'Watching registered business channels' : `Watching Discord channel ID: ${DISCORD_CHANNEL_ID}`);
  logInfo(`Parser mode: ${CAPTURE_ONLY ? 'capture only' : 'forward to business API'}`);
  logInfo(`Discord debug logging: ${DEBUG_DISCORD ? 'on' : 'off'}`);
  logInfo(`Discord inventory publishing: ${inventoryPublisher.enabled ? 'on' : 'off'}`);
  startHealthServer();
  inventoryPublisher.start().catch(error => {
    logError(`Unable to start Discord inventory publishing: ${error.message}`);
  });
});

client.on('messageCreate', async (message) => {
  if (DEBUG_DISCORD) {
    logInfo(
      `Saw message channel=${message.channelId} author=${message.author?.tag || 'unknown'} webhook=${message.webhookId || 'none'} embeds=${message.embeds.length}`
    );
  }

  if (!SHARED_BUSINESS_MODE && message.channelId !== DISCORD_CHANNEL_ID) {
    if (DEBUG_DISCORD) {
      logInfo(`Ignored channel ${message.channelId}; expected ${DISCORD_CHANNEL_ID}`);
    }
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
    try {
      const outboundPayload = prepareSheetPayload({
        ...payload,
        discord_message_id: message.id,
        discord_channel_id: message.channelId,
        timestamp: message.createdAt.toISOString()
      });
      await forwardToBusinessApi(outboundPayload);
      if (SHARED_BUSINESS_MODE) {
        inventoryPublisher.requestRefresh('business event', message.channelId);
      } else {
        inventoryPublisher.requestRefresh('storefront event');
      }
      if (payload.review_required) {
        logWarn(`Sent Discord message ${message.id} to review: ${payload.review_reason || 'parser review required'}`);
      }
    } catch (error) {
      logError(`Failed to forward Discord message ${message.id}: ${error.message}`);
    }
  }
});

client.on('interactionCreate', async (interaction) => {
  try {
    await inventoryPublisher.handleInteraction(interaction);
  } catch (error) {
    logError(`Discord inventory control failed: ${error.message}`);
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

async function forwardToBusinessApi(payload) {
  const response = await fetch(EVENT_API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      authorization: `Bearer ${BRIDGE_API_TOKEN}`
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Business API rejected payload (${response.status}): ${body}`);
  }

  const resultText = await response.text().catch(() => '');
  const result = parseJson(resultText);
  if (result && result.ok === false) {
    throw new Error(`Business API rejected payload: ${result.error || resultText}`);
  }

  const controls = [
    payload.current_item_total !== null && payload.current_item_total !== undefined
      ? `stock control=${payload.current_item_total}`
      : "",
    payload.shop_ledger !== null && payload.shop_ledger !== undefined
      ? `ledger control=$${payload.shop_ledger}`
      : ""
  ].filter(Boolean).join(", ");
  const itemName = payload.item_name || payload.proposed_item_name || 'unresolved item';
  const quantity = payload.quantity || payload.proposed_quantity || 0;
  logInfo(`Forwarded ${payload.event_type} for ${itemName} x${quantity}${controls ? ` / ${controls}` : ""}: ${resultText}`);
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
        inventory_publisher: inventoryPublisher.health(),
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
