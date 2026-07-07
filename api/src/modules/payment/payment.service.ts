import { Inject, Injectable, Logger } from '@nestjs/common';
import { DbService } from '../../common/db/db.service';
import { ConfigService } from '../../common/config/config.service';
import { AuditService, SYSTEM_ACTOR } from '../../common/audit/audit.service';
import { Err } from '../../common/errors';
import { advanceCapPaise, effectiveCapPct, formatReceipt } from '../../common/util';
import { ExpiryService } from '../booking/expiry.service';
import { NotificationService } from '../notification/notification.service';
import { GATEWAY, PaymentGatewayAdapter } from './gateway/adapter';

@Injectable()
export class PaymentService {
  private readonly logger = new Logger('Payment');

  constructor(
    private readonly db: DbService,
    private readonly config: ConfigService,
    private readonly audit: AuditService,
    private readonly expiry: ExpiryService,
    private readonly notify: NotificationService,
    @Inject(GATEWAY) private readonly gateway: PaymentGatewayAdapter,
  ) {}

  /** Payment order — CF §4.2. Lazy repair, ownership, status, replay, integer RERA cap. */
  async createOrder(
    userId: string,
    bookingId: string,
    amountPaise: number,
    idemKey: string | undefined,
    ctx: { requestId?: string; ip?: string } = {},
  ) {
    if (!idemKey) throw Err.badRequest('IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key required');
    await this.expiry.repairBooking(bookingId);

    const b = (await this.db.query(`SELECT * FROM bookings WHERE id=$1`, [bookingId])).rows[0];
    if (!b) throw Err.notFound('BOOKING_NOT_FOUND', 'Booking not found');
    if (b.user_id !== userId) throw Err.forbidden('NOT_BOOKING_OWNER', 'Not your booking');
    if (b.status !== 'BLOCKED') throw Err.conflict('BOOKING_NOT_BLOCKED', 'Booking not blocked');

    const replay = (
      await this.db.query(
        `SELECT * FROM payments WHERE booking_id=$1 AND idempotency_key=$2`,
        [bookingId, idemKey],
      )
    ).rows[0];
    if (replay) {
      if (Number(replay.amount_paise) !== amountPaise)
        throw Err.conflict('IDEMPOTENCY_CONFLICT', 'Key reused with different amount');
      return this.orderResult(replay);
    }

    const proj = (
      await this.db.query(
        `SELECT pr.max_advance_percentage, pr.rera_registered
           FROM plots p JOIN projects pr ON pr.id=p.project_id WHERE p.id=$1`,
        [b.plot_id],
      )
    ).rows[0];
    const capPct = effectiveCapPct(Number(proj.max_advance_percentage), proj.rera_registered);
    const capPaise = advanceCapPaise(Number(b.total_price_paise), capPct);
    if (amountPaise > capPaise)
      throw Err.badRequest('ADVANCE_EXCEEDS_CAP', 'Advance exceeds cap', { cap_paise: capPaise });
    const minAdvance = await this.config.int('min_advance_paise');
    if (amountPaise < minAdvance)
      throw Err.badRequest('ADVANCE_BELOW_MIN', 'Advance below minimum', {
        min_advance_paise: minAdvance,
      });

    // Gateway first, then local insert (CF §4.2 ordering note).
    const order = await this.gateway.createOrder({
      amountPaise,
      currency: 'INR',
      receipt: bookingId,
      notes: { booking_id: bookingId, plot_id: b.plot_id },
    });

    const payment = await this.db.tx(async (tx) => {
      const p = (
        await tx.query(
          `INSERT INTO payments
             (booking_id, gateway, gateway_order_id, amount_paise, status, idempotency_key)
           VALUES ($1,$2,$3,$4,'CREATED',$5) RETURNING *`,
          [bookingId, this.gateway.name, order.gatewayOrderId, amountPaise, idemKey],
        )
      ).rows[0];
      await tx.query(`UPDATE bookings SET advance_amount_paise=$1 WHERE id=$2`, [
        amountPaise,
        bookingId,
      ]);
      await this.audit.log(
        tx,
        { id: userId, role: 'CUSTOMER', requestId: ctx.requestId, ip: ctx.ip },
        'payment.order_created',
        'booking',
        bookingId,
        null,
        { payment_id: p.id, amount_paise: amountPaise },
      );
      return p;
    });
    return this.orderResult(payment);
  }

  private orderResult(p: any) {
    return {
      payment_id: p.id,
      gateway: p.gateway,
      gateway_order_id: p.gateway_order_id,
      gateway_key_id: process.env.PG_KEY_ID ?? 'rzp_test_xxx',
      amount_paise: Number(p.amount_paise),
      currency: p.currency,
      booking_id: p.booking_id,
    };
  }

  /**
   * Webhook — CF §5. The ONLY path that confirms a booking (Invariant 7). Returns an HTTP-ish
   * result the controller maps to 200/400. Never throws for business outcomes (gateway retries
   * only on 400 = bad signature or an unexpected 500).
   */
  async handleWebhook(
    rawBody: Buffer,
    headers: Record<string, any>,
  ): Promise<{ http: number; body: any }> {
    // 1. Verify signature over RAW body.
    if (!this.gateway.verifyWebhookSignature(rawBody, headers)) {
      await this.recordEvent(this.gateway.name, headerEventId(headers) || `bad_${Date.now()}`, '', null, false, safeJson(rawBody), 'INVALID_SIGNATURE');
      return { http: 400, body: { error: { code: 'INVALID_SIGNATURE', message: 'bad signature' } } };
    }

    // 2. Parse.
    const p = this.gateway.parseWebhook(rawBody);
    const eventId = headerEventId(headers) || p.eventId;

    // 3. Dedup insert (idempotent on (gateway, event_id)).
    const fresh = await this.recordEvent(
      this.gateway.name, eventId, p.eventType, p.gatewayPaymentId, true, p.raw, 'RECEIVED',
    );
    if (!fresh) return ok(); // duplicate delivery

    // 4. Only handle captured/failed.
    if (p.eventType !== 'payment.captured' && p.eventType !== 'payment.failed') {
      await this.finishEvent(eventId, 'IGNORED');
      return ok();
    }

    // 5. Load payment by gateway_order_id.
    const payment = (
      await this.db.query(`SELECT * FROM payments WHERE gateway_order_id=$1`, [p.gatewayOrderId])
    ).rows[0];
    if (!payment) {
      await this.finishEvent(eventId, 'MANUAL_REVIEW');
      this.logger.warn(`webhook for unknown order ${p.gatewayOrderId} → MANUAL_REVIEW`);
      return ok();
    }

    // 6. Already applied this payment id?
    if (payment.gateway_payment_id === p.gatewayPaymentId && payment.status === 'SUCCESS') {
      await this.finishEvent(eventId, 'DUPLICATE');
      return ok();
    }

    if (p.eventType === 'payment.failed') {
      // 8. Failure: mark FAILED, booking stays BLOCKED for retry.
      await this.db.tx(async (tx) => {
        await tx.query(
          `UPDATE payments SET status='FAILED', failure_reason=$2, raw_webhook=$3,
                  gateway_payment_id=COALESCE(gateway_payment_id,$4)
            WHERE id=$1`,
          [payment.id, 'gateway reported failure', JSON.stringify(p.raw), p.gatewayPaymentId],
        );
        await this.audit.log(tx, SYSTEM_ACTOR, 'payment.failed', 'payment', payment.id, null, {
          gateway_payment_id: p.gatewayPaymentId,
        });
      });
      await this.finishEvent(eventId, 'PROCESSED');
      return ok();
    }

    // 7. payment.captured
    const booking = (
      await this.db.query(`SELECT * FROM bookings WHERE id=$1`, [payment.booking_id])
    ).rows[0];

    // 7a. Amount / currency mismatch → MANUAL_REVIEW, plot stays held.
    if (p.amountPaise !== Number(payment.amount_paise) || p.currency !== 'INR') {
      await this.toManualReview(payment, booking, p, 'amount/currency mismatch');
      await this.finishEvent(eventId, 'MANUAL_REVIEW');
      return ok();
    }

    // 7b. Booking still BLOCKED (honor even if expires_at just passed) → confirm.
    if (booking.status === 'BLOCKED') {
      await this.confirm(payment, booking, p);
      await this.finishEvent(eventId, 'PROCESSED');
      await this.notify.cancelHoldJobs(booking.id);
      await this.notify.send(booking.user_id, 'PUSH', 'booking_confirmed', {
        booking_id: booking.id,
      });
      return ok();
    }

    // 7c. Booking EXPIRED/CANCELLED — money arrived late → MANUAL_REVIEW.
    await this.toManualReview(payment, booking, p, `late capture, booking ${booking.status}`);
    await this.finishEvent(eventId, 'MANUAL_REVIEW');
    return ok();
  }

  private async confirm(payment: any, booking: any, p: any) {
    await this.db.tx(async (tx) => {
      const year = new Date().getUTCFullYear();
      const seq = Number((await tx.query(`SELECT nextval('receipt_seq') AS v`)).rows[0].v);
      const receipt = formatReceipt(seq, year);
      await tx.query(
        `UPDATE payments SET status='SUCCESS', gateway_payment_id=$2, receipt_number=$3,
                raw_webhook=$4 WHERE id=$1`,
        [payment.id, p.gatewayPaymentId, receipt, JSON.stringify(p.raw)],
      );
      await tx.query(
        `UPDATE bookings SET status='BOOKED', confirmed_at=now() WHERE id=$1 AND status='BLOCKED'`,
        [booking.id],
      );
      await tx.query(`UPDATE plots SET status='BOOKED' WHERE id=$1 AND status='BLOCKED'`, [
        booking.plot_id,
      ]);
      await this.audit.log(tx, SYSTEM_ACTOR, 'booking.confirm', 'booking', booking.id, {
        status: 'BLOCKED',
      }, { status: 'BOOKED', receipt_number: receipt });
    });
  }

  private async toManualReview(payment: any, booking: any, p: any, reason: string) {
    await this.db.tx(async (tx) => {
      await tx.query(
        `UPDATE payments SET status='MANUAL_REVIEW', gateway_payment_id=COALESCE(gateway_payment_id,$2),
                raw_webhook=$3, failure_reason=$4 WHERE id=$1`,
        [payment.id, p.gatewayPaymentId, JSON.stringify(p.raw), reason],
      );
      // Flag the booking too, but only if the active-booking index permits (plot may be
      // re-blocked by someone else in the late-capture case).
      if (booking.status === 'BLOCKED') {
        await tx.query(`UPDATE bookings SET status='MANUAL_REVIEW' WHERE id=$1 AND status='BLOCKED'`, [
          booking.id,
        ]);
      }
      await this.audit.log(tx, SYSTEM_ACTOR, 'payment.manual_review', 'payment', payment.id, null, {
        reason,
        gateway_payment_id: p.gatewayPaymentId,
      });
    });
    await this.notify.send(booking.user_id, 'PUSH', 'payment_manual_review', {
      booking_id: booking.id,
    });
    this.logger.warn(`payment ${payment.id} → MANUAL_REVIEW (${reason})`);
  }

  private async recordEvent(
    gateway: string,
    eventId: string,
    eventType: string,
    gatewayPaymentId: string | null,
    signatureValid: boolean,
    payload: any,
    outcome: string,
  ): Promise<boolean> {
    const res = await this.db.query(
      `INSERT INTO webhook_events
         (gateway, event_id, event_type, gateway_payment_id, signature_valid, payload, outcome)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (gateway, event_id) DO NOTHING RETURNING id`,
      [gateway, eventId, eventType, gatewayPaymentId, signatureValid, JSON.stringify(payload), outcome],
    );
    return (res.rowCount ?? 0) > 0;
  }

  private async finishEvent(eventId: string, outcome: string) {
    await this.db.query(
      `UPDATE webhook_events SET outcome=$2, processed_at=now()
        WHERE gateway=$1 AND event_id=$3`,
      [this.gateway.name, outcome, eventId],
    );
  }
}

function headerEventId(headers: Record<string, any>): string {
  return String(headers['x-razorpay-event-id'] ?? '');
}
function ok() {
  return { http: 200, body: { status: 'ok' } };
}
function safeJson(buf: Buffer): any {
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    return { unparseable: true };
  }
}
