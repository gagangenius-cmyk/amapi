-- Customers browse a store's products by category and then sub-category, like any large shopping site.
ALTER TABLE store_products ADD COLUMN sub_category VARCHAR(80) NULL AFTER category;
ALTER TABLE store_products ADD KEY ix_sp_cat (is_active, category, sub_category);
