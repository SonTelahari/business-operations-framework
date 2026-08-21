ALTER TABLE app_documents
  ADD COLUMN IF NOT EXISTS revision bigint NOT NULL DEFAULT 1;

ALTER TABLE tenant_documents
  ADD COLUMN IF NOT EXISTS revision bigint NOT NULL DEFAULT 1;
