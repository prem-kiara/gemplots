'use client';
import { useRouter } from 'next/navigation';
import { Card, Skeleton } from '@/components/Card';
import { ErrorState } from '@/components/EmptyState';
import { StatusChip } from '@/components/StatusChip';
import { Countdown } from '@/components/Countdown';
import { InboxIcon } from '@/components/icons';
import { useDashboardSummary } from '@/lib/queries';
import { relativeAge } from '@/lib/format';
import { S } from '@/lib/strings';

const STATUS_COLORS: Record<string, string> = {
  AVAILABLE: '#16a34a',
  ON_HOLD: '#f59e0b',
  RESERVED: '#2563eb',
  SOLD: '#6b7280',
  WITHDRAWN: '#d1d5db',
};

export default function AdminHome() {
  const router = useRouter();
  const { data, isLoading, isError, refetch } = useDashboardSummary();

  if (isLoading) {
    return (
      <div className="grid gap-4 md:grid-cols-2">
        {[0, 1, 2, 3].map((i) => (
          <Card key={i} className="p-5">
            <Skeleton className="h-5 w-1/3" />
            <Skeleton className="mt-3 h-8 w-1/4" />
          </Card>
        ))}
      </div>
    );
  }
  if (isError || !data) return <ErrorState message={S.common.somethingWrong} onRetry={() => refetch()} />;

  const total = Object.values(data.plots_by_status).reduce((a, b) => a + b, 0) || 1;

  return (
    <div className="space-y-4">
      <h1 className="text-gp-2xl font-semibold text-ink">{S.admin.home.title}</h1>

      <div className="grid gap-4 md:grid-cols-2">
        {/* Pending approvals */}
        <Card onClick={() => router.push('/admin/inbox')} className="p-5">
          <div className="flex items-center gap-2 text-muted">
            <InboxIcon width={18} height={18} />
            <span className="text-gp-sm font-semibold">{S.admin.home.pendingApprovals}</span>
          </div>
          <p className="mt-2 text-4xl font-semibold text-primary">{data.approvals_pending}</p>
        </Card>

        {/* Inventory stacked bar */}
        <Card className="p-5">
          <span className="text-gp-sm font-semibold text-muted">{S.admin.home.inventory}</span>
          <div className="mt-3 flex h-3 w-full overflow-hidden rounded-full bg-line">
            {Object.entries(data.plots_by_status).map(([status, n]) =>
              n > 0 ? (
                <div
                  key={status}
                  style={{ width: `${(n / total) * 100}%`, backgroundColor: STATUS_COLORS[status] }}
                  title={`${status}: ${n}`}
                />
              ) : null,
            )}
          </div>
          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-gp-sm">
            {Object.entries(data.plots_by_status).map(([status, n]) => (
              <span key={status} className="flex items-center gap-1.5 text-muted">
                <span
                  className="h-2.5 w-2.5 rounded-sm"
                  style={{ backgroundColor: STATUS_COLORS[status] }}
                />
                {S.status[status] ?? status}: <span className="font-semibold text-ink">{n}</span>
              </span>
            ))}
          </div>
        </Card>
      </div>

      {/* Active holds */}
      <Card className="p-0">
        <div className="border-b border-line px-5 py-3 text-gp-base font-semibold text-ink">
          {S.admin.home.activeHolds}
        </div>
        {data.active_holds.length === 0 ? (
          <p className="px-5 py-8 text-center text-gp-sm text-muted">{S.admin.home.noHolds}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-left text-gp-sm">
              <thead className="border-b border-line bg-bg text-muted">
                <tr>
                  <th className="px-5 py-2 font-semibold">Plot</th>
                  <th className="px-5 py-2 font-semibold">Project</th>
                  <th className="px-5 py-2 font-semibold">Customer</th>
                  <th className="px-5 py-2 font-semibold">Status</th>
                  <th className="px-5 py-2 font-semibold">Expires</th>
                </tr>
              </thead>
              <tbody>
                {data.active_holds.map((h) => (
                  <tr
                    key={h.booking_id}
                    onClick={() => router.push(`/admin/inbox`)}
                    className="cursor-pointer border-b border-line last:border-0 hover:bg-bg"
                  >
                    <td className="px-5 py-2.5 font-semibold text-ink">{h.plot_number}</td>
                    <td className="px-5 py-2.5 text-ink">{h.project_name}</td>
                    <td className="px-5 py-2.5 text-muted">{h.customer_email}</td>
                    <td className="px-5 py-2.5">
                      <StatusChip status={h.status} />
                    </td>
                    <td className="px-5 py-2.5">
                      {h.expires_at ? <Countdown expiresAt={h.expires_at} /> : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Recent activity */}
      <Card className="p-0">
        <div className="flex items-center justify-between border-b border-line px-5 py-3">
          <span className="text-gp-base font-semibold text-ink">{S.admin.home.recentActivity}</span>
          <button
            className="text-gp-sm font-semibold text-primary"
            onClick={() => router.push('/admin/notifications')}
          >
            {S.admin.home.viewAll}
          </button>
        </div>
        {data.recent_notifications.length === 0 ? (
          <p className="px-5 py-8 text-center text-gp-sm text-muted">{S.admin.home.noActivity}</p>
        ) : (
          <ul>
            {data.recent_notifications.map((n) => (
              <li key={n.id} className="border-b border-line px-5 py-2.5 last:border-0">
                <p className="text-gp-sm font-medium text-ink">{n.title}</p>
                <p className="text-[11px] text-muted">{relativeAge(n.created_at)}</p>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
