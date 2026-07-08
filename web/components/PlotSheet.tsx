'use client';
import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { BottomSheet } from './BottomSheet';
import { Button } from './Button';
import { StatusChip } from './StatusChip';
import { api, ApiError, hasSession, newIdempotencyKey } from '@/lib/api';
import { usePlot } from '@/lib/queries';
import { noteDevOtp } from '@/lib/queries';
import { formatINR, formatIST } from '@/lib/format';
import { S } from '@/lib/strings';
import { useToast } from './Toast';
import type { MapPlot, PlotStatus, ReserveResult } from '@/lib/types';

function reserveDisabledLabel(status: PlotStatus): string | null {
  switch (status) {
    case 'ON_HOLD':
    case 'BLOCKED':
      return S.plot.onHold;
    case 'RESERVED':
    case 'BOOKED':
      return S.plot.reserved;
    case 'SOLD':
      return S.plot.sold;
    case 'WITHDRAWN':
      return S.plot.withdrawn;
    default:
      return null;
  }
}

export function PlotSheet({
  plot,
  slug,
  onClose,
  onConflict,
}: {
  plot: MapPlot | null;
  slug: string;
  onClose: () => void;
  onConflict: () => void;
}) {
  const router = useRouter();
  const toast = useToast();
  const [reserving, setReserving] = useState(false);
  // One idempotency key per reserve intent (this open sheet).
  const idemKey = useRef<string>('');

  // Fetch full plot detail for dimensions + blocked_until.
  const { data: detail } = usePlot(plot?.plot_id);

  if (!plot) return null;

  const disabledLabel = reserveDisabledLabel(plot.status);

  async function reserve() {
    if (!plot) return;
    if (!hasSession()) {
      router.push(`/login?next=${encodeURIComponent(`/p/${slug}`)}`);
      return;
    }
    if (!idemKey.current) idemKey.current = newIdempotencyKey();
    setReserving(true);
    try {
      const r = await api<ReserveResult>(`/v1/plots/${plot.plot_id}/reserve`, {
        method: 'POST',
        headers: { 'Idempotency-Key': idemKey.current },
      });
      noteDevOtp(r);
      // Stash challenge_id + dev_otp for the reserve journey (§7.3).
      if (typeof window !== 'undefined') {
        sessionStorage.setItem(
          `gp.reserve.${r.booking_id}`,
          JSON.stringify({ challenge_id: r.challenge_id, dev_otp: r.dev_otp }),
        );
      }
      idemKey.current = '';
      router.push(`/reserve/${r.booking_id}`);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        if (err.code === 'PLOT_UNAVAILABLE') {
          toast.error(S.plot.beatenToIt);
          onConflict();
          onClose();
        } else if (err.code === 'HOLD_LIMIT_EXCEEDED') {
          const limit = Number(err.details?.limit ?? err.details?.hold_limit ?? 3);
          toast.error(S.plot.holdLimit(limit));
        } else if (err.code === 'DUPLICATE_ACTIVE_HOLD') {
          toast.error(S.plot.duplicateHold);
        } else {
          toast.error(err.message);
        }
      } else {
        toast.error(err instanceof ApiError ? err.message : S.common.somethingWrong);
      }
      idemKey.current = '';
    } finally {
      setReserving(false);
    }
  }

  return (
    <BottomSheet open={!!plot} onClose={onClose}>
      <div className="flex items-center justify-between">
        <h2 className="text-gp-xl font-semibold text-ink">{plot.plot_number}</h2>
        <StatusChip status={plot.status} />
      </div>

      <div className="mt-4 grid grid-cols-2 gap-3 text-gp-base">
        <Fact label={S.plot.area} value={`${plot.area_sqft} sqft`} />
        <Fact label={S.plot.facing} value={plot.facing || '—'} />
        {detail?.dimensions_text && <Fact label={S.plot.dimensions} value={detail.dimensions_text} />}
      </div>

      <div className="mt-4">
        <p className="text-gp-sm text-muted">{S.plot.price}</p>
        <p className="text-gp-2xl font-semibold text-primary">{formatINR(plot.price_paise)}</p>
      </div>

      {(plot.status === 'ON_HOLD' || plot.status === 'BLOCKED') && detail?.blocked_until && (
        <p className="mt-2 text-gp-sm text-accent">
          {S.plot.onHoldUntil(formatIST(detail.blocked_until))}
        </p>
      )}

      <div className="mt-5">
        {plot.status === 'AVAILABLE' ? (
          <Button className="w-full" onClick={reserve} loading={reserving}>
            {S.plot.reserve}
          </Button>
        ) : (
          <Button className="w-full" variant="secondary" disabled>
            {disabledLabel}
          </Button>
        )}
      </div>
    </BottomSheet>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-gp-sm text-muted">{label}</p>
      <p className="font-semibold text-ink">{value}</p>
    </div>
  );
}
