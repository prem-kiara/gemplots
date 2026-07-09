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

const HELD_STATUSES = ['ON_HOLD', 'RESERVED', 'SOLD', 'BLOCKED', 'BOOKED'];

interface BulkItem {
  plot_id: string;
  new_price_paise: number;
}

/**
 * BULK_PRICE_UPDATE (MC §3.9). Maker OPERATIONS, approver SUPER_ADMIN. entity = project.
 * payload {items:[{plot_id,new_price_paise}]}. Guardrails: every plot in this project, none held
 * (ON_HOLD/RESERVED/SOLD/BLOCKED/BOOKED), all prices > 0. apply(): single TX over all plots,
 * all-or-nothing.
 */
@Injectable()
export class BulkPriceUpdateHandler implements ApprovalActionHandler {
  readonly action = 'BULK_PRICE_UPDATE' as const;
  readonly makerRoles: Role[] = ['OPERATIONS'];
  readonly approverRoles: Role[] = ['SUPER_ADMIN'];

  constructor(private readonly audit: AuditService) {}

  summarize(approval: ApprovalRow): { title: string; diff: FieldDiff[] } {
    const s = approval.snapshot ?? {};
    const items: BulkItem[] = approval.payload?.items ?? [];
    return {
      title: `Bulk reprice ${items.length} plot(s) in ${s.name ?? 'project'}`,
      diff: items.slice(0, 20).map((it) => ({
        field: `plot ${(s.plots ?? {})[it.plot_id] ?? it.plot_id}`,
        current: (s.prices ?? {})[it.plot_id] ?? null,
        proposed: Number(it.new_price_paise),
      })),
    };
  }

  async validate(approval: ApprovalRow, ex: Executor): Promise<GuardrailResult[]> {
    const projectId = approval.entity_id;
    const items: BulkItem[] = approval.payload?.items ?? [];
    if (items.length === 0)
      return [{ name: 'has_items', ok: false, detail: 'No items to update' }];

    const allPositive = items.every((it) => Number(it.new_price_paise) > 0);
    const plotIds = items.map((it) => it.plot_id);
    const rows = (
      await ex.query<{ id: string; status: string }>(
        `SELECT id, status FROM plots WHERE id = ANY($1) AND project_id=$2`,
        [plotIds, projectId],
      )
    ).rows;
    const allInProject = rows.length === plotIds.length;
    const noneHeld = rows.every((r) => !HELD_STATUSES.includes(r.status));

    return [
      {
        name: 'all_prices_positive',
        ok: allPositive,
        detail: allPositive ? 'All new prices > 0' : 'Some prices are not > 0',
      },
      {
        name: 'all_plots_in_project',
        ok: allInProject,
        detail: allInProject
          ? 'All plots belong to this project'
          : 'Some plot_id not in this project',
      },
      {
        name: 'no_plot_held',
        ok: noneHeld,
        detail: noneHeld ? 'No plot has an active hold' : 'Some plot is held/sold',
      },
    ];
  }

  async apply(approval: ApprovalRow, checker: Checker, ex: Executor): Promise<AppliedResult> {
    const projectId = approval.entity_id;
    const items: BulkItem[] = approval.payload?.items ?? [];
    // Single TX (this executor) — all-or-nothing: any throw rolls back the whole batch.
    for (const it of items) {
      const before = (
        await ex.query(
          `SELECT status, price_paise FROM plots WHERE id=$1 AND project_id=$2 FOR UPDATE`,
          [it.plot_id, projectId],
        )
      ).rows[0];
      if (!before) throw new Error(`BULK_PRICE_UPDATE apply: plot ${it.plot_id} not in project`);
      if (HELD_STATUSES.includes(before.status))
        throw new Error(`BULK_PRICE_UPDATE apply: plot ${it.plot_id} is ${before.status}`);
      if (!(Number(it.new_price_paise) > 0))
        throw new Error(`BULK_PRICE_UPDATE apply: plot ${it.plot_id} price must be > 0`);
      await ex.query(`UPDATE plots SET price_paise=$2 WHERE id=$1`, [
        it.plot_id,
        Number(it.new_price_paise),
      ]);
      await this.audit.log(
        ex,
        { id: checker.id, role: checker.role, requestId: checker.requestId, ip: checker.ip },
        'plot.price_update',
        'plot',
        it.plot_id,
        { price_paise: Number(before.price_paise) },
        { price_paise: Number(it.new_price_paise), bulk: true },
      );
    }
    return { audit: [] };
  }
}
