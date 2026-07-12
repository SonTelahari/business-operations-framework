# Frontier Firearms - Still Water Discord Bridge

The Still Water storefront posts its embeds to Discord. This bridge reads that dedicated log channel, parses inventory and sale events, and forwards normalized data to the Still Water operating workbook.

## Setup

1. Enable Message Content Intent for the Still Water reader bot.
2. Give the bot access to the Still Water storefront log channel.
3. Copy `.env.example` to `.env`.
4. Fill in the Still Water bot token, channel ID, and Apps Script `/exec` URL.
5. Run `install.cmd`, then `test-parser.cmd`.
6. Use `check-channel.cmd` after real Still Water storefront events exist.
7. Start with `start.cmd`.

The parser initially uses Discord item labels as product names. As products are captured, `app/items.js` will supply exact game-tag and custom-label mappings.
