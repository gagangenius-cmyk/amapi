-- Partial fulfilment, product images, admin two-factor, device sessions.
ALTER TABLE order_items ADD COLUMN ordered_qty INT NULL;           -- what the retailer asked for, when the distributor shipped less
ALTER TABLE orders ADD COLUMN is_adjusted TINYINT(1) NOT NULL DEFAULT 0;

CREATE TABLE product_images (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  product_id BIGINT UNSIGNED NOT NULL,
  distributor_id BIGINT UNSIGNED NOT NULL,
  file_key CHAR(40) NOT NULL,
  mime VARCHAR(20) NOT NULL,
  bytes INT NOT NULL,
  position INT NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_img_key (file_key),
  KEY ix_img_product (product_id, position),
  CONSTRAINT fk_img_prod FOREIGN KEY (product_id) REFERENCES products(id)
) ENGINE=InnoDB;

ALTER TABLE users ADD COLUMN totp_secret VARCHAR(200) NULL, ADD COLUMN totp_enabled_at TIMESTAMP NULL, ADD COLUMN totp_last_step BIGINT NULL;

ALTER TABLE refresh_tokens
  ADD COLUMN session_id CHAR(32) NULL, ADD COLUMN user_agent VARCHAR(200) NULL, ADD COLUMN ip VARCHAR(45) NULL,
  ADD KEY ix_rt_session (user_id, session_id);
UPDATE refresh_tokens SET session_id = LEFT(token_hash, 32) WHERE session_id IS NULL;
