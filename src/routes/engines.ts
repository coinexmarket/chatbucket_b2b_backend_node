/**
 * Engine burn — how much of *our* own capacity customers are using.
 *
 * Ported from `app/routers/engines.py`. This is the other half of metering:
 * `GET /usage/summary` answers "what does this customer owe us"; this answers
 * "what has serving them cost us in engine capacity, and how much of the
 * allowance is left".
 *
 * **Gated by an operator secret, not a user session.** Every other
 * authenticated endpoint here answers *about the caller*; this one answers
 * about the business. Consumption and remaining allowance are facts about our
 * margin, so exposing them to a signed-in customer — often the very account
 * being reported on — would hand competitors the cost side of our pricing.
 */
import { Router, type Request } from 'express';
import { ObjectId } from 'mongodb';

import { getSettings } from '../config.js';
import { usageCollection, usersCollection } from '../database.js';
import * as engines from '../engines.js';
import { asyncHandler } from '../errors.js';
import { requireSecret } from '../middleware/secret.js';

export const enginesRouter = Router();

/**
 * How many accounts to name per engine. The point is to spot the handful of
 * callers burning the allowance, not to page through every customer.
 */
const TOP_ACCOUNTS = 5;

interface Bucket {
  consumed: number;
  events: number;
  accounts: Array<{ userId: unknown; consumed: number; events: number }>;
  providers: Map<string, { consumed: number; events: number }>;
}

const round4 = (n: number): number => Math.round(n * 10_000) / 10_000;

enginesRouter.get(
  '/usage',
  asyncHandler(async (req: Request, res) => {
    const s = getSettings();
    requireSecret(
      req.get('X-Ops-Secret'),
      s.OPS_SECRET,
      'Engine reporting is not configured (OPS_SECRET unset).',
      'Invalid ops secret.',
    );

    const days = Math.min(365, Math.max(1, Number(req.query['days'] ?? 30)));
    const finish = new Date();
    const begin = new Date(finish.getTime() - days * 86_400_000);

    // Grouped by (engine, account, provider) in one pass: the per-engine
    // totals, the top consumers and the provider split are the same
    // aggregation viewed three ways, and doing it three times would let them
    // disagree if a write landed in between.
    const rows = await usageCollection()
      .aggregate([
        { $match: { engine: { $ne: null }, created_at: { $gte: begin, $lte: finish } } },
        {
          $group: {
            _id: { engine: '$engine', user_id: '$user_id', provider: '$provider' },
            consumed: { $sum: '$engine_quantity' },
            events: { $sum: 1 },
          },
        },
      ])
      .toArray();

    const byEngine = new Map<string, Bucket>();
    for (const row of rows) {
      const id = row['_id'] as Record<string, unknown>;
      const key = String(id['engine']);
      let bucket = byEngine.get(key);
      if (!bucket) {
        bucket = { consumed: 0, events: 0, accounts: [], providers: new Map() };
        byEngine.set(key, bucket);
      }

      const consumed = Number(row['consumed'] ?? 0);
      const events = Number(row['events'] ?? 0);
      bucket.consumed += consumed;
      bucket.events += events;
      bucket.accounts.push({ userId: id['user_id'], consumed, events });

      // Usage recorded before a service was configured with a provider has
      // none. Kept as a named bucket rather than dropped, so the split always
      // adds up to the engine total — a reconciliation that silently omits
      // rows is worse than one that admits what it cannot attribute.
      const provider = String(id['provider'] ?? '') || '(unreported)';
      const entry = bucket.providers.get(provider) ?? { consumed: 0, events: 0 };
      entry.consumed += consumed;
      entry.events += events;
      bucket.providers.set(provider, entry);
    }

    const quotas = s.engineQuotaMap;
    const labels = await accountLabels(byEngine);

    // Every known engine is listed, including ones with no traffic: an engine
    // missing from the page is indistinguishable from one nobody has reported
    // for, and silence is exactly what a capacity view must not hide.
    const keys = [...new Set([...Object.keys(engines.ENGINES), ...byEngine.keys()])].sort();

    const data = keys.map((key) => {
      const bucket =
        byEngine.get(key) ?? { consumed: 0, events: 0, accounts: [], providers: new Map() };
      const line = engines.summarise(key, bucket.consumed, bucket.events, quotas);

      // What to reconcile against which upstream invoice. Heaviest first,
      // because that is the bill worth checking.
      line['by_provider'] = [...bucket.providers.entries()]
        .sort((a, b) => b[1].consumed - a[1].consumed)
        .map(([provider, stats]) => ({
          provider,
          consumed: round4(stats.consumed),
          events: stats.events,
        }));

      line['top_accounts'] = [...bucket.accounts]
        .sort((a, b) => b.consumed - a.consumed)
        .slice(0, TOP_ACCOUNTS)
        .map((a) => ({
          user_id: String(a.userId),
          email: labels.get(String(a.userId)) ?? '(deleted account)',
          consumed: round4(a.consumed),
          events: a.events,
        }));

      return line;
    });

    res.json({
      status: true,
      period: { days, from: begin.toISOString(), to: finish.toISOString() },
      // Says plainly whether `remaining` means anything yet, so an operator
      // reading nulls knows it is unconfigured rather than broken.
      quotas_configured: Object.keys(quotas).length > 0,
      data,
    });
  }),
);

/**
 * Email per account id, for the accounts about to be listed.
 *
 * Only the ids that will actually be shown are looked up — the aggregation can
 * span every customer, and fetching them all to render five rows per engine
 * would make this endpoint scale with the customer base.
 */
async function accountLabels(byEngine: Map<string, Bucket>): Promise<Map<string, string>> {
  const wanted = new Set<string>();
  for (const bucket of byEngine.values()) {
    [...bucket.accounts]
      .sort((a, b) => b.consumed - a.consumed)
      .slice(0, TOP_ACCOUNTS)
      .forEach((a) => wanted.add(String(a.userId)));
  }
  if (wanted.size === 0) return new Map();

  const ids = [...wanted].filter((id) => ObjectId.isValid(id)).map((id) => new ObjectId(id));
  const docs = await usersCollection()
    .find({ _id: { $in: ids } }, { projection: { email: 1 } })
    .toArray();

  return new Map(docs.map((d) => [String(d['_id']), String(d['email'] ?? '')]));
}
