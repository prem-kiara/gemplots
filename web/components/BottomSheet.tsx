'use client';
import { useEffect, type ReactNode } from 'react';
import { XIcon } from './icons';

// §6: mobile bottom sheet with drag handle + backdrop-tap-close; centered modal ≥768px.
export function BottomSheet({
  open,
  onClose,
  children,
  title,
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  title?: string;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center md:items-center"
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div className="absolute inset-0 bg-ink/40" onClick={onClose} aria-hidden="true" />
      <div className="relative z-10 w-full max-w-mobile animate-[slideup_.2s_ease-out] rounded-t-2xl bg-white p-4 pb-6 shadow-sheet md:mx-4 md:max-w-md md:rounded-2xl md:shadow-modal">
        <div className="mx-auto mb-3 h-1.5 w-10 rounded-full bg-line md:hidden" aria-hidden="true" />
        {title && (
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-gp-lg font-semibold text-ink">{title}</h2>
            <button
              onClick={onClose}
              aria-label="Close"
              className="rounded-full p-1 text-muted hover:bg-bg"
            >
              <XIcon />
            </button>
          </div>
        )}
        {children}
      </div>
    </div>
  );
}
