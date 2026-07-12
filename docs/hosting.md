# Hosting - Still Water

Host the Discord bridge as an always-on Node.js service. Leave the repository root directory blank so the deployment includes both `discord-bridge` and the shared catalog in `app/items.js`.

## Commands

```text
npm install
npm start
```

Health check path:

```text
/health
```

## Required Environment Variables

```text
DISCORD_TOKEN=Still Water bot token
DISCORD_CHANNEL_ID=Still Water storefront log channel ID
APPS_SCRIPT_URL=Still Water Apps Script /exec URL
DEBUG_DISCORD=0
```

Use a new Discord bot or clearly separated Still Water channel configuration. Never reuse the original project's `.env` file.

Only one Still Water bridge instance should run at a time.
