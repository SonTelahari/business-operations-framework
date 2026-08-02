# Business Operations Framework

A standalone, reusable ledger-style operations system for roleplay businesses. PostgreSQL is the system of record for inventory, ledger cash, finance, accounts, staff activity, recipes, webhook events, and operational history. Google Sheets and Apps Script are not required at runtime.

The first browser visit opens a five-page setup ledger where a new owner enters:

- Business identity, location, currency, locale, timezone, and optional logo
- Their initial administrator account using an in-game or character name
- Sales, storage, production, and other operating locations
- Enabled modules
- Materials, products, prices, stock targets, and game item tags
- Recipes, craft yields, and ingredient requirements

No real-life identity or email address is requested. Passwords use salted `scrypt` hashes and sessions use signed, HTTP-only cookies.

The same deployment can also host multiple isolated businesses. Set `HOSTED_MODE=1`; each first-launch registration receives an internal UUID and a short workspace code. Business names and in-game reference IDs do not need to be unique. Employees use the workspace code at login, while all inventory, finance, accounts, recipes, and integrations are scoped to the internal UUID.

## Architecture

- `app/` serves the GUI and authenticated API.
- PostgreSQL stores append-only inventory, ledger, finance, webhook, and time-clock events.
- Account and business-operation documents also live in PostgreSQL, so no hosted filesystem volume is required.
- `discord-bridge/` parses storefront messages and posts them directly to the app with a bearer token.
- The app validates Discord item tags, labels, names, and saved aliases against the live business catalog.
- Discord stock and alert messages read a restricted storefront-only snapshot endpoint.

Authoritative counts create new baselines. Later movements are applied after the latest baseline, preserving the audit trail without rewriting history. Discord message IDs and GUI operation IDs provide idempotency.

## Local Start

1. Install Node.js 20 or newer and PostgreSQL 16 or newer.
2. Copy `.env.example` to `.env` and set `DATABASE_URL`, `AUTH_SESSION_SECRET`, and `BRIDGE_API_TOKEN`.
3. Export those variables in the shell or load them through the hosting platform.
4. Run `npm install` and `npm start`.
5. Open `http://localhost:4273` and complete first launch.

Docker Compose is also included:

```text
docker compose up postgres app
```

Set `AUTH_SESSION_SECRET` and `BRIDGE_API_TOKEN` before starting Compose. Add `--profile discord` when the bridge variables are ready.

## Accounts and Roles

- **Employees** see the daily desk, store, workbench, and ordinary shift tools.
- **Managers** can count and adjust stock, maintain targets and suppliers, reconcile webhook exceptions, manage production, approve staff, and inspect the audit ledger.
- **Admins** additionally control finance, payroll, owner funds, manager promotion, and protected corrections.

New registrations use the employee's character name and chosen password. A manager or admin approves the request from Staff.

## Catalog Model

Products are goods the business sells or produces. Materials are recipe inputs. Recipes connect products to material or intermediate-product ingredients and define the quantity produced per craft cycle.

The live catalog is created during first launch and persisted in PostgreSQL. Checked-in catalog files are legacy reference fixtures and parser regression data only; they are not injected into a newly configured business.

## Discord Bridge

The app and bridge share `BRIDGE_API_TOKEN`. The bridge needs:

```text
BUSINESS_API_URL=https://your-app.example.com
BRIDGE_API_TOKEN=<same secret as the app service>
DISCORD_TOKEN=<bot token>
DISCORD_CHANNEL_ID=<storefront event channel>
CAPTURE_ONLY=1
```

Keep `CAPTURE_ONLY=1` until the target server's real Discord messages pass parser tests. Set it to `0` only after a test forward appears in the app. Storefront stock and shortage channels are optional.

For one shared hosted bridge, set `SHARED_BUSINESS_MODE=1` and leave `DISCORD_CHANNEL_ID` blank. An admin connects each business's event channel in its workspace. The app routes incoming events by that registered channel and rejects channels assigned to another business.

## Hosted Workspaces

Use these additional GUI/API variables when offering the app as a shared service:

```text
HOSTED_MODE=1
HOSTED_SIGNUP_MODE=invite
HOSTED_SIGNUP_SECRET=<code supplied to invited business owners>
```

`HOSTED_SIGNUP_MODE` accepts `open`, `invite`, or `closed`. Invite mode is recommended for beta distribution. The invitation code protects workspace creation only; every business owner and employee still has a personal character-name login and password.

The first-launch ledger also accepts optional Discord server, storefront event, inventory, and alert channel IDs. This registers routing immediately; during the private beta, the service operator still adds the shared bot to the Discord server.

## Legacy Import

`scripts/import-legacy.js` can seed a new PostgreSQL deployment from the old Apps Script bootstrap and finance snapshots. It imports opening catalog entries, current storefront and storage counts, ledger balance, and summarized historical P&L. The import is fingerprinted and safe to rerun.

```text
npm run import:legacy
npm run import:legacy -- --commit
```

Set `LEGACY_APPS_SCRIPT_URL` for both commands and `DATABASE_URL` for `--commit`. Run the dry-run first, stop the old bridge during cutover, commit the snapshot, then start the new bridge. The `webhook/` directory remains only as a legacy migration reference.

## Commands

```text
npm start                 Start the GUI and API
npm run start:bridge      Start the Discord bridge
npm test                  Run the full regression suite
npm run import:legacy     Preview a legacy snapshot import
```

See `docs/hosting.md` for Railway, backups, bridge variables, and cutover steps.
