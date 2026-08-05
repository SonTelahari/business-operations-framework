ALTER TABLE catalog_items
  DROP CONSTRAINT IF EXISTS catalog_items_item_type_check;

ALTER TABLE catalog_items
  ADD CONSTRAINT catalog_items_item_type_check
  CHECK (item_type IN ('product', 'material', 'both'));
