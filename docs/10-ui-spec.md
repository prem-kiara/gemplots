# 10 — UI Specification (web/)

**Authority:** this document is the UI spec for slices P4–P6. It elaborates 08 §12; where they
differ on UI detail, this document wins. Backend behavior stays governed by 08.

The implementing agent builds exactly what is specified here — screens, components, states,
copy tone. Visual polish beyond this spec is welcome only where it doesn't add dependencies or
change flows.

## 1. Locked stack

| Area | Decision |
|---|---|
| Framework | Next.js 14+ (App Router, TypeScript), single app in `web/` |
| Styling | **Tailwind CSS** with the §3 tokens declared in the Tailwind theme. No component library (MUI/AntD/shadcn) — the §6 inventory is hand-rolled. |
| Data | **TanStack Query v5** + one thin typed API client (§5). No Redux/Zustand. |
| Forms | Plain controlled components. No form library (all forms here are ≤4 fields). |
| Font | Inter via `next/font` (bundled locally, no runtime fetch). System-stack fallback. |
| Icons | Inline SVG only (a single `icons.tsx`); no icon package. |
| Rendering | **All pages are client components** (`'use client'`) rendered inside the App Router. SSR/SEO is a later enhancement — do not mix server components now; it is the least-failure path. |
| Dev ports | Next on **3001**, Nest on 3000. `next.config` rewrites `/api/:path*` → `http://localhost:3000/:path*` (same-origin in prod via reverse proxy too). Client base URL is always `/api`. |
| Tests | Playwright smoke (§14). No unit tests for components in Phase 1. |

## 2. The two faces

- **Customer** (`/`, mobile-first, PWA): browse projects → map → reserve → confirm → track.
  Designed at 375 px; must remain usable at desktop widths (max-w-md centered column is fine).
- **Admin** (`/admin/**`, desktop-first, responsive down to tablet): approvals inbox is the
  heart; plus catalog management, notifications, outbox, audit.

## 3. Design language

### 3.1 Color tokens (Tailwind theme + CSS variables)
```
--gp-primary:      #047857  (emerald-700 — "Gem" green; buttons, links, active nav)
--gp-primary-dark: #065f46  (hover)
--gp-accent:       #d97706  (amber-600 — countdowns, dev-mode banners, warnings)
--gp-ink:          #111827  --gp-muted: #6b7280  --gp-line: #e5e7eb  --gp-bg: #f9fafb
--gp-danger:       #dc2626  --gp-info: #2563eb
Plot-status palette (map fills at 55% opacity, 1.5px solid stroke; chips solid):
  AVAILABLE #16a34a • ON_HOLD #f59e0b • RESERVED #2563eb • SOLD #6b7280 • WITHDRAWN (not rendered)
  (dormant BLOCKED/BOOKED, if ever seen, render as ON_HOLD/RESERVED respectively)
```

### 3.2 Type & shape
Inter. Scale: 24/20/17/15/13 px, weights 600 for headings, 400 body. Radius: 12 px cards/sheets,
8 px inputs/buttons. Shadows: one soft elevation for cards (`0 1px 3px rgb(0 0 0 / .08)`), one
for sheets/modals. Spacing on the 4-px grid; screen gutter 16 px mobile, 24 px desktop.

### 3.3 Brand mark
No binary assets exist. `Logo` component = inline SVG diamond (a simple faceted rhombus in
`--gp-primary`) + wordmark **Gem Plots** (Inter 600); subtitle "by Gem Housing" where space
allows. Same SVG becomes the PWA/favicon icon (Opus generates the sized PNGs from it).

### 3.4 Formatting utilities (`web/lib/format.ts`)
- `formatINR(paise)`: Indian grouping, no decimals — `180000000` → `₹18,00,000`.
- `formatIST(iso)`: `d MMM yyyy, h:mm a` in Asia/Kolkata (Intl API; no date library).
- `timeLeft(expiresAt)`: `47h 12m` / `28m 10s` (used by Countdown, ticks 1 s).

## 4. Shells & navigation

**Customer shell:** sticky top bar (Logo left; login/avatar right) + **bottom tab bar** on
mobile (Home ▸ `/`, My Plots ▸ `/me`) with safe-area padding. Content column `max-w-md mx-auto`.
When `EMAIL_MODE` demo data is present (any response carries `dev_otp`), show the persistent
amber **DEV MODE** ribbon (§7.2).

**Admin shell** (`/admin/**` layout): left sidebar (collapsible to icons <1024 px) — Home,
Inbox (with pending-count badge), Projects, Notifications, Emails, Audit; top bar with **Bell**
(unread count, §8.7) and admin name/role + logout. Non-admin JWT or no session → redirect
`/admin` (login).

**Route guards** (client-side, in each shell layout): decode the JWT role from the access
token. Customer-protected routes: `/me`, `/reserve/**` (browse is public; tapping Reserve while
logged out → `/login?next=<current>`). Admin routes require an admin role.

## 5. Data layer

### 5.1 API client (`web/lib/api.ts`)
- `api<T>(path, {method, body, headers})` → fetch `/api${path}`, JSON in/out.
- Error envelope is uniform: non-2xx → throw `ApiError {status, code, message, details}` parsed
  from `{error:{code,message,details}}`.
- **Token lifecycle:** access token in module memory; refresh token in
  `localStorage['gp.refresh']`; login response `user` in `localStorage['gp.user']`.
  On boot: if refresh exists → `POST /v1/auth/refresh` (rotates; store both). On any 401
  `TOKEN_EXPIRED`: refresh once, retry once; refresh failure → clear session, redirect to the
  face's login. (localStorage tradeoff accepted per 08 §12.)
- `Idempotency-Key`: generated `crypto.randomUUID()` per user *intent* — created when the
  Reserve button is tapped, reused across retries of that tap, discarded on success.

### 5.2 Query conventions (TanStack)
Keys: `['projects']`, `['project', idOrSlug]`, `['map', projectId]`, `['booking', id]`,
`['me','bookings']`, `['admin','approvals',filters]`, `['admin','approval',id]`,
`['admin','notifications','count']`, `['admin','notifications']`, `['admin','emails']`,
`['admin','audit',filters]`, `['admin','summary']`.
Polling: booking detail `refetchInterval` **3 s** while status is `PENDING_CONFIRMATION`/
`PENDING_APPROVAL`, else off • map **30 s** while mounted + on window focus • bell count
**30 s** • approvals inbox **60 s**. Mutations invalidate the obvious keys.

### 5.3 API additions the UI requires (backend touch-ups, slotted into slices — see §15)
1. **`GET /v1/projects/{idOrSlug}`** — detail endpoint accepts a UUID **or** a slug (UUID
   regex → id lookup, else slug). Customer routes are slug-based. *(lands in P4, tiny)*
2. **`POST /v1/reservations/{id}/resend-otp`** — owner-only, re-issues the RESERVE-purpose OTP
   (same rate limits; response `{challenge_id, retry_after_seconds, dev_otp?}`). Without it, a
   customer who closes the browser mid-confirmation is stranded. *(lands in P2 with the flow)*
3. **`GET /v1/admin/dashboard/summary`** — one call:
   `{approvals_pending, active_holds:[{booking_id, plot_number, project_name, customer_email, status, expires_at}], plots_by_status:{...}, recent_notifications:[...5]}`. *(lands in P3)*

## 6. Shared component inventory (`web/components/`)

| Component | Behavior |
|---|---|
| `Button` | primary / secondary / danger / ghost; `loading` prop shows inline spinner and disables. |
| `Input`, `TextArea` | label, error string, helper text; error border `--gp-danger`. |
| `OtpInput` | 6 boxes, auto-advance, paste-splits, backspace-retreats; `onComplete(code)`. |
| `BottomSheet` | mobile modal sheet (drag handle, backdrop tap closes); renders as centered modal ≥768 px. |
| `StatusChip` | booking/plot status → label + color per §9. |
| `Countdown` | from ISO `expires_at`; ticks 1 s; turns `--gp-accent` under 1 h, `--gp-danger` under 10 min; fires `onExpire` once. |
| `Card`, `Skeleton`, `EmptyState` | EmptyState = icon + one-liner + optional CTA. |
| `Toast` | top center (mobile) / bottom right (admin); auto-dismiss 4 s; `toast.success/error(msg)`; every caught `ApiError` not handled inline goes here as `error.message`. |
| `Stepper` | horizontal 4-step progress for the reservation journey. |
| `DataTable` | admin: header, rows, cursor "Load more", per-column truncation; no sorting Phase 1. |
| `ConfirmDialog` | for destructive/irreversible admin actions (reject, activate map). |
| `DevOtpBanner` | amber ribbon: "DEV MODE — OTP for {email}: **123456** (tap to fill)". Rendered only when a `dev_otp` value is present in a response; never invents one. |
| `Bell` | topbar icon + unread badge; click → dropdown of latest 5 + "View all". |
| `PlotMap` | §7.4 viewer. |
| `PolygonEditor` | §8.5 editor. |

## 7. Customer screens

### 7.1 `/` — Home (public)
Top bar + search-less list (Phase 1: few projects). Each `ProjectCard`: name, district/state,
RERA badge (shield icon + number if `rera_registered`), price range (`formatINR` min–max),
`{available}/{total} plots available`, cover image (or diamond-pattern placeholder div — no
external images). Tap → `/p/[slug]`. States: skeleton ×3 while loading; EmptyState "New
projects coming soon"; error toast + retry button.

### 7.2 `/login` — Email OTP (two stages, one route)
Stage 1: email input → `POST /v1/auth/otp/request {email}` → stage 2. Stage 2: OtpInput +
"Resend" (disabled `retry_after_seconds`, shows countdown) + edit-email link →
`POST /v1/auth/otp/verify` → store session → redirect `?next` or `/me`.
Errors inline: `OTP_INVALID` ("Wrong code, try again"), `OTP_EXPIRED` (offer resend),
`OTP_RATE_LIMITED` (show wait). If the request response carries `dev_otp` → DevOtpBanner.
First-login nicety: if `user.full_name` is empty, `/me` shows the profile prompt (§7.6).

### 7.3 `/p/[slug]` — Project detail (public)
Fetch via `GET /projects/{idOrSlug}` (§5.3.1) then `GET /projects/{id}/map`.
Layout: name + location line + RERA badge; description (3-line clamp + "more"); amenity chips;
**Map | List segment toggle** (map default); legend chips (Available/On hold/Reserved/Sold).
- **Map view:** `PlotMap` (§7.4), fills width, 60vh tall.
- **List view:** rows from the same map payload — plot number, area, facing, `formatINR`,
  StatusChip; tap opens the same plot sheet. (List exists for accessibility + no-map fallback.)
- `MAP_NOT_FOUND` → EmptyState "Site map coming soon — plots will appear here".

**Plot sheet** (BottomSheet on tap): plot number + StatusChip; facts grid (area sqft,
dimensions, facing, price big); if ON_HOLD, "on hold until {formatIST(blocked_until)}" when
available. CTA by status: AVAILABLE → primary **Reserve this plot** (logged out → login
redirect); otherwise disabled chip-colored label ("On hold" / "Reserved" / "Sold").
Reserve tap → `POST /v1/plots/{id}/block` (Idempotency-Key per §5.1) → on 201/200 navigate
`/reserve/{booking_id}` (stash `challenge_id` + optional `dev_otp` in `sessionStorage` under
the booking id). `409 PLOT_UNAVAILABLE` → toast "Someone just beat you to it" + refetch map;
`HOLD_LIMIT_EXCEEDED` → toast with the limit.

### 7.4 `PlotMap` (the interactive map)
- Container div; inside, a transform layer holding `<img>` (map image) + absolutely-positioned
  `<svg viewBox="0 0 1 1" preserveAspectRatio="none">` at identical size.
- Polygons from normalized coords render directly as `<polygon points>` in the unit viewBox.
  Fill = status color at 55% opacity, stroke 1.5px (non-scaling), selected plot → stroke 3px +
  fill 75%.
- Plot-number `<text>` at centroid (font auto-hides when `scale * plotArea` is under a
  legibility threshold — compute once per zoom change).
- Gestures: one-finger/mouse drag pans; wheel + pinch zooms (scale clamp 1–6, translate clamped
  to keep image in view). Double-tap zooms ×2 toward the tap point. Implement with pointer
  events + CSS transform on the layer — **no map library**.
- Tap (not drag) on a polygon → `onSelect(plot)`. Refetch per §5.2; a status change while open
  re-colors in place.

### 7.5 `/reserve/[bookingId]` — Reservation journey (owner only)
Polls `GET /v1/bookings/{id}` per §5.2. Renders by status:
- Header always: plot number, project name, `formatINR(total_price_paise)`; Stepper:
  **Requested → Verify email → Gem Housing review → Reserved**.
- `PENDING_CONFIRMATION` (step 2): "We emailed a code to {email}" + OtpInput →
  `POST /v1/reservations/{id}/confirm {challenge_id, otp}`; Resend button →
  `resend-otp` (§5.3.2, replaces stashed challenge_id); Countdown to `expires_at`
  ("Verify within…"). No stashed challenge_id (returning visit) → show only Resend to start.
- `PENDING_APPROVAL` (step 3): confirmation illustration + "Our team is reviewing your request.
  You'll get an email — most requests are decided within 48 hours." + Countdown (decision
  window) + the poll keeps the screen live.
- `RESERVED` (step 4): success state, green check, plot facts card, copy "Reserved in your
  name. Gem Housing will contact you at {email} to complete the paperwork."
- `EXPIRED` / `REJECTED` / `CANCELLED`: terminal card (gray/red), reason line, CTA
  **Back to {project}**.
`403 NOT_BOOKING_OWNER` / 404 → EmptyState "Reservation not found".

### 7.6 `/me` — My plots + profile
Sections: (1) **Profile completeness prompt** when `full_name` or `phone` empty — inline form
`PATCH /v1/me {full_name, phone}` with copy "So our team can reach you about your
reservation"; (2) **Reservations list** from `GET /v1/me/bookings` — cards with plot/project,
StatusChip, Countdown when pending, tap → `/reserve/[id]`; (3) Logout (revokes refresh,
clears storage). EmptyState: "No reservations yet — find your plot" → `/`.

## 8. Admin screens

### 8.1 `/admin` — Login
Email + password → `POST /v1/auth/admin/login`. Generic `INVALID_CREDENTIALS` error line.
On success → `/admin/home`.

### 8.2 `/admin/home` — Dashboard
From `GET /v1/admin/dashboard/summary` (§5.3.3): stat cards **Pending approvals** (click →
inbox), **Active holds** (table: plot, project, customer email, StatusChip, Countdown),
**Inventory** (horizontal stacked bar by plot status + counts), **Recent activity** (last 5
notifications, "View all").

### 8.3 `/admin/inbox` — Approvals inbox (MC §4.1)
`GET /v1/admin/approvals?status=PENDING&action=&project_id=` + filter row (status, action,
project). DataTable: **Age** (relative; amber >24 h, red >72 h), Action (human label —
`RESERVE_PLOT` → "Plot reservation"), Entity (plot number + project), Requested by (customer
email / admin name), Reason (truncated). Row → detail. Poll 60 s. Badge count shared with
sidebar via the count query.

### 8.4 `/admin/inbox/[id]` — Review detail (MC §4.2)
From `GET /v1/admin/approvals/{id}`: header (action label, StatusChip, maker + requested-at);
**Reservation context panel** (for RESERVE_PLOT): customer name/email/phone from snapshot,
"email verified ✓" (reserve_confirmed_at), plot facts, price, decision Countdown;
**Diff panel** (non-reservation actions): field / current / proposed, drift warning when live
≠ snapshot; **Guardrails panel**: each `{name, ok, detail}` with ✓/✗ — Approve disabled while
any fails or viewer is the maker (server enforces regardless);
Actions: **Approve** (ConfirmDialog, optional note) / **Reject** (ConfirmDialog, note
required) → `POST …/approve|reject` → toast + back to inbox. `SELF_APPROVAL_FORBIDDEN`,
`GUARDRAIL_FAILED`, `APPROVAL_NOT_PENDING` → error toast with message + refetch.

### 8.5 `/admin/projects`, `/admin/projects/[id]` — Catalog
List (DataTable: name, status chip, district, plots, actions) + **New project** form (name,
description, address fields, RERA toggle + number, advance %, hold override). Project page has
tabs:
- **Details**: PATCH form for non-controlled fields; controlled ones (publish, price…) shown
  with a lock icon + "requires approval" tooltip (wired in P7).
- **Plots**: DataTable of plots + **CSV upload**: file picker or paste-textarea → client reads
  text → `POST …/plots/bulk?dry_run=true` → preview table of parsed rows + per-row errors →
  **Import** button (enabled only when 0 errors) → real call → toast `{inserted} plots imported`.
- **Site map**: versions list (version, active badge, created) + **Upload new version**
  (file → base64 JSON per API §5.2, reads px dimensions from the image client-side) + open
  editor.
**PolygonEditor** (full-screen route or modal): left = the map image with pan/zoom (reuse
PlotMap's transform layer) + drawn polygons; right = plot list (assigned ✓ / unassigned).
Interactions: **Draw** mode — click adds vertex (drawn as small circles + rubber-band line);
click first vertex or ⏎ closes; then a plot-picker assigns it (centroid = vertex mean).
**Edit** — select polygon → drag vertices; **Delete** selected. **Save** → `POST
/site-maps/{id}/geometries` (full replace, from local state). **Activate** → ConfirmDialog →
on `MAP_INCOMPLETE` show the missing plot numbers as red chips in the right panel.
Undo = local history stack (array of geometry snapshots), Ctrl+Z.

### 8.6 `/admin/notifications`, `/admin/emails`, `/admin/audit`
- **Notifications**: feed list (type icon, title, body, entity link, relative time; unread =
  bold + dot), "Mark all read"; row click marks read + navigates to entity (approval → inbox
  detail, booking → filtered bookings).
- **Emails (outbox)**: DataTable (to, template, subject, status LOGGED/SENT/FAILED chip, time);
  row → right-side drawer rendering `body_text` in `<pre>`. This is demo-mode's "sent mail" —
  subtitle explains exactly that.
- **Audit**: DataTable (time IST, actor role+id, action, entity, request id) + filters
  (entity_type, entity_id, from/to). Read-only.

### 8.7 Bell
Badge from `['admin','notifications','count']` (30 s). Dropdown: latest 5 + "View all" →
`/admin/notifications`.

## 9. Booking status → UI mapping

| status | Chip label | Color | Customer screen state |
|---|---|---|---|
| PENDING_CONFIRMATION | Verify email | amber | §7.5 step 2 (OTP) |
| PENDING_APPROVAL | Awaiting approval | blue | §7.5 step 3 (review) |
| RESERVED | Reserved | green | §7.5 step 4 (success) |
| EXPIRED | Expired | gray | terminal card |
| REJECTED | Not approved | red | terminal card |
| CANCELLED | Cancelled | gray | terminal card |

## 10. PWA & mobile behaviors

`manifest.json`: name "Gem Plots", short_name "GemPlots", theme `#047857`, background
`#f9fafb`, display `standalone`, icons 192/512 from the §3.3 mark. Apple touch icon + status
bar meta. Viewport `viewport-fit=cover`; bottom nav respects `env(safe-area-inset-bottom)`.
No service-worker offline caching in Phase 1 (installability only) — avoids stale-map bugs.

## 11. Conventions: loading / empty / error

Every data screen implements all three: Skeletons (shaped like the real content, never
spinners-only pages), EmptyState with a next action, and error = toast + inline retry where the
content would be. Mutations: button `loading` state; success toast only where the UI doesn't
already visibly change. All user-facing strings live in `web/lib/strings.ts` (single object) —
Phase 1 is English; this keeps a future Tamil pass mechanical.

## 12. Accessibility & responsiveness

Breakpoints: base 375, `md` 768 (sheet→modal, admin sidebar expands), `lg` 1024. Touch targets
≥44 px. The map always has the List toggle as its accessible equivalent; polygons get
`role="button"` + `aria-label="Plot P-01, available, ₹18,00,000"`. Forms: labels tied to
inputs, errors announced via `aria-live="polite"`. Color is never the only signal (chips carry
text). Focus-visible rings on all interactive elements (Tailwind default ring in primary).

## 13. Directory layout

```
web/
├── app/
│   ├── layout.tsx  page.tsx  login/  p/[slug]/  reserve/[bookingId]/  me/
│   ├── (shell pieces live in app/_shell/: TopBar, BottomNav, DevRibbon)
│   └── admin/
│       ├── layout.tsx  page.tsx  home/  inbox/  inbox/[id]/
│       ├── projects/  projects/[id]/   notifications/  emails/  audit/
├── components/        (§6 inventory; PlotMap.tsx, PolygonEditor.tsx)
├── lib/               api.ts  auth.ts  format.ts  strings.ts  types.ts (mirrors API payloads)
├── e2e/               smoke.spec.ts (Playwright)
└── public/            manifest.json, icons
```

## 14. Verification (adds to docs/09 DoDs)

- **P4**: scripted 375-px browser walkthrough with screenshots (already in 09) **plus**
  `web/e2e/smoke.spec.ts` part 1: login (reading dev OTP via the API outbox/log) → open
  project → map renders ≥3 polygons → reserve → confirm OTP → status shows "Awaiting approval".
- **P5**: smoke part 2: admin logs in → bell shows ≥1 → inbox → approve → customer poll shows
  Reserved. Reject path asserted too. Playwright runs against the local stack (`npm run e2e`);
  wire into CI as a final stage with the API bootstrapped.
- **P6**: editor round-trip: upload image → draw 3 polygons → save → activate → customer map
  shows them (can be manual with screenshots; e2e optional).

## 15. Slice mapping (what lands where)

| Slice | UI scope from this doc | Backend touch-ups from §5.3 |
|---|---|---|
| P2 | — | `resend-otp` endpoint (§5.3.2) |
| P3 | — | `dashboard/summary` (§5.3.3) |
| P4 | §1–§7, §9–§13 complete customer face + shells + data layer + PWA + smoke part 1 | `GET /projects/{idOrSlug}` (§5.3.1) |
| P5 | §8.1–§8.4, §8.6 notifications/emails, §8.7 bell + smoke part 2 | — |
| P6 | §8.5 catalog + polygon editor (+ audit page if not done in P5) | — |
