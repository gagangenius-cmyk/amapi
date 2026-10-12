-- Inventory: warehouses, per-warehouse balances, a damaged-stock bucket, and a cost price for valuation.
--
-- Invariant kept by changeStock(): for every product, the sum of its inventory_balances equals products.stock_qty (sellable
-- on-hand). stock_movements stays the ledger: the sum of a product's on_hand movements equals stock_qty as well, which the
-- reconciliation report checks.

CREATE TABLE warehouses (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  distributor_id BIGINT UNSIGNED NOT NULL,
  name VARCHAR(80) NOT NULL,
  name_key VARCHAR(80) NOT NULL,
  address VARCHAR(255) NULL,
  is_default TINYINT(1) NOT NULL DEFAULT 0,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_wh_name (distributor_id, name_key),
  KEY ix_wh_dist (distributor_id, is_active),
  CONSTRAINT fk_wh_dist FOREIGN KEY (distributor_id) REFERENCES users(id)
) ENGINE=InnoDB;

CREATE TABLE inventory_balances (
  product_id BIGINT UNSIGNED NOT NULL,
  warehouse_id BIGINT UNSIGNED NOT NULL,
  qty INT NOT NULL DEFAULT 0,
  damaged_qty INT NOT NULL DEFAULT 0,
  PRIMARY KEY (product_id, warehouse_id),
  KEY ix_ib_wh (warehouse_id),
  CONSTRAINT fk_ib_product FOREIGN KEY (product_id) REFERENCES products(id),
  CONSTRAINT fk_ib_wh FOREIGN KEY (warehouse_id) REFERENCES warehouses(id)
) ENGINE=InnoDB;

ALTER TABLE products
  ADD COLUMN damaged_qty INT NOT NULL DEFAULT 0 COMMENT 'units set aside as damaged: not for sale, not in stock_qty',
  ADD COLUMN cost_paise BIGINT NULL COMMENT 'what the distributor paid per unit; used only for stock valuation';

ALTER TABLE stock_movements
  ADD COLUMN warehouse_id BIGINT UNSIGNED NULL,
  ADD COLUMN bucket ENUM('on_hand','damaged') NOT NULL DEFAULT 'on_hand',
  MODIFY reason ENUM('initial','manual','import','bulk','order_accepted','order_cancelled','correction','customer_return',
                     'transfer_out','transfer_in','damaged','damaged_recovered','damaged_writeoff') NOT NULL,
  ADD KEY ix_sm_wh (warehouse_id);

-- Every distributor that already has stock gets a default warehouse holding all of it.
INSERT INTO warehouses (distributor_id, name, name_key, is_default)
  SELECT DISTINCT p.distributor_id, 'Main warehouse', 'main warehouse', 1 FROM products p;
INSERT INTO inventory_balances (product_id, warehouse_id, qty)
  SELECT p.id, w.id, p.stock_qty FROM products p JOIN warehouses w ON w.distributor_id = p.distributor_id AND w.is_default = 1;
