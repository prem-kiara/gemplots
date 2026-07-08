'use client';
import { useRouter } from 'next/navigation';
import { Skeleton } from '@/components/Card';
import { EmptyState, ErrorState } from '@/components/EmptyState';
import { useAdminProject } from '@/lib/queries';
import { S } from '@/lib/strings';
import { PolygonEditor } from '@/components/PolygonEditor';

export default function MapEditorPage({
  params,
}: {
  params: { id: string; siteMapId: string };
}) {
  const router = useRouter();
  const { data, isLoading, isError, refetch } = useAdminProject(params.id);

  if (isLoading) return <Skeleton className="h-[70vh] w-full rounded-card" />;
  if (isError || !data)
    return <ErrorState message={S.common.somethingWrong} onRetry={() => refetch()} />;

  const siteMap = data.site_maps.find((m) => m.id === params.siteMapId);
  if (!siteMap)
    return (
      <EmptyState
        title={S.admin.projectDetail.notFound}
        cta={S.admin.editor.back}
        onCta={() => router.push(`/admin/projects/${params.id}`)}
      />
    );

  return (
    <PolygonEditor
      projectId={params.id}
      siteMap={siteMap}
      plots={data.plots}
      onBack={() => router.push(`/admin/projects/${params.id}`)}
    />
  );
}
