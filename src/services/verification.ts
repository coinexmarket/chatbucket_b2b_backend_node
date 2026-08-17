/**
 * Verification credentials — issuing them, and which channel carries them.
 *
 * Ported from `app/verification.py`. Lives in its own module rather than inside
 * the auth route because several callers need it: register, the resend routes,
 * and the scheduled reminder that chases accounts which never verified. A
 * reminder sent a day later **must mint a fresh pair** — the code from signup
 * expired within minutes, and re-sending a dead credential is worse than sending
 * nothing, because the customer tries it and concludes the product is broken.
 */
import type { ObjectId } from 'mongodb';

import { getSettings } from '../config.js';
import { phoneVerificationsCollection, usersCollection } from '../database.js';
import {
  digestsEqual,
  generateEmailOtp,
  generateVerificationToken,
  hashEmailOtp,
} from '../security.js';

export const CHANNEL_SMS = 'sms';
export const CHANNEL_EMAIL = 'email';
export type Channel = typeof CHANNEL_SMS | typeof CHANNEL_EMAIL;

/**
 * Which channel verifies this account: `sms` or `email`.
 *
 * An Indian number verifies by SMS and skips the email code entirely; every
 * other country verifies by email. This is the **single** place that rule lives,
 * so no route has to know about dial codes — and so changing the rule is one
 * function rather than a hunt.
 *
 * `SMS_COUNTRY_CODES` drives it, defaulting to `+91`. The number is already
 * E.164 by the time it is stored (see `schemas/auth.normalizePhone`), so a prefix
 * test is exact rather than a guess.
 */
export function channelFor(phone: string | null | undefined): Channel {
  const s = getSettings();
  // Nothing can be texted, so the only channel that works is email.
  if (s.resolvedSmsBackend === 'disabled') return CHANNEL_EMAIL;
  if (!phone) return CHANNEL_EMAIL;
  const number = phone.trim();
  return s.smsCountryCodeList.some((code) => number.startsWith(code))
    ? CHANNEL_SMS
    : CHANNEL_EMAIL;
}

/**
 * True when the account has confirmed itself through **either** channel.
 *
 * The gate on API-key creation reads this rather than `email_verified` directly:
 * an Indian account is never sent an email code, so checking that field alone
 * would block it permanently the moment `REQUIRE_EMAIL_VERIFICATION` is on.
 *
 * Deliberately either/or rather than "whichever channel applies now".
 * `channelFor` depends on the *current* phone number, so re-deriving it here
 * would mean an email-verified customer who edits their phone to an Indian one
 * silently becomes unverified and loses the ability to create a key — punished
 * for updating their profile. What was proven stays proven; the channel rule
 * decides which code to *send*, not which flag to trust forever.
 *
 * Changing the phone number does still clear `phone_verified` (see the profile
 * route), because the new number is not the proven one.
 */
export function isVerified(user: Record<string, unknown>): boolean {
  return Boolean(user['email_verified']) || Boolean(user['phone_verified']);
}

/** Applied by every path that confirms an address, so a code and a link cannot
 *  leave the account in two different states. */
export function markVerifiedUpdate(now = new Date()) {
  return {
    $set: { email_verified: true, email_verified_at: now },
    // Single use: both credentials are spent whichever one was presented.
    $unset: {
      verification_token_hash: '',
      verification_token_expires: '',
      verification_code_hash: '',
      verification_code_expires: '',
      verification_code_attempts: '',
    },
  };
}

export function markPhoneVerifiedUpdate(now = new Date()) {
  return {
    $set: { phone_verified: true, phone_verified_at: now },
    $unset: { phone_code_hash: '', phone_code_expires: '', phone_code_attempts: '' },
  };
}

/**
 * Store a fresh link token and code on the account. Returns `[token, code]`.
 *
 * Replaces whatever was there. Issuing supersedes rather than adds: an account
 * should never have two live codes, or the attempt counter guards one of them
 * while the other stays freely guessable.
 */
export async function issueCredentials(userId: ObjectId): Promise<[string, string]> {
  const s = getSettings();
  const [token, tokenHash] = generateVerificationToken();
  const [code, codeHash] = generateEmailOtp();
  const now = new Date();

  await usersCollection().updateOne(
    { _id: userId },
    {
      $set: {
        verification_token_hash: tokenHash,
        verification_token_expires: new Date(
          now.getTime() + s.VERIFICATION_TOKEN_EXPIRE_HOURS * 3_600_000,
        ),
        verification_code_hash: codeHash,
        verification_code_expires: new Date(
          now.getTime() + s.EMAIL_OTP_EXPIRE_MINUTES * 60_000,
        ),
        // Reset with each new code: a resend is a fresh secret, and carrying the
        // old attempt count over would lock someone out of a code they have only
        // just received.
        verification_code_attempts: 0,
      },
    },
  );
  return [token, code];
}

/**
 * Store a fresh six-digit code for an existing account's mobile number.
 *
 * Separate storage from the email code on purpose: an account could hold both at
 * once (a number that changed country, say), and one attempt counter guarding
 * two secrets would let the unguarded one be brute-forced freely.
 */
export async function issuePhoneCode(userId: ObjectId): Promise<string> {
  const s = getSettings();
  const [code, codeHash] = generateEmailOtp();
  await usersCollection().updateOne(
    { _id: userId },
    {
      $set: {
        phone_code_hash: codeHash,
        phone_code_expires: new Date(Date.now() + s.PHONE_OTP_EXPIRE_MINUTES * 60_000),
        // Reset with the code: a resend is a new secret, and carrying the old
        // count over would lock someone out of a code they have just been sent.
        phone_code_attempts: 0,
      },
    },
  );
  return code;
}

// --- Numbers proven before the account exists -------------------------------
//
// The signup form verifies the mobile number *while the form is being filled
// in*, so the code has to be issued and checked before there is any user
// document to store it on. These four functions are that flow, keyed by the
// number instead of by `_id`.
//
// The order matters for a reason worth stating: verifying first means an account
// is only ever created for a number somebody can actually receive a text on, and
// the per-message cost is paid before the free signup credits are granted rather
// than after. Verifying afterwards would let a signup with a mistyped number
// succeed and take the bonus with it.

export const OUTCOME_OK = 'ok';
export const OUTCOME_INVALID = 'invalid';
export const OUTCOME_LOCKED = 'locked';
export type Outcome = typeof OUTCOME_OK | typeof OUTCOME_INVALID | typeof OUTCOME_LOCKED;

/**
 * Store a fresh code against a bare number. Returns the code.
 *
 * Upsert rather than insert: a resend must replace the previous code, not add a
 * second live one (see the unique index on `phone`).
 */
export async function issuePendingPhoneCode(phone: string): Promise<string> {
  const s = getSettings();
  const [code, codeHash] = generateEmailOtp();
  const now = new Date();

  await phoneVerificationsCollection().updateOne(
    { phone },
    {
      $set: {
        code_hash: codeHash,
        expires_at: new Date(now.getTime() + s.PHONE_OTP_EXPIRE_MINUTES * 60_000),
        attempts: 0,
        updated_at: now,
        // Long enough to cover the code window *and* the grace period a verified
        // record stays usable for, so the TTL index never deletes a record that
        // registration is about to read.
        purge_at: new Date(
          now.getTime() +
            (s.PHONE_OTP_EXPIRE_MINUTES + s.PHONE_VERIFICATION_GRACE_MINUTES + 60) * 60_000,
        ),
      },
      $setOnInsert: { phone, created_at: now },
      // A new code un-verifies the number: otherwise someone could verify, then
      // request a code for the same number and still be treated as verified
      // without ever proving the second one.
      $unset: { verified_at: '' },
    },
    { upsert: true },
  );
  return code;
}

/**
 * Check a code against a bare number.
 *
 * On success the record is stamped `verified_at` and the code is spent, so
 * `phoneRecentlyVerified` can answer for it during registration.
 */
export async function checkPendingPhoneCode(phone: string, code: string): Promise<Outcome> {
  const s = getSettings();
  const record = await phoneVerificationsCollection().findOne({ phone });
  if (!record) return OUTCOME_INVALID;

  const stored = record['code_hash'] as string | undefined;
  const expires = record['expires_at'] as Date | undefined;
  if (!stored || !expires || expires.getTime() < Date.now()) return OUTCOME_INVALID;

  const attempts = Number(record['attempts'] ?? 0);
  if (attempts >= s.PHONE_OTP_MAX_ATTEMPTS) return OUTCOME_LOCKED;

  if (!digestsEqual(stored, hashEmailOtp(code))) {
    // In the database, not in memory, so the cap survives a restart and holds
    // across every worker rather than per-process.
    await phoneVerificationsCollection().updateOne({ phone }, { $inc: { attempts: 1 } });
    return OUTCOME_INVALID;
  }

  await phoneVerificationsCollection().updateOne(
    { phone },
    {
      $set: { verified_at: new Date() },
      // Single use, like every other code here.
      $unset: { code_hash: '', expires_at: '', attempts: '' },
    },
  );
  return OUTCOME_OK;
}

/**
 * True when this number was proven a short while ago and not yet claimed.
 *
 * Bounded by `PHONE_VERIFICATION_GRACE_MINUTES` rather than open-ended: the proof
 * is that somebody held the handset *at that moment*, and a record left lying
 * around for a day would let a number verified once be attached to an account
 * created later by somebody else.
 */
export async function phoneRecentlyVerified(phone: string): Promise<boolean> {
  const s = getSettings();
  const record = await phoneVerificationsCollection().findOne({ phone });
  const verifiedAt = record?.['verified_at'] as Date | undefined;
  if (!verifiedAt) return false;
  const cutoff = Date.now() - s.PHONE_VERIFICATION_GRACE_MINUTES * 60_000;
  return verifiedAt.getTime() >= cutoff;
}

/**
 * Consume the record once an account has been created for the number.
 *
 * Single use: without this the same proof could be replayed to create several
 * accounts on one number, each collecting the signup bonus — the exact abuse the
 * unique index on `users.phone` exists to stop.
 */
export async function claimPendingPhone(phone: string): Promise<void> {
  await phoneVerificationsCollection().deleteOne({ phone });
}
