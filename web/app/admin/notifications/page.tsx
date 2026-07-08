'use client';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { Card, Skeleton } from '@/components/Card';
import { EmptyState, ErrorState } from '@/components/EmptyState';
import { Button } from '@/components/Button';
import { AlertIcon } from '@/components/icons';
import { useNotifications } from '@/lib/queries';
import { api } from '@/lib/api';
import { relativeAge } from '@/lib/format';
import { S } from '@/lib/strings';
import type { Notification } from '@/lib/types';

function entityHref(n: Notification): string | null {
  if (n.entity_type === 'approval' && n.entity_id) return `/admin/inbox/${n.entity_id}`;
  if (n.entity_type === 'booking' && n.entity_id) return `/admin/inbox`;
  return null;
}

export default function NotificationsPage() {
  const router = useRouter();
  const qc = useQueryClient();
  const { data, isLoading, isError, refetch } = useNotifications();

  async function markRead(id: string) {
    try {
      await api(`/v1/admin/notifications/${id}/read`, { method: 'POST' });
    } finally {
      qc.invalidateQueries({ queryKey: ['admin', 'notifications'] });
    }
  }

  async function markAll() {
    try {
      await api('/v1/admin/notifications/read-all', { method: 'POST' });
    } finally {
      qc.invalidateQueries({ queryKey: ['admin', 'notifications'] });
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-gp-2xl font-semibold text-ink">{S.admin.notifications.title}</h1>
        <Button variant="secondary" onClick={markAll}>
          {S.admin.notifications.markAllRead}
        </Button>
      </div>

      {isLoading ? (
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-16 w-full rounded-card" />
          ))}
        </div>
      ) : isError ? (
        <ErrorState message={S.common.somethingWrong} onRetry={() => refetch()} />
      ) : !data || data.items.length === 0 ? (
        <EmptyState icon={<AlertIcon width={30} height={30} />} title={S.admin.notifications.empty} />
      ) : (
        <div className="overflow-hidden rounded-card border border-line bg-white shadow-card">
          <ul>
            {data.items.map((n) => {
              const href = entityHref(n);
              return (
                <li key={n.id}>
                  <button
                    onClick={() => {
                      if (!n.read_at) markRead(n.id);
                      if (href) router.push(href);
                    }}
                    className={`flex w-full items-start gap-3 border-b border-line px-4 py-3 text-left last:border-0 hover:bg-bg ${
                      !n.read_at ? 'bg-primary/5' : ''
                    }`}
                  >
                    {!n.read_at && <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-primary" />}
                    <span className={!n.read_at ? '' : 'pl-5'}>
                      <span className={`block text-gp-base ${!n.read_at ? 'font-semibold text-ink' : 'text-ink'}`}>
                        {n.title}
                      </span>
                      {n.body && <span className="block text-gp-sm text-muted">{n.body}</span>}
                      <span className="block text-[11px] text-muted">{relativeAge(n.created_at)}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
