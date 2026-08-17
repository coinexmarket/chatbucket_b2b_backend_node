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
import { DEFAULT_PLAN } from '../plans.js';
import {
  ForgotPasswordRequest,
  LoginRequest,
  LogoutRequest,
  RefreshRequest,
  RegisterRequest,
  ResendPhoneCodeRequest,
  ResetPasswordRequest,
  VerifyEmailOtpRequest,
  VerifyEmailRequest,
  VerifyPhoneRequest,
} from '../schemas/auth.js';
import {
  createAccessTokenForUser,
  digestsEqual,
  dummyPasswordHash,
  generateResetToken,
  hashEmailOtp,
  hashPassword,
  hashToken,
  verifyPassword,
} from '../security.js';
import { publicUser } from '../serialization.js';
import * as credits from '../services/credits.js';
import {
  sendEmailVerified,
  sendPasswordReset,
  sendVerificationEmail,
  sendWelcome,
} from '../services/email.js';
import * as sessions from '../services/sessions.js';
import { sendPhoneVerification } from '../services/sms.js';
import * as verification from '../services/verification.js';
import { requireUser, type AuthedRequest } from '../middleware/auth.js';

export const authRouter = Router();

const DUPLICATE_EMAIL = () =>
  new HttpError(409, 'An account with this email already exists.');

/**
 * A number identifies one account, so a taken one is a conflict rather than a
 * validation error — the value is well-formed, it just belongs to somebody.
 */
const DUPLICATE_PHONE = () =>
  new HttpError(409, 'An account with this mobile number already exists.');

/**
 * The token payload every authenticating route returns, shaped once.
 *
 * A refresh token comes with it so the dashboard can renew a 24h access token
 * instead of dumping the user back at the sign-in screen mid-session. `family`
 * chains a rotation to the original sign-in, so a later reuse can revoke the
 * whole family rather than one row.
 */
async function tokenResponse(user: Record<string, unknown>, family?: string) {
  const s = getSettings();
  const [refreshToken, refreshExpires] = await sessions.issue(
    user['_id'] as ObjectId,
    family,
  );
  return {
    status: true,
    access_token: createAccessTokenForUser(user),
    token_type: 'bearer',
    expires_in: s.ACCESS_TOKEN_EXPIRE_MINUTES * 60,
    refresh_token: refreshToken,
    refresh_expires_at: refreshExpires.toISOString(),
    data: publicUser(user),
    user: publicUser(user),
  };
}

/** Mongo stores UTC; treat a missing or past expiry as expired. */
function isLive(expires: unknown): boolean {
  return expires instanceof Date && expires.getTime() >= Date.now();
}

/**
 * Mark the address verified and tell the customer their account is open.
 *
 * The confirmation is queued after the response for the same reason every other
 * message is: verification should not wait on a mail server.
 */
async function confirmAndNotify(user: Record<string, unknown>): Promise<void> {
  await usersCollection().updateOne(
    { _id: user['_id'] as ObjectId },
    verification.markVerifiedUpdate(),
  );
  // State the balance they can now actually spend — until this moment the
  // signup credits were granted but unusable.
  let available: string | null = null;
  try {
    const balance = await credits.balanceOf(user['_id'] as ObjectId);
    available = balance.isInteger() ? balance.toFixed(0) : balance.toFixed(2);
  } catch (err) {
    logger.error(
      'could not read balance for %s: %s',
      String(user['_id']),
      err instanceof Error ? err.message : err,
    );
  }
  void sendEmailVerified(String(user['email']), user['name'] as string, available);
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
      const [token, code] = await verification.issueCredentials(insertedId);
      void sendVerificationEmail(payload.email, token, code, payload.name);
    }

    // Queued either way: a welcome email is worth sending, but not worth making
    // the customer wait on an SMTP round trip before their account appears.
    void sendWelcome(payload.email, payload.name, s.SIGNUP_BONUS_CREDITS || null);

    const body: Record<string, unknown> = {
      ...(await tokenResponse(document)),
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
    res.json(await tokenResponse(user));
  }),
);

// --- Password reset ---------------------------------------------------------

authRouter.post(
  '/forgot-password',
  ratelimit.byIp('forgot_ip'),
  asyncHandler(async (req: Request, res) => {
    const s = getSettings();
    const payload = ForgotPasswordRequest.parse(req.body);
    // Applied before the lookup, so the limit is identical whether or not the
    // account exists — one that only bit real accounts would leak which
    // addresses are registered.
    await ratelimit.enforce('forgot_email', payload.email);

    const user = await usersCollection().findOne({ email: payload.email });

    // Always the same response, so this cannot be used to discover addresses.
    const response: Record<string, unknown> = {
      status: true,
      message: 'If that email is registered, a reset link has been sent.',
    };

    if (user) {
      const [token, tokenHash] = generateResetToken();
      await usersCollection().updateOne(
        { _id: user['_id'] as ObjectId },
        {
          $set: {
            reset_token_hash: tokenHash,
            reset_token_expires: new Date(
              Date.now() + s.RESET_TOKEN_EXPIRE_MINUTES * 60_000,
            ),
          },
        },
      );
      // Not awaited: the response goes out first, so a registered address does
      // not take measurably longer than an unknown one. Awaiting the SMTP round
      // trip would undo the identical responses above and hand back a timing
      // oracle.
      void sendPasswordReset(String(user['email']), token, user['name'] as string);
      // Still returned in development, where the console backend means there is
      // no inbox to read the link out of.
      if (s.isDev) response['reset_token'] = token;
    }

    res.json(response);
  }),
);

authRouter.post(
  '/reset-password',
  asyncHandler(async (req: Request, res) => {
    const payload = ResetPasswordRequest.parse(req.body);
    const user = await usersCollection().findOne({
      reset_token_hash: hashToken(payload.token),
    });
    if (!user || !isLive(user['reset_token_expires'])) {
      throw new HttpError(400, 'Invalid or expired reset token.');
    }

    await usersCollection().updateOne(
      { _id: user['_id'] as ObjectId },
      {
        $set: {
          password_hash: await hashPassword(payload.newPassword),
          updated_at: new Date(),
        },
        // Retire every token issued before this reset. A reset is what you do
        // when the account is compromised, so leaving the attacker's existing
        // session alive would defeat the point.
        $inc: { token_version: 1 },
        $unset: { reset_token_hash: '', reset_token_expires: '' },
      },
    );
    // `token_version` only retires access tokens; without this the attacker's
    // refresh token would still mint new ones.
    await sessions.revokeAllForUser(user['_id'] as ObjectId, 'password_reset');

    res.json({ status: true, message: 'Password has been reset.' });
  }),
);

// --- Email verification -----------------------------------------------------

authRouter.post(
  '/verify-email',
  asyncHandler(async (req: Request, res) => {
    const payload = VerifyEmailRequest.parse(req.body);
    const user = await usersCollection().findOne({
      verification_token_hash: hashToken(payload.token),
    });
    if (!user || !isLive(user['verification_token_expires'])) {
      throw new HttpError(400, 'Invalid or expired verification link.');
    }
    await confirmAndNotify(user);
    res.json({ status: true, message: 'Email verified.' });
  }),
);

authRouter.post(
  '/verify-email/otp',
  ratelimit.byIp('verify_otp_ip'),
  asyncHandler(async (req: Request, res) => {
    const s = getSettings();
    const payload = VerifyEmailOtpRequest.parse(req.body);
    // Per address as well as per IP: a per-IP cap alone lets a spread-out
    // attacker work through one account's million codes.
    await ratelimit.enforce('verify_email_address', payload.email);

    const invalid = () => new HttpError(400, 'Invalid or expired verification code.');
    const user = await usersCollection().findOne({ email: payload.email });
    if (!user) throw invalid();
    if (user['email_verified']) {
      res.json({ status: true, message: 'Email is already verified.' });
      return;
    }

    const storedHash = user['verification_code_hash'] as string | undefined;
    if (!storedHash || !isLive(user['verification_code_expires'])) throw invalid();
    if (Number(user['verification_code_attempts'] ?? 0) >= s.EMAIL_OTP_MAX_ATTEMPTS) {
      throw new HttpError(429, 'Too many incorrect codes. Request a new one.');
    }
    if (!digestsEqual(storedHash, hashEmailOtp(payload.code))) {
      // Counted in the database, not in memory: the cap has to hold across
      // workers and restarts, and an in-process counter holds across neither.
      await usersCollection().updateOne(
        { _id: user['_id'] as ObjectId },
        { $inc: { verification_code_attempts: 1 } },
      );
      throw invalid();
    }

    await confirmAndNotify(user);
    res.json({ status: true, message: 'Email verified.' });
  }),
);

authRouter.post(
  '/verify-email/resend',
  requireUser,
  asyncHandler(async (req: Request, res) => {
    const s = getSettings();
    const user = (req as AuthedRequest).user;
    if (user['email_verified']) {
      res.json({ status: true, message: 'Email is already verified.' });
      return;
    }
    // Authenticated rather than taking an address, so it cannot be used to mail
    // an address the caller does not control.
    const [token, code] = await verification.issueCredentials(user['_id'] as ObjectId);
    void sendVerificationEmail(String(user['email']), token, code, user['name'] as string);

    const body: Record<string, unknown> = {
      status: true,
      message: 'Verification email sent.',
    };
    if (s.isDev) {
      body['verification_token'] = token;
      body['verification_code'] = code;
    }
    res.json(body);
  }),
);

// --- Sessions ---------------------------------------------------------------

authRouter.post(
  '/refresh',
  asyncHandler(async (req: Request, res) => {
    const payload = RefreshRequest.parse(req.body);
    // Rotated: the token presented is spent and a new one returned, so each has
    // exactly one valid use. Presenting a spent token means the value leaked,
    // and every session descended from that sign-in is revoked — see
    // `sessions.consume`.
    const record = await sessions.consume(payload.refreshToken);
    if (!record) {
      throw new HttpError(401, 'Refresh token is invalid, expired or already used.');
    }
    const user = await usersCollection().findOne({ _id: record['user_id'] as ObjectId });
    if (!user) throw new HttpError(401, 'User not found.');

    // Chained to the original sign-in so a later reuse can revoke the family.
    res.json(await tokenResponse(user, String(record['family'])));
  }),
);

authRouter.post(
  '/logout',
  requireUser,
  asyncHandler(async (req: Request, res) => {
    const payload = LogoutRequest.parse(req.body ?? {});
    const user = (req as AuthedRequest).user;

    if (payload.allSessions) {
      // Access tokens already issued are self-contained and stay valid until
      // they expire; bumping `token_version` retires those immediately, at the
      // cost of signing the caller out too.
      const revoked = await sessions.revokeAllForUser(user['_id'] as ObjectId);
      await usersCollection().updateOne(
        { _id: user['_id'] as ObjectId },
        { $inc: { token_version: 1 } },
      );
      res.json({
        status: true,
        message: 'Signed out of all sessions.',
        sessions_revoked: revoked,
      });
      return;
    }

    if (payload.refreshToken) await sessions.revokeOne(payload.refreshToken);
    res.json({ status: true, message: 'Signed out.', sessions_revoked: 1 });
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
