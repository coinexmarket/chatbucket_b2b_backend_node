/**
 * Authentication: register, login, and the verification routes.
 *
 * Ported from `app/routers/auth.py`.
 */
import { Router, type Request } from 'express';
import { MongoServerError, ObjectId } from 'mongodb';

import { getSettings } from '../config.js';
import { indexesReady, usersCollection } from '../database.js';
import { HttpError, asyncHandler } from '../errors.js';
import { logger } from '../logger.js';
import * as ratelimit from '../middleware/ratelimit.js';
import {
  LoginRequest,
  RegisterRequest,
  ResendPhoneCodeRequest,
  VerifyPhoneRequest,
} from '../schemas/auth.js';
import {
  createAccessTokenForUser,
  digestsEqual,
  dummyPasswordHash,
  hashEmailOtp,
  hashPassword,
  verifyPassword,
} from '../security.js';
import { publicUser } from '../serialization.js';
import * as credits from '../services/credits.js';
import { sendPhoneVerification } from '../services/sms.js';
import * as verification from '../services/verification.js';

export const authRouter = Router();

const DEFAULT_PLAN = 'free';

const DUPLICATE_EMAIL = () =>
  new HttpError(409, 'An account with this email already exists.');

/**
 * A number identifies one account, so a taken one is a conflict rather than a
 * validation error — the value is well-formed, it just belongs to somebody.
 */
const DUPLICATE_PHONE = () =>
  new HttpError(409, 'An account with this mobile number already exists.');

/** The token payload every authenticating route returns, shaped once. */
function tokenResponse(user: Record<string, unknown>) {
  return {
    status: true,
    access_token: createAccessTokenForUser(user),
    token_type: 'bearer',
    data: publicUser(user),
  };
}

// --- Register ---------------------------------------------------------------

authRouter.post(
  '/register',
  ratelimit.byIp('register_ip'),
  asyncHandler(async (req: Request, res) => {
    const s = getSettings();
    const payload = RegisterRequest.parse(req.body);
    const now = new Date();

    // The unique index is what actually prevents two accounts on one email under
    // concurrent signups. While it is missing, that guarantee is gone entirely,
    // so fall back to an explicit lookup rather than silently accepting a
    // duplicate (which would then make login pick an arbitrary one).
    if (!indexesReady() && (await usersCollection().findOne({ email: payload.email }))) {
      throw DUPLICATE_EMAIL();
    }

    // Checked explicitly as well as by the unique index, because that index
    // cannot be created on data that already holds duplicates.
    if (await usersCollection().findOne({ phone: payload.mobile })) {
      throw DUPLICATE_PHONE();
    }

    // Did the signup form already prove this number by SMS? Checked before the
    // insert so the account can be created verified, rather than written
    // unverified and corrected a moment later — a window in which a crash would
    // leave someone who *did* verify holding an unverified account.
    const phonePreVerified = await verification.phoneRecentlyVerified(payload.mobile);

    const document: Record<string, unknown> = {
      name: payload.name.trim(),
      email: payload.email,
      company: payload.company?.trim() ?? null,
      // Stored under `phone` — the field the user document and the profile route
      // already use — so the form's "Mobile Number" does not become a second
      // column meaning the same thing. Already E.164 by way of the schema.
      phone: payload.mobile,
      how_did_you_hear: payload.howDidYouHear?.trim() || null,
      // When they agreed, and to what. A boolean alone cannot answer either
      // question later, and the terms text will change.
      terms_accepted_at: now,
      terms_version: s.TERMS_VERSION,
      plan: DEFAULT_PLAN,
      email_verified: false,
      password_hash: await hashPassword(payload.password),
      token_version: 0,
      created_at: now,
      updated_at: now,
    };
    if (phonePreVerified) {
      document['phone_verified'] = true;
      document['phone_verified_at'] = now;
    }

    let insertedId: ObjectId;
    try {
      const result = await usersCollection().insertOne(document);
      insertedId = result.insertedId;
    } catch (err) {
      // Two concurrent signups; which unique index tripped decides the message.
      if (err instanceof MongoServerError && err.code === 11000) {
        throw String(err.message).includes('phone') ? DUPLICATE_PHONE() : DUPLICATE_EMAIL();
      }
      throw err;
    }
    document['_id'] = insertedId;

    // Open the credit account and grant the trial balance. Never fatal — see
    // `credits.openForSignup`.
    await credits.openForSignup(insertedId, s.SIGNUP_BONUS_CREDITS);

    // One channel or the other, never both: an Indian number verifies by SMS and
    // is not sent an email code, every other country verifies by email.
    // `verification.channelFor` owns that rule.
    const channel = verification.channelFor(payload.mobile);
    let phoneCode: string | null = null;

    if (channel === verification.CHANNEL_SMS) {
      if (phonePreVerified) {
        // Already proven on the form. Sending a second code would cost another
        // message and ask the customer to do the same thing twice. The record is
        // consumed here so one proof cannot create a second account on the
        // same number.
        await verification.claimPendingPhone(payload.mobile);
      } else {
        phoneCode = await verification.issuePhoneCode(insertedId);
        // Not awaited: the customer should not wait on a gateway round trip
        // before their account appears, and a gateway outage must not fail a
        // signup that already succeeded.
        void sendPhoneVerification(payload.mobile, phoneCode);
      }
    } else {
      await verification.issueCredentials(insertedId);
    }

    const body: Record<string, unknown> = {
      ...tokenResponse(document),
      // Which channel the client should now prompt for. Without this the
      // frontend has to re-derive the dial-code rule, and the two would drift.
      verification_channel: channel,
    };
    // Nothing to read the code out of under the console backends.
    if (s.isDev && phoneCode) body['phone_code'] = phoneCode;

    res.status(201).json(body);
  }),
);

// --- Login ------------------------------------------------------------------

authRouter.post(
  '/login',
  ratelimit.byIp('login_ip'),
  asyncHandler(async (req: Request, res) => {
    const payload = LoginRequest.parse(req.body);
    const user = await usersCollection().findOne({ email: payload.email });

    // Hash even when no user matched, against a throwaway hash of the same work
    // factor. Skipping it would make the miss path return visibly faster and turn
    // this endpoint into an account-enumeration oracle.
    const stored = (user?.['password_hash'] as string | undefined) ?? (await dummyPasswordHash());
    const ok = await verifyPassword(payload.password, stored);

    if (!user || !ok) {
      // One message for both cases, for the same reason.
      throw new HttpError(401, 'Incorrect email or password.');
    }
    res.json(tokenResponse(user));
  }),
);

// --- Phone verification -----------------------------------------------------

authRouter.post(
  '/verify-phone',
  ratelimit.byIp('verify_phone_ip'),
  asyncHandler(async (req: Request, res) => {
    const s = getSettings();
    const payload = VerifyPhoneRequest.parse(req.body);

    // Per-number as well as per-IP: a per-IP cap alone lets a spread-out attacker
    // work through one number's million codes.
    await ratelimit.enforce('verify_phone_number', payload.mobile);

    const invalid = () => new HttpError(400, 'Invalid or expired verification code.');

    // Newest first: the number is unique going forward, but data written before
    // the index existed may hold duplicates, and the live code belongs to the
    // most recent signup.
    const user = await usersCollection().findOne(
      { phone: payload.mobile },
      { sort: { created_at: -1 } },
    );

    if (!user) {
      // No account yet — this is the signup form proving the number before it
      // creates one. The code lives in `phone_verifications`, keyed by the
      // number, and register reads the result.
      const outcome = await verification.checkPendingPhoneCode(payload.mobile, payload.code);
      if (outcome === verification.OUTCOME_LOCKED) {
        throw new HttpError(429, 'Too many incorrect codes. Request a new one.');
      }
      if (outcome !== verification.OUTCOME_OK) throw invalid();
      res.json({ status: true, message: 'Mobile number verified.' });
      return;
    }

    if (user['phone_verified']) {
      // Idempotent for someone who taps twice, and it reveals nothing: they
      // already told us this number by typing it.
      res.json({ status: true, message: 'Mobile number is already verified.' });
      return;
    }

    const storedHash = user['phone_code_hash'] as string | undefined;
    const expires = user['phone_code_expires'] as Date | undefined;
    if (!storedHash || !expires || expires.getTime() < Date.now()) throw invalid();

    if (Number(user['phone_code_attempts'] ?? 0) >= s.PHONE_OTP_MAX_ATTEMPTS) {
      throw new HttpError(429, 'Too many incorrect codes. Request a new one.');
    }

    if (!digestsEqual(storedHash, hashEmailOtp(payload.code))) {
      // Counted in the database so the cap holds across workers and restarts.
      await usersCollection().updateOne(
        { _id: user['_id'] as ObjectId },
        { $inc: { phone_code_attempts: 1 } },
      );
      throw invalid();
    }

    await usersCollection().updateOne(
      { _id: user['_id'] as ObjectId },
      verification.markPhoneVerifiedUpdate(),
    );
    res.json({ status: true, message: 'Mobile number verified.' });
  }),
);

authRouter.post(
  '/verify-phone/resend',
  ratelimit.byIp('verify_phone_send_ip'),
  asyncHandler(async (req: Request, res) => {
    const s = getSettings();
    const payload = ResendPhoneCodeRequest.parse(req.body);
    await ratelimit.enforce('verify_phone_send_number', payload.mobile);

    // Same response in every branch below — it reveals nothing about which
    // numbers have accounts.
    const response: Record<string, unknown> = {
      status: true,
      message: 'If that number needs verifying, a code has been sent.',
    };

    // Not an SMS country (or SMS is switched off): a text would cost money and
    // prove nothing, because that account verifies by email instead.
    if (verification.channelFor(payload.mobile) !== verification.CHANNEL_SMS) {
      res.json(response);
      return;
    }

    const user = await usersCollection().findOne(
      { phone: payload.mobile },
      { sort: { created_at: -1 } },
    );

    if (user && user['phone_verified']) {
      // Say so, rather than answering "a code has been sent" and sending nothing.
      // There is no secret left to keep: register already refuses a taken number
      // with a 409, so staying quiet here discloses nothing extra — it only
      // leaves somebody on the signup form waiting for a message that was never
      // going to arrive.
      throw new HttpError(
        409,
        'This mobile number is already registered and verified. Please log in instead.',
      );
    }

    const code = user
      ? await verification.issuePhoneCode(user['_id'] as ObjectId)
      : await verification.issuePendingPhoneCode(payload.mobile);

    void sendPhoneVerification(payload.mobile, code);
    if (s.isDev) response['phone_code'] = code;

    logger.info('issued a phone verification code for %s', payload.mobile);
    res.json(response);
  }),
);
