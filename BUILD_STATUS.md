# Build Status — Gem Plots (Gem Housing)

Spec authority: [docs/08-gemhousing-pivot.md](docs/08-gemhousing-pivot.md) +
[docs/09-build-instructions-v2.md](docs/09-build-instructions-v2.md). The v1 NestJS backend
(hold engine, expiry, approvals schema, audit) is the foundation being re-pointed to the
no-integrations Gem Housing flows.

Verified against real local Postgres 15 + Redis 7 (no DB mocks). **47 tests pass across 7 suites.**

## Slice status (Gem Housing build order P0–P8)

| # | Slice | Status | Evidence |
|---|---|---|---|
| **P0** | Fix-list + rebrand + first commit | ✅ **Done** | F1–F7 applied; full Dhanam→Gem rebrand; 34 tests green; parity green; app boots, `/health` ok |
| **P1 / D1** | Email service + email-OTP auth | ✅ **Done** | `V5__email_identity.sql`; EmailService+outbox+Console/Smtp drivers; auth by email; `PATCH /me`; dev_otp double-gate; 38 tests green; parity green |
| **P2 / D2** | **Reserve flow** (critical) | ✅ **Done** | `POST /plots/{id}/reserve` (replaces `/block`), `/reservations/{id}/confirm` + `/resend-otp`, RESERVE_PLOT approval handler + `/admin/approvals` endpoints, two-phase expiry + approval auto-withdraw, `NotificationFeedService.feed()`, payments dormancy (conditional mount, SQL fixtures); TP-P gates 1/2/3/7 green; 47 tests green; parity green (payments off) |
| P3 | Notifications + admin read surface | ⬜ | |
| P4 | Customer web app (mobile-first) | ⬜ | `web/` not yet created |
| P5 | Admin portal core | ⬜ | |
| P6 | Admin catalog UI + local storage | ⬜ | |
| P7 | Remaining maker-checker actions | ⬜ | |
| P8 | Hardening-lite + deploy | ⬜ | |

## P0 detail

**Review fixes (docs/09 F1–F7):**
- F1 — CI now installs at repo root (`npm ci`), `cache-dependency-path: package-lock.json`,
  runs workspace scripts via `npm --workspace api …`. Repo was already `git init`-ed.
- F2 — `POST /admin/projects/:id/plots:bulk` → `…/plots/bulk` (Express 4 parsed `:bulk` as a
  param). *Regression test in `test/p0-fixes.spec.ts`.*
- F3 — idempotent replay returns **200 + `Idempotency-Replay: true`** (was 201) via
  `@Res({passthrough})`. *Regression test.*
- F4 — hold-limit check moved inside the TX behind a per-user `SELECT … FOR UPDATE`; parallel
  blocks by one user can no longer overshoot `max_active_holds`. *Regression test (3 parallel → 2).*
- F5 — production boot refuses unset/dev-default `JWT_SECRET`/`JWT_REFRESH_SECRET`/`OTP_PEPPER`.
- F6 — Redis `retryStrategy` is capped exponential backoff (was give-up-forever); errors still
  swallowed (Redis stays UX-only).
- F7 — `catalog-read.getProject` reads `global_hold_minutes` through `ConfigService`, not raw SQL.

**Rebrand (docs/08 §3):** databases `gemplots`/`gemplots_test`, role `gemplots_app`, seed
“Gem Housing (Own)” / “Gem Meadows” (`gem-meadows`), admin emails `@gemhousing.in`, admin
password `GemHousing@Dev1`, receipt prefix `GEM-`. `grep -ri dhanam` is clean across
api/src, db, infra, and root config.

**Additive §4 schema landed in P0** (kept the existing suite green): full `plot_status` /
`booking_status` enum sets (dormant `BLOCKED`/`BOOKED`/`MANUAL_REVIEW` retained for the payment
module), `otp_purpose` enum, `RESERVE_PLOT` action, `bookings.reserve_confirmed_at`,
`uniq_active_booking_per_plot` WHERE-list updated, `portal_notifications` + `emails_outbox`
tables, `reserve_otp_minutes`/`admin_decision_hours` settings.

## SPEC-QUESTION (flagged for review)

docs/08 §3–§4 asks to "rewrite migrations in place" for the **whole** §4 including the
email-identity change (`users.email NOT NULL`, `otp_challenges` phone→email). That change is
**breaking** — it can't move without P1's auth code, and P0's DoD requires "full existing suite
green." So P0 applied only the **additive** parts of §4 and **deferred the email-identity change
to P1**, where it lands with the email-OTP auth code as migration `V5`. This keeps slice
boundaries clean and honors the DoD. If the reviewer wants the full schema frozen pre-commit
instead, P1's auth rewrite would need to fold into P0.

## P1 / D1 detail (email service + email-OTP auth)

- **`V5__email_identity.sql`** (first additive migration post-P0): `users.email` backfilled from
  phone then `SET NOT NULL`; `customer_has_phone` dropped (phone is optional profile now);
  `admin_has_password` kept. `otp_challenges`: `phone`→`email` (+backfill+NOT NULL), added
  `purpose otp_purpose DEFAULT 'LOGIN'` and `booking_id` FK; index `idx_otp_phone_time` →
  `idx_otp_email_time`.
- **EmailService** (`api/src/common/email/`): renders subject/body from a templates map (7
  templates, plain text, signed "— Gem Housing") → **always** inserts an `emails_outbox` row →
  hands to the `EMAIL_MODE`-selected driver: `ConsoleDriver` (default, status `LOGGED`) or
  `SmtpDriver` (nodemailer, `SENT`/`FAILED`+error). Driver behind an interface (Invariant 11);
  send failures recorded, never thrown into a business flow.
- **Auth pivot**: `otp/request {email}` / `otp/verify {challenge_id,email,otp}`, find-or-create
  by email, rate limits keyed on email, login OTP via `login_otp` template. `PATCH /v1/me`
  `{full_name?,phone?}` audited in the same TX. Admin login + refresh rotation unchanged.
- **dev_otp double-gate (Invariant 12)**: returned only when `EMAIL_MODE` is console/unset AND
  `NODE_ENV !== 'production'`, read at request time (no caching).

## Test inventory (38)

`concurrency` (2, TP §2.1 gate) • `expiry` (6, TP §2.2 gate) • `webhook` (8, TP §2.3, dormant
payments on fixtures) • `cap-limits-audit` (8, cap/limits/audit-immutability) • `auth` (11:
email happy-path, wrong-OTP attempts, send rate-limit, outbox row asserted, dev_otp present,
dev_otp hidden in production [TP-P §4], admin login, refresh rotation+reuse chain, PATCH /me +
audit, RBAC, missing bearer) • `p0-fixes` (3, F2/F3/F4). All release gates remain green.

## How to run locally

```bash
createdb gemplots
DATABASE_URL_ADMIN=postgres://localhost:5432/gemplots bash db/migrate.sh
DATABASE_URL_ADMIN=postgres://localhost:5432/gemplots psql "$DATABASE_URL_ADMIN" -f db/seed.sql
cd api && npm install && npm run build && node dist/main.js   # :3000

# tests (needs gemplots_test migrated + seeded the same way)
TEST_DATABASE_URL=postgres://gemplots_app:gemplots_app_dev@localhost:5432/gemplots_test \
TEST_DATABASE_URL_ADMIN=postgres://localhost:5432/gemplots_test npm test
```

Admin login (dev): `ops@gemhousing.in` / `GemHousing@Dev1`.
