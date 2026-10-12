-- Subscription plans and payments, offers (announcements), employee availability.

-- Plans the platform sells to distributors. Price and length are editable by the admin.
CREATE TABLE subscription_plans (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(60) NOT NULL,
  days INT NOT NULL,
  price_paise BIGINT NOT NULL,
  description VARCHAR(200) NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

INSERT INTO subscription_plans (name, days, price_paise, description, sort_order) VALUES
  ('Monthly', 30, 99900, '30 days', 1),
  ('Quarterly', 90, 249900, '90 days, save 17%', 2),
  ('Yearly', 365, 899900, '365 days, save 25%', 3);

-- A distributor paying the platform. UPI payments wait for an admin to confirm; gateway payments confirm themselves.
CREATE TABLE subscription_payments (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  distributor_id BIGINT UNSIGNED NOT NULL,
  plan_id BIGINT UNSIGNED NOT NULL,
  plan_name VARCHAR(60) NOT NULL,
  days INT NOT NULL,
  amount_paise BIGINT NOT NULL,
  method ENUM('upi','gateway') NOT NULL,
  utr VARCHAR(30) NULL,
  gateway_ref VARCHAR(80) NULL,
  gateway_payment_id VARCHAR(80) NULL,
  checkout_url VARCHAR(300) NULL,
  status ENUM('pending','confirmed','rejected','failed') NOT NULL DEFAULT 'pending',
  idempotency_key VARCHAR(80) NOT NULL,
  decided_by BIGINT UNSIGNED NULL,
  decided_at DATETIME NULL,
  extended_to DATETIME NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_sp_idem (distributor_id, idempotency_key),
  UNIQUE KEY uq_sp_utr (utr),
  UNIQUE KEY uq_sp_gateway (gateway_ref),
  KEY ix_sp_status (status, id),
  CONSTRAINT fk_sp_d FOREIGN KEY (distributor_id) REFERENCES users(id),
  CONSTRAINT fk_sp_plan FOREIGN KEY (plan_id) REFERENCES subscription_plans(id)
) ENGINE=InnoDB;

ALTER TABLE distributor_profiles ADD COLUMN plan_name VARCHAR(60) NULL;

-- Small key/value settings the admin controls (the company's own UPI id, for example).
CREATE TABLE platform_settings (
  name VARCHAR(60) PRIMARY KEY,
  value VARCHAR(300) NOT NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- Offers and news a distributor sends to retailers.
CREATE TABLE announcements (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  distributor_id BIGINT UNSIGNED NOT NULL,
  title VARCHAR(80) NOT NULL,
  body VARCHAR(500) NOT NULL,
  audience ENUM('all','pincodes') NOT NULL DEFAULT 'all',
  pincodes TEXT NULL,
  product_id BIGINT UNSIGNED NULL,
  valid_until DATE NULL,
  recipients INT NOT NULL DEFAULT 0,
  created_by BIGINT UNSIGNED NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_ann_dist (distributor_id, id),
  CONSTRAINT fk_ann_d FOREIGN KEY (distributor_id) REFERENCES users(id)
) ENGINE=InnoDB;

ALTER TABLE retailer_profiles ADD COLUMN offers_seen_at DATETIME NULL;

-- Delivery staff can be marked unavailable (on leave) so work is not given to them.
ALTER TABLE users ADD COLUMN is_available TINYINT(1) NOT NULL DEFAULT 1;
