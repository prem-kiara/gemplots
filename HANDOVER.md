# Dhanam Plots Platform — Engineering Handover (v2, self-contained)

**Read this first.** This is the single entry point for building Phase 1.

This v2 handover supersedes `Dhanam_Handover_Document.docx` (v1, 7 July 2026). v1 referred to
external companion documents (SRS, screen specs, migrations, openapi.yaml) that are **not part of
this repository**. Every detail those documents carried has been re-specified in the `docs/`
directory of this repo. **The `docs/` directory is now the source of truth.** Nothing outside this
repo is required to build Phase 1.

If you are an AI coding agent (Claude Opus, Sonnet, or similar): your operating manual is
[docs/07-build-instructions.md](docs/07-build-instructions.md). Read section 0 (Session Protocol)
of that file before writing any code. Treat the **Invariants** below as hard constraints that
override anything else you might infer.

---

## 1. What we are building

A mobile-first real-estate **plots booking platform**, designed to grow into a marketplace.

- **Phase 1 (build now):** customers browse projects → open an interactive site-map → tap a plot
  to see dimensions/price → **block** it (24h configurable hold) → **pay an advance** → booking
  confirmed. The whole operation is run from a web admin panel with maker-checker controls.
- **Phase 2 (later, do not build):** in-app chat, CRM, site visits, documents,
  agreement/registration tracking.
- **Phase 3 (later, do not build):** seller onboarding, third-party/resale listings,
  commission & settlement.

Operating rule: **build lean like Phase 1, design structurally like a marketplace.** Never
compromise inventory truth, payment verification, audit trail, or approval control.

## 2. Document map (source of truth)

| Document | What it specifies |
|---|---|
| [docs/01-architecture.md](docs/01-architecture.md) | System architecture, module boundaries, request lifecycles, infra topology, Phase-2/3 seams. |
| [docs/02-data-model.md](docs/02-data-model.md) | Complete PostgreSQL schema (DDL), enums, constraints, indexes, state machines, config keys, seed data spec. |
| [docs/03-api-contracts.md](docs/03-api-contracts.md) | Every Phase-1 endpoint: auth, request/response shapes, error catalog, idempotency rules. |
| [docs/04-critical-flows.md](docs/04-critical-flows.md) | The risky parts, step-by-step: hold engine, triple-defended expiry, payment order, webhook, reconciliation. |
| [docs/05-maker-checker.md](docs/05-maker-checker.md) | Approvals model, the 10 controlled admin actions, the two Approvals screens. |
| [docs/06-test-plan.md](docs/06-test-plan.md) | Release-gating tests (concurrency, expiry, webhook idempotency, RERA cap, hold limit) + per-module test lists + CI gates. |
| [docs/07-build-instructions.md](docs/07-build-instructions.md) | **The implementation playbook** — session protocol + 14 self-contained slice briefs. |

Cross-reference convention used throughout: `DM §n` = data-model doc, `API §n` = api-contracts,
`CF §n` = critical-flows, `MC §n` = maker-checker, `TP §n` = test-plan.

When two documents disagree: **02-data-model wins on schema, 04-critical-flows wins on runtime
behavior, 03-api-contracts wins on wire format.** Fix the loser in the same PR and note it.

## 3. Locked technical decisions

| Area | Decision |
|---|---|
| Customer app | Flutter (iOS + Android) |
| Admin panel | Next.js (React) — mandatory, not optional |
| Backend | NestJS **modular monolith** (single deployable, strict module boundaries) |
| Database | PostgreSQL 15+ — the only source of truth |
| Cache / jobs | Redis (hold TTL countdown, cache) + BullMQ (sweeper, notifications, reconciliation) |
| Storage / push / msg | S3-compatible object storage • FCM • DLT-approved SMS/WhatsApp |
| Payments | **Razorpay as default** behind a gateway-adapter interface (swap to Cashfree/PayU = new adapter only). Webhook-first, always. |
| Region / money / time | India (DPDP) • money as integer **paise** (`BIGINT`) • store `timestamptz` UTC, display IST |
| Migrations | Flyway-style versioned SQL files in `db/migrations/` (`V1__*.sql` …), applied by a plain runner script — no ORM auto-sync, ever |

## 4. Invariants — do not violate

Hard constraints for every contributor and every AI coding agent. A PR that violates one of these
is wrong even if all tests pass.

1. **PostgreSQL is the source of truth** for plot status; Redis is only a helper (countdown UX,
   cache). Never derive a business decision from Redis state.
2. **Blocking a plot happens inside one DB transaction** with `SELECT … FOR UPDATE` on the plot
   row. Zero rows returned by the status-filtered lock query IS the "unavailable" answer (→ 409).
3. **Exactly one active booking per plot**, enforced in the database by the partial unique index
   `uniq_active_booking_per_plot` (DM §5.7). The index is the backstop when two transactions race.
4. **Every block and payment-order request carries an `Idempotency-Key`** header; replays return
   the original result. Webhooks are idempotent on `(gateway, event_id)` and `gateway_payment_id`.
5. **`bookings.expires_at` is frozen at block time.** Config changes never lengthen or shorten a
   live hold.
6. **Expiry is defended three ways:** Redis TTL (UX only), the sweeper worker (authoritative),
   and lazy repair on every plot/booking read (CF §3). Any one alone must be sufficient.
7. **A booking becomes BOOKED only from a signature-verified webhook** — never from the client
   checkout callback. The app callback only navigates to a "processing" screen that polls
   `GET /bookings/{id}`.
8. **Advance is capped at `min(project.max_advance_percentage, 10)` percent** (RERA), computed as
   `floor(total_price_paise * cap_pct / 100)` and enforced *before* gateway order creation.
9. **Sensitive admin actions require maker-checker**: the maker's endpoint returns `202` + an
   approvals row; nothing on the target entity changes until a *different* admin approves
   (`requested_by <> approved_by`, enforced by DB CHECK). Guardrails are re-validated at approval
   time.
10. **Every mutating action writes an immutable `audit_logs` row.** `UPDATE`/`DELETE` are revoked
    on that table at the DB level.

## 5. Repository layout (monorepo)

```
dhanam/
├── api/                # NestJS modular monolith
│   └── src/modules/{auth,project,plot,map,booking,payment,notification,
│                    admin,approval,audit,common}
├── admin/              # Next.js admin panel
├── app/                # Flutter customer app
├── db/
│   ├── migrations/     # V1__enums.sql … V4__config.sql  (authored from DM doc)
│   └── seed.sql        # dev/staging only
├── docs/               # THE SPECS (this repo's source of truth)
└── infra/              # docker-compose (postgres, redis), CI
```

## 6. Environment variables (starter)

```
DATABASE_URL=postgres://user:pass@localhost:5432/dhanam
REDIS_URL=redis://localhost:6379
JWT_SECRET=...            JWT_REFRESH_SECRET=...
S3_ENDPOINT=...  S3_BUCKET=...  S3_KEY=...  S3_SECRET=...
PAYMENT_GATEWAY=RAZORPAY  PG_KEY_ID=...  PG_KEY_SECRET=...  PG_WEBHOOK_SECRET=...
FCM_SERVER_KEY=...        SMS_PROVIDER_KEY=...  SMS_DLT_HEADER=...
GLOBAL_HOLD_MINUTES=1440  MAX_ACTIVE_HOLDS=2
```

Operational config that can change at runtime (hold minutes, max holds, OTP limits) lives in the
`global_settings` table (DM §5.13); env vars are the bootstrap defaults only.

## 7. Build order

Fourteen shippable slices; each has a full brief in
[docs/07-build-instructions.md](docs/07-build-instructions.md). Definition of Done for every
slice: unit + integration tests green, OpenAPI updated, audit rows written where state mutates.

| # | Slice | Spec | Gate |
|---|---|---|---|
| 1 | Bootstrap: monorepo, docker-compose, migrations, seed, health check | DM all | Fresh DB migrates + seeds |
| 2 | Auth: customer OTP → JWT/refresh; admin login + RBAC | API §2, DM §5.1–5.3 | OTP rate-limited; roles enforced |
| 3 | Admin: projects CRUD + bulk plot CSV upload | API §5, DM §5.4–5.5 | Compliance fields captured |
| 4 | Admin: site-map upload + polygon editor persistence | API §5.4, DM §5.6 | Polygons keyed by (map version, plot) |
| 5 | Customer read APIs: projects / map / plot | API §3 | Plot read lazy-repairs expired holds |
| 6 | **Hold engine**: `POST /plots/{id}/block` | CF §2 | **Concurrency test TP §2.1 passes** |
| 7 | Expiry: sweeper + Redis TTL + lazy repair | CF §3 | Expires with worker down (TP §2.2) |
| 8 | Payment order (RERA cap) | CF §4 | Over-cap → 400 (TP §2.4) |
| 9 | **Payment webhook** | CF §5 | Verified, matched, idempotent; mismatch → MANUAL_REVIEW |
| 10 | Customer dashboards + notifications (T-6h/T-1h reminders) | API §4, CF §6 | Reminders fire |
| 11 | Admin dashboards: inventory / bookings / payments | API §5.6 | Live status accurate |
| 12 | Maker-checker: approvals + 2 screens + 10 wired actions | MC all | Maker ≠ checker enforced |
| 13 | Reconciliation job | CF §7 | Unmatched settlement → MANUAL_REVIEW |
| 14 | Hardening: observability, backups drill, load test, security review | TP §5 | Load + restore drills pass |

## 8. CI gates (block merge on failure)

1. Migrations apply cleanly on a fresh database; `seed.sql` loads.
2. **Concurrency test**: N simultaneous blocks on one plot → exactly one `201` (TP §2.1).
3. Expiry, webhook-idempotency, RERA-cap and hold-limit tests (TP §2.2–2.5).
4. Maker-checker self-approval is rejected; `audit_logs` UPDATE fails (TP §2.6–2.7).
5. OpenAPI spec validates and matches implemented routes.

## 9. Decisions already defaulted (flag at kickoff if wrong)

These were "open decisions" in the v1 handover. To unblock the build, the architecture assumes the
following defaults; each is isolated so reversing it is cheap:

1. **Payment gateway: Razorpay** — isolated behind `PaymentGatewayAdapter` (CF §4.1). Changing to
   Cashfree/PayU means writing one new adapter class + webhook verifier; no other code changes.
2. **Hosting**: India region, managed Postgres/Redis assumed; nothing in the code depends on this.
3. **Site-map format: raster image + normalized polygon overlays** (DM §5.6). If vector/CAD
   arrives later, geometries are already stored as coordinate arrays — only the admin editor's
   import path changes.
4. **Refund policy**: refunds are *initiated* only via maker-checker (MC action 6) and executed
   manually at the gateway dashboard in Phase 1; no auto-refund code path.
5. **RERA applicability**: per-project `rera_registered` flag; cap logic already handles both.
6. **Default hold**: 24h global (`global_hold_minutes = 1440`) with per-project override column.
