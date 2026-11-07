-- Staged payments on an order (for example 30% advance, 70% on delivery). Stored as a share of the order total, so the amounts follow the
-- order if it is partly accepted. This tracks the agreed schedule (pending / paid); the money itself is still recorded in the khata or payments.
CREATE TABLE order_milestones (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  order_id BIGINT UNSIGNED NOT NULL,
  seq TINYINT UNSIGNED NOT NULL,
  label VARCHAR(60) NOT NULL,
  pct_bps INT UNSIGNED NOT NULL COMMENT 'share of the order total in basis points; all milestones of an order add up to 10000',
  due_event ENUM('order','accepted','dispatched','delivered') NOT NULL DEFAULT 'order',
  status ENUM('pending','paid') NOT NULL DEFAULT 'pending',
  paid_at TIMESTAMP NULL,
  paid_by BIGINT UNSIGNED NULL,
  method VARCHAR(20) NULL,
  reference VARCHAR(80) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_milestone_seq (order_id, seq),
  CONSTRAINT fk_ms_o FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
) ENGINE=InnoDB;
