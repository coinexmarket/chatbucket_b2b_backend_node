/**
 * The plan catalogue.
 *
 * Ported from `app/plans.py`. Plan keys and prices are written to user documents
 * and read by the frontend, so these values are shared with the Python service
 * and cannot be renamed independently.
 */
import { Decimal, toDecimal } from './money.js';

export interface Plan {
  key: string;
  label: string;
  /**
   * Advertised here, reported by `GET /limits`, and enforced on `POST /usage`,
   * counted per (account, service) in Mongo so the allowance holds across
   * workers.
   */
  requestsPerMinute: number;
  /**
   * Advertised and reported, but **NOT enforced**: nothing counts in-flight
   * requests. A deliberate, documented gap — stated here so nobody reads the
   * field as a live limit.
   */
  concurrency: number;
  support: string;
  bestFor: string;
  /** What buying this pack costs and grants. Zero for `starter`, which is not
   *  purchasable — you are on it by default. */
  priceInr: Decimal;
  creditsGranted: Decimal;
}

const LIST: Plan[] = [
  {
    key: 'starter',
    label: 'Starter',
    requestsPerMinute: 60,
    concurrency: 2,
    support: 'Community support',
    bestFor: 'Prototyping & testing',
    priceInr: toDecimal('0'),
    creditsGranted: toDecimal('0'),
  },
  {
    key: 'pro',
    label: 'Pro',
    requestsPerMinute: 200,
    concurrency: 10,
    support: 'Email support',
    bestFor: 'Startups & POCs',
    priceInr: toDecimal('10000'),
    creditsGranted: toDecimal('11000'), // 10% bonus
  },
  {
    key: 'business',
    label: 'Business',
    requestsPerMinute: 1000,
    concurrency: 50,
    support: 'Email support',
    bestFor: 'Production workloads',
    priceInr: toDecimal('50000'),
    creditsGranted: toDecimal('57500'), // 15% bonus
  },
];

export const PLANS: Record<string, Plan> = Object.fromEntries(LIST.map((p) => [p.key, p]));

export const DEFAULT_PLAN = 'starter';

/** Everything except the free tier can be bought as a top-up pack. */
export const PURCHASABLE = LIST.filter((p) => p.priceInr.greaterThan(0)).map((p) => p.key);

export class UnknownPlanError extends Error {}

/**
 * Resolve a plan key, falling back to the default.
 *
 * Accounts created before plans existed carry no `plan` field; they read as
 * `starter` rather than erroring.
 */
export function getPlan(key: string | null | undefined): Plan {
  const plan = PLANS[(key ?? DEFAULT_PLAN).toLowerCase()];
  if (!plan) {
    throw new UnknownPlanError(
      `Unknown plan '${key}'. Valid: ${Object.keys(PLANS).join(', ')}`,
    );
  }
  return plan;
}

/** JSON-serialisable description of every plan. */
export function planCatalogue(): Array<Record<string, unknown>> {
  return LIST.map((p) => ({
    key: p.key,
    label: p.label,
    requests_per_minute: p.requestsPerMinute,
    concurrency: p.concurrency,
    support: p.support,
    best_for: p.bestFor,
    price_inr: p.priceInr.toNumber(),
    credits_granted: p.creditsGranted.toNumber(),
    purchasable: p.priceInr.greaterThan(0),
  }));
}
