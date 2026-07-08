'use client';
import { useMemo, useState } from 'react';
import { DataTable, type Column } from '@/components/DataTable';
import { EmptyState, ErrorState } from '@/components/EmptyState';
import { Input } from '@/components/Input';
import { useAudit } from '@/lib/queries';
import { getUser } from '@/lib/api';
import { canSeeAudit } from '@/lib/auth';
import { formatIST } from '@/lib/format';
import { S } from '@/lib/strings';
import type { AuditRow } from '@/lib/types';

export default function AuditPage() {
  const allowed = canSeeAudit(getUser());
  const [entityType, setEntityType] = useState('');
  const [entityId, setEntityId] = useState('');
  const { data, isLoading, isError, refetch } = useAudit({
    entity_type: entityType || undefined,
    entity_id: entityId || undefined,
  });

  const columns: Column<AuditRow>[] = useMemo(
    () => [
      { header: S.admin.audit.time, cell: (r) => <span className="text-muted">{formatIST(r.created_at)}</span> },
      {
        header: S.admin.audit.actor,
        cell: (r) => (
          <span className="text-ink">
            {r.actor_role ?? '—'}
            {r.actor_id ? <span className="text-muted"> · {r.actor_id.slice(0, 8)}</span> : null}
          </span>
        ),
      },
      { header: S.admin.audit.action, cell: (r) => <span className="font-medium text-ink">{r.action}</span> },
      {
        header: S.admin.audit.entity,
        cell: (r) => (
          <span className="text-muted">
            {r.entity_type}
            {r.entity_id ? `/${r.entity_id.slice(0, 8)}` : ''}
          </span>
        ),
      },
      {
        header: S.admin.audit.requestId,
        cell: (r) => <span className="text-muted">{r.request_id?.slice(0, 8) ?? '—'}</span>,
      },
    ],
    [],
  );

  if (!allowed) {
    return <EmptyState title="You do not have access to the audit log." />;
  }

  return (
    <div className="space-y-4">
      <h1 className="text-gp-2xl font-semibold text-ink">{S.admin.audit.title}</h1>

      <div className="flex flex-wrap items-end gap-3">
        <Input
          label="Entity type"
          value={entityType}
          onChange={(e) => setEntityType(e.target.value)}
          placeholder="booking, plot, approval…"
          className="min-w-[180px]"
        />
        <Input
          label="Entity ID"
          value={entityId}
          onChange={(e) => setEntityId(e.target.value)}
          placeholder="uuid"
          className="min-w-[220px]"
        />
      </div>

      {isError ? (
        <ErrorState message={S.common.somethingWrong} onRetry={() => refetch()} />
      ) : (
        <DataTable
          columns={columns}
          rows={data?.items ?? []}
          rowKey={(r) => r.id}
          loading={isLoading}
          empty={S.admin.audit.empty}
        />
      )}
    </div>
  );
}
