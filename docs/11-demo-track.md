# 11 — Demo Track (compressed build order for the management demo)

**Goal:** a working, presentable product in one pass. One golden path must be flawless:

> Customer (phone view) browses **Gem Meadows** → taps a plot on the site map → **Reserve** →
> email OTP (demo mode shows the code) → "Awaiting approval" → **Admin portal** bell rings →
> Approvals inbox → **Approve** → customer's screen flips to **Reserved** → admin shows off
> dashboard, outbox ("sent" emails), audit trail.

This document compresses docs/09 P1–P5 into four demo slices **D1–D4**. Specs referenced
(08/09/10) remain authoritative for *how*; this document only decides *what's in and out*.
Session protocol (docs/07 §0) applies: suite green before every commit; push after commit.

## Shortcuts ledger (deliberately half-baked — deferred, not forgotten)

| Deferred | Where it returns |
|---|---|
| Polygon map editor UI (seed data already has geometries) | P6 |
| Playwright e2e suites | P4/P5 DoDs post-demo |
| SMTP sending (console driver + outbox viewer IS the demo story) | env flip when creds exist |
| Maker-checker actions other than RESERVE_PLOT | P7 |
| Reconciliation, hardening, PWA icons polish, Tamil strings | P7/P8 |
| Admin settings write / project publish flow via MC | P7 (seed project is already PUBLISHED) |

## D1 — Email service + email-OTP auth (backend) — was P1
Full P1 per docs/09: EmailService + outbox + Console/Smtp drivers (nodemailer OK),
**V5__email_identity.sql** (new file — V1–V4 are immutable now): users.email backfill→NOT NULL,
drop `customer_has_phone`, otp_challenges phone→email + `purpose` + `booking_id`, index swap.
Auth by email, PATCH /me, `dev_otp` double-gate (Invariant 12), login_otp email via the service.
Seed customer gains `customer@demo.gemhousing.in`. Tests rewritten for email + outbox
assertions + prod-hides-dev_otp.

## D2 — Reserve flow (backend, the critical slice) — was P2 (+feed writes)
Full P2 per docs/09 (amended): `POST /plots/{id}/reserve` (same TX shape as the proven block
engine; hold-limit counts PENDING_CONFIRMATION+PENDING_APPROVAL), `POST /reservations/{id}/confirm`,
`POST /reservations/{id}/resend-otp`, minimal `NotificationFeedService.feed()` (row insert —
endpoints come in D3) wired to every transition, approvals service + endpoints with the
**RESERVE_PLOT** handler (guardrails re-run at decision; maker≠checker), expiry rework
(two-phase windows, ON_HOLD→AVAILABLE, auto-WITHDRAW pending approvals), payments dormancy
(`PAYMENTS_ENABLED` conditional mount; payment/webhook tests on SQL fixtures; OpenAPI drops
those paths; parity runs flag-off). All emails per 08 §6 templates.
**Gates: TP-P 1, 2, 3, 7 (08 §13) rewritten and green.**

## D3 — Visibility + storage + demo seed (backend) — was P3-lite
Notifications endpoints (feed/count/read/read-all + `/me/notifications`), `GET /admin/emails`,
`GET /admin/bookings`, `GET /admin/audit-logs`, `GET /admin/settings` (RO),
`GET /admin/dashboard/summary` (10 §5.3.3), NEW_CUSTOMER/MAP_ACTIVATED/PLOTS_IMPORTED events,
`GET /projects/{idOrSlug}` (10 §5.3.1). **LocalDiskDriver** (STORAGE_MODE=local, UPLOADS_DIR)
+ static `GET /files/*`; `signedGetUrl` → `/api/files/{key}`.
**Demo seed:** expand Gem Meadows to **12 plots** (P-01…P-03 rows byte-identical — tests pin
them; P-04…P-12 new, varied sizes/prices, polygons in a tidy two-row layout) + a checked-in
site-plan **SVG** `db/assets/gem-meadows-v1.svg` (2000×1400) whose drawn plots align exactly
with the seeded polygons (roads, park, compass — make it look like a real layout plan);
seed `image_key='seed/gem-meadows-v1.svg'`; `scripts/demo-reset.sh` = drop/create → migrate →
seed → copy asset into uploads.

## D4 — Web app, both faces (frontend) — was P4+P5 core
Everything in **docs/10** EXCEPT §8.5 (polygon editor) and §14 Playwright. Customer face
complete (§7: home, login, project+PlotMap, plot sheet, reserve journey, /me) and admin face
core (§8.1–8.4 login/dashboard/inbox/review-detail, §8.6 notifications+emails+audit, §8.7
bell). `web/` joins the npm workspaces; Next on 3001 proxying `/api` → 3000. Every screen has
loading/empty/error states per 10 §11. Verify by building + booting + walking the golden path.

## Definition of DEMO-DONE (checked at the end, before the runbook is written)
1. `scripts/demo-reset.sh` → pristine demo data in one command.
2. API + web boot; the golden path completes in a real browser, phone-width.
3. Admin bell/badge updates within 30 s of a customer confirming; approve flips the customer
   screen (3 s poll) without reload.
4. Outbox viewer shows every email the flow generated; audit page shows the trail.
5. Full backend suite green; `DEMO.md` runbook at repo root tells the presenter exactly what
   to click, with credentials.
