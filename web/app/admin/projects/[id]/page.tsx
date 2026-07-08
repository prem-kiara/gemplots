'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Skeleton } from '@/components/Card';
import { EmptyState, ErrorState } from '@/components/EmptyState';
import { StatusChip } from '@/components/StatusChip';
import { ChevronLeft } from '@/components/icons';
import { useAdminProject } from '@/lib/queries';
import { ApiError } from '@/lib/api';
import { S } from '@/lib/strings';
import { DetailsTab } from './DetailsTab';
import { PlotsTab } from './PlotsTab';
import { SiteMapTab } from './SiteMapTab';

type Tab = 'details' | 'plots' | 'map';

export default function ProjectDetailPage({ params }: { params: { id: string } }) {
  const id = params.id;
  const router = useRouter();
  const { data, isLoading, error, refetch } = useAdminProject(id);
  const [tab, setTab] = useState<Tab>('details');

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-6 w-1/3" />
        <Skeleton className="h-64 w-full rounded-card" />
      </div>
    );
  }
  if (error instanceof ApiError && error.status === 404) {
    return (
      <EmptyState
        title={S.admin.projectDetail.notFound}
        cta={S.admin.projects.title}
        onCta={() => router.push('/admin/projects')}
      />
    );
  }
  if (!data) return <ErrorState message={S.common.somethingWrong} onRetry={() => refetch()} />;

  const tabs: { key: Tab; label: string }[] = [
    { key: 'details', label: S.admin.projectDetail.tabs.details },
    { key: 'plots', label: S.admin.projectDetail.tabs.plots },
    { key: 'map', label: S.admin.projectDetail.tabs.map },
  ];

  return (
    <div className="space-y-4">
      <button
        onClick={() => router.push('/admin/projects')}
        className="inline-flex items-center gap-1 text-gp-sm font-semibold text-muted hover:text-ink"
      >
        <ChevronLeft width={16} height={16} />
        {S.admin.projects.title}
      </button>

      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-gp-xl font-semibold text-ink">{data.name}</h1>
        <StatusChip status={data.status} />
      </div>
      <p className="text-gp-sm text-muted">{S.admin.projectDetail.publishNote}</p>

      <div className="flex gap-1 border-b border-line">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`-mb-px border-b-2 px-4 py-2 text-gp-base font-semibold transition ${
              tab === t.key
                ? 'border-primary text-primary'
                : 'border-transparent text-muted hover:text-ink'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'details' && <DetailsTab project={data} />}
      {tab === 'plots' && <PlotsTab project={data} />}
      {tab === 'map' && <SiteMapTab project={data} />}
    </div>
  );
}
