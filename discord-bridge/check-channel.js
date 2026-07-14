const path = require('path');
const { parseStillWaterEmbed } = require('./parser');
const { embedToText, loadEnvFile, normalizeSnowflake } = require('./runtime-utils');

loadEnvFile(path.join(__dirname, '.env'));

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const DISCORD_CHANNEL_ID = normalizeSnowflake(process.env.DISCORD_CHANNEL_ID);

if (!DISCORD_TOKEN || !DISCORD_CHANNEL_ID) {
  console.error('Missing DISCORD_TOKEN or DISCORD_CHANNEL_ID in .env.');
  process.exit(1);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});

async function main() {
  const bot = await discordGet('/users/@me');
  console.log(`Bot token works: ${bot.username}#${bot.discriminator || '0'} (${bot.id})`);

  const channel = await discordGet(`/channels/${DISCORD_CHANNEL_ID}`);
  console.log(`Channel found: ${channel.name || channel.id} (${channel.id}), type=${channel.type}`);

  const messages = await discordGet(`/channels/${DISCORD_CHANNEL_ID}/messages?limit=5`);
  console.log(`Fetched ${messages.length} recent message(s).`);

  for (const message of messages.reverse()) {
    console.log('---');
    console.log(`Message ${message.id}`);
    console.log(`Created: ${message.timestamp}`);
    console.log(`Author: ${message.author?.username || 'unknown'} webhook=${message.webhook_id || 'none'}`);
    console.log(`Embeds: ${message.embeds?.length || 0}`);

    if (!message.embeds?.length && !message.content) {
      console.log('No content or embeds to parse.');
      console.log('If this is a storefront webhook message, enable Message Content Intent in the Discord Developer Portal for this bot.');
      continue;
    }

    const sources = message.embeds?.length
      ? message.embeds.map((embed) => ({
          id: message.id,
          title: embed.title,
          description: embedToText(embed)
        }))
      : [{
          id: message.id,
          title: '',
          description: message.content
        }];

    for (const source of sources) {
      console.log(`Title: ${source.title || '(none)'}`);
      console.log('Raw text:');
      console.log(source.description || '(empty)');
      console.log('Provisional Still Water parse:');
      const payload = parseStillWaterEmbed(source);
      console.log(JSON.stringify(payload, null, 2));
    }
  }
}

async function discordGet(pathname) {
  const response = await fetch(`https://discord.com/api/v10${pathname}`, {
    headers: {
      authorization: `Bot ${DISCORD_TOKEN}`
    }
  });

  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }

  if (!response.ok) {
    throw new Error(`Discord API ${response.status}: ${JSON.stringify(body)}`);
  }

  return body;
}
