import { Injectable, NestMiddleware } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { NextFunction, Request, Response } from 'express';

/** Attaches a request_id to every request (API §1.2 envelope, audit rows). */
@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction) {
    const id = (req.headers['x-request-id'] as string) || `req_${randomUUID()}`;
    (req as any).requestId = id;
    res.setHeader('x-request-id', id);
    next();
  }
}

export function reqId(req: Request): string {
  return (req as any).requestId ?? 'req_unknown';
}

export function clientIp(req: Request): string | null {
  return (
    (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
    req.socket?.remoteAddress ||
    null
  );
}
