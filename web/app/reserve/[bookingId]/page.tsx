'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { CustomerShell, useRequireCustomer } from '../../_shell/CustomerShell';
import { Card, Skeleton } from '@/components/Card';
import { EmptyState } from '@/components/EmptyState';
import { Button } from '@/components/Button';
import { OtpInput } from '@/components/OtpInput';
import { DevOtpBanner } from '@/components/DevOtpBanner';
import { Stepper } from '@/components/Stepper';
import { Countdown } from '@/components/Countdown';
import { CheckIcon, ClockIcon } from '@/components/icons';
import { useToast } from '@/components/Toast';
import { useBooking, noteDevOtp } from '@/lib/queries';
import { api, ApiError } from '@/lib/api';
import { formatINR } from '@/lib/format';
import { S } from '@/lib/strings';
import type { BookingStatus, ConfirmResult, OtpChallenge } from '@/lib/types';

const STEP: Record<BookingStatus, number> = {
  PENDING_CONFIRMATION: 2,
  PENDING_APPROVAL: 3,
  RESERVED: 4,
  EXPIRED: 2,
  REJECTED: 3,
  CANCELLED: 3,
};

interface Stash {
  challenge_id?: string;
  dev_otp?: string;
}

export default function ReservePage({ params }: { params: { bookingId: string } }) {
  useRequireCustomer();
  const bookingId = params.bookingId;
  const router = useRouter();
  const qc = useQueryClient();
  const toast = useToast();
  const { data: booking, isLoading, error } = useBooking(bookingId);

  const [stash, setStash] = useState<Stash>({});
  const [fill, setFill] = useState<string | undefined>();
  const [confirming, setConfirming] = useState(false);
  const [resending, setResending] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const [otpErr, setOtpErr] = useState<string | undefined>();

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const raw = sessionStorage.getItem(`gp.reserve.${bookingId}`);
    if (raw) {
      try {
        setStash(JSON.parse(raw));
      } catch {
        /* ignore */
      }
    }
  }, [bookingId]);

  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setInterval(() => setCooldown((c) => Math.max(0, c - 1)), 1000);
    return () => clearInterval(t);
  }, [cooldown]);

  function persistStash(next: Stash) {
    setStash(next);
    if (typeof window !== 'undefined') {
      sessionStorage.setItem(`gp.reserve.${bookingId}`, JSON.stringify(next));
    }
  }

  async function confirm(code: string) {
    if (!stash.challenge_id) {
      setOtpErr(S.reserve.resendToStart);
      return;
    }
    setOtpErr(undefined);
    setConfirming(true);
    try {
      const r = await api<ConfirmResult>(`/v1/reservations/${bookingId}/confirm`, {
        method: 'POST',
        body: { challenge_id: stash.challenge_id, otp: code },
      });
      noteDevOtp(r);
      qc.invalidateQueries({ queryKey: ['booking', bookingId] });
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.code === 'OTP_INVALID') setOtpErr(S.login.otpInvalid);
        else if (err.code === 'OTP_EXPIRED') setOtpErr(S.login.otpExpired);
        else setOtpErr(err.message);
      } else setOtpErr(S.common.somethingWrong);
    } finally {
      setConfirming(false);
    }
  }

  async function resend() {
    setOtpErr(undefined);
    setResending(true);
    try {
      const r = await api<OtpChallenge>(`/v1/reservations/${bookingId}/resend-otp`, {
        method: 'POST',
      });
      noteDevOtp(r);
      persistStash({ challenge_id: r.challenge_id, dev_otp: r.dev_otp });
      setCooldown(r.retry_after_seconds || 30);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'OTP_RATE_LIMITED') {
        setCooldown(Number(err.details?.retry_after_seconds ?? 30));
      } else {
        toast.error(err instanceof ApiError ? err.message : S.common.somethingWrong);
      }
    } finally {
      setResending(false);
    }
  }

  if (isLoading) {
    return (
      <CustomerShell>
        <div className="space-y-4">
          <Skeleton className="h-6 w-2/3" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
      </CustomerShell>
    );
  }

  if (error instanceof ApiError && (error.status === 403 || error.status === 404)) {
    return (
      <CustomerShell>
        <EmptyState title={S.reserve.notFound} cta={S.common.back} onCta={() => router.push('/')} />
      </CustomerShell>
    );
  }

  if (!booking) {
    return (
      <CustomerShell>
        <EmptyState title={S.reserve.notFound} cta={S.common.back} onCta={() => router.push('/')} />
      </CustomerShell>
    );
  }

  const step = STEP[booking.status];
  const terminal = ['EXPIRED', 'REJECTED', 'CANCELLED'].includes(booking.status);

  return (
    <CustomerShell>
      {/* Header */}
      <div className="mb-4">
        <h1 className="text-gp-xl font-semibold text-ink">{booking.plot.plot_number}</h1>
        <p className="text-gp-sm text-muted">{booking.project.name}</p>
        <p className="mt-1 text-gp-lg font-semibold text-primary">
          {formatINR(booking.total_price_paise)}
        </p>
      </div>

      <div className="mb-6">
        <Stepper steps={S.reserve.steps} current={step} failed={terminal} />
      </div>

      {booking.status === 'PENDING_CONFIRMATION' && (
        <Card className="p-4">
          <h2 className="text-gp-lg font-semibold text-ink">{S.reserve.verifyTitle}</h2>
          <p className="mt-1 text-gp-base text-muted">{S.reserve.verifyBody}</p>
          {stash.dev_otp && (
            <div className="mt-3">
              <DevOtpBanner
                email="your email"
                otp={stash.dev_otp}
                onFill={(o) => setFill(o)}
              />
            </div>
          )}
          {stash.challenge_id ? (
            <div className="mt-4">
              <OtpInput onComplete={confirm} value={fill} disabled={confirming} />
            </div>
          ) : (
            <p className="mt-4 text-gp-sm text-muted">{S.reserve.resendToStart}</p>
          )}
          {otpErr && (
            <p className="mt-2 text-center text-gp-sm text-danger" aria-live="polite">
              {otpErr}
            </p>
          )}
          <div className="mt-4 flex items-center justify-between">
            <button
              type="button"
              className="text-gp-sm font-semibold text-primary disabled:text-muted"
              disabled={cooldown > 0 || resending}
              onClick={resend}
            >
              {cooldown > 0 ? S.login.resendIn(cooldown) : S.reserve.resend}
            </button>
            <Countdown expiresAt={booking.expires_at} prefix={`${S.reserve.verifyWithin}`} />
          </div>
        </Card>
      )}

      {booking.status === 'PENDING_APPROVAL' && (
        <Card className="flex flex-col items-center gap-3 p-6 text-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-full bg-info/10 text-info">
            <ClockIcon width={28} height={28} />
          </div>
          <h2 className="text-gp-lg font-semibold text-ink">{S.reserve.reviewTitle}</h2>
          <p className="text-gp-base text-muted">{S.reserve.reviewBody}</p>
          <Countdown expiresAt={booking.expires_at} prefix={`${S.reserve.decisionWithin}`} />
        </Card>
      )}

      {booking.status === 'RESERVED' && (
        <Card className="flex flex-col items-center gap-3 p-6 text-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-full bg-primary/10 text-primary">
            <CheckIcon width={30} height={30} />
          </div>
          <h2 className="text-gp-lg font-semibold text-ink">{S.reserve.reservedTitle}</h2>
          <p className="text-gp-base text-muted">{S.reserve.reservedBody}</p>
          <div className="mt-2 w-full rounded-card bg-bg p-3 text-left text-gp-sm">
            <Row label={S.plot.area} value={`${booking.plot.area_sqft ?? '—'} sqft`} />
            <Row label={S.plot.facing} value={booking.plot.facing || '—'} />
            <Row label={S.plot.price} value={formatINR(booking.total_price_paise)} />
          </div>
        </Card>
      )}

      {terminal && (
        <Card
          className={`flex flex-col items-center gap-3 p-6 text-center ${
            booking.status === 'REJECTED' ? 'border-danger/30' : ''
          }`}
        >
          <h2
            className={`text-gp-lg font-semibold ${
              booking.status === 'REJECTED' ? 'text-danger' : 'text-muted'
            }`}
          >
            {booking.status === 'EXPIRED'
              ? S.reserve.expiredTitle
              : booking.status === 'REJECTED'
                ? S.reserve.rejectedTitle
                : S.reserve.cancelledTitle}
          </h2>
          <p className="text-gp-base text-muted">
            {booking.status === 'EXPIRED'
              ? S.reserve.expiredBody
              : booking.status === 'REJECTED'
                ? S.reserve.rejectedBody
                : S.reserve.cancelledBody}
          </p>
          <Button variant="secondary" onClick={() => router.push(`/p/${booking.project.slug}`)}>
            {S.reserve.backTo(booking.project.name)}
          </Button>
        </Card>
      )}
    </CustomerShell>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between py-0.5">
      <span className="text-muted">{label}</span>
      <span className="font-semibold text-ink">{value}</span>
    </div>
  );
}
