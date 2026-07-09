import { Injectable } from '@nestjs/common';
import { Executor } from '../../../common/db/db.service';
import { AuditService } from '../../../common/audit/audit.service';
import { RedisService } from '../../../common/redis/redis.service';
import { EmailService } from '../../../common/email/email.service';
import { NotificationService } from '../../notification/notification.service';
import { Role } from '../../auth/auth.types';
import {
  AppliedResult,
  ApprovalActionHandler,
  ApprovalRow,
  Checker,
  FieldDiff,
  GuardrailResult,
} from '../approval.types';

/** Cancellable booking states in the reserve flow (MC §3.4 mapped to the pivot statuses). */
const CANCELLABLE = ['PENDING_CONFIRMATION', 'PENDING_APPROVAL', 'RESERVED'];

/**
 * CANCEL_BOOKING (MC §3.4). Maker SALES/OPERATIONS, approver SUPER_ADMIN/FINANCE. payload {note}.
 * Guardrails: booking is PENDING_CONFIRMATION|PENDING_APPROVAL|RESERVED. apply(): booking →
 * CANCELLED + closed_at; plot ON_HOLD/RESERVED → AVAILABLE (guarded); auto-withdraw any pending
 * approval for it; post-commit cancels the Redis hold + emails booking_cancelled + feeds.
 */
@Injectable()
export class CancelBookingHandler implements ApprovalActionHandler {
  readonly action = 'CANCEL_BOOKING' as const;
  readonly makerRoles: Role[] = ['SALES', 'OPERATIONS'];
  readonly approverRoles: Role[] = ['SUPER_ADMIN', 'FINANCE'];

  constructor(
    private readonly audit: AuditService,
    private readonly redis: RedisService,
    private readonly email: EmailService,
    private readonly notify: NotificationService,
  ) {}

  summarize(approval: ApprovalRow): { title: string; diff: FieldDiff[] } {
    const s = approval.snapshot ?? {};
    return {
      title: `Cancel booking for ${s.plot_number ?? '?'} (${s.customer_email ?? '?'})`,
      diff: [{ field: 'booking_status', current: s.status ?? null, proposed: 'CANCELLED' }],
    };
  }

  async validate(approval: ApprovalRow, ex: Executor): Promise<GuardrailResult[]> {
    const bookingId = approval.entity_id;
    const b = (await ex.query(`SELECT status FROM bookings WHERE id=$1`, [bookingId])).rows[0];
    if (!b) return [{ name: 'booking_exists', ok: false, detail: 'Booking not found' }];
    const cancellable = CANCELLABLE.includes(b.status);
    return [
      {
        name: 'booking_cancellable',
        ok: cancellable,
        detail: cancellable
          ? `Booking is ${b.status}`
          : `Booking is ${b.status}, not a cancellable state`,
      },
    ];
  }

  async apply(approval: ApprovalRow, checker: Checker, ex: Executor): Promise<AppliedResult> {
    const bookingId = approval.entity_id;
    const b = (
      await ex.query(
        `UPDATE bookings SET status='CANCELLED', closed_at=now()
          WHERE id=$1 AND status = ANY($2) RETURNING plot_id, status`,
        [bookingId, CANCELLABLE],
      )
    ).rows[0];
    if (!b) throw new Error('CANCEL_BOOKING apply: booking no longer cancellable');

    // Release the plot only if it is currently held by this booking (ON_HOLD/RESERVED).
    await ex.query(
      `UPDATE plots SET status='AVAILABLE' WHERE id=$1 AND status IN ('ON_HOLD','RESERVED')`,
      [b.plot_id],
    );
    // Auto-withdraw any OTHER pending approval for this booking (e.g. a RESERVE_PLOT still pending).
    await ex.query(
      `UPDATE approvals
          SET status='WITHDRAWN', decision_note='auto-withdrawn: booking cancelled', decided_at=now()
        WHERE entity_type='booking' AND entity_id=$1 AND status='PENDING' AND id<>$2`,
      [bookingId, approval.id],
    );
    await this.audit.log(
      ex,
      { id: checker.id, role: checker.role, requestId: checker.requestId, ip: checker.ip },
      'booking.cancel',
      'booking',
      bookingId,
      { status: approval.snapshot?.status ?? null },
      { status: 'CANCELLED', note: approval.payload?.note ?? null },
    );
    return { audit: [] };
  }

  /** Post-commit — best-effort, never rolls back the cancellation. */
  async afterApply(approval: ApprovalRow): Promise<void> {
    const s = approval.snapshot ?? {};
    await this.redis.delHold(approval.entity_id);
    if (s.customer_email)
      await this.email.send(s.customer_email, 'booking_cancelled', {
        plot_number: s.plot_number,
        project_name: s.project_name,
        note: approval.payload?.note ?? '',
      });
    if (s.customer_id)
      await this.notify.feed(
        'CUSTOMER',
        'BOOKING_CANCELLED',
        `Your booking for ${s.plot_number ?? 'a plot'} was cancelled`,
        '',
        'booking',
        approval.entity_id,
        s.customer_id,
      );
    await this.notify.feed(
      'ADMIN',
      'BOOKING_CANCELLED',
      `Booking for ${s.plot_number ?? 'a plot'} was cancelled`,
      '',
      'booking',
      approval.entity_id,
    );
  }
}
