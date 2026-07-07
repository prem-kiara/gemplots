# Build Status

Implementation progress against [docs/07-build-instructions.md](docs/07-build-instructions.md).
Backend built and verified against real Postgres 15 + Redis 7 (no DB mocks — the invariants live
in the DB). **31 tests pass across 5 suites**, including every release-gating test in
[docs/06-test-plan.md](docs/06-test-plan.md) §2.

## Slice status

| # | Slice | Status | Evidence |
|---|---|---|---|
| 1 | Bootstrap: monorepo, docker-compose, migrations, seed, health | ✅ Done | Fresh DB migrates (idempotent) + seeds (idempotent); `/health` → `{db:true,redis:true}` |
| 2 | Auth: OTP → JWT/refresh, admin login, RBAC | ✅ Done | `test/auth.spec.ts` (7 tests): OTP, rate limit, refresh rotation + reuse-chain revoke, RBAC, argon2 admin login |
| 3 | Admin: projects CRUD + bulk plot CSV | ✅ Backend done | Project create/patch, CSV all-or-nothing upload (rupees→paise). UI: Next.js pending |
| 4 | Admin: site-map upload + polygon geometries | ✅ Backend done | Upload/geometries/activate with `MAP_INCOMPLETE` guard. Polygon *editor UI*: Next.js pending |
| 5 | Customer read APIs | ✅ Done | `/projects`, `/projects/{id}`, `/projects/{id}/map`, `/plots/{id}` with lazy repair |
| 6 | **Hold engine** | ✅ Done (gate green) | `test/concurrency.spec.ts` — **TP §2.1**: 50 concurrent → exactly one 201 |
| 7 | Expiry: sweeper + TTL + lazy repair | ✅ Done (gate green) | `test/expiry.spec.ts` — **TP §2.2** incl. worker-down |
| 8 | Payment order (RERA cap) | ✅ Done (gate green) | `test/cap-limits-audit.spec.ts` — **TP §2.4** cap ±1 paise, integer math |
| 9 | **Payment webhook** | ✅ Done (gate green) | `test/webhook.spec.ts` — **TP §2.3** all 8 cases incl. Invariant-7 no-client-confirm |
| 10 | Customer dashboards + notifications | ◑ Partial | `GET /bookings/{id}`, `/me/bookings` done; notifications recorded to table; **FCM/SMS senders + BullMQ reminder jobs + Flutter app: pending** |
| 11 | Admin dashboards | ⬜ Not started | Aggregate endpoints + Next.js pages |
| 12 | Maker-checker | ⬜ Not started | `approvals` table + constraints exist; 10 handlers + Approvals screens pending |
| 13 | Reconciliation | ⬜ Not started | Tables + adapter seam exist; nightly job pending |
| 14 | Hardening | ⬜ Not started | Structured logs partial; OTel/metrics/load/restore drills pending |

## What runs today (verified end-to-end)

A full customer journey works through the live server (smoke-tested):
OTP → JWT → browse projects → open map → block a plot (idempotent) → create RERA-capped payment
order → signature-verified webhook confirms booking → poll shows BOOKED with receipt
`DHN-2026-000001`. Over-cap orders, duplicate webhooks, and bad signatures are all rejected
correctly.

## Invariants — enforcement evidence

1. Postgres source of truth — Redis disabled in tests, all correctness tests still pass ✅
2. Row lock on block — `booking.service.ts` `FOR UPDATE OF p`; TP §2.1 ✅
3. One active booking/plot — `uniq_active_booking_per_plot`; TP §2.1 ✅
4. Idempotency-Key + webhook dedup — TP §2.3b/c, §2.5 ✅
5. `expires_at` frozen — TP §2.2c ✅
6. Triple-defended expiry — TP §2.2a/b/d ✅
7. Booking BOOKED only via verified webhook — TP §2.3h ✅
8. RERA cap `min(project,10)%` integer — TP §2.4 ✅
9. Maker-checker — DB CHECK `maker_is_not_checker` in place; handlers pending (slice 12)
10. Audit append-only — `REVOKE UPDATE,DELETE`; TP §2.7 (app role denied) ✅

## Remaining work (in priority order)

1. **Slice 12 — maker-checker** (10 action handlers + approvals endpoints). Highest-value
   remaining backend; schema + constraints already in place.
2. **Slice 10 tail** — real FCM/SMS senders + BullMQ reminder jobs (T-6h/T-1h).
3. **Slice 13 — reconciliation** nightly job.
4. **Admin panel (Next.js)** — slices 3/4/11/12 UIs (polygon editor, dashboards, approvals inbox).
5. **Flutter customer app** — booking flow screens against the API.
6. **Slice 14 — hardening** — OTel, metrics, load + restore drills, security review.

## How to run locally

```bash
# from repo root — Postgres + Redis must be running (or: docker compose -f infra/docker-compose.yml up -d)
createdb dhanam
DATABASE_URL_ADMIN=postgres://localhost:5432/dhanam bash db/migrate.sh
DATABASE_URL_ADMIN=postgres://localhost:5432/dhanam psql "$DATABASE_URL_ADMIN" -f db/seed.sql
cd api && npm install && npm run build && node dist/main.js   # :3000, WORKER_MODE from .env

# tests (needs a dhanam_test DB migrated + seeded the same way)
TEST_DATABASE_URL=postgres://dhanam_app:dhanam_app_dev@localhost:5432/dhanam_test \
TEST_DATABASE_URL_ADMIN=postgres://localhost:5432/dhanam_test npm test
```
