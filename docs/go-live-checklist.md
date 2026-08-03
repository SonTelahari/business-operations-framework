# Go-Live Checklist

1. PostgreSQL backups are enabled.
2. `DATABASE_URL`, `AUTH_SESSION_SECRET`, and `BRIDGE_API_TOKEN` are set on the GUI service.
3. `/health` reports `dataBackend: postgresql` and `databaseReady: true`.
4. The first owner can sign in and a test employee can register and be approved.
5. Products, materials, recipes, stock targets, and locations are verified.
6. The Discord worker uses the same `BRIDGE_API_TOKEN` and the correct `BUSINESS_API_URL`.
7. Capture mode has been tested against real messages before live forwarding is enabled.
8. One stock count, ledger count, deposit, withdrawal, sale, purchase, and webhook review have been verified.
9. Inventory and alert channels show only products with configured targets.
10. A database backup has been taken after verification.
11. Hosted deployments use an intentional signup mode; beta deployments should use `invite`.
12. Two test workspaces with duplicate display names have passed session, stock, staff, and Discord isolation checks.
13. If Discord login is enabled, its redirect URL exactly matches the public domain, `/health` reports it configured, and a test character can request, receive, and switch business access.
14. `/health` reports the intended application version and a deployment-specific release identifier.
15. An installed PWA detects a test deployment and offers **Update App**.
16. Staff know the difference between P&L entries and ledger-only transfers so supplier payments and other recorded obligations are not counted twice.
