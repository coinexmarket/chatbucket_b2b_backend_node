/**
 * Credit accounts and the ledger.
 *
 * Ported from `app/credits.py`. Two invariants carry over and neither is
 * negotiable:
 *
 *   1. **A balance is never written from a value read earlier.** Debits are a
 *      single `findOneAndUpdate` with `$gte` in the filter and `$inc` in the
 *      update, so the check and the decrement are one atomic operation. Read,
 *      compare in the app, then write would let two concurrent requests each see
 *      a sufficient balance and both spend it.
 *   2. **Every movement writes a ledger row.** A balance with no explanation is
 *      unauditable, and "why was I charged" is a question support must be able to
 *      answer.
 *
 * Amounts are stored as `Decimal128` and handled as `Decimal` — see `money.ts`
 * for why a float here would be a billing bug.
 */
import type { ObjectId } from 'mongodb';

import { creditAccountsCollection, creditLedgerCollection } from '../database.js';
import { Decimal, toBson, toDecimal, type AmountLike } from '../money.js';
import { logger } from '../logger.js';

export const KIND_SIGNUP_BONUS = 'signup_bonus';
export const KIND_TOPUP = 'topup';
export const KIND_USAGE = 'usage';
export const KIND_ADJUSTMENT = 'adjustment';

/** Open the account if it does not exist yet, and return it. */
export async function getAccount(userId: ObjectId): Promise<Record<string, unknown>> {
  const now = new Date();
  const doc = await creditAccountsCollection().findOneAndUpdate(
    { user_id: userId },
    {
      $setOnInsert: {
        user_id: userId,
        balance: toBson(0),
        created_at: now,
        updated_at: now,
      },
    },
    { upsert: true, returnDocument: 'after' },
  );
  return doc as Record<string, unknown>;
}

export async function balanceOf(userId: ObjectId): Promise<Decimal> {
  const account = await getAccount(userId);
  return toDecimal((account['balance'] ?? 0) as AmountLike);
}

/**
 * Add credit and record why.
 *
 * `$inc` on a `Decimal128` rather than a computed absolute value, so two grants
 * landing at once both count instead of one overwriting the other.
 */
export async function grant(
  userId: ObjectId,
  amount: AmountLike,
  kind: string,
  description: string,
): Promise<Decimal> {
  const value = toDecimal(amount);
  if (value.lessThanOrEqualTo(0)) {
    throw new Error('A grant must be a positive amount.');
  }
  const now = new Date();

  // Ensure the account exists before incrementing it.
  await getAccount(userId);
  const updated = await creditAccountsCollection().findOneAndUpdate(
    { user_id: userId },
    { $inc: { balance: toBson(value) }, $set: { updated_at: now } },
    { returnDocument: 'after' },
  );

  await creditLedgerCollection().insertOne({
    user_id: userId,
    kind,
    description,
    amount: toBson(value),
    balance_after: updated?.['balance'] ?? toBson(value),
    created_at: now,
  });

  return toDecimal((updated?.['balance'] ?? value) as AmountLike);
}

/**
 * Spend credit, or return null if the balance is insufficient.
 *
 * The `$gte` guard lives **in the filter**, so the balance check and the
 * decrement are one atomic step and the balance can never go negative — not even
 * under two simultaneous requests that each saw enough credit a moment earlier.
 */
export async function debit(
  userId: ObjectId,
  amount: AmountLike,
  kind: string,
  description: string,
): Promise<Decimal | null> {
  const value = toDecimal(amount);
  if (value.lessThanOrEqualTo(0)) throw new Error('A debit must be a positive amount.');

  const now = new Date();
  const updated = await creditAccountsCollection().findOneAndUpdate(
    { user_id: userId, balance: { $gte: toBson(value) } },
    { $inc: { balance: toBson(value.negated()) }, $set: { updated_at: now } },
    { returnDocument: 'after' },
  );
  if (!updated) return null; // Insufficient balance — nothing was written.

  await creditLedgerCollection().insertOne({
    user_id: userId,
    kind,
    description,
    amount: toBson(value.negated()),
    balance_after: updated['balance'],
    created_at: now,
  });

  return toDecimal(updated['balance'] as AmountLike);
}

/**
 * Open the credit account for a new signup, granting the bonus if one is set.
 *
 * Failure here must **not** undo a successful registration: the customer has an
 * account, and the balance can be opened lazily on first use. So this logs and
 * returns rather than throwing.
 */
export async function openForSignup(
  userId: ObjectId,
  bonus: string,
): Promise<Decimal | null> {
  try {
    const amount = toDecimal(bonus || '0');
    if (amount.greaterThan(0)) {
      await grant(userId, amount, KIND_SIGNUP_BONUS, 'Welcome credits');
      return amount;
    }
    await getAccount(userId);
    return null;
  } catch (err) {
    logger.error(
      'could not open credit account for %s: %s',
      String(userId),
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}
