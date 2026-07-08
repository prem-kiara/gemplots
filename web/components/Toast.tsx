'use client';
import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';

type ToastKind = 'success' | 'error';
interface ToastItem {
  id: number;
  kind: ToastKind;
  msg: string;
}

interface ToastApi {
  success: (msg: string) => void;
  error: (msg: string) => void;
}

const Ctx = createContext<ToastApi | null>(null);

export function ToastProvider({
  children,
  placement = 'top',
}: {
  children: ReactNode;
  placement?: 'top' | 'bottom-right';
}) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const idRef = useRef(0);

  const push = useCallback((kind: ToastKind, msg: string) => {
    const id = ++idRef.current;
    setItems((cur) => [...cur, { id, kind, msg }]);
    setTimeout(() => setItems((cur) => cur.filter((t) => t.id !== id)), 4000);
  }, []);

  const api: ToastApi = {
    success: (m) => push('success', m),
    error: (m) => push('error', m),
  };

  const posCls =
    placement === 'bottom-right'
      ? 'bottom-4 right-4 items-end'
      : 'top-4 left-1/2 -translate-x-1/2 items-center';

  return (
    <Ctx.Provider value={api}>
      {children}
      <div
        className={`pointer-events-none fixed z-[100] flex flex-col gap-2 ${posCls}`}
        aria-live="polite"
      >
        {items.map((t) => (
          <div
            key={t.id}
            className={`pointer-events-auto max-w-[90vw] rounded-control px-4 py-2.5 text-gp-base font-medium text-white shadow-modal ${
              t.kind === 'error' ? 'bg-danger' : 'bg-primary'
            }`}
          >
            {t.msg}
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(Ctx);
  if (!ctx) {
    // No provider mounted — degrade gracefully rather than crash.
    return { success: () => {}, error: () => {} };
  }
  return ctx;
}
