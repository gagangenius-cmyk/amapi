-- A retailer's own banner picture for an offer, shown to customers full width on their home page and on the store.
ALTER TABLE store_offers ADD COLUMN image_key CHAR(40) NULL, ADD COLUMN image_mime VARCHAR(40) NULL, ADD KEY ix_offer_image (image_key);
