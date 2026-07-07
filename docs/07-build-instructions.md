# 07 — Build Instructions (implementation-agent playbook)

Written for the implementing model (Claude Opus / Sonnet or a human engineer). The architecture
is decided; your job is faithful implementation, slice by slice. **You do not make architectural
decisions.** If a spec seems wrong or incomplete, implement the closest faithful reading, leave a
`// SPEC-QUESTION:` comment, and list it in the PR description — do not invent a new design.

## 0. Session protocol (read every session)

1. **Scope = one slice per session/PR.** Slices are §2 below, in order. Do not start slice N+1
   until slice N's Definition of Done is met. Do not refactor code outside your slice.
2. **Read first, then code**: `HANDOVER.md` §4 (Invariants) + this file's brief for your slice +
   the spec sections the brief names. That's it — the docs are self-contained.
3. **Non-negotiables while coding**:
   - Never violate an Invariant (HANDOVER §4) even if a test seems to demand it.
   - Money: integer paise only. No floats anywhere near money. `Math.floor` for the cap.
   - Time: `timestamptz`, computed in SQL (`now()`) where transactional consistency matters.
   - Every state transition goes through the one sanctioned code path (CF doc); do not add
     alternate paths "for convenience".
   - Schema changes only via a NEW migration file (`V5__…` onward). Never edit an applied
     migration. Never enable ORM schema-sync.
   - Every mutating endpoint writes an audit row inside the same transaction.
4. **Definition of Done, every slice**: the brief's tests pass + the whole suite stays green +
   `api/openapi.yaml` updated for any route you added/changed + lint/typecheck clean.
5. **Verify like an operator**: after tests pass, run the app (`docker compose up` + seed) and
   exercise the slice's happy path once via HTTP (curl the endpoints; note it in the PR).
6. **Commit style**: `slice-<n>: <what>` — e.g. `slice-6: hold engine with row-lock block flow`.

Per-slice notation: **Specs** = required reading; **Build** = what to create;
**DoD** = gate to close the slice. Paths are relative to repo root.

---

## Slice 1 — Bootstrap: monorepo, infra, migrations, health

**Specs:** DM (whole doc), HANDOVER §5–6, TP §4.
**Build:**
- Monorepo layout per HANDOVER §5 (`api/`, `admin/`, `app/`, `db/`, `infra/`, `docs/` exists).
  npm workspaces or turborepo for api+admin; Flutter app scaffold only (`flutter create app`).
- `infra/docker-compose.yml`: postgres:15 + redis:7, volumes, healthchecks.
- **Transcribe DM into** `db/migrations/V1__enums.sql`, `V2__tables.sql`, `V3__indexes.sql`,
  `V4__config.sql` and `db/seed.sql` — verbatim, including the partial unique indexes, CHECK
  constraints, `set_updated_at` trigger, and the `REVOKE` on audit_logs (create app role
  `dhanam_app` in V4 and connect as it). Migration runner: `db/migrate.sh` (psql loop over
  sorted files with a `schema_migrations` table) — no heavy tooling required.
- `api/`: NestJS app; module folders per 01-architecture §3 (empty modules OK); `common` with
  ConfigService (global_settings→env→default, 60 s cache), request-id middleware, error filter
  producing the API §1.2 envelope; pg access via `pg` Pool or TypeORM **with synchronize:false**
  and raw-SQL support for the critical flows.
- `GET /health` → checks DB (`SELECT 1`) and Redis ping → `{status:"ok", db:true, redis:true}`.
- `api/openapi.yaml` seeded with conventions + /health.
- CI skeleton (TP §4 stages 1–3 wired; later slices extend).
**DoD:** `docker compose up` + `db/migrate.sh` + seed on fresh volume succeeds twice
(idempotent seed); /health green; CI runs on the repo.

## Slice 2 — Auth: OTP, JWT, refresh rotation, admin login, RBAC

**Specs:** API §2, DM §5.1–5.3, §5.13 (otp keys), TP §3-auth.
**Build:** auth module: OTP request/verify (hashing, expiry 5 min, attempt caps, rate limits
counted from otp_challenges + Redis fast-path), user auto-create on first verify, JWT issue
(claims per API §1.1), refresh rotation with reuse-detection chain revoke, admin
email+password (argon2id) login, `JwtAuthGuard`, `RolesGuard` + `@Roles()` (AUDITOR read-only
rule), `POST /me/device-tokens`. Dev OTP provider logs the code; SMS provider interface stubbed.
**DoD:** TP §3-auth tests green; RBAC matrix test covers every admin route added so far.

## Slice 3 — Admin: projects CRUD + bulk plot upload

**Specs:** API §5.1, DM §5.4–5.5, TP §3-project/plot.
**Build:** project + plot modules (admin controllers): create/patch project (compliance CHECK
honored), CSV bulk upload (multipart, streaming parse, validate-all-then-insert-all in one TX,
`?dry_run=true`, rupees→paise), plot patch for non-controlled fields. Audit rows on every
mutation. Publish/price/status endpoints DO NOT mutate yet — return `501` with code
`APPROVAL_REQUIRED_NOT_IMPLEMENTED` until slice 12 wires MC (leave TODO referencing MC §3).
**DoD:** TP §3 project/plot tests; CSV of 100 rows with 1 bad row inserts nothing.

## Slice 4 — Admin: site-map upload + polygon persistence

**Specs:** API §5.2, DM §5.6, TP §3-map.
**Build:** map module: S3 upload (common S3 client; store image_key + px dims), versioned
site_maps, `PUT geometries` full-replace with validation, `activate` with `MAP_INCOMPLETE`
guardrail in one TX. Admin panel (`admin/`): minimal Next.js app with admin login + a polygon
editor page (canvas/SVG over the map image; click-to-add vertices; per-plot assignment;
normalized coords) that drives these endpoints. Keep the editor simple — correctness of stored
geometry over UX polish.
**DoD:** TP §3-map tests; manual: upload seed image, draw 3 polygons, activate, re-activate v2.

## Slice 5 — Customer read APIs

**Specs:** API §3, CF §3.3 (lazy repair — STUB NOTE below).
**Build:** public controllers: `GET /projects`, `/projects/{id}`, `/projects/{id}/map`,
`/plots/{id}` with the exact payload shapes (price_range, plot_counts, signed S3 image URL,
effective cap, effective hold_minutes, `blocked_until`). Wire a `repairExpired(plotIds)` hook
into these reads: in this slice it's implemented for real if slice 6/7 landed; otherwise create
the booking-module method now with the real SQL from CF §3 — it simply finds no rows until
holds exist. (The transition SQL is small; implement it correctly once, here.)
**DoD:** payload snapshot tests against seed data; map endpoint hides non-PUBLISHED projects.

## Slice 6 — HOLD ENGINE (the critical slice)

**Specs:** CF §2 (follow literally), API §4-block, DM §5.7, TP §2.1 + §2.5.
**Build:** booking module `block()` exactly per CF §2 pseudocode: replay check, pre-checks,
single TX (`FOR UPDATE OF p` with status+published filter, price snapshot, frozen expires_at,
plot flip, audit), unique-violation mapping, post-commit side effects (Redis TTL key, BullMQ
expire + reminder jobs — queues defined now, processors in slice 7/10; FCM send stubbed to log).
**Do not** add optimistic-lock columns, advisory locks, Redis locks, or queue-serialization —
the row lock + partial unique index IS the design.
**DoD:** **TP §2.1 concurrency test green in CI (this is the release gate)** + TP §2.5;
manual double-block via two curl sessions.

## Slice 7 — Expiry: sweeper + TTL + lazy repair

**Specs:** CF §3 (all), TP §2.2.
**Build:** shared `expireBooking()` transition (guarded UPDATE pattern from CF §3); sweeper as
BullMQ repeatable job (60 s) with `FOR UPDATE SKIP LOCKED` batch loop; per-booking delayed job
processor calling the same transition; lazy repair verified wired into every CF §3.3-listed
read; `WORKER_MODE` split (api vs worker bootstrap). Redis TTL key already set in slice 6.
**DoD:** TP §2.2 a–e green (worker-down case is the release gate).

## Slice 8 — Payment order

**Specs:** CF §4, API §4-payment-order, TP §2.4.
**Build:** payment module: `PaymentGatewayAdapter` interface + `RazorpayAdapter`
(orders API) + `FakeGatewayAdapter` for tests; `createPaymentOrder()` per CF §4.2 (lazy repair
first, ownership, status, replay, integer cap math, gateway-then-DB ordering).
**DoD:** TP §2.4 green (cap boundary ±1 paise); replay + conflict tests.

## Slice 9 — PAYMENT WEBHOOK (the other critical slice)

**Specs:** CF §5 (follow the 9 steps literally), API §6, TP §2.3.
**Build:** raw-body route registration for the webhook path only; signature verification via
adapter; webhook_events insert-first dedup; the captured/failed/mismatch/late-capture branches
each per CF §5.7–5.8; receipt sequence `DHN-YYYY-NNNNNN` (Postgres sequence); post-commit job
cancellation + notifications; FINANCE alert = notification row + log (email later).
**DoD:** TP §2.3 a–h green (idempotency and no-client-confirm are release gates). Manual:
Razorpay test-mode end-to-end once if keys are available; otherwise FakeGateway walkthrough
documented in PR.

## Slice 10 — Customer dashboards + notifications

**Specs:** API §4 (`GET /bookings/{id}`, `/me/bookings`), CF §6, TP §3-notification.
**Build:** booking read endpoints (poll-ready, lazy repair), FCM sender (real), SMS sender
behind interface (DLT template ids in config), reminder processors (re-check state before send,
job-id dedup), all templates from CF §6 recorded in `notifications`. Flutter app: wire the
booking flow screens (browse → map → plot sheet → block → countdown → checkout →
processing/poll → confirmed) against the API — functional, not polished.
**DoD:** reminder skip-if-paid test; poll flow works against local stack.

## Slice 11 — Admin dashboards

**Specs:** API §5.6, TP §3-dashboards.
**Build:** three aggregate endpoints (SQL aggregates; run lazy repair for the projects being
summarized before counting) + Next.js pages: inventory grid (per-project status counts),
bookings board (active holds with countdown, recent confirmations/expiries), payments view
(collections, MANUAL_REVIEW queue with webhook evidence from API §5.3).
**DoD:** scripted-scenario consistency test (TP §3-dashboards).

## Slice 12 — Maker-checker

**Specs:** MC (whole doc), API §5.4, DM §5.10, TP §2.6.
**Build:** approval module: generic request/approve/reject/withdraw service, handler registry,
all **10 handlers** with their guardrails + apply() per MC §3 (this also replaces the slice-3
`501` stubs for publish/price/status); approvals endpoints incl. live guardrail re-check in the
detail GET; Next.js Approvals Inbox + Review Detail per MC §4 (diff panel, guardrail panel,
role-aware buttons).
**DoD:** TP §2.6 green (self-approval DB CHECK test is the release gate); each of the 10
actions has at least request→approve→applied and request→reject tests.

## Slice 13 — Reconciliation

**Specs:** CF §7, DM §5.12, TP §3-reconciliation.
**Build:** adapter `listPayments(from,to)` (Razorpay payments API) + CSV fallback admin upload;
nightly BullMQ cron (02:00 IST = 20:30 UTC); matching passes + item statuses + MANUAL_REVIEW
side effects; idempotent rerun; FINANCE summary notification; dashboard tile (slice 11 page)
shows last run.
**DoD:** TP §3-reconciliation matrix green.

## Slice 14 — Hardening

**Specs:** TP §4–5, 01-architecture §5-observability.
**Build:** pino structured logging with request_id everywhere; OTel traces (HTTP + pg + bullmq);
Prometheus `/metrics` + the four alerts from 01-arch §5; global rate limiter; helmet/CORS
config; backup script + documented restore drill; k6 load scripts (TP §5) + chaos runbook;
dependency/secret scan in CI; final OpenAPI-vs-routes parity check turned on as CI stage 5.
**DoD:** load, restore, and chaos drills executed with results recorded in `docs/drills/`;
security checklist in PR.

---

## Appendix A — When you're blocked

| Situation | Do this |
|---|---|
| Two docs disagree | Precedence: DM (schema) > CF (behavior) > API (wire) — HANDOVER §2. Fix the loser in your PR. |
| Spec is silent on a detail | Choose the smallest implementation consistent with the Invariants; `// SPEC-QUESTION:` comment + PR note. |
| A test in TP contradicts an Invariant | The Invariant wins; flag the test in the PR. |
| Need a new table/column | New `V<n>__` migration + update DM doc in the same PR. |
| Tempted to add a library for a critical flow (locks, queues-for-holds, saga frameworks) | Don't. The critical flows are deliberately plain SQL + one queue. |
