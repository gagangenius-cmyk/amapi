-- Online (card / netbanking / UPI) payments through a hosted payment link, next to the existing manual-UTR flow.
ALTER TABLE payment_intents
  ADD COLUMN method ENUM('upi','gateway') NOT NULL DEFAULT 'upi',
  ADD COLUMN gateway_ref VARCHAR(80) NULL,
  ADD COLUMN gateway_payment_id VARCHAR(80) NULL,
  ADD COLUMN checkout_url VARCHAR(300) NULL,
  MODIFY status ENUM('pending','confirmed','rejected','failed') NOT NULL DEFAULT 'pending',
  ADD UNIQUE KEY uq_pi_gateway_ref (gateway_ref);
