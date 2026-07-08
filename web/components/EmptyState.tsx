'use client';
import type { ReactNode } from 'react';
import { Button } from './Button';

export function EmptyState({
  icon,
  title,
  cta,
  onCta,
}: {
  icon?: ReactNode;
  title: string;
  cta?: string;
  onCta?: () => void;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-card border border-dashed border-line bg-white/50 px-6 py-12 text-center">
      {icon && <div className="text-muted">{icon}</div>}
      <p className="text-gp-base text-muted">{title}</p>
      {cta && onCta && (
        <Button variant="secondary" onClick={onCta}>
          {cta}
        </Button>
      )}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-card border border-danger/30 bg-danger/5 px-6 py-10 text-center">
      <p className="text-gp-base text-danger">{message}</p>
      {onRetry && (
        <Button variant="secondary" onClick={onRetry}>
          Retry
        </Button>
      )}
    </div>
  );
}
