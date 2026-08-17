/**
 * Account export and closure.
 *
 * Ported from `app/routers/account.py`.
 *
 * **Deletion anonymises rather than erases.** Invoices, payments, usage and the
 * credit ledger are financial records that most jurisdictions require to be kept
 * for years, so they stay — with the personal data stripped out of the user
 * document they point at. Erasing them would destroy the accounting trail for
 * money that really did change hands, which is not a right-to-be-forgotten
 * request, it is a bookkeeping hole.
 *
 * What is removed or neutralised: name, email, phone, company, billing details,
 * how-they-heard, every API key (revoked, so nothing keeps working), and every
 * session (revoked, so nothing stays signed in).
 */
import crypto from 'node:crypto';

import { Router, type Request } from 'express';
import type { ObjectId } from 'mongodb';
import { z } from 'zod';

import {
  apiKeysCollection,
  creditAccountsCollection,
  creditLedgerCollection,
  invoicesCollection,
  paymentsCollection,
  projectsCollection,
  usageCollection,
  usersCollection,
} from '../database.js';
import { HttpError, asyncHandler } from '../errors.js';
import { requireUser, type AuthedRequest } from '../middleware/auth.js';
import { verifyPassword } from '../security.js';
import { jsonSafe, publicUser, toIso } from '../serialization.js';
import * as credits from '../services/credits.js';
import * as invoices from '../services/invoices.js';
import * as sessions from '../services/sessions.js';

export const accountRouter = Router();
accountRouter.use(requireUser);

/** Kept, but detached from any person. */
const RETAINED = ['invoices', 'payments', 'usage', 'credit_ledger'];

accountRouter.get(
  '/export',
  asyncHandler(async (req: Request, res) => {
    const user = (req as AuthedRequest).user;
    const userId = user['_id'] as ObjectId;

    // Deliberately unpaginated — an export that silently stopped at 50 records
    // would be worse than none. Large accounts should use GET /usage/export.csv
    // for the bulk of it; this is the personal-data view.
    const rows = (collection: ReturnType<typeof usageCollection>, sortField = 'created_at') =>
      collection.find({ user_id: userId }).sort({ [sortField]: -1 }).toArray();

    const account = await credits.getAccount(userId);

    res.json({
      status: true,
      exported_at: new Date().toISOString(),
      data: {
        profile: publicUser(user),
        credit_account: {
          balance: credits.fromUnits(Number(account['balance_units'] ?? 0)).toNumber(),
          auto_recharge: account['auto_recharge'] ?? null,
        },
        api_keys: (await rows(apiKeysCollection())).map((d) => ({
          // Masked: an export is a copy of your data, not a way to recover a
          // secret the service itself cannot recover.
          id: String(d['_id']),
          name: d['name'] ?? null,
          masked_key: `${d['key_prefix'] ?? 'cb_live'}_****${d['key_last4'] ?? ''}`,
          revoked: Boolean(d['revoked']),
          created_at: toIso(d['created_at']),
          last_used_at: toIso(d['last_used_at']),
        })),
        projects: (await rows(projectsCollection())).map(jsonSafe),
        usage: (await rows(usageCollection())).map(jsonSafe),
        credit_ledger: (await rows(creditLedgerCollection())).map((e) => ({
          id: String(e['_id']),
          kind: e['kind'] ?? null,
          credits: credits.fromUnits(Number(e['units'] ?? 0)).toNumber(),
          balance_after: credits
            .fromUnits(Number(e['balance_after_units'] ?? 0))
            .toNumber(),
          description: e['description'] ?? null,
          created_at: toIso(e['created_at']),
        })),
        payments: (await rows(paymentsCollection())).map(jsonSafe),
        invoices: (await rows(invoicesCollection(), 'issued_at')).map(invoices.serialize),
      },
    });
  }),
);

const DeleteAccountRequest = z.object({ password: z.string().min(1) }).strict();

/**
 * Close the account. Requires the current password.
 *
 * Password-confirmed because a stolen access token should not be enough to
 * destroy an account — this is the one action with no undo.
 *
 * `POST /account/delete` rather than `DELETE /account`: a request body is the
 * natural place for the password, and RFC 9110 gives DELETE bodies no defined
 * semantics — several HTTP clients refuse to send one and intermediaries may
 * drop it. A confirmation that silently vanishes in transit is worse than an
 * unfashionable verb.
 */
accountRouter.post(
  '/delete',
  asyncHandler(async (req: Request, res) => {
    const user = (req as AuthedRequest).user;
    const payload = DeleteAccountRequest.parse(req.body);

    const ok = await verifyPassword(payload.password, String(user['password_hash'] ?? ''));
    if (!ok) throw new HttpError(400, 'Password is incorrect.');

    const userId = user['_id'] as ObjectId;
    const now = new Date();

    const revokedKeys = await apiKeysCollection().updateMany(
      { user_id: userId, revoked: false },
      { $set: { revoked: true } },
    );
    const revokedSessions = await sessions.revokeAllForUser(userId, 'account_deleted');

    // A unique index sits on `email`, so it must be replaced rather than
    // cleared — and with something that can never be a real address, so the
    // freed-up original can be reused by a genuine future signup.
    const placeholder = `deleted+${crypto.randomBytes(8).toString('hex')}@deleted.invalid`;
    await usersCollection().updateOne(
      { _id: userId },
      {
        $set: {
          email: placeholder,
          name: 'Deleted account',
          deleted_at: now,
          updated_at: now,
          email_verified: false,
        },
        // Retire every token issued before closure.
        $inc: { token_version: 1 },
        $unset: {
          phone: '',
          phone_verified: '',
          company: '',
          how_did_you_hear: '',
          billing_details: '',
          reset_token_hash: '',
          reset_token_expires: '',
          verification_token_hash: '',
          verification_token_expires: '',
        },
      },
    );

    // The balance is zeroed but the ledger is not: the movements that produced
    // it are part of the financial record.
    await creditAccountsCollection().updateOne(
      { user_id: userId },
      { $set: { balance_units: 0, closed_at: now } },
    );

    res.json({
      status: true,
      message: 'Account closed. Financial records are retained as required.',
      api_keys_revoked: revokedKeys.modifiedCount,
      sessions_revoked: revokedSessions,
      retained: RETAINED,
    });
  }),
);
