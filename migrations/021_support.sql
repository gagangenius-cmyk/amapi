-- Support desk: tickets raised by retailers and distributors, handled by platform staff.
CREATE TABLE support_categories (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(60) NOT NULL,
  default_priority ENUM('low','normal','high','urgent') NOT NULL DEFAULT 'normal',
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  sort_order INT NOT NULL DEFAULT 0,
  UNIQUE KEY uq_sc_name (name)
) ENGINE=InnoDB;

INSERT INTO support_categories (name, default_priority, sort_order) VALUES
  ('Order problem', 'high', 1), ('Payment or khata', 'high', 2), ('Account and login', 'normal', 3),
  ('Product or catalogue', 'normal', 4), ('Subscription or billing', 'normal', 5), ('App problem', 'normal', 6), ('Other', 'low', 7);

-- Service levels, in minutes, per priority. The clock runs around the clock (no business hours).
CREATE TABLE support_sla (
  priority ENUM('low','normal','high','urgent') NOT NULL PRIMARY KEY,
  first_response_minutes INT NOT NULL,
  resolution_minutes INT NOT NULL
) ENGINE=InnoDB;
INSERT INTO support_sla VALUES ('urgent', 60, 480), ('high', 240, 1440), ('normal', 480, 2880), ('low', 1440, 7200);

CREATE TABLE support_tickets (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  requester_id BIGINT UNSIGNED NOT NULL,
  requester_role ENUM('retailer','distributor') NOT NULL,
  subject VARCHAR(150) NOT NULL,
  category_id BIGINT UNSIGNED NOT NULL,
  priority ENUM('low','normal','high','urgent') NOT NULL DEFAULT 'normal',
  status ENUM('open','in_progress','waiting_customer','resolved','closed') NOT NULL DEFAULT 'open',
  order_id BIGINT UNSIGNED NULL,
  assignee_id BIGINT UNSIGNED NULL,
  first_response_due DATETIME NOT NULL,
  resolution_due DATETIME NOT NULL,
  first_response_at DATETIME NULL,
  resolved_at DATETIME NULL,
  closed_at DATETIME NULL,
  resolution_note VARCHAR(500) NULL,
  escalation_level TINYINT NOT NULL DEFAULT 0,
  escalated_at DATETIME NULL,
  rating TINYINT NULL,
  rating_comment VARCHAR(300) NULL,
  last_activity_at DATETIME NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_st_requester (requester_id, status),
  KEY ix_st_status (status, priority, last_activity_at),
  KEY ix_st_assignee (assignee_id, status),
  KEY ix_st_order (order_id),
  CONSTRAINT fk_st_requester FOREIGN KEY (requester_id) REFERENCES users(id),
  CONSTRAINT fk_st_category FOREIGN KEY (category_id) REFERENCES support_categories(id),
  CONSTRAINT fk_st_order FOREIGN KEY (order_id) REFERENCES orders(id)
) ENGINE=InnoDB;

-- kind: reply (the customer can read it), internal (staff only), system (status changes; the customer can read it)
CREATE TABLE support_messages (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  ticket_id BIGINT UNSIGNED NOT NULL,
  author_id BIGINT UNSIGNED NULL,
  author_side ENUM('customer','staff','system') NOT NULL,
  kind ENUM('reply','internal','system') NOT NULL,
  body VARCHAR(4000) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_sm_ticket (ticket_id, id),
  CONSTRAINT fk_smsg_ticket FOREIGN KEY (ticket_id) REFERENCES support_tickets(id)
) ENGINE=InnoDB;

CREATE TABLE support_attachments (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  ticket_id BIGINT UNSIGNED NOT NULL,
  uploaded_by BIGINT UNSIGNED NOT NULL,
  file_key VARCHAR(80) NOT NULL,
  file_name VARCHAR(120) NOT NULL,
  mime VARCHAR(40) NOT NULL,
  size_bytes INT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_sa_key (file_key),
  KEY ix_sa_ticket (ticket_id),
  CONSTRAINT fk_sa_ticket FOREIGN KEY (ticket_id) REFERENCES support_tickets(id)
) ENGINE=InnoDB;
