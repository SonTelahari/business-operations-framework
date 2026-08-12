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
- Account and business-operation documents also live in PostgreSQL, so no hosted filesystem volume is required.
- `discord-bridge/` parses storefront messages and posts them directly to the app with a bearer token.
- The app validates Discord item tags, labels, names, and saved aliases against the live business catalog.
- Discord stock and alert messages read a restricted storefront-only snapshot endpoint.

Authoritative counts create new baselines. Later movements are applied after the latest baseline, preserving the audit trail without rewriting history. Discord message IDs and GUI operation IDs provide idempotency.

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

- **Employees** see the daily desk, store, workbench, production queue, and ordinary shift tools. They can create customer orders, queue only those orders for production, start batches, record completed production cycles, and mark ready orders delivered. Inventory values, production costs, stock adjustments, cancellations, and administrative controls stay hidden.
- **Managers** can additionally count and adjust stock, maintain targets and suppliers, create storefront-restock or manual production, cancel batches, reconcile webhook exceptions, approve staff, and inspect the audit ledger.
- **Admins** additionally control finance, payroll, owner funds, manager promotion, and protected corrections.

New registrations use either the employee's character name and chosen password or Discord login. Discord users create one or more explicitly labelled character profiles, request access using a workspace code, and select an approved business from their profile. A manager or admin approves either kind of request from Staff. Existing password accounts can be linked once from the Discord profile and remain available as a recovery path.

Customer-order production follows a shared status flow: saving the order creates the work record, queuing its recipe lines marks it **In Production**, completing every batch line marks it **Ready**, and the employee marks it **Completed** only after delivery. The production register includes an **Assigned to Me** filter for the employee named as the order handler.

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

For one shared hosted bridge, set `SHARED_BUSINESS_MODE=1` and leave `DISCORD_CHANNEL_ID` blank. An admin connects each business's event channel in its workspace. The app routes incoming events by that registered channel and rejects channels assigned to another business.

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

The first-launch ledger also accepts optional Discord server, storefront event, inventory, and alert channel IDs. This registers routing immediately; during the private beta, the service operator still adds the shared bot to the Discord server.

## Business Archive Migration

The preferred migration path is a portable, versioned business archive. `npm run export:business` signs into the current hosted app with an admin account and exports the catalog, recipes, current inventory and ledger, orders, suppliers, production, finance summary, and sanitized staff audit history. Password hashes, sessions, API tokens, and database credentials are never included.

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
npm run export:business   Export the current hosted business
npm run import:business   Validate a business archive (dry run)
npm run import:legacy     Preview a legacy snapshot import
```

See `docs/hosting.md` for Railway, backups, bridge variables, and cutover steps.
