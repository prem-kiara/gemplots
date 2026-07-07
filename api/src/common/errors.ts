/**
 * Single error type carrying the API §7 catalog code + HTTP status. The global filter
 * (error.filter.ts) turns this into the {error:{code,message,details}, request_id} envelope.
 */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: Record<string, any> = {},
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const Err = {
  badRequest: (code: string, msg: string, details = {}) =>
    new AppError(400, code, msg, details),
  validation: (details: Record<string, any>) =>
    new AppError(400, 'VALIDATION_FAILED', 'Validation failed', details),
  unauthorized: (code = 'UNAUTHENTICATED', msg = 'Authentication required') =>
    new AppError(401, code, msg),
  forbidden: (code = 'FORBIDDEN_ROLE', msg = 'Forbidden') =>
    new AppError(403, code, msg),
  notFound: (code: string, msg: string) => new AppError(404, code, msg),
  conflict: (code: string, msg: string, details = {}) =>
    new AppError(409, code, msg, details),
  rateLimited: (code = 'RATE_LIMITED', msg = 'Too many requests', details = {}) =>
    new AppError(429, code, msg, details),
  internal: (msg = 'Internal error') => new AppError(500, 'INTERNAL', msg),
};
