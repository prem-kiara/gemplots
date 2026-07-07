import {
  CanActivate,
  ExecutionContext,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { Err } from '../../common/errors';
import { PUBLIC_KEY, ROLES_KEY } from './decorators';
import { TokenService } from './token.service';
import { Role } from './auth.types';

/** Verifies the Bearer JWT and attaches req.user. Skips routes marked @Public(). */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly tokens: TokenService,
    private readonly reflector: Reflector,
  ) {}

  canActivate(ctx: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (isPublic) return true;

    const req = ctx.switchToHttp().getRequest<Request>();
    const auth = req.headers.authorization ?? '';
    const [scheme, token] = auth.split(' ');
    if (scheme !== 'Bearer' || !token)
      throw Err.unauthorized('UNAUTHENTICATED', 'Missing bearer token');
    (req as any).user = this.tokens.verifyAccess(token);
    return true;
  }
}

/** Enforces @Roles(...). Applied after JwtAuthGuard. */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const roles = this.reflector.getAllAndOverride<Role[]>(ROLES_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (!roles || roles.length === 0) return true;
    const user = ctx.switchToHttp().getRequest().user;
    if (!user || !roles.includes(user.role))
      throw Err.forbidden('FORBIDDEN_ROLE', 'Insufficient role');
    return true;
  }
}
