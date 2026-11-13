-- Distributors sell AAYME subscriptions to retailers (the retailer's B2C online store) and earn commission.
-- Company -> distributor (sales partner) -> retailer (buys a subscription, runs an online store) -> end customers.

-- Subscription plans a retailer can buy. The admin sets name, price, validity and the default commission for each kind of sale.
CREATE TABLE retailer_plans (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(60) NOT NULL,
  days INT NOT NULL,
  price_paise BIGINT NOT NULL,
  description VARCHAR(200) NULL,
  features TEXT NULL COMMENT 'JSON list of short feature lines',
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  sort_order INT NOT NULL DEFAULT 0,
  commission_new_bps INT NOT NULL DEFAULT 0 COMMENT 'default commission (basis points of the amount paid) on a first subscription',
  commission_renewal_bps INT NOT NULL DEFAULT 0,
  commission_upgrade_bps INT NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- A distributor's own commission rates, overriding the plan's defaults. plan_id NULL = every plan. A NULL rate falls through to the next level.
CREATE TABLE distributor_commission_rates (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  distributor_id BIGINT UNSIGNED NOT NULL,
  plan_id BIGINT UNSIGNED NULL,
  plan_key BIGINT UNSIGNED NOT NULL DEFAULT 0 COMMENT 'plan_id, or 0 for every plan (lets the unique key work with NULL)',
  new_bps INT NULL,
  renewal_bps INT NULL,
  upgrade_bps INT NULL,
  UNIQUE KEY uq_dcr (distributor_id, plan_key),
  CONSTRAINT fk_dcr_d FOREIGN KEY (distributor_id) REFERENCES users(id),
  CONSTRAINT fk_dcr_p FOREIGN KEY (plan_id) REFERENCES retailer_plans(id)
) ENGINE=InnoDB;

-- The retailer's subscription periods (one row per paid purchase; the latest unexpired one is the current plan).
CREATE TABLE retailer_subscriptions (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  retailer_id BIGINT UNSIGNED NOT NULL,
  plan_id BIGINT UNSIGNED NOT NULL,
  plan_name VARCHAR(60) NOT NULL,
  price_paise BIGINT NOT NULL,
  starts_at DATETIME NOT NULL,
  ends_at DATETIME NOT NULL,
  status ENUM('active','cancelled') NOT NULL DEFAULT 'active',
  sold_by BIGINT UNSIGNED NULL,
  sale_id BIGINT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_rs_ret (retailer_id, ends_at),
  CONSTRAINT fk_rs_r FOREIGN KEY (retailer_id) REFERENCES users(id),
  CONSTRAINT fk_rs_p FOREIGN KEY (plan_id) REFERENCES retailer_plans(id)
) ENGINE=InnoDB;

-- One row per subscription a distributor sells. The plan name, validity and price are copied, so editing a plan never changes a past sale.
CREATE TABLE subscription_sales (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  distributor_id BIGINT UNSIGNED NOT NULL,
  retailer_id BIGINT UNSIGNED NOT NULL,
  plan_id BIGINT UNSIGNED NOT NULL,
  plan_name VARCHAR(60) NOT NULL,
  days INT NOT NULL,
  kind ENUM('new','renewal','upgrade') NOT NULL,
  amount_paise BIGINT NOT NULL,
  method ENUM('upi','bank','cheque','cash') NULL,
  reference VARCHAR(60) NULL COMMENT 'UPI UTR / bank reference / cheque number',
  note VARCHAR(200) NULL,
  status ENUM('awaiting_payment','payment_submitted','paid','rejected','cancelled','refunded') NOT NULL DEFAULT 'awaiting_payment',
  commission_bps INT NOT NULL DEFAULT 0,
  commission_paise BIGINT NOT NULL DEFAULT 0,
  commission_status ENUM('none','accrued','settled','reversed') NOT NULL DEFAULT 'none',
  clawback TINYINT(1) NOT NULL DEFAULT 0 COMMENT 'refunded after the commission was already paid out: to be recovered',
  settlement_ref VARCHAR(80) NULL,
  settled_at DATETIME NULL,
  lead_id BIGINT UNSIGNED NULL,
  decided_by BIGINT UNSIGNED NULL,
  decided_at DATETIME NULL,
  decision_note VARCHAR(200) NULL,
  paid_at DATETIME NULL,
  refunded_at DATETIME NULL,
  subscription_id BIGINT UNSIGNED NULL,
  previous_plan_id BIGINT UNSIGNED NULL COMMENT 'upgrade: the plan the retailer was on',
  previous_plan_name VARCHAR(60) NULL,
  previous_price_paise BIGINT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_ss_dist (distributor_id, created_at),
  KEY ix_ss_ret (retailer_id),
  KEY ix_ss_status (status),
  CONSTRAINT fk_ss_d FOREIGN KEY (distributor_id) REFERENCES users(id),
  CONSTRAINT fk_ss_r FOREIGN KEY (retailer_id) REFERENCES users(id),
  CONSTRAINT fk_ss_p FOREIGN KEY (plan_id) REFERENCES retailer_plans(id)
) ENGINE=InnoDB;

-- Retailers a distributor is working on, before they buy.
CREATE TABLE retailer_leads (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  distributor_id BIGINT UNSIGNED NOT NULL,
  name VARCHAR(120) NOT NULL,
  phone VARCHAR(15) NOT NULL,
  shop_name VARCHAR(190) NULL,
  city VARCHAR(80) NULL,
  pincode CHAR(6) NULL,
  note VARCHAR(500) NULL,
  status ENUM('new','contacted','interested','converted','lost') NOT NULL DEFAULT 'new',
  retailer_id BIGINT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY ix_lead_dist (distributor_id, status),
  CONSTRAINT fk_lead_d FOREIGN KEY (distributor_id) REFERENCES users(id)
) ENGINE=InnoDB;

-- Monthly sales targets the admin sets for a distributor.
CREATE TABLE distributor_targets (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  distributor_id BIGINT UNSIGNED NOT NULL,
  month CHAR(7) NOT NULL COMMENT 'YYYY-MM',
  target_amount_paise BIGINT NOT NULL DEFAULT 0,
  target_count INT NOT NULL DEFAULT 0,
  UNIQUE KEY uq_dt (distributor_id, month),
  CONSTRAINT fk_dt_d FOREIGN KEY (distributor_id) REFERENCES users(id)
) ENGINE=InnoDB;
