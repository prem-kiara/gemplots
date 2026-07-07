import { Injectable } from '@nestjs/common';
import { DbService } from '../db/db.service';

/**
 * Reads operational config from global_settings (DB) with a 60s cache, falling back to env,
 * then a hardcoded default (DM §5.13). Changing global_hold_minutes affects FUTURE holds only
 * (Invariant 5) — this service is only read at block time, never applied retroactively.
 */
@Injectable()
export class ConfigService {
  private cache = new Map<string, { value: any; at: number }>();
  private readonly ttlMs = 60_000;

  constructor(private readonly db: DbService) {}

  private defaults: Record<string, any> = {
    global_hold_minutes: Number(process.env.GLOBAL_HOLD_MINUTES ?? 1440),
    max_active_holds_per_user: Number(process.env.MAX_ACTIVE_HOLDS ?? 2),
    otp_send_limit_per_15min: 3,
    otp_send_limit_per_day: 10,
    otp_verify_max_attempts: 5,
    min_advance_paise: 1_000_000,
    reminder_offsets_minutes: [360, 60],
  };

  async get<T = any>(key: string): Promise<T> {
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.value as T;
    const res = await this.db.query<{ value: any }>(
      'SELECT value FROM global_settings WHERE key = $1',
      [key],
    );
    const value = res.rows.length ? res.rows[0].value : this.defaults[key];
    this.cache.set(key, { value, at: Date.now() });
    return value as T;
  }

  async int(key: string): Promise<number> {
    return Number(await this.get(key));
  }

  invalidate(key?: string) {
    if (key) this.cache.delete(key);
    else this.cache.clear();
  }
}
