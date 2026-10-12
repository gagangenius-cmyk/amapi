-- Named roles for company employees: a role bundles the powers (actions) and the distributor feature switches
-- (grantable) its members may hand out. Editing a role changes everyone who holds it, at once.
CREATE TABLE roles (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(60) NOT NULL,
  description VARCHAR(200) NULL,
  actions TEXT NOT NULL,
  grantable TEXT NOT NULL,
  is_system TINYINT(1) NOT NULL DEFAULT 0,
  created_by BIGINT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_roles_name (name)
) ENGINE=InnoDB;

ALTER TABLE users
  ADD COLUMN role_id BIGINT UNSIGNED NULL COMMENT 'company employees: the named role that supplies their permissions',
  ADD KEY ix_users_role (role_id),
  ADD CONSTRAINT fk_users_role FOREIGN KEY (role_id) REFERENCES roles(id);

INSERT INTO roles (name, description, actions, grantable, is_system) VALUES
  ('Onboarding Manager', 'Opens and looks after distributor accounts',
   '["create_distributors","manage_distributors"]',
   '["self_delivery","khatabook_enabled","chat_enabled","notifications_enabled","pincode_selling","online_payments","employees_enabled"]', 1),
  ('Distributor Viewer', 'Read-only: sees every distributor and the commission report',
   '["view_all_distributors","view_commissions"]', '[]', 1);
