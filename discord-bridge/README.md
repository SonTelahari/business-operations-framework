# Business Operations Discord Bridge

The storefront posts its embeds to Discord. This bridge reads the event channel, parses inventory and sale events, and forwards normalized data to the Business Operations API.

## Parser Intake Mode

New message formats should be learned from real storefront events. The bridge therefore defaults to `CAPTURE_ONLY=1`. In this mode it watches the configured channel, prints one single-line `CAPTURE` record for every message, and appends the same JSON record to `captures/events.jsonl`, but does not forward movements to the app.

Capture at least one example of each available event:

- Storefront deposit
- Storefront withdrawal
- Customer purchase
- Customer sale to the store or buy-order fill

The ignored local capture journal preserves event order and Discord message IDs for later replay into the sheet. The `CAPTURE` lines from the host logs, journal, or raw text printed by `check-channel.cmd` are the inputs needed to finish the dedicated Still Water parser. Keep `CAPTURE_ONLY=1` until those samples have parser tests. Set `CAPTURE_ONLY=0` only after the tests pass and the receiver is ready.

Discord message IDs are the transaction identity used for deduplication. Storefront `Weapon ID` values are server-side instance metadata and are intentionally not mapped into inventory records.

Run `npm run replay:captures` for a read-only journal summary. After verifying the target receiver, run `npm run replay:captures -- --commit` to post every unique capture. Re-running commit mode is safe because the receiver deduplicates by Discord message ID.

## Setup

1. Enable Message Content Intent for the Still Water reader bot.
2. Give the bot access to the Still Water storefront log channel.
3. Copy `.env.example` to `.env`.
4. Fill in the Still Water bot token and channel ID. Keep `CAPTURE_ONLY=1`.
5. Run `install.cmd`, then `test-parser.cmd`.
6. Start with `start.cmd` and trigger real Still Water storefront events.
7. Use `check-channel.cmd` to print the latest raw messages when needed.
8. After the dedicated parser is verified, set `BUSINESS_API_URL`, match `BRIDGE_API_TOKEN`, and set `CAPTURE_ONLY=0`.

The parser uses Discord item labels and game tags, then resolves exact names and saved aliases against each business's live catalog.

## Live Storefront Overview

The bridge can maintain two bot-authored Discord messages from the app's storefront snapshot:

- `INVENTORY_CHANNEL_ID` enables a paged storefront overview with current units, targets, sale prices, total stock, and known stock value. Only active products with a target greater than zero are listed.
- `STOCK_ALERT_CHANNEL_ID` enables a shortage message listing only products below their storefront targets.

Both messages are edited in place. The bridge refreshes them after a successfully forwarded storefront event and every `INVENTORY_REFRESH_SECONDS` seconds, with a minimum interval of 30 seconds. The default is 300 seconds. This fallback refresh also picks up manual counts, target changes, and GUI adjustments that did not originate in Discord. Adding a target brings the product into the overview on the next refresh; removing or zeroing a target removes it.

Give the bot `View Channel`, `Send Messages`, `Embed Links`, and `Read Message History` in both destination channels. A dedicated channel is recommended. The first refresh creates the managed message and logs its ID. The bridge normally finds that message again from recent channel history after a restart. For busy channels, set the logged ID explicitly as `INVENTORY_MESSAGE_ID` or `STOCK_ALERT_MESSAGE_ID` so restarts can never create a replacement.

The publisher is optional. Leave both channel IDs blank to disable it. `BUSINESS_API_URL` and `BRIDGE_API_TOKEN` are required whenever publishing is enabled.

## Shared Hosted Mode

Set `SHARED_BUSINESS_MODE=1` and leave `DISCORD_CHANNEL_ID` blank to run one bot for multiple businesses. The bridge watches the channels visible to the bot. The API uses the Discord event channel ID to route each movement to its registered workspace; unknown channels are rejected. Each workspace admin configures its event, inventory, and alert channel IDs in the app.
