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
 * UPDATE_ADVANCE_CAP (MC §3.8). Maker OPERATIONS, approver SUPER_ADMIN. payload {new_percentage}.
 * Guardrail: 0 < pct ≤ 10 when rera_registered, else ≤ 25. apply(): set max_advance_percentage.
 * (Dormant-ish with payments off, but the value is stored — Invariant 8.)
 */
@Injectable()
export class UpdateAdvanceCapHandler implements ApprovalActionHandler {
  readonly action = 'UPDATE_ADVANCE_CAP' as const;
  readonly makerRoles: Role[] = ['OPERATIONS'];
  readonly approverRoles: Role[] = ['SUPER_ADMIN'];

  constructor(private readonly audit: AuditService) {}

  summarize(approval: ApprovalRow): { title: string; diff: FieldDiff[] } {
    const s = approval.snapshot ?? {};
    const p = approval.payload ?? {};
    return {
      title: `Set advance cap for ${s.name ?? 'project'}`,
      diff: [
        {
          field: 'max_advance_percentage',
          current: s.max_advance_percentage ?? null,
          proposed: Number(p.new_percentage),
        },
      ],
    };
  }

  async validate(approval: ApprovalRow, ex: Executor): Promise<GuardrailResult[]> {
    const projectId = approval.entity_id;
    const pct = Number(approval.payload?.new_percentage);
    const pr = (
      await ex.query(`SELECT rera_registered FROM projects WHERE id=$1`, [projectId])
    ).rows[0];
    if (!pr) return [{ name: 'project_exists', ok: false, detail: 'Project not found' }];

    const ceiling = pr.rera_registered ? 10 : 25;
    const ok = Number.isFinite(pct) && pct > 0 && pct <= ceiling;
    return [
      {
        name: 'percentage_in_range',
        ok,
        detail: ok
          ? `${pct}% within 0 < pct ≤ ${ceiling}`
          : `percentage must be 0 < pct ≤ ${ceiling} (rera_registered=${pr.rera_registered})`,
      },
    ];
  }

  async apply(approval: ApprovalRow, checker: Checker, ex: Executor): Promise<AppliedResult> {
    const projectId = approval.entity_id;
    const pct = Number(approval.payload?.new_percentage);
    const before = (
      await ex.query(
        `SELECT max_advance_percentage, rera_registered FROM projects WHERE id=$1 FOR UPDATE`,
        [projectId],
      )
    ).rows[0];
    if (!before) throw new Error('UPDATE_ADVANCE_CAP apply: project not found');
    const ceiling = before.rera_registered ? 10 : 25;
    if (!(pct > 0 && pct <= ceiling))
      throw new Error(`UPDATE_ADVANCE_CAP apply: ${pct} out of range (≤ ${ceiling})`);

    await ex.query(`UPDATE projects SET max_advance_percentage=$2 WHERE id=$1`, [projectId, pct]);
    await this.audit.log(
      ex,
      { id: checker.id, role: checker.role, requestId: checker.requestId, ip: checker.ip },
      'project.advance_cap_update',
      'project',
      projectId,
      { max_advance_percentage: Number(before.max_advance_percentage) },
      { max_advance_percentage: pct },
    );
    return { audit: [] };
  }
}
