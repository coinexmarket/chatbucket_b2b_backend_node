/**
 * Authentication middleware.
 *
 * Ported from `app/deps.py`. Three ways to authenticate, all resolving to the
 * same user document on `req.user`:
 *
 *   requireUser     — a Bearer JWT, for the dashboard/user-facing routes;
 *   requireApiKey   — an `X-API-Key` header, for machine-to-machine calls;
 *   requireMetering — either, for `POST /usage`.
 */
import type { NextFunction, Request, Response } from 'express';
import { ObjectId } from 'mongodb';

import { apiKeysCollection, usersCollection } from '../database.js';
import { HttpError } from '../errors.js';
import { decodeAccessToken, hashApiKey, tokenVersionOf } from '../security.js';

export interface AuthedRequest extends Request {
  user: Record<string, unknown>;
  /** Which key authenticated the call, when one did. */
  apiKeyId?: string;
  /** The project that key belongs to — usage inherits it. */
  apiKeyProjectId?: unknown;
}

const UNAUTHORIZED = (detail: string) =>
  new HttpError(401, detail, { 'WWW-Authenticate': 'Bearer' });

async function loadUser(userId: string | undefined): Promise<Record<string, unknown> | null> {
  if (!userId || !ObjectId.isValid(userId)) return null;
  return usersCollection().findOne({ _id: new ObjectId(userId) });
}

function bearerToken(req: Request): string | null {
  const header = req.get('authorization');
  if (!header) return null;
  const [scheme, token] = header.split(' ');
  if (!token || scheme?.toLowerCase() !== 'bearer') return null;
  return token.trim() || null;
}

/** Resolve the user from a Bearer JWT, or throw 401. */
export async function resolveUser(req: Request): Promise<Record<string, unknown>> {
  const token = bearerToken(req);
  if (!token) throw UNAUTHORIZED('Missing bearer token');

  const payload = decodeAccessToken(token);
  if (!payload || payload.type !== 'access') throw UNAUTHORIZED('Invalid or expired token');

  const user = await loadUser(payload.sub);
  if (!user) throw UNAUTHORIZED('User not found');

  // A password reset or change bumps `token_version`, retiring every token
  // issued before it. Without this, a token stolen before the reset stays valid
  // for the rest of its lifetime — i.e. the reset would not actually lock the
  // attacker out.
  if ((payload.ver ?? 0) !== tokenVersionOf(user)) {
    throw UNAUTHORIZED('Token is no longer valid. Please sign in again.');
  }
  return user;
}

export function requireUser(req: Request, _res: Response, next: NextFunction): void {
  resolveUser(req)
    .then((user) => {
      (req as AuthedRequest).user = user;
      next();
    })
    .catch(next);
}

/** Resolve the user from an `X-API-Key` header, recording last use. */
export async function resolveApiUser(req: Request): Promise<Record<string, unknown>> {
  const key = req.get('x-api-key');
  if (!key) throw new HttpError(401, 'Missing X-API-Key header');

  const keyDoc = await apiKeysCollection().findOne({
    key_hash: hashApiKey(key),
    revoked: false,
  });
  if (!keyDoc) throw new HttpError(401, 'Invalid API key');

  await apiKeysCollection().updateOne(
    { _id: keyDoc['_id'] as ObjectId },
    { $set: { last_used_at: new Date() } },
  );

  const user = await loadUser(String(keyDoc['user_id']));
  if (!user) throw new HttpError(401, 'User not found');

  // Stash which key was used so the usage record can reference it, and the
  // project that key belongs to — usage inherits the key's project rather than
  // the caller declaring one, so attribution cannot drift from whichever
  // credential actually did the work.
  (req as AuthedRequest).apiKeyId = String(keyDoc['_id']);
  (req as AuthedRequest).apiKeyProjectId = keyDoc['project_id'];
  return user;
}

export function requireApiKey(req: Request, _res: Response, next: NextFunction): void {
  resolveApiUser(req)
    .then((user) => {
      (req as AuthedRequest).user = user;
      next();
    })
    .catch(next);
}

/**
 * Resolve the account to meter, from **either** credential.
 *
 * `POST /usage` is normally machine-to-machine and authenticated by API key. But
 * our own site serves STT/TTS to signed-in customers through its internal routes,
 * and what those routes hold is the customer's session — the API key was shown
 * once at creation and stored only as a hash, so no server can produce it later.
 * Without this the site's own traffic could not be metered to the customer who
 * caused it, which is the whole point of metering it.
 *
 * The API key wins when both are sent: it is the more specific credential and the
 * only one that can attribute usage to a key and project.
 *
 * A JWT is no weaker here. Both belong to the account being charged, so the worst
 * either allows is inflating one's own bill — and the dashboard routes already
 * trust this same token to spend credits.
 */
export function requireMetering(req: Request, _res: Response, next: NextFunction): void {
  const run = async (): Promise<Record<string, unknown>> => {
    if (req.get('x-api-key')) return resolveApiUser(req);
    if (bearerToken(req)) {
      // No key id is stashed: this usage genuinely came from no key, and
      // inventing an attribution would corrupt the by-key split.
      return resolveUser(req);
    }
    throw new HttpError(401, 'Send an X-API-Key header or a Bearer access token.');
  };
  run()
    .then((user) => {
      (req as AuthedRequest).user = user;
      next();
    })
    .catch(next);
}
