-- Birthdays, anniversaries and other dates of a store customer and their family, so the retailer can wish them (and send an offer) in advance.
CREATE TABLE store_customer_occasions (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  retailer_id BIGINT UNSIGNED NOT NULL,
  store_customer_id BIGINT UNSIGNED NOT NULL,
  person_name VARCHAR(120) NOT NULL,
  relation VARCHAR(40) NULL COMMENT 'self, wife, son, mother ...',
  kind ENUM('birthday','anniversary','other') NOT NULL DEFAULT 'birthday',
  label VARCHAR(80) NULL COMMENT 'for kind other, e.g. shop opening',
  month TINYINT UNSIGNED NOT NULL,
  day TINYINT UNSIGNED NOT NULL,
  birth_year SMALLINT UNSIGNED NULL COMMENT 'the year it began, to say 5th anniversary',
  note VARCHAR(255) NULL,
  last_wished_year SMALLINT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_oc_ret (retailer_id, month, day),
  KEY ix_oc_cust (store_customer_id),
  CONSTRAINT fk_oc_r FOREIGN KEY (retailer_id) REFERENCES users(id),
  CONSTRAINT fk_oc_c FOREIGN KEY (store_customer_id) REFERENCES store_customers(id) ON DELETE CASCADE
) ENGINE=InnoDB;
