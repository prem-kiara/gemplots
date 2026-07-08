import { INestApplication } from '@nestjs/common';
import { createHmac, randomUUID } from 'crypto';
import {
  makeApp,
  db,
  resetDynamic,
  firstPlotId,
  makeCustomers,
  makeDormantBlockedBooking,
  closeAdminPool,
} from './harness';
import { BookingReadService } from '../src/modules/booking/booking-read.service';
import { PaymentService } from '../src/modules/payment/payment.service';

const SECRET = 'test-whsec'; // matches PG_WEBHOOK_SECRET in test/setup.ts

function signedWebhook(opts: {
  event: 'payment.captured' | 'payment.failed';
  orderId: string;
  amountPaise: number;
  currency?: string;
  paymentId?: string;
  eventId?: string;
}) {
  const body = {
    id: opts.eventId ?? `evt_${randomUUID()}`,
    event: opts.event,
    payload: {
      payment: {
        entity: {
          id: opts.paymentId ?? `pay_${randomUUID()}`,
          order_id: opts.orderId,
          amount: opts.amountPaise,
          currency: opts.currency ?? 'INR',
        },
      },
    },
  };
  const raw = Buffer.from(JSON.stringify(body));
  const sig = createHmac('sha256', SECRET).update(raw).digest('hex');
  const headers = {
    'x-razorpay-signature': sig,
    'x-razorpay-event-id': body.id,
  };
  return { raw, headers, body };
}

describe('TP §2.3 webhook verification & idempotency', () => {
  let app: INestApplication;
  let payment: PaymentService;
  let reads: BookingReadService;

  beforeAll(async () => {
    app = await makeApp();
    payment = app.get(PaymentService);
    reads = app.get(BookingReadService);
  });
  afterAll(async () => {
    await app.close();
    await closeAdminPool();
  });
  beforeEach(async () => await resetDynamic(app));

  async function blockAndOrder(amount?: number) {
    const plotId = await firstPlotId(app);
    const [userId] = await makeCustomers(app, 1);
    const bookingId = await makeDormantBlockedBooking(app, userId, plotId);
    const amt = amount ?? 18000000; // 10% of the seed plot's 180000000 price
    const order = await payment.createOrder(userId, bookingId, amt, randomUUID());
    return { userId, plotId, bookingId, amount: amt, orderId: order.gateway_order_id };
  }

  it('(a) valid captured → payment SUCCESS, booking + plot BOOKED, receipt issued (atomic)', async () => {
    const o = await blockAndOrder();
    const wh = signedWebhook({ event: 'payment.captured', orderId: o.orderId, amountPaise: o.amount });
    const res = await payment.handleWebhook(wh.raw, wh.headers);
    expect(res.http).toBe(200);

    const p = await db(app).query(`SELECT * FROM payments WHERE gateway_order_id=$1`, [o.orderId]);
    expect(p.rows[0].status).toBe('SUCCESS');
    expect(p.rows[0].receipt_number).toMatch(/^GEM-\d{4}-\d{6}$/);
    const b = await db(app).query(`SELECT status FROM bookings WHERE id=$1`, [o.bookingId]);
    expect(b.rows[0].status).toBe('BOOKED');
    const plot = await db(app).query(`SELECT status FROM plots WHERE id=$1`, [o.plotId]);
    expect(plot.rows[0].status).toBe('BOOKED');
  });

  it('(b) same event_id twice → second is a no-op, one webhook_events row', async () => {
    const o = await blockAndOrder();
    const wh = signedWebhook({ event: 'payment.captured', orderId: o.orderId, amountPaise: o.amount });
    await payment.handleWebhook(wh.raw, wh.headers);
    await payment.handleWebhook(wh.raw, wh.headers); // duplicate delivery

    const ev = await db(app).query(`SELECT count(*)::int n FROM webhook_events WHERE event_id=$1`, [
      wh.body.id,
    ]);
    expect(ev.rows[0].n).toBe(1);
    const conf = await db(app).query(
      `SELECT count(*)::int n FROM audit_logs WHERE action='booking.confirm' AND entity_id=$1`,
      [o.bookingId],
    );
    expect(conf.rows[0].n).toBe(1); // confirmed exactly once
  });

  it('(c) same payment id, different event id → deduped on gateway_payment_id, no double confirm', async () => {
    const o = await blockAndOrder();
    const payId = `pay_${randomUUID()}`;
    const w1 = signedWebhook({ event: 'payment.captured', orderId: o.orderId, amountPaise: o.amount, paymentId: payId });
    const w2 = signedWebhook({ event: 'payment.captured', orderId: o.orderId, amountPaise: o.amount, paymentId: payId });
    await payment.handleWebhook(w1.raw, w1.headers);
    const res2 = await payment.handleWebhook(w2.raw, w2.headers);
    expect(res2.http).toBe(200);
    const conf = await db(app).query(
      `SELECT count(*)::int n FROM audit_logs WHERE action='booking.confirm' AND entity_id=$1`,
      [o.bookingId],
    );
    expect(conf.rows[0].n).toBe(1);
    const ev2 = await db(app).query(`SELECT outcome FROM webhook_events WHERE event_id=$1`, [w2.body.id]);
    expect(ev2.rows[0].outcome).toBe('DUPLICATE');
  });

  it('(d) bad signature → 400, no state change, webhook_events row signature_valid=false', async () => {
    const o = await blockAndOrder();
    const wh = signedWebhook({ event: 'payment.captured', orderId: o.orderId, amountPaise: o.amount });
    const res = await payment.handleWebhook(wh.raw, { ...wh.headers, 'x-razorpay-signature': 'deadbeef' });
    expect(res.http).toBe(400);
    const b = await db(app).query(`SELECT status FROM bookings WHERE id=$1`, [o.bookingId]);
    expect(b.rows[0].status).toBe('BLOCKED'); // untouched
    const ev = await db(app).query(
      `SELECT signature_valid, outcome FROM webhook_events WHERE event_id=$1`,
      [wh.body.id],
    );
    expect(ev.rows[0].signature_valid).toBe(false);
    expect(ev.rows[0].outcome).toBe('INVALID_SIGNATURE');
  });

  it('(e) amount mismatch → payment + booking MANUAL_REVIEW, plot stays held', async () => {
    const o = await blockAndOrder();
    const wh = signedWebhook({ event: 'payment.captured', orderId: o.orderId, amountPaise: o.amount - 1 });
    await payment.handleWebhook(wh.raw, wh.headers);
    const p = await db(app).query(`SELECT status FROM payments WHERE gateway_order_id=$1`, [o.orderId]);
    expect(p.rows[0].status).toBe('MANUAL_REVIEW');
    const b = await db(app).query(`SELECT status FROM bookings WHERE id=$1`, [o.bookingId]);
    expect(b.rows[0].status).toBe('MANUAL_REVIEW');
    const plot = await db(app).query(`SELECT status FROM plots WHERE id=$1`, [o.plotId]);
    expect(plot.rows[0].status).toBe('BLOCKED'); // still held by the active-status index
  });

  it('(f) payment.failed → payment FAILED, booking stays BLOCKED (retryable)', async () => {
    const o = await blockAndOrder();
    const wh = signedWebhook({ event: 'payment.failed', orderId: o.orderId, amountPaise: o.amount });
    await payment.handleWebhook(wh.raw, wh.headers);
    const p = await db(app).query(`SELECT status FROM payments WHERE gateway_order_id=$1`, [o.orderId]);
    expect(p.rows[0].status).toBe('FAILED');
    const b = await db(app).query(`SELECT status FROM bookings WHERE id=$1`, [o.bookingId]);
    expect(b.rows[0].status).toBe('BLOCKED');
  });

  it('(g) late capture (booking EXPIRED) → MANUAL_REVIEW, never auto-BOOKED', async () => {
    const o = await blockAndOrder();
    await db(app).query(`UPDATE bookings SET status='EXPIRED', closed_at=now() WHERE id=$1`, [o.bookingId]);
    await db(app).query(`UPDATE plots SET status='AVAILABLE' WHERE id=$1`, [o.plotId]);
    const wh = signedWebhook({ event: 'payment.captured', orderId: o.orderId, amountPaise: o.amount });
    await payment.handleWebhook(wh.raw, wh.headers);
    const b = await db(app).query(`SELECT status FROM bookings WHERE id=$1`, [o.bookingId]);
    expect(b.rows[0].status).not.toBe('BOOKED');
    const p = await db(app).query(`SELECT status FROM payments WHERE gateway_order_id=$1`, [o.orderId]);
    expect(p.rows[0].status).toBe('MANUAL_REVIEW');
  });

  it('(h) Invariant 7: reading the booking never confirms it (only the webhook does)', async () => {
    const o = await blockAndOrder();
    for (let i = 0; i < 3; i++) {
      const view = await reads.getById(o.bookingId, { id: o.userId, role: 'CUSTOMER' });
      expect(view.status).toBe('BLOCKED');
    }
    const b = await db(app).query(`SELECT status FROM bookings WHERE id=$1`, [o.bookingId]);
    expect(b.rows[0].status).toBe('BLOCKED');
  });
});
