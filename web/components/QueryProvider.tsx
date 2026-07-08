'use client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect, useState, type ReactNode } from 'react';
import { bootSession } from '@/lib/api';

export function QueryProvider({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            retry: 1,
            refetchOnWindowFocus: false,
            staleTime: 10_000,
          },
        },
      }),
  );
  const [ready, setReady] = useState(false);

  useEffect(() => {
    // Boot: rotate the refresh token once so authed queries have an access token.
    bootSession().finally(() => setReady(true));
  }, []);

  if (!ready) return null;
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
