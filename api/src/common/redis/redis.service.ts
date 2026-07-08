import { Injectable, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';

/**
 * Redis is a HELPER ONLY (Invariant 1, 6): hold-countdown TTL keys and cache. Correctness never
 * depends on it — if Redis is down, every method degrades to a no-op and the sweeper + lazy
 * repair (CF §3) keep the system correct. So all calls are wrapped and swallow errors.
 */
@Injectable()
export class RedisService implements OnModuleDestroy {
  private client: Redis | null = null;
  private disabled = false;

  private get(): Redis | null {
    if (this.disabled) return null;
    if (!this.client) {
      this.client = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
        maxRetriesPerRequest: 1,
        lazyConnect: false,
        // F6 — capped exponential backoff so Redis reconnects when it comes back, instead of
        // giving up forever. Errors stay swallowed below; correctness never depends on Redis.
        retryStrategy: (times) => Math.min(times * 200, 5000),
      });
      this.client.on('error', () => {
        /* swallowed — Redis is UX-only */
      });
    }
    return this.client;
  }

  async setHold(bookingId: string, plotId: string, ttlSeconds: number): Promise<void> {
    try {
      await this.get()?.set(`hold:${bookingId}`, plotId, 'EX', Math.max(1, ttlSeconds));
    } catch {
      /* ignore */
    }
  }

  async delHold(bookingId: string): Promise<void> {
    try {
      await this.get()?.del(`hold:${bookingId}`);
    } catch {
      /* ignore */
    }
  }

  async ping(): Promise<boolean> {
    try {
      return (await this.get()?.ping()) === 'PONG';
    } catch {
      return false;
    }
  }

  /** For tests: disable so nothing touches a real Redis. */
  disable() {
    this.disabled = true;
  }

  async onModuleDestroy() {
    try {
      await this.client?.quit();
    } catch {
      /* ignore */
    }
  }
}
