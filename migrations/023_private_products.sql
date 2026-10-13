-- A product can be kept for chosen retailers only. With no rows here a product is open to everyone the distributor sells to (as before);
-- with rows, only those retailers can see it, see its price, download it, or order it.
CREATE TABLE product_audience (
  product_id BIGINT UNSIGNED NOT NULL,
  retailer_id BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (product_id, retailer_id),
  KEY ix_pa_retailer (retailer_id),
  CONSTRAINT fk_pa_product FOREIGN KEY (product_id) REFERENCES products(id),
  CONSTRAINT fk_pa_retailer FOREIGN KEY (retailer_id) REFERENCES users(id)
) ENGINE=InnoDB;
