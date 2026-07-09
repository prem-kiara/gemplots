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

const TARGETS = ['PUBLISHED', 'PAUSED', 'ARCHIVED'];

/**
 * PUBLISH_PROJECT (MC §3.7) — the keystone that completes the P6 onboarding story. Maker
 * OPERATIONS, approver SUPER_ADMIN. payload {target: PUBLISHED|PAUSED|ARCHIVED}.
 * Guardrails for PUBLISHED: ≥1 plot, an active site map, every non-WITHDRAWN plot has a geometry
 * on the active map, RERA fields complete when rera_registered; for ARCHIVED: no active bookings.
 * apply(): set projects.status.
 */
@Injectable()
export class PublishProjectHandler implements ApprovalActionHandler {
  readonly action = 'PUBLISH_PROJECT' as const;
  readonly makerRoles: Role[] = ['OPERATIONS'];
  readonly approverRoles: Role[] = ['SUPER_ADMIN'];

  constructor(private readonly audit: AuditService) {}

  summarize(approval: ApprovalRow): { title: string; diff: FieldDiff[] } {
    const s = approval.snapshot ?? {};
    const p = approval.payload ?? {};
    return {
      title: `Set ${s.name ?? 'project'} to ${p.target}`,
      diff: [{ field: 'status', current: s.status ?? null, proposed: p.target }],
    };
  }

  async validate(approval: ApprovalRow, ex: Executor): Promise<GuardrailResult[]> {
    const projectId = approval.entity_id;
    const target = approval.payload?.target;
    const pr = (
      await ex.query(`SELECT status, rera_registered, rera_number FROM projects WHERE id=$1`, [
        projectId,
      ])
    ).rows[0];
    if (!pr) return [{ name: 'project_exists', ok: false, detail: 'Project not found' }];

    const targetValid = TARGETS.includes(target);
    const results: GuardrailResult[] = [
      {
        name: 'target_valid',
        ok: targetValid,
        detail: targetValid ? `Target ${target}` : `Target must be one of ${TARGETS.join('/')}`,
      },
    ];

    if (target === 'PUBLISHED') {
      const plotCount = Number(
        (await ex.query(`SELECT count(*)::int AS n FROM plots WHERE project_id=$1`, [projectId]))
          .rows[0].n,
      );
      const activeMap = (
        await ex.query(
          `SELECT id FROM site_maps WHERE project_id=$1 AND is_active LIMIT 1`,
          [projectId],
        )
      ).rows[0];
      const missing = activeMap
        ? Number(
            (
              await ex.query(
                `SELECT count(*)::int AS n FROM plots p
                  WHERE p.project_id=$1 AND p.status <> 'WITHDRAWN'
                    AND NOT EXISTS (SELECT 1 FROM plot_geometries g
                                     WHERE g.site_map_id=$2 AND g.plot_id=p.id)`,
                [projectId, activeMap.id],
              )
            ).rows[0].n,
          )
        : 0;
      const reraOk = !pr.rera_registered || !!pr.rera_number;

      results.push(
        {
          name: 'has_plots',
          ok: plotCount >= 1,
          detail: plotCount >= 1 ? `${plotCount} plot(s)` : 'Project has no plots',
        },
        {
          name: 'has_active_map',
          ok: !!activeMap,
          detail: activeMap ? 'Active site map present' : 'No active site map',
        },
        {
          name: 'all_plots_have_geometry',
          ok: !!activeMap && missing === 0,
          detail:
            !activeMap
              ? 'No active map to check geometry against'
              : missing === 0
                ? 'Every non-withdrawn plot has a geometry'
                : `${missing} plot(s) missing geometry`,
        },
        {
          name: 'rera_complete',
          ok: reraOk,
          detail: reraOk ? 'RERA fields complete' : 'rera_number required when rera_registered',
        },
      );
    } else if (target === 'ARCHIVED') {
      const active = Number(
        (
          await ex.query(
            `SELECT count(*)::int AS n FROM bookings b JOIN plots p ON p.id=b.plot_id
              WHERE p.project_id=$1 AND b.status IN
                ('PENDING_CONFIRMATION','PENDING_APPROVAL','RESERVED','BLOCKED','BOOKED','MANUAL_REVIEW')`,
            [projectId],
          )
        ).rows[0].n,
      );
      results.push({
        name: 'no_active_bookings',
        ok: active === 0,
        detail: active === 0 ? 'No active bookings' : `${active} active booking(s) block archive`,
      });
    }
    return results;
  }

  async apply(approval: ApprovalRow, checker: Checker, ex: Executor): Promise<AppliedResult> {
    const projectId = approval.entity_id;
    const target = approval.payload?.target;
    if (!TARGETS.includes(target)) throw new Error(`PUBLISH_PROJECT apply: bad target ${target}`);
    const before = (
      await ex.query(`SELECT status FROM projects WHERE id=$1 FOR UPDATE`, [projectId])
    ).rows[0];
    if (!before) throw new Error('PUBLISH_PROJECT apply: project not found');

    await ex.query(`UPDATE projects SET status=$2 WHERE id=$1`, [projectId, target]);
    await this.audit.log(
      ex,
      { id: checker.id, role: checker.role, requestId: checker.requestId, ip: checker.ip },
      'project.status_change',
      'project',
      projectId,
      { status: before.status },
      { status: target },
    );
    return { audit: [] };
  }
}
