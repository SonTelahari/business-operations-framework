# Business Operations Framework

A reusable ledger-style operations system for roleplay businesses. The framework combines inventory, production recipes, storefront targets, customer orders, purchasing, staff timekeeping, payroll, finance, webhook review, and Discord publishing without baking one business's catalog into the application.

The first browser visit opens a five-page setup ledger. A new owner enters:

- Business identity, location, currency, locale, timezone, and optional logo
- Their first administrator account using an in-game or character name
- Sales, storage, production, and other operating locations
- The modules the business needs
- Materials, products, prices, stock targets, and game item tags
- Product recipes, output quantities, and ingredient requirements

No real-life identity or email address is requested. Passwords are stored as salted `scrypt` hashes and sessions use signed, HTTP-only cookies.

## First Launch

1. Install Node.js 20 or newer.
2. Run `npm install` in the repository root.
3. Run `npm start`.
4. Open `http://localhost:4273`.
5. Complete the setup ledger and select **Open Ledger**.

The setup is transactional: invalid products, duplicate names, unknown recipe ingredients, invalid locations, or mismatched owner credentials do not create a partial business. A browser-local draft preserves non-secret setup fields if the page is closed before completion.

For a hosted deployment, attach persistent storage before completing setup. The application stores its account and business configuration under `AUTH_DATA_DIR`, the Railway volume mount, or `app/.data` locally. A stable session secret is generated into the same data directory when `AUTH_SESSION_SECRET` is not supplied.

## Accounts and Roles

- **Employees** see the daily desk, store, workbench, and production tools needed for ordinary shifts.
- **Managers** can run counts and adjustments, maintain targets and suppliers, reconcile webhook exceptions, manage production, approve staff, and inspect the audit ledger.
- **Admins** additionally control finance, payroll, owner funds, manager promotion, and protected corrections.

New employee requests use the employee's character name and chosen password. A manager or admin approves the request from the Staff page.

## Catalog Model

Products are the goods a business sells or produces. Materials are recipe inputs. Recipes connect a product to one or more material or intermediate-product ingredients and record the quantity produced per craft cycle.

The runtime catalog comes from the persisted first-launch configuration. The checked-in `app/items.js`, `app/recipes.js`, and `app/pricing.js` files remain reference fixtures for the original implementation and parser tests; they are not injected into a newly configured business.

## External Integrations

The GUI can run without a Google Apps Script receiver, but shared inventory, transactions, finance, and webhook-backed workflows require `APPS_SCRIPT_URL`. The included `webhook/Code.gs` is the current receiver implementation and must be deployed into a business-owned Google Sheet.

The `discord-bridge` directory contains the proven Still Water storefront parser as a reference adapter. Discord event wording is server-specific, so a new deployment must verify its message formats before forwarding production transactions. Keep `CAPTURE_ONLY=1` while collecting unfamiliar formats.

Secrets such as Discord tokens, channel IDs, and Apps Script URLs are hosting variables. They are intentionally not collected by the browser setup wizard.

## Commands

```text
npm start                 Start the GUI and API
npm run start:bridge      Start the Discord bridge
npm test                  Run the full regression suite
```

## Deployment

See `docs/hosting.md` for the Railway layout, persistent-volume requirements, and integration variables. The original Frontier Firearms project remains separate; this framework was created in an isolated repository so generic development cannot change its live deployment.
