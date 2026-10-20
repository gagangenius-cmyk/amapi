-- Field sales: shop locations, beat plans (which employee visits which shops on which weekday) and visit punches.

-- A retailer sets the shop's location once, from the shop. Changing it afterwards needs the distributor to reset it.
ALTER TABLE retailer_profiles
  ADD COLUMN lat DECIMAL(9,6) NULL,
  ADD COLUMN lng DECIMAL(9,6) NULL,
  ADD COLUMN location_set_at DATETIME NULL;

-- A beat plan: one employee, one weekday (0 = Sunday ... 6 = Saturday), an ordered list of shops.
CREATE TABLE beat_plans (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  distributor_id BIGINT UNSIGNED NOT NULL,
  employee_id BIGINT UNSIGNED NOT NULL,
  name VARCHAR(80) NOT NULL,
  weekday TINYINT UNSIGNED NOT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_by BIGINT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY ix_beat_dist (distributor_id, is_active),
  KEY ix_beat_emp (employee_id, weekday),
  CONSTRAINT fk_beat_d FOREIGN KEY (distributor_id) REFERENCES users(id),
  CONSTRAINT fk_beat_e FOREIGN KEY (employee_id) REFERENCES users(id)
) ENGINE=InnoDB;

CREATE TABLE beat_plan_retailers (
  beat_id BIGINT UNSIGNED NOT NULL,
  retailer_id BIGINT UNSIGNED NOT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  PRIMARY KEY (beat_id, retailer_id),
  KEY ix_bpr_retailer (retailer_id),
  CONSTRAINT fk_bpr_b FOREIGN KEY (beat_id) REFERENCES beat_plans(id) ON DELETE CASCADE,
  CONSTRAINT fk_bpr_r FOREIGN KEY (retailer_id) REFERENCES users(id)
) ENGINE=InnoDB;

-- A visit is punched when the employee scans the QR shown in the retailer's own app.
CREATE TABLE visits (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  distributor_id BIGINT UNSIGNED NOT NULL,
  employee_id BIGINT UNSIGNED NOT NULL,
  retailer_id BIGINT UNSIGNED NOT NULL,
  beat_id BIGINT UNSIGNED NULL,
  visited_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  lat DECIMAL(9,6) NULL,
  lng DECIMAL(9,6) NULL,
  distance_m INT NULL COMMENT 'how far the employee was from the shop location when punching, if both are known',
  KEY ix_visit_dist (distributor_id, visited_at),
  KEY ix_visit_emp (employee_id, visited_at),
  KEY ix_visit_ret (retailer_id, visited_at),
  CONSTRAINT fk_visit_d FOREIGN KEY (distributor_id) REFERENCES users(id),
  CONSTRAINT fk_visit_e FOREIGN KEY (employee_id) REFERENCES users(id),
  CONSTRAINT fk_visit_r FOREIGN KEY (retailer_id) REFERENCES users(id)
) ENGINE=InnoDB;
