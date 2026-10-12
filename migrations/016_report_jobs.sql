-- Report exports run in the background: a request becomes a row, a worker builds the file, the requester downloads it later.
CREATE TABLE report_jobs (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  requested_by BIGINT UNSIGNED NOT NULL,
  type VARCHAR(40) NOT NULL,
  format ENUM('csv','xlsx') NOT NULL,
  params TEXT NOT NULL,
  status ENUM('queued','running','done','failed') NOT NULL DEFAULT 'queued',
  file_key VARCHAR(80) NULL,
  file_name VARCHAR(120) NULL,
  row_count INT NULL,
  truncated TINYINT(1) NOT NULL DEFAULT 0,
  error VARCHAR(300) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  started_at DATETIME NULL,
  finished_at DATETIME NULL,
  KEY ix_rj_user (requested_by, id),
  KEY ix_rj_status (status, id),
  CONSTRAINT fk_rj_user FOREIGN KEY (requested_by) REFERENCES users(id)
) ENGINE=InnoDB;
