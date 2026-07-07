import { Injectable } from '@nestjs/common';
import { DbService, Executor } from '../db/db.service';

export interface AuditActor {
  id: string | null; // null for SYSTEM (sweeper, webhook, reconciliation) — CF §1.2
  role: string; // role or 'SYSTEM'
  requestId?: string | null;
  ip?: string | null;
}

export const SYSTEM_ACTOR: AuditActor = { id: null, role: 'SYSTEM' };

/**
 * Invariant 10: every mutating action writes an immutable audit_logs row. Callers pass the
 * transaction Executor so the audit row commits atomically with the mutation it records.
 */
@Injectable()
export class AuditService {
  constructor(private readonly db: DbService) {}

  async log(
    ex: Executor,
    actor: AuditActor,
    action: string,
    entityType: string,
    entityId: string,
    before: any | null,
    after: any | null,
  ): Promise<void> {
    await ex.query(
      `INSERT INTO audit_logs
         (actor_id, actor_role, action, entity_type, entity_id, before, after, request_id, ip)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        actor.id,
        actor.role,
        action,
        entityType,
        entityId,
        before === null ? null : JSON.stringify(before),
        after === null ? null : JSON.stringify(after),
        actor.requestId ?? null,
        actor.ip ?? null,
      ],
    );
  }
}
