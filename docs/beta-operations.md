# Private Beta Operations

Beta workspaces use the production data model from their first day. They are never reset between releases. Each business keeps one internal UUID for its full lifetime, regardless of business name, in-game ID, workspace code, application version, or hosting domain.

## Before Inviting Testers

1. Configure `DATABASE_URL`, a stable `AUTH_SESSION_SECRET`, `BRIDGE_API_TOKEN`, and a separate stable `PLATFORM_ADMIN_SECRET`.
2. Set `HOSTED_MODE=1` and `HOSTED_SIGNUP_MODE=invite`.
3. Enable Railway PostgreSQL backups and take a manual backup before the first invitation.
4. Deploy, open `/health`, and confirm `databaseReady`, `tenantScoped`, and `operatorConsoleConfigured` are all `true`.
   Confirm `multiReplicaDocumentWrites` and `materializedBalances` are also `true` before running more than one GUI/API replica.
5. Open `/operator.html`, issue one single-use invitation per business, and send only that code and the public setup URL to the owner.

The setup page explicitly asks for in-game or character names. Testers should not enter real-life names, email addresses, or other private personal information.

## Release Rule

Every release upgrades the existing database in place:

1. Take a database backup.
2. Run the full regression suite against the release candidate.
3. Deploy one application replica. Scale out only after the new release is healthy and reports `multiReplicaDocumentWrites: true`.
4. Let startup apply new numbered migrations from `app/db/migrations`.
5. Verify `/health` reports the intended version and release identifier.
6. Sign into an existing beta workspace and verify its storefront count, storage count, ledger balance, open orders, staff, and finance totals.
7. Create a portable archive from `/operator.html` for any workspace participating in a high-risk migration test.

Never remove or edit an applied migration. Schema changes are additive and receive the next migration number. Never replace the production PostgreSQL service with an empty database during an application deployment.

Migration 013 creates compact inventory and ledger balances. The first access to each existing workspace rebuilds them from immutable event history. A mismatch is recovered by rebuilding the balances; inventory or ledger events must never be deleted to repair a balance.

## Access Incidents

- **Business should temporarily stop using the app:** suspend the workspace. All data remains stored and integrations stop resolving it as active.
- **Business can return:** reactivate the same workspace. Its UUID, workspace code, accounts, and operational records remain unchanged.
- **Owner lost local account access:** use **Reset Owner** and share the temporary password privately. Existing local password sessions are invalidated, and the temporary password is never written to platform audit records.
- **Operator needs a recovery artifact:** download the workspace archive. It contains sanitized business configuration and operational snapshots, but never passwords, sessions, OAuth tokens, bot tokens, or database credentials.
- **Application release fails:** roll the application back without rolling the database backward. Restore the database only for confirmed data corruption and only from a verified backup.

## Beta-to-Release Transition

There is no bulk re-entry step. Removing the beta label is an application release against the same PostgreSQL database. Existing workspaces continue using their original UUIDs and accounts. New functionality should either read existing records directly or add fields through a versioned migration with deterministic defaults.

The portable archive is a disaster-recovery and host-migration path. The live PostgreSQL database remains the complete source of truth for raw webhook events, time entries, finance events, inventory events, ledger events, and audit history.
