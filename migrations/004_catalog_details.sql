-- Richer product records: grouping, units, MRP, minimum order quantity and low-stock alerts.
ALTER TABLE products
  ADD COLUMN category VARCHAR(80) NULL AFTER sku,
  ADD COLUMN brand VARCHAR(80) NULL AFTER category,
  ADD COLUMN unit VARCHAR(20) NOT NULL DEFAULT 'pcs' AFTER brand,
  ADD COLUMN description VARCHAR(500) NULL AFTER unit,
  ADD COLUMN mrp_paise BIGINT NULL AFTER price_paise,
  ADD COLUMN min_order_qty INT NOT NULL DEFAULT 1 AFTER stock_qty,
  ADD COLUMN low_stock_threshold INT NOT NULL DEFAULT 10 AFTER min_order_qty,
  ADD KEY ix_prod_cat (distributor_id, category),
  ADD UNIQUE KEY uq_prod_sku (distributor_id, sku);

-- Quantity-break pricing: "from min_qty units the price is price_paise". The base price applies below the first tier.
CREATE TABLE product_price_tiers (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  product_id BIGINT UNSIGNED NOT NULL,
  min_qty INT NOT NULL,
  price_paise BIGINT NOT NULL,
  UNIQUE KEY uq_tier (product_id, min_qty),
  CONSTRAINT fk_tier_prod FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Every stock change, who made it and why. Append-only, like the ledger.
CREATE TABLE stock_movements (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  product_id BIGINT UNSIGNED NOT NULL,
  distributor_id BIGINT UNSIGNED NOT NULL,
  delta INT NOT NULL,
  balance_after INT NOT NULL,
  reason ENUM('initial','manual','import','bulk','order_accepted','order_cancelled','correction') NOT NULL,
  ref_order_id BIGINT UNSIGNED NULL,
  note VARCHAR(200) NULL,
  actor_id BIGINT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_sm_product (product_id, id),
  KEY ix_sm_dist (distributor_id, id),
  CONSTRAINT fk_sm_prod FOREIGN KEY (product_id) REFERENCES products(id)
) ENGINE=InnoDB;

-- Price changes are kept too, so a disputed invoice can be explained later.
CREATE TABLE price_history (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  product_id BIGINT UNSIGNED NOT NULL,
  old_price_paise BIGINT NULL,
  new_price_paise BIGINT NOT NULL,
  actor_id BIGINT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_ph_product (product_id, id),
  CONSTRAINT fk_ph_prod FOREIGN KEY (product_id) REFERENCES products(id)
) ENGINE=InnoDB;
