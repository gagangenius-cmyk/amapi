-- A line of news the retailer wants their customers to see scrolling on the home page (offers, holidays, new stock). Shown only while it is set and not expired.
ALTER TABLE retailer_stores ADD COLUMN notice_text VARCHAR(300) NULL, ADD COLUMN notice_expires_at DATETIME NULL;
