'use client';
import { useEffect, useRef, useState } from 'react';
import { timeLeft, msUntil } from '@/lib/format';
import { ClockIcon } from './icons';

// §6: ticks 1s; accent under 1h, danger under 10min; fires onExpire once.
export function Countdown({
  expiresAt,
  onExpire,
  prefix,
  className = '',
  showIcon = true,
}: {
  expiresAt: string;
  onExpire?: () => void;
  prefix?: string;
  className?: string;
  showIcon?: boolean;
}) {
  const [, setTick] = useState(0);
  const fired = useRef(false);

  useEffect(() => {
    fired.current = false;
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [expiresAt]);

  const ms = msUntil(expiresAt);
  useEffect(() => {
    if (ms <= 0 && !fired.current) {
      fired.current = true;
      onExpire?.();
    }
  }, [ms, onExpire]);

  const label = timeLeft(expiresAt);
  const expired = ms <= 0;
  const color = expired
    ? 'text-muted'
    : ms < 10 * 60_000
      ? 'text-danger'
      : ms < 60 * 60_000
        ? 'text-accent'
        : 'text-muted';

  return (
    <span className={`inline-flex items-center gap-1 text-gp-sm font-semibold ${color} ${className}`}>
      {showIcon && <ClockIcon width={14} height={14} />}
      {expired ? 'Expired' : `${prefix ? prefix + ' ' : ''}${label}`}
    </span>
  );
}
