# Hosting - Still Water

Deploy one private GitHub repository as two persistent Railway services. Both services use the repository root and the shared `railway.json` health and restart policy.

## Service 1: Discord Bridge

- Service name: `still-water-bridge`
- Start command: `npm start`
- Health check: `/health`
- Public domain: not required
- Replicas: exactly one

Variables:

```text
DISCORD_TOKEN=<Still Water bot token>
DISCORD_CHANNEL_ID=1510695972798201967
APPS_SCRIPT_URL=https://script.google.com/macros/s/AKfycbxUltse2dYLlqIyfX2JgQdMJEFRcWNM2OAlQa5ZKP630HVigsBhUwhIaYrg7eJFq855yg/exec
CAPTURE_ONLY=0
DEBUG_DISCORD=0
INVENTORY_CHANNEL_ID=<Discord channel for the live storefront overview>
STOCK_ALERT_CHANNEL_ID=<Discord channel for storefront target alerts>
INVENTORY_REFRESH_SECONDS=300
NODE_ENV=production
```

`INVENTORY_MESSAGE_ID` and `STOCK_ALERT_MESSAGE_ID` are optional. After the first publish, the bridge logs both managed message IDs. Add them to Railway when the destination channel is busy enough that the message may fall outside the bot's 50-message restart lookup.

## Service 2: GUI

- Service name: `still-water-gui`
- Start command: `npm run start:app`
- Health check: `/health`
- Generate a public Railway domain after deployment

Variables:

```text
APPS_SCRIPT_URL=https://script.google.com/macros/s/AKfycbxUltse2dYLlqIyfX2JgQdMJEFRcWNM2OAlQa5ZKP630HVigsBhUwhIaYrg7eJFq855yg/exec
AUTH_SESSION_SECRET=<long random secret, at least 32 characters>
ADMIN_FULL_NAME=<first admin's full name>
ADMIN_PASSWORD=<first admin's initial password, at least 10 characters>
NODE_ENV=production
```

Attach one Railway volume to `still-water-gui` with mount path `/data`. Railway provides the mount path to the application automatically. Keep the GUI at exactly one replica while it uses this file-backed account store.

The GUI health endpoint remains public for Railway. The desk and business APIs require an active account. Railway serves the generated domain over HTTPS.

## Shared Login Migration

1. Attach the volume to `still-water-gui` at `/data`.
2. Add `AUTH_SESSION_SECRET`, `ADMIN_FULL_NAME`, and `ADMIN_PASSWORD` to the GUI service variables.
3. Deploy the staged Railway changes.
4. Sign in with the first admin name and password.
5. Confirm the Employees tab opens, then delete the old `APP_AUTH_USER` and `APP_AUTH_PASSWORD` variables.
6. After the first admin account exists on the volume, `ADMIN_PASSWORD` may also be removed. Keep `AUTH_SESSION_SECRET` unchanged or all existing sessions will be signed out.

If the account variables have not been added yet, the application continues using the old shared Basic Auth login. This makes the migration safe to deploy before the Railway variable changes are applied.

## Employee Approval

1. The employee opens the public GUI URL and selects Request Access.
2. They enter their first and last name and a password of at least 10 characters.
3. An admin signs in, opens Employees, and approves or rejects the request.
4. Approved employees can sign in with their full name and password.
5. Disabling an employee immediately invalidates their active sessions.

Do not copy `.env` into Git or Railway. Enter each variable in its service's Variables tab. Railway injects `PORT` automatically.
