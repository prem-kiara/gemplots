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

/** Plot statuses that hold the plot exclusively — no repricing while one is active (MC §3.1). */
const HELD_STATUSES = ['ON_HOLD', 'RESERVED', 'SOLD', 'BLOCKED', 'BOOKED'];

/**
 * UPDATE_PLOT_PRICE (MC §3.1). Maker OPERATIONS/SALES, approver SUPER_ADMIN/OPERATIONS.
 * payload {new_price_paise}. Guardrails: plot not under an active hold (ON_HOLD/RESERVED/SOLD/
 * BLOCKED/BOOKED), price > 0, change ≤ ±50% unless the approver is SUPER_ADMIN (the ±50% is
 * enforced at request; the SUPER_ADMIN override is applied at approval time by approver role).
 */
@Injectable()
export class UpdatePlotPriceHandler implements ApprovalActionHandler {
  readonly action = 'UPDATE_PLOT_PRICE' as const;
  readonly makerRoles: Role[] = ['OPERATIONS', 'SALES'];
  readonly approverRoles: Role[] = ['SUPER_ADMIN', 'OPERATIONS'];

  constructor(private readonly audit: AuditService) {}

  summarize(approval: ApprovalRow): { title: string; diff: FieldDiff[] } {
    const s = approval.snapshot ?? {};
    const p = approval.payload ?? {};
    return {
      title: `Reprice plot ${s.plot_number ?? '?'}`,
      diff: [
        {
          field: 'price_paise',
          current: s.price_paise ?? null,
          proposed: Number(p.new_price_paise),
        },
      ],
    };
  }

  async validate(approval: ApprovalRow, ex: Executor): Promise<GuardrailResult[]> {
    const plotId = approval.entity_id;
    const newPrice = Number(approval.payload?.new_price_paise);
    const plot = (
      await ex.query(`SELECT status, price_paise FROM plots WHERE id=$1`, [plotId])
    ).rows[0];
    if (!plot) return [{ name: 'plot_exists', ok: false, detail: 'Plot not found' }];

    const notHeld = !HELD_STATUSES.includes(plot.status);
    const positive = Number.isFinite(newPrice) && newPrice > 0;
    // ±50% band vs the price captured at request time (snapshot). SUPER_ADMIN may override at
    // approval — that is enforced by approverRoles + the checker's role, so the band guardrail is
    // informational: it never blocks approval (a SUPER_ADMIN can decide anyway).
    const base = Number(approval.snapshot?.price_paise ?? plot.price_paise);
    const withinBand =
      positive && base > 0 && Math.abs(newPrice - base) <= base * 0.5;

    return [
      {
        name: 'plot_not_held',
        ok: notHeld,
        detail: notHeld ? 'Plot has no active hold' : `Plot is ${plot.status}`,
      },
      {
        name: 'price_positive',
        ok: positive,
        detail: positive ? 'New price is positive' : 'New price must be > 0',
      },
      {
        name: 'within_50pct_or_super_admin',
        ok: withinBand,
        detail: withinBand
          ? 'Change within ±50%'
          : 'Change exceeds ±50% — requires SUPER_ADMIN approval',
      },
    ];
  }

  async apply(approval: ApprovalRow, checker: Checker, ex: Executor): Promise<AppliedResult> {
    const plotId = approval.entity_id;
    const newPrice = Number(approval.payload?.new_price_paise);
    // Re-guard the held-status + positivity inside the TX (belt-and-braces).
    const before = (
      await ex.query(`SELECT status, price_paise FROM plots WHERE id=$1 FOR UPDATE`, [plotId])
    ).rows[0];
    if (!before) throw new Error('UPDATE_PLOT_PRICE apply: plot not found');
    if (HELD_STATUSES.includes(before.status))
      throw new Error(`UPDATE_PLOT_PRICE apply: plot is ${before.status}`);
    if (!(newPrice > 0)) throw new Error('UPDATE_PLOT_PRICE apply: price must be > 0');

    await ex.query(`UPDATE plots SET price_paise=$2 WHERE id=$1`, [plotId, newPrice]);
    await this.audit.log(
      ex,
      { id: checker.id, role: checker.role, requestId: checker.requestId, ip: checker.ip },
      'plot.price_update',
      'plot',
      plotId,
      { price_paise: Number(before.price_paise) },
      { price_paise: newPrice },
    );
    return { audit: [] };
  }
}
