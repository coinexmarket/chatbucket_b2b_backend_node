/**
 * The small public routers: pricing, demo requests, subscriptions.
 *
 * Ported from `app/routers/pricing.py`, `demo.py` and `subscriptions.py`. Kept
 * together because each is a single endpoint; splitting them into three files
 * would be more ceremony than code.
 */
import { Router, type Request } from 'express';
import { MongoServerError } from 'mongodb';
import { z } from 'zod';

import { demoRequestsCollection, subscriptionsCollection } from '../database.js';
import { asyncHandler } from '../errors.js';
import * as ratelimit from '../middleware/ratelimit.js';
import { rateCard } from '../pricing.js';
import {
  sendContactReceived,
  sendDemoRequestNotification,
  sendSubscriptionConfirmation,
} from '../services/email.js';
import { email } from '../schemas/auth.js';

// --- Pricing ----------------------------------------------------------------

export const pricingRouter = Router();

/** The public rate card. */
pricingRouter.get('', (_req, res) => {
  res.json({ status: true, currency: 'INR', data: rateCard() });
});

// --- Demo requests ----------------------------------------------------------

export const demoRouter = Router();

/**
 * The "Let's get your demo started" modal, which has a Personal/Business
 * toggle. Both tabs share name/email/mobile and the consent checkbox; each adds
 * its own fields.
 *
 * A discriminated union on `type`, so "company_name is required, but only for
 * business" is enforced — a single flat model with everything optional would
 * accept a business lead with no company on it, which sales cannot act on.
 */
const DemoBase = {
  name: z.string().min(1).max(120),
  email,
  marketing_consent: z.boolean().default(false),
};

const DemoRequestBody = z.discriminatedUnion('type', [
  z
    .object({
      ...DemoBase,
      type: z.literal('personal'),
      // The Personal tab does not ask for a phone number, so requiring one here
      // would reject every lead the form can actually produce.
      mobile: z.string().max(32).nullish(),
      how_did_you_hear: z.string().max(2000).nullish(),
    })
    .strict(),
  z
    .object({
      ...DemoBase,
      type: z.literal('business'),
      // Required here: sales calls business leads, and the Business tab asks.
      mobile: z.string().min(4).max(32),
      company_name: z.string().min(1).max(200),
      company_details: z.string().max(2000).nullish(),
    })
    .strict(),
]);

demoRouter.post(
  '',
  // Public and unauthenticated, so it is a spam target — and it sends mail.
  ratelimit.byIp('demo_ip'),
  asyncHandler(async (req: Request, res) => {
    const payload = DemoRequestBody.parse(req.body);

    const document: Record<string, unknown> = { ...payload };
    document['name'] = payload.name.trim();
    for (const field of ['mobile', 'company_name', 'company_details', 'how_did_you_hear']) {
      const value = document[field];
      if (typeof value === 'string') document[field] = value.trim() || null;
    }
    document['status'] = 'new'; // for whoever works the lead queue
    document['created_at'] = new Date();

    // Duplicates are accepted on purpose: someone asking for a second demo
    // months later is a lead, not a mistake, so de-duplication belongs in
    // whatever CRM consumes these rather than in a 409 that loses the request.
    const result = await demoRequestsCollection().insertOne(document);

    // Notify sales *and* acknowledge to the person who wrote in, both after the
    // response: the lead is already safely stored, so a mail outage must not
    // fail the submission and lose it. The lead id doubles as the query id the
    // acknowledgement tells them to quote.
    const lead = { ...document, _id: result.insertedId };
    void sendDemoRequestNotification(lead);
    void sendContactReceived(lead);

    res.status(201).json({
      status: true,
      message: "Thanks — we'll be in touch to schedule your demo.",
      data: {
        id: String(result.insertedId),
        type: payload.type,
        created_at: (document['created_at'] as Date).toISOString(),
      },
    });
  }),
);

// --- Subscriptions ----------------------------------------------------------

export const subscriptionsRouter = Router();

const SubscriptionRequest = z
  .object({ email })
  .strict();

/**
 * App-launch notification signup.
 *
 * The error contract here differs from every other route on purpose — it is
 * what the existing frontend branches on: success is any 2xx, a duplicate is a
 * non-ok status carrying `{ err_code: 409, error: "<message>" }`. Changing it to
 * match the rest of the API would silently break the NotifyMe button.
 */
subscriptionsRouter.post(
  '/v1/notify-app-launch',
  asyncHandler(async (req: Request, res) => {
    const payload = SubscriptionRequest.parse(req.body);
    const duplicate = { err_code: 409, error: 'You have already subscribed.' };

    // Guard against duplicates even without a unique index present.
    if (await subscriptionsCollection().findOne({ email: payload.email })) {
      res.status(409).json(duplicate);
      return;
    }

    try {
      await subscriptionsCollection().insertOne({
        email: payload.email,
        source: 'notify-app-launch',
        subscribedAt: new Date().toISOString(),
      });
    } catch (err) {
      if (err instanceof MongoServerError && err.code === 11000) {
        res.status(409).json(duplicate);
        return;
      }
      throw err;
    }

    // Only on a genuinely new subscription — the duplicate paths above return
    // before this, so re-submitting the form does not re-send the confirmation.
    void sendSubscriptionConfirmation(payload.email);

    res.status(201).json({
      status: true,
      status_code: 201,
      message: 'Subscribed successfully.',
    });
  }),
);
