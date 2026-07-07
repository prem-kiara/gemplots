import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import * as jwt from 'jsonwebtoken';
import { DbService, Executor } from '../../common/db/db.service';
import { Err } from '../../common/errors';
import { sha256 } from '../../common/util';
import { JwtUser, Role } from './auth.types';

const ACCESS_TTL = '15m';
const REFRESH_TTL_DAYS = 30;

@Injectable()
export class TokenService {
  constructor(private readonly db: DbService) {}

  private get accessSecret() {
    return process.env.JWT_SECRET ?? 'dev-access-secret-change-me';
  }

  signAccess(user: JwtUser): string {
    return jwt.sign({ role: user.role }, this.accessSecret, {
      subject: user.sub,
      expiresIn: ACCESS_TTL,
    });
  }

  verifyAccess(token: string): JwtUser {
    try {
      const decoded = jwt.verify(token, this.accessSecret) as jwt.JwtPayload;
      return { sub: decoded.sub as string, role: decoded.role as Role };
    } catch (e: any) {
      if (e?.name === 'TokenExpiredError')
        throw Err.unauthorized('TOKEN_EXPIRED', 'Access token expired');
      throw Err.unauthorized('UNAUTHENTICATED', 'Invalid token');
    }
  }

  /** Issue a fresh opaque refresh token, persisted as a hash. */
  async issueRefresh(userId: string, ex: Executor = this.db.pool): Promise<string> {
    const raw = `rt_${randomUUID()}${randomUUID()}`;
    await ex.query(
      `INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
       VALUES ($1,$2, now() + ($3 || ' days')::interval)`,
      [userId, sha256(raw), String(REFRESH_TTL_DAYS)],
    );
    return raw;
  }

  /**
   * Rotate: verify + revoke the old token, issue a new one, chain them. Reuse of an already
   * revoked token → revoke the whole chain and 401 REFRESH_REUSED (API §2).
   */
  async rotateRefresh(
    rawToken: string,
  ): Promise<{ userId: string; role: Role; refreshToken: string }> {
    const hash = sha256(rawToken);
    const outcome = await this.db.tx<
      | { kind: 'unknown' }
      | { kind: 'blocked' }
      | { kind: 'reuse'; userId: string }
      | { kind: 'ok'; userId: string; role: Role; refreshToken: string }
    >(async (tx) => {
      const row = (
        await tx.query(
          `SELECT rt.id, rt.user_id, rt.revoked_at, rt.expires_at, u.role, u.status
             FROM refresh_tokens rt JOIN users u ON u.id = rt.user_id
            WHERE rt.token_hash = $1 FOR UPDATE`,
          [hash],
        )
      ).rows[0];

      if (!row) return { kind: 'unknown' };
      if (row.status === 'BLOCKED') return { kind: 'blocked' };
      if (row.revoked_at || new Date(row.expires_at) < new Date())
        return { kind: 'reuse', userId: row.user_id };

      const newRaw = `rt_${randomUUID()}${randomUUID()}`;
      const inserted = (
        await tx.query(
          `INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
           VALUES ($1,$2, now() + interval '${REFRESH_TTL_DAYS} days') RETURNING id`,
          [row.user_id, sha256(newRaw)],
        )
      ).rows[0];
      await tx.query(
        `UPDATE refresh_tokens SET revoked_at = now(), replaced_by = $2 WHERE id = $1`,
        [row.id, inserted.id],
      );
      return { kind: 'ok', userId: row.user_id, role: row.role as Role, refreshToken: newRaw };
    });

    if (outcome.kind === 'reuse') {
      // Token theft signal → revoke the whole chain. Runs OUTSIDE the read tx so it commits
      // (throwing inside that tx would roll the revoke back).
      await this.db.query(
        `UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`,
        [outcome.userId],
      );
      throw Err.unauthorized('REFRESH_REUSED', 'Refresh token reuse detected');
    }
    if (outcome.kind === 'unknown')
      throw Err.unauthorized('UNAUTHENTICATED', 'Unknown refresh token');
    if (outcome.kind === 'blocked') throw Err.forbidden('USER_BLOCKED', 'User blocked');
    return { userId: outcome.userId, role: outcome.role, refreshToken: outcome.refreshToken };
  }

  async revoke(rawToken: string): Promise<void> {
    await this.db.query(
      `UPDATE refresh_tokens SET revoked_at = now()
        WHERE token_hash = $1 AND revoked_at IS NULL`,
      [sha256(rawToken)],
    );
  }
}
