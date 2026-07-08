# 09 — Build Instructions v2 (Gem Housing pivot)

For the implementing agent (Opus). Supersedes the *build order* in docs/07; the **session
protocol in docs/07 §0 still applies verbatim** (one slice per session, read-first, invariants
override everything, tests+OpenAPI in the DoD, verify like an operator). Spec authority for this
phase: [docs/08-gemhousing-pivot.md](08-gemhousing-pivot.md) — where 08 conflicts with 01–07,
08 wins.

The v1 backend (slices 1–9) is the foundation — the hold engine, expiry machinery, approvals
schema, and audit regime carry over. You are re-pointing them from “pay to confirm” to
“admin approves to confirm,” adding email/notifications/storage workarounds, and building the
web frontend.

---

## Slice P0 — Fix-list + rebrand + first commit

**Specs:** 08 §3–§4 (rebrand, migrations), the fix-list below.

Fixes from the architecture review (each needs a regression test where marked):

| # | Fix | Detail |
|---|---|---|
| F1 | **Repo + CI** | `git init`; fix CI: workspaces hoist the lockfile to the **repo root** (`api/package-lock.json` does not exist) — run `npm ci` at root, set `cache-dependency-path: package-lock.json`, run workspace scripts via `npm --workspace api …`. First commit lands at the END of this slice. |
| F2 | **`plots:bulk` route** | Express 4 parses `:bulk` as a param → route matches `/plotsANYTHING`. Rename to `POST /admin/projects/:id/plots/bulk`; update OpenAPI. *(test)* |
| F3 | **Replay must return 200** | `req.res.status(200)` is overridden by `@HttpCode(201)` at send time. Use `@Res({passthrough: true})` and set the status explicitly on the replay branch. *(test asserts 201 first call, 200 + `Idempotency-Replay: true` on replay)* |
| F4 | **Hold-limit race** | The `max_active_holds` count runs outside the TX. Inside the TX, take `SELECT id FROM users WHERE id=$1 FOR UPDATE` as a per-user serialization point, then re-count active holds before inserting. *(test: parallel reserves on different plots by one user never exceed the limit)* |
| F5 | **Fail-fast secrets** | If `NODE_ENV=production` and `JWT_SECRET`/`OTP_PEPPER` are unset or equal to the dev defaults → refuse to boot. |
| F6 | **Redis reconnect** | Replace `retryStrategy: () => null` with capped exponential backoff; keep all errors swallowed (Redis stays UX-only). |
| F7 | **Config consistency** | `catalog-read.service.ts getProject` queries `global_settings` directly — route it through `ConfigService`. |

**Rebrand** per 08 §3: rewrite migrations in place (one-time pre-commit exception — after this
slice’s commit, never again), `gemplots`/`gemplots_test` DBs, `gemplots_app` role, Gem Meadows
seed, all Dhanam strings gone (grep gate: `grep -ri dhanam` returns nothing outside docs
history notes), `.env.example` per 08 §3, receipt prefix `GEM-`.

**DoD:** fresh `gemplots_test` migrates+seeds; full existing suite green; parity green; CI
workflow valid (run `act` or dry-review); `git log` shows the initial commit; BUILD_STATUS.md
refreshed.

## Slice P1 — Email service + email-OTP auth

**Specs:** 08 §6, §9; DM §5.2 as amended by 08 §4.
Build `EmailService` + `emails_outbox` + Console/Smtp drivers; convert `otp_challenges` to
email+purpose; auth endpoints take `email`; find-or-create by email; `PATCH /me`; login OTP
emails through the service; `dev_otp` double-gate (Invariant 12).
**DoD:** auth spec rewritten for email (all previous cases: rate limits, attempts, rotation,
reuse-chain, RBAC) + outbox rows asserted + TP-P §4 gate (prod hides `dev_otp`).

## Slice P2 — Reserve flow (the critical slice)

**Specs:** 08 §5 (follow literally), §10; MC §2 registry.
Schema per 08 §4 (enums, bookings, approvals action, settings). `reserve` endpoint reusing the
CF §2 transaction shape (F3/F4 fixes live here); `confirm` endpoint; `RESERVE_PLOT` approval
handler (guardrails + approve/reject apply); expiry rework (two-phase windows + approval
auto-withdraw); payments dormancy: conditional module mount, spec paths removed, payment tests
converted to SQL fixtures.
**DoD:** **TP-P gates 1, 2, 3, 7 green** — these are the release gates. Manual walkthrough via
curl: reserve → confirm (OTP from outbox/log) → approve as ops admin → booking RESERVED.

## Slice P3 — Notifications + admin read surface

**Specs:** 08 §7; API §5.3/5.5/5.7 (bookings list, audit-logs, settings-RO).
`portal_notifications` + endpoints + `feed()` wired into every §5 transition and MC decisions +
`NEW_CUSTOMER`/`MAP_ACTIVATED`/`PLOTS_IMPORTED`; outbox viewer endpoint; `GET /admin/bookings`.
**DoD:** TP-P §5 (event per transition, count endpoint); catalog gates TP-P §6 (the overdue
CSV/geometry/activation tests) if not already landed in P0.

## Slice P4 — Web app: customer journey (mobile-first)

**Specs:** 08 §12.
Next.js scaffold (`web/`), same-origin `/api` proxy, PWA manifest; login (email OTP with
demo-mode banner), project list, project detail with the interactive SVG-overlay map, plot
bottom sheet, reserve → confirm screen (countdown, polls booking), `/me` reservations +
profile form.
**DoD:** scripted browser walkthrough on a 375-px viewport of the full journey against the
local stack (document it in the PR with screenshots); Lighthouse mobile usability sanity pass.

## Slice P5 — Web app: admin portal core

**Specs:** 08 §7, §12; MC §4 screen layouts.
Admin login, layout with notification bell (30 s poll), Approvals Inbox + Review Detail
(guardrail panel, approve/reject with note), dashboard-lite cards (pending approvals, active
holds with time-left, inventory by status), notifications feed page, emails outbox viewer.
**DoD:** end-to-end through the browser: customer reserves+confirms (P4 UI) → bell rings →
approve in inbox → customer sees RESERVED. Reject path too.

## Slice P6 — Web app: admin catalog management

**Specs:** 08 §8, §12; API §5.1–5.2.
Local-disk `StorageDriver` (+ `/files/*` static route) replacing the S3 no-op; projects CRUD
UI; CSV plot upload UI (dry-run preview → commit); the polygon map editor; activation flow
surfacing `MAP_INCOMPLETE`.
**DoD:** create a new project through the UI alone: upload map → draw 3 polygons → activate →
appears on the customer map; image survives an API restart (actually on disk).

## Slice P7 — Remaining maker-checker actions

**Specs:** MC §3 (10 actions; `INITIATE_REFUND` + `RESOLVE_MANUAL_REVIEW` stay dormant with
payments), MC §5 tests.
Handlers for the 8 active actions incl. EXTEND_HOLD (the one sanctioned deadline move) and
UPDATE_GLOBAL_SETTING; settings UI; TP §2.6 test set (self-approval, guardrail drift,
double-request, apply atomicity).
**DoD:** MC §5 tests green; each action exercised request→approve and request→reject.

## Slice P8 — Hardening-lite + deploy

**Specs:** TP §4–5 scaled down; 08 §12 deployment sketch.
Structured request logging with request-id, global rate limiter, backup script + restore note,
Caddy/nginx config for plots.gemhousing.in (`/` → Next, `/api` → Nest), PWA polish, admin
deadline-reminder email (T-6h before `admin_decision_hours` lapses), final `grep -ri dhanam`
sweep, BUILD_STATUS refresh.
**DoD:** full CI sequence green from a fresh clone; documented single-host deploy runbook.

---

## Blocked? (extends docs/07 Appendix A)

| Situation | Do this |
|---|---|
| 08 conflicts with 01–07 | 08 wins; fix the older doc in the same PR. |
| A dormant-payment test fights the new enums/flows | Convert it to SQL fixtures (08 §10); never delete it. |
| Tempted to sniff user-agents for the mobile view | Don’t — responsive CSS only (08 §12). |
| An email “must” be sent but there’s no driver | There is: the Console driver + outbox IS the send path in demo mode. Never bypass the outbox. |
