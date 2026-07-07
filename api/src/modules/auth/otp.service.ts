import { Injectable, Logger } from '@nestjs/common';
import { randomInt } from 'crypto';
import { DbService } from '../../common/db/db.service';
import { ConfigService } from '../../common/config/config.service';
import { Err } from '../../common/errors';
import { sha256 } from '../../common/util';

const OTP_TTL_MIN = 5;

/**
 * OTP request/verify with rate limits counted from otp_challenges (DM §5.2). Dev provider logs
 * the code; a real DLT SMS provider swaps in behind sendSms(). Never reveals user existence.
 */
@Injectable()
export class OtpService {
  private readonly logger = new Logger('OTP');

  constructor(
    private readonly db: DbService,
    private readonly config: ConfigService,
  ) {}

  private pepper() {
    return process.env.OTP_PEPPER ?? 'dev-otp-pepper-change-me';
  }

  async request(phone: string): Promise<{ challengeId: string; retryAfterSeconds: number }> {
    const per15 = await this.config.int('otp_send_limit_per_15min');
    const perDay = await this.config.int('otp_send_limit_per_day');

    const counts = (
      await this.db.query<{ last15: string; today: string }>(
        `SELECT
           count(*) FILTER (WHERE created_at > now() - interval '15 minutes') AS last15,
           count(*) FILTER (WHERE created_at > now() - interval '1 day')      AS today
         FROM otp_challenges WHERE phone = $1`,
        [phone],
      )
    ).rows[0];

    if (Number(counts.last15) >= per15 || Number(counts.today) >= perDay) {
      throw Err.rateLimited('OTP_RATE_LIMITED', 'Too many OTP requests', {
        retry_after_seconds: 900,
      });
    }

    const otp = String(randomInt(100000, 1000000)); // 6 digits
    const row = (
      await this.db.query<{ id: string }>(
        `INSERT INTO otp_challenges (phone, otp_hash, expires_at)
         VALUES ($1,$2, now() + interval '${OTP_TTL_MIN} minutes') RETURNING id`,
        [phone, sha256(otp + this.pepper())],
      )
    ).rows[0];

    await this.sendSms(phone, otp);
    return { challengeId: row.id, retryAfterSeconds: 30 };
  }

  /** Returns the verified phone on success; throws the API §2 error codes otherwise. */
  async verify(challengeId: string, phone: string, otp: string): Promise<string> {
    const maxAttempts = await this.config.int('otp_verify_max_attempts');
    const outcome = await this.db.tx<
      | { kind: 'invalid' | 'used' | 'expired' | 'exceeded' }
      | { kind: 'wrong' }
      | { kind: 'ok' }
    >(async (tx) => {
      const c = (
        await tx.query(
          `SELECT * FROM otp_challenges WHERE id = $1 AND phone = $2 FOR UPDATE`,
          [challengeId, phone],
        )
      ).rows[0];

      if (!c) return { kind: 'invalid' };
      if (c.consumed_at) return { kind: 'used' };
      if (new Date(c.expires_at) < new Date()) return { kind: 'expired' };
      if (c.attempts >= maxAttempts) return { kind: 'exceeded' };

      if (c.otp_hash !== sha256(otp + this.pepper())) {
        // Increment inside this tx AND commit it (we return, not throw) so the attempt sticks.
        await tx.query(`UPDATE otp_challenges SET attempts = attempts + 1 WHERE id = $1`, [
          challengeId,
        ]);
        return { kind: 'wrong' };
      }
      await tx.query(`UPDATE otp_challenges SET consumed_at = now() WHERE id = $1`, [challengeId]);
      return { kind: 'ok' };
    });

    switch (outcome.kind) {
      case 'ok':
        return phone;
      case 'wrong':
      case 'invalid':
      case 'used':
        throw Err.badRequest('OTP_INVALID', 'Invalid OTP');
      case 'expired':
        throw Err.badRequest('OTP_EXPIRED', 'OTP expired');
      case 'exceeded':
        throw Err.rateLimited('OTP_ATTEMPTS_EXCEEDED', 'Too many attempts');
    }
  }

  private async sendSms(phone: string, otp: string): Promise<void> {
    // TODO(prod): DLT-approved SMS provider. Dev: log so testers can read the code.
    this.logger.log(`OTP for ${phone}: ${otp}`);
  }
}
