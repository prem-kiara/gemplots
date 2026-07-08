'use client';
import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { Card } from '@/components/Card';
import { Button } from '@/components/Button';
import { EmptyState } from '@/components/EmptyState';
import { useToast } from '@/components/Toast';
import { api, ApiError } from '@/lib/api';
import { formatIST } from '@/lib/format';
import { S } from '@/lib/strings';
import type { AdminProjectDetail, UploadMapResult } from '@/lib/types';

/** Read a file as a base64 string (no data: prefix) + its natural pixel dimensions. */
async function readImage(file: File): Promise<{ base64: string; width: number; height: number }> {
  const dataUrl: string = await new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error('read failed'));
    r.readAsDataURL(file);
  });
  const base64 = dataUrl.split(',')[1] ?? '';
  const { width, height } = await new Promise<{ width: number; height: number }>(
    (resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
      img.onerror = () => reject(new Error('decode failed'));
      img.src = dataUrl;
    },
  );
  return { base64, width, height };
}

export function SiteMapTab({ project }: { project: AdminProjectDetail }) {
  const router = useRouter();
  const qc = useQueryClient();
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      const { base64, width, height } = await readImage(file);
      if (!width || !height) throw new Error('bad dimensions');
      const res = await api<UploadMapResult>(`/v1/admin/projects/${project.id}/site-maps`, {
        method: 'POST',
        body: {
          image_base64: base64,
          content_type: file.type || 'image/png',
          width_px: width,
          height_px: height,
        },
      });
      toast.success(S.admin.projectDetail.mapUploaded);
      qc.invalidateQueries({ queryKey: ['admin', 'project', project.id] });
      // Open the editor for the freshly-uploaded version.
      router.push(`/admin/projects/${project.id}/map/${res.site_map_id}`);
    } catch (err) {
      if (err instanceof ApiError) toast.error(err.message);
      else toast.error(S.admin.projectDetail.mapBadImage);
      setUploading(false);
    } finally {
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <label
          className={`inline-flex min-h-[44px] cursor-pointer items-center gap-2 rounded-control bg-primary px-4 py-2 text-gp-base font-semibold text-white hover:bg-primary-dark ${
            uploading ? 'pointer-events-none opacity-50' : ''
          }`}
        >
          {uploading ? S.admin.projectDetail.mapUploading : S.admin.projectDetail.mapUploadNew}
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={onFile}
            disabled={uploading}
          />
        </label>
      </div>

      {project.site_maps.length === 0 ? (
        <EmptyState title={S.admin.projectDetail.noMaps} />
      ) : (
        <div className="space-y-3">
          {project.site_maps.map((m) => (
            <Card key={m.id} className="flex flex-wrap items-center justify-between gap-3 p-4">
              <div className="flex items-center gap-3">
                <span className="text-gp-base font-semibold text-ink">
                  {S.admin.projectDetail.mapVersion} {m.version}
                </span>
                {m.is_active && (
                  <span className="rounded-full bg-primary/15 px-2.5 py-0.5 text-gp-sm font-semibold text-primary">
                    {S.admin.projectDetail.mapActive}
                  </span>
                )}
                <span className="text-gp-sm text-muted">
                  {m.width_px}×{m.height_px}px · {m.geometries.length}/{project.plots.length} assigned
                </span>
                <span className="text-gp-sm text-muted">{formatIST(m.created_at)}</span>
              </div>
              <Button
                variant="secondary"
                onClick={() => router.push(`/admin/projects/${project.id}/map/${m.id}`)}
              >
                {S.admin.projectDetail.mapOpenEditor}
              </Button>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
