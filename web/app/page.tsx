'use client';
import { useRouter } from 'next/navigation';
import { CustomerShell } from './_shell/CustomerShell';
import { Card, Skeleton } from '@/components/Card';
import { EmptyState, ErrorState } from '@/components/EmptyState';
import { ShieldIcon, BuildingIcon } from '@/components/icons';
import { useProjects } from '@/lib/queries';
import { formatINRRange } from '@/lib/format';
import { S } from '@/lib/strings';
import type { ProjectSummary } from '@/lib/types';

function ProjectCard({ p, onOpen }: { p: ProjectSummary; onOpen: () => void }) {
  return (
    <Card onClick={onOpen} className="overflow-hidden">
      <div className="relative flex h-32 items-center justify-center bg-gradient-to-br from-primary/10 to-primary/25">
        {p.cover_image_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={p.cover_image_url} alt={p.name} className="h-full w-full object-cover" />
        ) : (
          <BuildingIcon width={40} height={40} className="text-primary/50" />
        )}
        {p.rera_registered && (
          <span className="absolute right-2 top-2 inline-flex items-center gap-1 rounded-full bg-white/90 px-2 py-0.5 text-[11px] font-semibold text-primary shadow-sm">
            <ShieldIcon width={13} height={13} />
            {S.home.reraBadge(p.rera_number)}
          </span>
        )}
      </div>
      <div className="p-4">
        <h3 className="text-gp-lg font-semibold text-ink">{p.name}</h3>
        <p className="text-gp-sm text-muted">
          {p.district}, {p.state}
        </p>
        <div className="mt-2 flex items-center justify-between">
          <span className="text-gp-base font-semibold text-primary">
            {formatINRRange(p.price_range_paise.min, p.price_range_paise.max)}
          </span>
          <span className="text-gp-sm text-muted">
            {S.home.availability(p.plot_counts.available, p.plot_counts.total)}
          </span>
        </div>
      </div>
    </Card>
  );
}

export default function HomePage() {
  const router = useRouter();
  const { data, isLoading, isError, refetch } = useProjects();

  return (
    <CustomerShell>
      <h1 className="mb-3 text-gp-2xl font-semibold text-ink">{S.home.title}</h1>
      {isLoading ? (
        <div className="flex flex-col gap-4">
          {[0, 1, 2].map((i) => (
            <Card key={i} className="overflow-hidden">
              <Skeleton className="h-32 w-full rounded-none" />
              <div className="space-y-2 p-4">
                <Skeleton className="h-5 w-1/2" />
                <Skeleton className="h-4 w-1/3" />
              </div>
            </Card>
          ))}
        </div>
      ) : isError ? (
        <ErrorState message={S.home.error} onRetry={() => refetch()} />
      ) : !data || data.length === 0 ? (
        <EmptyState icon={<BuildingIcon width={32} height={32} />} title={S.home.empty} />
      ) : (
        <div className="flex flex-col gap-4">
          {data.map((p) => (
            <ProjectCard key={p.id} p={p} onOpen={() => router.push(`/p/${p.slug}`)} />
          ))}
        </div>
      )}
    </CustomerShell>
  );
}
