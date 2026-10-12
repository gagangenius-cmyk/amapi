-- Customer, group, regional and promotional price lists. A distributor's standard price and quantity breaks still apply
-- to everyone; a price list changes the price for the retailers it applies to. See modules/pricing/resolver.ts for the
-- precedence rules.
CREATE TABLE price_lists (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  distributor_id BIGINT UNSIGNED NOT NULL,
  name VARCHAR(80) NOT NULL,
  kind ENUM('contract','promotion','group','regional') NOT NULL,
  priority INT NOT NULL DEFAULT 0 COMMENT 'among lists of the same kind, the higher number wins',
  valid_from DATE NULL,
  valid_to DATE NULL,
  pincode_prefixes TEXT NULL COMMENT 'regional lists: JSON array of pincode prefixes, e.g. ["400","4010"]',
  allow_above_standard TINYINT(1) NOT NULL DEFAULT 0 COMMENT '0: a list price is never higher than the standard price',
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_by BIGINT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_pl_name (distributor_id, name),
  KEY ix_pl_dist (distributor_id, is_active),
  CONSTRAINT fk_pl_dist FOREIGN KEY (distributor_id) REFERENCES users(id)
) ENGINE=InnoDB;

CREATE TABLE price_list_members (
  price_list_id BIGINT UNSIGNED NOT NULL,
  retailer_id BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (price_list_id, retailer_id),
  KEY ix_plm_retailer (retailer_id),
  CONSTRAINT fk_plm_list FOREIGN KEY (price_list_id) REFERENCES price_lists(id) ON DELETE CASCADE,
  CONSTRAINT fk_plm_retailer FOREIGN KEY (retailer_id) REFERENCES users(id)
) ENGINE=InnoDB;

CREATE TABLE price_list_items (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  price_list_id BIGINT UNSIGNED NOT NULL,
  product_id BIGINT UNSIGNED NOT NULL,
  mode ENUM('fixed','percent_off') NOT NULL,
  value BIGINT NOT NULL COMMENT 'fixed: price in paise. percent_off: basis points off the standard price (1000 = 10%)',
  min_qty INT NOT NULL DEFAULT 1,
  UNIQUE KEY uq_pli (price_list_id, product_id, min_qty),
  KEY ix_pli_product (product_id),
  CONSTRAINT fk_pli_list FOREIGN KEY (price_list_id) REFERENCES price_lists(id) ON DELETE CASCADE,
  CONSTRAINT fk_pli_product FOREIGN KEY (product_id) REFERENCES products(id)
) ENGINE=InnoDB;

-- What each order line was priced at, and why. Written once at order time, never recomputed, so a later change to a
-- list or to the catalogue price cannot change a past order. The list name is copied so it survives the list being removed.
ALTER TABLE order_items
  ADD COLUMN standard_unit_price_paise BIGINT NULL COMMENT 'the standard (tier-aware) unit price at order time',
  ADD COLUMN price_list_id BIGINT UNSIGNED NULL,
  ADD COLUMN price_list_name VARCHAR(80) NULL,
  ADD COLUMN price_basis ENUM('standard','tier','list') NULL;
