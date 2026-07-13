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
NODE_ENV=production
```

## Service 2: GUI

- Service name: `still-water-gui`
- Start command: `npm run start:app`
- Health check: `/health`
- Generate a public Railway domain after deployment

Variables:

```text
APPS_SCRIPT_URL=https://script.google.com/macros/s/AKfycbxUltse2dYLlqIyfX2JgQdMJEFRcWNM2OAlQa5ZKP630HVigsBhUwhIaYrg7eJFq855yg/exec
APP_AUTH_USER=<shared login name>
APP_AUTH_PASSWORD=<long unique password>
NODE_ENV=production
```

The GUI health endpoint remains public for Railway. Every other GUI and API route requires HTTP Basic Auth when `APP_AUTH_PASSWORD` is configured. Railway serves the generated domain over HTTPS.

Do not copy `.env` into Git or Railway. Enter each variable in its service's Variables tab. Railway injects `PORT` automatically.
