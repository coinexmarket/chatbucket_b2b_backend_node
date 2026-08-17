/**
 * Profile: view, update details, change password. Requires a Bearer JWT.
 *
 * Ported from `app/routers/profile.py`.
 */
import { Router, type Request } from 'express';
import type { ObjectId } from 'mongodb';

import { usersCollection } from '../database.js';
import { HttpError, asyncHandler } from '../errors.js';
import { requireUser, type AuthedRequest } from '../middleware/auth.js';
import { ChangePasswordRequest, ProfileUpdateRequest } from '../schemas/auth.js';
import {
  createAccessTokenForUser,
  hashPassword,
  verifyPassword,
} from '../security.js';
import { publicUser } from '../serialization.js';
import * as sessions from '../services/sessions.js';

export const profileRouter = Router();
profileRouter.use(requireUser);

profileRouter.get(
  '',
  asyncHandler(async (req: Request, res) => {
    res.json({ status: true, data: publicUser((req as AuthedRequest).user) });
  }),
);

profileRouter.put(
  '',
  asyncHandler(async (req: Request, res) => {
    const user = (req as AuthedRequest).user;
    const payload = ProfileUpdateRequest.parse(req.body);

    const updates: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(payload)) {
      if (v !== undefined) updates[k] = v;
    }
    if (Object.keys(updates).length === 0) {
      throw new HttpError(400, 'No fields to update.');
    }
    updates['updated_at'] = new Date();

    // Moving to a different number un-proves it. Without this, someone could
    // verify one mobile and then swap in another, and the account would still
    // read as phone-verified for a number nobody confirmed. Not applied when
    // the number is unchanged, so re-saving the same profile does not cost the
    // customer their verification.
    const unset: Record<string, string> =
      'phone' in updates && updates['phone'] !== user['phone']
        ? {
            phone_verified: '',
            phone_verified_at: '',
            phone_code_hash: '',
            phone_code_expires: '',
            phone_code_attempts: '',
          }
        : {};

    await usersCollection().updateOne(
      { _id: user['_id'] as ObjectId },
      Object.keys(unset).length > 0
        ? { $set: updates, $unset: unset }
        : { $set: updates },
    );
    const fresh = await usersCollection().findOne({ _id: user['_id'] as ObjectId });
    res.json({ status: true, data: publicUser(fresh ?? {}) });
  }),
);

profileRouter.put(
  '/password',
  asyncHandler(async (req: Request, res) => {
    const user = (req as AuthedRequest).user;
    const payload = ChangePasswordRequest.parse(req.body);

    const ok = await verifyPassword(
      payload.currentPassword,
      String(user['password_hash'] ?? ''),
    );
    if (!ok) throw new HttpError(400, 'Current password is incorrect.');

    await usersCollection().updateOne(
      { _id: user['_id'] as ObjectId },
      {
        $set: {
          password_hash: await hashPassword(payload.newPassword),
          updated_at: new Date(),
        },
        // Sign out every other session holding an older token.
        $inc: { token_version: 1 },
      },
    );

    // Refresh tokens survive a `token_version` bump, so revoke them too —
    // otherwise a stolen session could mint new access tokens indefinitely.
    await sessions.revokeAllForUser(user['_id'] as ObjectId, 'password_change');

    // The bump above also retires the caller's own token, so hand back a fresh
    // one — changing your password shouldn't log you out of the tab you're in.
    const fresh = await usersCollection().findOne({ _id: user['_id'] as ObjectId });
    res.json({
      status: true,
      message: 'Password updated. Other sessions have been signed out.',
      access_token: createAccessTokenForUser(fresh ?? {}),
    });
  }),
);
