'use client';
import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { DataTable, type Column } from '@/components/DataTable';
import { ErrorState } from '@/components/EmptyState';
import { StatusChip } from '@/components/StatusChip';
import { useApprovals } from '@/lib/queries';
import { relativeAge, hoursSince } from '@/lib/format';
import { S } from '@/lib/strings';
import type { ApprovalListItem } from '@/lib/types';

const ACTION_LABELS: Record<string, string> = {
  RESERVE_PLOT: S.admin.inbox.reservePlot,
};

function ageColor(iso: string): string {
  const h = hoursSince(iso);
  if (h > 72) return 'text-danger font-semibold';
  if (h > 24) return 'text-accent font-semibold';
  return 'text-muted';
}

export default function InboxPage() {
  const router = useRouter();
  const [status, setStatus] = useState('PENDING');
  const [action, setAction] = useState('');
  const { data, isLoading, isError, refetch } = useApprovals({
    status: status || undefined,
    action: action || undefined,
  });

  const rows = data?.items ?? [];

  const columns: Column<ApprovalListItem>[] = useMemo(
    () => [
      {
        header: S.admin.inbox.age,
        cell: (r) => <span className={ageColor(r.created_at)}>{relativeAge(r.created_at)}</span>,
      },
      {
        header: S.admin.inbox.action,
        cell: (r) => <span className="font-medium text-ink">{ACTION_LABELS[r.action] ?? r.action}</span>,
      },
      {
        header: S.admin.inbox.entity,
        cell: (r) => <span className="text-ink">{r.summary}</span>,
      },
      {
        header: S.admin.inbox.requestedBy,
        cell: (r) => <span className="text-muted">{r.maker_email ?? '—'}</span>,
      },
      {
        header: 'Status',
        cell: (r) => <StatusChip status={r.status} />,
      },
    ],
    [],
  );

  return (
    <div className="space-y-4">
      <h1 className="text-gp-2xl font-semibold text-ink">{S.admin.inbox.title}</h1>

      <div className="flex flex-wrap gap-3">
        <label className="flex items-center gap-2 text-gp-sm text-muted">
          {S.admin.inbox.statusFilter}
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            className="min-h-[38px] rounded-control border border-line bg-white px-2 text-ink"
          >
            <option value="PENDING">Pending</option>
            <option value="APPROVED">Approved</option>
            <option value="REJECTED">Rejected</option>
            <option value="">All</option>
          </select>
        </label>
        <label className="flex items-center gap-2 text-gp-sm text-muted">
          {S.admin.inbox.actionFilter}
          <select
            value={action}
            onChange={(e) => setAction(e.target.value)}
            className="min-h-[38px] rounded-control border border-line bg-white px-2 text-ink"
          >
            <option value="">All</option>
            <option value="RESERVE_PLOT">{S.admin.inbox.reservePlot}</option>
          </select>
        </label>
      </div>

      {isError ? (
        <ErrorState message={S.common.somethingWrong} onRetry={() => refetch()} />
      ) : (
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(r) => r.id}
          loading={isLoading}
          onRowClick={(r) => router.push(`/admin/inbox/${r.id}`)}
          empty={S.admin.inbox.empty}
        />
      )}
    </div>
  );
}
