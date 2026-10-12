-- Push notifications become a queue: every message is stored, retried with backoff, and checked for delivery.
CREATE TABLE push_outbox (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT UNSIGNED NOT NULL,
  token VARCHAR(200) NOT NULL,
  title VARCHAR(120) NOT NULL,
  body VARCHAR(300) NOT NULL,
  data TEXT NULL,
  status ENUM('pending','sent','delivered','failed','dead') NOT NULL DEFAULT 'pending',
  attempts INT NOT NULL DEFAULT 0,
  next_attempt_at DATETIME NOT NULL,
  ticket_id VARCHAR(80) NULL,
  error VARCHAR(200) NULL,
  sent_at DATETIME NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY ix_po_due (status, next_attempt_at),
  KEY ix_po_sent (status, sent_at),
  KEY ix_po_user (user_id, id)
) ENGINE=InnoDB;
