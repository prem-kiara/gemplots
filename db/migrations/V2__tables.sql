-- V2__tables.sql — tables, constraints, the critical partial unique indexes (DM §5)
CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid()

-- updated_at trigger helper
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

-- 5.1 users
CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone         text UNIQUE,
  email         text UNIQUE,
  full_name     text NOT NULL DEFAULT '',
  role          user_role NOT NULL DEFAULT 'CUSTOMER',
  status        user_status NOT NULL DEFAULT 'ACTIVE',
  password_hash text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT customer_has_phone CHECK (role <> 'CUSTOMER' OR phone IS NOT NULL),
  CONSTRAINT admin_has_password CHECK (role = 'CUSTOMER' OR password_hash IS NOT NULL)
);
CREATE TRIGGER trg_users_updated BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- 5.2 otp_challenges
CREATE TABLE otp_challenges (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone        text NOT NULL,
  otp_hash     text NOT NULL,
  expires_at   timestamptz NOT NULL,
  attempts     int NOT NULL DEFAULT 0,
  consumed_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- 5.3 refresh_tokens, device_tokens
CREATE TABLE refresh_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id),
  token_hash  text NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz,
  replaced_by uuid REFERENCES refresh_tokens(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE device_tokens (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id),
  fcm_token  text NOT NULL,
  platform   text NOT NULL CHECK (platform IN ('android','ios')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, fcm_token)
);

-- 5.4 sellers, projects
CREATE TABLE sellers (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  type       seller_type NOT NULL DEFAULT 'OWN_COMPANY',
  contact    jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_sellers_updated BEFORE UPDATE ON sellers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE projects (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id     uuid NOT NULL REFERENCES sellers(id),
  name          text NOT NULL,
  slug          text NOT NULL UNIQUE,
  description   text NOT NULL DEFAULT '',
  address_line  text NOT NULL DEFAULT '',
  district      text NOT NULL DEFAULT '',
  state         text NOT NULL DEFAULT 'Tamil Nadu',
  pincode       text NOT NULL DEFAULT '',
  lat           double precision,
  lng           double precision,
  amenities     jsonb NOT NULL DEFAULT '[]',
  status        project_status NOT NULL DEFAULT 'DRAFT',
  rera_registered boolean NOT NULL DEFAULT false,
  rera_number   text,
  max_advance_percentage numeric(5,2) NOT NULL DEFAULT 10.00
                CHECK (max_advance_percentage > 0),
  hold_minutes_override int CHECK (hold_minutes_override BETWEEN 30 AND 10080),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rera_needs_number CHECK (NOT rera_registered OR rera_number IS NOT NULL)
);
CREATE TRIGGER trg_projects_updated BEFORE UPDATE ON projects
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- 5.5 plots
CREATE TABLE plots (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      uuid NOT NULL REFERENCES projects(id),
  plot_number     text NOT NULL,
  facing          text,
  dimensions_text text NOT NULL DEFAULT '',
  area_sqft       numeric(10,2) NOT NULL CHECK (area_sqft > 0),
  price_paise     bigint NOT NULL CHECK (price_paise > 0),
  status          plot_status NOT NULL DEFAULT 'AVAILABLE',
  attributes      jsonb NOT NULL DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, plot_number)
);
CREATE TRIGGER trg_plots_updated BEFORE UPDATE ON plots
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- 5.6 site_maps, plot_geometries
CREATE TABLE site_maps (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id),
  version    int NOT NULL,
  image_key  text NOT NULL,
  width_px   int NOT NULL,
  height_px  int NOT NULL,
  is_active  boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, version)
);
CREATE UNIQUE INDEX uniq_active_map_per_project ON site_maps(project_id) WHERE is_active;

CREATE TABLE plot_geometries (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_map_id uuid NOT NULL REFERENCES site_maps(id),
  plot_id     uuid NOT NULL REFERENCES plots(id),
  polygon     jsonb NOT NULL,
  centroid    jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (site_map_id, plot_id)
);

-- 5.7 bookings — the heart
CREATE TABLE bookings (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plot_id              uuid NOT NULL REFERENCES plots(id),
  user_id              uuid NOT NULL REFERENCES users(id),
  status               booking_status NOT NULL DEFAULT 'BLOCKED',
  total_price_paise    bigint NOT NULL,
  advance_amount_paise bigint,
  hold_minutes         int NOT NULL,
  blocked_at           timestamptz NOT NULL DEFAULT now(),
  expires_at           timestamptz NOT NULL,
  reserve_confirmed_at timestamptz,             -- set when the customer email-OTP succeeds (08 §5)
  confirmed_at         timestamptz,
  closed_at            timestamptz,
  idempotency_key      text NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, idempotency_key)
);
CREATE TRIGGER trg_bookings_updated BEFORE UPDATE ON bookings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
-- INVARIANT 3 — the backstop against double-booking races. Active statuses hold the plot
-- exclusively; includes the reserve-flow states plus the dormant payment states (08 §4).
CREATE UNIQUE INDEX uniq_active_booking_per_plot ON bookings(plot_id)
  WHERE status IN ('PENDING_CONFIRMATION','PENDING_APPROVAL','RESERVED',
                   'BLOCKED','BOOKED','MANUAL_REVIEW');

-- 5.8 payments
CREATE TABLE payments (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id         uuid NOT NULL REFERENCES bookings(id),
  gateway            text NOT NULL DEFAULT 'RAZORPAY',
  gateway_order_id   text NOT NULL UNIQUE,
  gateway_payment_id text UNIQUE,
  amount_paise       bigint NOT NULL CHECK (amount_paise > 0),
  currency           text NOT NULL DEFAULT 'INR',
  status             payment_status NOT NULL DEFAULT 'CREATED',
  receipt_number     text UNIQUE,
  failure_reason     text,
  raw_webhook        jsonb,
  idempotency_key    text NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (booking_id, idempotency_key)
);
CREATE TRIGGER trg_payments_updated BEFORE UPDATE ON payments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- receipt number sequence (GEM-YYYY-NNNNNN formatted in app; dormant with payments)
CREATE SEQUENCE receipt_seq START 1;

-- 5.9 webhook_events
CREATE TABLE webhook_events (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  gateway            text NOT NULL,
  event_id           text NOT NULL,
  event_type         text NOT NULL,
  gateway_payment_id text,
  signature_valid    boolean NOT NULL,
  payload            jsonb NOT NULL,
  outcome            text NOT NULL,
  processed_at       timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (gateway, event_id)
);

-- 5.10 approvals
CREATE TABLE approvals (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  action        approval_action NOT NULL,
  entity_type   text NOT NULL,
  entity_id     text NOT NULL,
  payload       jsonb NOT NULL,
  snapshot      jsonb NOT NULL,
  reason        text NOT NULL,
  status        approval_status NOT NULL DEFAULT 'PENDING',
  requested_by  uuid NOT NULL REFERENCES users(id),
  decided_by    uuid REFERENCES users(id),
  decided_at    timestamptz,
  decision_note text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT maker_is_not_checker CHECK (decided_by IS NULL OR decided_by <> requested_by)
);
CREATE TRIGGER trg_approvals_updated BEFORE UPDATE ON approvals
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE UNIQUE INDEX uniq_pending_approval
  ON approvals(action, entity_type, entity_id) WHERE status = 'PENDING';

-- 5.11 audit_logs (append-only)
CREATE TABLE audit_logs (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_id    uuid,
  actor_role  text NOT NULL,
  action      text NOT NULL,
  entity_type text NOT NULL,
  entity_id   text NOT NULL,
  before      jsonb,
  after       jsonb,
  request_id  text,
  ip          inet,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- 5.12 notifications, reconciliation
CREATE TABLE notifications (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id),
  channel    notification_channel NOT NULL,
  template   text NOT NULL,
  payload    jsonb NOT NULL DEFAULT '{}',
  sent_at    timestamptz,
  error      text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- portal_notifications — admin feed + customer notices (08 §7). Consumed from slice P3.
CREATE TABLE portal_notifications (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  audience    text NOT NULL CHECK (audience IN ('ADMIN','CUSTOMER')),
  user_id     uuid REFERENCES users(id),           -- required when audience='CUSTOMER'
  type        text NOT NULL,
  title       text NOT NULL,
  body        text NOT NULL DEFAULT '',
  entity_type text,
  entity_id   text,
  read_at     timestamptz,   -- ADMIN feed: shared read state (any admin clears it) — Phase-1 simplification
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT customer_notif_has_user CHECK (audience <> 'CUSTOMER' OR user_id IS NOT NULL)
);
CREATE INDEX idx_portal_notif_feed
  ON portal_notifications(audience, created_at DESC) WHERE read_at IS NULL;

-- emails_outbox — every email passes through, regardless of driver (08 §6). Consumed from P1.
CREATE TABLE emails_outbox (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  to_email   text NOT NULL,
  template   text NOT NULL,
  subject    text NOT NULL,
  body_text  text NOT NULL,
  payload    jsonb NOT NULL DEFAULT '{}',
  status     text NOT NULL CHECK (status IN ('LOGGED','SENT','FAILED')),  -- LOGGED = console driver
  error      text,
  sent_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE reconciliation_runs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_date     date NOT NULL UNIQUE,
  source       text NOT NULL,
  matched      int NOT NULL DEFAULT 0,
  unmatched    int NOT NULL DEFAULT 0,
  completed_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE reconciliation_items (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id             uuid NOT NULL REFERENCES reconciliation_runs(id),
  gateway_payment_id text NOT NULL,
  amount_paise       bigint NOT NULL,
  matched_payment_id uuid REFERENCES payments(id),
  status             text NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now()
);

-- 5.13 global_settings
CREATE TABLE global_settings (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_by uuid REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);
