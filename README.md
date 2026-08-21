# Business Operations Framework

A standalone, reusable ledger-style operations system for roleplay businesses. PostgreSQL is the system of record for inventory, ledger cash, finance, accounts, staff activity, recipes, webhook events, and operational history. Google Sheets and Apps Script are not required at runtime.

The first browser visit opens a five-page setup ledger where a new owner enters:

- Business identity, location, currency, locale, timezone, and optional logo
- Their initial administrator account using an in-game or character name
- Sales, storage, production, and other operating locations
- Enabled modules
- Materials, products, prices, stock targets, and game item tags
- Recipes, craft yields, and ingredient requirements

No real-life identity or email address is requested. Character names are explicitly labelled as in-game names. Passwords use salted `scrypt` hashes and sessions use signed, HTTP-only cookies.

The same deployment can also host multiple isolated businesses. Set `HOSTED_MODE=1`; each first-launch registration receives an internal UUID and a short workspace code. Business names and in-game reference IDs do not need to be unique. Employees can use a workspace password account or one global Discord identity with separate character profiles and business memberships. All inventory, finance, accounts, recipes, and integrations are scoped to the internal UUID.

## Architecture

- `app/` serves the GUI and authenticated API.
- PostgreSQL stores append-only inventory, ledger, finance, webhook, and time-clock events.
- Materialized inventory and ledger balance rows serve normal snapshots without replaying the complete event history.
- Account and business-operation documents also live in PostgreSQL, so no hosted filesystem volume is required.
- `discord-bridge/` parses storefront messages and posts them directly to the app with a bearer token.
- The app validates Discord item tags, labels, names, and saved aliases against the live business catalog.
- Discord stock and alert messages read a restricted storefront-only snapshot endpoint.

Authoritative counts create new baselines. Later movements are applied after the latest baseline, preserving the audit trail without rewriting history. Balance rows update in the same transaction as their immutable events; late events rebuild only the affected chronological stream. A complete balance rebuild remains available from event history for recovery. Discord message IDs and GUI operation IDs provide idempotency.

## Desktop Installation

The hosted ledger is an installable progressive web app. In Chrome or Edge, open the deployment over HTTPS and use **Install App** when it appears. The ledger then opens in its own window and can be pinned to the taskbar or Start menu without a separate installer, application store, or per-user database setup.

Every installed copy uses the same hosted PostgreSQL data and existing workspace or Discord login. Updates are downloaded by the browser; when a new version is ready, **Update App** reloads into it. Authenticated pages, API responses, finance data, and business records are always network-only and are never written to the service-worker cache. The cache contains only the public manifest and generic app icons.

Releases use semantic versions. `/health` reports both the application version and the deployment release identifier. Railway deployments stamp their unique deployment ID into the served service worker, so installed copies detect every deployment even when the checked-in worker file itself did not change. `APP_RELEASE` can provide the same behavior on another host.

Local development is installable from `http://localhost`; production installation requires HTTPS. Run `npm run test:pwa` to verify the manifest, icons, routing, and private-data cache exclusions.

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

- **Employees** see the daily desk, store, workbench, production queue, customer register, and ordinary shift tools. They can register customers, create customer orders and over-the-counter cash sales, build internal stock, queue eligible saved orders for production, start batches, record completed production cycles, and mark ready customer orders delivered. Inventory values, production costs, stock adjustments, customer deletion, cancellations, and administrative controls stay hidden.
- **Managers** can additionally count and adjust stock, maintain targets and suppliers, create storefront-restock or manual production, cancel batches, reconcile webhook exceptions, approve staff, and inspect the audit ledger.
- **Admins** additionally control finance, payroll, owner funds, manager promotion, and protected corrections.

New registrations use either the employee's character name and chosen password or Discord login. Discord users create one or more explicitly labelled character profiles, request access using a workspace code, and select an approved business from their profile. A manager or admin approves either kind of request from Staff. Existing password accounts can be linked once from the Discord profile and remain available as a recovery path.

One personal profile can hold jobs at several businesses. Discord memberships appear automatically after approval. Password users link each separately approved business account once with its workspace code and credentials, then use the **Businesses** control in the ledger header to switch workplaces. Role, approval status, time entries, stock, and audit history remain scoped to the selected business.

Admins can tailor each workspace's navigation from **Business Settings**. Dashboard and Business Settings remain available; every other tab can be shown or hidden for that business without changing the underlying employee, manager, or admin permissions.

Customer-order fulfillment first reserves available finished goods from storage or storefront stock, then creates production work only for the remaining quantity. The allocation can be adjusted before queueing and is persisted so another order cannot claim the same units. Orders covered entirely by existing stock move directly to **Ready**; otherwise, completing every production line marks the order **Ready**, and the employee marks it **Completed** only after delivery. The production register includes an **Assigned to Me** filter for the employee named as the order handler.

The customer register is part of the Sales/Order workbench. Registered customer orders store a stable customer link plus a historical name snapshot, and customer cards derive order count, completed sales, lifetime value, average sale, outstanding balance, top purchases, and activity history from those orders. **Over-the-counter Cash Sale** records an anonymous paid-in-full sale immediately and cannot be sent to production; it is intentionally excluded from named-customer statistics.

Internal crafts use the same workbench with **Internal Craft** selected. They always build the full entered quantity for storage, even when finished stock already exists. Prices, deposits, balances, ledger movements, and P&L entries are forced to zero. Completing production consumes the chosen recipe ingredients, adds the crafted output to storage, and closes the internal order automatically without a customer-delivery movement.

Production plans expand recipes recursively. If a finished good needs another craftable product, the queue inserts that intermediate as an earlier stage, uses existing intermediate stock first, and continues until it reaches external materials. Shared intermediate demand, recipe yields, source locations, and yield surplus are netted across the complete batch. Cyclic recipes are rejected before queueing, and inventory movements record only external inputs, finished output, and genuine intermediate surplus.

## Finance Entry Rules

Storefront sales and purchases, supplier receipts, payroll payouts, owner funds, and safekeeping movements create their own finance records. Use **Other Income** or **Other Expense** only for activity that has not already been recorded elsewhere. When cash merely enters or leaves the in-game ledger for an already-recorded transaction, use **Ledger Transfer In/Out**; it updates cash without duplicating revenue or expense in P&L.

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

For one shared hosted bridge, set `SHARED_BUSINESS_MODE=1` and leave `DISCORD_CHANNEL_ID` blank. An admin connects each business's storefront event channel and optional storage/ledger event channel in **Business Settings**. The app routes incoming events by the registered channel and rejects channels assigned to another business. Storefront events affect storefront stock and storefront P&L; storage/ledger events affect storage counts and authoritative ledger balances without creating duplicate sales or purchase finance entries. Storage Manager messages are parsed from `PlayerName` and the `Has Taken ... From ... Inventory` or `Deposited ... To ... Inventory` movement line; the visible item name is resolved against that business's live catalog and the character name is retained for audit.

Managers and admins can inspect the latest 250 accepted deliveries in **Review > Recent Webhook Log**, including applied events that did not create an exception. The log exposes parsing, channel routing, item, direction, quantity, character, final status, Discord message identity, and retained raw text so bridge and inventory problems can be diagnosed without Railway access.

The app also detects and reparses retained Storage Manager text before inventory is applied, regardless of which configured Discord channel field routed the message. This recovers the character, visible item, quantity, direction, and storage location from lines such as `Has Taken 53 Refined Oil From Van Horn Gunsmith Inventory` even when an older bridge sends blank structured fields. On startup, open unapplied storage exceptions are repaired in the same way; recognized catalog goods are applied once and resolved, while unknown goods remain in Review with the recovered fields prefilled.

Crated or packaged goods are resolved once in the webhook Review ledger. Select the canonical catalog good, mark the event as a crate/package, enter the units held by one package, and keep the Discord mapping enabled. The recorded movement and every later matching webhook are converted into loose inventory units while the original package count and price remain in event metadata for audit. Exact Discord item-name mappings take priority over shared display labels, so loose goods cannot accidentally inherit a crate conversion.

## Hosted Workspaces

Use these additional GUI/API variables when offering the app as a shared service:

```text
HOSTED_MODE=1
HOSTED_SIGNUP_MODE=invite
PLATFORM_ADMIN_SECRET=<stable platform operator secret of at least 24 characters>
HOSTED_SIGNUP_SECRET=<optional legacy shared invitation code>
DISCORD_CLIENT_ID=<Discord OAuth application client ID>
DISCORD_CLIENT_SECRET=<Discord OAuth application client secret>
DISCORD_REDIRECT_URI=https://<gui-public-domain>/auth/discord/callback
```

`HOSTED_SIGNUP_MODE` accepts `open`, `invite`, or `closed`. Invite mode is recommended for beta distribution. Open `/operator.html` with `PLATFORM_ADMIN_SECRET` to issue individually tracked, expiring invitation codes, suspend or reactivate workspaces, recover an owner's local password account, review platform actions, and download portable recovery archives. `HOSTED_SIGNUP_SECRET` remains an optional backwards-compatible shared code and can be removed after individual invitations are in use. Invitation codes protect workspace creation only. Discord login requests only the `identify` scope; it stores the stable Discord user ID and current public profile fields, then discards the OAuth access token.

Beta workspaces are permanent tenant records, not disposable previews. Releases apply additive PostgreSQL migrations to the same internal business UUID, so testers keep their catalog, recipes, inventory, finance, staff, orders, webhook history, and audit trail without repeating setup. See `docs/beta-operations.md` for the release and recovery procedure.

The first-launch ledger also accepts optional Discord server, storage/ledger event, inventory, and alert channel IDs in addition to the required storefront event channel. This registers routing immediately; admins can later replace any channel ID from **Business Settings** if the business moves channels or Discord servers. During the private beta, the service operator still adds the shared bot to the Discord server.

## Business Archive Migration

The preferred migration path is a portable, versioned business archive. `npm run export:business` signs into the current hosted app with an admin account and exports the catalog, recipes, current inventory and ledger, customers, orders, suppliers, production, finance summary, and sanitized staff audit history. Password hashes, sessions, API tokens, and database credentials are never included.

On Windows, `scripts/export-business-preview.ps1` provides an interactive credential prompt so the legacy password never needs to be placed in the shell history or an environment file.

`npm run import:business` validates the archive and prints a dry-run summary. Re-run it with `-- --commit` to create a fresh workspace with a new UUID and owner password. A failed import removes the incomplete workspace, and the archive fingerprint prevents accidental duplicate imports.

Raw historic timesheet rows were never exposed by the legacy app. Payroll finance totals migrate when available, while staff reconnect with fresh credentials or Discord profiles. The lower-level `import:legacy` command remains available for Apps Script-only recovery imports.

See `docs/business-archive-migration.md` for the complete export, verification, and bridge cutover procedure.

## Commands

```text
npm start                 Start the GUI and API
npm run start:bridge      Start the Discord bridge
npm test                  Run the full regression suite
npm run test:pwa          Check desktop-install assets and cache boundaries
npm run test:e2e          Run the hosted sign-in and workspace browser journey
npm run export:business   Export the current hosted business
npm run import:business   Validate a business archive (dry run)
npm run import:legacy     Preview a legacy snapshot import
```

The browser journey uses Playwright and an isolated in-memory PostgreSQL database. Install its local browser once with `pnpm exec playwright install chromium`. GitHub Actions installs Chromium automatically and retains desktop, mobile, and failure diagnostics for 14 days.

See `docs/hosting.md` for Railway, backups, bridge variables, and cutover steps.
