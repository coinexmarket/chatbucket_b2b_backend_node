/**
 * Hackathon contest registration + verification.
 *
 * Ported from `app/routers/contest.py`, which is itself a port of the Next.js
 * `/api/register` and `/api/verify` routes. These write to a *separate*
 * database (`ChatBucketHackathon`) and the `contest_registrations` collection,
 * matching the data the current site already stores.
 *
 * Response shapes are kept byte-for-byte compatible with the frontend:
 *   register -> { success, data: { referenceNumber, insertedId } }
 *   verify   -> { valid, name?, isWinner? }
 */
import crypto from 'node:crypto';

import { Router, type Request } from 'express';
import { z } from 'zod';

import { contestRegistrationsCollection } from '../database.js';
import { asyncHandler } from '../errors.js';
import * as ratelimit from '../middleware/ratelimit.js';
import { email } from '../schemas/auth.js';

export const contestRouter = Router();

const REF_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

/** Mirrors the JS: 'WX-' plus 6 uppercase base36-ish characters. */
function referenceNumber(): string {
  const bytes = crypto.randomBytes(6);
  const suffix = Array.from(bytes, (b) => REF_ALPHABET[b % REF_ALPHABET.length]).join('');
  return `WX-${suffix}`;
}

/** Matches the register form's formData exactly. */
const ContestRegistrationRequest = z
  .object({
    fullName: z.string().min(1),
    email,
    mobileNumber: z.string().min(1),
    course: z.string().default(''),
    useTranslationApp: z.string().default(''),
    dailyFeature: z.string().default(''),
    b2bIndustry: z.string().default(''),
    consent: z.boolean().default(false),
  })
  .strict();

contestRouter.post(
  '/register',
  ratelimit.byIp('contest_ip'),
  asyncHandler(async (req: Request, res) => {
    const payload = ContestRegistrationRequest.parse(req.body);
    const reference = referenceNumber();

    const result = await contestRegistrationsCollection().insertOne({
      ...payload,
      referenceNumber: reference,
      registeredAt: new Date().toISOString(),
    });

    res.status(200).json({
      success: true,
      data: { insertedId: String(result.insertedId), referenceNumber: reference },
    });
  }),
);

/**
 * Verify a badge id of the form `CB-HACK-2026-XXXXXX`, where the last part is
 * the first 6 characters of the reference number.
 *
 * Scanned from a printed badge, so it answers `{valid: false}` with a 200 for
 * anything it cannot match: a scanner showing an HTTP error tells the person
 * holding the badge nothing useful.
 */
contestRouter.get(
  '/verify',
  asyncHandler(async (req: Request, res) => {
    const raw = String(req.query['id'] ?? '').trim();
    if (!raw) {
      res.status(400).json({ valid: false, error: 'Missing ID' });
      return;
    }

    const parts = raw.toUpperCase().split('-');
    if (parts.length < 4) {
      res.status(200).json({ valid: false });
      return;
    }
    const shortId = parts.slice(3).join('-');

    // Matched in the app rather than in a query: the stored reference is the
    // full value and only its first 6 characters are on the badge, so there is
    // no index-friendly predicate for it. The collection is small enough (one
    // event's registrations) that a scan is the honest trade.
    const cursor = contestRegistrationsCollection().find(
      {},
      { projection: { fullName: 1, referenceNumber: 1, _id: 1, isWinner: 1 } },
    );

    for await (const entry of cursor) {
      const ref = String(entry['referenceNumber'] ?? entry['_id'] ?? '1109');
      if (ref.slice(0, 6).toUpperCase() === shortId) {
        res.status(200).json({
          valid: true,
          name: entry['fullName'] ?? 'Hackathon Participant',
          isWinner: Boolean(entry['isWinner']),
        });
        return;
      }
    }

    res.status(200).json({ valid: false });
  }),
);
