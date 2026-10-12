-- Barcodes, variants (grouped products) and batch / expiry tracking.
ALTER TABLE products
  ADD COLUMN barcode VARCHAR(40) NULL,
  ADD COLUMN variant_group VARCHAR(80) NULL,
  ADD COLUMN variant_label VARCHAR(60) NULL,
  ADD UNIQUE KEY uq_prod_barcode (distributor_id, barcode),
  ADD KEY ix_prod_variant (distributor_id, variant_group);

-- A lot of stock with its own expiry. Optional per product: stock not in any batch is simply "untracked" stock.
CREATE TABLE product_batches (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  product_id BIGINT UNSIGNED NOT NULL,
  distributor_id BIGINT UNSIGNED NOT NULL,
  batch_no VARCHAR(60) NOT NULL,
  expiry_date DATE NULL,
  qty_received INT NOT NULL,
  qty_remaining INT NOT NULL,
  received_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_batch_fefo (product_id, expiry_date, id),
  KEY ix_batch_expiry (distributor_id, expiry_date),
  CONSTRAINT fk_batch_prod FOREIGN KEY (product_id) REFERENCES products(id)
) ENGINE=InnoDB;

-- Which batches an order took from, so a cancellation puts the goods back in the same batches.
CREATE TABLE batch_allocations (
  order_id BIGINT UNSIGNED NOT NULL,
  batch_id BIGINT UNSIGNED NOT NULL,
  qty INT NOT NULL,
  PRIMARY KEY (order_id, batch_id),
  CONSTRAINT fk_ba_batch FOREIGN KEY (batch_id) REFERENCES product_batches(id)
) ENGINE=InnoDB;
