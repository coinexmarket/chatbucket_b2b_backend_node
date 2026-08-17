/**
 * HTTP errors and the one handler that renders them.
 *
 * FastAPI gives you `HTTPException` and a `{"detail": ...}` body for free.
 * Express gives you neither, so both are rebuilt here — and the shape matches
 * the Python service exactly, because the frontend already reads `detail` and a
 * different key would break every error message in the UI.
 */
import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';

import { logger } from './logger.js';

export class HttpError extends Error {
  readonly status: number;
  readonly headers: Record<string, string>;

  constructor(status: number, detail: string, headers: Record<string, string> = {}) {
    super(detail);
    this.name = 'HttpError';
    this.status = status;
    this.headers = headers;
  }
}

/**
 * Turn a zod failure into the same 422 shape FastAPI produces.
 *
 * Kept deliberately close to pydantic's: `loc`, `msg`, `type` per issue. The
 * frontend surfaces these per field, so an invented shape would show blank
 * validation messages.
 */
function zodTo422(err: ZodError) {
  return {
    detail: err.issues.map((issue) => ({
      loc: ['body', ...issue.path.map(String)],
      msg: issue.message,
      type: issue.code,
    })),
  };
}

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (res.headersSent) return next(err);

  if (err instanceof ZodError) {
    res.status(422).json(zodTo422(err));
    return;
  }
  if (err instanceof HttpError) {
    for (const [k, v] of Object.entries(err.headers)) res.setHeader(k, v);
    res.status(err.status).json({ detail: err.message });
    return;
  }

  // Anything unhandled is a bug. Log it with the stack, and tell the caller
  // nothing — an internal message here is an information leak, and a stack trace
  // in a response body is a gift to anybody probing the service.
  logger.error('unhandled error: %s', err instanceof Error ? (err.stack ?? err.message) : err);
  res.status(500).json({ detail: 'Internal server error.' });
}

/**
 * Wrap an async handler so a rejected promise reaches `errorHandler`.
 *
 * Express 4 does not await handlers: an async function that throws produces an
 * unhandled rejection and the request hangs until the client times out. Every
 * async route must go through this. (Express 5 fixes it; this port targets 4 so
 * it can run on the LTS most teams already have.)
 */
export function asyncHandler<T extends Request>(
  fn: (req: T, res: Response, next: NextFunction) => Promise<unknown>,
) {
  return (req: T, res: Response, next: NextFunction): void => {
    void fn(req, res, next).catch(next);
  };
}
