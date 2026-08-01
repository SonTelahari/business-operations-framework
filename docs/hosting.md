# Hosting

Deploy the private repository to Railway as a persistent GUI service. Add a second service only when the business uses the Discord storefront bridge.

## GUI Service

- Start command: `npm start`
- Health check: `/health`
- Replicas: exactly one while the application uses its file-backed business store
- Public domain: required for employee access
- Volume mount: `/data`

Optional variables:

```text
APPS_SCRIPT_URL=https://script.google.com/macros/s/your_deployment_id/exec
AUTH_SESSION_SECRET=<stable random secret of at least 32 characters>
NODE_ENV=production
```

`AUTH_SESSION_SECRET` is recommended but not mandatory. When omitted, the server generates a stable secret in the persistent data directory. Do not set `ADMIN_FULL_NAME` or `ADMIN_PASSWORD` for a normal new deployment; the first-launch ledger creates the initial administrator.

After deployment, open the Railway domain and complete first launch. The volume must be attached before this step so the business configuration, accounts, sessions, orders, audit records, and operational state survive redeployments.

## Discord Bridge Service

- Start command: `npm run start:bridge`
- Health check: `/health`
- Replicas: exactly one
- Public domain: not required

Variables:

```text
DISCORD_TOKEN=<bot token>
DISCORD_CHANNEL_ID=<channel receiving storefront webhook events>
APPS_SCRIPT_URL=https://script.google.com/macros/s/your_deployment_id/exec
CAPTURE_ONLY=1
DEBUG_DISCORD=0
INVENTORY_CHANNEL_ID=<optional live inventory channel>
STOCK_ALERT_CHANNEL_ID=<optional shortage alert channel>
INVENTORY_REFRESH_SECONDS=300
NODE_ENV=production
```

Keep `CAPTURE_ONLY=1` until parser tests cover the target server's actual Discord messages. Set it to `0` only after test forwards reach the correct Apps Script deployment.

The inventory and stock-alert publishers are optional. They need `View Channel`, `Send Messages`, `Embed Links`, and `Read Message History`. Managed messages are edited in place. Their IDs can be pinned with `INVENTORY_MESSAGE_ID` and `STOCK_ALERT_MESSAGE_ID` in busy channels.

## Google Sheet Receiver

1. Create a new business-owned Google Sheet.
2. Open **Extensions > Apps Script**.
3. Replace the editor contents with `webhook/Code.gs`.
4. Deploy it as a web app that runs as the owner and is accessible to anyone with the URL.
5. Put the resulting `/exec` URL in the GUI and bridge `APPS_SCRIPT_URL` variables.
6. Confirm `/health`, the GUI bootstrap, and a test bridge forward before enabling live forwarding.

Never commit `.env`, tokens, Apps Script URLs, employee records, or generated data files.
