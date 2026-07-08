import { Injectable } from '@nestjs/common';
import { Executor } from '../../common/db/db.service';
import { AuditService } from '../../common/audit/audit.service';
import { Role } from '../auth/auth.types';
import {
  AppliedResult,
  ApprovalActionHandler,
  ApprovalRow,
  Checker,
  GuardrailResult,
} from './approval.types';

/**
 * RESERVE_PLOT handler (08 §5 step 3, MC §2). approverRoles: SUPER_ADMIN, OPERATIONS, SALES.
 * Guardrails re-run at decision time (MC §1.3); apply() flips booking → RESERVED and plot →
 * RESERVED in the approving TX. This is the ONLY structural path to a RESERVED booking
 * (Invariant 7′) — and it only runs when the checker ≠ requester (enforced by ApprovalService
 * + the maker_is_not_checker DB CHECK).
 */
@Injectable()
export class ReservePlotHandler implements ApprovalActionHandler {
  readonly action = 'RESERVE_PLOT' as const;
  readonly approverRoles: Role[] = ['SUPER_ADMIN', 'OPERATIONS', 'SALES'];

  constructor(private readonly audit: AuditService) {}

  async validate(approval: ApprovalRow, ex: Executor): Promise<GuardrailResult[]> {
    const bookingId = approval.entity_id;
    const row = (
      await ex.query(
        `SELECT b.status AS booking_status, b.expires_at, b.plot_id,
                p.status AS plot_status
           FROM bookings b JOIN plots p ON p.id = b.plot_id
          WHERE b.id = $1`,
        [bookingId],
      )
    ).rows[0];

    if (!row) {
      return [{ name: 'booking_exists', ok: false, detail: 'Booking not found' }];
    }

    const bookingPending = row.booking_status === 'PENDING_APPROVAL';
    const notExpired = new Date(row.expires_at) > new Date();
    const plotHeld = row.plot_status === 'ON_HOLD';

    return [
      {
        name: 'booking_pending_approval',
        ok: bookingPending,
        detail: bookingPending
          ? 'Booking is awaiting approval'
          : `Booking is ${row.booking_status}, not PENDING_APPROVAL`,
      },
      {
        name: 'not_expired',
        ok: notExpired,
        detail: notExpired ? 'Decision window still open' : 'Decision window has passed',
      },
      {
        name: 'plot_on_hold',
        ok: plotHeld,
        detail: plotHeld ? 'Plot is held for this booking' : `Plot is ${row.plot_status}, not ON_HOLD`,
      },
    ];
  }

  async apply(approval: ApprovalRow, checker: Checker, ex: Executor): Promise<AppliedResult> {
    const bookingId = approval.entity_id;
    const b = (
      await ex.query(
        `UPDATE bookings SET status='RESERVED'
          WHERE id=$1 AND status='PENDING_APPROVAL' RETURNING plot_id`,
        [bookingId],
      )
    ).rows[0];
    if (!b) {
      // Guardrails should have caught this; belt-and-braces so we never half-apply.
      throw new Error('RESERVE_PLOT apply: booking no longer PENDING_APPROVAL');
    }
    const plotId = b.plot_id;
    const plotUpd = await ex.query(
      `UPDATE plots SET status='RESERVED' WHERE id=$1 AND status='ON_HOLD'`,
      [plotId],
    );
    if (plotUpd.rowCount === 0) {
      throw new Error('RESERVE_PLOT apply: plot no longer ON_HOLD');
    }

    await this.audit.log(
      ex,
      { id: checker.id, role: checker.role, requestId: checker.requestId, ip: checker.ip },
      'booking.reserve_approved',
      'booking',
      bookingId,
      { status: 'PENDING_APPROVAL' },
      { status: 'RESERVED' },
    );

    return {
      audit: [],
    };
  }
}
