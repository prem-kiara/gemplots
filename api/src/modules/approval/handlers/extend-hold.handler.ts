import { Injectable } from '@nestjs/common';
import { Executor } from '../../../common/db/db.service';
import { AuditService } from '../../../common/audit/audit.service';
import { RedisService } from '../../../common/redis/redis.service';
import { Role } from '../../auth/auth.types';
import {
  AppliedResult,
  ApprovalActionHandler,
  ApprovalRow,
  Checker,
  FieldDiff,
  GuardrailResult,
} from '../approval.types';

const MIN_EXTRA = 30;
const MAX_EXTRA = 2880;
const MAX_TOTAL = 2880; // total extension per booking ≤ 2880 min (MC §3.4/EXTEND_HOLD)

/**
 * EXTEND_HOLD (MC §3, Invariant 5′ — the ONE sanctioned write to expires_at). Maker SALES,
 * approver OPERATIONS/SUPER_ADMIN. payload {extra_minutes} (30–2880; total per booking ≤ 2880).
 * Guardrails: booking PENDING_CONFIRMATION|PENDING_APPROVAL and not expired. apply():
 * expires_at += extra_minutes; post-commit reschedules the Redis TTL. Config changes never move a
 * live deadline — only this action does.
 */
@Injectable()
export class ExtendHoldHandler implements ApprovalActionHandler {
  readonly action = 'EXTEND_HOLD' as const;
  readonly makerRoles: Role[] = ['SALES'];
  readonly approverRoles: Role[] = ['OPERATIONS', 'SUPER_ADMIN'];

  constructor(
    private readonly audit: AuditService,
    private readonly redis: RedisService,
  ) {}

  summarize(approval: ApprovalRow): { title: string; diff: FieldDiff[] } {
    const s = approval.snapshot ?? {};
    const p = approval.payload ?? {};
    return {
      title: `Extend hold for ${s.plot_number ?? '?'} by ${p.extra_minutes} min`,
      diff: [{ field: 'expires_at', current: s.expires_at ?? null, proposed: `+${p.extra_minutes} min` }],
    };
  }

  /** Sum extra_minutes across ALREADY-APPROVED EXTEND_HOLD approvals for this booking. */
  private async priorExtension(ex: Executor, bookingId: string): Promise<number> {
    const r = (
      await ex.query(
        `SELECT COALESCE(SUM((payload->>'extra_minutes')::int), 0)::int AS total
           FROM approvals
          WHERE action='EXTEND_HOLD' AND entity_type='booking' AND entity_id=$1
            AND status='APPROVED'`,
        [bookingId],
      )
    ).rows[0];
    return Number(r?.total ?? 0);
  }

  async validate(approval: ApprovalRow, ex: Executor): Promise<GuardrailResult[]> {
    const bookingId = approval.entity_id;
    const extra = Number(approval.payload?.extra_minutes);
    const b = (
      await ex.query(`SELECT status, expires_at FROM bookings WHERE id=$1`, [bookingId])
    ).rows[0];
    if (!b) return [{ name: 'booking_exists', ok: false, detail: 'Booking not found' }];

    const pending = ['PENDING_CONFIRMATION', 'PENDING_APPROVAL'].includes(b.status);
    const notExpired = new Date(b.expires_at) > new Date();
    const inRange = Number.isFinite(extra) && extra >= MIN_EXTRA && extra <= MAX_EXTRA;
    const prior = await this.priorExtension(ex, bookingId);
    const withinTotal = inRange && prior + extra <= MAX_TOTAL;

    return [
      {
        name: 'booking_pending',
        ok: pending,
        detail: pending ? `Booking is ${b.status}` : `Booking is ${b.status}, not pending`,
      },
      {
        name: 'not_expired',
        ok: notExpired,
        detail: notExpired ? 'Hold window still open' : 'Hold window has passed',
      },
      {
        name: 'extra_minutes_in_range',
        ok: inRange,
        detail: inRange ? `${extra} min is 30–2880` : 'extra_minutes must be 30–2880',
      },
      {
        name: 'within_total_extension',
        ok: withinTotal,
        detail: withinTotal
          ? `Total extension ${prior + extra} ≤ ${MAX_TOTAL} min`
          : `Total extension would exceed ${MAX_TOTAL} min (already ${prior})`,
      },
    ];
  }

  async apply(approval: ApprovalRow, checker: Checker, ex: Executor): Promise<AppliedResult> {
    const bookingId = approval.entity_id;
    const extra = Number(approval.payload?.extra_minutes);
    const before = (
      await ex.query(`SELECT status, expires_at FROM bookings WHERE id=$1 FOR UPDATE`, [bookingId])
    ).rows[0];
    if (!before) throw new Error('EXTEND_HOLD apply: booking not found');
    if (!['PENDING_CONFIRMATION', 'PENDING_APPROVAL'].includes(before.status))
      throw new Error(`EXTEND_HOLD apply: booking is ${before.status}, not pending`);
    if (new Date(before.expires_at) <= new Date())
      throw new Error('EXTEND_HOLD apply: hold already expired');

    const updated = (
      await ex.query(
        `UPDATE bookings SET expires_at = expires_at + make_interval(mins => $2)
          WHERE id=$1 RETURNING expires_at`,
        [bookingId, extra],
      )
    ).rows[0];

    await this.audit.log(
      ex,
      { id: checker.id, role: checker.role, requestId: checker.requestId, ip: checker.ip },
      'booking.extend_hold',
      'booking',
      bookingId,
      { expires_at: new Date(before.expires_at).toISOString() },
      { expires_at: new Date(updated.expires_at).toISOString(), extra_minutes: extra },
    );
    return { audit: [] };
  }

  /** Post-commit — reschedule the Redis hold TTL to the new deadline (best-effort). */
  async afterApply(approval: ApprovalRow): Promise<void> {
    const bookingId = approval.entity_id;
    const plotId = approval.snapshot?.plot_id;
    // We can't read the DB here without an executor; the snapshot carries plot_id, and the extra
    // is known — set a fresh TTL from now to the new deadline. Redis is UX-only, so approximate.
    const extra = Number(approval.payload?.extra_minutes);
    if (plotId) await this.redis.setHold(bookingId, plotId, extra * 60);
  }
}
