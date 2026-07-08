'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { BellIcon } from './icons';
import { useNotificationCount, useNotifications } from '@/lib/queries';
import { relativeAge } from '@/lib/format';
import { S } from '@/lib/strings';

// §8.7: topbar bell, unread badge (30s poll), dropdown of latest 5 + View all.
export function Bell() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const { data: count } = useNotificationCount();
  const { data: feed } = useNotifications();
  const unread = count?.unread ?? 0;
  const latest = feed?.items.slice(0, 5) ?? [];

  return (
    <div className="relative">
      <button
        aria-label={`${S.admin.bell.title}${unread ? `, ${unread} unread` : ''}`}
        onClick={() => setOpen((o) => !o)}
        className="relative rounded-full p-2 text-muted hover:bg-bg"
      >
        <BellIcon />
        {unread > 0 && (
          <span className="absolute -right-0 -top-0 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-danger px-1 text-[10px] font-bold text-white">
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} aria-hidden="true" />
          <div className="absolute right-0 z-50 mt-2 w-80 rounded-card border border-line bg-white shadow-modal">
            <div className="border-b border-line px-4 py-2 text-gp-sm font-semibold text-ink">
              {S.admin.bell.title}
            </div>
            {latest.length === 0 ? (
              <p className="px-4 py-6 text-center text-gp-sm text-muted">{S.admin.bell.empty}</p>
            ) : (
              <ul className="max-h-80 overflow-y-auto">
                {latest.map((n) => (
                  <li key={n.id}>
                    <button
                      onClick={() => {
                        setOpen(false);
                        router.push('/admin/notifications');
                      }}
                      className={`block w-full px-4 py-2.5 text-left hover:bg-bg ${
                        !n.read_at ? 'bg-primary/5' : ''
                      }`}
                    >
                      <p className={`text-gp-sm ${!n.read_at ? 'font-semibold text-ink' : 'text-ink'}`}>
                        {n.title}
                      </p>
                      <p className="text-[11px] text-muted">{relativeAge(n.created_at)}</p>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <button
              onClick={() => {
                setOpen(false);
                router.push('/admin/notifications');
              }}
              className="block w-full border-t border-line px-4 py-2 text-center text-gp-sm font-semibold text-primary hover:bg-bg"
            >
              {S.admin.bell.viewAll}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
