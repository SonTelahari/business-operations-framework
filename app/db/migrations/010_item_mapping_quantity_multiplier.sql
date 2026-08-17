ALTER TABLE item_mappings
  ADD COLUMN IF NOT EXISTS quantity_multiplier numeric(14,4) NOT NULL DEFAULT 1;
