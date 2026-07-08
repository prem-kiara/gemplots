# Gem Plots Platform (Gem Housing) — Engineering Handover (v3)

**Read this first.** Single entry point for the build. v3 reflects the **Gem Housing pivot**
(2026-07-07): no live integrations — no payment gateway, no SMS, no push, no S3. Confirmation
is human: customer requests a plot → email-OTP confirms intent → **an admin approves in the
portal** → plot RESERVED. Product ships as a mobile-first web app at **plots.gemhousing.in**.

If you are an AI coding agent: your work queue is
[docs/09-build-instructions-v2.md](docs/09-build-instructions-v2.md) (session protocol:
docs/07 §0). Treat the **Invariants** below as hard constraints.

## Document map & precedence

| Document | Role |
|---|---|
| [docs/08-gemhousing-pivot.md](docs/08-gemhousing-pivot.md) | **The pivot spec — wins over every older doc on conflict.** Reserve flow, email/notifications/storage workarounds, frontend architecture, revised gates. |
| [docs/09-build-instructions-v2.md](docs/09-build-instructions-v2.md) | **Current build order** (P0–P8) + review fix-list. |
| [docs/10-ui-spec.md](docs/10-ui-spec.md) | **The UI spec** for `web/` (slices P4–P6): stack, design tokens, every screen with states, the map viewer + polygon editor, e2e gates. Wins on UI detail. |
| docs/01–07 | Reference architecture, data model, API, critical flows, maker-checker, tests, v1 protocol — valid wherever 08 doesn’t override. |
| [BUILD_STATUS.md](BUILD_STATUS.md) | Implementation progress (refreshed each slice). |

Within 01–07 the old precedence stands (DM schema > CF behavior > API wire). 08 outranks all.

## What exists already (verified)

The v1 NestJS backend: hold engine (50-way concurrency gate green), triple-defended expiry
(worker-down gate green), email-agnostic OTP machinery, approvals schema with the
maker≠checker DB CHECK, append-only audit (REVOKE-enforced), and a dormant but fully tested
payment/webhook stack. 31 tests across 5 suites. The pivot re-points this machinery; it does
not rebuild it.

## Invariants (Phase-1 active set — full text in 08 §2)

1. PostgreSQL is the source of truth; Redis is a helper only.
2. Placing a hold runs in one DB transaction with `SELECT … FOR UPDATE` on the plot row.
3. Exactly one active booking per plot — `uniq_active_booking_per_plot` is the backstop.
4. Reserve requests carry an `Idempotency-Key`; replays return the original result (HTTP 200).
5. Deadlines (`expires_at`) are set only at state entry (+30 min OTP / +48 h admin); config
   changes never move a live deadline; EXTEND_HOLD (maker-checker) is the only manual move.
6. Expiry is defended three ways: Redis TTL (UX), sweeper, lazy repair on read.
7. **A booking becomes RESERVED only via admin approval with `decided_by <> requested_by`.**
   No customer-facing path sets RESERVED.
8. RERA advance-cap — dormant with payments (`PAYMENTS_ENABLED=false`); code+tests stay alive.
9. Sensitive admin actions are maker-checker; guardrails re-run at approval time.
10. Every mutating action writes an immutable `audit_logs` row (DB-level REVOKE).
11. Every integration sits behind a driver interface with an offline default
    (Email: console+outbox • Storage: local disk • Payments: adapter, dormant).
12. Demo-mode OTP exposure (`dev_otp`) is double-gated: console driver AND non-production.

## Stack (locked)

NestJS modular monolith • PostgreSQL 15 (`gemplots`, app role `gemplots_app` non-owner) •
Redis (UX/queues) • **Next.js 14 single app** (`web/`): customer mobile-first at `/`, admin at
`/admin`, PWA, same-origin `/api` proxy • email via outbox-first driver (console now, SMTP
flip later) • uploads on local disk • money integer paise • time `timestamptz` UTC, display IST.

## Environment (starter)

```
DATABASE_URL=postgres://gemplots_app:gemplots_app_dev@localhost:5432/gemplots
DATABASE_URL_ADMIN=postgres://localhost:5432/gemplots
REDIS_URL=redis://localhost:6379
JWT_SECRET=...  JWT_REFRESH_SECRET=...  OTP_PEPPER=...      # fail-fast if dev-default in prod
EMAIL_MODE=console            # console | smtp  (+ SMTP_HOST/PORT/USER/PASS/FROM)
ADMIN_ALERT_EMAIL=admin@gemhousing.in
STORAGE_MODE=local            UPLOADS_DIR=./uploads
PAYMENTS_ENABLED=false
PUBLIC_BASE_URL=https://plots.gemhousing.in
GLOBAL_HOLD_MINUTES=1440  MAX_ACTIVE_HOLDS=2   # + reserve_otp_minutes / admin_decision_hours in global_settings
```

## Build order (briefs in docs/09)

P0 fixes+rebrand+first commit → P1 email service + email-OTP auth → **P2 reserve flow**
(critical) → P3 notifications + admin reads → P4 customer web app → P5 admin portal core →
P6 admin catalog UI + local storage → P7 remaining maker-checker actions → P8 hardening + deploy.

## CI gates (current)

Fresh-DB migrate+seed • TP-P gates 1–7 (08 §13: reserve concurrency, two-phase expiry,
admin-approval-only, dev_otp gating, notification emission, catalog gates, dormant payments) •
OpenAPI route parity (payments off) • typecheck + build • `grep -ri dhanam` returns nothing.
