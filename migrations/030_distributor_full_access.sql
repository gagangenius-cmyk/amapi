-- Every distributor has full access: all feature switches on (own delivery, khata, chat, offers, pincode selling, online payments, team members, cash on delivery).
-- The admin can still switch one off for a particular distributor afterwards.
UPDATE distributor_profiles SET permissions = '{"self_delivery":true,"khatabook_enabled":true,"chat_enabled":true,"notifications_enabled":true,"pincode_selling":true,"online_payments":true,"employees_enabled":true,"cod_enabled":true}';
