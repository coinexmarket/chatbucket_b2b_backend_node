/**
 * Security primitives: password hashing, JWTs, API keys, OTP hashing.
 *
 * Ported from `app/security.py` and **wire-compatible with it on purpose**.
 * Both services run against the same MongoDB during the cutover, so a hash
 * written by Python must verify here and vice versa. That constrains three
 * things, none of which may be "modernised" without a migration:
 *
 *   - passwords are `pbkdf2_sha256$<iterations>$<salt_hex>$<hash_hex>`,
 *     PBKDF2-HMAC-SHA256, 240k iterations, 16-byte salt, 32-byte output;
 *   - OTP codes are stored as HMAC-SHA256 under `JWT_SECRET`, hex;
 *   - API keys and opaque tokens are stored as plain SHA-256 hex.
 *
 * bcrypt/argon2 would be a fine choice for a greenfield service and are the
 * wrong choice here: switching would lock out every existing customer.
 */
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';

import { getSettings } from './config.js';

// --- Password hashing (PBKDF2-HMAC-SHA256) ---------------------------------
const PBKDF2_ITERATIONS = 240_000;
const SALT_BYTES = 16;
const KEY_BYTES = 32; // SHA-256 digest size — what Python's default dklen gives.

/** `hashPassword`, off the event loop. */
export function hashPassword(password: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(SALT_BYTES);
    crypto.pbkdf2(password, salt, PBKDF2_ITERATIONS, KEY_BYTES, 'sha256', (err, dk) => {
      if (err) return reject(err);
      resolve(
        `pbkdf2_sha256$${PBKDF2_ITERATIONS}$${salt.toString('hex')}$${dk.toString('hex')}`,
      );
    });
  });
}

/**
 * Constant-time verify a password against a stored PBKDF2 string.
 *
 * `crypto.pbkdf2` (async) rather than `pbkdf2Sync`: 240k iterations is ~200ms
 * of CPU, and the sync call would block the event loop for that whole time,
 * stalling every other in-flight request. Since login hashes even when no user
 * matches (see `dummyPasswordHash`), unauthenticated traffic alone could
 * saturate the process. Node runs the async variant on its threadpool.
 */
export function verifyPassword(password: string, stored: string): Promise<boolean> {
  return new Promise((resolve) => {
    const parts = (stored ?? '').split('$');
    if (parts.length !== 4) return resolve(false);
    const [algorithm, iterStr, saltHex, hashHex] = parts as [string, string, string, string];
    if (algorithm !== 'pbkdf2_sha256') return resolve(false);

    const iterations = Number.parseInt(iterStr, 10);
    if (!Number.isFinite(iterations) || iterations <= 0) return resolve(false);

    let salt: Buffer;
    let expected: Buffer;
    try {
      salt = Buffer.from(saltHex, 'hex');
      expected = Buffer.from(hashHex, 'hex');
    } catch {
      return resolve(false);
    }
    if (expected.length === 0) return resolve(false);

    crypto.pbkdf2(password, salt, iterations, expected.length, 'sha256', (err, dk) => {
      if (err) return resolve(false);
      // Length-checked before comparing: timingSafeEqual throws on a mismatch.
      resolve(dk.length === expected.length && crypto.timingSafeEqual(dk, expected));
    });
  });
}

let dummyHash: string | null = null;

/**
 * A throwaway hash carrying the same work factor as a real one.
 *
 * Verifying against this when no user matches keeps login's response time the
 * same whether or not the email exists. Otherwise the miss path skips ~240k
 * PBKDF2 rounds and returns visibly faster, which turns the endpoint into an
 * account-enumeration oracle.
 */
export async function dummyPasswordHash(): Promise<string> {
  if (dummyHash === null) {
    dummyHash = await hashPassword(crypto.randomBytes(32).toString('base64url'));
  }
  return dummyHash;
}

/**
 * Build the dummy hash before serving traffic.
 *
 * Otherwise the very first login with an unknown email pays the ~200ms hash to
 * build it. Called at startup, where blocking costs nothing.
 */
export async function warmPasswordHasher(): Promise<void> {
  await dummyPasswordHash();
}

// --- JWT access tokens -----------------------------------------------------

export interface AccessTokenClaims {
  sub: string;
  email?: string;
  ver?: number;
  type?: string;
  iat?: number;
  exp?: number;
}

export function createAccessToken(subject: string, extra: Record<string, unknown> = {}): string {
  const s = getSettings();
  return jwt.sign({ sub: subject, type: 'access', ...extra }, s.JWT_SECRET, {
    algorithm: s.JWT_ALGORITHM as jwt.Algorithm,
    expiresIn: `${s.ACCESS_TOKEN_EXPIRE_MINUTES}m`,
  });
}

export function decodeAccessToken(token: string): AccessTokenClaims | null {
  const s = getSettings();
  try {
    return jwt.verify(token, s.JWT_SECRET, {
      algorithms: [s.JWT_ALGORITHM as jwt.Algorithm],
    }) as AccessTokenClaims;
  } catch {
    return null;
  }
}

/**
 * The user's current token generation.
 *
 * Bumping this on the user document invalidates every token issued before it.
 * Users created before the field existed read as 0, which matches the claim
 * default, so their live tokens keep working until something revokes them.
 */
export function tokenVersionOf(user: Record<string, unknown>): number {
  const v = user['token_version'];
  return typeof v === 'number' ? v : 0;
}

/** The one place the claim shape is defined, so the auth middleware can rely on it. */
export function createAccessTokenForUser(user: Record<string, unknown>): string {
  return createAccessToken(String(user['_id']), {
    email: user['email'],
    ver: tokenVersionOf(user),
  });
}

// --- API keys --------------------------------------------------------------
// Format: cb_live_<random>. Only the SHA-256 hash is stored; the plaintext is
// shown to the customer exactly once, at creation.
const API_KEY_PREFIX = 'cb_live_';

export function hashApiKey(fullKey: string): string {
  return crypto.createHash('sha256').update(fullKey, 'utf8').digest('hex');
}

export function generateApiKey(): {
  full: string;
  prefix: string;
  hash: string;
  last4: string;
} {
  const raw = crypto.randomBytes(32).toString('base64url');
  const full = `${API_KEY_PREFIX}${raw}`;
  return {
    full,
    prefix: API_KEY_PREFIX.replace(/_$/, ''),
    hash: hashApiKey(full),
    last4: full.slice(-4),
  };
}

// --- Opaque tokens ---------------------------------------------------------

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

function randomToken(bytes: number): [string, string] {
  const token = crypto.randomBytes(bytes).toString('base64url');
  return [token, hashToken(token)];
}

export const generateResetToken = () => randomToken(32);
export const generateVerificationToken = () => randomToken(32);

/**
 * Opaque and random rather than a JWT: a refresh token must be revocable the
 * instant a user signs out, and that means checking it against storage on every
 * use — which a self-contained JWT is specifically designed to avoid.
 */
export const generateRefreshToken = () => randomToken(48);

// --- Verification codes ----------------------------------------------------

/**
 * Keyed hash of a six-digit code, for storage.
 *
 * HMAC under `JWT_SECRET` rather than a bare SHA-256: there are only a million
 * six-digit codes, so a plain digest is reversed by a laptop in seconds and
 * storing one would be the same as storing the code. The key lives in the
 * environment, not the database, so a dump of the users collection on its own
 * reveals nothing.
 */
export function hashEmailOtp(code: string): string {
  return crypto
    .createHmac('sha256', Buffer.from(getSettings().JWT_SECRET, 'utf8'))
    .update(code, 'utf8')
    .digest('hex');
}

/**
 * A six-digit code and its keyed hash.
 *
 * `crypto.randomInt`, not `Math.random`: this is a credential. Zero-padded, so
 * "004821" is valid and the keyspace is the full million rather than the
 * 900,000 you get by starting at 100000.
 */
export function generateEmailOtp(): [string, string] {
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  return [code, hashEmailOtp(code)];
}

/** Constant-time compare of two hex digests of equal length. */
export function digestsEqual(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}
