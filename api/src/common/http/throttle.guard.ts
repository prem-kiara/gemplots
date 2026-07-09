import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Request } from 'express';
import { Err } from '../errors';
import { clientIp } from './request-context';

/**
 * Global in-memory rate limiter (P8 hardening). Protects the public surface without a new
 * dependency: a sane default per IP, plus tighter buckets on the auth endpoints (which sit in
 * front of the per-email OTP limits). Fixed-window counters in a Map, swept lazily.
 *
 * - Keyed on client IP + a route bucket, so auth flooding can't starve the default budget.
 * - The webhook route is skipped (machine caller, HMAC-verified; must never be throttled).
 * - Fully env-configurable and DISABLED in test / when THROTTLE_DISABLED=1 so the suite and any
 *   burst test never trip it (test/setup.ts sets THROTTLE_DISABLED).
 * - On breach returns the standard 429 RATE_LIMITED envelope (mapped by ErrorFilter).
 *
 * Runs as the FIRST APP_GUARD (before JwtAuthGuard) so it also shields unauthenticated floods.
 */
@Injectable()
export class ThrottleGuard implements CanActivate {
  // key -> { count, resetAt(ms) }
  private readonly buckets = new Map<string, { count: number; resetAt: number }>();
  private lastSweep = 0;

  private get disabled(): boolean {
    return process.env.NODE_ENV === 'test' || process.env.THROTTLE_DISABLED === '1';
  }

  private windowMs(): number {
    return Number(process.env.THROTTLE_WINDOW_MS ?? 60_000);
  }

  /** Per-route override buckets. Tighter limits on the sensitive auth endpoints. */
  private limitFor(method: string, path: string): { bucket: string; max: number } {
    const p = path.split('?')[0];
    if (method === 'POST') {
      if (p.endsWith('/auth/otp/request'))
        return { bucket: 'otp-request', max: Number(process.env.THROTTLE_AUTH_MAX ?? 10) };
      if (p.endsWith('/auth/otp/verify'))
        return { bucket: 'otp-verify', max: Number(process.env.THROTTLE_AUTH_MAX ?? 10) };
      if (p.endsWith('/auth/admin/login'))
        return { bucket: 'admin-login', max: Number(process.env.THROTTLE_LOGIN_MAX ?? 10) };
    }
    return { bucket: 'global', max: Number(process.env.THROTTLE_GLOBAL_MAX ?? 100) };
  }

  canActivate(ctx: ExecutionContext): boolean {
    if (this.disabled) return true;
    if (ctx.getType() !== 'http') return true;

    const req = ctx.switchToHttp().getRequest<Request>();
    const path = req.originalUrl ?? req.url ?? '';
    // Webhook route is never throttled (Invariant: machine caller, HMAC-verified).
    if (path.includes('/webhooks/')) return true;

    const now = Date.now();
    this.sweep(now);

    const ip = clientIp(req) ?? 'unknown';
    const { bucket, max } = this.limitFor(req.method, path);
    const key = `${bucket}:${ip}`;

    const entry = this.buckets.get(key);
    if (!entry || entry.resetAt <= now) {
      this.buckets.set(key, { count: 1, resetAt: now + this.windowMs() });
      return true;
    }
    entry.count += 1;
    if (entry.count > max) {
      const retry = Math.ceil((entry.resetAt - now) / 1000);
      throw Err.rateLimited('RATE_LIMITED', 'Too many requests', {
        retry_after_seconds: Math.max(1, retry),
      });
    }
    return true;
  }

  /** Drop expired buckets occasionally so the Map can't grow unbounded. */
  private sweep(now: number) {
    if (now - this.lastSweep < 30_000) return;
    this.lastSweep = now;
    for (const [k, v] of this.buckets) if (v.resetAt <= now) this.buckets.delete(k);
  }
}
