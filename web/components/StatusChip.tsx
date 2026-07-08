'use client';
import { S } from '@/lib/strings';

// §9 booking/plot status → label + color. Color is never the only signal (text always present).
const COLORS: Record<string, string> = {
  // Booking statuses
  PENDING_CONFIRMATION: 'bg-accent/15 text-accent',
  PENDING_APPROVAL: 'bg-info/15 text-info',
  RESERVED: 'bg-primary/15 text-primary',
  EXPIRED: 'bg-muted/15 text-muted',
  REJECTED: 'bg-danger/15 text-danger',
  CANCELLED: 'bg-muted/15 text-muted',
  // Plot statuses
  AVAILABLE: 'bg-status-available/15 text-status-available',
  ON_HOLD: 'bg-status-onhold/15 text-[#b45309]',
  SOLD: 'bg-status-sold/15 text-status-sold',
  WITHDRAWN: 'bg-muted/15 text-muted',
  // Approval statuses
  PENDING: 'bg-accent/15 text-accent',
  APPROVED: 'bg-primary/15 text-primary',
  // Email statuses
  LOGGED: 'bg-info/15 text-info',
  SENT: 'bg-primary/15 text-primary',
  FAILED: 'bg-danger/15 text-danger',
};

export function StatusChip({ status, label }: { status: string; label?: string }) {
  const text = label ?? S.status[status] ?? status;
  const color = COLORS[status] ?? 'bg-muted/15 text-muted';
  return (
    <span
      className={`inline-flex items-center whitespace-nowrap rounded-full px-2.5 py-0.5 text-gp-sm font-semibold ${color}`}
    >
      {text}
    </span>
  );
}
