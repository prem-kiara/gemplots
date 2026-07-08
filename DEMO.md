# Gem Plots — Demo Runbook

A complete walkthrough for presenting the platform. Total demo time: ~5 minutes.
Everything runs locally; no internet, no payment gateway, no SMS — email is simulated through
an in-portal outbox (that's a feature of the demo story, not a gap: "here's the mail the
customer received").

## 1. Start the stack (2 terminals, repo root)

```bash
# One-time / to reset to pristine demo data (safe to run before every demo):
bash scripts/demo-reset.sh

# Terminal 1 — API (port 3000):
cd api && npm run build && node dist/main.js

# Terminal 2 — Web (port 3001):
npm --workspace web run dev
```

Open http://localhost:3001 — **in a phone-sized browser window** (or DevTools device mode,
375px) for the customer part. Health check: http://localhost:3000/health → `{"status":"ok"}`.

## 2. Credentials

| Who | Login | Password |
|---|---|---|
| Customer | `customer@demo.gemhousing.in` (any email works — signup is automatic) | — (email OTP; **the code appears on screen** in demo mode) |
| Admin (approver) | `ops@gemhousing.in` at http://localhost:3001/admin | `GemHousing@Dev1` |
| Other admins | `super@` / `sales@` / `finance@` / `auditor@gemhousing.in` | `GemHousing@Dev1` |

## 3. The golden path (the demo script)

**Act 1 — Customer, on the phone (http://localhost:3001):**
1. Home shows **Gem Meadows** — RERA badge, price range, "12 plots · available".
2. Tap it → the **interactive site map** (12 plots, color-coded by status). Pinch/scroll to
   zoom, drag to pan. Point out the legend. Toggle **List** view to show the accessible
   alternative.
3. Tap any green (Available) plot → bottom sheet: area, facing, dimensions, price in
   ₹ lakh format → **Reserve this plot**.
4. Login prompt: enter any email → the OTP appears in the amber **DEV MODE** banner (tell
   management: "in production this arrives by email/SMS — one config flip") → tap to fill →
   logged in.
5. Reserve → the **reservation journey** screen: 4-step progress. Step 2 asks for a second
   OTP ("verify it's really you") — again shown on screen → confirm.
6. Screen moves to **"Gem Housing review"** with a live countdown. Leave this screen OPEN —
   it updates by itself in Act 3.

**Act 2 — Admin portal (desktop window, http://localhost:3001/admin):**
7. Login as `ops@gemhousing.in`. The **bell** already shows unread notifications; the
   sidebar **Inbox badge** shows 1 pending.
8. **Dashboard**: pending approvals, live holds with countdowns, inventory bar.
9. **Inbox** → the reservation request. Open it: customer contact, **"email verified ✓"**,
   plot facts, the **guardrails panel** (all green checks — "the system re-validates before
   any decision"). Note: the requester can never approve their own request — maker-checker
   is enforced in the database itself.
10. **Approve** (add a note if you like).

**Act 3 — the payoff:**
11. Switch back to the phone window: within ~3 seconds the customer's screen flips to
    **Reserved** ✅ — no reload. ("Customer gets an email confirmation too.")
12. Back in admin: **Emails** page — show the outbox: the OTP mails, the admin alert, the
    approval confirmation. **Notifications** — the full activity feed. **Audit** (login as
    `super@gemhousing.in` or `auditor@`) — every action recorded, tamper-proof at the
    database level.

**Optional flourishes:**
- Reject path: reserve another plot with a second email, reject it with a note → customer
  sees "Not approved".
- Scarcity story: while a plot is mid-reservation, show it amber ("On hold") for other
  browsers — first-come-first-served is enforced by the database, 50 simultaneous clicks
  produce exactly one winner (that's a tested guarantee, not a hope).

## 4. Talking points (what's real under the hood)

- **Inventory truth is bank-grade**: row locks + a unique index mean a plot can never be
  double-reserved, verified by a 50-way concurrency test in CI.
- **Every deadline self-heals**: unconfirmed requests auto-release after 30 min, undecided
  ones after 48 h (both configurable) — even if background workers are down.
- **Maker-checker everywhere**: no reservation exists without a human approval; approver ≠
  requester is a database constraint.
- **Full audit trail**: append-only at the DB permission level — the app literally cannot
  edit or delete audit rows.
- **Integration-ready, not integration-dependent**: email → SMTP is an env flip; payments
  (Razorpay, RERA-capped advances, signature-verified webhooks) are already built and tested,
  parked behind a feature flag.
- 60 automated backend tests, all green, run in CI on every push.

## 5. If something goes wrong mid-demo

- Reset everything: `bash scripts/demo-reset.sh` (5 seconds), refresh both windows, log in again.
- Customer stuck mid-OTP? Use **Resend code** — a fresh code appears in the banner.
- The plot you wanted is "On hold" from a previous run? That's the auto-expiry story — or
  just reset.
