import { Injectable } from '@nestjs/common';
import { randomInt } from 'crypto';
import { DbService } from '../../common/db/db.service';
import { ConfigService } from '../../common/config/config.service';
import { EmailService } from '../../common/email/email.service';
import { Err } from '../../common/errors';
import { sha256 } from '../../common/util';
import { OtpPurpose } from './auth.types';

const OTP_TTL_MIN = 5;

/**
 * OTP request/verify with rate limits counted from otp_challenges (DM §5.2, as amended by 08 §4:
 * keyed on email now). LOGIN OTPs go out through the EmailService (login_otp template + outbox);
 * a real SMTP send is a later env flip behind the same driver. Never reveals user existence.
 */
@Injectable()
export class OtpService {
  constructor(
    private readonly db: DbService,
    private readonly config: ConfigService,
    private readonly email: EmailService,
  ) {}

  private pepper() {
    return process.env.OTP_PEPPER ?? 'dev-otp-pepper-change-me';
  }

  /**
   * Issue an OTP challenge for `email`. Returns the raw otp too so callers that need it (login
   * dev_otp gate, reserve flow) can use it; the caller decides whether to expose it. LOGIN emails
   * are sent here; other purposes let the caller send the purpose-specific template.
   */
  async request(
    email: string,
    purpose: OtpPurpose = 'LOGIN',
    bookingId: string | null = null,
  ): Promise<{ challengeId: string; otp: string; retryAfterSeconds: number }> {
    const per15 = await this.config.int('otp_send_limit_per_15min');
    const perDay = await this.config.int('otp_send_limit_per_day');

    const counts = (
      await this.db.query<{ last15: string; today: string }>(
        `SELECT
           count(*) FILTER (WHERE created_at > now() - interval '15 minutes') AS last15,
           count(*) FILTER (WHERE created_at > now() - interval '1 day')      AS today
         FROM otp_challenges WHERE email = $1`,
        [email],
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
        `INSERT INTO otp_challenges (email, otp_hash, purpose, booking_id, expires_at)
         VALUES ($1,$2,$3,$4, now() + interval '${OTP_TTL_MIN} minutes') RETURNING id`,
        [email, sha256(otp + this.pepper()), purpose, bookingId],
      )
    ).rows[0];

    if (purpose === 'LOGIN') {
      await this.email.send(email, 'login_otp', { otp });
    }
    return { challengeId: row.id, otp, retryAfterSeconds: 30 };
  }

  /**
   * Verify an OTP. Returns the verified email on success; throws the API §2 error codes otherwise.
   * When `purpose` is passed it must match the challenge's purpose (OTP_PURPOSE_MISMATCH), and
   * `bookingId` (when passed) must match the challenge's booking linkage.
   */
  async verify(
    challengeId: string,
    email: string,
    otp: string,
    opts: { purpose?: OtpPurpose; bookingId?: string } = {},
  ): Promise<string> {
    const maxAttempts = await this.config.int('otp_verify_max_attempts');
    const outcome = await this.db.tx<
      | { kind: 'invalid' | 'used' | 'expired' | 'exceeded' | 'purpose' }
      | { kind: 'wrong' }
      | { kind: 'ok' }
    >(async (tx) => {
      const c = (
        await tx.query(
          `SELECT * FROM otp_challenges WHERE id = $1 AND email = $2 FOR UPDATE`,
          [challengeId, email],
        )
      ).rows[0];

      if (!c) return { kind: 'invalid' };
      if (c.consumed_at) return { kind: 'used' };
      if (new Date(c.expires_at) < new Date()) return { kind: 'expired' };
      if (c.attempts >= maxAttempts) return { kind: 'exceeded' };
      if (opts.purpose && c.purpose !== opts.purpose) return { kind: 'purpose' };
      if (opts.bookingId && c.booking_id !== opts.bookingId) return { kind: 'purpose' };

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
        return email;
      case 'purpose':
        throw Err.badRequest('OTP_PURPOSE_MISMATCH', 'OTP purpose mismatch');
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
}
