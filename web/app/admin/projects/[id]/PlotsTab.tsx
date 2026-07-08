'use client';
import { useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Card } from '@/components/Card';
import { Button } from '@/components/Button';
import { DataTable, type Column } from '@/components/DataTable';
import { StatusChip } from '@/components/StatusChip';
import { useToast } from '@/components/Toast';
import { api, ApiError } from '@/lib/api';
import { formatINR } from '@/lib/format';
import { S } from '@/lib/strings';
import type { AdminPlotRow, AdminProjectDetail, BulkResult } from '@/lib/types';

const CSV_HEADER = 'plot_number,facing,dimensions_text,area_sqft,price_inr';

interface PreviewRow {
  rowNum: number;
  cells: string[];
  errors: string[];
}

export function PlotsTab({ project }: { project: AdminProjectDetail }) {
  const qc = useQueryClient();
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);

  const [csv, setCsv] = useState('');
  const [preview, setPreview] = useState<PreviewRow[] | null>(null);
  const [headerCells, setHeaderCells] = useState<string[]>([]);
  const [validating, setValidating] = useState(false);
  const [importing, setImporting] = useState(false);

  const columns: Column<AdminPlotRow>[] = useMemo(
    () => [
      { header: S.admin.projectDetail.plotNumber, cell: (p) => <span className="font-medium text-ink">{p.plot_number}</span> },
      { header: S.admin.projectDetail.facing, cell: (p) => <span className="text-muted">{p.facing || '—'}</span> },
      { header: S.admin.projectDetail.area, cell: (p) => <span className="text-ink">{p.area_sqft} sqft</span> },
      { header: S.admin.projectDetail.price, cell: (p) => <span className="text-ink">{formatINR(p.price_paise)}</span> },
      { header: S.admin.projectDetail.plotStatus, cell: (p) => <StatusChip status={p.status} /> },
    ],
    [],
  );

  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      setCsv(String(reader.result ?? ''));
      setPreview(null);
    };
    reader.readAsText(file);
  }

  // Build the preview locally (header + cells) and merge server-side row errors from dry-run.
  async function validate() {
    if (!csv.trim()) return;
    setValidating(true);
    try {
      const res = await api<BulkResult>(
        `/v1/admin/projects/${project.id}/plots/bulk?dry_run=true`,
        { method: 'POST', body: { csv } },
      );
      const lines = csv.split(/\r?\n/).filter((l) => l.trim().length > 0);
      const header = (lines[0] ?? '').split(',').map((c) => c.trim());
      setHeaderCells(header);
      // Group server errors by their 1-based row number.
      const byRow = new Map<number, string[]>();
      for (const e of res.errors) {
        const arr = byRow.get(e.row) ?? [];
        arr.push(e.message);
        byRow.set(e.row, arr);
      }
      const rows: PreviewRow[] = [];
      for (let i = 1; i < lines.length; i++) {
        const rowNum = i + 1; // matches server row numbering (header is row 1)
        rows.push({
          rowNum,
          cells: lines[i].split(',').map((c) => c.trim()),
          errors: byRow.get(rowNum) ?? [],
        });
      }
      // Header-level errors (row 1), e.g. missing column.
      const headerErrors = byRow.get(1);
      if (headerErrors) {
        rows.unshift({ rowNum: 1, cells: header, errors: headerErrors });
      }
      setPreview(rows);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : S.admin.projectDetail.csvError);
    } finally {
      setValidating(false);
    }
  }

  const errorCount = preview?.reduce((n, r) => n + r.errors.length, 0) ?? 0;
  const canImport = !!preview && preview.length > 0 && errorCount === 0;

  async function doImport() {
    setImporting(true);
    try {
      const res = await api<BulkResult>(
        `/v1/admin/projects/${project.id}/plots/bulk?dry_run=false`,
        { method: 'POST', body: { csv } },
      );
      if (res.errors.length > 0) {
        toast.error(S.admin.projectDetail.csvHasErrors);
        return;
      }
      toast.success(S.admin.projectDetail.csvImported(res.inserted));
      setCsv('');
      setPreview(null);
      if (fileRef.current) fileRef.current.value = '';
      qc.invalidateQueries({ queryKey: ['admin', 'project', project.id] });
      qc.invalidateQueries({ queryKey: ['admin', 'projects'] });
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : S.admin.projectDetail.csvError);
    } finally {
      setImporting(false);
    }
  }

  return (
    <div className="space-y-4">
      <DataTable
        columns={columns}
        rows={project.plots}
        rowKey={(p) => p.id}
        empty={S.admin.projectDetail.noPlots}
      />

      <Card className="space-y-3 p-5">
        <h2 className="text-gp-base font-semibold text-ink">{S.admin.projectDetail.csvTitle}</h2>
        <p className="text-gp-sm text-muted">{S.admin.projectDetail.csvHelper}</p>

        <div className="flex flex-wrap items-center gap-3">
          <label className="inline-flex cursor-pointer items-center gap-2 rounded-control border border-line bg-white px-4 py-2 text-gp-base font-semibold text-ink hover:bg-bg">
            {S.admin.projectDetail.csvPickFile}
            <input ref={fileRef} type="file" accept=".csv,text/csv" className="hidden" onChange={onFile} />
          </label>
        </div>

        <textarea
          value={csv}
          onChange={(e) => {
            setCsv(e.target.value);
            setPreview(null);
          }}
          placeholder={`${CSV_HEADER}\nP-01,E,30x40,1200,1800000`}
          rows={5}
          className="w-full rounded-control border border-line px-3 py-2 font-mono text-gp-sm text-ink outline-none focus-visible:ring-2 focus-visible:ring-primary"
          aria-label={S.admin.projectDetail.csvPaste}
        />

        <div className="flex flex-wrap items-center gap-2">
          <Button variant="secondary" onClick={validate} loading={validating} disabled={!csv.trim()}>
            {S.admin.projectDetail.csvValidate}
          </Button>
          <Button onClick={doImport} loading={importing} disabled={!canImport}>
            {S.admin.projectDetail.csvImport}
          </Button>
          {preview && errorCount > 0 && (
            <span className="text-gp-sm font-medium text-danger">
              {errorCount} error{errorCount === 1 ? '' : 's'} — {S.admin.projectDetail.csvHasErrors}
            </span>
          )}
        </div>

        {preview && (
          <div className="overflow-x-auto rounded-card border border-line">
            <table className="w-full min-w-[560px] text-left text-gp-sm">
              <thead>
                <tr className="border-b border-line bg-bg text-muted">
                  <th className="px-3 py-2 font-semibold">{S.admin.projectDetail.csvRow}</th>
                  {(headerCells.length ? headerCells : CSV_HEADER.split(',')).map((h, i) => (
                    <th key={i} className="px-3 py-2 font-semibold">
                      {h}
                    </th>
                  ))}
                  <th className="px-3 py-2 font-semibold">Errors</th>
                </tr>
              </thead>
              <tbody>
                {preview.length === 0 ? (
                  <tr>
                    <td colSpan={3} className="px-3 py-6 text-center text-muted">
                      {S.admin.projectDetail.csvNoRows}
                    </td>
                  </tr>
                ) : (
                  preview.map((r) => (
                    <tr
                      key={r.rowNum}
                      className={`border-b border-line last:border-0 ${
                        r.errors.length ? 'bg-danger/5' : ''
                      }`}
                    >
                      <td className="px-3 py-2 text-muted">{r.rowNum}</td>
                      {r.cells.map((c, i) => (
                        <td key={i} className="px-3 py-2 text-ink">
                          {c}
                        </td>
                      ))}
                      <td className="px-3 py-2 text-danger">{r.errors.join('; ')}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
