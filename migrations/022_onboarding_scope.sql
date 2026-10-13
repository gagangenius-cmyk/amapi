-- Paid distributor onboarding, category scope, social links, cash on delivery, targeted offers, per-distributor product review.

-- A distributor a company employee wants to onboard. The account does NOT exist until the subscription fee has been received:
-- the request holds everything needed, and payment turns it into a real account with its subscription timer starting then.
CREATE TABLE onboarding_requests (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  created_by BIGINT UNSIGNED NOT NULL,
  phone VARCHAR(15) NOT NULL,
  email VARCHAR(190) NULL,
  owner_name VARCHAR(120) NOT NULL,
  password_hash VARCHAR(100) NOT NULL,
  business_name VARCHAR(190) NOT NULL,
  gst_no VARCHAR(20) NULL,
  address VARCHAR(255) NULL,
  city VARCHAR(100) NULL,
  pincode CHAR(6) NULL,
  permissions TEXT NOT NULL COMMENT 'JSON: the feature switches the employee chose, already checked against what they may grant',
  category_ids TEXT NOT NULL COMMENT 'JSON array of category ids the distributor deals in',
  review_required TINYINT(1) NOT NULL DEFAULT 0,
  plan_id BIGINT UNSIGNED NOT NULL,
  plan_name VARCHAR(60) NOT NULL,
  days INT NOT NULL,
  amount_paise BIGINT NOT NULL,
  method ENUM('upi','gateway') NOT NULL,
  utr VARCHAR(30) NULL,
  gateway_ref VARCHAR(80) NULL,
  gateway_payment_id VARCHAR(80) NULL,
  checkout_url VARCHAR(300) NULL,
  status ENUM('awaiting_payment','payment_submitted','completed','cancelled','failed') NOT NULL DEFAULT 'awaiting_payment',
  distributor_id BIGINT UNSIGNED NULL,
  error VARCHAR(300) NULL,
  decided_by BIGINT UNSIGNED NULL,
  decided_at DATETIME NULL,
  completed_at DATETIME NULL,
  idempotency_key VARCHAR(80) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_ob_idem (created_by, idempotency_key),
  UNIQUE KEY uq_ob_utr (utr),
  UNIQUE KEY uq_ob_gateway (gateway_ref),
  KEY ix_ob_status (status, id),
  KEY ix_ob_creator (created_by, id),
  KEY ix_ob_phone (phone, status),
  CONSTRAINT fk_ob_creator FOREIGN KEY (created_by) REFERENCES users(id),
  CONSTRAINT fk_ob_plan FOREIGN KEY (plan_id) REFERENCES subscription_plans(id)
) ENGINE=InnoDB;

-- What a distributor deals in, and what a retailer may see prices for. A retailer with no rows here sees everything (as before).
CREATE TABLE distributor_categories (
  distributor_id BIGINT UNSIGNED NOT NULL,
  category_id BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (distributor_id, category_id),
  KEY ix_dc_category (category_id),
  CONSTRAINT fk_dc_dist FOREIGN KEY (distributor_id) REFERENCES users(id),
  CONSTRAINT fk_dc_cat FOREIGN KEY (category_id) REFERENCES categories(id)
) ENGINE=InnoDB;

CREATE TABLE retailer_categories (
  retailer_id BIGINT UNSIGNED NOT NULL,
  category_id BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (retailer_id, category_id),
  KEY ix_rc_category (category_id),
  CONSTRAINT fk_rc_ret FOREIGN KEY (retailer_id) REFERENCES users(id),
  CONSTRAINT fk_rc_cat FOREIGN KEY (category_id) REFERENCES categories(id)
) ENGINE=InnoDB;

ALTER TABLE distributor_profiles
  ADD COLUMN review_required TINYINT(1) NOT NULL DEFAULT 0 COMMENT 'new products of this distributor wait for approval',
  ADD COLUMN social_links TEXT NULL COMMENT 'JSON: whatsapp, facebook, instagram, youtube, maps (https links)';

-- Cash on delivery: the retailer pays the delivery person when the goods arrive instead of owing on the khata account.
ALTER TABLE orders ADD COLUMN payment_method ENUM('credit','cod') NOT NULL DEFAULT 'credit';

-- Offers can go to chosen retailers, or to the retailers under one team member, not only to everyone or to pincodes.
ALTER TABLE announcements
  MODIFY audience ENUM('all','pincodes','retailers','employee') NOT NULL DEFAULT 'all',
  ADD COLUMN retailer_ids TEXT NULL,
  ADD COLUMN employee_id BIGINT UNSIGNED NULL;
