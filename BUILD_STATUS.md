# Build Status — Gem Plots (Gem Housing)

Spec authority: [docs/08-gemhousing-pivot.md](docs/08-gemhousing-pivot.md) +
[docs/09-build-instructions-v2.md](docs/09-build-instructions-v2.md). The v1 NestJS backend
(hold engine, expiry, approvals schema, audit) is the foundation being re-pointed to the
no-integrations Gem Housing flows.

Verified against real local Postgres 15 + Redis 7 (no DB mocks). **81 backend tests across 10
suites** (reliably green — flaky integration race fixed), plus the full customer→admin golden
path verified in a real browser, plus a Playwright e2e smoke.

**Demo-ready AND deploy-ready.** Demo runbook: [DEMO.md](DEMO.md). Deploy runbook:
[docs/DEPLOY.md](docs/DEPLOY.md). Start locally: `bash scripts/demo-reset.sh` then
`cd api && npm run build && node dist/main.js` and `npm --workspace web run dev` (web on :3001).

**All slices P0–P8 complete.**

## Slice status (Gem Housing build order P0–P8)

| # | Slice | Status | Evidence |
|---|---|---|---|
| **P0** | Fix-list + rebrand + first commit | ✅ **Done** | F1–F7 applied; full Dhanam→Gem rebrand; 34 tests green; parity green; app boots, `/health` ok |
| **P1 / D1** | Email service + email-OTP auth | ✅ **Done** | `V5__email_identity.sql`; EmailService+outbox+Console/Smtp drivers; auth by email; `PATCH /me`; dev_otp double-gate; 38 tests green; parity green |
| **P2 / D2** | **Reserve flow** (critical) | ✅ **Done** | `POST /plots/{id}/reserve` (replaces `/block`), `/reservations/{id}/confirm` + `/resend-otp`, RESERVE_PLOT approval handler + `/admin/approvals` endpoints, two-phase expiry + approval auto-withdraw, `NotificationFeedService.feed()`, payments dormancy (conditional mount, SQL fixtures); TP-P gates 1/2/3/7 green; 47 tests green; parity green (payments off) |
| **P3 / D3** | Admin visibility + local storage + demo seed | ✅ **Done** | Notifications read endpoints (`/admin/notifications` feed/count/read/read-all, `/me/notifications`), `/admin/emails`, `/admin/bookings`, `/admin/audit-logs` (SA+AUDITOR), `/admin/settings` (RO), `/admin/dashboard/summary` (10 §5.3.3, lazy-repaired); NEW_CUSTOMER/MAP_ACTIVATED/PLOTS_IMPORTED feed events; `StorageService` LocalDiskDriver + static `GET /files/*`; `GET /projects/{idOrSlug}`; Gem Meadows → 12 plots + aligned SVG site plan; `scripts/demo-reset.sh`; 59 tests green; parity green |
| **P4+P5 / D4** | Web app — customer face + admin portal core | ✅ **Done** | `web/` Next.js 14 + Tailwind + TanStack Query, port 3001, `/api` proxy, PWA. Customer: home, email-OTP login (dev-OTP banner), project detail + interactive `PlotMap` (overlay aligned to image, fixed in D4.1), plot sheet, reserve journey (stepper/OTP/countdown/poll), `/me`. Admin: login, shell + bell, dashboard, approvals inbox + review detail (guardrails, email-verified, ConfirmDialog approve/reject), notifications, emails outbox, audit. **Golden path verified in-browser end-to-end.** |
| **P6** | Admin catalog UI (project create/edit + **polygon editor**) | ✅ **Done** | Admin project list (incl. DRAFT), New-project form, detail tabs (Details/Plots/Site map), CSV upload with dry-run preview, full PolygonEditor (draw/edit/assign/save/activate, MAP_INCOMPLETE). Geometry round-trips byte-exact onto the customer map. Verified in-browser. |
| **P7** | Remaining maker-checker actions | ✅ **Done** | 8 active handlers (PUBLISH_PROJECT, UPDATE_PLOT_PRICE, FORCE_PLOT_STATUS, CANCEL_BOOKING, EXTEND_HOLD, UPDATE_ADVANCE_CAP, BULK_PRICE_UPDATE, UPDATE_GLOBAL_SETTING) + maker endpoints; web Publish button + Settings page + generic review diff; MC §5 gate (self-approval, guardrail-drift, double-request, atomicity). RESOLVE_MANUAL_REVIEW + INITIATE_REFUND stay dormant with payments. |
| **P8** | Hardening + e2e + deploy | ✅ **Done** | Structured request logging (request_id), global rate limiter, deadline-reminder emails (worker sweep), Playwright e2e smoke wired into CI (isolated 3010/3011 + gemplots_e2e), flaky-test fix (baseline restore + retry), `infra/Caddyfile`, `scripts/backup.sh`, [docs/DEPLOY.md](docs/DEPLOY.md). Reconciliation + payments go-live stay dormant with payments (docs/11 ledger). |

## Known follow-ups (non-blocking)
- **Map endpoint slug**: `GET /projects/{id}/map` takes a UUID only; the web app fetches detail
  by slug first (works). Optional: accept slug there too for symmetry.
- **Customer email not in payloads**: JWT/booking responses omit the address, so a few UI strings
  say "your registered email". Add `email` to the `user` object / booking detail if literal
  interpolation is wanted.
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

## P3 / D3 detail (admin visibility + local storage + demo seed)

- **Notifications read surface** (08 §7): `NotificationService` gained `listAdmin`/`listCustomer`/
  `adminUnreadCount`/`markAdminRead`/`markAllAdminRead`. Endpoints on
  `AdminNotificationController` + `MeNotificationController`: `GET /admin/notifications`
  (`?unread&cursor&limit`, newest first), `/count`, `POST /:id/read` + `/read-all` (204, shared
  read state — any admin clears), `GET /me/notifications` (own CUSTOMER rows). Any-admin-role
  including AUDITOR.
- **Admin reads** (`AdminReadService` + `AdminReadController`): `GET /admin/emails` (outbox
  viewer), `/admin/bookings` (joined customer+plot+project, filters), `/admin/audit-logs`
  (SUPER_ADMIN + AUDITOR, cursor on the monotonic id), `/admin/settings` (RO, SUPER_ADMIN +
  AUDITOR), `/admin/dashboard/summary` — EXACT 10 §5.3.3 shape, runs `ExpiryService.repairPlots`
  over pending-booking plots before counting so numbers are truthful.
- **Feed events**: `NEW_CUSTOMER` (auth `verifyOtp` on customer row CREATE), `MAP_ACTIVATED`
  (`MapService.activate`), `PLOTS_IMPORTED` (`PlotService.bulkUpload` commit). Audience ADMIN,
  best-effort (never thrown into the business flow).
- **Local-disk storage** (Invariant 11, 08 §8): `StorageService` with `LocalDiskDriver` (default,
  `STORAGE_MODE=local`) — `putObject` writes `UPLOADS_DIR/<key>` (mkdir -p, `..`-traversal guard),
  `signedGetUrl` → `/api/files/<key>`; `S3Driver` kept for the `s3` flip. Catalog map upload +
  reads swapped off the old `S3Service` (deleted). `main.ts` mounts `express.static('/files')`
  from `UPLOADS_DIR` (`fallthrough:false`, `image/svg+xml` for `.svg`). `uploads/` gitignored.
- **`GET /projects/{idOrSlug}`** (10 §5.3.1): canonical-UUID → id lookup, else slug. Map route
  keeps id.
- **Demo seed**: Gem Meadows expanded to **12 plots** (P-01..P-03 byte-identical — pinned by
  tests; P-04..P-12 new, areas 1000–2600 sqft, prices 150M–400M paise, varied facings). Layout:
  row 1 (existing) → horizontal road → row 2 (5 plots) → thin road → row 3 (4 plots + a park).
  Checked-in `db/assets/gem-meadows-v1.svg` (2000×1400) draws every plot polygon at
  `normalized×(2000,1400)` so it aligns exactly with `plot_geometries` — plus roads, park+trees,
  compass, title block. `image_key='seed/gem-meadows-v1.svg'`. `scripts/demo-reset.sh` (drop →
  create → migrate → seed → copy asset into `api/uploads/seed`, prints demo credentials).

## Test inventory (59)

`concurrency` (2, TP §2.1 gate) • `expiry` (6, TP §2.2 gate) • `webhook` (8, TP §2.3, dormant
payments on fixtures) • `cap-limits-audit` (8, cap/limits/audit-immutability) • `auth` (11:
email happy-path, wrong-OTP attempts, send rate-limit, outbox row asserted, dev_otp present,
dev_otp hidden in production [TP-P §4], admin login, refresh rotation+reuse chain, PATCH /me +
audit, RBAC, missing bearer) • `p0-fixes` (3, F2/F3/F4) • `reserve-flow` (9, TP-P §3
Invariant 7′) • `admin-visibility` (12: notifications list/count/read/read-all, AUDITOR read,
`/me/notifications`, dashboard summary shape + lazy-repair, emails+bookings, audit/settings RBAC,
storage round-trip + `/files/*` serve + traversal guard, idOrSlug, seed integrity, NEW_CUSTOMER).
All release gates remain green.

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
