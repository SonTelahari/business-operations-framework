# Frontier Firearms - Still Water Discord Bridge

The Still Water storefront posts its embeds to Discord. This bridge reads that dedicated log channel, parses inventory and sale events, and forwards normalized data to the Still Water operating workbook.

## Parser Intake Mode

Still Water message formats must be learned from real storefront events. The bridge therefore defaults to `CAPTURE_ONLY=1`. In this mode it watches the configured channel, prints one single-line `CAPTURE` record for every message, and appends the same JSON record to `captures/events.jsonl`, but does not send anything to Google Sheets.

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
8. After the dedicated parser is verified, add the Apps Script `/exec` URL and set `CAPTURE_ONLY=0`.

The provisional parser uses Discord item labels as product names. As events are captured, `app/items.js` will supply exact game-tag and custom-label mappings.

## Live Storefront Overview

The bridge can maintain two bot-authored Discord messages from the shared Apps Script inventory:

- `INVENTORY_CHANNEL_ID` enables a paged storefront overview with current units, targets, sale prices, total stock, and known stock value.
- `STOCK_ALERT_CHANNEL_ID` enables a shortage message listing only products below their storefront targets.

Both messages are edited in place. The bridge refreshes them after a successfully forwarded storefront event and every `INVENTORY_REFRESH_SECONDS` seconds, with a minimum interval of 30 seconds. The default is 300 seconds. This fallback refresh also picks up manual counts, target changes, and GUI adjustments that did not originate in Discord.

Give the bot `View Channel`, `Send Messages`, `Embed Links`, and `Read Message History` in both destination channels. A dedicated channel is recommended. The first refresh creates the managed message and logs its ID. The bridge normally finds that message again from recent channel history after a restart. For busy channels, set the logged ID explicitly as `INVENTORY_MESSAGE_ID` or `STOCK_ALERT_MESSAGE_ID` so restarts can never create a replacement.

The publisher is optional. Leave both channel IDs blank to disable it. `APPS_SCRIPT_URL` is required whenever either publisher channel is configured, even in capture-only parser mode.
