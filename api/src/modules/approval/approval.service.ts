import { Injectable } from '@nestjs/common';
import { DbService, Executor, isUniqueViolation } from '../../common/db/db.service';
import { AuditService } from '../../common/audit/audit.service';
import { RedisService } from '../../common/redis/redis.service';
import { EmailService } from '../../common/email/email.service';
import { Err } from '../../common/errors';
import { NotificationService } from '../notification/notification.service';
import { Role } from '../auth/auth.types';
import {
  ApprovalAction,
  ApprovalActionHandler,
  ApprovalRow,
  Checker,
  GuardrailResult,
} from './approval.types';
import { ReservePlotHandler } from './reserve-plot.handler';
import { UpdatePlotPriceHandler } from './handlers/update-plot-price.handler';
import { ForcePlotStatusHandler } from './handlers/force-plot-status.handler';
import { CancelBookingHandler } from './handlers/cancel-booking.handler';
import { ExtendHoldHandler } from './handlers/extend-hold.handler';
import { PublishProjectHandler } from './handlers/publish-project.handler';
import { UpdateAdvanceCapHandler } from './handlers/update-advance-cap.handler';
import { BulkPriceUpdateHandler } from './handlers/bulk-price-update.handler';
import { UpdateGlobalSettingHandler } from './handlers/update-global-setting.handler';

/** The maker requesting a controlled action. */
export interface Requester {
  id: string;
  role: Role;
  requestId?: string;
  ip?: string;
}

/**
 * Generic approvals service (MC §2). Handlers register in a map keyed by action; request/approve/
 * reject are action-agnostic. Guardrails re-run at approval time (MC §1.3); the checker must be in
 * the handler's approverRoles and must not be the requester (409 SELF_APPROVAL_FORBIDDEN; the
 * maker_is_not_checker DB CHECK is the backstop). SPEC-QUESTION: RESOLVE_MANUAL_REVIEW and
 * INITIATE_REFUND (MC §3.5/§3.6) stay DORMANT with payments (08 §10) — no handler is registered;
 * they land with payments go-live.
 */
@Injectable()
export class ApprovalService {
  private readonly handlers = new Map<string, ApprovalActionHandler>();

  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly redis: RedisService,
    private readonly email: EmailService,
    private readonly notify: NotificationService,
    private readonly reservePlot: ReservePlotHandler,
    private readonly updatePlotPrice: UpdatePlotPriceHandler,
    private readonly forcePlotStatus: ForcePlotStatusHandler,
    private readonly cancelBooking: CancelBookingHandler,
    private readonly extendHold: ExtendHoldHandler,
    private readonly publishProject: PublishProjectHandler,
    private readonly updateAdvanceCap: UpdateAdvanceCapHandler,
    private readonly bulkPriceUpdate: BulkPriceUpdateHandler,
    private readonly updateGlobalSetting: UpdateGlobalSettingHandler,
  ) {
    this.register(this.reservePlot);
    this.register(this.updatePlotPrice);
    this.register(this.forcePlotStatus);
    this.register(this.cancelBooking);
    this.register(this.extendHold);
    this.register(this.publishProject);
    this.register(this.updateAdvanceCap);
    this.register(this.bulkPriceUpdate);
    this.register(this.updateGlobalSetting);
  }

  private register(h: ApprovalActionHandler) {
    this.handlers.set(h.action, h);
  }

  handler(action: string): ApprovalActionHandler {
    const h = this.handlers.get(action);
    if (!h) throw Err.badRequest('UNKNOWN_APPROVAL_ACTION', `No handler for ${action}`);
    return h;
  }

  /**
   * File a controlled-action request (MC §1.1). Validates the maker's role, runs guardrails at
   * request time (fail fast), inserts the PENDING approvals row (unique per (action,entity) →
   * 409 PENDING_APPROVAL_EXISTS on a dup), and writes a request audit row in the same TX. The
   * target entity is NOT mutated here. Returns {approval_id, status:'PENDING'}.
   */
  async request(
    action: ApprovalAction,
    entityType: string,
    entityId: string,
    payload: any,
    snapshot: any,
    reason: string,
    requester: Requester,
  ): Promise<{ approval_id: string; status: 'PENDING' }> {
    const h = this.handler(action);
    if (!h.makerRoles.includes(requester.role))
      throw Err.forbidden('FORBIDDEN_ROLE', 'Your role may not request this action');

    // Guardrails at request time (fail fast). Build a stand-in row so validate() can read payload.
    const probe: ApprovalRow = {
      id: '', action, entity_type: entityType, entity_id: entityId,
      payload, snapshot, reason, status: 'PENDING', requested_by: requester.id,
      decided_by: null, decided_at: null, decision_note: null, created_at: new Date().toISOString(),
    };
    const failures = (await h.validate(probe, this.db.pool)).filter((g) => !g.ok);
    if (failures.length)
      throw Err.conflict('GUARDRAIL_FAILED', 'Request guardrails failed', { failures });

    try {
      return await this.db.tx(async (tx) => {
        const row = (
          await tx.query(
            `INSERT INTO approvals
               (action, entity_type, entity_id, payload, snapshot, reason, requested_by)
             VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7)
             RETURNING id`,
            [
              action,
              entityType,
              entityId,
              JSON.stringify(payload ?? {}),
              JSON.stringify(snapshot ?? {}),
              reason,
              requester.id,
            ],
          )
        ).rows[0];
        // The request itself is an auditable action (MC §3 — audit written for the REQUEST too).
        await this.audit.log(
          tx,
          { id: requester.id, role: requester.role, requestId: requester.requestId, ip: requester.ip },
          'approval.request',
          'approval',
          row.id,
          null,
          { action, entity_type: entityType, entity_id: entityId },
        );
        return { approval_id: row.id, status: 'PENDING' as const };
      });
    } catch (e: any) {
      if (isUniqueViolation(e, 'uniq_pending_approval'))
        throw Err.conflict('PENDING_APPROVAL_EXISTS', 'A pending approval already exists for this');
      throw e;
    }
  }

  /** GET /v1/admin/approvals — list, newest-pending-first, with maker email + entity summary. */
  async list(filters: { status?: string; action?: string }) {
    const params: any[] = [];
    const where: string[] = [];
    if (filters.status) {
      params.push(filters.status);
      where.push(`a.status = $${params.length}`);
    }
    if (filters.action) {
      params.push(filters.action);
      where.push(`a.action = $${params.length}`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const rows = (
      await this.db.query(
        `SELECT a.*, u.email AS maker_email
           FROM approvals a JOIN users u ON u.id = a.requested_by
           ${whereSql}
          ORDER BY (a.status = 'PENDING') DESC, a.created_at DESC`,
        params,
      )
    ).rows;
    return {
      items: rows.map((r) => ({
        id: r.id,
        action: r.action,
        entity_type: r.entity_type,
        entity_id: r.entity_id,
        status: r.status,
        reason: r.reason,
        maker_email: r.maker_email,
        requested_by: r.requested_by,
        decided_by: r.decided_by,
        decided_at: r.decided_at ? new Date(r.decided_at).toISOString() : null,
        decision_note: r.decision_note,
        created_at: new Date(r.created_at).toISOString(),
        summary: this.summarize(r as ApprovalRow),
      })),
    };
  }

  /** GET /v1/admin/approvals/{id} — detail incl. LIVE guardrail re-check + summarize diff. */
  async detail(id: string) {
    const r = await this.loadRow(id);
    const maker = (
      await this.db.query(`SELECT email FROM users WHERE id=$1`, [r.requested_by])
    ).rows[0];
    const h = this.handler(r.action);
    const guardrails: GuardrailResult[] = await h.validate(r, this.db.pool);
    const summarized = h.summarize(r);
    return {
      id: r.id,
      action: r.action,
      entity_type: r.entity_type,
      entity_id: r.entity_id,
      status: r.status,
      reason: r.reason,
      payload: r.payload,
      snapshot: r.snapshot,
      maker_email: maker?.email,
      requested_by: r.requested_by,
      decided_by: r.decided_by,
      decided_at: r.decided_at ? new Date(r.decided_at).toISOString() : null,
      decision_note: r.decision_note,
      created_at: new Date(r.created_at).toISOString(),
      summary: summarized.title,
      title: summarized.title,
      diff: summarized.diff,
      guardrails,
    };
  }

  /** One-line human summary for the inbox list, delegated to the handler. */
  private summarize(r: ApprovalRow): string {
    try {
      return this.handlers.get(r.action)?.summarize(r).title ?? r.action;
    } catch {
      return r.action;
    }
  }

  private async loadRow(id: string): Promise<ApprovalRow> {
    const r = (await this.db.query(`SELECT * FROM approvals WHERE id=$1`, [id])).rows[0];
    if (!r) throw Err.notFound('APPROVAL_NOT_FOUND', 'Approval not found');
    return r as ApprovalRow;
  }

  /** POST /v1/admin/approvals/{id}/approve — MC §1.2–1.4. */
  async approve(id: string, checker: Checker, note?: string) {
    const r = await this.loadRow(id);
    const h = this.handler(r.action);

    if (!h.approverRoles.includes(checker.role))
      throw Err.forbidden('FORBIDDEN_ROLE', 'Your role may not approve this action');
    if (checker.id === r.requested_by)
      throw Err.conflict('SELF_APPROVAL_FORBIDDEN', 'The requester cannot approve their own request');
    if (r.status !== 'PENDING')
      throw Err.conflict('APPROVAL_NOT_PENDING', 'Approval is not pending');

    // Guardrails re-run at approval time (fail before mutating).
    const guardrails = await h.validate(r, this.db.pool);
    const failures = guardrails.filter((g) => !g.ok);
    if (failures.length)
      throw Err.conflict('GUARDRAIL_FAILED', 'Approval guardrails failed', { failures });

    const applied = await this.db.tx(async (tx) => {
      // Re-guard the approval row itself so a concurrent decision loses.
      const locked = (
        await tx.query(`SELECT status FROM approvals WHERE id=$1 FOR UPDATE`, [id])
      ).rows[0];
      if (!locked || locked.status !== 'PENDING')
        throw Err.conflict('APPROVAL_NOT_PENDING', 'Approval is not pending');

      const result = await h.apply(r, checker, tx);

      await tx.query(
        `UPDATE approvals SET status='APPROVED', decided_by=$2, decided_at=now(), decision_note=$3
          WHERE id=$1`,
        [id, checker.id, note ?? null],
      );
      await this.audit.log(
        tx,
        { id: checker.id, role: checker.role, requestId: checker.requestId, ip: checker.ip },
        'approval.approve',
        'approval',
        id,
        { status: 'PENDING' },
        { status: 'APPROVED' },
      );
      return result;
    });

    // Post-commit — best-effort, never rolls back an applied action.
    if (r.action === 'RESERVE_PLOT') await this.afterReserveApprove(r);
    if (h.afterApply) {
      try {
        await h.afterApply(r);
      } catch {
        /* post-commit side-effects are best-effort */
      }
    }
    return { id, status: 'APPROVED', ...applied };
  }

  /** POST /v1/admin/approvals/{id}/reject — note required (MC §1.6). No guardrails to re-run. */
  async reject(id: string, checker: Checker, note: string) {
    if (!note || !note.trim())
      throw Err.badRequest('REJECTION_NOTE_REQUIRED', 'A rejection note is required');
    const r = await this.loadRow(id);
    const h = this.handler(r.action);

    if (!h.approverRoles.includes(checker.role))
      throw Err.forbidden('FORBIDDEN_ROLE', 'Your role may not decide this action');
    if (checker.id === r.requested_by)
      throw Err.conflict('SELF_APPROVAL_FORBIDDEN', 'The requester cannot decide their own request');
    if (r.status !== 'PENDING')
      throw Err.conflict('APPROVAL_NOT_PENDING', 'Approval is not pending');

    await this.db.tx(async (tx) => {
      const locked = (
        await tx.query(`SELECT status FROM approvals WHERE id=$1 FOR UPDATE`, [id])
      ).rows[0];
      if (!locked || locked.status !== 'PENDING')
        throw Err.conflict('APPROVAL_NOT_PENDING', 'Approval is not pending');

      if (r.action === 'RESERVE_PLOT') {
        const bookingId = r.entity_id;
        const b = (
          await tx.query(
            `UPDATE bookings SET status='REJECTED', closed_at=now()
              WHERE id=$1 AND status='PENDING_APPROVAL' RETURNING plot_id`,
            [bookingId],
          )
        ).rows[0];
        if (b)
          await tx.query(
            `UPDATE plots SET status='AVAILABLE' WHERE id=$1 AND status='ON_HOLD'`,
            [b.plot_id],
          );
        await this.audit.log(
          tx,
          { id: checker.id, role: checker.role, requestId: checker.requestId, ip: checker.ip },
          'booking.reserve_rejected',
          'booking',
          bookingId,
          { status: 'PENDING_APPROVAL' },
          { status: 'REJECTED' },
        );
      }

      await tx.query(
        `UPDATE approvals SET status='REJECTED', decided_by=$2, decided_at=now(), decision_note=$3
          WHERE id=$1`,
        [id, checker.id, note],
      );
      await this.audit.log(
        tx,
        { id: checker.id, role: checker.role, requestId: checker.requestId, ip: checker.ip },
        'approval.reject',
        'approval',
        id,
        { status: 'PENDING' },
        { status: 'REJECTED' },
      );
    });

    if (r.action === 'RESERVE_PLOT') await this.afterReserveReject(r, note);
    if (h.afterReject) {
      try {
        await h.afterReject(r, note);
      } catch {
        /* best-effort */
      }
    }
    return { id, status: 'REJECTED' };
  }

  private async afterReserveApprove(r: ApprovalRow) {
    const s = r.snapshot ?? {};
    const customerId = s.customer?.id;
    const email = s.customer?.email;
    const plotNumber = s.plot?.plot_number;
    const projectName = s.plot?.project_name;
    if (email)
      await this.email.send(email, 'reservation_approved', {
        plot_number: plotNumber,
        project_name: projectName,
      });
    if (customerId)
      await this.notify.feed(
        'CUSTOMER',
        'RESERVATION_APPROVED',
        `Your reservation for ${plotNumber} is approved`,
        '',
        'booking',
        r.entity_id,
        customerId,
      );
    await this.notify.feed(
      'ADMIN',
      'RESERVATION_APPROVED',
      `${email ?? 'A customer'}'s reservation for ${plotNumber} was approved`,
      '',
      'booking',
      r.entity_id,
    );
    await this.redis.delHold(r.entity_id);
  }

  private async afterReserveReject(r: ApprovalRow, note: string) {
    const s = r.snapshot ?? {};
    const customerId = s.customer?.id;
    const email = s.customer?.email;
    const plotNumber = s.plot?.plot_number;
    if (email)
      await this.email.send(email, 'reservation_rejected', {
        plot_number: plotNumber,
        note,
      });
    if (customerId)
      await this.notify.feed(
        'CUSTOMER',
        'RESERVATION_REJECTED',
        `Your reservation for ${plotNumber} was not approved`,
        '',
        'booking',
        r.entity_id,
        customerId,
      );
    await this.notify.feed(
      'ADMIN',
      'RESERVATION_REJECTED',
      `${email ?? 'A customer'}'s reservation for ${plotNumber} was rejected`,
      '',
      'booking',
      r.entity_id,
    );
    await this.redis.delHold(r.entity_id);
  }
}
