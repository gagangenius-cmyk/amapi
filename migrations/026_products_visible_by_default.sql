-- Products a distributor adds are visible to retailers straight away. Holding them for company approval is now opt-in per distributor.
UPDATE distributor_profiles SET review_required = 0 WHERE review_required = 1;
UPDATE products SET review_status = 'approved', review_note = NULL WHERE review_status = 'pending' AND deleted_at IS NULL;
