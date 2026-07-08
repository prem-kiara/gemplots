// §3.3 brand mark: inline faceted diamond + "Gem Plots" wordmark.
import { S } from '@/lib/strings';

export function DiamondMark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden="true">
      <path d="M8 4h16l6 8-14 16L2 12z" fill="#047857" />
      <path d="M8 4h16l-3 8H11z" fill="#065f46" />
      <path d="M2 12h9l5 16z" fill="#059669" />
      <path d="M30 12h-9l-5 16z" fill="#047857" />
      <path d="M11 12h10l-5 16z" fill="#0f9d6f" />
    </svg>
  );
}

export function Logo({ subtitle = false, size = 28 }: { subtitle?: boolean; size?: number }) {
  return (
    <span className="flex items-center gap-2">
      <DiamondMark size={size} />
      <span className="flex flex-col leading-none">
        <span className="font-semibold text-ink" style={{ fontSize: size * 0.62 }}>
          {S.brand.name}
        </span>
        {subtitle && <span className="text-[11px] text-muted mt-0.5">{S.brand.by}</span>}
      </span>
    </span>
  );
}
