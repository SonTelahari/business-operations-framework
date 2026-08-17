CREATE TABLE IF NOT EXISTS cash_review_allocations (
  business_id text NOT NULL,
  webhook_id text NOT NULL,
  allocation_id text NOT NULL,
  occurred_at timestamptz NOT NULL,
  direction text NOT NULL CHECK (direction IN ('Cash In', 'Cash Out')),
  classification text NOT NULL,
  reference text NOT NULL DEFAULT '',
  note text NOT NULL DEFAULT '',
  amount numeric(14, 2) NOT NULL CHECK (amount > 0),
  actor_name text NOT NULL DEFAULT '',
  resolved_by text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, webhook_id, allocation_id),
  FOREIGN KEY (business_id, webhook_id)
    REFERENCES webhook_events (business_id, webhook_id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS cash_review_allocations_event
  ON cash_review_allocations (business_id, webhook_id, created_at);
