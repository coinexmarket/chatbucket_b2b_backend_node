/**
 * Billing: balance, ledger, payments, invoices, top-ups.
 *
 * Ported from `app/routers/billing.py`.
 *
 * The rule that shapes this file: **credits are granted in exactly one place**
 * (`settle`), and every route that can confirm a payment funnels there *after*
 * verifying its caller. Gateways redeliver webhooks and a customer can hit the
 * callback while a webhook is in flight, so settlement claims the order with a
 * conditional update — only the first arrival credits the account, the rest read
 * as replays. Crediting the same money twice is the failure this exists to
 * prevent.
 */
import crypto from 'node:crypto';

import { Router, type Request } from 'express';
import { MongoServerError, ObjectId } from 'mongodb';
import { z } from 'zod';

import { getSettings } from '../config.js';
import {
  creditAccountsCollection,
  creditLedgerCollection,
  invoicesCollection,
  paymentsCollection,
  usersCollection,
} from '../database.js';
import { HttpError, asyncHandler } from '../errors.js';
import { logger } from '../logger.js';
import { requireUser, type AuthedRequest } from '../middleware/auth.js';
import { toBson, toChargeable, toDecimal, toJson, type AmountLike } from '../money.js';
import { PURCHASABLE, getPlan } from '../plans.js';
import { toIso } from '../serialization.js';
import * as credits from '../services/credits.js';
import * as invoices from '../services/invoices.js';

export const billingRouter = Router();

// --- Views ------------------------------------------------------------------

function accountView(
  account: Record<string, unknown>,
  planKey: string | null | undefined,
): Record<string, unknown> {
  const plan = getPlan(planKey);
  const balance = Number(account['balance_units'] ?? 0);
  const purchased = Number(account['lifetime_purchased_units'] ?? 0);
  const auto = (account['auto_recharge'] ?? {}) as Record<string, unknown>;

  return {
    plan: plan.key,
    plan_label: plan.label,
    currency: 'INR',
    credits: credits.fromUnits(balance).toNumber(),
    lifetime_purchased_credits: credits.fromUnits(purchased).toNumber(),
    // The progress bar reads "x of y used": y is everything ever bought, which
    // is the only total that does not shrink as credits are spent.
    credits_used: credits.fromUnits(Math.max(purchased - balance, 0)).toNumber(),
    auto_recharge: {
      enabled: Boolean(auto['enabled']),
      threshold_credits: auto['threshold_credits'] ?? null,
      amount_inr: auto['amount_inr'] ?? null,
    },
  };
}

/** Render a ledger entry for the billing history table. */
function ledgerView(entry: Record<string, unknown>): Record<string, unknown> {
  return {
    id: String(entry['_id']),
    kind: entry['kind'] ?? null,
    credits: credits.fromUnits(Number(entry['units'] ?? 0)).toNumber(),
    balance_after: credits.fromUnits(Number(entry['balance_after_units'] ?? 0)).toNumber(),
    description: entry['description'] ?? null,
    ref: entry['ref'] != null ? String(entry['ref']) : null,
    created_at: toIso(entry['created_at']),
  };
}

function paymentView(doc: Record<string, unknown>): Record<string, unknown> {
  return {
    id: String(doc['_id']),
    amount: toJson((doc['amount_inr'] ?? 0) as AmountLike),
    currency: doc['currency'] ?? 'INR',
    credits: credits.fromUnits(Number(doc['credit_units'] ?? 0)).toNumber(),
    plan: doc['plan'] ?? null,
    status: doc['status'] ?? null,
    method: doc['method'] ?? null,
    // Populated once the payment is confirmed; this is what the billing
    // history's "Invoice" column shows.
    invoice_number: doc['invoice_number'] ?? null,
    provider_order_id: doc['provider_order_id'] ?? null,
    created_at: toIso(doc['created_at']),
    paid_at: doc['paid_at'] ? toIso(doc['paid_at']) : null,
  };
}

// --- Read endpoints ---------------------------------------------------------

billingRouter.get(
  '',
  requireUser,
  asyncHandler(async (req: Request, res) => {
    const user = (req as AuthedRequest).user;
    const account = await credits.getAccount(user['_id'] as ObjectId);
    res.json({ status: true, data: accountView(account, user['plan'] as string) });
  }),
);

billingRouter.get(
  '/history',
  requireUser,
  asyncHandler(async (req: Request, res) => {
    const user = (req as AuthedRequest).user;
    const limit = Math.min(500, Math.max(1, Number(req.query['limit'] ?? 50)));

    const query: Record<string, unknown> = { user_id: user['_id'] };
    if (req.query['kind']) query['kind'] = String(req.query['kind']);

    const entries = await creditLedgerCollection()
      .find(query)
      .sort({ created_at: -1 })
      .limit(limit)
      .toArray();

    res.json({ status: true, count: entries.length, data: entries.map(ledgerView) });
  }),
);

billingRouter.get(
  '/payments',
  requireUser,
  asyncHandler(async (req: Request, res) => {
    const user = (req as AuthedRequest).user;
    const limit = Math.min(500, Math.max(1, Number(req.query['limit'] ?? 50)));
    const docs = await paymentsCollection()
      .find({ user_id: user['_id'] })
      .sort({ created_at: -1 })
      .limit(limit)
      .toArray();
    res.json({ status: true, count: docs.length, data: docs.map(paymentView) });
  }),
);

const BillingDetailsRequest = z
  .object({
    legal_name: z.string().max(200).nullish(),
    gstin: z.string().max(20).nullish(),
    address_line1: z.string().max(200).nullish(),
    address_line2: z.string().max(200).nullish(),
    city: z.string().max(100).nullish(),
    state: z.string().max(100).nullish(),
    postal_code: z.string().max(20).nullish(),
    country: z.string().max(100).nullish(),
  })
  .strict();

billingRouter.get(
  '/details',
  requireUser,
  asyncHandler(async (req: Request, res) => {
    // The customer's invoicing identity, or null if never filled in.
    res.json({ status: true, data: (req as AuthedRequest).user['billing_details'] ?? null });
  }),
);

billingRouter.put(
  '/details',
  requireUser,
  asyncHandler(async (req: Request, res) => {
    const user = (req as AuthedRequest).user;
    const details = BillingDetailsRequest.parse(req.body);
    // Editing these never alters an invoice already issued: each one carries
    // its own snapshot, so history stays a record of what was true at the time.
    await usersCollection().updateOne(
      { _id: user['_id'] as ObjectId },
      { $set: { billing_details: details, updated_at: new Date() } },
    );
    res.json({ status: true, message: 'Billing details saved.', data: details });
  }),
);

billingRouter.get(
  '/invoices',
  requireUser,
  asyncHandler(async (req: Request, res) => {
    const user = (req as AuthedRequest).user;
    const limit = Math.min(500, Math.max(1, Number(req.query['limit'] ?? 50)));
    const docs = await invoicesCollection()
      .find({ user_id: user['_id'] })
      .sort({ issued_at: -1 })
      .limit(limit)
      .toArray();
    res.json({ status: true, count: docs.length, data: docs.map(invoices.serialize) });
  }),
);

billingRouter.get(
  '/invoices/:invoiceId',
  requireUser,
  asyncHandler(async (req: Request, res) => {
    const user = (req as AuthedRequest).user;
    const raw = String(req.params['invoiceId']);

    // By id or by invoice number: INV-0001 works in a URL just as well as the
    // raw ObjectId.
    const query: Record<string, unknown> = { user_id: user['_id'] };
    if (ObjectId.isValid(raw)) query['_id'] = new ObjectId(raw);
    else query['invoice_number'] = raw;

    const doc = await invoicesCollection().findOne(query);
    if (!doc) throw new HttpError(404, 'Invoice not found.');
    res.json({ status: true, data: invoices.serialize(doc) });
  }),
);

const AutoRechargeRequest = z
  .object({
    enabled: z.boolean(),
    threshold_credits: z.number().nonnegative().nullish(),
    amount_inr: z.number().positive().nullish(),
  })
  .strict();

billingRouter.put(
  '/auto-recharge',
  requireUser,
  asyncHandler(async (req: Request, res) => {
    const user = (req as AuthedRequest).user;
    const payload = AutoRechargeRequest.parse(req.body);

    // The settings are recorded and reported, but nothing triggers on them yet:
    // charging a customer unattended needs a saved payment method held by the
    // gateway, which this service does not have. `GET /billing` reports exactly
    // what was stored, so the dashboard never claims a recharge will happen.
    await credits.getAccount(user['_id'] as ObjectId);
    await creditAccountsCollection().updateOne(
      { user_id: user['_id'] },
      {
        $set: {
          auto_recharge: {
            enabled: payload.enabled,
            threshold_credits: payload.threshold_credits ?? null,
            amount_inr: payload.amount_inr ?? null,
          },
          updated_at: new Date(),
        },
      },
    );
    const account = await credits.getAccount(user['_id'] as ObjectId);
    res.json({
      status: true,
      message: 'Auto-recharge settings saved. Automatic charging is not active yet.',
      data: accountView(account, user['plan'] as string),
    });
  }),
);

// --- Top-up -----------------------------------------------------------------

const TopUpRequest = z
  .object({
    plan: z.string().max(50).nullish(),
    amount_inr: z.number().positive().nullish(),
  })
  .strict()
  .refine((v) => Boolean(v.plan) !== (v.amount_inr != null), {
    message: 'Send either `plan` or `amount_inr`, not both.',
  });

billingRouter.post(
  '/top-up',
  requireUser,
  asyncHandler(async (req: Request, res) => {
    const user = (req as AuthedRequest).user;
    const payload = TopUpRequest.parse(req.body);

    let amount;
    let creditUnits: number;
    let planAfter: string | null;
    let description: string;

    if (payload.plan) {
      const key = payload.plan.toLowerCase().trim();
      if (!PURCHASABLE.includes(key)) {
        throw new HttpError(
          400,
          `Plan '${payload.plan}' cannot be purchased. Valid: ${PURCHASABLE.join(', ')}`,
        );
      }
      const plan = getPlan(key);
      amount = plan.priceInr;
      creditUnits = credits.toUnits(plan.creditsGranted);
      planAfter = plan.key;
      description = `${plan.label} pack`;
    } else {
      // Custom amount: 1 credit per rupee, no bonus, no tier change.
      amount = toDecimal(payload.amount_inr as number);
      creditUnits = credits.toUnits(amount);
      planAfter = null;
      description = 'Credit top-up';
    }

    // Rounded to whole paise: a gateway can only charge integer minor units, so
    // an amount it cannot charge exactly must not be the amount we record.
    amount = toChargeable(amount);

    const document: Record<string, unknown> = {
      user_id: user['_id'],
      amount_inr: toBson(amount),
      currency: 'INR',
      credit_units: creditUnits,
      plan: planAfter,
      description,
      status: 'pending',
      // Handed to the gateway as its idempotency/reference key.
      reference: `cb_top_${crypto.randomBytes(9).toString('base64url')}`,
      created_at: new Date(),
    };
    const result = await paymentsCollection().insertOne(document);
    document['_id'] = result.insertedId;

    // No credits are granted here. The order is what the frontend hands to the
    // gateway; credits appear only when the gateway confirms payment.
    res.status(201).json({
      status: true,
      message: 'Top-up created. Complete payment to receive credits.',
      data: { ...paymentView(document), reference: document['reference'] },
      // The gateway order is created by the Python service's Razorpay
      // integration, which is not yet ported — see the README. Until then this
      // is null and the local pending record is the whole result.
      checkout: null,
    });
  }),
);

// --- Settlement -------------------------------------------------------------

interface SettleArgs {
  providerPaymentId: string | null;
  method?: string | null;
  providerInvoiceId?: string | null;
  providerInvoiceUrl?: string | null;
}

/**
 * Mark a payment paid, grant its credits, upgrade the plan, invoice it.
 *
 * The single settlement path. Every route that can confirm a payment funnels
 * here **after** verifying its caller, so there is one place where credits are
 * granted and one place to reason about double-crediting.
 */
async function settle(oid: ObjectId, args: SettleArgs): Promise<Record<string, unknown>> {
  let claimed;
  try {
    // Claim the order with a conditional update so only the first arrival
    // credits the account; the rest read as replays.
    claimed = await paymentsCollection().findOneAndUpdate(
      { _id: oid, status: 'pending' },
      {
        $set: {
          status: 'paid',
          provider_payment_id: args.providerPaymentId,
          method: args.method ?? null,
          provider_invoice_id: args.providerInvoiceId ?? null,
          provider_invoice_url: args.providerInvoiceUrl ?? null,
          paid_at: new Date(),
        },
      },
      { returnDocument: 'after' },
    );
  } catch (err) {
    if (err instanceof MongoServerError && err.code === 11000) {
      // `provider_payment_id` is uniquely indexed, so this is one gateway
      // payment being used to settle a second order. Refusing is the whole
      // point of that index — never credit the same money twice.
      logger.error(
        'gateway payment %s already settled another order; refusing %s',
        String(args.providerPaymentId),
        String(oid),
      );
      throw new HttpError(
        409,
        'That gateway payment has already been applied to another order.',
      );
    }
    throw err;
  }

  if (!claimed) {
    const current = await paymentsCollection().findOne({ _id: oid });
    return {
      status: true,
      replayed: true,
      message: `Payment already ${current?.['status']}.`,
      data: paymentView(current ?? {}),
    };
  }

  await credits.grant(
    claimed['user_id'] as ObjectId,
    Number(claimed['credit_units']),
    credits.KIND_PURCHASE,
    String(claimed['description'] ?? 'Credit top-up'),
    claimed['_id'],
  );

  // A pack purchase also moves the account onto that tier's limits.
  if (claimed['plan']) {
    await usersCollection().updateOne(
      { _id: claimed['user_id'] as ObjectId },
      { $set: { plan: claimed['plan'], updated_at: new Date() } },
    );
  }

  // Issue the invoice last. It runs inside the claimed branch, so a redelivered
  // webhook never produces a second one, and it cannot fail the confirmation —
  // the money has already moved.
  const owner = await usersCollection().findOne({ _id: claimed['user_id'] as ObjectId });
  const invoice = await invoices.issueForPayment(claimed, owner ?? {});
  if (invoice) {
    await paymentsCollection().updateOne(
      { _id: claimed['_id'] as ObjectId },
      { $set: { invoice_number: invoice['invoice_number'] } },
    );
    claimed['invoice_number'] = invoice['invoice_number'];
  }

  return {
    status: true,
    replayed: false,
    message: 'Payment confirmed and credits added.',
    data: paymentView(claimed),
    invoice: invoice ? invoices.serialize(invoice) : null,
  };
}

const PaymentConfirmation = z
  .object({
    provider_payment_id: z.string().max(200).nullish(),
    method: z.string().max(50).nullish(),
    provider_invoice_id: z.string().max(200).nullish(),
    provider_invoice_url: z.string().max(500).nullish(),
  })
  .strict();

/**
 * Gateway webhook: mark a top-up paid and grant its credits.
 *
 * Guarded by a shared secret rather than a user session, because the caller is
 * the payment provider, not the customer. **Fails closed** when no secret is
 * configured — an unset secret must not mean "anyone may grant credits".
 */
billingRouter.post(
  '/payments/:paymentId/confirm',
  asyncHandler(async (req: Request, res) => {
    const s = getSettings();
    if (!s.BILLING_WEBHOOK_SECRET) {
      throw new HttpError(
        503,
        'Billing webhook is not configured (BILLING_WEBHOOK_SECRET unset).',
      );
    }
    const supplied = req.get('X-Billing-Secret') ?? '';
    // Constant-time compare: a plain `!==` leaks the secret one character at a
    // time to anyone who can measure the response.
    const expected = s.BILLING_WEBHOOK_SECRET;
    const ok =
      supplied.length === expected.length &&
      crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
    if (!ok) throw new HttpError(401, 'Invalid billing secret.');

    const raw = String(req.params['paymentId']);
    if (!ObjectId.isValid(raw)) throw new HttpError(404, 'Payment not found.');
    const oid = new ObjectId(raw);

    const payment = await paymentsCollection().findOne({ _id: oid });
    if (!payment) throw new HttpError(404, 'Payment not found.');

    const payload = PaymentConfirmation.parse(req.body ?? {});
    res.json(
      await settle(oid, {
        providerPaymentId: payload.provider_payment_id ?? null,
        method: payload.method,
        providerInvoiceId: payload.provider_invoice_id,
        providerInvoiceUrl: payload.provider_invoice_url,
      }),
    );
  }),
);
