'use client';
import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { CustomerShell } from '../../_shell/CustomerShell';
import { Card, Skeleton } from '@/components/Card';
import { EmptyState, ErrorState } from '@/components/EmptyState';
import { StatusChip } from '@/components/StatusChip';
import { PlotMap } from '@/components/PlotMap';
import { PlotSheet } from '@/components/PlotSheet';
import { ShieldIcon, MapIcon, ListIcon } from '@/components/icons';
import { useProject, useProjectMap } from '@/lib/queries';
import { ApiError } from '@/lib/api';
import { formatINR } from '@/lib/format';
import { S } from '@/lib/strings';
import type { MapPlot } from '@/lib/types';

const LEGEND = [
  { color: '#16a34a', label: S.project.legend.available },
  { color: '#f59e0b', label: S.project.legend.onhold },
  { color: '#2563eb', label: S.project.legend.reserved },
  { color: '#6b7280', label: S.project.legend.sold },
];

export default function ProjectPage({ params }: { params: { slug: string } }) {
  const slug = params.slug;
  const qc = useQueryClient();
  const {
    data: project,
    isLoading: pLoading,
    isError: pError,
    refetch: refetchProject,
  } = useProject(slug);
  const {
    data: map,
    isLoading: mLoading,
    error: mError,
  } = useProjectMap(project?.id);

  const [view, setView] = useState<'map' | 'list'>('map');
  const [selected, setSelected] = useState<MapPlot | null>(null);
  const [descOpen, setDescOpen] = useState(false);

  const mapMissing = mError instanceof ApiError && mError.code === 'MAP_NOT_FOUND';

  const listPlots = useMemo(
    () => (map?.plots ?? []).filter((p) => p.status !== 'WITHDRAWN'),
    [map],
  );

  function refetchMap() {
    if (project?.id) qc.invalidateQueries({ queryKey: ['map', project.id] });
  }

  return (
    <CustomerShell>
      {pLoading ? (
        <div className="space-y-3">
          <Skeleton className="h-7 w-2/3" />
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="mt-4 h-[50vh] w-full" />
        </div>
      ) : pError || !project ? (
        <ErrorState message={S.project.error} onRetry={() => refetchProject()} />
      ) : (
        <>
          <div className="mb-3">
            <h1 className="text-gp-2xl font-semibold text-ink">{project.name}</h1>
            <p className="text-gp-sm text-muted">
              {project.district}, {project.state}
            </p>
            {project.rera_registered && (
              <span className="mt-1 inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-semibold text-primary">
                <ShieldIcon width={13} height={13} />
                {S.home.reraBadge(project.rera_number)}
              </span>
            )}
            {project.description && (
              <p className={`mt-2 text-gp-base text-muted ${descOpen ? '' : 'line-clamp-3'}`}>
                {project.description}
              </p>
            )}
            {project.description && project.description.length > 120 && (
              <button
                className="mt-1 text-gp-sm font-semibold text-primary"
                onClick={() => setDescOpen((o) => !o)}
              >
                {descOpen ? S.project.less : S.project.more}
              </button>
            )}
            {project.amenities && project.amenities.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-1.5">
                {project.amenities.map((a) => (
                  <span
                    key={a}
                    className="rounded-full bg-bg px-2.5 py-0.5 text-gp-sm text-muted"
                  >
                    {a}
                  </span>
                ))}
              </div>
            )}
          </div>

          {/* Map | List toggle */}
          <div className="mb-3 inline-flex rounded-control border border-line bg-white p-0.5">
            <ToggleBtn active={view === 'map'} onClick={() => setView('map')} icon={<MapIcon width={16} height={16} />}>
              {S.project.mapTab}
            </ToggleBtn>
            <ToggleBtn active={view === 'list'} onClick={() => setView('list')} icon={<ListIcon width={16} height={16} />}>
              {S.project.listTab}
            </ToggleBtn>
          </div>

          {/* Legend */}
          <div className="mb-3 flex flex-wrap gap-3">
            {LEGEND.map((l) => (
              <span key={l.label} className="flex items-center gap-1.5 text-gp-sm text-muted">
                <span className="h-3 w-3 rounded-sm" style={{ backgroundColor: l.color }} />
                {l.label}
              </span>
            ))}
          </div>

          {mapMissing ? (
            <EmptyState icon={<MapIcon width={32} height={32} />} title={S.project.mapMissing} />
          ) : mLoading ? (
            <Skeleton className="h-[60vh] w-full" />
          ) : !map || listPlots.length === 0 ? (
            <EmptyState title={S.project.noPlots} />
          ) : view === 'map' ? (
            <div className="h-[60vh] w-full">
              <PlotMap
                imageUrl={map.image_url}
                width={map.width_px}
                height={map.height_px}
                plots={map.plots}
                selectedId={selected?.plot_id}
                onSelect={(p) => setSelected(p)}
              />
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {listPlots.map((p) => (
                <Card key={p.plot_id} onClick={() => setSelected(p)} className="p-3">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="font-semibold text-ink">{p.plot_number}</p>
                      <p className="text-gp-sm text-muted">
                        {p.area_sqft} sqft · {p.facing || '—'}
                      </p>
                    </div>
                    <div className="flex flex-col items-end gap-1">
                      <span className="font-semibold text-primary">{formatINR(p.price_paise)}</span>
                      <StatusChip status={p.status} />
                    </div>
                  </div>
                </Card>
              ))}
            </div>
          )}
        </>
      )}

      <PlotSheet
        plot={selected}
        slug={slug}
        onClose={() => setSelected(null)}
        onConflict={refetchMap}
      />
    </CustomerShell>
  );
}

function ToggleBtn({
  active,
  onClick,
  icon,
  children,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 rounded-[6px] px-3 py-1.5 text-gp-sm font-semibold transition ${
        active ? 'bg-primary text-white' : 'text-muted'
      }`}
    >
      {icon}
      {children}
    </button>
  );
}
