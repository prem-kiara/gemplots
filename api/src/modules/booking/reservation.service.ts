import { Injectable } from '@nestjs/common';
import { DbService } from '../../common/db/db.service';
import { ConfigService } from '../../common/config/config.service';
import { AuditService } from '../../common/audit/audit.service';
import { RedisService } from '../../common/redis/redis.service';
import { EmailService } from '../../common/email/email.service';
import { Err } from '../../common/errors';
import { ExpiryService } from './expiry.service';
import { NotificationService } from '../notification/notification.service';
import { OtpService } from '../auth/otp.service';

/**
 * Reservation confirm + resend-otp (08 §5 step 2, docs/10 §5.3.2). The customer-facing half of the
 * reserve flow: OTP verification moves a booking PENDING_CONFIRMATION → PENDING_APPROVAL and files
 * the RESERVE_PLOT approval row. Nothing here ever sets RESERVED (Invariant 7′).
 */
@Injectable()
export class ReservationService {
  constructor(
    private readonly db: DbService,
    private readonly config: ConfigService,
    private readonly audit: AuditService,
    private readonly redis: RedisService,
    private readonly email: EmailService,
    private readonly expiry: ExpiryService,
    private readonly notify: NotificationService,
    private readonly otp: OtpService,
  ) {}

  /** Load a booking with owner + plot/project/customer facts, after lazy repair. */
  private async loadBooking(bookingId: string, requester: { id: string }) {
    await this.expiry.repairBooking(bookingId);
    const b = (
      await this.db.query(
        `SELECT b.*, p.plot_number, p.project_id, pr.name AS project_name,
                u.email AS customer_email, u.full_name AS customer_name, u.phone AS customer_phone
           FROM bookings b
           JOIN plots p ON p.id = b.plot_id
           JOIN projects pr ON pr.id = p.project_id
           JOIN users u ON u.id = b.user_id
          WHERE b.id = $1`,
        [bookingId],
      )
    ).rows[0];
    if (!b) throw Err.notFound('BOOKING_NOT_FOUND', 'Booking not found');
    if (b.user_id !== requester.id) throw Err.forbidden('NOT_BOOKING_OWNER', 'Not your booking');
    return b;
  }

  /**
   * Confirm — 08 §5 step 2. Verify the RESERVE OTP, then in ONE TX flip
   * PENDING_CONFIRMATION → PENDING_APPROVAL, set reserve_confirmed_at, set the +admin_decision_hours
   * deadline at state entry (Invariant 5′), and file the RESERVE_PLOT approval row.
   */
  async confirm(
    bookingId: string,
    challengeId: string,
    otp: string,
    requester: { id: string },
    ctx: { requestId?: string; ip?: string } = {},
  ) {
    const b = await this.loadBooking(bookingId, requester);

    if (b.status !== 'PENDING_CONFIRMATION' || new Date(b.expires_at) <= new Date())
      throw Err.conflict('RESERVATION_NOT_PENDING', 'Reservation not pending confirmation');

    // Verify BEFORE the TX (its own short TX). Throws OTP_* / OTP_PURPOSE_MISMATCH on failure.
    await this.otp.verify(challengeId, b.customer_email, otp, {
      purpose: 'RESERVE',
      bookingId,
    });

    const decisionHours = await this.config.int('admin_decision_hours');

    const outcome = await this.db.tx<
      { kind: 'ok'; approvalId: string } | { kind: 'not_pending' }
    >(async (tx) => {
      const upd = await tx.query(
        `UPDATE bookings
            SET status='PENDING_APPROVAL',
                reserve_confirmed_at=now(),
                expires_at = now() + make_interval(hours => $2)
          WHERE id=$1 AND status='PENDING_CONFIRMATION'
          RETURNING *`,
        [bookingId, decisionHours],
      );
      if (upd.rowCount === 0) return { kind: 'not_pending' };
      const nb = upd.rows[0];

      const snapshot = {
        booking: {
          id: b.id,
          plot_id: b.plot_id,
          status: 'PENDING_APPROVAL',
          total_price_paise: Number(b.total_price_paise),
        },
        plot: {
          id: b.plot_id,
          plot_number: b.plot_number,
          project_id: b.project_id,
          project_name: b.project_name,
        },
        customer: {
          id: b.user_id,
          name: b.customer_name,
          email: b.customer_email,
          phone: b.customer_phone,
        },
        reserve_confirmed_at: new Date(nb.reserve_confirmed_at).toISOString(),
      };

      const approval = (
        await tx.query(
          `INSERT INTO approvals
             (action, entity_type, entity_id, payload, snapshot, reason, requested_by)
           VALUES ('RESERVE_PLOT','booking',$1,$2,$3,$4,$5)
           RETURNING id`,
          [bookingId, '{}', JSON.stringify(snapshot), 'Customer reservation request', b.user_id],
        )
      ).rows[0];

      await this.audit.log(
        tx,
        { id: b.user_id, role: 'CUSTOMER', requestId: ctx.requestId, ip: ctx.ip },
        'booking.confirm_request',
        'booking',
        bookingId,
        { status: 'PENDING_CONFIRMATION' },
        { status: 'PENDING_APPROVAL', approval_id: approval.id },
      );
      return { kind: 'ok', approvalId: approval.id };
    });

    if (outcome.kind === 'not_pending')
      throw Err.conflict('RESERVATION_NOT_PENDING', 'Reservation not pending confirmation');

    // Post-commit — best-effort, never rolls back the confirmation.
    const adminAlert = process.env.ADMIN_ALERT_EMAIL ?? 'admin@gemhousing.in';
    await this.email.send(adminAlert, 'reservation_requested_admin', {
      customer_email: b.customer_email,
      plot_number: b.plot_number,
      project_name: b.project_name,
      approval_id: outcome.approvalId,
    });
    await this.email.send(b.customer_email, 'reservation_received', {
      plot_number: b.plot_number,
      project_name: b.project_name,
    });
    await this.notify.feed(
      'ADMIN',
      'RESERVATION_CONFIRMED',
      `${b.customer_email} confirmed ${b.plot_number} in ${b.project_name} — approval needed`,
      '',
      'approval',
      outcome.approvalId,
    );

    // Reschedule the Redis hold key to the admin-decision window.
    await this.redis.setHold(bookingId, b.plot_id, decisionHours * 3600);

    return {
      booking_id: bookingId,
      status: 'PENDING_APPROVAL',
      approval_id: outcome.approvalId,
      expires_at: new Date(
        (await this.db.query(`SELECT expires_at FROM bookings WHERE id=$1`, [bookingId])).rows[0]
          .expires_at,
      ).toISOString(),
    };
  }

  /**
   * Resend the RESERVE OTP — docs/10 §5.3.2. Owner-only; the booking must still be
   * PENDING_CONFIRMATION and unexpired. Issues a fresh RESERVE challenge under the same email rate
   * limits (otp.request throws OTP_RATE_LIMITED) and re-sends the reserve_otp email.
   */
  async resendOtp(bookingId: string, requester: { id: string }) {
    const b = await this.loadBooking(bookingId, requester);
    if (b.status !== 'PENDING_CONFIRMATION' || new Date(b.expires_at) <= new Date())
      throw Err.conflict('RESERVATION_NOT_PENDING', 'Reservation not pending confirmation');

    const challenge = await this.otp.request(b.customer_email, 'RESERVE', bookingId);
    await this.email.send(b.customer_email, 'reserve_otp', {
      otp: challenge.otp,
      plot_number: b.plot_number,
    });

    const consoleMode = (process.env.EMAIL_MODE ?? 'console') === 'console';
    const nonProd = process.env.NODE_ENV !== 'production';
    const devOtp = consoleMode && nonProd ? challenge.otp : undefined;

    return {
      challenge_id: challenge.challengeId,
      retry_after_seconds: challenge.retryAfterSeconds,
      ...(devOtp !== undefined ? { dev_otp: devOtp } : {}),
    };
  }
}
