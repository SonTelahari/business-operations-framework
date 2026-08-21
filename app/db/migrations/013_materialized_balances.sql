CREATE TABLE IF NOT EXISTS balance_materialization_state (
  business_id text PRIMARY KEY,
  status text NOT NULL DEFAULT 'building'
    CHECK (status IN ('building', 'ready')),
  rebuilt_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS inventory_balances (
  business_id text NOT NULL,
  location_type text NOT NULL
    CHECK (location_type IN ('sales', 'storage', 'other')),
  normalized_item_name text NOT NULL,
  item_name text NOT NULL,
  quantity numeric(14, 3) NOT NULL DEFAULT 0,
  counted_at timestamptz,
  net_movement_since_count numeric(14, 3) NOT NULL DEFAULT 0,
  last_activity_at timestamptz,
  last_event_occurred_at timestamptz,
  last_event_recorded_at timestamptz,
  last_event_id text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, location_type, normalized_item_name)
);

CREATE INDEX IF NOT EXISTS inventory_balances_business_location
  ON inventory_balances (business_id, location_type, normalized_item_name);

CREATE TABLE IF NOT EXISTS ledger_balances (
  business_id text PRIMARY KEY,
  balance numeric(14, 2) NOT NULL DEFAULT 0,
  counted_balance numeric(14, 2),
  counted_at timestamptz,
  net_movement_since_count numeric(14, 2) NOT NULL DEFAULT 0,
  last_activity_at timestamptz,
  last_event_occurred_at timestamptz,
  last_event_recorded_at timestamptz,
  last_event_id text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now()
);
