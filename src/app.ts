/**
 * The Express application: middleware, CORS, routes, error handling.
 *
 * Separate from `server.ts` so tests can mount the app without binding a port.
 */
import cors from 'cors';
import express, { type Express } from 'express';

import { getSettings } from './config.js';
import { indexesReady } from './database.js';
import { errorHandler } from './errors.js';
import { logger } from './logger.js';
import { apiKeysRouter } from './routes/apiKeys.js';
import { authRouter } from './routes/auth.js';
import { billingRouter } from './routes/billing.js';
import { limitsRouter } from './routes/limits.js';
import { profileRouter } from './routes/profile.js';
import { projectsRouter } from './routes/projects.js';
import { usageRouter } from './routes/usage.js';

/** Any localhost/127.0.0.1 port, for local development only. */
const LOOPBACK = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\]):\d+$/;

export function createApp(): Express {
  const s = getSettings();
  const app = express();

  // Required for `req.ip` to be the real client behind a load balancer.
  // Without it every request appears to come from the proxy, and one customer's
  // traffic would exhaust everybody's rate limit.
  app.set('trust proxy', true);
  app.disable('x-powered-by');

  app.use(express.json({ limit: '1mb' }));

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

  app.get('/health', (_req, res) => {
    res.json({
      status: true,
      service: 'ChatBucket B2B Backend (Node)',
      database: 'up',
      indexes: indexesReady() ? 'ready' : 'pending',
    });
  });

  app.use('/auth', authRouter);
  app.use('/api-keys', apiKeysRouter);
  app.use('/projects', projectsRouter);
  app.use('/profile', profileRouter);
  app.use('/limits', limitsRouter);
  app.use('/usage', usageRouter);
  app.use('/billing', billingRouter);

  app.use((_req, res) => {
    res.status(404).json({ detail: 'Not found.' });
  });

  // Last: Express picks a handler by arity, so this must be registered after
  // every route or errors thrown in them will not reach it.
  app.use(errorHandler);

  return app;
}
