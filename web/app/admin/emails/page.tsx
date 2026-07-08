'use client';
import { useMemo, useState } from 'react';
import { DataTable, type Column } from '@/components/DataTable';
import { ErrorState } from '@/components/EmptyState';
import { StatusChip } from '@/components/StatusChip';
import { XIcon } from '@/components/icons';
import { useEmails } from '@/lib/queries';
import { formatIST } from '@/lib/format';
import { S } from '@/lib/strings';
import type { EmailRow } from '@/lib/types';

export default function EmailsPage() {
  const { data, isLoading, isError, refetch } = useEmails();
  const [selected, setSelected] = useState<EmailRow | null>(null);

  const columns: Column<EmailRow>[] = useMemo(
    () => [
      { header: S.admin.emails.to, cell: (r) => <span className="text-ink">{r.to_email}</span> },
      { header: S.admin.emails.template, cell: (r) => <span className="text-muted">{r.template}</span> },
      {
        header: S.admin.emails.subject,
        cell: (r) => <span className="line-clamp-1 max-w-[280px] text-ink">{r.subject}</span>,
      },
      { header: S.admin.emails.status, cell: (r) => <StatusChip status={r.status} /> },
      { header: S.admin.emails.time, cell: (r) => <span className="text-muted">{formatIST(r.created_at)}</span> },
    ],
    [],
  );

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-gp-2xl font-semibold text-ink">{S.admin.emails.title}</h1>
        <p className="text-gp-sm text-muted">{S.admin.emails.subtitle}</p>
      </div>

      {isError ? (
        <ErrorState message={S.common.somethingWrong} onRetry={() => refetch()} />
      ) : (
        <DataTable
          columns={columns}
          rows={data?.items ?? []}
          rowKey={(r) => r.id}
          loading={isLoading}
          onRowClick={(r) => setSelected(r)}
          empty={S.admin.emails.empty}
        />
      )}

      {/* Body drawer */}
      {selected && (
        <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true">
          <div className="absolute inset-0 bg-ink/30" onClick={() => setSelected(null)} aria-hidden="true" />
          <div className="relative z-10 flex h-full w-full max-w-xl flex-col bg-white shadow-modal">
            <div className="flex items-start justify-between border-b border-line px-5 py-3">
              <div>
                <p className="text-gp-base font-semibold text-ink">{selected.subject}</p>
                <p className="text-gp-sm text-muted">
                  {selected.to_email} · {selected.template}
                </p>
              </div>
              <button
                aria-label="Close"
                onClick={() => setSelected(null)}
                className="rounded-full p-1 text-muted hover:bg-bg"
              >
                <XIcon />
              </button>
            </div>
            <div className="flex-1 overflow-auto p-5">
              <pre className="whitespace-pre-wrap break-words font-sans text-gp-sm text-ink">
                {selected.body_text}
              </pre>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
