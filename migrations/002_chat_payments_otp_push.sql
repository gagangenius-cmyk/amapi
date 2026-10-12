CREATE TABLE chat_messages (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  distributor_id BIGINT UNSIGNED NOT NULL,
  retailer_id BIGINT UNSIGNED NOT NULL,
  sender_id BIGINT UNSIGNED NOT NULL,
  body VARCHAR(2000) NOT NULL,
  client_id VARCHAR(60) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_chat_pair (distributor_id, retailer_id, id),
  UNIQUE KEY uq_chat_client (sender_id, client_id),
  CONSTRAINT fk_cm_d FOREIGN KEY (distributor_id) REFERENCES users(id),
  CONSTRAINT fk_cm_r FOREIGN KEY (retailer_id) REFERENCES users(id),
  CONSTRAINT fk_cm_s FOREIGN KEY (sender_id) REFERENCES users(id)
) ENGINE=InnoDB;

CREATE TABLE chat_reads (
  user_id BIGINT UNSIGNED NOT NULL,
  distributor_id BIGINT UNSIGNED NOT NULL,
  retailer_id BIGINT UNSIGNED NOT NULL,
  last_read_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, distributor_id, retailer_id)
) ENGINE=InnoDB;

-- Retailer reports a UPI payment (with UTR); the distributor confirms it, which posts the ledger entry.
CREATE TABLE payment_intents (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  distributor_id BIGINT UNSIGNED NOT NULL,
  retailer_id BIGINT UNSIGNED NOT NULL,
  amount_paise BIGINT NOT NULL,
  utr VARCHAR(30) NOT NULL,
  status ENUM('pending','confirmed','rejected') NOT NULL DEFAULT 'pending',
  idempotency_key VARCHAR(80) NOT NULL,
  decided_by BIGINT UNSIGNED NULL,
  decided_at DATETIME NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_pi_idem (retailer_id, idempotency_key),
  UNIQUE KEY uq_pi_utr (distributor_id, utr),
  KEY ix_pi_dist (distributor_id, status),
  CONSTRAINT fk_pi_d FOREIGN KEY (distributor_id) REFERENCES users(id),
  CONSTRAINT fk_pi_r FOREIGN KEY (retailer_id) REFERENCES users(id)
) ENGINE=InnoDB;

CREATE TABLE otps (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  phone VARCHAR(15) NOT NULL,
  purpose ENUM('login','reset') NOT NULL,
  code_hash CHAR(64) NOT NULL,
  attempts INT NOT NULL DEFAULT 0,
  expires_at DATETIME NOT NULL,
  consumed_at DATETIME NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_otp_phone (phone, created_at)
) ENGINE=InnoDB;

CREATE TABLE push_tokens (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT UNSIGNED NOT NULL,
  token VARCHAR(200) NOT NULL,
  platform VARCHAR(10) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_push_token (token),
  KEY ix_push_user (user_id),
  CONSTRAINT fk_pt_u FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;
