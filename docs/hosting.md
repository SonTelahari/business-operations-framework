# Hosting

The recommended Railway project has PostgreSQL, one GUI/API service, and an optional Discord bridge worker. Google Sheets, Apps Script, and a filesystem volume are not part of the running system.

## PostgreSQL

1. Add a Railway PostgreSQL service to the project.
2. Enable Railway backups or schedule regular `pg_dump` exports.
3. Reference its `DATABASE_URL` from the GUI service.

Database migrations run automatically when the app starts. They are versioned in `app/db/migrations` and recorded in `schema_migrations`.

## GUI And API Service

- Start command: `npm start`
- Health check: `/health`
- Data health check: `/health/data`
- Public domain: required for employee access
- Replicas: one; the operational events are database-native, while shared order documents are still cached by a single app process
- Volume: none

Required variables:

```text
DATABASE_URL=${{Postgres.DATABASE_URL}}
AUTH_SESSION_SECRET=<stable random secret of at least 32 characters>
BRIDGE_API_TOKEN=<different stable random secret>
NODE_ENV=production
```

For a shared hosted deployment, add:

```text
HOSTED_MODE=1
HOSTED_SIGNUP_MODE=invite
HOSTED_SIGNUP_SECRET=<business invitation code>
DISCORD_CLIENT_ID=<OAuth application client ID>
DISCORD_CLIENT_SECRET=<OAuth application client secret>
DISCORD_REDIRECT_URI=https://<gui-public-domain>/auth/discord/callback
```

Every business receives a random internal UUID and a public workspace code. Duplicate business names and duplicate in-game IDs are supported because neither is used as a database key. Use `HOSTED_SIGNUP_MODE=closed` to pause new workspaces or `open` only when unrestricted registration is intentional.

Do not set `ADMIN_FULL_NAME` or `ADMIN_PASSWORD` for a normal new business. Open the public domain and let first launch create the initial administrator.

`AUTH_SESSION_SECRET` signs employee sessions. Changing it logs everyone out. `BRIDGE_API_TOKEN` authenticates the bridge and should not be shared with employees or placed in browser code.

## Discord Login

Discord login is separate from the storefront bridge bot. Configure it once for the shared GUI service:

1. Create or select an application in the Discord Developer Portal.
2. In OAuth2, add `https://<gui-public-domain>/auth/discord/callback` as a redirect URL. It must exactly match `DISCORD_REDIRECT_URI`.
3. Copy the application's client ID and client secret into the GUI service variables above, then redeploy.
4. Confirm `/health` reports `discordLoginConfigured: true` and the sign-in page shows **Continue with Discord**.
5. A user signs in, creates an explicitly labelled in-game character, and requests a business using its workspace code. A manager approves the request from Staff.

The login requests only Discord's `identify` scope. OAuth access tokens are used only for the immediate profile lookup and are not stored. The client secret remains on the GUI service and must never be added to the bridge, browser code, or repository.

Existing password users can choose **Link Password Account** on their Discord profile. They enter the workspace code and existing credentials once; the Discord membership inherits the existing role while the password account remains available for recovery.

## Discord Bridge Worker

- Start command: `npm run start:bridge`
- Health check: `/health`
- Replicas: one
- Public domain: not required

Required variables:

```text
DISCORD_TOKEN=<bot token>
SHARED_BUSINESS_MODE=1
BUSINESS_API_URL=https://<gui-public-domain>
BRIDGE_API_TOKEN=<same value as the GUI service>
CAPTURE_ONLY=1
DEBUG_DISCORD=0
NODE_ENV=production
```

In shared mode, leave `DISCORD_CHANNEL_ID` blank. Each workspace admin registers that business's storefront event channel in the app. A channel can belong to only one active workspace.

Optional publishing variables:

```text
INVENTORY_CHANNEL_ID=
STOCK_ALERT_CHANNEL_ID=
INVENTORY_REFRESH_SECONDS=300
INVENTORY_MESSAGE_ID=
STOCK_ALERT_MESSAGE_ID=
```

Keep `CAPTURE_ONLY=1` until parser tests cover the server's actual messages. Run `npm run test:forward`, confirm the event reaches Webhook Review or inventory correctly, and then set `CAPTURE_ONLY=0`.

The inventory publisher needs `View Channel`, `Send Messages`, `Embed Links`, and `Read Message History`. Managed messages are edited in place.

## Legacy Cutover

1. Deploy PostgreSQL and the GUI with the three required variables.
2. Complete first launch with the business catalog and recipes.
3. Stop the old bridge so the source stops moving.
4. Set `LEGACY_APPS_SCRIPT_URL` and run `npm run import:legacy` locally as a dry run.
5. Verify product, material, storage, ledger, and finance totals.
6. Run `npm run import:legacy -- --commit` against the new `DATABASE_URL`.
7. Start the new bridge with `BUSINESS_API_URL` and `BRIDGE_API_TOKEN`.
8. Submit one deposit, withdrawal, sale, and purchase before retiring the old receiver.

The import creates opening baselines and summarized historical finance. It does not recreate individual old transaction rows or detailed payroll identities.

## Backups And Restore

- Use Railway PostgreSQL backups for routine recovery.
- Take a manual backup before migrations, imports, or major catalog changes.
- Test restoration in a separate project periodically.
- Keep application secrets outside the database backup and store them in a password manager.

Never commit `.env`, database URLs, Discord tokens, employee records, or generated capture journals.
