-- The retailer's own online store for end customers (B2C), the customers themselves, and the shop-counter billing (POS) with its day book.
-- A retailer's store is live while they hold an active AAYME subscription (see 031).

ALTER TABLE users MODIFY COLUMN role ENUM('admin','distributor','employee','retailer','company_employee','customer') NOT NULL;

-- An end customer: signs up with details and location; may have one store pinned to the top of their home page.
CREATE TABLE customer_profiles (
  user_id BIGINT UNSIGNED PRIMARY KEY,
  address VARCHAR(255) NULL,
  pincode CHAR(6) NULL,
  lat DECIMAL(9,6) NULL,
  lng DECIMAL(9,6) NULL,
  pinned_retailer_id BIGINT UNSIGNED NULL,
  joined_via VARCHAR(40) NULL COMMENT 'e.g. qr:CODE when they came from a store QR code',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_cp_u FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB;

-- A retailer's store profile and settings (one per retailer, created the first time it is opened).
CREATE TABLE retailer_stores (
  retailer_id BIGINT UNSIGNED PRIMARY KEY,
  code VARCHAR(12) NOT NULL COMMENT 'the short code inside the store QR',
  name VARCHAR(120) NOT NULL,
  description VARCHAR(500) NULL,
  phone VARCHAR(15) NULL,
  whatsapp_url VARCHAR(255) NULL,
  facebook_url VARCHAR(255) NULL,
  instagram_url VARCHAR(255) NULL,
  youtube_url VARCHAR(255) NULL,
  address VARCHAR(255) NULL,
  pincode CHAR(6) NULL,
  lat DECIMAL(9,6) NULL,
  lng DECIMAL(9,6) NULL,
  opens_at TIME NULL,
  closes_at TIME NULL,
  open_override TINYINT NULL COMMENT '1 = open now, 0 = closed now, NULL = follow the opening hours',
  delivery_enabled TINYINT(1) NOT NULL DEFAULT 1,
  delivery_fee_paise INT NOT NULL DEFAULT 0,
  free_delivery_above_paise INT NULL,
  min_order_paise INT NOT NULL DEFAULT 0,
  delivery_minutes_min INT NULL,
  delivery_minutes_max INT NULL,
  upi_id VARCHAR(64) NULL COMMENT 'where customers pay (shown as a QR on the bill)',
  upi_payee VARCHAR(80) NULL,
  accepts_cod TINYINT(1) NOT NULL DEFAULT 1,
  accepts_upi TINYINT(1) NOT NULL DEFAULT 1,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  bill_seq INT NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_store_code (code),
  KEY ix_store_pin (pincode),
  CONSTRAINT fk_rst_r FOREIGN KEY (retailer_id) REFERENCES users(id)
) ENGINE=InnoDB;

-- The retailer's customers (online customers, walk-ins billed at the counter, or added by hand). One row per phone number.
CREATE TABLE store_customers (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  retailer_id BIGINT UNSIGNED NOT NULL,
  customer_id BIGINT UNSIGNED NULL COMMENT 'set once the person has an AAYME customer account',
  name VARCHAR(120) NOT NULL,
  phone VARCHAR(15) NOT NULL,
  source ENUM('qr','online','counter','manual') NOT NULL DEFAULT 'manual',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_sc (retailer_id, phone),
  KEY ix_sc_cust (customer_id),
  CONSTRAINT fk_sc_r FOREIGN KEY (retailer_id) REFERENCES users(id)
) ENGINE=InnoDB;

-- What the retailer sells to customers: their own products, or ones copied from a distributor's catalogue (source_product_id).
CREATE TABLE store_products (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  retailer_id BIGINT UNSIGNED NOT NULL,
  name VARCHAR(190) NOT NULL,
  description VARCHAR(1000) NULL,
  brand VARCHAR(80) NULL,
  category VARCHAR(80) NULL,
  unit VARCHAR(20) NOT NULL DEFAULT 'pcs',
  barcode VARCHAR(40) NULL,
  sku VARCHAR(60) NULL,
  price_paise BIGINT NOT NULL COMMENT 'what the customer pays (all taxes included)',
  mrp_paise BIGINT NULL,
  cost_paise BIGINT NULL COMMENT 'what it costs the retailer, for the earnings figure',
  gst_rate_bps INT NOT NULL DEFAULT 0,
  stock_qty INT NOT NULL DEFAULT 0,
  image_url VARCHAR(255) NULL,
  source_distributor_id BIGINT UNSIGNED NULL,
  source_product_id BIGINT UNSIGNED NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  deleted_at DATETIME NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY ix_sp_ret (retailer_id, is_active),
  KEY ix_sp_barcode (retailer_id, barcode),
  CONSTRAINT fk_sp_r FOREIGN KEY (retailer_id) REFERENCES users(id)
) ENGINE=InnoDB;

-- Online orders from customers and bills made at the counter. Money is in paise; every line keeps its own copy of name, price and cost.
CREATE TABLE store_orders (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  retailer_id BIGINT UNSIGNED NOT NULL,
  customer_id BIGINT UNSIGNED NULL,
  customer_name VARCHAR(120) NULL,
  customer_phone VARCHAR(15) NULL,
  channel ENUM('online','counter') NOT NULL,
  bill_no VARCHAR(30) NULL,
  bill_seq INT NULL,
  status ENUM('placed','accepted','out_for_delivery','delivered','cancelled','rejected') NOT NULL DEFAULT 'placed',
  payment_method ENUM('cash','card','upi','cod') NOT NULL,
  payment_status ENUM('pending','paid') NOT NULL DEFAULT 'pending',
  subtotal_paise BIGINT NOT NULL,
  delivery_fee_paise BIGINT NOT NULL DEFAULT 0,
  discount_paise BIGINT NOT NULL DEFAULT 0,
  total_paise BIGINT NOT NULL,
  delivery_address VARCHAR(255) NULL,
  lat DECIMAL(9,6) NULL,
  lng DECIMAL(9,6) NULL,
  note VARCHAR(300) NULL,
  upi_ref VARCHAR(60) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY ix_so_ret (retailer_id, created_at),
  KEY ix_so_cust (customer_id, created_at),
  UNIQUE KEY uq_so_bill (retailer_id, bill_seq),
  CONSTRAINT fk_so_r FOREIGN KEY (retailer_id) REFERENCES users(id)
) ENGINE=InnoDB;

CREATE TABLE store_order_items (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  order_id BIGINT UNSIGNED NOT NULL,
  product_id BIGINT UNSIGNED NULL,
  name VARCHAR(190) NOT NULL,
  unit VARCHAR(20) NOT NULL DEFAULT 'pcs',
  qty INT NOT NULL,
  unit_price_paise BIGINT NOT NULL,
  cost_paise BIGINT NULL,
  line_total_paise BIGINT NOT NULL,
  KEY ix_soi_order (order_id),
  CONSTRAINT fk_soi_o FOREIGN KEY (order_id) REFERENCES store_orders(id)
) ENGINE=InnoDB;

-- Offers the retailer runs; customers see them as banners on the store and on their home page.
CREATE TABLE store_offers (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  retailer_id BIGINT UNSIGNED NOT NULL,
  title VARCHAR(120) NOT NULL,
  description VARCHAR(300) NULL,
  starts_on DATE NULL,
  ends_on DATE NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_offer_ret (retailer_id, is_active),
  CONSTRAINT fk_off_r FOREIGN KEY (retailer_id) REFERENCES users(id)
) ENGINE=InnoDB;
