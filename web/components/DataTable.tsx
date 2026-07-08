'use client';
import type { ReactNode } from 'react';
import { Button } from './Button';
import { Skeleton } from './Card';

export interface Column<T> {
  header: string;
  cell: (row: T) => ReactNode;
  className?: string;
}

// §6 admin DataTable: header, rows, cursor "Load more", per-column truncation. No sorting Phase 1.
export function DataTable<T>({
  columns,
  rows,
  rowKey,
  onRowClick,
  loading = false,
  hasMore = false,
  loadingMore = false,
  onLoadMore,
  empty,
}: {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  onRowClick?: (row: T) => void;
  loading?: boolean;
  hasMore?: boolean;
  loadingMore?: boolean;
  onLoadMore?: () => void;
  empty?: ReactNode;
}) {
  return (
    <div className="overflow-hidden rounded-card border border-line bg-white shadow-card">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[560px] text-left text-gp-sm">
          <thead>
            <tr className="border-b border-line bg-bg text-muted">
              {columns.map((c) => (
                <th key={c.header} className={`px-4 py-2.5 font-semibold ${c.className ?? ''}`}>
                  {c.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              Array.from({ length: 5 }).map((_, i) => (
                <tr key={i} className="border-b border-line last:border-0">
                  {columns.map((c) => (
                    <td key={c.header} className="px-4 py-3">
                      <Skeleton className="h-4 w-24" />
                    </td>
                  ))}
                </tr>
              ))
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={columns.length} className="px-4 py-10 text-center text-muted">
                  {empty ?? 'No data'}
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr
                  key={rowKey(row)}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                  tabIndex={onRowClick ? 0 : undefined}
                  onKeyDown={
                    onRowClick
                      ? (e) => {
                          if (e.key === 'Enter') onRowClick(row);
                        }
                      : undefined
                  }
                  className={`border-b border-line align-middle last:border-0 ${
                    onRowClick ? 'cursor-pointer hover:bg-bg focus-visible:bg-bg focus-visible:outline-none' : ''
                  }`}
                >
                  {columns.map((c) => (
                    <td key={c.header} className={`px-4 py-3 text-ink ${c.className ?? ''}`}>
                      {c.cell(row)}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      {hasMore && (
        <div className="flex justify-center border-t border-line p-3">
          <Button variant="secondary" onClick={onLoadMore} loading={loadingMore}>
            Load more
          </Button>
        </div>
      )}
    </div>
  );
}
