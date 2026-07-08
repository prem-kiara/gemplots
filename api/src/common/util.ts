import { createHash } from 'crypto';

/** Money is integer paise everywhere (HANDOVER §3). Rupees → paise for CSV/admin input. */
export function rupeesToPaise(rupees: number): number {
  return Math.round(rupees * 100);
}
export function paiseToRupees(paise: number): number {
  return paise / 100;
}

/** RERA advance cap in paise (Invariant 8): floor(total * capPct / 100), integer math only. */
export function advanceCapPaise(totalPricePaise: number, capPct: number): number {
  return Math.floor((totalPricePaise * capPct) / 100);
}

/** Effective cap pct: min(project cap, 10) when RERA-registered, else the project cap. */
export function effectiveCapPct(maxAdvancePct: number, reraRegistered: boolean): number {
  return reraRegistered ? Math.min(maxAdvancePct, 10) : maxAdvancePct;
}

export function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Receipt number GEM-YYYY-NNNNNN from a Postgres sequence value (CF §5.7b; dormant). */
export function formatReceipt(seqValue: number, year: number): string {
  return `GEM-${year}-${String(seqValue).padStart(6, '0')}`;
}
