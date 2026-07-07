import { Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';
import { DbService } from '../../common/db/db.service';
import { Err } from '../../common/errors';
import { OtpService } from './otp.service';
import { TokenService } from './token.service';
import { JwtUser, Role } from './auth.types';

export interface PublicUser {
  id: string;
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
  ) {}

  requestOtp(phone: string) {
    return this.otp.request(phone);
  }

  /** Verify OTP → find-or-create customer → issue tokens. */
  async verifyOtp(
    challengeId: string,
    phone: string,
    otp: string,
  ): Promise<TokenPair & { user: PublicUser }> {
    await this.otp.verify(challengeId, phone, otp);

    const user = await this.db.tx(async (tx) => {
      const existing = (
        await tx.query(`SELECT * FROM users WHERE phone = $1`, [phone])
      ).rows[0];
      if (existing) {
        if (existing.status === 'BLOCKED')
          throw Err.forbidden('USER_BLOCKED', 'User blocked');
        return existing;
      }
      return (
        await tx.query(
          `INSERT INTO users (phone, role, status) VALUES ($1,'CUSTOMER','ACTIVE') RETURNING *`,
          [phone],
        )
      ).rows[0];
    });

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
    return { id: u.id, phone: u.phone, full_name: u.full_name, role: u.role };
  }
}
