'use client';
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Card } from '@/components/Card';
import { Button } from '@/components/Button';
import { Input, TextArea } from '@/components/Input';
import { useToast } from '@/components/Toast';
import { api, ApiError } from '@/lib/api';
import { S } from '@/lib/strings';
import type { AdminProjectDetail } from '@/lib/types';

// A small lock glyph for controlled (approval-gated) fields.
function Lock() {
  return (
    <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
      <rect x="4" y="11" width="16" height="9" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  );
}

export function DetailsTab({ project }: { project: AdminProjectDetail }) {
  const qc = useQueryClient();
  const toast = useToast();

  const [form, setForm] = useState({
    description: project.description ?? '',
    address_line: project.address_line ?? '',
    district: project.district ?? '',
    state: project.state ?? '',
    pincode: project.pincode ?? '',
    lat: project.lat != null ? String(project.lat) : '',
    lng: project.lng != null ? String(project.lng) : '',
    amenities: (project.amenities ?? []).join(', '),
  });
  const [saving, setSaving] = useState(false);

  function set<K extends keyof typeof form>(k: K, v: (typeof form)[K]) {
    setForm((f) => ({ ...f, [k]: v }));
  }

  async function save() {
    const body: Record<string, unknown> = {
      description: form.description,
      address_line: form.address_line,
      district: form.district,
      state: form.state,
      pincode: form.pincode,
      amenities: form.amenities.trim()
        ? form.amenities.split(',').map((a) => a.trim()).filter(Boolean)
        : [],
    };
    if (form.lat.trim()) body.lat = Number(form.lat);
    if (form.lng.trim()) body.lng = Number(form.lng);

    setSaving(true);
    try {
      await api(`/v1/admin/projects/${project.id}`, { method: 'PATCH', body });
      toast.success(S.admin.projectDetail.detailsSaved);
      qc.invalidateQueries({ queryKey: ['admin', 'project', project.id] });
      qc.invalidateQueries({ queryKey: ['admin', 'projects'] });
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : S.admin.projectDetail.detailsError);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {/* Editable non-controlled fields */}
      <Card className="space-y-3 p-5">
        <h2 className="text-gp-base font-semibold text-ink">{S.admin.projectDetail.tabs.details}</h2>
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
          <div />
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
        </div>
        <Input
          label={S.admin.projects.fieldAmenities}
          value={form.amenities}
          onChange={(e) => set('amenities', e.target.value)}
        />
        <div className="flex justify-end">
          <Button onClick={save} loading={saving}>
            {S.admin.projectDetail.saveDetails}
          </Button>
        </div>
      </Card>

      {/* Controlled (approval-gated) fields — read-only */}
      <Card className="space-y-3 p-5">
        <h2 className="text-gp-base font-semibold text-ink">Controlled fields</h2>
        <ControlledRow label={S.admin.projects.fieldName} value={project.name} />
        <ControlledRow label={S.admin.projects.status} value={project.status} />
        <ControlledRow
          label={S.admin.projects.fieldReraRegistered}
          value={project.rera_registered ? `Yes — ${project.rera_number ?? ''}` : 'No'}
        />
        <ControlledRow
          label={S.admin.projects.fieldAdvancePct}
          value={`${project.max_advance_percentage}%`}
        />
        <ControlledRow
          label="Hold override"
          value={project.hold_minutes_override != null ? `${project.hold_minutes_override} min` : '—'}
        />
        <p className="pt-1 text-gp-sm text-muted">{S.admin.projectDetail.publishNote}</p>
      </Card>
    </div>
  );
}

function ControlledRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-line pb-2 last:border-0">
      <span className="inline-flex items-center gap-1.5 text-gp-sm text-muted" title={S.admin.projectDetail.controlledNote}>
        <Lock />
        {label}
      </span>
      <span className="text-right text-gp-sm font-medium text-ink">{value}</span>
    </div>
  );
}
