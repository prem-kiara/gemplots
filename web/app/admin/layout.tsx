'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { Logo } from '@/components/Logo';
import { Bell } from '@/components/Bell';
import { ToastProvider } from '@/components/Toast';
import {
  HomeIcon,
  InboxIcon,
  BuildingIcon,
  BellIcon,
  MailIcon,
  ScrollIcon,
  LogOutIcon,
} from '@/components/icons';
import { getUser, hasSession } from '@/lib/api';
import { canSeeAudit, isAdmin, logout } from '@/lib/auth';
import { useNotificationCount } from '@/lib/queries';
import { S } from '@/lib/strings';
import type { User } from '@/lib/types';

function Sidebar({ user }: { user: User }) {
  const path = usePathname();
  const { data: count } = useNotificationCount();
  const pending = count?.unread ?? 0;

  const items = [
    { href: '/admin/home', label: S.admin.nav.home, Icon: HomeIcon },
    { href: '/admin/inbox', label: S.admin.nav.inbox, Icon: InboxIcon, badge: pending },
    { href: '/admin/projects', label: S.admin.nav.projects, Icon: BuildingIcon },
    { href: '/admin/notifications', label: S.admin.nav.notifications, Icon: BellIcon },
    { href: '/admin/emails', label: S.admin.nav.emails, Icon: MailIcon },
    ...(canSeeAudit(user)
      ? [{ href: '/admin/audit', label: S.admin.nav.audit, Icon: ScrollIcon }]
      : []),
  ];

  return (
    <aside className="hidden w-56 shrink-0 flex-col border-r border-line bg-white md:flex">
      <div className="border-b border-line px-4 py-3">
        <Logo size={22} />
      </div>
      <nav className="flex-1 p-2">
        {items.map(({ href, label, Icon, badge }) => {
          const active = path === href || path.startsWith(href + '/');
          return (
            <Link
              key={href}
              href={href}
              className={`mb-0.5 flex items-center justify-between rounded-control px-3 py-2 text-gp-base font-medium transition ${
                active ? 'bg-primary/10 text-primary' : 'text-ink hover:bg-bg'
              }`}
            >
              <span className="flex items-center gap-2.5">
                <Icon width={18} height={18} />
                {label}
              </span>
              {badge != null && badge > 0 && (
                <span className="rounded-full bg-accent px-1.5 text-[11px] font-bold text-white">
                  {badge}
                </span>
              )}
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}

function TopBar({ user }: { user: User }) {
  const router = useRouter();
  return (
    <header className="flex items-center justify-between border-b border-line bg-white px-4 py-2.5">
      <div className="md:hidden">
        <Logo size={20} />
      </div>
      <div className="hidden md:block" />
      <div className="flex items-center gap-3">
        <Bell />
        <div className="text-right">
          <p className="text-gp-sm font-semibold text-ink">{user.full_name || 'Admin'}</p>
          <p className="text-[11px] text-muted">{user.role}</p>
        </div>
        <button
          aria-label={S.nav.logout}
          onClick={async () => {
            await logout();
            router.replace('/admin');
          }}
          className="rounded-full p-2 text-muted hover:bg-bg"
        >
          <LogOutIcon width={18} height={18} />
        </button>
      </div>
    </header>
  );
}

export default function AdminLayout({ children }: { children: ReactNode }) {
  const path = usePathname();
  const router = useRouter();
  const isLogin = path === '/admin';
  const [user, setUserState] = useState<User | null>(null);
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    if (isLogin) {
      setChecked(true);
      return;
    }
    const u = getUser();
    if (!hasSession() || !isAdmin(u)) {
      router.replace('/admin');
      return;
    }
    setUserState(u);
    setChecked(true);
  }, [isLogin, router, path]);

  // The login page renders bare (no shell), inside its own ToastProvider.
  if (isLogin) return <ToastProvider placement="bottom-right">{children}</ToastProvider>;

  if (!checked || !user) return null;

  return (
    <ToastProvider placement="bottom-right">
      <div className="flex min-h-dvh">
        <Sidebar user={user} />
        <div className="flex min-w-0 flex-1 flex-col">
          <TopBar user={user} />
          <main className="flex-1 overflow-x-hidden p-4 md:p-6">{children}</main>
        </div>
      </div>
    </ToastProvider>
  );
}
