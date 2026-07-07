# 06 — Test Plan & CI Gates

Testing authority. §2 tests are **release-gating**: CI blocks merge on failure. Integration
tests run against real Postgres + Redis (docker-compose in CI, no mocks for the DB — the
invariants live in the DB).

## 1. Harness

- Runner: Jest (+ supertest against the Nest app).
- Each integration test file gets a fresh schema: apply `db/migrations/*` + `seed.sql` into a
  per-worker database (template-database trick for speed).
- Gateway: `FakeGatewayAdapter` implementing `PaymentGatewayAdapter` — records orders, and a
  test helper `deliverWebhook(event, {signWith})` posts signed/mis-signed payloads to the real
  webhook route.
- Clock: hold/expiry tests use short holds via `global_settings.global_hold_minutes` override or
  direct `expires_at` manipulation — never `sleep()` longer than 2 s.

## 2. Release-gating tests

### 2.1 Concurrency — one winner per plot (Invariants 2, 3)
`N = 50` concurrent `POST /plots/{id}/block` (distinct users, distinct keys) on one AVAILABLE
plot. Assert: exactly one `201`; all others `409 PLOT_UNAVAILABLE`
(`HOLD_LIMIT_EXCEEDED` not acceptable here — use 50 distinct users); exactly 1 bookings row for
the plot; plot BLOCKED; exactly 1 audit `booking.block` row.
Repeat with N=50 **same user, same idempotency key**: one `201` + replays `200` with identical
booking_id, still exactly 1 booking row.

### 2.2 Expiry — three defenses (Invariants 5, 6)
a. **Sweeper**: block with 1-min hold → run sweeper past expiry → booking EXPIRED, plot
   AVAILABLE, audit row, reminder jobs cancelled.
b. **Worker down**: block, kill/skip workers, advance past expiry → `GET /plots/{id}` returns
   AVAILABLE (lazy repair) and booking is EXPIRED. Same via `GET /projects/{id}/map`.
c. **Frozen expires_at**: block → change `global_hold_minutes` → assert booking's `expires_at`
   unchanged; new blocks get the new duration.
d. **Race**: sweeper and lazy repair fired concurrently on the same due booking → exactly one
   EXPIRED transition, one audit row, no error.
e. **Paid at the buzzer**: booking due but not yet expired-by-anyone; deliver captured webhook →
   BOOKED wins (CF §5.7b); subsequent sweeper run does not touch it.

### 2.3 Webhook — verification & idempotency (Invariants 4, 7)
a. Valid captured webhook → payment SUCCESS, booking BOOKED, plot BOOKED, receipt issued, all
   in one TX (assert no intermediate state visible on concurrent read).
b. Same event delivered twice (same event_id) → second returns 200, zero additional state
   change, webhook_events has one row.
c. Same payment, different event_id (gateway re-notify) → deduped on gateway_payment_id, no
   double transition.
d. **Bad signature** → 400, no state change, webhook_events row with
   `signature_valid=false` (best-effort).
e. **Amount mismatch** (paid ≠ order amount) → payment + booking → MANUAL_REVIEW, plot still
   held, FINANCE alert recorded.
f. `payment.failed` → payment FAILED, booking still BLOCKED, customer can create a new
   payment order.
g. Late capture (booking already EXPIRED) → MANUAL_REVIEW path, never auto-BOOKED.
h. Client callback alone (poll with no webhook) → booking remains BLOCKED forever until expiry:
   assert **no** code path from `GET /bookings/{id}` mutates toward BOOKED.

### 2.4 RERA cap (Invariant 8)
Project rera_registered, cap 10%: order at exactly `floor(total*10/100)` → 201; +1 paise →
`400 ADVANCE_EXCEEDS_CAP`. Project cap set to 15 + rera_registered → effective cap still 10%.
Below `min_advance_paise` → `400 ADVANCE_BELOW_MIN`. Cap math uses integers (test odd totals,
e.g. total 999999 paise → cap 99999).

### 2.5 Hold limit & idempotency conflicts
User with `max_active_holds` BLOCKED holds → next block `409 HOLD_LIMIT_EXCEEDED`; after one
expires → block succeeds. Same key reused for a different plot → `409 IDEMPOTENCY_CONFLICT`.
Payment-order replay: same key → same order (200); same key different amount → 409.

### 2.6 Maker-checker (Invariant 9) — the four tests in MC §5.

### 2.7 Audit immutability (Invariant 10)
As the app DB role: `UPDATE audit_logs …` and `DELETE FROM audit_logs …` both raise
`insufficient_privilege`. Block/webhook/approval flows each produce their expected audit rows
(count + action names asserted).

## 3. Per-module functional tests (non-gating but required per slice DoD)

- **auth**: OTP send/verify happy path; rate limits (3/15min, attempts=5); refresh rotation +
  reuse detection revokes chain; RBAC matrix (each admin endpoint × each role → allow/deny);
  AUDITOR write-deny.
- **project/plot**: CSV bulk upload all-or-nothing (1 bad row of 100 → 0 inserted, row errors
  reported); rupees→paise conversion; duplicate plot_number rejected; unpublished project
  invisible to customer APIs.
- **map**: geometry validation (out-of-range coords, <3 points, foreign plot_id); activation
  guardrail `MAP_INCOMPLETE`; exactly one active map (unique index).
- **booking read**: `blocked_until` surfaces on BLOCKED plots; `/me/bookings` pagination.
- **notification**: reminder jobs skip if paid/cancelled; job-id dedup (re-enqueue same
  reminder → single send).
- **reconciliation**: MATCHED / AMOUNT_MISMATCH / UNKNOWN_PAYMENT / MISSING_AT_GATEWAY each
  produce the right item + MANUAL_REVIEW side effects; rerun same date is idempotent.
- **admin dashboards**: counts agree with direct SQL after a scripted scenario (block, pay,
  expire ×N).

## 4. CI pipeline (infra/ci)

Stages, all required: 1) lint + typecheck; 2) migrations on fresh Postgres + seed;
3) unit tests; 4) integration tests (§2 gates + §3); 5) OpenAPI: spec validates
(`spectral`/`swagger-cli`) AND route parity check (script compares Nest route map vs spec paths —
fail on drift); 6) build artifacts (api image, admin build).

## 5. Hardening drills (slice 14, manual but scripted)

- **Load**: k6 — 200 rps browse, 50 concurrent blocks on 20 plots, sustained 10 min: p95 block
  < 400 ms, zero double-holds (post-run SQL assert on uniq index candidates).
- **Restore drill**: nightly backup → restore to scratch instance → row counts + latest audit id
  match within RPO (15 min). RTO target 60 min, timed.
- **Chaos**: kill Redis mid-flow (blocks/webhooks unaffected, countdown degrades); kill worker
  for 2 h (lazy repair holds the line; sweeper catches up on restart — no double transitions).
- **Security**: dependency audit, secret scan, OWASP top-10 pass over auth/webhook/upload
  endpoints, DPDP PII access review (who can read phone numbers).
