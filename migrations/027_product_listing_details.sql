-- Everything an online shop lists about a product, beyond name / price / stock: bullet highlights, a free-form specification table,
-- weight and size (for delivery), origin, maker, shelf life, warranty, return window and search tags.
-- highlights, specs and tags hold JSON text (TEXT, so it also works on MariaDB).
ALTER TABLE products
  ADD COLUMN highlights TEXT NULL,
  ADD COLUMN specs TEXT NULL,
  ADD COLUMN tags TEXT NULL,
  ADD COLUMN weight_g INT UNSIGNED NULL,
  ADD COLUMN length_cm DECIMAL(7,2) NULL,
  ADD COLUMN width_cm DECIMAL(7,2) NULL,
  ADD COLUMN height_cm DECIMAL(7,2) NULL,
  ADD COLUMN country_of_origin VARCHAR(60) NULL,
  ADD COLUMN manufacturer VARCHAR(120) NULL,
  ADD COLUMN shelf_life_days INT UNSIGNED NULL,
  ADD COLUMN warranty_months INT UNSIGNED NULL,
  ADD COLUMN return_days INT UNSIGNED NULL;
