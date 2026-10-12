-- Commission rules, an entry per earning or reversal, and settlement batches.
--
-- Commission is what a distributor owes the platform for an order a retailer placed with them outside the retailer's own
-- hierarchy. The rule is resolved when the order is PLACED and snapshotted on the order line, so editing a rule later never
-- changes an order already taken. The amount is earned when the order is DELIVERED and reversed in proportion when a
-- return is approved. Entries are append-only; a settlement batch claims entries and is approved, then paid.

CREATE TABLE commission_rules (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  distributor_id BIGINT UNSIGNED NULL COMMENT 'NULL = applies to every distributor',
  category_id BIGINT UNSIGNED NULL,
  product_id BIGINT UNSIGNED NULL,
  mode ENUM('percent','fixed_unit') NOT NULL,
  value INT NOT NULL COMMENT 'percent: basis points of the line value excluding GST. fixed_unit: paise per unit',
  priority INT NOT NULL DEFAULT 0,
  valid_from DATE NULL,
  valid_to DATE NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  note VARCHAR(200) NULL,
  created_by BIGINT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_cr_dist (distributor_id, is_active),
  CONSTRAINT fk_cr_dist FOREIGN KEY (distributor_id) REFERENCES users(id),
  CONSTRAINT fk_cr_cat FOREIGN KEY (category_id) REFERENCES categories(id),
  CONSTRAINT fk_cr_prod FOREIGN KEY (product_id) REFERENCES products(id)
) ENGINE=InnoDB;

CREATE TABLE commission_settlements (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  distributor_id BIGINT UNSIGNED NOT NULL,
  period_from DATE NOT NULL,
  period_to DATE NOT NULL,
  entry_count INT NOT NULL,
  amount_paise BIGINT NOT NULL,
  status ENUM('draft','approved','paid','cancelled') NOT NULL DEFAULT 'draft',
  created_by BIGINT UNSIGNED NOT NULL,
  approved_by BIGINT UNSIGNED NULL,
  approved_at DATETIME NULL,
  paid_by BIGINT UNSIGNED NULL,
  paid_at DATETIME NULL,
  payment_ref VARCHAR(60) NULL,
  note VARCHAR(300) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_cs_dist (distributor_id, status),
  CONSTRAINT fk_cs_dist FOREIGN KEY (distributor_id) REFERENCES users(id)
) ENGINE=InnoDB;

CREATE TABLE commission_entries (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  distributor_id BIGINT UNSIGNED NOT NULL,
  order_id BIGINT UNSIGNED NOT NULL,
  order_item_id BIGINT UNSIGNED NULL,
  return_item_id BIGINT UNSIGNED NULL,
  kind ENUM('earned','reversal','legacy') NOT NULL,
  dedupe_key VARCHAR(40) NOT NULL COMMENT 'e:<order item>, r:<return item>, l:<order>: a retried event cannot make a second entry',
  basis_paise BIGINT NOT NULL,
  mode ENUM('percent','fixed_unit') NOT NULL,
  value INT NOT NULL,
  rule_id BIGINT UNSIGNED NULL,
  amount_paise BIGINT NOT NULL COMMENT 'positive: owed to the platform. negative: a reversal',
  occurred_at DATETIME NOT NULL,
  settlement_id BIGINT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_ce_dedupe (dedupe_key),
  KEY ix_ce_dist (distributor_id, settlement_id, occurred_at),
  KEY ix_ce_order (order_id),
  KEY ix_ce_settlement (settlement_id),
  CONSTRAINT fk_ce_dist FOREIGN KEY (distributor_id) REFERENCES users(id),
  CONSTRAINT fk_ce_settlement FOREIGN KEY (settlement_id) REFERENCES commission_settlements(id)
) ENGINE=InnoDB;

ALTER TABLE order_items
  ADD COLUMN commission_mode ENUM('percent','fixed_unit') NULL,
  ADD COLUMN commission_value INT NULL,
  ADD COLUMN commission_rule_id BIGINT UNSIGNED NULL;

INSERT IGNORE INTO platform_settings (name, value) VALUES ('settlement_dual_control', '0');

-- Commission already earned before this feature: one "legacy" entry per delivered out-of-hierarchy order, computed the way
-- the old report did (rate snapshotted on the order, on the order total), so historical figures do not move.
INSERT INTO commission_entries (distributor_id, order_id, kind, dedupe_key, basis_paise, mode, value, amount_paise, occurred_at)
  SELECT o.distributor_id, o.id, 'legacy', CONCAT('l:', o.id), o.total_paise, 'percent', o.commission_rate_bps,
         ROUND(o.total_paise * o.commission_rate_bps / 10000),
         COALESCE((SELECT MIN(e.created_at) FROM order_events e WHERE e.order_id = o.id AND e.to_status = 'delivered'), o.created_at)
  FROM orders o WHERE o.is_out_of_hierarchy = 1 AND o.status = 'delivered' AND o.commission_rate_bps > 0;
