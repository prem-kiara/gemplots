'use client';
import { type ReactNode } from 'react';
import { Button } from './Button';

// §6: for destructive/irreversible admin actions.
export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel = 'Confirm',
  confirmVariant = 'primary',
  loading = false,
  disabled = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  children?: ReactNode;
  confirmLabel?: string;
  confirmVariant?: 'primary' | 'danger';
  loading?: boolean;
  disabled?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div className="absolute inset-0 bg-ink/40" onClick={onCancel} aria-hidden="true" />
      <div className="relative z-10 w-full max-w-md rounded-card bg-white p-5 shadow-modal">
        <h2 className="mb-2 text-gp-lg font-semibold text-ink">{title}</h2>
        {children && <div className="mb-4 text-gp-base text-muted">{children}</div>}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onCancel} disabled={loading}>
            Cancel
          </Button>
          <Button variant={confirmVariant} onClick={onConfirm} loading={loading} disabled={disabled}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
