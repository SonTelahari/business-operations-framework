CREATE TABLE IF NOT EXISTS discord_identities (
  id text PRIMARY KEY,
  discord_user_id text NOT NULL UNIQUE,
  username text NOT NULL,
  global_name text NOT NULL DEFAULT '',
  avatar_hash text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'disabled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS identity_characters (
  id text PRIMARY KEY,
  identity_id text NOT NULL,
  name text NOT NULL,
  normalized_name text NOT NULL,
  setting_name text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'archived')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (identity_id, normalized_name),
  FOREIGN KEY (identity_id) REFERENCES discord_identities (id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS business_memberships (
  id text PRIMARY KEY,
  business_id text NOT NULL,
  character_id text NOT NULL,
  role text NOT NULL DEFAULT 'employee'
    CHECK (role IN ('employee', 'manager', 'admin')),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'active', 'disabled', 'rejected')),
  requested_at timestamptz NOT NULL DEFAULT now(),
  approved_at timestamptz,
  approved_by text NOT NULL DEFAULT '',
  last_login_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (business_id, character_id),
  FOREIGN KEY (business_id) REFERENCES businesses (id) ON DELETE CASCADE,
  FOREIGN KEY (character_id) REFERENCES identity_characters (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS business_memberships_character_lookup
  ON business_memberships (character_id, status);

CREATE INDEX IF NOT EXISTS business_memberships_business_lookup
  ON business_memberships (business_id, status, role);

CREATE TABLE IF NOT EXISTS oauth_states (
  state_hash text PRIMARY KEY,
  code_verifier text NOT NULL,
  return_to text NOT NULL DEFAULT '/profile.html',
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS oauth_states_expiry
  ON oauth_states (expires_at);
