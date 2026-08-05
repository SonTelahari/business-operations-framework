ALTER TABLE recipe_definitions
  ADD COLUMN IF NOT EXISTS active boolean NOT NULL DEFAULT true;

ALTER TABLE recipe_ingredients
  ADD COLUMN IF NOT EXISTS source_location text NOT NULL DEFAULT 'storage';

ALTER TABLE recipe_ingredients
  DROP CONSTRAINT IF EXISTS recipe_ingredients_source_location_check;

ALTER TABLE recipe_ingredients
  ADD CONSTRAINT recipe_ingredients_source_location_check
  CHECK (source_location IN ('storage', 'sales'));
