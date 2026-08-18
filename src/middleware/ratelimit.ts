/**
 * Rate limiting, counted in MongoDB.
 *
 * Ported from `app/ratelimit.py`. In the database rather than in memory for two
 * reasons: the service runs more than one worker, and an in-process counter is
 * per-worker, so N workers means N times the intended limit; and a restart would
 * forget every count, which is trivially exploitable by anyone who can trigger
 * one.
 *
 * The `rate_limits` collection has a TTL index on `expires_at`, so spent windows
 * delete themselves and nothing has to sweep them.
 */
import type { NextFunction, Request, Response } from 'express';

import { getSettings } from '../config.js';
import { rateLimitsCollection } from '../database.js';
import { HttpError } from '../errors.js';

export interface Limit {
  /** How many calls are allowed in the window. */
  max: number;
  /** Window length, in seconds. */
  windowSeconds: number;
}

/**
 * The limits, by name.
 *
 * Sending a text is capped far harder than checking one, because **every send
 * costs money and rings a real phone**. Three per number per hour is enough for a
 * genuine retry and useless for running up a bill or harassing a stranger.
 */
export const LIMITS: Record<string, Limit> = {
  login_ip: { max: 20, windowSeconds: 900 },
  register_ip: { max: 10, windowSeconds: 3600 },
  forgot_ip: { max: 5, windowSeconds: 3600 },
  // Public, unauthenticated and it sends mail, so it is a spam target.
  demo_ip: { max: 10, windowSeconds: 3600 },
  contest_ip: { max: 10, windowSeconds: 3600 },
  // Per address as well as per IP, so this cannot be used to mail-bomb someone.
  // Applied before the account lookup, so the limit is identical whether or not
  // the address exists — one that only bit real accounts would itself leak
  // which addresses are registered.
  forgot_email: { max: 3, windowSeconds: 3600 },

  verify_otp_ip: { max: 30, windowSeconds: 900 },
  verify_email_ip: { max: 30, windowSeconds: 900 },
  verify_email_address: { max: 10, windowSeconds: 900 },

  // Checking a texted code: same shape as the email code above.
  verify_phone_ip: { max: 30, windowSeconds: 900 },
  verify_phone_number: { max: 10, windowSeconds: 900 },

  // *Sending* one is different — see the note above.
  verify_phone_send_ip: { max: 10, windowSeconds: 3600 },
  verify_phone_send_number: { max: 3, windowSeconds: 3600 },
};

export interface LimitResult {
  /** How many calls remain in this window. Never negative. */
  remaining: number;
  /** Seconds until the window resets. */
  retryAfter: number;
  /** The ceiling that was applied. */
  limit: number;
}

/**
 * Count one call against an explicit limit, reporting what is left.
 *
 * Used by `POST /usage`, which reports the plan's allowance in `X-RateLimit-*`
 * headers rather than only refusing at the ceiling — a metering client needs to
 * see itself approaching the limit, not just discover it.
 */
export async function enforceLimit(
  name: string,
  key: string,
  limit: Limit,
): Promise<LimitResult> {
  // Reports the full allowance as remaining when limiting is off, so the
  // `X-RateLimit-*` headers stay truthful rather than claiming a ceiling that
  // is not being applied.
  if (!getSettings().RATE_LIMIT_ENABLED) {
    return { remaining: limit.max, retryAfter: 0, limit: limit.max };
  }
  const now = new Date();
  const bucket = `${name}:${key}`;

  const doc = await rateLimitsCollection().findOneAndUpdate(
    { bucket, expires_at: { $gt: now } },
    {
      $inc: { count: 1 },
      $setOnInsert: {
        bucket,
        expires_at: new Date(now.getTime() + limit.windowSeconds * 1000),
      },
    },
    { upsert: true, returnDocument: 'after' },
  );

  const count = Number(doc?.['count'] ?? 1);
  const expiresAt = doc?.['expires_at'] as Date | undefined;
  const retryAfter = expiresAt
    ? Math.max(1, Math.ceil((expiresAt.getTime() - now.getTime()) / 1000))
    : limit.windowSeconds;

  if (count > limit.max) {
    throw new HttpError(429, 'Too many requests. Please try again later.', {
      'Retry-After': String(retryAfter),
      'X-RateLimit-Limit': String(limit.max),
      'X-RateLimit-Remaining': '0',
      'X-RateLimit-Reset': String(retryAfter),
    });
  }
  return { remaining: Math.max(0, limit.max - count), retryAfter, limit: limit.max };
}

/**
 * Count one call against a named limit, or throw 429.
 *
 * A single atomic upsert-and-increment, so two concurrent requests cannot both
 * read "9 so far" and both be allowed through. `expires_at` is only written on
 * insert, so the window is fixed from the first call rather than sliding forward
 * with each one — otherwise a steady stream of calls would keep pushing the reset
 * out and the limit would never release.
 */
export async function enforce(name: string, key: string): Promise<void> {
  const limit = LIMITS[name];
  if (!limit) throw new Error(`Unknown rate limit: ${name}`);
  // An escape hatch for local work and load tests. The name is still resolved
  // above, so a typo in a limit name is caught even when limiting is off.
  if (!getSettings().RATE_LIMIT_ENABLED) return;

  const now = new Date();
  const bucket = `${name}:${key}`;

  const doc = await rateLimitsCollection().findOneAndUpdate(
    { bucket, expires_at: { $gt: now } },
    {
      $inc: { count: 1 },
      $setOnInsert: {
        bucket,
        expires_at: new Date(now.getTime() + limit.windowSeconds * 1000),
      },
    },
    { upsert: true, returnDocument: 'after' },
  );

  const count = Number(doc?.['count'] ?? 1);
  if (count > limit.max) {
    const expiresAt = doc?.['expires_at'] as Date | undefined;
    const retryAfter = expiresAt
      ? Math.max(1, Math.ceil((expiresAt.getTime() - now.getTime()) / 1000))
      : limit.windowSeconds;
    throw new HttpError(429, 'Too many requests. Please try again later.', {
      'Retry-After': String(retryAfter),
    });
  }
}

/**
 * The caller's address.
 *
 * `req.ip` honours Express's `trust proxy`, which `app.ts` sets from
 * `TRUST_PROXY_HEADERS` — off unless a proxy you control rewrites the header.
 * With it off, `req.ip` is the socket address and a forged `X-Forwarded-For` is
 * ignored, which is what keeps per-IP limits meaningful on a directly exposed
 * deployment.
 */
export function clientIp(req: Request): string {
  return req.ip ?? req.socket.remoteAddress ?? 'unknown';
}

/** Express middleware form: count this request against a per-IP limit. */
export function byIp(name: string) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      await enforce(name, clientIp(req));
      next();
    } catch (err) {
      next(err);
    }
  };
}
