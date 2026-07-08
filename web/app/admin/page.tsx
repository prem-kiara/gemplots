'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Logo } from '@/components/Logo';
import { Button } from '@/components/Button';
import { Input } from '@/components/Input';
import { api, ApiError, getUser, hasSession, setSession } from '@/lib/api';
import { isAdmin } from '@/lib/auth';
import { S } from '@/lib/strings';
import type { TokenPair } from '@/lib/types';

export default function AdminLoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    // Already signed in as an admin → skip straight to the dashboard.
    if (hasSession() && isAdmin(getUser())) router.replace('/admin/home');
  }, [router]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(undefined);
    setLoading(true);
    try {
      const tokens = await api<TokenPair>('/v1/auth/admin/login', {
        method: 'POST',
        body: { email, password },
      });
      setSession(tokens);
      router.replace('/admin/home');
    } catch (error) {
      setErr(error instanceof ApiError ? S.admin.invalidCreds : S.common.somethingWrong);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-dvh items-center justify-center bg-bg px-4">
      <div className="w-full max-w-sm rounded-card border border-line bg-white p-6 shadow-card">
        <div className="mb-5 flex justify-center">
          <Logo size={30} subtitle />
        </div>
        <h1 className="mb-4 text-center text-gp-lg font-semibold text-ink">{S.admin.loginTitle}</h1>
        <form onSubmit={submit} className="flex flex-col gap-3">
          <Input
            label={S.admin.email}
            type="email"
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <Input
            label={S.admin.password}
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            error={err}
          />
          <Button type="submit" loading={loading}>
            {S.admin.signIn}
          </Button>
        </form>
      </div>
    </div>
  );
}
