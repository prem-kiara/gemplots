'use client';
import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { CustomerShell } from '../_shell/CustomerShell';
import { Button } from '@/components/Button';
import { Input } from '@/components/Input';
import { OtpInput } from '@/components/OtpInput';
import { DevOtpBanner } from '@/components/DevOtpBanner';
import { api, ApiError, setSession } from '@/lib/api';
import { noteDevOtp } from '@/lib/queries';
import { S } from '@/lib/strings';
import type { OtpChallenge, TokenPair } from '@/lib/types';

function LoginInner() {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get('next') || '/me';

  const [stage, setStage] = useState<'email' | 'otp'>('email');
  const [email, setEmail] = useState('');
  const [challengeId, setChallengeId] = useState('');
  const [devOtp, setDevOtp] = useState<string | undefined>();
  const [fill, setFill] = useState<string | undefined>();
  const [cooldown, setCooldown] = useState(0);
  const [sending, setSending] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [emailErr, setEmailErr] = useState<string | undefined>();
  const [otpErr, setOtpErr] = useState<string | undefined>();

  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setInterval(() => setCooldown((c) => Math.max(0, c - 1)), 1000);
    return () => clearInterval(t);
  }, [cooldown]);

  async function requestOtp(e?: React.FormEvent) {
    e?.preventDefault();
    setEmailErr(undefined);
    if (!email.includes('@')) {
      setEmailErr('Enter a valid email');
      return;
    }
    setSending(true);
    try {
      const r = await api<OtpChallenge>('/v1/auth/otp/request', {
        method: 'POST',
        body: { email },
      });
      noteDevOtp(r);
      setChallengeId(r.challenge_id);
      setDevOtp(r.dev_otp);
      setCooldown(r.retry_after_seconds || 30);
      setStage('otp');
    } catch (err) {
      if (err instanceof ApiError && err.code === 'OTP_RATE_LIMITED') {
        setEmailErr(S.login.rateLimited(Number(err.details?.retry_after_seconds ?? 30)));
      } else {
        setEmailErr(err instanceof ApiError ? err.message : S.common.somethingWrong);
      }
    } finally {
      setSending(false);
    }
  }

  async function verify(code: string) {
    setOtpErr(undefined);
    setVerifying(true);
    try {
      const tokens = await api<TokenPair>('/v1/auth/otp/verify', {
        method: 'POST',
        body: { challenge_id: challengeId, email, otp: code },
      });
      setSession(tokens);
      router.replace(next);
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.code === 'OTP_INVALID') setOtpErr(S.login.otpInvalid);
        else if (err.code === 'OTP_EXPIRED') setOtpErr(S.login.otpExpired);
        else setOtpErr(err.message);
      } else setOtpErr(S.common.somethingWrong);
    } finally {
      setVerifying(false);
    }
  }

  return (
    <div className="mx-auto mt-6 max-w-sm">
      <h1 className="mb-4 text-gp-2xl font-semibold text-ink">{S.login.title}</h1>

      {stage === 'email' ? (
        <form onSubmit={requestOtp} className="flex flex-col gap-3">
          <Input
            label={S.login.emailLabel}
            type="email"
            inputMode="email"
            autoComplete="email"
            placeholder={S.login.emailPlaceholder}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            error={emailErr}
          />
          <Button type="submit" loading={sending}>
            {S.login.sendCode}
          </Button>
        </form>
      ) : (
        <div className="flex flex-col gap-3">
          <p className="text-gp-base text-muted">{S.login.codeSentTo(email)}</p>
          {devOtp && (
            <DevOtpBanner email={email} otp={devOtp} onFill={(o) => setFill(o)} />
          )}
          <OtpInput onComplete={verify} value={fill} disabled={verifying} />
          {otpErr && (
            <p className="text-center text-gp-sm text-danger" aria-live="polite">
              {otpErr}
            </p>
          )}
          <div className="flex items-center justify-between text-gp-sm">
            <button
              type="button"
              className="font-semibold text-primary disabled:text-muted"
              disabled={cooldown > 0 || sending}
              onClick={() => requestOtp()}
            >
              {cooldown > 0 ? S.login.resendIn(cooldown) : S.login.resend}
            </button>
            <button
              type="button"
              className="font-semibold text-muted"
              onClick={() => {
                setStage('email');
                setFill(undefined);
                setOtpErr(undefined);
              }}
            >
              {S.login.editEmail}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default function LoginPage() {
  return (
    <CustomerShell>
      <Suspense fallback={null}>
        <LoginInner />
      </Suspense>
    </CustomerShell>
  );
}
