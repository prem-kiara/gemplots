'use client';
import { useMemo } from 'react';
import { DataTable, type Column } from '@/components/DataTable';
import { ErrorState } from '@/components/EmptyState';
import { StatusChip } from '@/components/StatusChip';
import { useProjects } from '@/lib/queries';
import { S } from '@/lib/strings';
import type { ProjectSummary } from '@/lib/types';

export default function AdminProjectsPage() {
  // No admin projects-list endpoint in this slice; the public list carries the fields we show.
  const { data, isLoading, isError, refetch } = useProjects();

  const columns: Column<ProjectSummary>[] = useMemo(
    () => [
      { header: S.admin.projects.name, cell: (p) => <span className="font-medium text-ink">{p.name}</span> },
      { header: S.admin.projects.status, cell: () => <StatusChip status="APPROVED" label="Published" /> },
      { header: S.admin.projects.district, cell: (p) => <span className="text-muted">{p.district}</span> },
      {
        header: S.admin.projects.plots,
        cell: (p) => (
          <span className="text-ink">
            {p.plot_counts.available}
            <span className="text-muted"> / {p.plot_counts.total}</span>
          </span>
        ),
      },
    ],
    [],
  );

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-gp-2xl font-semibold text-ink">{S.admin.projects.title}</h1>
        <p className="text-gp-sm text-muted">{S.admin.projects.managedNote}</p>
      </div>

      {isError ? (
        <ErrorState message={S.common.somethingWrong} onRetry={() => refetch()} />
      ) : (
        <DataTable
          columns={columns}
          rows={data ?? []}
          rowKey={(p) => p.id}
          loading={isLoading}
          empty="No projects"
        />
      )}
    </div>
  );
}
