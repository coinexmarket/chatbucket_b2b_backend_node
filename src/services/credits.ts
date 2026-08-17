/**
 * Credit balances and the append-only credit ledger.
 *
 * Ported from `app/credits.py`. Credits are the account's prepaid spending
 * power: 1 credit = ₹1, so a usage record costing ₹5.20 debits 5.2 credits.
 *
 * **Balances are stored as integer minor units**, not `Decimal128`. 1 credit =
 * `UNITS_PER_CREDIT` units, matching the 4dp `money.ts` works to, so the value
 * is exact. Integers are used because the overspend guard depends on comparing
 * and incrementing the balance *inside a single Mongo update* — `{$gte: n}` plus
 * `{$inc: -n}` — and that has to be atomic to be correct under concurrent
 * requests. Two simultaneous calls against a balance of 5 must not both succeed
 * in spending 5. (`$gte` against a `Decimal128` would also work in Mongo, but
 * the Python service stores integers and both must agree — see below.)
 *
 * The field names here are **not** a free choice. Both services read and write
 * the same documents during the cutover, so `balance_units`,
 * `lifetime_purchased_units`, `units` and `balance_after_units` must match
 * `credits.py` exactly. An earlier draft of this file invented a Decimal128
 * `balance` field; it passed its own tests and would have produced accounts the
 * Python service read as having a zero balance.
 *
 * Two collections:
 *   credit_accounts — one document per user with the authoritative balance;
 *   credit_ledger   — append-only history of every movement.
 *
 * The balance is the authority, not a sum of the ledger: summing an ever-growing
 * ledger on every metered call would get slower for exactly the customers who
 * use the service most.
 */
import type { ObjectId } from 'mongodb';

import { creditAccountsCollection, creditLedgerCollection } from '../database.js';
import { logger } from '../logger.js';
import { Decimal, quantize, toDecimal, type AmountLike } from '../money.js';

/** 4 decimal places, the same precision `money.quantize` works to. */
export const UNITS_PER_CREDIT = 10_000;

export const KIND_PURCHASE = 'purchase';
export const KIND_SIGNUP_BONUS = 'signup_bonus';
export const KIND_USAGE = 'usage';
export const KIND_ADJUSTMENT = 'adjustment';
export const KIND_REFUND = 'refund';

/** Credits -> integer minor units, exactly. */
export function toUnits(credits: AmountLike): number {
  return quantize(credits).times(UNITS_PER_CREDIT).toNumber();
}

/** Integer minor units -> credits. */
export function fromUnits(units: number): Decimal {
  return quantize(new Decimal(units).dividedBy(UNITS_PER_CREDIT));
}

/**
 * The user's credit account, creating an empty one on first touch.
 *
 * Upserted rather than created at registration, so accounts that predate billing
 * behave identically to new ones.
 */
export async function getAccount(userId: ObjectId): Promise<Record<string, unknown>> {
  await creditAccountsCollection().updateOne(
    { user_id: userId },
    {
      $setOnInsert: {
        user_id: userId,
        balance_units: 0,
        lifetime_purchased_units: 0,
        auto_recharge: { enabled: false, threshold_credits: null, amount_inr: null },
        created_at: new Date(),
      },
    },
    { upsert: true },
  );
  return (await creditAccountsCollection().findOne({ user_id: userId })) ?? {};
}

export async function balanceUnits(userId: ObjectId): Promise<number> {
  const account = await getAccount(userId);
  return Number(account['balance_units'] ?? 0);
}

export async function balanceOf(userId: ObjectId): Promise<Decimal> {
  return fromUnits(await balanceUnits(userId));
}

async function appendLedger(
  userId: ObjectId,
  units: number,
  kind: string,
  description: string,
  balanceAfter: number,
  ref: unknown = null,
): Promise<Record<string, unknown>> {
  const entry: Record<string, unknown> = {
    user_id: userId,
    kind,
    units, // signed: negative for spend
    balance_after_units: balanceAfter,
    description,
    ref,
    created_at: new Date(),
  };
  const result = await creditLedgerCollection().insertOne(entry);
  entry['_id'] = result.insertedId;
  return entry;
}

/** Add credits. Returns the ledger entry. */
export async function grant(
  userId: ObjectId,
  units: number,
  kind: string,
  description: string,
  ref: unknown = null,
): Promise<Record<string, unknown>> {
  if (units <= 0) throw new Error('grant requires a positive number of units');

  await getAccount(userId);
  const inc: Record<string, number> = { balance_units: units };
  if (kind === KIND_PURCHASE) inc['lifetime_purchased_units'] = units;

  const account = await creditAccountsCollection().findOneAndUpdate(
    { user_id: userId },
    { $inc: inc },
    { returnDocument: 'after' },
  );
  return appendLedger(
    userId,
    units,
    kind,
    description,
    Number(account?.['balance_units'] ?? units),
    ref,
  );
}

/**
 * Spend credits if the balance covers it. Returns the ledger entry, or null.
 *
 * The balance check and the decrement are a single conditional update, so two
 * concurrent calls cannot both pass a check that only one balance can satisfy.
 * Read-then-write would let them.
 */
export async function tryDebit(
  userId: ObjectId,
  units: number,
  description: string,
  ref: unknown = null,
): Promise<Record<string, unknown> | null> {
  if (units < 0) throw new Error('tryDebit requires a non-negative number of units');

  await getAccount(userId);
  const account = await creditAccountsCollection().findOneAndUpdate(
    { user_id: userId, balance_units: { $gte: units } },
    { $inc: { balance_units: -units } },
    { returnDocument: 'after' },
  );
  if (!account) return null; // insufficient balance; nothing was deducted

  // The decrement above is the authoritative step and has already happened. If
  // this append fails the customer is charged with no ledger line, so it is
  // logged loudly rather than swallowed — the balance is still correct.
  try {
    return await appendLedger(
      userId,
      -units,
      KIND_USAGE,
      description,
      Number(account['balance_units'] ?? 0),
      ref,
    );
  } catch (err) {
    logger.error(
      'debited %d units from %s but failed to write the ledger entry: %s',
      units,
      String(userId),
      err instanceof Error ? err.message : err,
    );
    throw err;
  }
}

/**
 * Spend credits without a balance check, letting the balance go negative.
 *
 * Used only when the deployment has chosen never to refuse a metered call. The
 * consumption still happened, so the ledger and balance must still record it — a
 * negative balance is the honest statement of what was allowed through unpaid.
 */
export async function debitAllowingNegative(
  userId: ObjectId,
  units: number,
  description: string,
  ref: unknown = null,
): Promise<Record<string, unknown>> {
  await getAccount(userId);
  const account = await creditAccountsCollection().findOneAndUpdate(
    { user_id: userId },
    { $inc: { balance_units: -units } },
    { returnDocument: 'after' },
  );
  return appendLedger(
    userId,
    -units,
    KIND_USAGE,
    description,
    Number(account?.['balance_units'] ?? 0),
    ref,
  );
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
  bonusCredits: string,
): Promise<number> {
  try {
    const units = toUnits(bonusCredits || '0');
    if (units > 0) {
      await grant(userId, units, KIND_SIGNUP_BONUS, 'Welcome credits');
      return units;
    }
    await getAccount(userId);
    return 0;
  } catch (err) {
    logger.error(
      'could not open credit account for %s: %s',
      String(userId),
      err instanceof Error ? err.message : err,
    );
    return 0;
  }
}
