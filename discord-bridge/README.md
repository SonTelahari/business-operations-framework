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
