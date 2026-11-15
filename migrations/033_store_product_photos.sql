-- Photos of a retailer's own store products (up to 5 each; the first by position is the cover).
CREATE TABLE store_product_images (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  product_id BIGINT UNSIGNED NOT NULL,
  retailer_id BIGINT UNSIGNED NOT NULL,
  file_key VARCHAR(64) NOT NULL,
  mime VARCHAR(40) NOT NULL,
  bytes INT NOT NULL,
  position INT NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_spi_key (file_key),
  KEY ix_spi_product (product_id, position),
  CONSTRAINT fk_spi_p FOREIGN KEY (product_id) REFERENCES store_products(id),
  CONSTRAINT fk_spi_r FOREIGN KEY (retailer_id) REFERENCES users(id)
) ENGINE=InnoDB;
