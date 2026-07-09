import { Executor } from '../../common/db/db.service';
import { Role } from '../auth/auth.types';

/** All controlled actions (MC §3). RESOLVE_MANUAL_REVIEW + INITIATE_REFUND stay dormant with
 *  payments (08 §10) — no handler registered until payments go-live. */
export type ApprovalAction =
  | 'RESERVE_PLOT'
  | 'UPDATE_PLOT_PRICE'
  | 'FORCE_PLOT_STATUS'
  | 'CANCEL_BOOKING'
  | 'EXTEND_HOLD'
  | 'RESOLVE_MANUAL_REVIEW'
  | 'INITIATE_REFUND'
  | 'PUBLISH_PROJECT'
  | 'UPDATE_ADVANCE_CAP'
  | 'BULK_PRICE_UPDATE'
  | 'UPDATE_GLOBAL_SETTING';

/** One guardrail check result (MC §2). Surfaced in the review-detail `guardrails` panel. */
export interface GuardrailResult {
  name: string;
  ok: boolean;
  detail: string;
}

/** A single field in the Review-screen diff (MC §2, docs/10 §8.4): current (live) vs proposed. */
export interface FieldDiff {
  field: string;
  current: any;
  proposed: any;
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
 * ApprovalService.request/approve/reject are action-agnostic. Adding an action = one handler file.
 */
export interface ApprovalActionHandler {
  action: ApprovalAction;
  /** Who may request the action (the maker). Enforced at the maker endpoint + here. */
  makerRoles: Role[];
  /** Who may approve. The maker is excluded at runtime (SELF_APPROVAL_FORBIDDEN + DB CHECK). */
  approverRoles: Role[];
  /** Run at approval time (and re-runnable for the live guardrails panel). Reads via `ex`. */
  validate(approval: ApprovalRow, ex: Executor): Promise<GuardrailResult[]>;
  /** The actual mutation, inside the approving TX. Returns audit rows to write. */
  apply(approval: ApprovalRow, checker: Checker, ex: Executor): Promise<AppliedResult>;
  /** Human title + field diff for the Review screen (MC §2, docs/10 §8.4). */
  summarize(approval: ApprovalRow): { title: string; diff: FieldDiff[] };
  /** Optional post-commit side-effects (emails, feeds, Redis, cache) — never rolls back apply(). */
  afterApply?(approval: ApprovalRow): Promise<void>;
  /** Optional post-commit side-effects on rejection (e.g. notify the customer). */
  afterReject?(approval: ApprovalRow, note: string): Promise<void>;
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
