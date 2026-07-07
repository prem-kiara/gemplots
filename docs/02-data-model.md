# 02 — Data Model (PostgreSQL, authoritative)

This document IS the schema spec. Slice 1 turns it into `db/migrations/V1__enums.sql`,
`V2__tables.sql`, `V3__indexes.sql`, `V4__config.sql` and `db/seed.sql` **verbatim** — do not
redesign while transcribing. PostgreSQL 15+. All timestamps `timestamptz` (UTC). All money
`BIGINT` paise. All ids `uuid DEFAULT gen_random_uuid()` unless noted.

## 1. Conventions

- Every table: `created_at timestamptz NOT NULL DEFAULT now()`, and `updated_at` (same default,
  maintained by trigger `set_updated_at()`) on mutable tables. Not repeated below.
- Soft deletes are NOT used; rows transition status instead.
- Foreign keys are `ON DELETE RESTRICT` (nothing business-critical cascades).

## 2. Enums (V1__enums.sql)

```sql
CREATE TYPE user_role AS ENUM
  ('CUSTOMER','SUPER_ADMIN','OPERATIONS','SALES','FINANCE','AUDITOR');
CREATE TYPE user_status AS ENUM ('ACTIVE','BLOCKED');
CREATE TYPE seller_type AS ENUM ('OWN_COMPANY','THIRD_PARTY');       -- THIRD_PARTY = Phase 3
CREATE TYPE project_status AS ENUM ('DRAFT','PUBLISHED','PAUSED','ARCHIVED');
CREATE TYPE plot_status AS ENUM ('AVAILABLE','BLOCKED','BOOKED','SOLD','WITHDRAWN');
CREATE TYPE booking_status AS ENUM
  ('BLOCKED','BOOKED','EXPIRED','CANCELLED','MANUAL_REVIEW');
CREATE TYPE payment_status AS ENUM
  ('CREATED','SUCCESS','FAILED','MANUAL_REVIEW','REFUND_INITIATED','REFUNDED');
CREATE TYPE approval_status AS ENUM ('PENDING','APPROVED','REJECTED','WITHDRAWN');
CREATE TYPE approval_action AS ENUM (
  'UPDATE_PLOT_PRICE','FORCE_PLOT_STATUS','CANCEL_BOOKING','EXTEND_HOLD',
  'RESOLVE_MANUAL_REVIEW','INITIATE_REFUND','PUBLISH_PROJECT','UPDATE_ADVANCE_CAP',
  'BULK_PRICE_UPDATE','UPDATE_GLOBAL_SETTING');
CREATE TYPE notification_channel AS ENUM ('PUSH','SMS','WHATSAPP');
```

Admin roles: SUPER_ADMIN (everything incl. settings), OPERATIONS (projects/plots/maps),
SALES (bookings view, hold extensions request), FINANCE (payments, refunds, reconciliation,
manual review), AUDITOR (read-only + audit log). Any admin role except the maker can approve an
approval **if the action's `approver_roles` (MC §3) includes their role**.

## 3. State machines

### 3.1 plot.status
```
AVAILABLE ──block (CF §2)──────────────▶ BLOCKED
BLOCKED ──verified webhook success────▶ BOOKED
BLOCKED ──hold expiry / booking cancel─▶ AVAILABLE
BOOKED ──registration complete (admin, MC FORCE_PLOT_STATUS)─▶ SOLD
BOOKED ──booking cancelled (MC CANCEL_BOOKING, after refund decision)─▶ AVAILABLE
AVAILABLE ⇄ WITHDRAWN (MC FORCE_PLOT_STATUS — inventory pulled/restored)
```
No other transitions exist. Every transition is written by exactly one code path listed in CF,
inside a transaction that also writes the corresponding booking row (where applicable) and an
audit row.

### 3.2 booking.status
```
(insert) BLOCKED ──verified webhook success──▶ BOOKED
BLOCKED ──expires_at passed (sweeper or lazy repair)──▶ EXPIRED
BLOCKED ──customer/admin cancel──▶ CANCELLED
BLOCKED|EXPIRED ──webhook anomaly (amount mismatch, late capture)──▶ MANUAL_REVIEW
MANUAL_REVIEW ──MC RESOLVE_MANUAL_REVIEW──▶ BOOKED or CANCELLED
BOOKED ──MC CANCEL_BOOKING──▶ CANCELLED
```
**Active** statuses (hold the plot): `BLOCKED`, `BOOKED`, `MANUAL_REVIEW`.

### 3.3 payment.status
`CREATED → SUCCESS | FAILED | MANUAL_REVIEW`; `SUCCESS → REFUND_INITIATED → REFUNDED`
(refund states driven by MC action 6; execution manual in Phase 1).

## 4. Entity-relationship overview

```
sellers 1─* projects 1─* plots 1─* bookings *─1 users
                   1─* site_maps 1─* plot_geometries *─1 plots
bookings 1─* payments        payments 1─* webhook_events (by gateway ids)
approvals ─(entity_type, entity_id)→ any    audit_logs ─(append only)→ any
```

## 5. Tables (V2__tables.sql)

### 5.1 users
```sql
CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone         text UNIQUE,                  -- E.164, required for CUSTOMER
  email         text UNIQUE,                  -- required for admin roles
  full_name     text NOT NULL DEFAULT '',
  role          user_role NOT NULL DEFAULT 'CUSTOMER',
  status        user_status NOT NULL DEFAULT 'ACTIVE',
  password_hash text,                         -- argon2id, admin roles only
  CONSTRAINT customer_has_phone CHECK (role <> 'CUSTOMER' OR phone IS NOT NULL),
  CONSTRAINT admin_has_password CHECK (role = 'CUSTOMER' OR password_hash IS NOT NULL)
);
```

### 5.2 otp_challenges
```sql
CREATE TABLE otp_challenges (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone        text NOT NULL,
  otp_hash     text NOT NULL,                 -- sha256(otp + server pepper)
  expires_at   timestamptz NOT NULL,          -- now() + 5 min
  attempts     int NOT NULL DEFAULT 0,        -- verify attempts, max 5
  consumed_at  timestamptz
);
```
Rate limits (enforced in service, counting rows): ≤ 3 sends per phone per 15 min,
≤ 10 per phone per day, ≤ 30 per IP per day. Config keys in §7.

### 5.3 refresh_tokens, device_tokens
```sql
CREATE TABLE refresh_tokens (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id),
  token_hash text NOT NULL UNIQUE,            -- sha256 of the opaque token
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  replaced_by uuid REFERENCES refresh_tokens(id)   -- rotation chain
);
CREATE TABLE device_tokens (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id   uuid NOT NULL REFERENCES users(id),
  fcm_token text NOT NULL,
  platform  text NOT NULL CHECK (platform IN ('android','ios')),
  UNIQUE (user_id, fcm_token)
);
```

### 5.4 sellers, projects
```sql
CREATE TABLE sellers (
  id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name   text NOT NULL,
  type   seller_type NOT NULL DEFAULT 'OWN_COMPANY',
  contact jsonb NOT NULL DEFAULT '{}'
);
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
  lat           double precision, lng double precision,
  amenities     jsonb NOT NULL DEFAULT '[]',
  status        project_status NOT NULL DEFAULT 'DRAFT',
  rera_registered boolean NOT NULL DEFAULT false,
  rera_number   text,
  max_advance_percentage numeric(5,2) NOT NULL DEFAULT 10.00
                CHECK (max_advance_percentage > 0),
  hold_minutes_override int CHECK (hold_minutes_override BETWEEN 30 AND 10080),
  CONSTRAINT rera_needs_number CHECK (NOT rera_registered OR rera_number IS NOT NULL)
);
```
Effective advance cap = `LEAST(max_advance_percentage, 10.00)` when `rera_registered`; otherwise
`max_advance_percentage` (still defaulted 10). Compute in service, per Invariant 8.

### 5.5 plots
```sql
CREATE TABLE plots (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id   uuid NOT NULL REFERENCES projects(id),
  plot_number  text NOT NULL,
  facing       text,                              -- N/S/E/W/NE/...
  dimensions_text text NOT NULL DEFAULT '',       -- e.g. "30 x 40 ft"
  area_sqft    numeric(10,2) NOT NULL CHECK (area_sqft > 0),
  price_paise  bigint NOT NULL CHECK (price_paise > 0),
  status       plot_status NOT NULL DEFAULT 'AVAILABLE',
  attributes   jsonb NOT NULL DEFAULT '{}',       -- corner, park-facing, ...
  UNIQUE (project_id, plot_number)
);
```

### 5.6 site_maps, plot_geometries
```sql
CREATE TABLE site_maps (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES projects(id),
  version     int NOT NULL,                       -- map_version
  image_key   text NOT NULL,                      -- S3 object key
  width_px    int NOT NULL, height_px int NOT NULL,
  is_active   boolean NOT NULL DEFAULT false,
  UNIQUE (project_id, version)
);
-- exactly one active map per project:
CREATE UNIQUE INDEX uniq_active_map_per_project ON site_maps(project_id) WHERE is_active;

CREATE TABLE plot_geometries (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_map_id uuid NOT NULL REFERENCES site_maps(id),
  plot_id     uuid NOT NULL REFERENCES plots(id),
  polygon     jsonb NOT NULL,   -- [[x,y],...] normalized 0..1 relative to image, ≥3 points
  centroid    jsonb NOT NULL,   -- [x,y] normalized, for the tap label
  UNIQUE (site_map_id, plot_id)
);
```

### 5.7 bookings — the heart of the system
```sql
CREATE TABLE bookings (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plot_id           uuid NOT NULL REFERENCES plots(id),
  user_id           uuid NOT NULL REFERENCES users(id),
  status            booking_status NOT NULL DEFAULT 'BLOCKED',
  total_price_paise bigint NOT NULL,          -- price SNAPSHOT at block time
  advance_amount_paise bigint,                -- set at payment-order time
  hold_minutes      int NOT NULL,             -- resolved at block time
  blocked_at        timestamptz NOT NULL DEFAULT now(),
  expires_at        timestamptz NOT NULL,     -- FROZEN at block time (Invariant 5)
  confirmed_at      timestamptz,
  closed_at         timestamptz,              -- when EXPIRED/CANCELLED
  idempotency_key   text NOT NULL,
  UNIQUE (user_id, idempotency_key)
);
-- INVARIANT 3 — the backstop against double-booking races:
CREATE UNIQUE INDEX uniq_active_booking_per_plot ON bookings(plot_id)
  WHERE status IN ('BLOCKED','BOOKED','MANUAL_REVIEW');
```

### 5.8 payments
```sql
CREATE TABLE payments (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id         uuid NOT NULL REFERENCES bookings(id),
  gateway            text NOT NULL DEFAULT 'RAZORPAY',
  gateway_order_id   text NOT NULL UNIQUE,
  gateway_payment_id text UNIQUE,             -- set by webhook; idempotency anchor
  amount_paise       bigint NOT NULL CHECK (amount_paise > 0),
  currency           text NOT NULL DEFAULT 'INR',
  status             payment_status NOT NULL DEFAULT 'CREATED',
  receipt_number     text UNIQUE,             -- DHN-YYYY-NNNNNN, on SUCCESS
  failure_reason     text,
  raw_webhook        jsonb,                   -- last decisive webhook payload
  idempotency_key    text NOT NULL,
  UNIQUE (booking_id, idempotency_key)
);
```

### 5.9 webhook_events (dedup + forensics)
```sql
CREATE TABLE webhook_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  gateway         text NOT NULL,
  event_id        text NOT NULL,              -- gateway's event id (x-razorpay-event-id)
  event_type      text NOT NULL,
  gateway_payment_id text,
  signature_valid boolean NOT NULL,
  payload         jsonb NOT NULL,
  outcome         text NOT NULL,              -- PROCESSED|DUPLICATE|IGNORED|MANUAL_REVIEW|INVALID_SIGNATURE
  processed_at    timestamptz,
  UNIQUE (gateway, event_id)
);
```

### 5.10 approvals (MC doc governs semantics)
```sql
CREATE TABLE approvals (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  action        approval_action NOT NULL,
  entity_type   text NOT NULL,                -- 'plot'|'booking'|'project'|'payment'|'global_setting'
  entity_id     text NOT NULL,
  payload       jsonb NOT NULL,               -- proposed change, action-specific (MC §3)
  snapshot      jsonb NOT NULL,               -- entity state at request time (for the diff UI)
  reason        text NOT NULL,
  status        approval_status NOT NULL DEFAULT 'PENDING',
  requested_by  uuid NOT NULL REFERENCES users(id),
  decided_by    uuid REFERENCES users(id),
  decided_at    timestamptz,
  decision_note text,
  CONSTRAINT maker_is_not_checker CHECK (decided_by IS NULL OR decided_by <> requested_by)
);
-- one pending approval per (action, entity):
CREATE UNIQUE INDEX uniq_pending_approval
  ON approvals(action, entity_type, entity_id) WHERE status = 'PENDING';
```

### 5.11 audit_logs (append-only)
```sql
CREATE TABLE audit_logs (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_id    uuid,                           -- NULL for system (sweeper, webhook)
  actor_role  text NOT NULL,                  -- role or 'SYSTEM'
  action      text NOT NULL,                  -- e.g. 'booking.block','plot.status','approval.approve'
  entity_type text NOT NULL,
  entity_id   text NOT NULL,
  before      jsonb,
  after       jsonb,
  request_id  text,
  ip          inet,
  created_at  timestamptz NOT NULL DEFAULT now()
);
REVOKE UPDATE, DELETE ON audit_logs FROM PUBLIC;
-- and from the app role explicitly in V4:
-- REVOKE UPDATE, DELETE ON audit_logs FROM dhanam_app;
```

### 5.12 notifications, reconciliation
```sql
CREATE TABLE notifications (
  id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id  uuid NOT NULL REFERENCES users(id),
  channel  notification_channel NOT NULL,
  template text NOT NULL,                     -- 'hold_created'|'hold_reminder_6h'|...
  payload  jsonb NOT NULL DEFAULT '{}',
  sent_at  timestamptz,
  error    text
);
CREATE TABLE reconciliation_runs (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_date   date NOT NULL UNIQUE,
  source     text NOT NULL,                   -- 'RAZORPAY_SETTLEMENT_API'|'CSV'
  matched    int NOT NULL DEFAULT 0,
  unmatched  int NOT NULL DEFAULT 0,
  completed_at timestamptz
);
CREATE TABLE reconciliation_items (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id     uuid NOT NULL REFERENCES reconciliation_runs(id),
  gateway_payment_id text NOT NULL,
  amount_paise bigint NOT NULL,
  matched_payment_id uuid REFERENCES payments(id),
  status     text NOT NULL                    -- 'MATCHED'|'AMOUNT_MISMATCH'|'UNKNOWN_PAYMENT'|'MISSING_AT_GATEWAY'
);
```

### 5.13 global_settings (V4__config.sql)
```sql
CREATE TABLE global_settings (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_by uuid REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO global_settings(key, value) VALUES
  ('global_hold_minutes',        '1440'),
  ('max_active_holds_per_user',  '2'),
  ('otp_send_limit_per_15min',   '3'),
  ('otp_send_limit_per_day',     '10'),
  ('otp_verify_max_attempts',    '5'),
  ('min_advance_paise',          '1000000'),   -- ₹10,000 floor for an advance
  ('reminder_offsets_minutes',   '[360, 60]'); -- T-6h, T-1h
```
Settings are read through `common`'s ConfigService (DB value → env default → hardcoded default)
and cached 60 s. Changing `global_hold_minutes` affects only FUTURE holds (Invariant 5).
`UPDATE_GLOBAL_SETTING` is maker-checker controlled.

## 6. Indexes (V3__indexes.sql) — beyond PK/unique above

```sql
CREATE INDEX idx_plots_project_status      ON plots(project_id, status);
CREATE INDEX idx_bookings_user             ON bookings(user_id, created_at DESC);
CREATE INDEX idx_bookings_due_expiry       ON bookings(expires_at) WHERE status = 'BLOCKED';
CREATE INDEX idx_bookings_plot             ON bookings(plot_id, created_at DESC);
CREATE INDEX idx_payments_booking          ON payments(booking_id);
CREATE INDEX idx_approvals_pending         ON approvals(status, created_at) WHERE status='PENDING';
CREATE INDEX idx_audit_entity              ON audit_logs(entity_type, entity_id, created_at DESC);
CREATE INDEX idx_otp_phone_time            ON otp_challenges(phone, created_at DESC);
CREATE INDEX idx_geometries_map            ON plot_geometries(site_map_id);
```

## 7. Seed data spec (db/seed.sql — dev/staging only)

1. One seller: "Dhanam Realty (Own)", type OWN_COMPANY.
2. One project: **Dhanam Green Meadows**, PUBLISHED, `rera_registered = true`,
   `rera_number = 'TN/29/LAYOUT/DEMO'`, max_advance_percentage 10.00, Coimbatore, TN.
3. One active site_map (version 1, placeholder image_key `seed/green-meadows-v1.png`,
   2000×1400 px).
4. Three plots: P-01 (30×40, 1200 sqft, ₹18,00,000 = 180000000 paise, AVAILABLE),
   P-02 (30×50, 1500 sqft, ₹22,50,000, AVAILABLE), P-03 (40×60, 2400 sqft, ₹36,00,000,
   AVAILABLE) — each with a rectangular polygon in plot_geometries.
5. One admin user per role (password `Dhanam@Dev1`, argon2id-hashed at seed-generation time):
   `super@dev.dhanam`, `ops@dev.dhanam`, `sales@dev.dhanam`, `finance@dev.dhanam`,
   `auditor@dev.dhanam`; one customer `+919800000001`.
6. global_settings rows as in §5.13 (idempotent `ON CONFLICT DO NOTHING`).
