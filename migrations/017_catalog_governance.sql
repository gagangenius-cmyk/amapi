-- Catalogue governance: managed categories and brands, a product review step, and a version history per product.

-- Managed taxonomy, maintained by the platform admin. A name a distributor types that is not in the list is created as
-- 'pending' (usable straight away, but flagged for the admin to approve, rename or merge).
CREATE TABLE categories (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  parent_id BIGINT UNSIGNED NULL,
  parent_key BIGINT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'parent_id, or 0 for top level: lets the unique key work with NULL parents',
  name VARCHAR(80) NOT NULL,
  name_key VARCHAR(80) NOT NULL COMMENT 'lower-cased name, for case-insensitive uniqueness',
  status ENUM('active','pending','retired') NOT NULL DEFAULT 'active',
  merged_into_id BIGINT UNSIGNED NULL,
  sort_order INT NOT NULL DEFAULT 0,
  created_by BIGINT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_cat_name (parent_key, name_key),
  KEY ix_cat_parent (parent_id),
  KEY ix_cat_status (status),
  CONSTRAINT fk_cat_parent FOREIGN KEY (parent_id) REFERENCES categories(id)
) ENGINE=InnoDB;

CREATE TABLE brands (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(80) NOT NULL,
  name_key VARCHAR(80) NOT NULL,
  status ENUM('active','pending','retired') NOT NULL DEFAULT 'active',
  merged_into_id BIGINT UNSIGNED NULL,
  created_by BIGINT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_brand_name (name_key),
  KEY ix_brand_status (status)
) ENGINE=InnoDB;

ALTER TABLE products
  ADD COLUMN category_id BIGINT UNSIGNED NULL,
  ADD COLUMN brand_id BIGINT UNSIGNED NULL,
  ADD COLUMN review_status ENUM('approved','pending','rejected') NOT NULL DEFAULT 'approved',
  ADD COLUMN review_note VARCHAR(300) NULL,
  ADD COLUMN reviewed_by BIGINT UNSIGNED NULL,
  ADD COLUMN reviewed_at DATETIME NULL,
  ADD KEY ix_prod_category (category_id),
  ADD KEY ix_prod_brand (brand_id),
  ADD KEY ix_prod_review (review_status, distributor_id);

-- Existing free-text values become managed entries (already in use, so they start active), and products point at them.
INSERT INTO categories (name, name_key, status)
  SELECT MIN(TRIM(category)), LOWER(TRIM(category)), 'active' FROM products
  WHERE category IS NOT NULL AND TRIM(category) <> '' GROUP BY LOWER(TRIM(category));
INSERT INTO brands (name, name_key, status)
  SELECT MIN(TRIM(brand)), LOWER(TRIM(brand)), 'active' FROM products
  WHERE brand IS NOT NULL AND TRIM(brand) <> '' GROUP BY LOWER(TRIM(brand));
UPDATE products p JOIN categories c ON c.parent_key = 0 AND c.name_key = LOWER(TRIM(p.category)) SET p.category_id = c.id;
UPDATE products p JOIN brands b ON b.name_key = LOWER(TRIM(p.brand)) SET p.brand_id = b.id;

-- Every change to a product's details, newest last. `changes` lists only the fields that differ from the previous version.
CREATE TABLE product_versions (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  product_id BIGINT UNSIGNED NOT NULL,
  version_no INT NOT NULL,
  change_type VARCHAR(30) NOT NULL,
  actor_id BIGINT UNSIGNED NULL,
  snapshot TEXT NOT NULL,
  changes TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_pv (product_id, version_no),
  CONSTRAINT fk_pv_product FOREIGN KEY (product_id) REFERENCES products(id)
) ENGINE=InnoDB;

INSERT IGNORE INTO platform_settings (name, value) VALUES ('product_approval_required', '0');
