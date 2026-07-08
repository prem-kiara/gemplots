import { Executor } from '../../common/db/db.service';
import { Role } from '../auth/auth.types';

export type ApprovalAction = 'RESERVE_PLOT';

/** One guardrail check result (MC §2). Surfaced in the review-detail `guardrails` panel. */
export interface GuardrailResult {
  name: string;
  ok: boolean;
  detail: string;
}

export interface AppliedResult {
  audit: Array<{
    action: string;
    entityType: string;
    entityId: string;
    before: any;
    after: any;
  }>;
}

/** The approval-time actor applying the decision (the checker). */
export interface Checker {
  id: string;
  role: Role;
  requestId?: string;
  ip?: string;
}

/**
 * Handler-registry shape per MC §2. Handlers register in a map keyed by action; the generic
 * ApprovalService.request/approve/reject are action-agnostic. Only RESERVE_PLOT exists in D2.
 */
export interface ApprovalActionHandler {
  action: ApprovalAction;
  approverRoles: Role[];
  /** Run at approval time (and re-runnable for the live guardrails panel). Reads via `ex`. */
  validate(approval: ApprovalRow, ex: Executor): Promise<GuardrailResult[]>;
  /** The actual mutation, inside the approving TX. Returns audit rows to write. */
  apply(approval: ApprovalRow, checker: Checker, ex: Executor): Promise<AppliedResult>;
}

export interface ApprovalRow {
  id: string;
  action: ApprovalAction;
  entity_type: string;
  entity_id: string;
  payload: any;
  snapshot: any;
  reason: string;
  status: string;
  requested_by: string;
  decided_by: string | null;
  decided_at: string | null;
  decision_note: string | null;
  created_at: string;
}
