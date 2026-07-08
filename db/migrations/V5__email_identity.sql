-- V5__email_identity.sql — email is the customer identity now (08 §4, §9).
-- V1–V4 are immutable; this is the first additive migration after the P0 commit.

-- users: email becomes the identity for ALL roles; phone is now an optional profile field.
UPDATE users
   SET email = replace(coalesce(phone, ''), '+', '') || '@placeholder.gemhousing.in'
 WHERE email IS NULL;
ALTER TABLE users ALTER COLUMN email SET NOT NULL;
-- phone is no longer required for customers (08 §4). Keep admin_has_password.
ALTER TABLE users DROP CONSTRAINT customer_has_phone;

-- otp_challenges: phone → email; add purpose + booking linkage (08 §4).
ALTER TABLE otp_challenges ADD COLUMN email text;
UPDATE otp_challenges SET email = phone WHERE email IS NULL;
ALTER TABLE otp_challenges ALTER COLUMN email SET NOT NULL;
ALTER TABLE otp_challenges DROP COLUMN phone;
ALTER TABLE otp_challenges ADD COLUMN purpose otp_purpose NOT NULL DEFAULT 'LOGIN';
ALTER TABLE otp_challenges ADD COLUMN booking_id uuid REFERENCES bookings(id);

-- index swap: rate limits + lookups now keyed on email.
-- (DROP COLUMN phone above already cascades away idx_otp_phone_time — IF EXISTS is the safe read.)
DROP INDEX IF EXISTS idx_otp_phone_time;
CREATE INDEX idx_otp_email_time ON otp_challenges(email, created_at DESC);
