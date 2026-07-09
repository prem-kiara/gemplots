import { Injectable } from '@nestjs/common';
import { Executor } from '../../../common/db/db.service';
import { AuditService } from '../../../common/audit/audit.service';
import { Role } from '../../auth/auth.types';
import {
  AppliedResult,
  ApprovalActionHandler,
  ApprovalRow,
  Checker,
  FieldDiff,
  GuardrailResult,
} from '../approval.types';

/**
 * Allowed manual transitions (DM §3.1, pivot flavour). The old BOOKED→SOLD becomes RESERVED→SOLD
 * (RESERVED is the active reserve state in the Gem Housing flow). Every other transition is barred.
 */
const ALLOWED: Record<string, string[]> = {
  AVAILABLE: ['WITHDRAWN'],
  WITHDRAWN: ['AVAILABLE'],
  RESERVED: ['SOLD'],
};

/**
 * FORCE_PLOT_STATUS (MC §3.2). Maker OPERATIONS, approver SUPER_ADMIN. payload {new_status, note}.
 * Guardrails: only DM §3.1 transitions; target has no active booking unless RESERVED→SOLD.
 */
@Injectable()
export class ForcePlotStatusHandler implements ApprovalActionHandler {
  readonly action = 'FORCE_PLOT_STATUS' as const;
  readonly makerRoles: Role[] = ['OPERATIONS'];
  readonly approverRoles: Role[] = ['SUPER_ADMIN'];

  constructor(private readonly audit: AuditService) {}

  summarize(approval: ApprovalRow): { title: string; diff: FieldDiff[] } {
    const s = approval.snapshot ?? {};
    const p = approval.payload ?? {};
    return {
      title: `Force status of plot ${s.plot_number ?? '?'}`,
      diff: [{ field: 'status', current: s.status ?? null, proposed: p.new_status }],
    };
  }

  async validate(approval: ApprovalRow, ex: Executor): Promise<GuardrailResult[]> {
    const plotId = approval.entity_id;
    const target = approval.payload?.new_status;
    const plot = (await ex.query(`SELECT status FROM plots WHERE id=$1`, [plotId])).rows[0];
    if (!plot) return [{ name: 'plot_exists', ok: false, detail: 'Plot not found' }];

    const from = plot.status;
    const allowed = (ALLOWED[from] ?? []).includes(target);
    const reservedToSold = from === 'RESERVED' && target === 'SOLD';

    // "Active booking" = a booking currently holding the plot exclusively.
    const active = Number(
      (
        await ex.query(
          `SELECT count(*)::int AS n FROM bookings
             WHERE plot_id=$1 AND status IN
               ('PENDING_CONFIRMATION','PENDING_APPROVAL','RESERVED','BLOCKED','BOOKED','MANUAL_REVIEW')`,
          [plotId],
        )
      ).rows[0].n,
    );
    // RESERVED→SOLD is the sanctioned exception: the plot legitimately still has its RESERVED booking.
    const noActiveBooking = reservedToSold || active === 0;

    return [
      {
        name: 'transition_allowed',
        ok: allowed,
        detail: allowed
          ? `${from} → ${target} is permitted`
          : `${from} → ${target} is not a permitted transition`,
      },
      {
        name: 'no_active_booking',
        ok: noActiveBooking,
        detail: noActiveBooking
          ? 'No blocking active booking'
          : 'Plot has an active booking (only RESERVED→SOLD is exempt)',
      },
    ];
  }

  async apply(approval: ApprovalRow, checker: Checker, ex: Executor): Promise<AppliedResult> {
    const plotId = approval.entity_id;
    const target = approval.payload?.new_status;
    const before = (
      await ex.query(`SELECT status FROM plots WHERE id=$1 FOR UPDATE`, [plotId])
    ).rows[0];
    if (!before) throw new Error('FORCE_PLOT_STATUS apply: plot not found');
    if (!(ALLOWED[before.status] ?? []).includes(target))
      throw new Error(`FORCE_PLOT_STATUS apply: ${before.status} → ${target} not permitted`);

    await ex.query(`UPDATE plots SET status=$2 WHERE id=$1`, [plotId, target]);
    await this.audit.log(
      ex,
      { id: checker.id, role: checker.role, requestId: checker.requestId, ip: checker.ip },
      'plot.force_status',
      'plot',
      plotId,
      { status: before.status },
      { status: target, note: approval.payload?.note ?? null },
    );
    return { audit: [] };
  }
}
