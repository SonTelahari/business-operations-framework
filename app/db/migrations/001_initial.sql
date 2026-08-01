CREATE TABLE IF NOT EXISTS schema_migrations (
  id text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS app_documents (
  document_key text PRIMARY KEY,
  data jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS catalog_items (
  business_id text NOT NULL DEFAULT 'primary',
  id text NOT NULL,
  item_type text NOT NULL CHECK (item_type IN ('product', 'material')),
  name text NOT NULL,
  normalized_name text NOT NULL,
  label text NOT NULL,
  item_tag text NOT NULL DEFAULT '',
  category text NOT NULL,
  unit_name text NOT NULL DEFAULT 'unit',
  unit_cost numeric(14, 2) NOT NULL DEFAULT 0,
  sale_price numeric(14, 2) NOT NULL DEFAULT 0,
  stock_target numeric(14, 3) NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  aliases jsonb NOT NULL DEFAULT '[]'::jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, id),
  UNIQUE (business_id, normalized_name)
);

CREATE UNIQUE INDEX IF NOT EXISTS catalog_items_tag_unique
  ON catalog_items (business_id, lower(item_tag))
  WHERE item_tag <> '';

CREATE TABLE IF NOT EXISTS recipe_definitions (
  business_id text NOT NULL DEFAULT 'primary',
  id text NOT NULL,
  product_name text NOT NULL,
  normalized_product_name text NOT NULL,
  output_quantity numeric(14, 3) NOT NULL CHECK (output_quantity > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, id),
  UNIQUE (business_id, normalized_product_name)
);

CREATE TABLE IF NOT EXISTS recipe_ingredients (
  business_id text NOT NULL DEFAULT 'primary',
  recipe_id text NOT NULL,
  position integer NOT NULL,
  ingredient_name text NOT NULL,
  normalized_ingredient_name text NOT NULL,
  quantity numeric(14, 3) NOT NULL CHECK (quantity > 0),
  PRIMARY KEY (business_id, recipe_id, position),
  FOREIGN KEY (business_id, recipe_id)
    REFERENCES recipe_definitions (business_id, id)
    ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS operation_receipts (
  business_id text NOT NULL DEFAULT 'primary',
  event_id text NOT NULL,
  operation_type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, event_id)
);

CREATE TABLE IF NOT EXISTS inventory_events (
  business_id text NOT NULL DEFAULT 'primary',
  event_id text NOT NULL,
  occurred_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  source text NOT NULL,
  event_kind text NOT NULL,
  location_type text NOT NULL CHECK (location_type IN ('sales', 'storage', 'other')),
  item_name text NOT NULL,
  normalized_item_name text NOT NULL,
  quantity_delta numeric(14, 3) NOT NULL DEFAULT 0,
  absolute_quantity numeric(14, 3),
  unit_price numeric(14, 2) NOT NULL DEFAULT 0,
  actor_name text NOT NULL DEFAULT '',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (business_id, event_id)
);

CREATE INDEX IF NOT EXISTS inventory_events_lookup
  ON inventory_events (business_id, location_type, normalized_item_name, occurred_at, recorded_at);

CREATE TABLE IF NOT EXISTS ledger_events (
  business_id text NOT NULL DEFAULT 'primary',
  event_id text NOT NULL,
  occurred_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  source text NOT NULL,
  event_kind text NOT NULL,
  amount_delta numeric(14, 2) NOT NULL DEFAULT 0,
  absolute_balance numeric(14, 2),
  actor_name text NOT NULL DEFAULT '',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (business_id, event_id)
);

CREATE INDEX IF NOT EXISTS ledger_events_order
  ON ledger_events (business_id, occurred_at, recorded_at);

CREATE TABLE IF NOT EXISTS finance_events (
  business_id text NOT NULL DEFAULT 'primary',
  event_id text NOT NULL,
  occurred_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  entry_type text NOT NULL CHECK (entry_type IN ('Revenue', 'Expense', 'Owner Capital', 'Safekeeping')),
  category text NOT NULL,
  label text NOT NULL,
  source text NOT NULL,
  direction text NOT NULL DEFAULT '',
  amount numeric(14, 2) NOT NULL CHECK (amount >= 0),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (business_id, event_id)
);

CREATE INDEX IF NOT EXISTS finance_events_period
  ON finance_events (business_id, occurred_at, entry_type);

CREATE TABLE IF NOT EXISTS webhook_events (
  business_id text NOT NULL DEFAULT 'primary',
  webhook_id text NOT NULL,
  occurred_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  event_type text NOT NULL,
  direction text NOT NULL,
  item_name text NOT NULL DEFAULT '',
  quantity numeric(14, 3) NOT NULL DEFAULT 0,
  unit_price numeric(14, 2) NOT NULL DEFAULT 0,
  actor_name text NOT NULL DEFAULT '',
  order_id text NOT NULL DEFAULT '',
  status text NOT NULL CHECK (status IN ('applied', 'review', 'ignored')),
  payload jsonb NOT NULL,
  PRIMARY KEY (business_id, webhook_id)
);

CREATE INDEX IF NOT EXISTS webhook_events_purchases
  ON webhook_events (business_id, event_type, occurred_at)
  WHERE status = 'applied';

CREATE TABLE IF NOT EXISTS webhook_exceptions (
  business_id text NOT NULL DEFAULT 'primary',
  webhook_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('Open', 'Resolved', 'Ignored')),
  reason text NOT NULL DEFAULT '',
  discord_title text NOT NULL DEFAULT '',
  discord_item_name text NOT NULL DEFAULT '',
  discord_item_label text NOT NULL DEFAULT '',
  proposed_event_type text NOT NULL DEFAULT '',
  proposed_direction text NOT NULL DEFAULT '',
  proposed_quantity numeric(14, 3) NOT NULL DEFAULT 0,
  proposed_unit_price numeric(14, 2) NOT NULL DEFAULT 0,
  ledger_balance numeric(14, 2),
  current_item_total numeric(14, 3),
  resolved_item_name text NOT NULL DEFAULT '',
  resolved_at timestamptz,
  resolved_by text NOT NULL DEFAULT '',
  resolution_note text NOT NULL DEFAULT '',
  original_payload jsonb NOT NULL,
  transaction_written boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, webhook_id),
  FOREIGN KEY (business_id, webhook_id)
    REFERENCES webhook_events (business_id, webhook_id)
    ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS item_mappings (
  business_id text NOT NULL DEFAULT 'primary',
  id text NOT NULL,
  discord_item_name text NOT NULL DEFAULT '',
  discord_item_label text NOT NULL DEFAULT '',
  canonical_item_name text NOT NULL,
  created_by text NOT NULL DEFAULT '',
  source_webhook_id text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, id)
);

CREATE INDEX IF NOT EXISTS item_mappings_name
  ON item_mappings (business_id, lower(discord_item_name));
CREATE INDEX IF NOT EXISTS item_mappings_label
  ON item_mappings (business_id, lower(discord_item_label));

CREATE TABLE IF NOT EXISTS time_entries (
  business_id text NOT NULL DEFAULT 'primary',
  entry_id text NOT NULL,
  employee_name text NOT NULL,
  clock_in timestamptz NOT NULL,
  clock_out timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, entry_id)
);

CREATE TABLE IF NOT EXISTS import_batches (
  business_id text NOT NULL DEFAULT 'primary',
  id text NOT NULL,
  source_type text NOT NULL,
  source_fingerprint text NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now(),
  imported_by text NOT NULL DEFAULT '',
  summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (business_id, id),
  UNIQUE (business_id, source_fingerprint)
);
