# Frontier Firearms - Still Water

Still Water server edition of the Frontier Firearms business system.

This project preserves the order desk, production planning, storefront targets, manual counts, ledger adjustments, employee time clock, payroll, Discord parser, Google Sheets receiver, and hosting setup from the original project. Its catalog contains Still Water data only, preventing server economies from being mixed.

## Employee Accounts

Employees request access with their in-game character name and a password. No real-life name or personal information is requested. New accounts remain pending until an admin or manager approves them in the Staff tab. Passwords are stored only as salted `scrypt` hashes, and account sessions use signed, HTTP-only cookies.

Roles are intentionally separated:

- Employees can use orders, production planning, restock information, and their time clock.
- Managers can also run counts and adjustments, maintain storefront targets, approve or disable employee accounts, and review the employee audit ledger.
- Admins can additionally run payroll and promote or demote managers.

The server-side audit ledger records account requests, successful sign-ins and sign-outs, staff actions, time-clock events, counts, adjustments, and storefront target changes. It does not record passwords, IP addresses, or real-life identity data.

The Railway GUI service needs one persistent volume so accounts survive deployments. See `docs/hosting.md` for the migration from the shared login.

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

The base catalog uses Still Water's native item tag and label. Names, descriptions, engravings, or other labels applied during later customization belong to the individual order or weapon record and do not replace the base product identity.

## Discord Parser Status

The Still Water bridge is capture-only by default while its real storefront event formats are collected. Capture mode records raw Discord embeds in the host logs and cannot forward transactions to Google Sheets. Once deposit, withdrawal, customer purchase, and customer-sale examples have been converted into parser tests, forwarding can be enabled explicitly with `CAPTURE_ONLY=0`.

## Safety

- No Discord token, channel ID, Apps Script URL, spreadsheet ID, transaction history, employee data, or local browser state was copied.
- `webhook/Code.gs` contains a Still Water spreadsheet placeholder and cannot write to the original workbook.
- Create a new `.env` from `discord-bridge/.env.example` only after the Still Water Discord channel and receiver exist.
- The local GUI uses port `4273` and separate browser-storage keys to prevent cross-server data mixing.
- Local account data under `app/.data` and Railway volume data are excluded from Git.

See `docs/categories.md` for captured category sources and `docs/hosting.md` for deployment details.
See `docs/pricing.md` for the MSRP midpoint policy, ingredient aliases, and unresolved prices.
