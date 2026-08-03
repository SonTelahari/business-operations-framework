CREATE TABLE IF NOT EXISTS beta_invites (
  id text PRIMARY KEY,
  code_hash text NOT NULL UNIQUE,
  code_hint text NOT NULL DEFAULT '',
  label text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'revoked', 'exhausted')),
  max_uses integer NOT NULL DEFAULT 1 CHECK (max_uses > 0),
  use_count integer NOT NULL DEFAULT 0 CHECK (use_count >= 0),
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS beta_invites_status_lookup
  ON beta_invites (status, expires_at, created_at);

CREATE TABLE IF NOT EXISTS beta_invite_redemptions (
  id text PRIMARY KEY,
  invite_id text NOT NULL,
  business_id text NOT NULL UNIQUE,
  redeemed_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  FOREIGN KEY (invite_id) REFERENCES beta_invites (id) ON DELETE RESTRICT,
  FOREIGN KEY (business_id) REFERENCES businesses (id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS beta_invite_redemptions_invite_lookup
  ON beta_invite_redemptions (invite_id, redeemed_at);

CREATE TABLE IF NOT EXISTS platform_audit_events (
  id text PRIMARY KEY,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  actor text NOT NULL DEFAULT 'Service operator',
  action text NOT NULL,
  business_id text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS platform_audit_events_recent
  ON platform_audit_events (occurred_at DESC);

CREATE INDEX IF NOT EXISTS platform_audit_events_business
  ON platform_audit_events (business_id, occurred_at DESC);
