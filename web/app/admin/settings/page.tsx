'use client';
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { DataTable, type Column } from '@/components/DataTable';
import { EmptyState, ErrorState } from '@/components/EmptyState';
import { Button } from '@/components/Button';
import { Input } from '@/components/Input';
import { useToast } from '@/components/Toast';
import { useSettings } from '@/lib/queries';
import { api, ApiError, getUser } from '@/lib/api';
import { canSeeSettings, isSuperAdmin } from '@/lib/auth';
import { formatIST } from '@/lib/format';
import { S } from '@/lib/strings';
import type { GlobalSetting } from '@/lib/types';

/** Render a jsonb setting value compactly (numbers/strings inline, arrays/objects as JSON). */
function showValue(v: unknown): string {
  if (v == null) return '—';
  if (typeof v === 'number' || typeof v === 'string') return String(v);
  return JSON.stringify(v);
}

export default function SettingsPage() {
  const user = getUser();
  const allowed = canSeeSettings(user);
  const canEdit = isSuperAdmin(user);
  const qc = useQueryClient();
  const toast = useToast();
  const { data, isLoading, isError, refetch } = useSettings();

  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);

  function startEdit(row: GlobalSetting) {
    setEditingKey(row.key);
    setDraft(showValue(row.value));
  }

  async function submit(key: string) {
    // Coerce to a number when the draft is numeric (the backend whitelist keys are all ints).
    const numeric = draft.trim() !== '' && !Number.isNaN(Number(draft));
    const newValue: unknown = numeric ? Number(draft) : draft;
    setSaving(true);
    try {
      await api('/v1/admin/settings', { method: 'POST', body: { key, new_value: newValue } });
      toast.success(S.admin.settings.requested);
      setEditingKey(null);
      qc.invalidateQueries({ queryKey: ['admin', 'approvals'] });
    } catch (err) {
      if (err instanceof ApiError && err.code === 'PENDING_APPROVAL_EXISTS')
        toast.error(S.admin.settings.pending);
      else toast.error(err instanceof ApiError ? err.message : S.admin.settings.error);
    } finally {
      setSaving(false);
    }
  }

  const columns: Column<GlobalSetting>[] = [
    { header: S.admin.settings.key, cell: (r) => <span className="font-medium text-ink">{r.key}</span> },
    {
      header: S.admin.settings.value,
      cell: (r) =>
        editingKey === r.key ? (
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            className="min-w-[140px]"
            aria-label={`New value for ${r.key}`}
          />
        ) : (
          <span className="text-ink">{showValue(r.value)}</span>
        ),
    },
    {
      header: S.admin.settings.updated,
      cell: (r) => <span className="text-muted">{r.updated_at ? formatIST(r.updated_at) : '—'}</span>,
    },
    ...(canEdit
      ? [
          {
            header: '',
            cell: (r: GlobalSetting) =>
              editingKey === r.key ? (
                <div className="flex justify-end gap-2">
                  <Button onClick={() => submit(r.key)} loading={saving}>
                    {S.admin.settings.save}
                  </Button>
                  <Button variant="ghost" onClick={() => setEditingKey(null)}>
                    {S.admin.settings.cancel}
                  </Button>
                </div>
              ) : (
                <div className="flex justify-end">
                  <Button variant="ghost" onClick={() => startEdit(r)}>
                    {S.admin.settings.edit}
                  </Button>
                </div>
              ),
          } as Column<GlobalSetting>,
        ]
      : []),
  ];

  if (!allowed) return <EmptyState title={S.admin.settings.noAccess} />;

  return (
    <div className="space-y-4">
      <h1 className="text-gp-2xl font-semibold text-ink">{S.admin.settings.title}</h1>
      <p className="max-w-2xl text-gp-sm text-muted">{S.admin.settings.subtitle}</p>

      {isError ? (
        <ErrorState message={S.common.somethingWrong} onRetry={() => refetch()} />
      ) : (
        <DataTable
          columns={columns}
          rows={data?.items ?? []}
          rowKey={(r) => r.key}
          loading={isLoading}
          empty={S.admin.settings.empty}
        />
      )}
    </div>
  );
}
