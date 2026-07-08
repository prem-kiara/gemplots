import { Injectable } from '@nestjs/common';
import { DbService, isUniqueViolation } from '../../common/db/db.service';
import { ConfigService } from '../../common/config/config.service';
import { AuditService } from '../../common/audit/audit.service';
import { RedisService } from '../../common/redis/redis.service';
import { EmailService } from '../../common/email/email.service';
import { Err } from '../../common/errors';
import { ExpiryService } from './expiry.service';
import { NotificationService } from '../notification/notification.service';
import { OtpService } from '../auth/otp.service';

/** Response shape for the reserve endpoint (08 §5 step 1 + docs/10 §7.3). */
export interface ReserveResult {
  booking_id: string;
  plot_id: string;
  status: string;
  plot_number: string;
  project_name: string;
  total_price_paise: number;
  blocked_at: string;
  expires_at: string;
  challenge_id: string;
  dev_otp?: string;
  replay?: boolean;
}

@Injectable()
export class BookingService {
  constructor(
    private readonly db: DbService,
    private readonly config: ConfigService,
    private readonly audit: AuditService,
    private readonly redis: RedisService,
    private readonly expiry: ExpiryService,
    private readonly notify: NotificationService,
    private readonly email: EmailService,
    private readonly otp: OtpService,
  ) {}

  /**
   * Reserve flow — 08 §5 step 1. Same proven TX shape as the v1 hold engine (CF §2): per-user
   * FOR UPDATE serialization point, in-TX hold-limit re-count, plot lock under AVAILABLE +
   * PUBLISHED, price snapshot, frozen expires_at, unique-index backstop, replay semantics.
   *
   * Difference from block(): the hold-limit now counts only PENDING_CONFIRMATION +
   * PENDING_APPROVAL (a RESERVED booking no longer counts against the active-hold cap), the
   * inserted status is PENDING_CONFIRMATION with a +reserve_otp_minutes deadline, and the
   * post-commit side-effects issue a RESERVE OTP, send the reserve_otp email, and feed the admin.
   */
  async reserve(
    userId: string,
    plotId: string,
    idemKey: string | undefined,
    ctx: { requestId?: string; ip?: string } = {},
  ): Promise<ReserveResult> {
    if (!idemKey) throw Err.badRequest('IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key required');

    // 1. Replay?
    const existing = await this.findByUserAndKey(userId, idemKey);
    if (existing) {
      if (existing.plot_id !== plotId) throw Err.conflict('IDEMPOTENCY_CONFLICT', 'Key reused');
      // A replay returns the original booking. We DO NOT re-issue a fresh OTP — the customer
      // uses resend-otp for that — so the replay carries no challenge/dev_otp.
      return this.toResult(existing, true, null, null);
    }

    // 2. Cheap pre-checks (DB constraints are the real guard).
    const user = (
      await this.db.query(`SELECT status, email FROM users WHERE id=$1`, [userId])
    ).rows[0];
    if (!user) throw Err.unauthorized('UNAUTHENTICATED', 'Unknown user');
    if (user.status === 'BLOCKED') throw Err.forbidden('USER_BLOCKED', 'User blocked');

    const maxHolds = await this.config.int('max_active_holds_per_user');
    // Fast, friendly pre-check outside the TX. NOT authoritative — the same count is re-run inside
    // the TX under a per-user row lock (F4). The active-hold cap counts only pending reservations.
    const active = Number(
      (
        await this.db.query(
          `SELECT count(*)::int AS n FROM bookings
             WHERE user_id=$1 AND status IN ('PENDING_CONFIRMATION','PENDING_APPROVAL')`,
          [userId],
        )
      ).rows[0].n,
    );
    if (active >= maxHolds)
      throw Err.conflict('HOLD_LIMIT_EXCEEDED', 'Active hold limit reached', {
        max_active_holds: maxHolds,
      });

    // Friendlier duplicate message when this user already actively holds this plot.
    const dup = await this.db.query(
      `SELECT 1 FROM bookings WHERE user_id=$1 AND plot_id=$2
         AND status IN ('PENDING_CONFIRMATION','PENDING_APPROVAL','RESERVED')`,
      [userId, plotId],
    );
    if (dup.rowCount && dup.rowCount > 0)
      throw Err.conflict('DUPLICATE_ACTIVE_HOLD', 'You already hold this plot');

    // 3. The transaction (Invariants 2, 3, 5′).
    const otpMinutes = await this.config.int('reserve_otp_minutes');
    let booking;
    try {
      booking = await this.db.tx(async (tx) => {
        // F4 — serialize this user's concurrent reserves on their own row (locked BEFORE the
        // plot, a consistent lock order → no deadlock), then re-count active holds authoritatively.
        await tx.query(`SELECT id FROM users WHERE id=$1 FOR UPDATE`, [userId]);
        const activeNow = Number(
          (
            await tx.query(
              `SELECT count(*)::int AS n FROM bookings
                 WHERE user_id=$1 AND status IN ('PENDING_CONFIRMATION','PENDING_APPROVAL')`,
              [userId],
            )
          ).rows[0].n,
        );
        if (activeNow >= maxHolds)
          throw Err.conflict('HOLD_LIMIT_EXCEEDED', 'Active hold limit reached', {
            max_active_holds: maxHolds,
          });

        const locked = await tx.query(
          `SELECT p.id, p.price_paise, p.plot_number, pr.name AS project_name
             FROM plots p JOIN projects pr ON pr.id = p.project_id
            WHERE p.id = $1 AND p.status = 'AVAILABLE' AND pr.status = 'PUBLISHED'
            FOR UPDATE OF p`,
          [plotId],
        );
        if (locked.rowCount === 0) {
          const exists = await tx.query(
            `SELECT 1 FROM plots p JOIN projects pr ON pr.id=p.project_id
              WHERE p.id=$1 AND pr.status='PUBLISHED'`,
            [plotId],
          );
          throw exists.rowCount
            ? Err.conflict('PLOT_UNAVAILABLE', 'Plot not available')
            : Err.notFound('PLOT_NOT_FOUND', 'Plot not found');
        }
        const p = locked.rows[0];
        const b = (
          await tx.query(
            `INSERT INTO bookings
               (plot_id, user_id, status, total_price_paise, hold_minutes, expires_at, idempotency_key)
             VALUES ($1,$2,'PENDING_CONFIRMATION',$3,$4, now() + make_interval(mins => $4), $5)
             RETURNING *`,
            [plotId, userId, p.price_paise, otpMinutes, idemKey],
          )
        ).rows[0];
        await tx.query(`UPDATE plots SET status='ON_HOLD' WHERE id=$1`, [plotId]);
        await this.audit.log(
          tx,
          { id: userId, role: 'CUSTOMER', requestId: ctx.requestId, ip: ctx.ip },
          'booking.reserve',
          'plot',
          plotId,
          { status: 'AVAILABLE' },
          { status: 'ON_HOLD', booking_id: b.id },
        );
        // Carry the plot/project facts out of the TX for the response + email.
        b.plot_number = p.plot_number;
        b.project_name = p.project_name;
        return b;
      });
    } catch (e: any) {
      // A concurrent request with the SAME (user, idempotency_key) may have committed first — a
      // replay, not a failure — whether this attempt lost the row lock (in-TX PLOT_UNAVAILABLE) or
      // tripped the unique index. Always resolve replay BEFORE mapping any error (KNOWN BUG PATTERN).
      const replay = await this.findByUserAndKey(userId, idemKey);
      if (replay && replay.plot_id === plotId) return this.toResult(replay, true, null, null);
      if (isUniqueViolation(e, 'uniq_active_booking_per_plot'))
        throw Err.conflict('PLOT_UNAVAILABLE', 'Plot not available');
      throw e;
    }

    // 4. After commit — best-effort, never rolls back the reservation (08 §5 step 1).
    const ttl = booking.hold_minutes * 60;
    await this.redis.setHold(booking.id, plotId, ttl);

    // Issue the RESERVE OTP (otp.service auto-sends only LOGIN; we send reserve_otp ourselves).
    const challenge = await this.otp.request(user.email, 'RESERVE', booking.id);
    await this.email.send(user.email, 'reserve_otp', {
      otp: challenge.otp,
      plot_number: booking.plot_number,
    });

    await this.notify.feed(
      'ADMIN',
      'RESERVATION_REQUESTED',
      `${user.email} requested ${booking.plot_number} in ${booking.project_name}`,
      '',
      'booking',
      booking.id,
    );

    // Invariant 12 — dev_otp is double-gated: console driver AND non-production.
    const consoleMode = (process.env.EMAIL_MODE ?? 'console') === 'console';
    const nonProd = process.env.NODE_ENV !== 'production';
    const devOtp = consoleMode && nonProd ? challenge.otp : null;

    return this.toResult(booking, false, challenge.challengeId, devOtp);
  }

  async findByUserAndKey(userId: string, idemKey: string) {
    return (
      await this.db.query(`SELECT * FROM bookings WHERE user_id=$1 AND idempotency_key=$2`, [
        userId,
        idemKey,
      ])
    ).rows[0];
  }

  private async toResult(
    b: any,
    replay: boolean,
    challengeId: string | null,
    devOtp: string | null,
  ): Promise<ReserveResult> {
    // A replay branch (no plot/project facts carried out of the TX) fetches them here.
    let plotNumber = b.plot_number;
    let projectName = b.project_name;
    if (plotNumber === undefined || projectName === undefined) {
      const row = (
        await this.db.query(
          `SELECT p.plot_number, pr.name AS project_name
             FROM plots p JOIN projects pr ON pr.id=p.project_id WHERE p.id=$1`,
          [b.plot_id],
        )
      ).rows[0];
      plotNumber = row?.plot_number;
      projectName = row?.project_name;
    }
    const out: ReserveResult = {
      booking_id: b.id,
      plot_id: b.plot_id,
      status: b.status,
      plot_number: plotNumber,
      project_name: projectName,
      total_price_paise: Number(b.total_price_paise),
      blocked_at: new Date(b.blocked_at).toISOString(),
      expires_at: new Date(b.expires_at).toISOString(),
      challenge_id: challengeId ?? '',
      replay,
    };
    if (challengeId === null) delete (out as any).challenge_id;
    if (devOtp !== null) out.dev_otp = devOtp;
    return out;
  }
}
