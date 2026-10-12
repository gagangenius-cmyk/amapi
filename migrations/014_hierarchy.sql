-- Account hierarchy:
--   admin -> company employee (admin picks what they may do)
--   company employee -> distributor (can only hand out the feature switches the admin gave them)
--   distributor -> distributor employee / retailer (retailer may sit under one of the distributor's employees)
--   distributor employee -> retailer
ALTER TABLE users
  MODIFY COLUMN role ENUM('admin','distributor','employee','retailer','company_employee') NOT NULL,
  ADD COLUMN created_by BIGINT UNSIGNED NULL COMMENT 'the account that created this one (NULL = self sign-up)',
  ADD COLUMN managed_by_id BIGINT UNSIGNED NULL COMMENT 'for retailers: the distributor employee whose tree they sit under',
  ADD COLUMN staff_permissions TEXT NULL COMMENT 'company employees: JSON {actions:[...], grantable:[...]}',
  ADD KEY ix_users_created_by (created_by),
  ADD KEY ix_users_managed_by (managed_by_id);
