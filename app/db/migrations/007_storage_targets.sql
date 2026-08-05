ALTER TABLE catalog_items
  ADD COLUMN IF NOT EXISTS storage_target numeric(14, 3) NOT NULL DEFAULT 0;

