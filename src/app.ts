/**
 * The Express application: middleware, CORS, routes, error handling.
 *
 * Separate from `server.ts` so tests can mount the app without binding a port.
 */
import cors from 'cors';
import express, { type Express } from 'express';

import { getSettings } from './config.js';
import { indexesReady, ping } from './database.js';
import { errorHandler } from './errors.js';
import { logger } from './logger.js';
import { accountRouter } from './routes/account.js';
import { apiKeysRouter } from './routes/apiKeys.js';
import { authRouter } from './routes/auth.js';
import { billingRouter } from './routes/billing.js';
import { blogsRouter } from './routes/blogs.js';
import { contestRouter } from './routes/contest.js';
import { enginesRouter } from './routes/engines.js';
import { limitsRouter } from './routes/limits.js';
import { notificationsRouter } from './routes/notifications.js';
import { demoRouter, pricingRouter, subscriptionsRouter } from './routes/misc.js';
import { profileRouter } from './routes/profile.js';
import { projectsRouter } from './routes/projects.js';
import { statusRouter } from './routes/status.js';
import { usageRouter } from './routes/usage.js';

/** Any localhost/127.0.0.1 port, for local development only. */
const LOOPBACK = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\]):\d+$/;

export function createApp(): Express {
  const s = getSettings();
  const app = express();

  /**
   * Whether to believe `X-Forwarded-For`.
   *
   * Behind a load balancer this must be on, or every request appears to come
   * from the proxy and one customer's traffic exhausts everybody's rate limit.
   *
   * With nothing in front it must be OFF, and that is the default: the header
   * is trivially forged, so trusting it lets any caller invent an address per
   * request and walk past every per-IP limit — including the OTP send cap,
   * which is the one that costs money.
   */
  app.set('trust proxy', s.TRUST_PROXY_HEADERS);
  app.disable('x-powered-by');

  /**
   * JSON everywhere **except** the payment webhook.
   *
   * That route verifies an HMAC over the exact bytes the gateway sent. Parsing
   * and re-serialising the body produces a different digest, so every delivery
   * would be rejected — and a rejected webhook means a customer who paid never
   * gets their credits. The route mounts `express.raw` itself; this skip is what
   * lets it see the original bytes.
   */
  const WEBHOOK_PATHS = new Set(['/billing/webhook/razorpay']);
  app.use((req, res, next) => {
    if (WEBHOOK_PATHS.has(req.path)) return next();
    return express.json({ limit: '1mb' })(req, res, next);
  });

  /**
   * CORS: exact-match origins, plus any loopback port in development.
   *
   * `credentials: true` is what makes the strictness matter — a permissive origin
   * would let any site read authenticated responses on a signed-in user's behalf.
   * The loopback regex exists so a developer does not have to add every Next.js
   * port by hand, and is switched off entirely in production.
   */
  app.use(
    cors({
      credentials: true,
      origin(origin, callback) {
        // No Origin header: same-origin, curl, or a server-to-server call.
        if (!origin) return callback(null, true);
        if (s.corsOriginList.includes(origin)) return callback(null, true);
        if (s.isDev && LOOPBACK.test(origin)) return callback(null, true);
        // Logged, because "it works in Postman but not the browser" is almost
        // always this, and silence makes it a long afternoon.
        logger.warn('CORS: refused origin %s', origin.slice(0, 200));
        return callback(null, false);
      },
    }),
  );

  /**
   * Liveness + database connectivity probe.
   *
   * Returns **503 when Mongo is unreachable**: load balancers and orchestrators
   * route on the status code, so a 200 carrying `"database": "down"` would keep
   * a broken instance in rotation serving errors.
   *
   * It pings rather than reporting what `connect()` returned at boot — a client
   * object outlives an outage and would happily claim a connection that stopped
   * working an hour ago.
   */
  app.get('/health', (_req, res) => {
    void ping().then((dbOk) => {
      res.status(dbOk ? 200 : 503).json({
        status: dbOk,
        service: 'ChatBucket B2B Backend (Node)',
        database: dbOk ? 'up' : 'down',
        // Informational: a lasting "pending" means the index retry is stuck and
        // uniqueness is running on the fallback check in `register`.
        indexes: indexesReady() ? 'ready' : 'pending',
      });
    });
  });

  app.use('/auth', authRouter);
  app.use('/api-keys', apiKeysRouter);
  app.use('/projects', projectsRouter);
  app.use('/profile', profileRouter);
  app.use('/limits', limitsRouter);
  app.use('/usage', usageRouter);
  app.use('/billing', billingRouter);
  app.use('/account', accountRouter);
  app.use('/status', statusRouter);
  app.use('/pricing', pricingRouter);
  app.use('/demo-requests', demoRouter);
  app.use('/subscriptions', subscriptionsRouter);
  app.use('/notifications', notificationsRouter);
  app.use('/engines', enginesRouter);
  app.use('/api', contestRouter);
  // Mounted at the root: these paths are the contract the blog frontend already
  // calls (/v1/blogs, /v2/blogs/...), not a prefix we get to choose.
  app.use(blogsRouter);

  app.use((_req, res) => {
    // "Not Found", exactly as FastAPI renders an unmatched route. The wording
    // is part of the contract: a client that string-matches on it would break
    // against a tidier message.
    res.status(404).json({ detail: 'Not Found' });
  });

  // Last: Express picks a handler by arity, so this must be registered after
  // every route or errors thrown in them will not reach it.
  app.use(errorHandler);

  return app;
}
