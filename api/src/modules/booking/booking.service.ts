import { Injectable } from '@nestjs/common';
import { DbService, isUniqueViolation } from '../../common/db/db.service';
import { ConfigService } from '../../common/config/config.service';
import { AuditService } from '../../common/audit/audit.service';
import { RedisService } from '../../common/redis/redis.service';
import { Err } from '../../common/errors';
import { advanceCapPaise, effectiveCapPct } from '../../common/util';
import { ExpiryService } from './expiry.service';
import { NotificationService } from '../notification/notification.service';

export interface BlockResult {
  booking_id: string;
  plot_id: string;
  status: string;
  total_price_paise: number;
  advance_cap_paise: number;
  min_advance_paise: number;
  blocked_at: string;
  expires_at: string;
  hold_minutes: number;
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
  ) {}

  /** Hold engine — CF §2. Follows the pseudocode literally: replay, pre-checks, one TX with
   *  FOR UPDATE + status filter, price snapshot, frozen expires_at, unique-violation backstop. */
  async block(
    userId: string,
    plotId: string,
    idemKey: string | undefined,
    ctx: { requestId?: string; ip?: string } = {},
  ): Promise<BlockResult> {
    if (!idemKey) throw Err.badRequest('IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key required');

    // 1. Replay?
    const existing = await this.findByUserAndKey(userId, idemKey);
    if (existing) {
      if (existing.plot_id !== plotId) throw Err.conflict('IDEMPOTENCY_CONFLICT', 'Key reused');
      return this.toResult(existing, true);
    }

    // 2. Cheap pre-checks (DB constraints are the real guard).
    const user = (await this.db.query(`SELECT status FROM users WHERE id=$1`, [userId])).rows[0];
    if (!user) throw Err.unauthorized('UNAUTHENTICATED', 'Unknown user');
    if (user.status === 'BLOCKED') throw Err.forbidden('USER_BLOCKED', 'User blocked');

    const maxHolds = await this.config.int('max_active_holds_per_user');
    // Fast, friendly pre-check outside the TX. NOT authoritative — the same count is re-run
    // inside the TX under a per-user row lock (F4) so concurrent blocks can't overshoot the cap.
    const active = Number(
      (
        await this.db.query(
          `SELECT count(*)::int AS n FROM bookings WHERE user_id=$1 AND status='BLOCKED'`,
          [userId],
        )
      ).rows[0].n,
    );
    if (active >= maxHolds)
      throw Err.conflict('HOLD_LIMIT_EXCEEDED', 'Active hold limit reached', {
        max_active_holds: maxHolds,
      });

    // Friendlier duplicate-hold message when this user already actively holds this plot.
    const dup = await this.db.query(
      `SELECT 1 FROM bookings WHERE user_id=$1 AND plot_id=$2
         AND status IN ('BLOCKED','BOOKED','MANUAL_REVIEW')`,
      [userId, plotId],
    );
    if (dup.rowCount && dup.rowCount > 0)
      throw Err.conflict('DUPLICATE_ACTIVE_HOLD', 'You already hold this plot');

    // 3. The transaction (Invariants 2, 3, 5).
    const globalHold = await this.config.int('global_hold_minutes');
    let booking;
    try {
      booking = await this.db.tx(async (tx) => {
        // F4 — serialize this user's concurrent blocks on their own row (locked BEFORE the plot,
        // a consistent lock order across all callers → no deadlock), then re-count active holds
        // authoritatively. Without this, N parallel blocks by one user could each pass the
        // outside-TX pre-check and overshoot max_active_holds.
        await tx.query(`SELECT id FROM users WHERE id=$1 FOR UPDATE`, [userId]);
        const activeNow = Number(
          (
            await tx.query(
              `SELECT count(*)::int AS n FROM bookings WHERE user_id=$1 AND status='BLOCKED'`,
              [userId],
            )
          ).rows[0].n,
        );
        if (activeNow >= maxHolds)
          throw Err.conflict('HOLD_LIMIT_EXCEEDED', 'Active hold limit reached', {
            max_active_holds: maxHolds,
          });

        const locked = await tx.query(
          `SELECT p.id, p.price_paise, pr.hold_minutes_override
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
        const holdMinutes = p.hold_minutes_override ?? globalHold;
        const b = (
          await tx.query(
            `INSERT INTO bookings
               (plot_id, user_id, status, total_price_paise, hold_minutes, expires_at, idempotency_key)
             VALUES ($1,$2,'BLOCKED',$3,$4, now() + make_interval(mins => $4), $5)
             RETURNING *`,
            [plotId, userId, p.price_paise, holdMinutes, idemKey],
          )
        ).rows[0];
        await tx.query(`UPDATE plots SET status='BLOCKED' WHERE id=$1`, [plotId]);
        await this.audit.log(
          tx,
          { id: userId, role: 'CUSTOMER', requestId: ctx.requestId, ip: ctx.ip },
          'booking.block',
          'plot',
          plotId,
          { status: 'AVAILABLE' },
          { status: 'BLOCKED', booking_id: b.id },
        );
        return b;
      });
    } catch (e: any) {
      // A concurrent request with the SAME (user, idempotency_key) may have committed first. That
      // is a replay, not a failure — regardless of whether this attempt lost the row lock (and
      // saw the plot already BLOCKED → in-TX PLOT_UNAVAILABLE) or tripped a unique index. So
      // always resolve replay before surfacing any error.
      const replay = await this.findByUserAndKey(userId, idemKey);
      if (replay && replay.plot_id === plotId) return this.toResult(replay, true);
      if (isUniqueViolation(e, 'uniq_active_booking_per_plot'))
        throw Err.conflict('PLOT_UNAVAILABLE', 'Plot not available');
      throw e;
    }

    // 4. After commit — best-effort, never rolls back the hold (CF §2 step 4).
    const ttl = booking.hold_minutes * 60;
    await this.redis.setHold(booking.id, plotId, ttl);
    await this.notify.scheduleHoldJobs(booking.id, new Date(booking.expires_at));
    await this.notify.send(userId, 'PUSH', 'hold_created', { booking_id: booking.id });

    return this.toResult(booking, false);
  }

  async findByUserAndKey(userId: string, idemKey: string) {
    return (
      await this.db.query(
        `SELECT * FROM bookings WHERE user_id=$1 AND idempotency_key=$2`,
        [userId, idemKey],
      )
    ).rows[0];
  }

  private async toResult(b: any, replay: boolean): Promise<BlockResult> {
    const proj = (
      await this.db.query(
        `SELECT pr.max_advance_percentage, pr.rera_registered
           FROM plots p JOIN projects pr ON pr.id=p.project_id WHERE p.id=$1`,
        [b.plot_id],
      )
    ).rows[0];
    const capPct = effectiveCapPct(Number(proj.max_advance_percentage), proj.rera_registered);
    const minAdvance = await this.config.int('min_advance_paise');
    return {
      booking_id: b.id,
      plot_id: b.plot_id,
      status: b.status,
      total_price_paise: Number(b.total_price_paise),
      advance_cap_paise: advanceCapPaise(Number(b.total_price_paise), capPct),
      min_advance_paise: minAdvance,
      blocked_at: new Date(b.blocked_at).toISOString(),
      expires_at: new Date(b.expires_at).toISOString(),
      hold_minutes: b.hold_minutes,
      replay,
    };
  }
}
