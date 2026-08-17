ALTER TABLE business_integrations
  ADD COLUMN IF NOT EXISTS storage_ledger_channel_id text NOT NULL DEFAULT '';

CREATE UNIQUE INDEX IF NOT EXISTS business_integrations_storage_ledger_channel_unique
  ON business_integrations (provider, storage_ledger_channel_id)
  WHERE storage_ledger_channel_id <> '' AND status = 'active';
