-- Money columns are integer paise (BIGINT). JSON-ish columns are TEXT for MySQL/MariaDB portability.
CREATE TABLE users (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  role ENUM('admin','distributor','employee','retailer') NOT NULL,
  phone VARCHAR(15) NOT NULL,
  name VARCHAR(120) NOT NULL,
  email VARCHAR(190) NULL,
  password_hash VARCHAR(100) NOT NULL,
  owner_distributor_id BIGINT UNSIGNED NULL COMMENT 'for employees: the distributor they work for',
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_users_phone (phone),
  KEY ix_users_owner (owner_distributor_id),
  CONSTRAINT fk_users_owner FOREIGN KEY (owner_distributor_id) REFERENCES users(id)
) ENGINE=InnoDB;

CREATE TABLE refresh_tokens (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT UNSIGNED NOT NULL,
  token_hash CHAR(64) NOT NULL,
  expires_at DATETIME NOT NULL,
  revoked_at DATETIME NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_rt_hash (token_hash),
  CONSTRAINT fk_rt_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE distributor_profiles (
  user_id BIGINT UNSIGNED PRIMARY KEY,
  business_name VARCHAR(190) NOT NULL,
  gst_no VARCHAR(20) NULL,
  bank_account_details TEXT NULL,
  permissions TEXT NOT NULL,
  commission_rate_bps INT NOT NULL DEFAULT 200,
  subscription_ends_at DATETIME NOT NULL,
  expiry_warned_at DATETIME NULL,
  CONSTRAINT fk_dp_user FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB;

CREATE TABLE retailer_profiles (
  user_id BIGINT UNSIGNED PRIMARY KEY,
  shop_name VARCHAR(190) NOT NULL,
  pincode CHAR(6) NOT NULL,
  address VARCHAR(255) NULL,
  KEY ix_rp_pin (pincode),
  CONSTRAINT fk_rp_user FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB;

CREATE TABLE service_pincodes (
  distributor_id BIGINT UNSIGNED NOT NULL,
  pincode CHAR(6) NOT NULL,
  PRIMARY KEY (distributor_id, pincode),
  KEY ix_sp_pin (pincode),
  CONSTRAINT fk_sp_dist FOREIGN KEY (distributor_id) REFERENCES users(id)
) ENGINE=InnoDB;

-- One row per retailer<->distributor pair; also holds the running ledger balance (lock target).
CREATE TABLE retailer_distributor_relations (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  retailer_id BIGINT UNSIGNED NOT NULL,
  distributor_id BIGINT UNSIGNED NOT NULL,
  is_primary TINYINT(1) NOT NULL DEFAULT 0,
  balance_due_paise BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_rdr (retailer_id, distributor_id),
  KEY ix_rdr_dist (distributor_id),
  CONSTRAINT fk_rdr_r FOREIGN KEY (retailer_id) REFERENCES users(id),
  CONSTRAINT fk_rdr_d FOREIGN KEY (distributor_id) REFERENCES users(id)
) ENGINE=InnoDB;

CREATE TABLE products (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  distributor_id BIGINT UNSIGNED NOT NULL,
  name VARCHAR(190) NOT NULL,
  sku VARCHAR(60) NULL,
  price_paise BIGINT NOT NULL,
  stock_qty INT NOT NULL DEFAULT 0,
  hsn VARCHAR(10) NULL,
  gst_rate_bps INT NOT NULL DEFAULT 0,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  deleted_at DATETIME NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_prod_dist (distributor_id, deleted_at),
  CONSTRAINT fk_prod_dist FOREIGN KEY (distributor_id) REFERENCES users(id)
) ENGINE=InnoDB;

CREATE TABLE orders (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  retailer_id BIGINT UNSIGNED NOT NULL,
  distributor_id BIGINT UNSIGNED NOT NULL,
  status ENUM('placed','accepted','dispatched','out_for_delivery','delivered','rejected','cancelled') NOT NULL DEFAULT 'placed',
  total_paise BIGINT NOT NULL,
  is_out_of_hierarchy TINYINT(1) NOT NULL DEFAULT 0,
  commission_rate_bps INT NOT NULL DEFAULT 0,
  assigned_employee_id BIGINT UNSIGNED NULL,
  idempotency_key VARCHAR(80) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_order_idem (retailer_id, idempotency_key),
  KEY ix_order_dist (distributor_id, status),
  KEY ix_order_emp (assigned_employee_id),
  CONSTRAINT fk_o_r FOREIGN KEY (retailer_id) REFERENCES users(id),
  CONSTRAINT fk_o_d FOREIGN KEY (distributor_id) REFERENCES users(id),
  CONSTRAINT fk_o_e FOREIGN KEY (assigned_employee_id) REFERENCES users(id)
) ENGINE=InnoDB;

CREATE TABLE order_items (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  order_id BIGINT UNSIGNED NOT NULL,
  product_id BIGINT UNSIGNED NOT NULL,
  name VARCHAR(190) NOT NULL,
  qty INT NOT NULL,
  unit_price_paise BIGINT NOT NULL,
  gst_rate_bps INT NOT NULL,
  line_total_paise BIGINT NOT NULL,
  KEY ix_oi_order (order_id),
  CONSTRAINT fk_oi_o FOREIGN KEY (order_id) REFERENCES orders(id),
  CONSTRAINT fk_oi_p FOREIGN KEY (product_id) REFERENCES products(id)
) ENGINE=InnoDB;

CREATE TABLE order_events (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  order_id BIGINT UNSIGNED NOT NULL,
  from_status VARCHAR(20) NULL,
  to_status VARCHAR(20) NOT NULL,
  actor_id BIGINT UNSIGNED NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_oe_order (order_id),
  CONSTRAINT fk_oe_o FOREIGN KEY (order_id) REFERENCES orders(id)
) ENGINE=InnoDB;

-- Append-only. Corrections are new rows (reversal_of). delta_paise > 0 increases what the retailer owes.
CREATE TABLE ledger_transactions (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  distributor_id BIGINT UNSIGNED NOT NULL,
  retailer_id BIGINT UNSIGNED NOT NULL,
  order_id BIGINT UNSIGNED NULL,
  type ENUM('invoice','payment_cash','payment_online','credit_note','debit_note','reversal') NOT NULL,
  amount_paise BIGINT NOT NULL,
  delta_paise BIGINT NOT NULL,
  balance_after_paise BIGINT NOT NULL,
  payment_mode VARCHAR(20) NULL,
  cash_denominations TEXT NULL,
  gateway_event_id VARCHAR(80) NULL,
  reversal_of BIGINT UNSIGNED NULL,
  notes VARCHAR(500) NULL,
  created_by BIGINT UNSIGNED NOT NULL,
  idempotency_key VARCHAR(80) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_ledger_idem (created_by, idempotency_key),
  UNIQUE KEY uq_ledger_gateway (gateway_event_id),
  UNIQUE KEY uq_ledger_reversal (reversal_of),
  KEY ix_ledger_pair (distributor_id, retailer_id, id),
  CONSTRAINT fk_l_d FOREIGN KEY (distributor_id) REFERENCES users(id),
  CONSTRAINT fk_l_r FOREIGN KEY (retailer_id) REFERENCES users(id)
) ENGINE=InnoDB;

CREATE TABLE audit_log (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  actor_id BIGINT UNSIGNED NULL,
  action VARCHAR(60) NOT NULL,
  entity VARCHAR(40) NOT NULL,
  entity_id BIGINT UNSIGNED NULL,
  meta TEXT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_audit_entity (entity, entity_id)
) ENGINE=InnoDB;
