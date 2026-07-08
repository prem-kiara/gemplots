# 08 — Gem Housing Pivot (authoritative)

**Precedence: where this document conflicts with docs 01–07, THIS document wins.** Docs 01–07
remain the reference for everything not touched here (hold-engine mechanics, expiry defenses,
audit rules, module boundaries, maker-checker framework — all unchanged in substance).

Decisions locked with the owner on 2026-07-07:
demo-mode email • exclusive hold (30 min OTP / 48 h admin windows) • one Next.js app • payments
dormant behind a flag.

## 1. What changed and why

The platform is **Gem Housing** (`plots.gemhousing.in`), not Dhanam. There are **no live
integrations** — no payment gateway, no SMS, no FCM, no S3. Every integration is replaced by a
human-in-the-loop or local workaround, each behind the same driver interface so the real
integration is a later env flip, not a rebuild:

| Was (integration) | Now (workaround) | Later |
|---|---|---|
| SMS OTP login | **Email OTP** login (demo mode: outbox + on-screen code) | SMTP flip / SMS |
| Payment advance → webhook confirms booking | **No money.** Customer requests → email-OTP confirms intent → **admin approves in portal** → plot RESERVED. Maker = customer, checker = admin. | `PAYMENTS_ENABLED=true` re-arms the dormant payment path |
| FCM push | **In-portal notifications** (admin bell + feed) + emails via outbox | FCM driver |
| S3 storage | **Local-disk storage** driver (`uploads/`, served statically) | S3 driver |
| SMTP email | **Console/outbox driver**: every email recorded in `emails_outbox`; admins read it in the portal; customer OTPs shown on-screen (double-gated dev-only) | `EMAIL_MODE=smtp` |
| Flutter app | **Mobile-first responsive web** at plots.gemhousing.in, installable PWA | Flutter Phase 2 |

## 2. Revised invariants (Phase-1 active set)

Unchanged: 1 (Postgres is truth), 2 (row-lock on hold), 3 (one active booking per plot),
4 (Idempotency-Key on hold requests), 6 (triple-defended expiry), 9 (maker-checker for
controlled admin actions), 10 (immutable audit).

**Revised:**

- **5′ — deadlines are set only at state entry** by the state machine (reserve request:
  +`reserve_otp_minutes`; OTP confirm: +`admin_decision_hours`). Config changes never move a
  live deadline; the only manual extension is the EXTEND_HOLD maker-checker action.
- **7′ — a booking becomes RESERVED only through an admin approval** where
  `decided_by <> requested_by` (customer is the requester; DB CHECK enforces the split). No
  customer-facing code path may set RESERVED — the exact structural role the payment webhook
  used to play.
- **8 (RERA cap) — dormant** with the payment module; the code and its tests stay alive.
- **NEW 11 — every external integration sits behind a driver interface** (`EmailDriver`,
  `StorageDriver`, `PaymentGatewayAdapter`) with an offline driver as default. No module may
  import a vendor SDK directly.
- **NEW 12 — demo-mode OTP exposure is double-gated**: the API returns `dev_otp` only when
  `EMAIL_MODE=console` **and** `NODE_ENV !== 'production'`. A test must prove production hides it.

## 3. Rebrand spec

One-time, **before the first git commit** (the repo has never been committed, so migrations may
be rewritten in place this once; after the P0 commit, the never-edit-applied-migrations rule is
absolute):

- Names: product “Gem Plots” by Gem Housing; seller seed “Gem Housing (Own)”; seed project
  **Gem Meadows** (`gem-meadows`); admin emails `super@gemhousing.in`, `ops@…`, etc.;
  alert target `ADMIN_ALERT_EMAIL=admin@gemhousing.in`; receipt prefix `GEM-` (dormant).
- Databases: `gemplots` (dev), `gemplots_test` (tests); DB role `gemplots_app`
  (non-owner, same REVOKE regime).
- Env (new/changed): `EMAIL_MODE=console|smtp` (+`SMTP_HOST/PORT/USER/PASS/FROM`),
  `STORAGE_MODE=local|s3` (+`UPLOADS_DIR=./uploads`), `PAYMENTS_ENABLED=false`,
  `ADMIN_ALERT_EMAIL`, `PUBLIC_BASE_URL=https://plots.gemhousing.in`. Delete FCM/SMS/S3 keys
  from the active example (keep commented for later).
- All Dhanam strings in code, seed, OpenAPI, README/docs headers → Gem Housing.

## 4. Data model changes

Rewrite migrations in place per §3. Deltas from docs/02 (everything else unchanged):

```sql
-- enums: FULL new sets (dormant values kept so the payment module + tests still run)
plot_status:    AVAILABLE, ON_HOLD, RESERVED, SOLD, WITHDRAWN, BLOCKED, BOOKED   -- last 2 dormant
booking_status: PENDING_CONFIRMATION, PENDING_APPROVAL, RESERVED, EXPIRED, CANCELLED,
                REJECTED, BLOCKED, BOOKED, MANUAL_REVIEW                          -- last 3 dormant
approval_action: + 'RESERVE_PLOT'
otp_purpose (new): 'LOGIN','RESERVE'
```

```sql
-- users: email is the customer identity now
email text NOT NULL UNIQUE;          -- all roles
phone text UNIQUE NULL;              -- optional profile field
-- CHECK customer_has_phone → DROP. Keep admin_has_password.

-- otp_challenges: phone → email; add purpose + booking linkage
email text NOT NULL;  purpose otp_purpose NOT NULL DEFAULT 'LOGIN';
booking_id uuid NULL REFERENCES bookings(id);   -- set for RESERVE-purpose OTPs

-- bookings: + reserve_confirmed_at timestamptz NULL  (OTP done)
-- uniq_active_booking_per_plot WHERE status IN
--   ('PENDING_CONFIRMATION','PENDING_APPROVAL','RESERVED','BLOCKED','BOOKED','MANUAL_REVIEW')

-- NEW portal_notifications (admin feed + customer notices)
CREATE TABLE portal_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  audience text NOT NULL CHECK (audience IN ('ADMIN','CUSTOMER')),
  user_id uuid NULL REFERENCES users(id),        -- required when audience='CUSTOMER'
  type text NOT NULL,                            -- RESERVATION_REQUESTED | RESERVATION_CONFIRMED | ...
  title text NOT NULL, body text NOT NULL DEFAULT '',
  entity_type text, entity_id text,
  read_at timestamptz,          -- ADMIN feed: shared read state (any admin clears it) — accepted Phase-1 simplification
  created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX idx_portal_notif_feed ON portal_notifications(audience, created_at DESC) WHERE read_at IS NULL;

-- NEW emails_outbox (every email passes through, regardless of driver)
CREATE TABLE emails_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  to_email text NOT NULL, template text NOT NULL, subject text NOT NULL,
  body_text text NOT NULL, payload jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL CHECK (status IN ('LOGGED','SENT','FAILED')),  -- LOGGED = console driver
  error text, sent_at timestamptz, created_at timestamptz NOT NULL DEFAULT now());

-- global_settings: + reserve_otp_minutes=30, admin_decision_hours=48; keep the rest
```

## 5. The reserve flow (replaces block-and-pay as THE critical flow)

State machine (active statuses hold the plot exclusively via the partial unique index):

```
plot:    AVAILABLE → ON_HOLD → RESERVED → SOLD;   ON_HOLD → AVAILABLE (expiry/reject/cancel)
booking: (insert) PENDING_CONFIRMATION ──customer email-OTP──▶ PENDING_APPROVAL
         PENDING_APPROVAL ──admin approve──▶ RESERVED    ──admin reject──▶ REJECTED
         PENDING_CONFIRMATION|PENDING_APPROVAL ──deadline passes──▶ EXPIRED
         any active ──MC CANCEL_BOOKING──▶ CANCELLED
```

**Step 1 — `POST /plots/{id}/reserve`** [CUSTOMER, `Idempotency-Key` required]
Identical transaction shape to CF §2 (same lock, same pre-checks incl. in-TX hold-limit
re-check, same unique-index backstop, same replay semantics):
plot `AVAILABLE`+project `PUBLISHED` `FOR UPDATE` → insert booking `PENDING_CONFIRMATION`
(price snapshot, `expires_at = now() + reserve_otp_minutes`) → plot `ON_HOLD` → audit.
Post-commit: create RESERVE-purpose OTP challenge for the customer’s email + send
`reserve_otp` email; admin feed event `RESERVATION_REQUESTED`.
Response: booking payload + `challenge_id` (+ `dev_otp` per Invariant 12).

**Step 2 — `POST /reservations/{id}/confirm`** `{challenge_id, otp}` [CUSTOMER owner]
Verify OTP (purpose RESERVE, matching booking, attempts/expiry rules as login OTP). Then in one
TX: booking `PENDING_CONFIRMATION→PENDING_APPROVAL` (guarded: status + not expired),
`reserve_confirmed_at=now()`, `expires_at = now() + admin_decision_hours`, **create the
approvals row** (`action='RESERVE_PLOT'`, entity=booking, `requested_by = customer`,
snapshot = booking+plot+customer summary), audit.
Post-commit: email `reservation_requested_admin` → `ADMIN_ALERT_EMAIL` with a deep link to the
approval; email `reservation_received` → customer; admin feed `RESERVATION_CONFIRMED`
(this is the action-needed event).

**Step 3 — admin decision** via the standard approvals endpoints (API §5.4) with a
`RESERVE_PLOT` handler in the registry (MC §2):
- makerRoles: none (customer-initiated; the request path is step 2, not an admin endpoint).
- approverRoles: SUPER_ADMIN, OPERATIONS, SALES. `maker_is_not_checker` CHECK holds
  (customer ≠ admin).
- Guardrails (re-run at decision time): booking is `PENDING_APPROVAL` and not past
  `expires_at`; plot is `ON_HOLD` held by this booking.
- approve → TX: booking `RESERVED`, plot `RESERVED`, approval `APPROVED`, audit. Post-commit:
  customer email `reservation_approved` + customer notification; admin feed.
- reject (note required) → TX: booking `REJECTED`, plot `ON_HOLD→AVAILABLE` (guarded),
  approval `REJECTED`, audit. Post-commit: customer email `reservation_rejected`; admin feed.

**Expiry rework** (same three defenses, same guarded-UPDATE pattern from CF §3):
```sql
UPDATE bookings SET status='EXPIRED', closed_at=now()
 WHERE id=$1 AND status IN ('PENDING_CONFIRMATION','PENDING_APPROVAL') AND expires_at <= now();
-- if 1 row: plot ON_HOLD→AVAILABLE (guarded);
--   auto-withdraw any PENDING approvals row for this booking
--   (status='WITHDRAWN', decision_note='auto-expired', decided_by stays NULL);
--   audit('SYSTEM','booking.expire'); customer email reservation_expired; admin feed event.
```
Sweeper + per-read lazy repair unchanged. Redis TTL key stays UX-only.

## 6. Email service

`EmailService.send(to, template, payload)`: render subject/body (plain text is fine Phase 1) →
**insert `emails_outbox` row always** → hand to driver:
- `ConsoleDriver` (default): logs; outbox `status='LOGGED'`. The portal’s outbox viewer
  (`/admin/emails`) is the demo-mode “sent mail” — this is how admins see what customers got.
- `SmtpDriver`: nodemailer against `SMTP_*` env; `SENT`/`FAILED`+error recorded.

Templates: `login_otp`, `reserve_otp`, `reservation_requested_admin`, `reservation_received`,
`reservation_approved`, `reservation_rejected`, `reservation_expired`. Reminder emails
(T-6h before admin deadline → admin) reuse the sweeper-adjacent scheduler later (P8-optional).

## 7. Notifications system (admin visibility requirement)

`NotificationService.feed(audience, type, title, body, entity)` → `portal_notifications`.
Emitted at every reserve-flow transition (§5), plus `NEW_CUSTOMER` (first login),
`MAP_ACTIVATED`, `PLOTS_IMPORTED`, and every MC decision. Endpoints:

| Endpoint | Notes |
|---|---|
| `GET /admin/notifications?unread=true&cursor=` | feed, newest first; `[ADMIN:any]` |
| `GET /admin/notifications/count` | `{unread: n}` — the bell polls this every 30 s |
| `POST /admin/notifications/{id}/read` • `POST /admin/notifications/read-all` | shared read state |
| `GET /me/notifications` | customer’s own notices |
| `GET /admin/emails?to=&template=&cursor=` | outbox viewer `[ADMIN:any]` |

## 8. Storage

`StorageService` gets drivers: `LocalDiskDriver` (default — writes `UPLOADS_DIR`, served
read-only at `GET /files/*` by Nest static middleware; `signedGetUrl` returns
`{PUBLIC_BASE_URL}/api/files/{key}`) and the existing S3 stub behind `STORAGE_MODE=s3`.
Fixes the current silent no-op: map images must actually persist and round-trip.

## 9. Auth changes

- `POST /auth/otp/request {email}` / `verify {challenge_id, email, otp}` — find-or-create
  customer **by email**. Same rate limits keyed on email. Login OTPs are `purpose='LOGIN'`.
- `PATCH /me {full_name?, phone?}` [CUSTOMER] — profile completion (admin needs a callable
  contact on the approval screen; prompt for it in the reserve UI before step 2).
- Admin email+password login unchanged.

## 10. Payments dormancy

- `PaymentModule` (controller + webhook route) is mounted **only when `PAYMENTS_ENABLED=true`**.
  Default false; OpenAPI spec omits payment paths; the route-parity gate runs with the flag off.
- Tests keep running: `test/setup.ts` sets `PAYMENTS_ENABLED=true`; payment/webhook specs are
  updated to **fixture-create `BLOCKED` bookings via SQL** (the old `block()` semantics no
  longer produce them) so they keep exercising order-creation + webhook machinery end to end.
- The dormant enum values (`BLOCKED`,`BOOKED`,`MANUAL_REVIEW`) exist solely for this module.

## 11. API surface delta

**Removed from active surface** (dormant with flag): `POST /bookings/{id}/payment-order`,
`POST /webhooks/payments/{gateway}`.

**Changed:** `POST /plots/{id}/block` → **`POST /plots/{id}/reserve`** (§5 step 1; response adds
`challenge_id`, drops advance/cap fields). `GET /bookings/{id}` + `/me/bookings` unchanged
shapes minus payments array when flag off. Auth endpoints take `email` not `phone`.

**New:** `POST /reservations/{id}/confirm` (§5 step 2) • notifications + outbox endpoints (§7) •
`PATCH /me` (§9) • `GET /admin/bookings` (filters: status, project, email, from/to) •
`GET /admin/audit-logs`, `GET /admin/settings` (from API §5.5/5.7 — now needed by the portal) •
approvals endpoints per API §5.4 (now actually built).

**New error codes:** `OTP_PURPOSE_MISMATCH`, `RESERVATION_NOT_PENDING` (confirm on a non-
PENDING_CONFIRMATION booking), `PROFILE_INCOMPLETE` (optional guard before confirm).

## 12. Frontend architecture (`web/` — one Next.js app)

Next.js 14+ (App Router, TypeScript). Mobile-first customer UI; responsive admin.

```
web/app/
├── (customer)/                      # mobile-first, PWA
│   ├── page.tsx                     # project list (cards: name, district, price range, availability)
│   ├── login/page.tsx               # email → OTP → in (shows dev_otp banner in demo mode)
│   ├── p/[slug]/page.tsx            # project detail + INTERACTIVE MAP
│   ├── reserve/[bookingId]/page.tsx # OTP confirm + live status/countdown (polls GET /bookings/{id})
│   └── me/page.tsx                  # my reservations (status chips, countdowns), profile form
├── admin/
│   ├── page.tsx                     # login
│   ├── home/page.tsx                # dashboard cards: pending approvals, holds live, inventory by status
│   ├── inbox/page.tsx + inbox/[id]/page.tsx   # approvals inbox + review detail (MC §4 layout)
│   ├── projects/… (list, edit, plots + CSV upload, map editor)
│   ├── notifications/page.tsx       # feed; bell in admin layout polls /count every 30s
│   ├── emails/page.tsx              # outbox viewer (demo-mode “sent mail”)
│   └── audit/page.tsx
└── lib/api.ts                       # typed fetch client
```

- **Interactive map:** site-map image in a pan/zoom container; SVG overlay scales polygons from
  normalized coords; fill by status (AVAILABLE tappable, ON_HOLD/RESERVED/SOLD tinted+disabled);
  tap → bottom sheet (mobile) / side panel (desktop) with plot facts + Reserve button.
- **Map editor (admin):** upload image → click-to-add-vertex polygons → assign plot from the
  unassigned list → save (PUT geometries) → activate (surface `MAP_INCOMPLETE.missing_plot_ids`).
  Correctness of stored geometry over editor polish.
- **API access:** same-origin — Next.js `rewrites()` proxies `/api/*` → NestJS :3000 (dev and
  prod), so no CORS. Access token in memory; refresh token in `localStorage` with rotation
  (documented XSS tradeoff, accepted for Phase 1).
- **Mobile view rule:** responsive CSS only (no UA sniffing) — a phone visiting
  plots.gemhousing.in gets the mobile layout naturally. PWA manifest + icons; installable.
- **Countdowns** derive from `expires_at`; demo-mode banners clearly marked.

Deployment sketch: one host; Caddy/nginx — `plots.gemhousing.in` → Next (:3001),
`/api/*` → Nest (:3000). Nest serves `/files/*` from `UPLOADS_DIR`.

## 13. Revised release gates (TP-P — replaces TP §2 actives; payment gates run dormant)

1. **Reserve concurrency**: 50 concurrent `reserve` on one plot → exactly one
   `PENDING_CONFIRMATION`, rest `409 PLOT_UNAVAILABLE`; replay returns **HTTP 200** (fix F3).
2. **Two-phase expiry**: (a) OTP window lapses → EXPIRED + plot AVAILABLE (sweeper AND
   lazy-repair-with-worker-down variants); (b) admin window lapses → EXPIRED + pending approval
   auto-WITHDRAWN; (c) deadlines don’t move when settings change (Invariant 5′).
3. **Invariant 7′**: no customer-facing call sets RESERVED (poll/read mutation test); approval
   by the requester is impossible (API 409 + DB CHECK direct-SQL test); approve applies
   booking+plot+approval in one TX.
4. **Invariant 12**: `dev_otp` present in console+non-prod; absent when `NODE_ENV=production`.
5. **Notifications**: each §5 transition emits its feed event + outbox row (asserted per
   transition); unread count endpoint correct.
6. **Catalog gates (overdue from v1)**: CSV all-or-nothing, geometry validation,
   `MAP_INCOMPLETE`, activation swap; `plots/bulk` route matches exactly.
7. **Dormant payments**: existing 16 payment/webhook tests stay green on fixtures; app boots
   with flag off and parity passes without payment routes.
