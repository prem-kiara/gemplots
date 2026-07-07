-- V4__config.sql — app DB role, audit immutability, seed global settings (DM §5.11, §5.13)

-- Application role: the API connects as this NON-OWNER role so the audit REVOKE has teeth.
-- (A table owner keeps privileges regardless of REVOKE; only a non-owner is truly blocked.)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dhanam_app') THEN
    CREATE ROLE dhanam_app LOGIN PASSWORD 'dhanam_app_dev';
  END IF;
END$$;

GRANT USAGE ON SCHEMA public TO dhanam_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO dhanam_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO dhanam_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO dhanam_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO dhanam_app;

-- INVARIANT 10 — audit_logs is append-only for everyone incl. the app role.
REVOKE UPDATE, DELETE ON audit_logs FROM PUBLIC;
REVOKE UPDATE, DELETE ON audit_logs FROM dhanam_app;

-- Global settings defaults (DM §5.13). Idempotent.
INSERT INTO global_settings(key, value) VALUES
  ('global_hold_minutes',        '1440'),
  ('max_active_holds_per_user',  '2'),
  ('otp_send_limit_per_15min',   '3'),
  ('otp_send_limit_per_day',     '10'),
  ('otp_verify_max_attempts',    '5'),
  ('min_advance_paise',          '1000000'),
  ('reminder_offsets_minutes',   '[360, 60]')
ON CONFLICT (key) DO NOTHING;
