CREATE TABLE IF NOT EXISTS local_identities (
  id text PRIMARY KEY,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'disabled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS local_identity_memberships (
  identity_id text NOT NULL,
  business_id text NOT NULL,
  local_user_id text NOT NULL,
  linked_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (identity_id, business_id),
  UNIQUE (business_id, local_user_id),
  FOREIGN KEY (identity_id) REFERENCES local_identities (id) ON DELETE CASCADE,
  FOREIGN KEY (business_id) REFERENCES businesses (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS local_identity_memberships_user_lookup
  ON local_identity_memberships (business_id, local_user_id);

CREATE INDEX IF NOT EXISTS local_identity_memberships_identity_lookup
  ON local_identity_memberships (identity_id);
