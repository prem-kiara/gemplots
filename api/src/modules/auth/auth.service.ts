import { Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';
import { DbService } from '../../common/db/db.service';
import { AuditService } from '../../common/audit/audit.service';
import { Err } from '../../common/errors';
import { OtpService } from './otp.service';
import { TokenService } from './token.service';
import { NotificationService } from '../notification/notification.service';
import { JwtUser, Role } from './auth.types';

export interface PublicUser {
  id: string;
  email: string;
  phone: string | null;
  full_name: string;
  role: Role;
}

interface TokenPair {
  access_token: string;
  refresh_token: string;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly db: DbService,
    private readonly otp: OtpService,
    private readonly tokens: TokenService,
    private readonly audit: AuditService,
    private readonly notify: NotificationService,
  ) {}

  /**
   * Request a LOGIN OTP for an email. dev_otp is double-gated (Invariant 12): returned only when
   * EMAIL_MODE is console (or unset) AND NODE_ENV !== 'production'. Env is read here at REQUEST
   * time (no caching) so a test can flip NODE_ENV around a single request.
   */
  async requestOtp(email: string) {
    const r = await this.otp.request(email, 'LOGIN');
    const consoleMode = (process.env.EMAIL_MODE ?? 'console') === 'console';
    const nonProd = process.env.NODE_ENV !== 'production';
    const devOtp = consoleMode && nonProd ? r.otp : undefined;
    return { challengeId: r.challengeId, retryAfterSeconds: r.retryAfterSeconds, devOtp };
  }

  /** Verify LOGIN OTP → find-or-create customer BY EMAIL → issue tokens. */
  async verifyOtp(
    challengeId: string,
    email: string,
    otp: string,
  ): Promise<TokenPair & { user: PublicUser }> {
    await this.otp.verify(challengeId, email, otp, { purpose: 'LOGIN' });

    let created = false;
    const user = await this.db.tx(async (tx) => {
      const existing = (
        await tx.query(`SELECT * FROM users WHERE email = $1`, [email])
      ).rows[0];
      if (existing) {
        if (existing.status === 'BLOCKED')
          throw Err.forbidden('USER_BLOCKED', 'User blocked');
        return existing;
      }
      created = true;
      return (
        await tx.query(
          `INSERT INTO users (email, role, status) VALUES ($1,'CUSTOMER','ACTIVE') RETURNING *`,
          [email],
        )
      ).rows[0];
    });

    // First login = a new customer row was created (08 §7). Post-commit admin feed event;
    // best-effort — never breaks the login flow.
    if (created)
      await this.notify.feed(
        'ADMIN',
        'NEW_CUSTOMER',
        `New customer ${email} signed up`,
        '',
        'user',
        user.id,
      );

    return { ...(await this.issue(user.id, user.role)), user: this.toPublic(user) };
  }

  async adminLogin(email: string, password: string): Promise<TokenPair & { user: PublicUser }> {
    const user = (
      await this.db.query(`SELECT * FROM users WHERE email = $1 AND role <> 'CUSTOMER'`, [
        email,
      ])
    ).rows[0];
    // Constant-ish work whether or not the user exists; generic error either way.
    const ok =
      user && user.password_hash
        ? await argon2.verify(user.password_hash, password).catch(() => false)
        : await argon2
            .hash(password)
            .then(() => false)
            .catch(() => false);
    if (!user || !ok) throw Err.unauthorized('INVALID_CREDENTIALS', 'Invalid credentials');
    if (user.status === 'BLOCKED') throw Err.forbidden('USER_BLOCKED', 'User blocked');

    return { ...(await this.issue(user.id, user.role)), user: this.toPublic(user) };
  }

  /** PATCH /me — customer profile completion (08 §9). Audited in the same TX as the update. */
  async updateProfile(
    userId: string,
    patch: { full_name?: string; phone?: string },
    ctx: { requestId?: string; ip?: string } = {},
  ): Promise<PublicUser> {
    return this.db.tx(async (tx) => {
      const before = (
        await tx.query(`SELECT * FROM users WHERE id = $1 FOR UPDATE`, [userId])
      ).rows[0];
      if (!before) throw Err.notFound('USER_NOT_FOUND', 'User not found');

      const fullName = patch.full_name ?? before.full_name;
      const phone = patch.phone !== undefined ? patch.phone : before.phone;

      const after = (
        await tx.query(
          `UPDATE users SET full_name = $2, phone = $3 WHERE id = $1 RETURNING *`,
          [userId, fullName, phone],
        )
      ).rows[0];

      await this.audit.log(
        tx,
        { id: userId, role: before.role, requestId: ctx.requestId, ip: ctx.ip },
        'user.update_profile',
        'user',
        userId,
        { full_name: before.full_name, phone: before.phone },
        { full_name: after.full_name, phone: after.phone },
      );
      return this.toPublic(after);
    });
  }

  async refresh(rawToken: string): Promise<TokenPair> {
    const { userId, role, refreshToken } = await this.tokens.rotateRefresh(rawToken);
    return { access_token: this.tokens.signAccess({ sub: userId, role }), refresh_token: refreshToken };
  }

  logout(rawToken: string) {
    return this.tokens.revoke(rawToken);
  }

  async registerDeviceToken(userId: string, fcmToken: string, platform: string) {
    await this.db.query(
      `INSERT INTO device_tokens (user_id, fcm_token, platform) VALUES ($1,$2,$3)
       ON CONFLICT (user_id, fcm_token) DO NOTHING`,
      [userId, fcmToken, platform],
    );
  }

  private async issue(userId: string, role: Role): Promise<TokenPair> {
    const jwtUser: JwtUser = { sub: userId, role };
    return {
      access_token: this.tokens.signAccess(jwtUser),
      refresh_token: await this.tokens.issueRefresh(userId),
    };
  }

  private toPublic(u: any): PublicUser {
    return { id: u.id, email: u.email, phone: u.phone, full_name: u.full_name, role: u.role };
  }
}
