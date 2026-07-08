'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { Logo } from '@/components/Logo';
import { HomeIcon, PlotsIcon } from '@/components/icons';
import { ToastProvider } from '@/components/Toast';
import { S } from '@/lib/strings';
import { getUser, hasSession } from '@/lib/api';
import { useDevMode } from '@/lib/devmode';

function DevRibbon() {
  const on = useDevMode();
  if (!on) return null;
  return (
    <div className="bg-accent px-4 py-1.5 text-center text-[12px] font-semibold text-white">
      {S.dev.ribbon}
    </div>
  );
}

function TopBar() {
  const [name, setName] = useState<string | null>(null);
  useEffect(() => {
    if (hasSession()) setName(getUser()?.full_name || 'Account');
  }, []);
  return (
    <header className="sticky top-0 z-40 border-b border-line bg-white/95 backdrop-blur">
      <div className="mx-auto flex max-w-mobile items-center justify-between px-4 py-2.5">
        <Link href="/" aria-label="Gem Plots home">
          <Logo size={24} />
        </Link>
        {name ? (
          <Link href="/me" className="text-gp-sm font-semibold text-primary">
            {name}
          </Link>
        ) : (
          <Link href="/login" className="text-gp-sm font-semibold text-primary">
            {S.nav.login}
          </Link>
        )}
      </div>
    </header>
  );
}

function BottomNav() {
  const path = usePathname();
  const items = [
    { href: '/', label: S.nav.home, Icon: HomeIcon, active: path === '/' },
    { href: '/me', label: S.nav.myPlots, Icon: PlotsIcon, active: path === '/me' },
  ];
  return (
    <nav className="pb-safe sticky bottom-0 z-40 border-t border-line bg-white">
      <div className="mx-auto flex max-w-mobile">
        {items.map(({ href, label, Icon, active }) => (
          <Link
            key={href}
            href={href}
            className={`flex flex-1 flex-col items-center gap-0.5 py-2 text-[11px] font-medium ${
              active ? 'text-primary' : 'text-muted'
            }`}
          >
            <Icon width={22} height={22} />
            {label}
          </Link>
        ))}
      </div>
    </nav>
  );
}

export function CustomerShell({ children }: { children: ReactNode }) {
  return (
    <ToastProvider placement="top">
      <div className="flex min-h-dvh flex-col">
        <DevRibbon />
        <TopBar />
        <main className="mx-auto w-full max-w-mobile flex-1 px-4 py-4">{children}</main>
        <BottomNav />
      </div>
    </ToastProvider>
  );
}

/** Client-side guard for customer-protected routes (/me, /reserve/**). */
export function useRequireCustomer() {
  const router = useRouter();
  const path = usePathname();
  useEffect(() => {
    if (!hasSession()) {
      const next = encodeURIComponent(path);
      router.replace(`/login?next=${next}`);
    }
  }, [router, path]);
}
