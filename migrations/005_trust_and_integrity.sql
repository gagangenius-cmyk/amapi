-- 1) Retailer consent: a distributor can only REQUEST a link; it becomes active when the retailer accepts.
ALTER TABLE retailer_distributor_relations
  ADD COLUMN status ENUM('active','pending') NOT NULL DEFAULT 'active' AFTER is_primary,
  ADD COLUMN requested_by ENUM('retailer','distributor') NOT NULL DEFAULT 'retailer' AFTER status,
  ADD KEY ix_rdr_status (distributor_id, status);

-- 2) Disputes: a retailer can contest any ledger entry; the distributor must reverse it or answer.
CREATE TABLE ledger_disputes (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  ledger_id BIGINT UNSIGNED NOT NULL,
  distributor_id BIGINT UNSIGNED NOT NULL,
  retailer_id BIGINT UNSIGNED NOT NULL,
  reason VARCHAR(500) NOT NULL,
  status ENUM('open','resolved','rejected') NOT NULL DEFAULT 'open',
  resolution_note VARCHAR(500) NULL,
  resolved_by BIGINT UNSIGNED NULL,
  resolved_at DATETIME NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_dispute_entry (ledger_id),
  KEY ix_disp_dist (distributor_id, status),
  KEY ix_disp_ret (retailer_id, status),
  CONSTRAINT fk_disp_ledger FOREIGN KEY (ledger_id) REFERENCES ledger_transactions(id)
) ENGINE=InnoDB;

-- 3) Accounts: email verification and per-account login lockout; optional retailer GSTIN for invoices.
ALTER TABLE users
  ADD COLUMN email_verified_at DATETIME NULL AFTER email,
  ADD COLUMN failed_logins INT NOT NULL DEFAULT 0,
  ADD COLUMN locked_until DATETIME NULL;
ALTER TABLE retailer_profiles ADD COLUMN gst_no VARCHAR(20) NULL;
ALTER TABLE otps MODIFY purpose ENUM('login','reset','verify') NOT NULL;

-- 4) Orders: replay protection that notices a different request, and GST-compliant sequential invoice numbers.
ALTER TABLE orders
  ADD COLUMN request_hash CHAR(64) NULL,
  ADD COLUMN invoice_no VARCHAR(40) NULL,
  ADD UNIQUE KEY uq_order_invoice (distributor_id, invoice_no);

CREATE TABLE invoice_counters (
  distributor_id BIGINT UNSIGNED NOT NULL,
  fy CHAR(7) NOT NULL,
  last_no INT NOT NULL DEFAULT 0,
  PRIMARY KEY (distributor_id, fy)
) ENGINE=InnoDB;

-- 5) Performance: cancelling/looking up an order's invoice must not scan the whole ledger.
ALTER TABLE ledger_transactions ADD KEY ix_ledger_order (order_id, type);
