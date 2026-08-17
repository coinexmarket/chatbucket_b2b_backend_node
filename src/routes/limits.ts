/**
 * Plan limits — backs the dashboard's Limits page.
 *
 * Ported from `app/routers/limits.py`.
 *
 *   GET /limits         the caller's plan, credit balance and per-API limits
 *   GET /limits/plans   the public plan catalogue (no auth)
 *
 * Every API key on an account shares these limits, so they are reported per
 * service rather than per key.
 */
import { Router, type Request } from 'express';
import type { ObjectId } from 'mongodb';

import { getSettings } from '../config.js';
import { asyncHandler } from '../errors.js';
import { requireUser, type AuthedRequest } from '../middleware/auth.js';
import { getPlan, planCatalogue } from '../plans.js';
import { SERVICES } from '../pricing.js';
import * as credits from '../services/credits.js';

export const limitsRouter = Router();

/** The plan catalogue. Public, like `/pricing`. Declared before the authed
 *  routes so the middleware below does not apply to it. */
limitsRouter.get('/plans', (_req, res) => {
  res.json({ status: true, data: planCatalogue() });
});

limitsRouter.get(
  '',
  requireUser,
  asyncHandler(async (req: Request, res) => {
    const user = (req as AuthedRequest).user;
    const plan = getPlan(user['plan'] as string | undefined);
    const balance = await credits.balanceOf(user['_id'] as ObjectId);

    res.json({
      status: true,
      data: {
        plan: plan.key,
        plan_label: plan.label,
        support: plan.support,
        best_for: plan.bestFor,
        credits: balance.toNumber(),
        requests_per_minute: plan.requestsPerMinute,
        concurrency: plan.concurrency,
        // True when the limits below are actually applied to POST /usage.
        enforced: getSettings().ENFORCE_PLAN_RATE_LIMITS,
        limits: Object.values(SERVICES).map((s) => ({
          service: s.key,
          label: s.label,
          unit: s.unit,
          requests_per_minute: plan.requestsPerMinute,
          concurrency: plan.concurrency,
        })),
      },
    });
  }),
);
