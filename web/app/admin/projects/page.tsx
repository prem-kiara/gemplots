'use client';
import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { DataTable, type Column } from '@/components/DataTable';
import { ErrorState } from '@/components/EmptyState';
import { StatusChip } from '@/components/StatusChip';
import { Button } from '@/components/Button';
import { Input, TextArea } from '@/components/Input';
import { ShieldIcon } from '@/components/icons';
import { useToast } from '@/components/Toast';
import { useAdminProjects } from '@/lib/queries';
import { api, ApiError } from '@/lib/api';
import { S } from '@/lib/strings';
import type { AdminProjectRow, CreateProjectBody } from '@/lib/types';

export default function AdminProjectsPage() {
  const { data, isLoading, isError, refetch } = useAdminProjects();
  const [showCreate, setShowCreate] = useState(false);

  const columns: Column<AdminProjectRow>[] = useMemo(
    () => [
      { header: S.admin.projects.name, cell: (p) => <span className="font-medium text-ink">{p.name}</span> },
      { header: S.admin.projects.status, cell: (p) => <StatusChip status={p.status} /> },
      { header: S.admin.projects.district, cell: (p) => <span className="text-muted">{p.district || '—'}</span> },
      { header: S.admin.projects.plots, cell: (p) => <span className="text-ink">{p.plot_count}</span> },
      {
        header: S.admin.projects.rera,
        cell: (p) =>
          p.rera_registered ? (
            <span className="inline-flex items-center gap-1 text-primary">
              <ShieldIcon width={15} height={15} />
              {S.admin.projects.reraYes}
            </span>
          ) : (
            <span className="text-muted">—</span>
          ),
      },
    ],
    [],
  );

  const rows = data?.items ?? [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-gp-2xl font-semibold text-ink">{S.admin.projects.title}</h1>
        <Button onClick={() => setShowCreate(true)}>{S.admin.projects.newProject}</Button>
      </div>

      {isError ? (
        <ErrorState message={S.admin.projects.error} onRetry={() => refetch()} />
      ) : (
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(p) => p.id}
          loading={isLoading}
          onRowClick={(p) => (window.location.href = `/admin/projects/${p.id}`)}
          empty={S.admin.projects.empty}
        />
      )}

      {showCreate && <CreateProjectModal onClose={() => setShowCreate(false)} />}
    </div>
  );
}

function CreateProjectModal({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const qc = useQueryClient();
  const toast = useToast();

  const [form, setForm] = useState({
    name: '',
    description: '',
    address_line: '',
    district: '',
    state: 'Tamil Nadu',
    pincode: '',
    lat: '',
    lng: '',
    amenities: '',
    rera_registered: false,
    rera_number: '',
    max_advance_percentage: '',
    hold_minutes_override: '',
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);

  function set<K extends keyof typeof form>(k: K, v: (typeof form)[K]) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  function validate(): boolean {
    const e: Record<string, string> = {};
    if (!form.name.trim()) e.name = S.admin.projects.nameRequired;
    if (form.rera_registered && !form.rera_number.trim())
      e.rera_number = S.admin.projects.reraNumberRequired;
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  async function submit() {
    if (!validate()) return;
    setSubmitting(true);
    const body: CreateProjectBody = {
      name: form.name.trim(),
      description: form.description.trim() || undefined,
      address_line: form.address_line.trim() || undefined,
      district: form.district.trim() || undefined,
      state: form.state.trim() || undefined,
      pincode: form.pincode.trim() || undefined,
      lat: form.lat.trim() ? Number(form.lat) : undefined,
      lng: form.lng.trim() ? Number(form.lng) : undefined,
      amenities: form.amenities.trim()
        ? form.amenities.split(',').map((a) => a.trim()).filter(Boolean)
        : undefined,
      rera_registered: form.rera_registered,
      rera_number: form.rera_registered ? form.rera_number.trim() : undefined,
      max_advance_percentage: form.max_advance_percentage.trim()
        ? Number(form.max_advance_percentage)
        : undefined,
      hold_minutes_override: form.hold_minutes_override.trim()
        ? Number(form.hold_minutes_override)
        : undefined,
    };
    try {
      const created = await api<{ id: string }>('/v1/admin/projects', { method: 'POST', body });
      toast.success(S.admin.projects.created);
      qc.invalidateQueries({ queryKey: ['admin', 'projects'] });
      router.push(`/admin/projects/${created.id}`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : S.admin.projects.createError);
      setSubmitting(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center overflow-y-auto p-4"
      role="dialog"
      aria-modal="true"
      aria-label={S.admin.projects.createTitle}
    >
      <div className="absolute inset-0 bg-ink/40" onClick={onClose} aria-hidden="true" />
      <div className="relative z-10 my-8 w-full max-w-lg rounded-card bg-white p-5 shadow-modal">
        <h2 className="mb-4 text-gp-lg font-semibold text-ink">{S.admin.projects.createTitle}</h2>
        <div className="space-y-3">
          <Input
            label={S.admin.projects.fieldName}
            value={form.name}
            onChange={(e) => set('name', e.target.value)}
            error={errors.name}
          />
          <TextArea
            label={S.admin.projects.fieldDescription}
            value={form.description}
            onChange={(e) => set('description', e.target.value)}
          />
          <Input
            label={S.admin.projects.fieldAddress}
            value={form.address_line}
            onChange={(e) => set('address_line', e.target.value)}
          />
          <div className="grid grid-cols-2 gap-3">
            <Input
              label={S.admin.projects.fieldDistrict}
              value={form.district}
              onChange={(e) => set('district', e.target.value)}
            />
            <Input
              label={S.admin.projects.fieldState}
              value={form.state}
              onChange={(e) => set('state', e.target.value)}
            />
            <Input
              label={S.admin.projects.fieldPincode}
              value={form.pincode}
              onChange={(e) => set('pincode', e.target.value)}
            />
            <Input
              label={S.admin.projects.fieldAdvancePct}
              type="number"
              value={form.max_advance_percentage}
              onChange={(e) => set('max_advance_percentage', e.target.value)}
            />
            <Input
              label={S.admin.projects.fieldLat}
              type="number"
              value={form.lat}
              onChange={(e) => set('lat', e.target.value)}
            />
            <Input
              label={S.admin.projects.fieldLng}
              type="number"
              value={form.lng}
              onChange={(e) => set('lng', e.target.value)}
            />
            <Input
              label={S.admin.projects.fieldHoldOverride}
              type="number"
              value={form.hold_minutes_override}
              onChange={(e) => set('hold_minutes_override', e.target.value)}
            />
          </div>
          <Input
            label={S.admin.projects.fieldAmenities}
            value={form.amenities}
            onChange={(e) => set('amenities', e.target.value)}
          />
          <label className="flex items-center gap-2 py-1 text-gp-base text-ink">
            <input
              type="checkbox"
              checked={form.rera_registered}
              onChange={(e) => set('rera_registered', e.target.checked)}
              className="h-4 w-4 accent-[var(--gp-primary)]"
            />
            {S.admin.projects.fieldReraRegistered}
          </label>
          {form.rera_registered && (
            <Input
              label={S.admin.projects.fieldReraNumber}
              value={form.rera_number}
              onChange={(e) => set('rera_number', e.target.value)}
              error={errors.rera_number}
            />
          )}
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={submitting}>
            {S.common.cancel}
          </Button>
          <Button onClick={submit} loading={submitting}>
            {S.admin.projects.create}
          </Button>
        </div>
      </div>
    </div>
  );
}
