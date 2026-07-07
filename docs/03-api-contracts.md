# 03 — API Contracts

Wire-format authority for Phase 1. The implementing agent authors `api/openapi.yaml` from this
document in slice 1 and keeps it in sync every slice (CI gate). Base URL prefix: `/v1`.

## 1. Conventions

### 1.1 Auth
- Customer + admin: `Authorization: Bearer <JWT>` (15-min access token).
  JWT claims: `sub` (user id), `role`, `iat`, `exp`.
- Role guard notation below: `[CUSTOMER]`, `[ADMIN:any]`, `[ADMIN:FINANCE]`, `[PUBLIC]`.
  `ADMIN:any` = any of SUPER_ADMIN/OPERATIONS/SALES/FINANCE/AUDITOR; AUDITOR is read-only
  (write endpoints exclude it even under `ADMIN:any` — enforced in the roles guard).
- Webhook endpoint: `[PUBLIC]` + gateway signature (CF §5).

### 1.2 Envelopes
Success: plain resource JSON (no wrapper). Errors, always:
```json
{ "error": { "code": "PLOT_UNAVAILABLE", "message": "human readable", "details": {} },
  "request_id": "req_..." }
```

### 1.3 Money & time
Money: integer paise fields suffixed `_paise`. Time: ISO-8601 UTC (`2026-07-08T12:00:00Z`);
clients render IST.

### 1.4 Idempotency
`Idempotency-Key: <uuid>` header is **required** on `POST /plots/{id}/block` and
`POST /bookings/{id}/payment-order`. Missing → `400 IDEMPOTENCY_KEY_REQUIRED`. A replay (same
user + same key) returns the originally created resource with `200` (not 201) and header
`Idempotency-Replay: true`. Same key with *different* request body → `409 IDEMPOTENCY_CONFLICT`.

### 1.5 Pagination
List endpoints: `?limit=` (default 20, max 100) `&cursor=` (opaque). Response:
`{ "items": [...], "next_cursor": "..." | null }`.

## 2. Auth endpoints

| Method & path | Guard | Purpose |
|---|---|---|
| `POST /auth/otp/request` | PUBLIC | Body `{phone}` (E.164). Sends OTP. → `200 {challenge_id, retry_after_seconds}`. Errors: `OTP_RATE_LIMITED` (429). Response never reveals whether user exists. |
| `POST /auth/otp/verify` | PUBLIC | Body `{challenge_id, phone, otp}`. Creates user if new. → `200 {access_token, refresh_token, user}`. Errors: `OTP_INVALID` (400, increments attempts), `OTP_EXPIRED` (400), `OTP_ATTEMPTS_EXCEEDED` (429). |
| `POST /auth/refresh` | PUBLIC | Body `{refresh_token}`. Rotates: old token revoked+chained. → `200 {access_token, refresh_token}`. Reuse of a revoked token → `401 REFRESH_REUSED` and the whole chain is revoked. |
| `POST /auth/logout` | any | Body `{refresh_token}` → revoke. `204`. |
| `POST /auth/admin/login` | PUBLIC | Body `{email, password}` → same token pair for admin roles. `401 INVALID_CREDENTIALS`. Rate-limit 5/15min/IP. |
| `POST /me/device-tokens` | CUSTOMER | Body `{fcm_token, platform}` → upsert. `204`. |

`user` object: `{id, phone, full_name, role}`.

## 3. Customer read APIs

### `GET /projects` [PUBLIC]
Only `status = PUBLISHED`. Query: `?district=&state=`. Item:
```json
{ "id":"…","name":"Dhanam Green Meadows","slug":"dhanam-green-meadows",
  "district":"Coimbatore","state":"Tamil Nadu","rera_registered":true,"rera_number":"…",
  "price_range_paise":{"min":180000000,"max":360000000},
  "plot_counts":{"total":3,"available":2},
  "cover_image_url":"https://…", "amenities":["park","water"] }
```

### `GET /projects/{id}` [PUBLIC]
Full project detail incl. description, address, lat/lng, `max_advance_percentage`,
`effective_advance_cap_pct` (computed), `hold_minutes` (effective), plot_counts by status.

### `GET /projects/{id}/map` [PUBLIC]
The active site map + geometries + live statuses:
```json
{ "map_version":1, "image_url":"https://…signed…", "width_px":2000, "height_px":1400,
  "plots":[ { "plot_id":"…","plot_number":"P-01","status":"AVAILABLE",
              "polygon":[[0.10,0.12],[0.18,0.12],[0.18,0.25],[0.10,0.25]],
              "centroid":[0.14,0.185],
              "area_sqft":1200,"price_paise":180000000,"facing":"E" } ] }
```
`404 MAP_NOT_FOUND` if no active map. **Statuses in this payload run lazy repair first (CF §3.3).**

### `GET /plots/{id}` [PUBLIC]
Plot detail. Runs lazy repair before responding. Includes, when status=BLOCKED,
`"blocked_until":"…"` (from the active booking) so the UI can show "held, check back at …".

## 4. Booking & payment (customer)

### `POST /plots/{id}/block` [CUSTOMER] — CF §2
Headers: `Idempotency-Key` (required). Body: `{}` (price is never client-supplied).
- `201`:
```json
{ "booking_id":"…","plot_id":"…","status":"BLOCKED",
  "total_price_paise":180000000,
  "advance_cap_paise":18000000, "min_advance_paise":1000000,
  "blocked_at":"…","expires_at":"…","hold_minutes":1440 }
```
- Errors: `409 PLOT_UNAVAILABLE` • `409 HOLD_LIMIT_EXCEEDED` (details: `{max_active_holds}`)
  • `409 DUPLICATE_ACTIVE_HOLD` (this user already actively holds this plot)
  • `400 IDEMPOTENCY_KEY_REQUIRED` • `409 IDEMPOTENCY_CONFLICT` • `403 USER_BLOCKED`
  • `404 PLOT_NOT_FOUND` (also when project not PUBLISHED).

### `POST /bookings/{id}/payment-order` [CUSTOMER, owner] — CF §4
Headers: `Idempotency-Key`. Body: `{ "amount_paise": 15000000 }`.
- `201`:
```json
{ "payment_id":"…","gateway":"RAZORPAY","gateway_order_id":"order_XXX",
  "gateway_key_id":"rzp_live_xxx","amount_paise":15000000,"currency":"INR",
  "booking_id":"…","expires_at":"…" }
```
- Errors: `400 ADVANCE_EXCEEDS_CAP` (details `{cap_paise}`) • `400 ADVANCE_BELOW_MIN` •
  `409 BOOKING_NOT_BLOCKED` (already booked/expired/cancelled — lazy repair runs first) •
  `403 NOT_BOOKING_OWNER` • `404 BOOKING_NOT_FOUND`.

### `GET /bookings/{id}` [CUSTOMER owner, or ADMIN:any]
Booking detail + embedded plot/project summary + payments array. This is the endpoint the app
**polls** from the "processing" screen. Runs lazy repair.
```json
{ "id":"…","status":"BLOCKED","plot":{…},"project":{…},
  "total_price_paise":…,"advance_amount_paise":…,
  "blocked_at":"…","expires_at":"…","confirmed_at":null,
  "payments":[{"id":"…","status":"CREATED","amount_paise":…,"receipt_number":null}] }
```

### `GET /me/bookings` [CUSTOMER]
Paginated list of caller's bookings, newest first, same item shape (without payments detail).

## 5. Admin APIs (prefix `/admin`)

All require admin JWT. Every mutation writes an audit row. Mutations marked **(MC)** are
maker-checker: they return `202 {approval_id, status:"PENDING"}` instead of mutating (MC §3).

### 5.1 Projects & plots
| Endpoint | Guard | Notes |
|---|---|---|
| `POST /admin/projects` | OPERATIONS, SUPER_ADMIN | Create DRAFT project. Compliance fields (rera_*) required if `rera_registered`. |
| `PATCH /admin/projects/{id}` | OPERATIONS, SUPER_ADMIN | Non-controlled fields only (description, amenities, address…). Controlled: publish (MC 7), advance cap (MC 8). |
| `POST /admin/projects/{id}/publish` **(MC)** | OPERATIONS → approver SUPER_ADMIN | PUBLISH_PROJECT. Guardrail: ≥1 plot, active site map, RERA fields complete when flagged. |
| `POST /admin/projects/{id}/plots:bulk` | OPERATIONS, SUPER_ADMIN | CSV upload (multipart). Columns: `plot_number,facing,dimensions_text,area_sqft,price_inr`. Validates all rows before inserting any (all-or-nothing); `price_inr` rupees → paise ×100. → `201 {inserted, errors:[{row, message}]}` (errors only on dry-run flag `?dry_run=true`). Duplicate plot_number → row error. |
| `PATCH /admin/plots/{id}` | OPERATIONS, SUPER_ADMIN | Non-controlled fields (facing, dimensions, attributes). Price → MC 1. Status → MC 2. |

### 5.2 Site map
| Endpoint | Notes |
|---|---|
| `POST /admin/projects/{id}/site-maps` | Multipart image upload → S3; creates version = max+1, inactive. → `201 {site_map_id, version, image_url}` |
| `PUT /admin/site-maps/{id}/geometries` | Body `{geometries:[{plot_id, polygon, centroid}]}` — full replace for that map. Validates: polygon ≥3 points, coords in [0,1], every plot_id belongs to the project, no duplicate plot_id. |
| `POST /admin/site-maps/{id}/activate` | Flips active map atomically (deactivate old, activate new in one TX). Guardrail: every non-WITHDRAWN plot has a geometry, else `409 MAP_INCOMPLETE {missing_plot_ids}`. |

### 5.3 Bookings & payments (ops/finance)
| Endpoint | Guard | Notes |
|---|---|---|
| `GET /admin/bookings` | any | Filters: `status, project_id, phone, from, to`. |
| `GET /admin/payments` | FINANCE, SUPER_ADMIN, AUDITOR | Filters: `status, gateway_payment_id, from, to`. |
| `GET /admin/manual-review` | FINANCE, SUPER_ADMIN | Queue of MANUAL_REVIEW bookings/payments with webhook evidence. |
| `POST /admin/bookings/{id}/cancel` **(MC 3)** | SALES/OPERATIONS request → approve per MC | |
| `POST /admin/bookings/{id}/extend-hold` **(MC 4)** | Body `{extra_minutes}` | |
| `POST /admin/manual-review/{bookingId}/resolve` **(MC 5)** | FINANCE request | Body `{resolution:"CONFIRM"|"CANCEL", note}` |
| `POST /admin/payments/{id}/refund` **(MC 6)** | FINANCE request | Body `{amount_paise, reason}` |

### 5.4 Approvals (MC §4 defines the screens these feed)
| Endpoint | Notes |
|---|---|
| `GET /admin/approvals?status=PENDING&action=&project_id=` | Inbox list; items include age, maker, action, entity summary. |
| `GET /admin/approvals/{id}` | Review detail: payload, snapshot, **live guardrail re-check result** (`guardrails: [{name, ok, detail}]`). |
| `POST /admin/approvals/{id}/approve` | Body `{note?}`. `409 SELF_APPROVAL_FORBIDDEN` if caller is maker; `409 GUARDRAIL_FAILED {failures}` if re-check fails; `409 APPROVAL_NOT_PENDING`. On success applies the change in one TX and returns the updated entity. |
| `POST /admin/approvals/{id}/reject` | Body `{note}` (required). |
| `POST /admin/approvals/{id}/withdraw` | Maker only, while PENDING. |

### 5.5 Settings
`GET /admin/settings` (SUPER_ADMIN, AUDITOR) • `PUT /admin/settings/{key}` **(MC 10)**
(SUPER_ADMIN request, different SUPER_ADMIN approves).

### 5.6 Dashboards
| Endpoint | Returns |
|---|---|
| `GET /admin/dashboard/inventory` | Per project: plot counts by status, value of available inventory (paise). |
| `GET /admin/dashboard/bookings` | Active holds (with time-left), today/7d/30d counts: created, confirmed, expired; conversion rate. |
| `GET /admin/dashboard/payments` | Collected today/7d/30d (paise), pending MANUAL_REVIEW count, last reconciliation run summary. |

### 5.7 Audit
`GET /admin/audit-logs?entity_type=&entity_id=&actor_id=&from=&to=` (SUPER_ADMIN, AUDITOR).

## 6. Webhook

### `POST /webhooks/payments/razorpay` [PUBLIC + signature]
Full algorithm CF §5. Headers used: `x-razorpay-signature`, `x-razorpay-event-id`.
Must read the **raw body** for HMAC verification (register a raw-body parser for this route
only). Responses: `200 {status:"ok"}` for processed/duplicate/ignored/manual-review;
`400 INVALID_SIGNATURE` for bad signature (gateway will retry; that is intended).
Handled events: `payment.captured`, `payment.failed`; all others recorded as `IGNORED`.

## 7. Error catalog

| HTTP | code | Where |
|---|---|---|
| 400 | `VALIDATION_FAILED` | any (details: per-field) |
| 400 | `IDEMPOTENCY_KEY_REQUIRED` | block, payment-order |
| 400 | `ADVANCE_EXCEEDS_CAP` / `ADVANCE_BELOW_MIN` | payment-order |
| 400 | `OTP_INVALID` / `OTP_EXPIRED` | otp/verify |
| 400 | `INVALID_SIGNATURE` | webhook |
| 401 | `UNAUTHENTICATED` / `TOKEN_EXPIRED` / `REFRESH_REUSED` / `INVALID_CREDENTIALS` | auth |
| 403 | `FORBIDDEN_ROLE` / `NOT_BOOKING_OWNER` / `USER_BLOCKED` | guards |
| 404 | `PLOT_NOT_FOUND` / `BOOKING_NOT_FOUND` / `PROJECT_NOT_FOUND` / `MAP_NOT_FOUND` / `APPROVAL_NOT_FOUND` | reads |
| 409 | `PLOT_UNAVAILABLE` | block |
| 409 | `HOLD_LIMIT_EXCEEDED` / `DUPLICATE_ACTIVE_HOLD` | block |
| 409 | `IDEMPOTENCY_CONFLICT` | block, payment-order |
| 409 | `BOOKING_NOT_BLOCKED` | payment-order |
| 409 | `SELF_APPROVAL_FORBIDDEN` / `GUARDRAIL_FAILED` / `APPROVAL_NOT_PENDING` / `PENDING_APPROVAL_EXISTS` | approvals |
| 409 | `MAP_INCOMPLETE` | map activate |
| 429 | `OTP_RATE_LIMITED` / `RATE_LIMITED` | auth, global limiter |
| 500 | `INTERNAL` | catch-all (never leaks internals) |
