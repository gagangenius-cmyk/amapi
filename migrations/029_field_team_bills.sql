-- Sales vs delivery staff, delivery date on orders, GST / plain bill choice, collection receipts and field logs (branding photos, product pickups).

-- Which job a team member does. Existing employees stay "sales"; the distributor can change it.
ALTER TABLE users
  ADD COLUMN employee_kind ENUM('sales','delivery') NOT NULL DEFAULT 'sales' COMMENT 'for employees: sales person or delivery person';

-- When the assigned person should deliver, and which kind of bill the retailer asked for.
ALTER TABLE orders
  ADD COLUMN deliver_on DATE NULL,
  ADD COLUMN bill_type ENUM('gst','plain') NOT NULL DEFAULT 'gst' COMMENT 'plain = shopkeeper without GST: no GST bill';

-- Collection details the person writes down at the shop: their receipt number and the UPI reference when the retailer paid by UPI.
ALTER TABLE ledger_transactions
  ADD COLUMN receipt_no VARCHAR(40) NULL,
  ADD COLUMN upi_ref VARCHAR(60) NULL;

-- Things the field team record with a photo: branding put up at a shop (poster, flex, board), and expired / returned goods taken back.
CREATE TABLE field_logs (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  distributor_id BIGINT UNSIGNED NOT NULL,
  employee_id BIGINT UNSIGNED NOT NULL,
  retailer_id BIGINT UNSIGNED NOT NULL,
  kind ENUM('branding','expiry_pickup','return_pickup') NOT NULL,
  title VARCHAR(120) NULL,
  note VARCHAR(500) NULL,
  product_name VARCHAR(190) NULL,
  qty INT NULL,
  photo_key VARCHAR(160) NULL,
  photo_mime VARCHAR(40) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_fl_dist (distributor_id, created_at),
  KEY ix_fl_ret (retailer_id, created_at),
  KEY ix_fl_emp (employee_id, created_at),
  CONSTRAINT fk_fl_d FOREIGN KEY (distributor_id) REFERENCES users(id),
  CONSTRAINT fk_fl_e FOREIGN KEY (employee_id) REFERENCES users(id),
  CONSTRAINT fk_fl_r FOREIGN KEY (retailer_id) REFERENCES users(id)
) ENGINE=InnoDB;

-- A reminder sent the day before the salesperson's collection visit.
ALTER TABLE collection_reminders MODIFY source ENUM('manual','auto','beat') NOT NULL;
