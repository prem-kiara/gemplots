'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { CustomerShell, useRequireCustomer } from '../_shell/CustomerShell';
import { Card, Skeleton } from '@/components/Card';
import { EmptyState, ErrorState } from '@/components/EmptyState';
import { Button } from '@/components/Button';
import { Input } from '@/components/Input';
import { StatusChip } from '@/components/StatusChip';
import { Countdown } from '@/components/Countdown';
import { LogOutIcon, PlotsIcon } from '@/components/icons';
import { useToast } from '@/components/Toast';
import { useMyBookings } from '@/lib/queries';
import { api, getUser, setUser } from '@/lib/api';
import { logout } from '@/lib/auth';
import { formatINR } from '@/lib/format';
import { S } from '@/lib/strings';
import type { User } from '@/lib/types';

const PENDING = ['PENDING_CONFIRMATION', 'PENDING_APPROVAL'];

export default function MePage() {
  useRequireCustomer();
  const router = useRouter();
  const toast = useToast();
  const { data, isLoading, isError, refetch } = useMyBookings();

  const user = getUser();
  const needsProfile = !!user && (!user.full_name?.trim() || !user.phone?.trim());

  return (
    <CustomerShell>
      <h1 className="mb-3 text-gp-2xl font-semibold text-ink">{S.me.title}</h1>

      {needsProfile && <ProfilePrompt user={user!} onSaved={() => toast.success(S.me.profileSaved)} />}

      <h2 className="mb-2 mt-4 text-gp-lg font-semibold text-ink">{S.me.reservations}</h2>
      {isLoading ? (
        <div className="flex flex-col gap-3">
          {[0, 1].map((i) => (
            <Card key={i} className="p-4">
              <Skeleton className="h-5 w-1/2" />
              <Skeleton className="mt-2 h-4 w-1/3" />
            </Card>
          ))}
        </div>
      ) : isError ? (
        <ErrorState message={S.me.error} onRetry={() => refetch()} />
      ) : !data || data.items.length === 0 ? (
        <EmptyState
          icon={<PlotsIcon width={32} height={32} />}
          title={S.me.empty}
          cta={S.me.findPlot}
          onCta={() => router.push('/')}
        />
      ) : (
        <div className="flex flex-col gap-3">
          {data.items.map((b) => (
            <Card key={b.id} onClick={() => router.push(`/reserve/${b.id}`)} className="p-4">
              <div className="flex items-start justify-between">
                <div>
                  <p className="font-semibold text-ink">{b.plot.plot_number}</p>
                  <p className="text-gp-sm text-muted">{b.project.name}</p>
                  <p className="mt-1 text-gp-base font-semibold text-primary">
                    {formatINR(b.total_price_paise)}
                  </p>
                </div>
                <div className="flex flex-col items-end gap-1">
                  <StatusChip status={b.status} />
                  {PENDING.includes(b.status) && <Countdown expiresAt={b.expires_at} />}
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      <div className="mt-8 border-t border-line pt-4">
        <Button
          variant="ghost"
          onClick={async () => {
            await logout();
            router.replace('/');
          }}
        >
          <LogOutIcon width={18} height={18} />
          {S.nav.logout}
        </Button>
      </div>
    </CustomerShell>
  );
}

function ProfilePrompt({ user, onSaved }: { user: User; onSaved: () => void }) {
  const [fullName, setFullName] = useState(user.full_name || '');
  const [phone, setPhone] = useState(user.phone || '');
  const [saving, setSaving] = useState(false);
  const toast = useToast();

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      const updated = await api<User>('/v1/me', {
        method: 'PATCH',
        body: { full_name: fullName, phone },
      });
      setUser(updated);
      onSaved();
    } catch {
      toast.error(S.common.somethingWrong);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="p-4">
      <h2 className="text-gp-lg font-semibold text-ink">{S.me.profilePrompt}</h2>
      <p className="mt-1 text-gp-sm text-muted">{S.me.profileBody}</p>
      <form onSubmit={save} className="mt-3 flex flex-col gap-3">
        <Input
          label={S.me.fullName}
          value={fullName}
          onChange={(e) => setFullName(e.target.value)}
          autoComplete="name"
        />
        <Input
          label={S.me.phone}
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          inputMode="tel"
          autoComplete="tel"
        />
        <Button type="submit" loading={saving} disabled={!fullName.trim() || !phone.trim()}>
          {S.me.saveProfile}
        </Button>
      </form>
    </Card>
  );
}
