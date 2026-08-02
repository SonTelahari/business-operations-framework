# Business Archive Migration

This runbook moves one business from the legacy Frontier Firearms app into a fresh hosted workspace. Keep the archive private: it contains business records and character names, although it never contains passwords, sessions, Discord tokens, or database credentials.

## 1. Prepare the new deployment

Create the new PostgreSQL database and GUI service, but do not connect the live Discord storefront channel yet. Set `DATABASE_URL` and an `AUTH_SESSION_SECRET` of at least 32 characters in the environment that will run the import.

## 2. Make a preview export

Run this while the old app is still online:

```powershell
$env:LEGACY_APP_URL='https://still-water-gui-production.up.railway.app'
$env:LEGACY_ADMIN_NAME='William Winther'
$env:LEGACY_ADMIN_PASSWORD='<current legacy password>'
$env:LEGACY_BUSINESS_NAME='Frontier Firearms'
$env:LEGACY_BUSINESS_LOCATION='Van Horn'
$env:LEGACY_BUSINESS_REFERENCE_ID='23'
$env:LEGACY_PRICING_PATH='C:\path\to\frontier-firearms-still-water\app\pricing.js'
npm run export:business
```

`LEGACY_PRICING_PATH` is optional, but it preserves the old material MSRP costs. Without it, material costs are inferred from supplier cards where possible. The command prints the archive path and a count summary. Remove the password from the shell after export:

```powershell
$env:LEGACY_ADMIN_PASSWORD=$null
```

## 3. Validate without writing

```powershell
$env:BUSINESS_ARCHIVE_PATH='C:\path\to\frontier-firearms-....business-archive.json'
npm run import:business
```

Check the displayed product, material, recipe, storefront count, storage count, ledger, order, supplier, finance, and staff-audit totals. A fingerprint error means the archive changed after export and must not be imported.

## 4. Take the final cutover snapshot

Pause the old Discord bridge and avoid manual writes in the old GUI. Run `npm run export:business` again, then repeat the dry-run using the final archive. This closes the gap between the exported balances and the last storefront event.

## 5. Import the new workspace

```powershell
$env:DATABASE_URL='<new PostgreSQL connection string>'
$env:AUTH_SESSION_SECRET='<new secret of at least 32 characters>'
$env:IMPORT_OWNER_NAME='William Winther'
$env:IMPORT_OWNER_PASSWORD='<new owner password>'
$env:BUSINESS_ARCHIVE_PATH='C:\path\to\final.business-archive.json'
npm run import:business -- --commit
```

The command prints the new workspace UUID and code. It creates a fresh owner login; old password hashes are intentionally not copied. Legacy staff names and actions remain in the audit ledger as references, and employees can request access again with Discord or a fresh password account.

## 6. Verify before reconnecting Discord

Open the new workspace and compare these controls with the final archive summary and the old app:

1. Product, material, and recipe counts.
2. Storefront and storage totals, including several individual items.
3. Store ledger balance and its last count time.
4. Open sales orders, supplier orders, storefront buy orders, and production batches.
5. Suppliers and quoted unit prices.
6. P&L totals, owner capital, and safekeeping balances.
7. Staff audit references and daily closes.

Raw historic timesheet rows cannot be recovered through the old app API. Payroll totals are retained in finance when the old finance endpoint is available. Keep the final archive as the immutable migration record.

## 7. Cut over the bridge

Configure the new workspace's Discord integration, point the shared bridge at the new GUI/API, and send one controlled storefront movement. Confirm that it appears exactly once and changes the expected stock and ledger figures before resuming normal use.
