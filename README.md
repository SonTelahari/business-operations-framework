# Frontier Firearms - Still Water

Still Water server edition of the Frontier Firearms business system.

This project preserves the order desk, production planning, storefront targets, manual counts, ledger adjustments, employee time clock, payroll, Discord parser, Google Sheets receiver, and hosting setup from the original project. Its catalog contains Still Water data only, preventing server economies from being mixed.

## Employee Accounts

Employees request access with their in-game character name and a password. No real-life name or personal information is requested. New accounts remain pending until an admin or manager approves them in the Staff tab. Passwords are stored only as salted `scrypt` hashes, and account sessions use signed, HTTP-only cookies.

Roles are intentionally separated:

- Employees can use the shared sales-order register, restock information, the shared production queue, and their time clock. They can start batches and record completed craft cycles.
- Managers can also queue or cancel production, run counts and adjustments, maintain storefront targets, approve or disable employee accounts, and review the employee audit ledger.
- Admins can additionally run payroll and promote or demote managers.

The server-side audit ledger records account requests, successful sign-ins and sign-outs, staff actions, sales-order changes, time-clock events, counts, adjustments, and storefront target changes. It does not record passwords, IP addresses, or real-life identity data.

## Shared Sales Orders

Customer quotes and work orders are stored in the server-side business register so every signed-in employee sees the same queue. Saves use revisions to prevent an older browser tab from silently overwriting a colleague's changes. Production can only be queued after the current order revision has saved successfully, and orders linked to production are retained instead of being deleted.

On the first login after this update, each browser imports its older local work orders by ID. Existing shared records are skipped, and local browser copies are removed only after the import succeeds.

The Railway GUI service needs one persistent volume so accounts survive deployments. See `docs/hosting.md` for the migration from the shared login.

## Current Catalog Categories

- Rifles
- Bows
- Misc
- Shotguns
- Repeaters
- Revolvers
- Pistols
- Tools
- Ammunition

The catalog and recipe checks require every sellable item to have exactly one recipe and prevent duplicate item names, labels, and tags.

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

The Still Water bridge is capture-only by default for a safe first deployment. The current parser suite covers 28 event formats, including 20 captured Still Water storefront events. Production forwarding is enabled explicitly with `CAPTURE_ONLY=0`; capture mode remains available for collecting unfamiliar future formats without writing them to Google Sheets.

## Production Batches

Managers can turn customer orders or uncovered storefront targets into shared production batches. The server snapshots each product recipe when the batch is created, reserves materials by expedite status and due date, and lets employees record total craft cycles as work is completed. Each progress update writes material consumption and finished goods into shared Storage; finished goods can then be moved to the Storefront with the existing transfer workflow.

Interrupted Sheet writes remain attached to the batch and can be retried without consuming materials or adding finished stock twice.

## Safety

- No Discord token, channel ID, Apps Script URL, spreadsheet ID, transaction history, employee data, or local browser state was copied.
- `webhook/Code.gs` contains a Still Water spreadsheet placeholder and cannot write to the original workbook.
- Create a new `.env` from `discord-bridge/.env.example` only after the Still Water Discord channel and receiver exist.
- The local GUI uses port `4273` and separate browser-storage keys to prevent cross-server data mixing.
- Local account data under `app/.data` and Railway volume data are excluded from Git.

See `docs/categories.md` for captured category sources and `docs/hosting.md` for deployment details.
See `docs/pricing.md` for the MSRP midpoint policy, ingredient aliases, and unresolved prices.
