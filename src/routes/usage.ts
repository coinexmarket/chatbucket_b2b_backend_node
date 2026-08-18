/**
 * Usage metering: pricing, recording, and the history the dashboard reads.
 *
 * Ported from `app/routers/usage.py`. `POST /usage` is the **billing write** —
 * the point at which a customer's credits are actually spent — so three
 * properties matter more than anything else here:
 *
 *   1. **A retry must not charge twice.** An `Idempotency-Key` plus a unique
 *      index means a replay returns the original record with 200, not a second
 *      charge.
 *   2. **The debit must be atomic.** `credits.tryDebit` is one conditional
 *      update; two concurrent calls cannot both spend a balance covering one.
 *   3. **Consumption is never lost.** The record is written *before* the debit
 *      and stays even when the customer cannot pay, flagged `billed: false`.
 *      The 402 tells the caller to stop serving them; the record is the
 *      evidence of what was consumed.
 */
import { Router, type Request, type Response } from 'express';
import { MongoServerError, ObjectId } from 'mongodb';
import { z } from 'zod';

import * as analytics from '../analytics.js';
import { getSettings } from '../config.js';
import { indexesReady, usageCollection } from '../database.js';
import { HttpError, asyncHandler } from '../errors.js';
import {
  requireMetering,
  requireUser,
  type AuthedRequest,
} from '../middleware/auth.js';
import * as ratelimit from '../middleware/ratelimit.js';
import { toBson, toJson, toDecimal, total as sumOf, type AmountLike } from '../money.js';
import { getPlan } from '../plans.js';
import {
  UnknownServiceError,
  calculateCost,
  calculateSplitCost,
  getService,
  normalizeModelKey,
  resolveRate,
  splitRates,
} from '../pricing.js';
import { toIso } from '../serialization.js';
import * as credits from '../services/credits.js';

export const usageRouter = Router();

/**
 * Fields of a priced record that carry money and must not become floats until
 * they reach JSON. Everything else is a label, a count or a unit.
 */
const MONEY_FIELDS = new Set(['rate', 'cost', 'input_rate', 'output_rate']);

/** The priced fields stored on every usage record, echoed back to the caller. */
const PRICED_FIELDS = [
  'service',
  'label',
  'unit',
  'quantity',
  'pricing',
  'input_quantity',
  'output_quantity',
  'input_rate',
  'output_rate',
  'rate',
  'unit_size',
  'cost',
  'currency',
] as const;

const UsageRequest = z
  .object({
    service: z.string().min(1),
    quantity: z.number().nonnegative().optional(),
    input_quantity: z.number().nonnegative().optional(),
    output_quantity: z.number().nonnegative().optional(),
    model: z.string().max(200).nullish(),
    engine: z.string().max(200).nullish(),
    engine_quantity: z.number().nonnegative().nullish(),
    provider: z.string().max(200).nullish(),
    metadata: z.record(z.unknown()).nullish(),
  })
  .strict()
  .refine((v) => v.quantity !== undefined || v.input_quantity !== undefined, {
    message: 'Send either `quantity` or `input_quantity`/`output_quantity`.',
  });
type UsageRequest = z.infer<typeof UsageRequest>;

/** The quantity that represents the whole call, split or not. */
function totalQuantity(p: UsageRequest): number {
  if (p.input_quantity !== undefined) {
    return p.input_quantity + (p.output_quantity ?? 0);
  }
  return p.quantity ?? 0;
}

/**
 * Price one reported consumption, flat or input/output split.
 *
 * The stored record carries whichever rates were actually applied, so history
 * stays auditable after a price change or a switch to split pricing.
 */
function price(payload: UsageRequest): Record<string, unknown> {
  let service;
  try {
    service = getService(payload.service);
  } catch (err) {
    if (err instanceof UnknownServiceError) throw new HttpError(400, err.message);
    throw err;
  }

  const base = {
    service: service.key,
    label: service.label,
    unit: service.unit,
    quantity: totalQuantity(payload),
    currency: 'INR',
  };

  if (payload.input_quantity !== undefined) {
    const rates = splitRates(payload.service, payload.model);
    if (!rates) {
      throw new HttpError(
        400,
        `Service '${service.key}' is not priced separately for input and output. ` +
          'Send `quantity` instead.',
      );
    }
    const [inputRate, outputRate, unitSize] = rates;
    return {
      ...base,
      pricing: 'split',
      input_quantity: payload.input_quantity,
      output_quantity: payload.output_quantity ?? 0,
      input_rate: inputRate,
      output_rate: outputRate,
      rate: null, // no single rate applies
      unit_size: unitSize,
      cost: calculateSplitCost(
        payload.service,
        payload.input_quantity,
        payload.output_quantity ?? 0,
        payload.model,
      ),
    };
  }

  // The model can carry its own price; `rate`/`unit_size` are the ones actually
  // charged, so the stored record shows what was billed rather than the service
  // default.
  const { rate, unitSize } = resolveRate(payload.service, payload.model);
  return {
    ...base,
    pricing: 'flat',
    input_quantity: null,
    output_quantity: null,
    input_rate: null,
    output_rate: null,
    rate,
    unit_size: unitSize,
    cost: calculateCost(payload.service, payload.quantity ?? 0, payload.model),
  };
}

/** Amounts -> number, at the response boundary. Null stays null. */
function forJson(priced: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(priced).map(([k, v]) => [
      k,
      MONEY_FIELDS.has(k) && v !== null && v !== undefined ? toJson(v as AmountLike) : v,
    ]),
  );
}

/** Amounts -> Decimal128, so Mongo stores and `$sum`s them exactly. */
function forBson(priced: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(priced).map(([k, v]) => [
      k,
      MONEY_FIELDS.has(k) && v !== null && v !== undefined ? toBson(v as AmountLike) : v,
    ]),
  );
}

/**
 * UTC now, truncated to milliseconds.
 *
 * BSON datetimes only hold milliseconds. Truncating up front keeps the timestamp
 * in the 201 equal to the one `GET /usage` and any replay read back, instead of
 * advertising precision the database never stored. (JS Date is already
 * millisecond-resolution, so this is a no-op here — kept as the named concept so
 * the two services stay legible side by side.)
 */
function utcNowMs(): Date {
  return new Date();
}

/**
 * Render a stored usage record.
 *
 * Built from the document rather than the freshly-priced values, so a replay
 * returns exactly what the first call stored even if the rate card has changed
 * since.
 */
function recorded(doc: Record<string, unknown>): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  for (const field of PRICED_FIELDS) {
    const value = doc[field];
    data[field] =
      MONEY_FIELDS.has(field) && value !== null && value !== undefined
        ? toJson(value as AmountLike)
        : (value ?? null);
  }
  return {
    id: String(doc['_id']),
    ...data,
    model: doc['model'] ?? null,
    // False means the consumption was recorded but the customer had no credits
    // for it — the caller needs to see that, not just the 402.
    billed: Boolean(doc['billed']),
    created_at: toIso(doc['created_at']),
  };
}

/**
 * Apply the caller's plan rate limit and set the `X-RateLimit-*` headers.
 *
 * Scoped to (account, service) rather than to the API key: every key on an
 * account shares one allowance, so minting extra keys cannot buy extra
 * throughput.
 */
async function enforcePlanLimit(
  user: Record<string, unknown>,
  service: string,
  res: Response,
): Promise<void> {
  if (!getSettings().ENFORCE_PLAN_RATE_LIMITS) return;
  const plan = getPlan(user['plan'] as string | undefined);
  const limit = { max: plan.requestsPerMinute, windowSeconds: 60 };
  const result = await ratelimit.enforceLimit('plan', `${user['_id']}:${service}`, limit);
  res.setHeader('X-RateLimit-Limit', String(limit.max));
  res.setHeader('X-RateLimit-Remaining', String(result.remaining));
  res.setHeader('X-RateLimit-Reset', String(result.retryAfter));
}

function findReplay(userId: unknown, idempotencyKey: string) {
  return usageCollection().findOne({ user_id: userId, idempotency_key: idempotencyKey });
}

/** Four decimal places, matching the precision quantities are stored at. */
function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

function chargeDescription(doc: Record<string, unknown>): string {
  return `${doc['label'] ?? doc['service']} usage`;
}

/**
 * Debit the cost from the owner's credits. Returns the new balance, or null.
 *
 * Null means the balance will not cover it. With enforcement disabled the
 * service meters without ever blocking, which is how it behaved before credits
 * existed — but it still debits, so balances and the ledger stay truthful.
 */
async function charge(
  doc: Record<string, unknown>,
  cost: AmountLike,
): Promise<number | null> {
  const units = credits.toUnits(cost);
  const userId = doc['user_id'] as ObjectId;
  const id = doc['_id'] as ObjectId;

  const entry = getSettings().ENFORCE_CREDIT_BALANCE
    ? await credits.tryDebit(userId, units, chargeDescription(doc), id)
    : await credits.debitAllowingNegative(userId, units, chargeDescription(doc), id);

  if (!entry) return null;

  await usageCollection().updateOne(
    { _id: id },
    { $set: { billed: true, ledger_id: entry['_id'] } },
  );
  doc['billed'] = true;
  return credits.fromUnits(Number(entry['balance_after_units'])).toNumber();
}

// --- Estimate ---------------------------------------------------------------

/**
 * The cost of a hypothetical usage. No auth, nothing stored.
 *
 * Takes `model` too, so an estimate matches what `POST /usage` will actually
 * charge when that model has its own price.
 */
usageRouter.post(
  '/estimate',
  asyncHandler(async (req: Request, res) => {
    res.json({ status: true, data: forJson(price(UsageRequest.parse(req.body))) });
  }),
);

// --- Record -----------------------------------------------------------------

usageRouter.post(
  '',
  requireMetering,
  asyncHandler(async (req: Request, res) => {
    const authed = req as AuthedRequest;
    const user = authed.user;
    const payload = UsageRequest.parse(req.body);
    const idempotencyKey = req.get('Idempotency-Key') ?? null;

    // The plan's advertised requests-per-minute, applied per service and shared
    // across the account's API keys. Checked before pricing so a throttled call
    // costs nothing.
    await enforcePlanLimit(user, payload.service, res);

    const priced = price(payload);
    const document: Record<string, unknown> = {
      user_id: user['_id'],
      api_key_id: authed.apiKeyId ?? null,
      project_id: authed.apiKeyProjectId ?? null,
      ...forBson(priced),
      // `model` is kept as the caller spelled it, for display; `model_key` is
      // the normalised value everything groups on, so "CB Paluku" and
      // "cb  paluku" are one row rather than two.
      model: payload.model ?? null,
      model_key: payload.model ? normalizeModelKey(payload.model) : null,
      // What the call cost *us* in engine capacity. Stored beside the billable
      // figures but never priced with them: this is COGS, and the customer
      // neither pays it nor sees it.
      engine: payload.engine ?? null,
      engine_quantity: payload.engine_quantity ?? null,
      // Which upstream served it, normalised for grouping so a differently-cased
      // name does not open a second row in the reconciliation.
      provider: payload.provider ?? null,
      provider_key: payload.provider ? payload.provider.toLowerCase() : null,
      metadata: payload.metadata ?? null,
      // Flipped to true once the credits are actually taken. Recorded up front
      // so usage is never lost just because it could not be paid for.
      billed: false,
      created_at: utcNowMs(),
    };

    if (idempotencyKey) {
      document['idempotency_key'] = idempotencyKey;
      // The unique index normally catches replays via a duplicate-key error on
      // insert, which keeps the common path at one round trip. While that index
      // is missing there is nothing to raise, so check first.
      if (!indexesReady()) {
        const existing = await findReplay(user['_id'], idempotencyKey);
        if (existing) {
          res.status(200).json({ status: true, replayed: true, data: recorded(existing) });
          return;
        }
      }
    }

    try {
      const result = await usageCollection().insertOne(document);
      document['_id'] = result.insertedId;
    } catch (err) {
      if (!(err instanceof MongoServerError) || err.code !== 11000) throw err;
      const existing = idempotencyKey ? await findReplay(user['_id'], idempotencyKey) : null;
      if (!existing) {
        // Lost a race with a concurrent identical request.
        throw new HttpError(409, 'Idempotency-Key is already in flight. Retry shortly.');
      }
      res.status(200).json({ status: true, replayed: true, data: recorded(existing) });
      return;
    }

    // Take the credits only after the insert, so the unique idempotency index
    // has already rejected any replay: a retried call must never be charged
    // twice.
    const balance = await charge(document, priced['cost'] as AmountLike);
    if (balance !== null) {
      res.status(201).json({
        status: true,
        replayed: false,
        data: recorded(document),
        balance,
      });
      return;
    }

    // Recorded but unpaid. 402 tells the calling service to stop serving this
    // customer; the record stays as evidence of what was consumed.
    throw new HttpError(
      402,
      'Insufficient credits. The usage was recorded but not billed. ' +
        'Top up at /billing/top-up.',
    );
  }),
);

// --- History ----------------------------------------------------------------

/** The Mongo filter for a history query, always scoped to the caller. */
function scope(
  user: Record<string, unknown>,
  q: Request['query'],
): Record<string, unknown> {
  const filter: Record<string, unknown> = { user_id: user['_id'] };
  if (q['service']) filter['service'] = String(q['service']);
  if (q['model']) filter['model_key'] = normalizeModelKey(String(q['model']));
  if (q['api_key_id']) filter['api_key_id'] = String(q['api_key_id']);
  if (q['project_id']) filter['project_id'] = String(q['project_id']);

  const from = q['from'] ? new Date(String(q['from'])) : null;
  const to = q['to'] ? new Date(String(q['to'])) : null;
  const range: Record<string, Date> = {};
  if (from && !Number.isNaN(from.getTime())) range['$gte'] = from;
  if (to && !Number.isNaN(to.getTime())) range['$lte'] = to;
  if (Object.keys(range).length > 0) filter['created_at'] = range;

  return filter;
}

usageRouter.get(
  '',
  requireUser,
  asyncHandler(async (req: Request, res) => {
    const user = (req as AuthedRequest).user;
    const limit = Math.min(500, Math.max(1, Number(req.query['limit'] ?? 50)));
    const offset = Math.max(0, Number(req.query['offset'] ?? 0));
    const filter = scope(user, req.query);

    const total = await usageCollection().countDocuments(filter);
    const docs = await usageCollection()
      .find(filter)
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
      data: docs.map(recorded),
    });
  }),
);

/** Totals over a window: what it cost, how many calls, split by service. */
async function periodTotals(
  user: Record<string, unknown>,
  begin: Date,
  finish: Date,
): Promise<{ cost: ReturnType<typeof toDecimal>; calls: number; byService: Array<Record<string, unknown>> }> {
  const rows = await usageCollection()
    .aggregate([
      { $match: { user_id: user['_id'], created_at: { $gte: begin, $lte: finish } } },
      {
        $group: {
          _id: '$service',
          // `$sum` over Decimal128 is exact — the reason costs are stored that
          // way rather than as doubles.
          cost: { $sum: '$cost' },
          calls: { $sum: 1 },
          quantity: { $sum: '$quantity' },
        },
      },
      { $sort: { cost: -1 } },
    ])
    .toArray();

  return {
    cost: sumOf(rows.map((r) => (r['cost'] ?? 0) as AmountLike)),
    calls: rows.reduce((n, r) => n + Number(r['calls'] ?? 0), 0),
    byService: rows.map((r) => ({
      service: r['_id'],
      label: SERVICE_LABEL(r['_id'] as string),
      cost: toJson((r['cost'] ?? 0) as AmountLike),
      calls: Number(r['calls'] ?? 0),
      quantity: Number(r['quantity'] ?? 0),
    })),
  };
}

function SERVICE_LABEL(key: string): string {
  try {
    return getService(key).label;
  } catch {
    // A service removed from the rate card still has history; label it by key
    // rather than dropping the row.
    return key;
  }
}

/**
 * Percentage change, or null when there is no baseline.
 *
 * Null rather than 0 or 100: "no previous usage" is not "no change", and a
 * dashboard showing +0% for a customer's first month would be wrong.
 */
function percentChange(current: AmountLike, previous: AmountLike): number | null {
  const prev = toDecimal(previous);
  if (prev.isZero()) return null;
  return toDecimal(current).minus(prev).dividedBy(prev).times(100).toDecimalPlaces(2).toNumber();
}

usageRouter.get(
  '/overview',
  requireUser,
  asyncHandler(async (req: Request, res) => {
    const user = (req as AuthedRequest).user;
    const days = Math.min(365, Math.max(1, Number(req.query['days'] ?? 30)));

    const now = new Date();
    const begin = new Date(now.getTime() - days * 86_400_000);
    const priorBegin = new Date(begin.getTime() - days * 86_400_000);

    const current = await periodTotals(user, begin, now);
    const previous = await periodTotals(user, priorBegin, begin);
    const balance = await credits.balanceOf(user['_id'] as ObjectId);

    res.json({
      status: true,
      data: {
        days,
        from: begin.toISOString(),
        to: now.toISOString(),
        total_cost: toJson(current.cost),
        total_calls: current.calls,
        credits_remaining: balance.toNumber(),
        by_service: current.byService,
        change_percent: {
          cost: percentChange(current.cost, previous.cost),
          calls: previous.calls === 0 ? null : percentChange(current.calls, previous.calls),
        },
      },
    });
  }),
);

usageRouter.get(
  '/summary',
  requireUser,
  asyncHandler(async (req: Request, res) => {
    const user = (req as AuthedRequest).user;
    const now = new Date();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

    const month = await periodTotals(user, monthStart, now);
    const balance = await credits.balanceOf(user['_id'] as ObjectId);
    const lifetime = await usageCollection().countDocuments({ user_id: user['_id'] });

    res.json({
      status: true,
      data: {
        month_start: monthStart.toISOString(),
        month_cost: toJson(month.cost),
        month_calls: month.calls,
        lifetime_calls: lifetime,
        credits_remaining: balance.toNumber(),
        by_service: month.byService,
      },
    });
  }),
);

/**
 * Spend, requests and quantity bucketed over time, for the usage charts.
 *
 * Buckets with no usage are returned as **zeroes rather than omitted**:
 * dropping them would make a quiet day vanish from the x-axis instead of
 * showing as a flat line, so the chart would misrepresent the month.
 */
usageRouter.get(
  '/timeseries',
  requireUser,
  asyncHandler(async (req: Request, res) => {
    const user = (req as AuthedRequest).user;

    let gran;
    let begin: Date;
    let finish: Date;
    try {
      gran = analytics.getGranularity(req.query['granularity'] as string | undefined);
      [begin, finish] = analytics.resolveRange(
        gran,
        req.query['from'] as string | undefined,
        req.query['to'] as string | undefined,
      );
    } catch (err) {
      // Both a bad granularity and an over-wide range are the caller's mistake,
      // and the message says which — a bare 400 would leave the dashboard
      // unable to explain itself.
      throw new HttpError(400, err instanceof Error ? err.message : 'Invalid range.');
    }

    const query = scope(user, req.query);
    query['created_at'] = { $gte: analytics.truncate(begin, gran), $lte: finish };

    const rows = await usageCollection()
      .aggregate([
        { $match: query },
        {
          $group: {
            _id: { $dateToString: { format: gran.fmt, date: '$created_at' } },
            cost: { $sum: '$cost' },
            quantity: { $sum: '$quantity' },
            requests: { $sum: 1 },
          },
        },
      ])
      .toArray();
    const found = new Map(rows.map((r) => [String(r['_id']), r]));

    const buckets = analytics.bucketLabels(begin, finish, gran).map((label) => {
      const row = found.get(label);
      return {
        bucket: label,
        cost: row ? toJson((row['cost'] ?? 0) as AmountLike) : 0,
        quantity: row ? round4(Number(row['quantity'] ?? 0)) : 0,
        requests: row ? Number(row['requests'] ?? 0) : 0,
      };
    });

    res.json({
      status: true,
      granularity: gran.key,
      from: begin.toISOString(),
      to: finish.toISOString(),
      currency: 'INR',
      totals: {
        cost: toJson(sumOf(buckets.map((b) => b.cost))),
        requests: buckets.reduce((n, b) => n + b.requests, 0),
        quantity: round4(buckets.reduce((n, b) => n + b.quantity, 0)),
      },
      count: buckets.length,
      data: buckets,
    });
  }),
);

usageRouter.get(
  '/export.csv',
  requireUser,
  asyncHandler(async (req: Request, res) => {
    const user = (req as AuthedRequest).user;
    const docs = await usageCollection()
      .find(scope(user, req.query))
      .sort({ created_at: -1 })
      .limit(50_000)
      .toArray();

    const header = [
      'id', 'created_at', 'service', 'label', 'model', 'unit', 'quantity',
      'pricing', 'input_quantity', 'output_quantity', 'rate', 'unit_size',
      'cost', 'currency', 'billed', 'project_id', 'api_key_id',
    ];

    /** RFC 4180 quoting. A label containing a comma would otherwise shift every
     *  column after it, silently corrupting the customer's spreadsheet. */
    const cell = (v: unknown): string => {
      if (v === null || v === undefined) return '';
      const s = String(v);
      return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };

    const lines = [header.join(',')];
    for (const doc of docs) {
      const r = recorded(doc);
      lines.push(header.map((h) => cell(r[h] ?? doc[h])).join(','));
    }

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="usage.csv"');
    res.send(lines.join('\r\n'));
  }),
);
