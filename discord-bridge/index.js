const { Client, GatewayIntentBits, Partials } = require('discord.js');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { parseFrontierEmbed } = require('./parser');

loadEnvFile(path.join(__dirname, '.env'));

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const DISCORD_CHANNEL_ID = normalizeSnowflake(process.env.DISCORD_CHANNEL_ID);
const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL;
const DEBUG_DISCORD = process.env.DEBUG_DISCORD !== '0';
const PORT = numberValue(process.env.PORT);

if (!DISCORD_TOKEN || !DISCORD_CHANNEL_ID || !APPS_SCRIPT_URL) {
  console.error('Missing DISCORD_TOKEN, DISCORD_CHANNEL_ID, or APPS_SCRIPT_URL.');
  process.exit(1);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  partials: [Partials.Channel]
});

client.once('clientReady', () => {
  logInfo(`Frontier Firearms - Still Water bridge logged in as ${client.user.tag}`);
  logInfo(`Watching Discord channel ID: ${DISCORD_CHANNEL_ID}`);
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

  const payloads = message.embeds.length
    ? message.embeds.map((embed, index) => parseFrontierEmbed({
        id: message.embeds.length > 1 ? `${message.id}-${index + 1}` : message.id,
        title: embed.title,
        description: embedToText(embed)
      }))
    : [parseFrontierEmbed({
        id: message.id,
        title: '',
        description: message.content
      })];

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

  logInfo(`Forwarded ${payload.event_type} for ${payload.item_name} x${payload.quantity}: ${resultText}`);
}

function startHealthServer() {
  if (!PORT) return;

  const server = http.createServer((request, response) => {
    if (request.url === '/health' || request.url === '/') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        ok: true,
        service: 'frontier-firearms-still-water-discord-bridge',
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

function embedToText(embed) {
  const parts = [];
  if (embed.description) parts.push(embed.description);

  for (const field of embed.fields || []) {
    parts.push(`${field.name}:\n${field.value}`);
  }

  return parts.join('\n');
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

function normalizeSnowflake(value) {
  const match = String(value || '').match(/\d{15,25}/);
  return match ? match[0] : String(value || '').trim();
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
