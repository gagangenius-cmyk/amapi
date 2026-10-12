-- OTP codes are now delivered by email. Users get a unique (optional for old rows) email,
-- and OTPs are keyed by an identifier that can be an email or a phone number.
ALTER TABLE users ADD UNIQUE KEY uq_users_email (email);
ALTER TABLE otps CHANGE phone identifier VARCHAR(190) NOT NULL;
