/**
 * Service status — backs the API Status page.
 *
 * Ported from `app/routers/status.py`.
 *
 *   GET  /status                 the page: every system, plus 90 days of history
 *   GET  /status/{service}       one system
 *   POST /status/heartbeat       a service reports in       (X-Status-Secret)
 *   PUT  /status/{service}       set by hand for incidents  (X-Status-Secret)
 *
 * `GET /status` is public: a status page nobody can read during an outage is not
 * much of a status page.
 *
 * Writes are guarded by a shared secret rather than a user session, because the
 * callers are the AI services and operators, not customers. Without the secret
 * configured nothing can write — anyone able to set "operational" could hide a
 * real outage from every customer at once.
 */
import { Router, type Request } from 'express';
import { z } from 'zod';

import { getSettings } from '../config.js';
import { serviceStatusCollection } from '../database.js';
import { HttpError, asyncHandler } from '../errors.js';
import { requireSecret } from '../middleware/secret.js';
import { toIso } from '../serialization.js';
import * as serviceStatus from '../services/status.js';

export const statusRouter = Router();

const HEADLINE: Record<string, string> = {
  [serviceStatus.OPERATIONAL]: 'All systems operational',
  [serviceStatus.DEGRADED]: 'Some systems are degraded',
  [serviceStatus.DOWN]: 'We are experiencing an outage',
  [serviceStatus.MAINTENANCE]: 'Undergoing scheduled maintenance',
  [serviceStatus.UNKNOWN]: 'System status is currently unknown',
};

const StatusValue = z.enum(
  serviceStatus.STATUSES as [string, ...string[]],
);

const HeartbeatRequest = z
  .object({
    service: z.string().min(1),
    status: StatusValue,
    detail: z.string().max(500).nullish(),
  })
  .strict();

const StatusUpdateRequest = z
  .object({ status: StatusValue, detail: z.string().max(500).nullish() })
  .strict();

function daysParam(req: Request): number {
  return Math.min(365, Math.max(1, Number(req.query['days'] ?? 90)));
}

function guard(req: Request): void {
  const s = getSettings();
  requireSecret(
    req.get('X-Status-Secret'),
    s.STATUS_WEBHOOK_SECRET,
    'Status reporting is not configured (STATUS_WEBHOOK_SECRET unset).',
    'Invalid status secret.',
  );
}

async function systemView(
  system: serviceStatus.SystemDef,
  doc: Record<string, unknown> | null,
  days: number,
  now: Date,
): Promise<Record<string, unknown>> {
  return {
    service: system.key,
    name: system.name,
    components: system.components,
    status: serviceStatus.applyStaleness(doc, now),
    detail: doc?.['detail'] ?? null,
    source: doc?.['source'] ?? null,
    last_reported_at: doc?.['reported_at'] ? toIso(doc['reported_at']) : null,
    history: await serviceStatus.history(system.key, days, now),
  };
}

statusRouter.get(
  '',
  asyncHandler(async (req: Request, res) => {
    const days = daysParam(req);
    const now = new Date();
    const docs = new Map(
      (await serviceStatusCollection().find({}).toArray()).map((d) => [
        String(d['service']),
        d,
      ]),
    );

    const services = [];
    for (const system of Object.values(serviceStatus.SYSTEMS)) {
      services.push(await systemView(system, docs.get(system.key) ?? null, days, now));
    }

    const overall = serviceStatus.worst(services.map((s) => String(s['status'])));
    res.json({
      status: true,
      overall,
      message: HEADLINE[overall],
      checked_at: now.toISOString(),
      data: services,
    });
  }),
);

/** Declared before `/:service`, or Express matches "heartbeat" as a system key. */
statusRouter.post(
  '/heartbeat',
  asyncHandler(async (req: Request, res) => {
    guard(req);
    const payload = HeartbeatRequest.parse(req.body);
    // Send this on a schedule shorter than `STATUS_STALE_AFTER_SECONDS`; stop,
    // and the service reads `unknown` rather than staying green.
    try {
      const record = await serviceStatus.record(
        payload.service,
        payload.status,
        serviceStatus.SOURCE_HEARTBEAT,
        payload.detail ?? null,
      );
      res.json({
        status: true,
        data: { ...record, reported_at: toIso(record['reported_at']) },
      });
    } catch (err) {
      if (err instanceof serviceStatus.UnknownSystemError) {
        throw new HttpError(400, err.message);
      }
      throw err;
    }
  }),
);

statusRouter.get(
  '/:service',
  asyncHandler(async (req: Request, res) => {
    let system;
    try {
      system = serviceStatus.getSystem(String(req.params['service']));
    } catch (err) {
      if (err instanceof serviceStatus.UnknownSystemError) {
        throw new HttpError(404, err.message);
      }
      throw err;
    }
    const doc = await serviceStatusCollection().findOne({ service: system.key });
    res.json({
      status: true,
      data: await systemView(system, doc, daysParam(req), new Date()),
    });
  }),
);

statusRouter.put(
  '/:service',
  asyncHandler(async (req: Request, res) => {
    guard(req);
    const payload = StatusUpdateRequest.parse(req.body);
    // A manual status does not go stale — it stands until changed, so declaring
    // an outage is not quietly undone by the staleness rule.
    try {
      const record = await serviceStatus.record(
        String(req.params['service']),
        payload.status,
        serviceStatus.SOURCE_MANUAL,
        payload.detail ?? null,
      );
      res.json({
        status: true,
        data: { ...record, reported_at: toIso(record['reported_at']) },
      });
    } catch (err) {
      if (err instanceof serviceStatus.UnknownSystemError) {
        throw new HttpError(400, err.message);
      }
      throw err;
    }
  }),
);
