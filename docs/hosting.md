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

Do not set `ADMIN_FULL_NAME` or `ADMIN_PASSWORD` for a normal new business. Open the public domain and let first launch create the initial administrator.

`AUTH_SESSION_SECRET` signs employee sessions. Changing it logs everyone out. `BRIDGE_API_TOKEN` authenticates the bridge and should not be shared with employees or placed in browser code.

## Discord Bridge Worker

- Start command: `npm run start:bridge`
- Health check: `/health`
- Replicas: one
- Public domain: not required

Required variables:

```text
DISCORD_TOKEN=<bot token>
DISCORD_CHANNEL_ID=<channel receiving storefront webhook events>
BUSINESS_API_URL=https://<gui-public-domain>
BRIDGE_API_TOKEN=<same value as the GUI service>
CAPTURE_ONLY=1
DEBUG_DISCORD=0
NODE_ENV=production
```

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
