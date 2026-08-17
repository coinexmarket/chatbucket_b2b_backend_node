/**
 * Refresh tokens: keeping a session alive without a long-lived credential.
 *
 * Ported from `app/sessions.py`. Access tokens last 24h and are self-contained,
 * which makes them fast to check but impossible to revoke individually. Refresh
 * tokens are the opposite — opaque, stored hashed, and checked against the
 * database on every use — so a sign-out takes effect immediately.
 *
 * **Rotation with reuse detection.** Each refresh consumes the token and issues a
 * new one, so a token has exactly one legitimate use. Seeing it a second time
 * means the value leaked and two parties hold it. That cannot be told apart from
 * the attacker refreshing first, so the whole family is revoked and everyone is
 * signed out. Losing a session is a far better outcome than silently sharing one
 * with whoever copied the token.
 */
import type { ObjectId } from 'mongodb';

import { getSettings } from '../config.js';
import { refreshTokensCollection } from '../database.js';
import { logger } from '../logger.js';
import { generateRefreshToken, hashToken } from '../security.js';

/**
 * Create a refresh token. Returns `[token, expiresAt]`.
 *
 * `family` chains a rotated token to its predecessor, so a reuse can revoke every
 * descendant of the original sign-in rather than just one row.
 */
export async function issue(
  userId: ObjectId,
  family?: string,
): Promise<[string, Date]> {
  const s = getSettings();
  const [token, tokenHash] = generateRefreshToken();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + s.REFRESH_TOKEN_EXPIRE_DAYS * 86_400_000);

  await refreshTokensCollection().insertOne({
    user_id: userId,
    token_hash: tokenHash,
    family: family ?? tokenHash,
    revoked: false,
    used_at: null,
    created_at: now,
    expires_at: expiresAt,
  });
  return [token, expiresAt];
}

/** Revoke every token descended from one sign-in. */
export async function revokeFamily(family: string, reason: string): Promise<number> {
  const result = await refreshTokensCollection().updateMany(
    { family, revoked: false },
    { $set: { revoked: true, reason } },
  );
  return result.modifiedCount;
}

/**
 * Spend a refresh token, returning its record, or null if unusable.
 *
 * The token is claimed with a conditional update, so two concurrent refreshes
 * cannot both succeed — exactly one gets the rotation.
 */
export async function consume(token: string): Promise<Record<string, unknown> | null> {
  const tokenHash = hashToken(token);

  const claimed = await refreshTokensCollection().findOneAndUpdate(
    { token_hash: tokenHash, revoked: false, used_at: null },
    { $set: { used_at: new Date() } },
    { returnDocument: 'after' },
  );
  if (claimed) {
    const expires = claimed['expires_at'] as Date | undefined;
    if (expires && expires.getTime() < Date.now()) return null;
    return claimed;
  }

  // Nothing claimable. If the token exists but was already spent, it has been
  // replayed — treat the whole family as compromised.
  const existing = await refreshTokensCollection().findOne({ token_hash: tokenHash });
  if (existing && existing['used_at']) {
    const revoked = await revokeFamily(String(existing['family']), 'refresh token reused');
    logger.warn(
      'refresh token replayed for user %s; revoked %d session(s)',
      String(existing['user_id']),
      revoked,
    );
  }
  return null;
}

/** Sign out a single session (the caller's own logout). */
export async function revokeOne(token: string): Promise<boolean> {
  const result = await refreshTokensCollection().updateOne(
    { token_hash: hashToken(token), revoked: false },
    { $set: { revoked: true, reason: 'logout' } },
  );
  return result.modifiedCount > 0;
}

/** Sign out every session for a user. */
export async function revokeAllForUser(
  userId: ObjectId,
  reason = 'logout_all',
): Promise<number> {
  const result = await refreshTokensCollection().updateMany(
    { user_id: userId, revoked: false },
    { $set: { revoked: true, reason } },
  );
  return result.modifiedCount;
}

export async function activeCount(userId: ObjectId): Promise<number> {
  return refreshTokensCollection().countDocuments({
    user_id: userId,
    revoked: false,
    used_at: null,
  });
}
