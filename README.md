# Frontier Firearms - Still Water

Still Water server edition of the Frontier Firearms business system.

This project preserves the order desk, production planning, storefront targets, manual counts, ledger adjustments, employee time clock, payroll, Discord parser, Google Sheets receiver, and hosting setup from the original project. Its catalog contains Still Water data only, preventing server economies from being mixed.

## Initial Weapon Categories

- Rifles
- Bows
- Misc
- Shotguns
- Repeaters
- Revolvers
- Pistols

These are page 1 of 7 from the Still Water crafting menu. Additional categories will be added as screenshots arrive.

## Data Intake

For each product, record:

- Product name
- In-game item tag
- Display or custom label
- Category
- Sale price
- Recipe ingredients and quantities
- Wiki link, when available

## Safety

- No Discord token, channel ID, Apps Script URL, spreadsheet ID, transaction history, employee data, or local browser state was copied.
- `webhook/Code.gs` contains a Still Water spreadsheet placeholder and cannot write to the original workbook.
- Create a new `.env` from `discord-bridge/.env.example` only after the Still Water Discord channel and receiver exist.
- The local GUI uses port `4273` and separate browser-storage keys to prevent cross-server data mixing.

See `docs/categories.md` for captured category sources and `docs/hosting.md` for deployment details.
