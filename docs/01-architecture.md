# 01 — System Architecture

Phase 1 architecture for the Dhanam Plots platform. Cross-refs: `DM` = 02-data-model,
`API` = 03-api-contracts, `CF` = 04-critical-flows, `MC` = 05-maker-checker.

## 1. Topology

```
┌─────────────┐     ┌──────────────┐
│ Flutter app │     │ Next.js admin│
│ (customer)  │     │ (staff)      │
└──────┬──────┘     └──────┬───────┘
       │  HTTPS/JSON       │  HTTPS/JSON
       ▼                   ▼
┌──────────────────────────────────────────────┐
│  NestJS modular monolith (api/)              │
│  ┌────────┬─────────┬─────────┬───────────┐  │
│  │ auth   │ project │ plot    │ map       │  │
│  │ booking│ payment │ approval│ audit     │  │
│  │ admin  │ notification      │ common    │  │
│  └────────┴─────────┴─────────┴───────────┘  │
│  HTTP workers          BullMQ workers        │
│  (same deployable, WORKER_MODE env selects)  │
└───────┬──────────────┬───────────┬───────────┘
        │              │           │
        ▼              ▼           ▼
   PostgreSQL       Redis     S3-compatible
  (source of     (TTL, cache,    storage
    truth)       BullMQ queues) (site maps, receipts)

External: Razorpay (orders API + webhooks) • FCM • DLT SMS/WhatsApp gateway
```

One deployable, two run modes: `WORKER_MODE=api` serves HTTP; `WORKER_MODE=worker` runs BullMQ
processors (expiry sweeper, notification sender, reconciliation). Dev runs both in one process.

## 2. Why these shapes (locked rationale, summarized)

- **Modular monolith, not microservices**: one team, one domain, transactional integrity across
  plots/bookings/payments is the core requirement — a single Postgres transaction is the simplest
  correct tool. Module boundaries (below) keep a later extraction possible.
- **Postgres as sole source of truth**: inventory truth under concurrency is the product. Row
  locks + partial unique indexes give correctness that cache-based reservations cannot.
- **Webhook-first payments**: client callbacks are spoofable and lossy. Only a signature-verified
  server-to-server webhook mutates money-adjacent state (Invariant 7).
- **Redis as helper only**: hold-countdown TTL and queues. If Redis is wiped, the system heals
  from Postgres (sweeper + lazy repair re-derive everything).

## 3. Module boundaries (api/src/modules/)

Each module owns its tables and exposes a service interface; other modules call the service,
never the repository. **No module imports another module's repositories/entities directly.**

| Module | Owns (tables) | Exposes | Depends on |
|---|---|---|---|
| `common` | — | config service (global_settings + env), idempotency helper, error types, IST/paise utils, S3 client, request-id middleware | — |
| `auth` | users, otp_challenges, refresh_tokens, device_tokens | guards (JwtAuthGuard, RolesGuard), current-user decorator | common |
| `project` | sellers, projects | ProjectService (read + admin CRUD) | common, audit |
| `plot` | plots | PlotService (read, bulk import, status transitions API for booking module) | project, audit |
| `map` | site_maps, plot_geometries | MapService (upload, geometry save, active-map read) | project, plot, common(S3) |
| `booking` | bookings | BookingService: `block()`, `repairExpired()`, `expireDue()` — the hold engine (CF §2–3) | plot, auth, audit, notification |
| `payment` | payments, webhook_events, reconciliation_* | PaymentService: `createOrder()`, `handleWebhook()`; `PaymentGatewayAdapter` interface + `RazorpayAdapter` | booking, audit, notification |
| `approval` | approvals | ApprovalService: `request()`, `approve()`, `reject()` + the action-handler registry (MC §3) | all mutating modules, audit |
| `audit` | audit_logs | `AuditService.log(actor, action, entity, before, after)` — append-only | common |
| `notification` | notifications | push/SMS senders, reminder scheduler (BullMQ) | auth(device tokens), common |
| `admin` | — | admin-only controllers composing the above (dashboards, CSV upload, approvals inbox) | all |

**Transaction rule:** cross-module writes that must be atomic (block = booking + plot + audit;
webhook success = payment + booking + plot + audit) run in ONE transaction owned by the
orchestrating service (`booking` for holds, `payment` for webhooks), passing the transaction
handle into the other services' methods. Services must accept an optional tx/entity-manager
parameter for this reason.

## 4. Request lifecycles (canonical paths)

**Block a plot** (full spec CF §2):
app → `POST /plots/{id}/block` (JWT + Idempotency-Key) → idempotency replay check → hold-limit
check → TX[lock plot row → insert booking → flip plot → audit] → post-commit: Redis TTL key,
BullMQ expiry+reminder jobs, FCM push → `201` with `expires_at`.

**Pay advance** (CF §4–5):
app → `POST /bookings/{id}/payment-order` → RERA-cap check → gateway order via adapter →
app opens Razorpay checkout → app callback shows "processing" screen polling
`GET /bookings/{id}` → Razorpay calls `POST /webhooks/payments/razorpay` → verify signature →
dedupe → amount match → TX[payment SUCCESS, booking BOOKED, plot BOOKED, audit] → receipt +
push. The poll sees BOOKED and the app shows success. **The callback never mutates state.**

**Controlled admin action** (MC §2):
admin UI → maker endpoint → guardrail pre-check → `202` + approvals row (PENDING) → different
admin opens Review Detail → guardrails re-checked → approve → TX[apply change via the action
handler + audit] → notify maker.

## 5. Concerns

- **AuthN/Z**: customers = OTP → JWT (15 min) + rotating refresh (30 d). Admins = email+password
  (argon2) → same JWT shape with admin role. RBAC via `@Roles()` guard; roles in DM §2.
  Webhook route is unauthenticated but signature-verified and rate-limited.
- **Idempotency**: header `Idempotency-Key` (client-generated UUID) required on
  `POST /plots/{id}/block` and `POST /bookings/{id}/payment-order`. Stored on the created row;
  replay returns the original response (API §1.4).
- **Errors**: single envelope `{error: {code, message, details}, request_id}` — catalog in API §7.
- **Observability** (slice 14): pino structured logs with `request_id`, OpenTelemetry traces,
  Prometheus metrics; alert on: sweeper lag > 2 min, webhook signature failures,
  MANUAL_REVIEW count > 0, hold-conflict (409) rate spikes.
- **Security**: DPDP — PII limited to name/phone/email; raw webhook payloads stored (needed for
  disputes) but access-controlled; audit log immutable; secrets only via env; no card data ever
  touches our servers (gateway-hosted checkout).

## 6. Phase-2/3 seams (design for, don't build)

- `sellers` table exists from day 1 with `type = 'OWN_COMPANY'`; Phase 3 adds `THIRD_PARTY` +
  KYC columns — no booking-flow changes.
- `bookings` is the anchor for Phase-2 documents/agreements (child tables keyed on booking_id).
- `notification` module is channel-abstracted (push/SMS today; chat later is a new module).
- Money fields are `BIGINT` paise everywhere; Phase-3 commission/settlement reuses the unit.
- The approval action registry (MC §3) is open — new controlled actions register a handler, no
  framework change.
