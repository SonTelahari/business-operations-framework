CREATE TABLE IF NOT EXISTS businesses (
  id text PRIMARY KEY,
  workspace_code text NOT NULL UNIQUE,
  name text NOT NULL,
  reference_id text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'provisioning'
    CHECK (status IN ('provisioning', 'active', 'suspended', 'failed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE UNIQUE INDEX IF NOT EXISTS businesses_workspace_code_upper_unique
  ON businesses (upper(workspace_code));

CREATE TABLE IF NOT EXISTS tenant_documents (
  business_id text NOT NULL,
  document_key text NOT NULL,
  data jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, document_key),
  FOREIGN KEY (business_id) REFERENCES businesses (id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS business_integrations (
  business_id text NOT NULL,
  provider text NOT NULL,
  guild_id text NOT NULL DEFAULT '',
  event_channel_id text NOT NULL DEFAULT '',
  inventory_channel_id text NOT NULL DEFAULT '',
  alert_channel_id text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'disabled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (business_id, provider),
  FOREIGN KEY (business_id) REFERENCES businesses (id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS business_integrations_event_channel_unique
  ON business_integrations (provider, event_channel_id)
  WHERE event_channel_id <> '' AND status = 'active';

CREATE INDEX IF NOT EXISTS business_integrations_guild_lookup
  ON business_integrations (provider, guild_id)
  WHERE guild_id <> '';

INSERT INTO businesses (id, workspace_code, name, status, metadata)
SELECT
  'primary',
  'PRIMARY',
  CASE
    WHEN COALESCE(data->'configuration'->'business'->>'name', '') = '' THEN 'Primary Business'
    ELSE data->'configuration'->'business'->>'name'
  END,
  'active',
  '{"source":"legacy-single-tenant"}'::jsonb
FROM app_documents
WHERE document_key = 'business'
ON CONFLICT (id) DO NOTHING;

INSERT INTO tenant_documents (business_id, document_key, data, updated_at)
SELECT 'primary', document_key, data, updated_at
FROM app_documents
WHERE EXISTS (SELECT 1 FROM businesses WHERE id = 'primary')
ON CONFLICT (business_id, document_key) DO NOTHING;
