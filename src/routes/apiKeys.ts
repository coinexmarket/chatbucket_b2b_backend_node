/**
 * API key management. Requires a Bearer JWT (dashboard).
 *
 * Ported from `app/routers/api_keys.py`. The plaintext key is returned exactly
 * once, at creation. Only its SHA-256 hash is stored; listings show a masked
 * `cb_live_****ABCD` form.
 */
import { Router, type Request } from 'express';
import { ObjectId } from 'mongodb';
import { z } from 'zod';

import { getSettings } from '../config.js';
import { apiKeysCollection } from '../database.js';
import { HttpError, asyncHandler } from '../errors.js';
import { requireApiKey, requireUser, type AuthedRequest } from '../middleware/auth.js';
import { getPlan } from '../plans.js';
import { generateApiKey } from '../security.js';
import { toIso } from '../serialization.js';
import * as credits from '../services/credits.js';
import * as verification from '../services/verification.js';
import { resolveProject } from './projects.js';

export const apiKeysRouter = Router();

const NOT_FOUND = () => new HttpError(404, 'Key not found.');

const ApiKeyCreateRequest = z
  .object({
    name: z.string().min(1).max(120),
    project_id: z.string().nullish(),
  })
  .strict();

const ApiKeyRenameRequest = z
  .object({
    name: z.string().min(1).max(120),
    project_id: z.string().nullish(),
  })
  .strict();

function mask(doc: Record<string, unknown>): Record<string, unknown> {
  return {
    id: String(doc['_id']),
    name: doc['name'] ?? null,
    masked_key: `${doc['key_prefix'] ?? 'cb_live'}_****${doc['key_last4'] ?? ''}`,
    project_id: doc['project_id'] ?? null,
    created_at: toIso(doc['created_at']),
    last_used_at: toIso(doc['last_used_at']),
    revoked: Boolean(doc['revoked']),
  };
}

/** A malformed id is indistinguishable from someone else's key here, and both
 *  should look the same to the caller. */
function keyOid(keyId: string): ObjectId {
  if (!ObjectId.isValid(keyId)) throw NOT_FOUND();
  return new ObjectId(keyId);
}

/**
 * Validate an `X-API-Key` and say whose it is. For our AI services.
 *
 * The STT/TTS/translation/voice services need to answer two questions before
 * doing any work: is this a real customer, and which one.
 *
 * Deliberately a **POST**: the key travels in a header either way, but a GET
 * invites caching by a proxy, and a cached "valid" answer would outlive a
 * revoked key.
 *
 * Returns the plan and remaining credits too, so a service can refuse work a
 * customer cannot pay for rather than doing it and discovering that at metering
 * time — the point at which refusing is too late to save the cost.
 *
 * Registered BEFORE `/:keyId`, or Express would match "verify" as an id.
 */
apiKeysRouter.post(
  '/verify',
  requireApiKey,
  asyncHandler(async (req: Request, res) => {
    const caller = (req as AuthedRequest).user;
    const balance = await credits.balanceOf(caller['_id'] as ObjectId);
    const plan = getPlan(caller['plan'] as string | undefined);

    // Answered fresh every time: a revoked key must stop working immediately,
    // which is the whole reason this is not a cacheable GET.
    res.setHeader('Cache-Control', 'no-store');

    res.json({
      status: true,
      data: {
        user_id: String(caller['_id']),
        api_key_id: (req as AuthedRequest).apiKeyId ?? null,
        project_id: (req as AuthedRequest).apiKeyProjectId ?? null,
        plan: plan.key,
        requests_per_minute: plan.requestsPerMinute,
        credits: balance.toNumber(),
        // False means the next metered call will 402. A service can stop here
        // instead of doing work it will not be paid for.
        has_credits: balance.greaterThan(0),
      },
    });
  }),
);

apiKeysRouter.post(
  '',
  requireUser,
  asyncHandler(async (req: Request, res) => {
    const user = (req as AuthedRequest).user;
    const payload = ApiKeyCreateRequest.parse(req.body);

    // An unverified address means nobody has proven they own it, so issuing a
    // live credential against it is a decision worth gating. Off by default:
    // switching it on would lock out every account created before verification
    // existed until they confirm.
    //
    // `verification.isVerified` checks whichever channel applies to this
    // account. Reading `email_verified` directly would permanently block an
    // Indian account, which is never sent an email code at all.
    if (getSettings().REQUIRE_EMAIL_VERIFICATION && !verification.isVerified(user)) {
      throw new HttpError(403, 'Verify your email address before creating API keys.');
    }

    const { full, prefix, hash, last4 } = generateApiKey();
    // Validated against the caller's own projects, so a guessed id cannot
    // attach this key to another customer's project.
    const projectId = await resolveProject(user, payload.project_id);

    const document: Record<string, unknown> = {
      user_id: user['_id'],
      name: payload.name.trim(),
      project_id: projectId,
      key_prefix: prefix,
      key_hash: hash,
      key_last4: last4,
      revoked: false,
      created_at: new Date(),
      last_used_at: null,
    };
    const result = await apiKeysCollection().insertOne(document);
    document['_id'] = result.insertedId;

    res.status(201).json({
      status: true,
      message: 'Store this key now — it will not be shown again.',
      api_key: full,
      data: mask(document),
    });
  }),
);

apiKeysRouter.get(
  '',
  requireUser,
  asyncHandler(async (req: Request, res) => {
    const user = (req as AuthedRequest).user;
    const limit = Math.min(200, Math.max(1, Number(req.query['limit'] ?? 50)));
    const offset = Math.max(0, Number(req.query['offset'] ?? 0));
    const includeRevoked = req.query['include_revoked'] !== 'false';

    // Paged rather than returning everything: an account that has rotated keys
    // for years would otherwise get the whole history in one response.
    const query: Record<string, unknown> = { user_id: user['_id'] };
    if (!includeRevoked) query['revoked'] = false;

    const total = await apiKeysCollection().countDocuments(query);
    const docs = await apiKeysCollection()
      .find(query)
      .sort({ created_at: -1 })
      .skip(offset)
      .limit(limit)
      .toArray();

    res.json({
      status: true,
      count: docs.length,
      total,
      limit,
      offset,
      data: docs.map(mask),
    });
  }),
);

apiKeysRouter.patch(
  '/:keyId',
  requireUser,
  asyncHandler(async (req: Request, res) => {
    const user = (req as AuthedRequest).user;
    const payload = ApiKeyRenameRequest.parse(req.body);

    // The secret itself is unchanged — this is only the label.
    const updates: Record<string, unknown> = { name: payload.name.trim() };
    if (payload.project_id !== undefined && payload.project_id !== null) {
      // "" means unassign; an id is validated as the caller's own.
      updates['project_id'] = await resolveProject(user, payload.project_id || null);
    }

    const doc = await apiKeysCollection().findOneAndUpdate(
      // Scoped to the caller's own keys, so a valid id belonging to another
      // customer is a 404 rather than a rename of their key.
      { _id: keyOid(String(req.params['keyId'])), user_id: user['_id'] },
      { $set: updates },
      { returnDocument: 'after' },
    );
    if (!doc) throw NOT_FOUND();
    res.json({ status: true, message: 'API key renamed.', data: mask(doc) });
  }),
);

apiKeysRouter.delete(
  '/:keyId',
  requireUser,
  asyncHandler(async (req: Request, res) => {
    const user = (req as AuthedRequest).user;
    const result = await apiKeysCollection().updateOne(
      { _id: keyOid(String(req.params['keyId'])), user_id: user['_id'] },
      { $set: { revoked: true } },
    );
    if (result.matchedCount === 0) throw NOT_FOUND();
    res.json({ status: true, message: 'API key revoked.' });
  }),
);
