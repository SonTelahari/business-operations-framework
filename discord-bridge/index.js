const { Client, GatewayIntentBits, Partials } = require('discord.js');
const http = require('http');
const path = require('path');
const { appendCaptureRecord, createCaptureRecord, serializeCaptureRecord } = require('./capture');
const { createRegisteredChannelBackfill, normalizeBackfillLimit } = require('./channel-backfill');
const { createInventoryPublisher } = require('./inventory-publisher');
const { createSharedInventoryPublisher } = require('./shared-inventory-publisher');
const { parseStillWaterEmbed } = require('./parser');
const {
  createBridgeTelemetry,
  embedToText,
  loadEnvFile,
  normalizeSnowflake,
  prepareSheetPayload,
  resolveCaptureMode
} = require('./runtime-utils');

loadEnvFile(path.join(__dirname, '.env'));

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const DISCORD_CHANNEL_ID = normalizeSnowflake(process.env.DISCORD_CHANNEL_ID);
const SHARED_BUSINESS_MODE = process.env.SHARED_BUSINESS_MODE === '1';
const BUSINESS_API_URL = String(process.env.BUSINESS_API_URL || '').trim().replace(/\/+$/, '');
const BRIDGE_API_TOKEN = String(process.env.BRIDGE_API_TOKEN || '').trim();
const EVENT_API_URL = BUSINESS_API_URL ? `${BUSINESS_API_URL}/api/integrations/discord/events` : '';
const HEARTBEAT_API_URL = BUSINESS_API_URL ? `${BUSINESS_API_URL}/api/integrations/discord/heartbeat` : '';
const SNAPSHOT_API_URL = BUSINESS_API_URL
  ? `${BUSINESS_API_URL}/api/integrations/discord/snapshot${!SHARED_BUSINESS_MODE && DISCORD_CHANNEL_ID ? `?discord_channel_id=${encodeURIComponent(DISCORD_CHANNEL_ID)}` : ''}`
  : '';
let captureMode;
try {
  captureMode = resolveCaptureMode(process.env);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
const CAPTURE_ONLY = captureMode.captureOnly;
const DEBUG_DISCORD = process.env.DEBUG_DISCORD !== '0';
const INVENTORY_CHANNEL_ID = normalizeSnowflake(process.env.INVENTORY_CHANNEL_ID);
const STOCK_ALERT_CHANNEL_ID = normalizeSnowflake(process.env.STOCK_ALERT_CHANNEL_ID);
const INVENTORY_MESSAGE_ID = normalizeSnowflake(process.env.INVENTORY_MESSAGE_ID);
const STOCK_ALERT_MESSAGE_ID = normalizeSnowflake(process.env.STOCK_ALERT_MESSAGE_ID);
const INVENTORY_REFRESH_SECONDS = numberValue(process.env.INVENTORY_REFRESH_SECONDS) || 300;
const BRIDGE_HEARTBEAT_SECONDS = Math.max(15, numberValue(process.env.BRIDGE_HEARTBEAT_SECONDS) || 30);
const BRIDGE_BACKFILL_MESSAGES = normalizeBackfillLimit(process.env.BRIDGE_BACKFILL_MESSAGES);
const BRIDGE_BACKFILL_INTERVAL_SECONDS = Math.max(60, numberValue(process.env.BRIDGE_BACKFILL_INTERVAL_SECONDS) || 900);
const PORT = numberValue(process.env.PORT);
const CAPTURE_FILE = path.join(__dirname, 'captures', 'events.jsonl');
const INVENTORY_PUBLISHING_REQUESTED = Boolean(INVENTORY_CHANNEL_ID || STOCK_ALERT_CHANNEL_ID);
const telemetry = createBridgeTelemetry();
let heartbeatInterval = null;
let channelBackfillInterval = null;

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
const channelBackfill = createRegisteredChannelBackfill({
  client,
  apiBaseUrl: SHARED_BUSINESS_MODE && !CAPTURE_ONLY ? BUSINESS_API_URL : '',
  apiToken: BRIDGE_API_TOKEN,
  limit: BRIDGE_BACKFILL_MESSAGES,
  processMessage: processDiscordMessage,
  logger: publisherLogger
});

client.once('clientReady', () => {
  telemetry.discordReady();
  logInfo(`Business Operations bridge logged in as ${client.user.tag}`);
  logInfo(SHARED_BUSINESS_MODE ? 'Watching registered business channels' : `Watching Discord channel ID: ${DISCORD_CHANNEL_ID}`);
  logInfo(`Parser mode: ${CAPTURE_ONLY ? 'capture only' : 'forward to business API'} (${captureMode.source})`);
  logInfo(`Discord debug logging: ${DEBUG_DISCORD ? 'on' : 'off'}`);
  logInfo(`Discord inventory publishing: ${inventoryPublisher.enabled ? 'on' : 'off'}`);
  startHealthServer();
  startHeartbeat();
  inventoryPublisher.start().catch(error => {
    logError(`Unable to start Discord inventory publishing: ${error.message}`);
  });
  startChannelBackfill();
});

client.on('messageCreate', (message) => {
  processDiscordMessage(message).catch(error => {
    telemetry.forwardFailure(error);
    logError(`Unable to process Discord message ${message.id}: ${error.message}`);
  });
});

async function processDiscordMessage(message, options = {}) {
  const trackTelemetry = options.trackTelemetry !== false;
  const summary = { payloads: 0, duplicates: 0, applied: 0, review: 0, errors: 0 };
  if (trackTelemetry) telemetry.messageSeen(message);
  if (DEBUG_DISCORD) {
    logInfo(
      `Saw message channel=${message.channelId} author=${message.author?.tag || 'unknown'} webhook=${message.webhookId || 'none'} embeds=${message.embeds.length}`
    );
  }

  if (!SHARED_BUSINESS_MODE && message.channelId !== DISCORD_CHANNEL_ID) {
    if (trackTelemetry) telemetry.messageIgnored();
    if (DEBUG_DISCORD) {
      logInfo(`Ignored channel ${message.channelId}; expected ${DISCORD_CHANNEL_ID}`);
    }
    return summary;
  }
  if (trackTelemetry) telemetry.messageRelevant();

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
      if (trackTelemetry) telemetry.payloadCaptured();
      logInfo(`CAPTURE ${serializeCaptureRecord(record)}`);
      summary.payloads += 1;
    }
    return summary;
  }

  const payloads = sources.map(parseStillWaterEmbed);

  for (const payload of payloads) {
    summary.payloads += 1;
    if (trackTelemetry) telemetry.forwardAttempt();
    try {
      const outboundPayload = prepareSheetPayload({
        ...payload,
        discord_message_id: message.id,
        discord_channel_id: message.channelId,
        timestamp: message.createdAt.toISOString()
      });
      const result = await forwardToBusinessApi(outboundPayload, {
        quietDuplicate: options.quietDuplicate === true
      });
      if (trackTelemetry) telemetry.forwardSuccess();
      if (result?.duplicate) summary.duplicates += 1;
      else if (result?.reviewRequired) summary.review += 1;
      else summary.applied += 1;
      if (!result?.duplicate) {
        if (SHARED_BUSINESS_MODE) {
          inventoryPublisher.requestRefresh(options.backfill ? 'channel catch-up' : 'business event', message.channelId);
        } else {
          inventoryPublisher.requestRefresh('storefront event');
        }
      }
      if (!result?.duplicate && result?.reviewRequired) {
        logWarn(`Sent Discord message ${message.id} to review: ${result.reviewReason || payload.review_reason || 'review required'}`);
      }
    } catch (error) {
      summary.errors += 1;
      if (trackTelemetry) telemetry.forwardFailure(error);
      logError(`Failed to forward Discord message ${message.id}: ${error.message}`);
    }
  }
  return summary;
}

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

async function forwardToBusinessApi(payload, options = {}) {
  const response = await fetch(EVENT_API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      authorization: `Bearer ${BRIDGE_API_TOKEN}`
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30000)
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
  if (!result?.duplicate || !options.quietDuplicate) {
    logInfo(`Forwarded ${payload.event_type} for ${itemName} x${quantity}${controls ? ` / ${controls}` : ""}: ${resultText}`);
  }
  return result || {};
}

function startHealthServer() {
  if (!PORT) return;

  const server = http.createServer((request, response) => {
    if (request.url === '/health' || request.url === '/') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        ok: true,
        service: 'business-operations-discord-bridge',
        mode: CAPTURE_ONLY ? 'capture' : 'forward',
        mode_source: captureMode.source,
        shared_business_mode: SHARED_BUSINESS_MODE,
        configured_channel_id: SHARED_BUSINESS_MODE ? '' : DISCORD_CHANNEL_ID,
        parser_profile: 'still-water',
        capture_journal: CAPTURE_ONLY,
        discord_ready: client.isReady(),
        events: telemetry.health(),
        inventory_publisher: inventoryPublisher.health(),
        channel_backfill: channelBackfill.health(),
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

function startHeartbeat() {
  if (!HEARTBEAT_API_URL || !BRIDGE_API_TOKEN || heartbeatInterval) return;
  reportHeartbeat().catch(error => logWarn(`Bridge heartbeat failed: ${error.message}`));
  heartbeatInterval = setInterval(() => {
    reportHeartbeat().catch(error => logWarn(`Bridge heartbeat failed: ${error.message}`));
  }, BRIDGE_HEARTBEAT_SECONDS * 1000);
  if (typeof heartbeatInterval.unref === 'function') heartbeatInterval.unref();
}

function startChannelBackfill() {
  if (!channelBackfill.enabled || channelBackfillInterval) return;
  runChannelBackfillWithRetry(1);
  channelBackfillInterval = setInterval(() => {
    channelBackfill.run('periodic').catch(error => {
      logError(`Unable to catch up registered Discord channels: ${error.message}`);
    });
  }, BRIDGE_BACKFILL_INTERVAL_SECONDS * 1000);
  if (typeof channelBackfillInterval.unref === 'function') channelBackfillInterval.unref();
}

function runChannelBackfillWithRetry(attempt) {
  const reason = attempt === 1 ? 'startup' : `startup retry ${attempt - 1}`;
  channelBackfill.run(reason)
    .then(summary => {
      if (summary.errorCount > 0 && attempt < 5) scheduleChannelBackfillRetry(attempt + 1);
    })
    .catch(error => {
      logError(`Unable to catch up registered Discord channels: ${error.message}`);
      if (attempt < 5) scheduleChannelBackfillRetry(attempt + 1);
    });
}

function scheduleChannelBackfillRetry(attempt) {
  const timer = setTimeout(() => runChannelBackfillWithRetry(attempt), 30000);
  if (typeof timer.unref === 'function') timer.unref();
}

async function reportHeartbeat() {
  const response = await fetch(HEARTBEAT_API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      authorization: `Bearer ${BRIDGE_API_TOKEN}`
    },
    body: JSON.stringify({
      mode: CAPTURE_ONLY ? 'capture' : 'forward',
      shared_business_mode: SHARED_BUSINESS_MODE,
      discord_ready: client.isReady(),
      events: telemetry.health()
    }),
    signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Business API rejected heartbeat (${response.status}): ${body}`);
  }
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
