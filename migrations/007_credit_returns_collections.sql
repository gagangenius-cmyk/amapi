-- Credit terms per retailer<->distributor pair, order returns (credit notes), and collection reminders.
ALTER TABLE retailer_distributor_relations
  ADD COLUMN credit_limit_paise BIGINT NULL,
  ADD COLUMN credit_days INT NOT NULL DEFAULT 0;

CREATE TABLE order_returns (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  order_id BIGINT UNSIGNED NOT NULL,
  retailer_id BIGINT UNSIGNED NOT NULL,
  distributor_id BIGINT UNSIGNED NOT NULL,
  status ENUM('requested','approved','rejected') NOT NULL DEFAULT 'requested',
  reason VARCHAR(500) NOT NULL,
  total_paise BIGINT NOT NULL,
  restock TINYINT(1) NOT NULL DEFAULT 0,
  resolution_note VARCHAR(500) NULL,
  resolved_by BIGINT UNSIGNED NULL,
  resolved_at TIMESTAMP NULL,
  idempotency_key VARCHAR(80) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_return_idem (retailer_id, idempotency_key),
  KEY ix_return_dist (distributor_id, status, id),
  KEY ix_return_order (order_id),
  CONSTRAINT fk_ret_o FOREIGN KEY (order_id) REFERENCES orders(id),
  CONSTRAINT fk_ret_r FOREIGN KEY (retailer_id) REFERENCES users(id),
  CONSTRAINT fk_ret_d FOREIGN KEY (distributor_id) REFERENCES users(id)
) ENGINE=InnoDB;

CREATE TABLE order_return_items (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  return_id BIGINT UNSIGNED NOT NULL,
  product_id BIGINT UNSIGNED NOT NULL,
  name VARCHAR(190) NOT NULL,
  qty INT NOT NULL,
  unit_price_paise BIGINT NOT NULL,
  gst_rate_bps INT NOT NULL,
  line_total_paise BIGINT NOT NULL,
  KEY ix_ri_return (return_id),
  CONSTRAINT fk_ri_ret FOREIGN KEY (return_id) REFERENCES order_returns(id)
) ENGINE=InnoDB;

CREATE TABLE collection_reminders (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  distributor_id BIGINT UNSIGNED NOT NULL,
  retailer_id BIGINT UNSIGNED NOT NULL,
  amount_paise BIGINT NOT NULL,
  source ENUM('manual','auto') NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_rem_pair (distributor_id, retailer_id, created_at)
) ENGINE=InnoDB;

-- Goods coming back from a retailer return to stock through the same audited path.
ALTER TABLE stock_movements
  MODIFY reason ENUM('initial','manual','import','bulk','order_accepted','order_cancelled','correction','customer_return') NOT NULL;
