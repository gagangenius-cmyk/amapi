-- GST e-invoice / e-way bill support: supplier address, and the numbers the government portal returns.
ALTER TABLE distributor_profiles
  ADD COLUMN address VARCHAR(255) NULL,
  ADD COLUMN city VARCHAR(100) NULL,
  ADD COLUMN pincode CHAR(6) NULL;

ALTER TABLE orders
  ADD COLUMN irn CHAR(64) NULL,
  ADD COLUMN irn_ack_no VARCHAR(30) NULL,
  ADD COLUMN irn_ack_at DATETIME NULL,
  ADD COLUMN signed_qr TEXT NULL,
  ADD COLUMN eway_bill_no VARCHAR(20) NULL,
  ADD COLUMN eway_valid_until DATETIME NULL,
  ADD UNIQUE KEY uq_orders_irn (irn);
