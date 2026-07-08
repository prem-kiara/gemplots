// §5.1 API client. Access token lives in module memory; refresh token + user in localStorage.
// One thin typed fetch wrapper, uniform error envelope, boot refresh, single retry on expiry.

import type { TokenPair, User } from './types';

const REFRESH_KEY = 'gp.refresh';
const USER_KEY = 'gp.user';

export class ApiError extends Error {
  status: number;
  code: string;
  details?: Record<string, unknown>;
  constructor(status: number, code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

// In-memory access token (never persisted per §5.1 — refresh survives reload instead).
let accessToken: string | null = null;
let bootPromise: Promise<void> | null = null;

export function setSession(tokens: TokenPair): void {
  accessToken = tokens.access_token;
  if (typeof window !== 'undefined') {
    localStorage.setItem(REFRESH_KEY, tokens.refresh_token);
    // The refresh endpoint returns tokens without `user`; keep the stored profile in that case.
    if (tokens.user) localStorage.setItem(USER_KEY, JSON.stringify(tokens.user));
  }
}

export function getUser(): User | null {
  if (typeof window === 'undefined') return null;
  const raw = localStorage.getItem(USER_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as User;
  } catch {
    return null;
  }
}

export function setUser(user: User): void {
  if (typeof window !== 'undefined') localStorage.setItem(USER_KEY, JSON.stringify(user));
}

export function hasSession(): boolean {
  return typeof window !== 'undefined' && !!localStorage.getItem(REFRESH_KEY);
}

export function clearSession(): void {
  accessToken = null;
  if (typeof window !== 'undefined') {
    localStorage.removeItem(REFRESH_KEY);
    localStorage.removeItem(USER_KEY);
  }
}

/** Redirect to the right login for the current face, preserving where we were. */
export function redirectToLogin(): void {
  if (typeof window === 'undefined') return;
  const path = window.location.pathname;
  if (path.startsWith('/admin')) {
    if (path !== '/admin') window.location.href = '/admin';
  } else {
    const next = encodeURIComponent(path + window.location.search);
    window.location.href = `/login?next=${next}`;
  }
}

async function parse<T>(res: Response): Promise<T> {
  const text = await res.text();
  const data = text ? JSON.parse(text) : undefined;
  if (!res.ok) {
    const env = data?.error ?? {};
    throw new ApiError(
      res.status,
      env.code ?? 'UNKNOWN',
      env.message ?? `Request failed (${res.status})`,
      env.details,
    );
  }
  return data as T;
}

async function rawRefresh(refreshToken: string): Promise<TokenPair> {
  const res = await fetch('/api/v1/auth/refresh', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ refresh_token: refreshToken }),
  });
  return parse<TokenPair>(res);
}

/** On boot: if a refresh token exists, rotate it once to get a fresh access token. */
export function bootSession(): Promise<void> {
  if (bootPromise) return bootPromise;
  bootPromise = (async () => {
    if (typeof window === 'undefined') return;
    const refresh = localStorage.getItem(REFRESH_KEY);
    if (!refresh) return;
    try {
      const tokens = await rawRefresh(refresh);
      setSession(tokens);
    } catch {
      clearSession();
    }
  })();
  return bootPromise;
}

interface Options {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  /** Skip the 401 refresh-retry (used by the refresh call itself). */
  noRetry?: boolean;
}

async function once<T>(path: string, opts: Options): Promise<T> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (accessToken) headers['authorization'] = `Bearer ${accessToken}`;
  const res = await fetch(`/api${path}`, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  return parse<T>(res);
}

export async function api<T = unknown>(path: string, opts: Options = {}): Promise<T> {
  try {
    return await once<T>(path, opts);
  } catch (e) {
    if (
      e instanceof ApiError &&
      e.status === 401 &&
      (e.code === 'TOKEN_EXPIRED' || e.code === 'UNAUTHORIZED') &&
      !opts.noRetry &&
      typeof window !== 'undefined'
    ) {
      const refresh = localStorage.getItem(REFRESH_KEY);
      if (refresh) {
        try {
          const tokens = await rawRefresh(refresh);
          setSession(tokens);
          return await once<T>(path, opts); // single retry
        } catch {
          clearSession();
          redirectToLogin();
          throw e;
        }
      }
      clearSession();
      redirectToLogin();
    }
    throw e;
  }
}

/** Idempotency-Key per user intent (§5.1): minted when the Reserve tap opens, reused on retry. */
export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}
