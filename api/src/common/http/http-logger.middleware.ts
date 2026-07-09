import { Injectable, Logger, NestMiddleware } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';
import { reqId, clientIp } from './request-context';

/**
 * Structured access log (P8 hardening) — one line per request:
 *   { request_id, method, path, status, ms, ip, actor? }
 *
 * The request_id already exists (RequestIdMiddleware); this threads it and the actor (set by the
 * JWT guard on req.user). Non-production prints a compact human line via Nest's Logger; production
 * emits single-line JSON to stdout for log shippers. No new dependency — Nest Logger only.
 *
 * The /files/* static route and /health are skipped to keep the log signal high.
 */
@Injectable()
export class HttpLoggerMiddleware implements NestMiddleware {
  private readonly logger = new Logger('HTTP');
  private readonly isProd = process.env.NODE_ENV === 'production';

  use(req: Request, res: Response, next: NextFunction) {
    const start = process.hrtime.bigint();
    const { method } = req;
    const path = req.originalUrl?.split('?')[0] ?? req.url;

    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      const actor = actorOf(req);
      const line = {
        request_id: reqId(req),
        method,
        path,
        status: res.statusCode,
        ms: Math.round(ms * 10) / 10,
        ip: clientIp(req) ?? undefined,
        ...(actor ? { actor } : {}),
      };

      if (this.isProd) {
        // Structured JSON for prod log shippers (one line).
        // eslint-disable-next-line no-console
        console.log(JSON.stringify({ level: 'info', msg: 'http', ...line }));
      } else {
        const suffix = actor ? ` actor=${actor}` : '';
        this.logger.log(
          `${line.method} ${line.path} ${line.status} ${line.ms}ms [${line.request_id}]${suffix}`,
        );
      }
    });

    next();
  }
}

/** Identify the authenticated principal for the log line, when present. */
function actorOf(req: Request): string | undefined {
  const u = (req as any).user as { sub?: string; role?: string } | undefined;
  if (!u?.sub) return undefined;
  return `${u.role ?? 'USER'}:${u.sub}`;
}
