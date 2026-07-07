# 04 — Critical Flows (runtime behavior authority)

The five places this system can silently lose money or inventory truth, specified step-by-step.
Implement these **exactly**; if code and this doc diverge, this doc wins. Pseudocode is
TypeScript-flavored; SQL is real.

## 1. Shared machinery

### 1.1 Idempotency replay helper (common module)
For `block`: look up `bookings WHERE user_id=$user AND idempotency_key=$key`.
For `payment-order`: `payments WHERE booking_id=$id AND idempotency_key=$key`.
Found → compare a hash of the canonical request body stored per row? No — simpler and sufficient:
the request-identifying fields ARE the row (plot_id / amount_paise). If the found row matches the
request target/amount → return it (`200`, `Idempotency-Replay: true`). If it differs →
`409 IDEMPOTENCY_CONFLICT`.

### 1.2 System actor
Sweeper, webhook, and reconciliation write audit rows with `actor_id = NULL`,
`actor_role = 'SYSTEM'`.

## 2. Hold engine — `POST /plots/{id}/block`

```ts
async block(userId, plotId, idemKey) {
  if (!idemKey) throw badRequest('IDEMPOTENCY_KEY_REQUIRED');

  // 1. Replay?
  const existing = await bookings.findByUserAndKey(userId, idemKey);
  if (existing) {
    if (existing.plot_id !== plotId) throw conflict('IDEMPOTENCY_CONFLICT');
    return replay(existing);                                  // 200, original payload
  }

  // 2. Pre-checks (cheap, outside the TX; DB constraints are the real guard)
  const user = await users.get(userId);
  if (user.status === 'BLOCKED') throw forbidden('USER_BLOCKED');
  const activeHolds = await bookings.countActiveBlockedByUser(userId); // status='BLOCKED'
  const maxHolds = await config.int('max_active_holds_per_user');      // default 2
  if (activeHolds >= maxHolds) throw conflict('HOLD_LIMIT_EXCEEDED', {max_active_holds: maxHolds});

  // 3. The transaction — Invariants 2, 3, 5
  try {
    return await db.transaction(async tx => {
      const plot = await tx.query(
        `SELECT p.*, pr.status AS project_status, pr.hold_minutes_override,
                pr.max_advance_percentage, pr.rera_registered
           FROM plots p JOIN projects pr ON pr.id = p.project_id
          WHERE p.id = $1 AND p.status = 'AVAILABLE' AND pr.status = 'PUBLISHED'
          FOR UPDATE OF p`, [plotId]);
      if (plot.rows.length === 0) {
        // Either the plot doesn't exist (→404, check without lock) or it isn't
        // available (→409). Zero rows from this query IS the unavailable signal.
        const exists = await tx.query(
          `SELECT 1 FROM plots p JOIN projects pr ON pr.id=p.project_id
            WHERE p.id=$1 AND pr.status='PUBLISHED'`, [plotId]);
        throw exists.rows.length ? conflict('PLOT_UNAVAILABLE') : notFound('PLOT_NOT_FOUND');
      }
      const p = plot.rows[0];
      const holdMinutes = p.hold_minutes_override ?? await config.int('global_hold_minutes');
      const booking = await tx.insert('bookings', {
        plot_id: plotId, user_id: userId, status: 'BLOCKED',
        total_price_paise: p.price_paise,            // PRICE SNAPSHOT
        hold_minutes: holdMinutes,
        expires_at: sql`now() + make_interval(mins => ${holdMinutes})`,  // FROZEN
        idempotency_key: idemKey });
      await tx.query(`UPDATE plots SET status='BLOCKED' WHERE id=$1`, [plotId]);
      await audit.log(tx, userId, 'CUSTOMER', 'booking.block', 'plot', plotId,
                      {status:'AVAILABLE'}, {status:'BLOCKED', booking_id: booking.id});
      return booking;                                         // 201
    });
  } catch (e) {
    if (isUniqueViolation(e, 'uniq_active_booking_per_plot')) throw conflict('PLOT_UNAVAILABLE');
    if (isUniqueViolation(e, 'bookings_user_id_idempotency_key_key')) {
      return replay(await bookings.findByUserAndKey(userId, idemKey)); // concurrent same-key retry
    }
    throw e;
  }
  // NOTE: DUPLICATE_ACTIVE_HOLD (same user, same plot, active hold, new key) surfaces
  // naturally as uniq_active_booking_per_plot → PLOT_UNAVAILABLE is acceptable; if the
  // pre-check in step 2 detects it first, prefer the more specific code.
}

// 4. AFTER COMMIT (never inside the TX; failures here must not roll back the hold):
//    - redis.set(`hold:${booking.id}`, plotId, EX = holdMinutes*60)      // UX countdown only
//    - bullmq: enqueue 'expire-booking'   delay = expires_at - now       // belt
//    - bullmq: enqueue 'hold-reminder' x2 at expires_at - 6h and - 1h (skip offsets already past)
//    - push notification 'hold_created'
```

**Why each piece:** the `FOR UPDATE` serializes competing blockers; the status filter makes the
lock query itself the availability check; the partial unique index catches anything that slips
through (e.g., a code bug that forgets the filter); the pre-checks give friendly errors but are
never trusted as the guard.

## 3. Expiry — three independent defenses (Invariant 6)

The single transition, one implementation shared by all three paths:

```sql
-- expire_booking(booking_id): call inside a TX
UPDATE bookings SET status='EXPIRED', closed_at=now()
 WHERE id=$1 AND status='BLOCKED' AND expires_at <= now();   -- guard: only truly-due holds
-- if 1 row updated:
UPDATE plots SET status='AVAILABLE' WHERE id=$plot_id AND status='BLOCKED';
INSERT INTO audit_logs(actor_role, action, entity_type, entity_id, before, after)
     VALUES ('SYSTEM','booking.expire','booking',$1, '{"status":"BLOCKED"}','{"status":"EXPIRED"}');
```
If the bookings UPDATE touches 0 rows, do nothing (someone else already handled it, or it was
paid) — this is what makes all three defenses safely concurrent.

### 3.1 Sweeper (authoritative) — BullMQ repeatable job, every 60 s, worker mode
```sql
SELECT id, plot_id FROM bookings
 WHERE status='BLOCKED' AND expires_at <= now()
 ORDER BY expires_at
 FOR UPDATE SKIP LOCKED LIMIT 100;   -- inside a TX; loop until empty
```
For each row run the transition above in the same TX (batch), then send 'hold_expired' push
after commit. `SKIP LOCKED` lets multiple workers coexist and never blocks the block-endpoint.

### 3.2 Per-booking delayed job (belt)
The 'expire-booking' job enqueued at block time calls the same transition. It may find 0 rows
(paid, or sweeper won) — fine.

### 3.3 Lazy repair on read (belt #2, works even with Redis and workers down)
`repairExpired(plotIds[])` runs before serving: `GET /plots/{id}`, `GET /projects/{id}/map`,
`GET /bookings/{id}`, `POST /bookings/{id}/payment-order`, and admin dashboards.
```sql
SELECT id FROM bookings
 WHERE plot_id = ANY($1) AND status='BLOCKED' AND expires_at <= now();
```
For each id, run the transition (each in a short TX). Then serve the read from post-repair state.

### 3.4 Redis TTL
`hold:{booking_id}` with TTL = the hold. **Used only** by the app for the countdown and by
support tooling. Never read to decide availability. Redis loss = countdowns degrade, correctness
unaffected.

## 4. Payment order — `POST /bookings/{id}/payment-order`

### 4.1 Gateway adapter (the only Razorpay-specific code)
```ts
interface PaymentGatewayAdapter {
  createOrder(i: {amountPaise: number; currency: 'INR'; receipt: string;
                  notes: Record<string,string>}): Promise<{gatewayOrderId: string}>;
  verifyWebhookSignature(rawBody: Buffer, headers: Headers): boolean;   // HMAC-SHA256, PG_WEBHOOK_SECRET
  parseWebhook(rawBody: Buffer): {eventId: string; eventType: 'payment.captured'|'payment.failed'|string;
     gatewayPaymentId: string; gatewayOrderId: string; amountPaise: number; currency: string; raw: any};
}
```
`RazorpayAdapter` implements it (orders API; amount already in paise — Razorpay's native unit).
Swapping gateways = new adapter + env change; nothing else.

### 4.2 Flow
```ts
async createPaymentOrder(userId, bookingId, amountPaise, idemKey) {
  requireIdemKey(idemKey);
  await booking.repairExpired([bookingOf(bookingId).plot_id]);          // lazy repair FIRST
  const b = await bookings.get(bookingId);
  if (!b) throw notFound('BOOKING_NOT_FOUND');
  if (b.user_id !== userId) throw forbidden('NOT_BOOKING_OWNER');
  if (b.status !== 'BLOCKED') throw conflict('BOOKING_NOT_BLOCKED');

  const replayRow = await payments.findByBookingAndKey(bookingId, idemKey);
  if (replayRow) return replayMatchingAmount(replayRow, amountPaise);   // §1.1

  // Invariant 8 — RERA cap, integer math only
  const proj = await projects.getByBooking(b);
  const capPct = proj.rera_registered
      ? Math.min(Number(proj.max_advance_percentage), 10) : Number(proj.max_advance_percentage);
  const capPaise = Math.floor(b.total_price_paise * capPct / 100);
  if (amountPaise > capPaise) throw badRequest('ADVANCE_EXCEEDS_CAP', {cap_paise: capPaise});
  if (amountPaise < await config.int('min_advance_paise')) throw badRequest('ADVANCE_BELOW_MIN');

  const order = await gateway.createOrder({amountPaise, currency:'INR',
      receipt: bookingId, notes: {booking_id: bookingId, plot_id: b.plot_id}});
  const payment = await db.transaction(async tx => {
    const p = await tx.insert('payments', {booking_id: bookingId, gateway: env.PAYMENT_GATEWAY,
        gateway_order_id: order.gatewayOrderId, amount_paise: amountPaise,
        status: 'CREATED', idempotency_key: idemKey});
    await tx.query(`UPDATE bookings SET advance_amount_paise=$1 WHERE id=$2`,
                   [amountPaise, bookingId]);
    await audit.log(tx, userId, 'CUSTOMER', 'payment.order_created', 'booking', bookingId,
                    null, {payment_id: p.id, amount_paise: amountPaise});
    return p;
  });
  return {...payment, gateway_key_id: env.PG_KEY_ID};                   // 201
}
```
Ordering note: the gateway call happens *before* the local insert; if the insert fails, an
orphan gateway order exists but is harmless (never paid → auto-voids). Never the reverse
(local row pointing at no order).

## 5. Webhook — `POST /webhooks/payments/razorpay` (Invariants 4, 7)

The **only** code path that confirms a booking. Route uses the raw request body.

```
1. verify signature over RAW body (adapter). Invalid →
     insert webhook_events(signature_valid=false, outcome='INVALID_SIGNATURE') best-effort;
     return 400. (Gateway retries; a real event will come back.)
2. parse → {eventId, eventType, gatewayPaymentId, gatewayOrderId, amountPaise, currency}
3. INSERT INTO webhook_events(gateway, event_id, …, outcome='RECEIVED')
     ON CONFLICT (gateway, event_id) DO NOTHING;
   → conflict? return 200 (duplicate delivery, already handled/being handled).
4. eventType not in {payment.captured, payment.failed} → outcome='IGNORED'; return 200.
5. Load payment by gateway_order_id.
   Missing → outcome='MANUAL_REVIEW'; alert FINANCE; return 200.
6. If payments row already has this gateway_payment_id with status SUCCESS →
   outcome='DUPLICATE'; return 200.        (idempotency on gateway_payment_id)
7. payment.captured:
   a. amount/currency mismatch (amountPaise !== payment.amount_paise OR currency !== 'INR'):
      TX: payment.status='MANUAL_REVIEW' (store raw), booking.status='MANUAL_REVIEW'
          (plot stays locked by the active-status index), audit('SYSTEM').
      outcome='MANUAL_REVIEW'; alert FINANCE; return 200.
   b. booking still BLOCKED (even if expires_at just passed but no one expired it yet — money
      arrived in time, honor it):
      TX: payment.status='SUCCESS', gateway_payment_id, receipt_number = next 'DHN-YYYY-NNNNNN'
              (from a Postgres sequence, formatted);
          booking.status='BOOKED', confirmed_at=now();
          plot.status='BOOKED' (guard: WHERE status='BLOCKED');
          audit('SYSTEM','booking.confirm').
      after commit: cancel expiry + reminder jobs, DEL redis hold key,
          push 'booking_confirmed' + SMS receipt. outcome='PROCESSED'; return 200.
   c. booking EXPIRED/CANCELLED (money arrived late, plot may already be re-blocked by someone
      else): TX: payment.status='MANUAL_REVIEW', booking.status='MANUAL_REVIEW' ONLY IF the
      unique-active index permits (plot re-blocked by another → leave booking status, flag via
      payments only); audit. outcome='MANUAL_REVIEW'; alert FINANCE (resolution = MC action 5:
      re-confirm if plot free, else refund). return 200.
8. payment.failed:
   payment.status='FAILED' (+failure_reason). Booking STAYS 'BLOCKED' until natural expiry —
   the customer may retry with a fresh payment-order. outcome='PROCESSED'; return 200.
9. Any unexpected exception after step 3 → rethrow 500 WITHOUT marking the event processed;
   gateway retry + step 3/6 dedup make the retry safe.
```

**Client side (Flutter):** checkout callback → "processing" screen → poll `GET /bookings/{id}`
every 3 s (max 2 min) → BOOKED → success screen; timeout → "we'll notify you" (push arrives on
webhook). The callback carries no authority.

## 6. Reminders & notifications

BullMQ `hold-reminder` jobs at `expires_at − 360min` and `− 60min` (config
`reminder_offsets_minutes`). Job re-reads the booking; sends only if still `BLOCKED` and unpaid.
Templates: `hold_created`, `hold_reminder_6h`, `hold_reminder_1h`, `hold_expired`,
`booking_confirmed` (+receipt link), `booking_cancelled`. Every send recorded in
`notifications`; failures logged, never retried into duplicates (job-id = `${booking}:${offset}`).

## 7. Reconciliation (daily, worker)

Nightly job (02:00 IST):
1. Fetch previous day's settlements/payments from the gateway (adapter method
   `listPayments(from,to)`; CSV upload endpoint as fallback).
2. Create `reconciliation_runs` row (unique per date; rerun = upsert + wipe items).
3. For each gateway record: match `payments.gateway_payment_id`.
   - match + equal amount → item MATCHED.
   - match + different amount → AMOUNT_MISMATCH → payment & booking → MANUAL_REVIEW.
   - no local row → UNKNOWN_PAYMENT → MANUAL_REVIEW alert.
4. Reverse pass: local SUCCESS payments in the window absent from gateway list →
   MISSING_AT_GATEWAY → alert (do NOT auto-downgrade a SUCCESS).
5. Summary → FINANCE (email/notification): matched/unmatched counts. Unmatched > 0 pages.
