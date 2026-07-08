// §3.4 formatting utilities. No date library — Intl only.

/** Indian-grouped rupees, no decimals. 180000000 (paise) → "₹18,00,000". */
export function formatINR(paise: number | null | undefined): string {
  if (paise == null) return '—';
  const rupees = Math.round(paise / 100);
  const formatted = new Intl.NumberFormat('en-IN', {
    maximumFractionDigits: 0,
  }).format(rupees);
  return `₹${formatted}`;
}

/** Price range "₹18,00,000 – ₹32,00,000" (or single value / dash). */
export function formatINRRange(min: number | null, max: number | null): string {
  if (min == null && max == null) return '—';
  if (min == null) return formatINR(max);
  if (max == null || min === max) return formatINR(min);
  return `${formatINR(min)} – ${formatINR(max)}`;
}

/** "d MMM yyyy, h:mm a" in Asia/Kolkata. */
export function formatIST(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(d);
}

/** Milliseconds until an ISO expiry (may be negative). */
export function msUntil(iso: string): number {
  return new Date(iso).getTime() - Date.now();
}

/** "47h 12m" when >1h, "28m 10s" when <1h. Empty when expired. */
export function timeLeft(expiresAt: string): string {
  const ms = msUntil(expiresAt);
  if (ms <= 0) return '';
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h >= 1) return `${h}h ${m}m`;
  return `${m}m ${String(s).padStart(2, '0')}s`;
}

/** Relative age like "3h ago" / "2d ago" / "just now" (for admin tables). */
export function relativeAge(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return 'just now';
  const min = Math.floor(ms / 60_000);
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

/** Hours elapsed since an ISO timestamp — for age-based coloring. */
export function hoursSince(iso: string): number {
  return (Date.now() - new Date(iso).getTime()) / 3_600_000;
}
