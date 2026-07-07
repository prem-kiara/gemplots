import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { AppError } from '../errors';
import { reqId } from './request-context';

/** Produces the single API §1.2 error envelope for every thrown error. Never leaks internals. */
@Catch()
export class ErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger('Error');

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();
    const request_id = reqId(req);

    let status = 500;
    let code = 'INTERNAL';
    let message = 'Internal error';
    let details: Record<string, any> = {};

    if (exception instanceof AppError) {
      status = exception.status;
      code = exception.code;
      message = exception.message;
      details = exception.details;
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body = exception.getResponse() as any;
      code = mapNestCode(status);
      message = typeof body === 'string' ? body : body?.message ?? message;
      if (Array.isArray(message)) {
        details = { fields: message };
        message = 'Validation failed';
        code = 'VALIDATION_FAILED';
      }
    } else {
      this.logger.error(
        `[${request_id}] unhandled: ${(exception as any)?.message}`,
        (exception as any)?.stack,
      );
    }

    if (status >= 500) {
      this.logger.error(`[${request_id}] ${code}: ${message}`);
    }

    res.status(status).json({ error: { code, message, details }, request_id });
  }
}

function mapNestCode(status: number): string {
  switch (status) {
    case 400:
      return 'VALIDATION_FAILED';
    case 401:
      return 'UNAUTHENTICATED';
    case 403:
      return 'FORBIDDEN_ROLE';
    case 404:
      return 'NOT_FOUND';
    case 429:
      return 'RATE_LIMITED';
    default:
      return 'INTERNAL';
  }
}
