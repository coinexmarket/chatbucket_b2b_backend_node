/**
 * Process entry point: connect, build indexes, warm the hasher, serve.
 *
 * The equivalent of FastAPI's lifespan, with one rule that shapes the order:
 * **a database that is briefly unreachable must not stop the service starting.**
 * It comes up and answers `/health` with a 503 and `"database": "down"`, which
 * is what an orchestrator routes on. Exiting instead turns a thirty-second Mongo
 * blip into a crash-loop — and a crash-looping container has no health endpoint
 * at all, so the thing meant to report the problem is the thing that disappears.
 *
 * Indexes and the password hasher are still prepared before the port opens when
 * the database *is* reachable, so the first request does not pay for them.
 */
import { createApp } from './app.js';
import { getSettings } from './config.js';
import { connect, disconnect, ensureIndexes } from './database.js';
import { logger } from './logger.js';
import { schedulerLoop, stopScheduler } from './services/notifications.js';
import { warmPasswordHasher } from './security.js';

/** How long to wait between attempts to reach a database that was down. */
const RECONNECT_DELAY_MS = 15_000;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms).unref());

/**
 * Keep trying to reach the database, for the life of the process.
 *
 * An instance that started during an outage must begin serving properly once
 * the outage ends, without anybody restarting it.
 */
async function retryDatabase(): Promise<void> {
  for (;;) {
    await sleep(RECONNECT_DELAY_MS);
    try {
      await connect();
      await ensureIndexes();
      logger.info('database reachable; indexes ready');
      return;
    } catch (err) {
      logger.error(
        'database still unreachable: %s',
        err instanceof Error ? err.message : err,
      );
    }
  }
}

/** Connect and build indexes. Returns whether it worked; never throws. */
async function prepareDatabase(): Promise<boolean> {
  try {
    await connect();
    await ensureIndexes();
    return true;
  } catch (err) {
    logger.error(
      'database not ready at startup; serving 503 on /health and retrying: %s',
      err instanceof Error ? err.message : err,
    );
    void retryDatabase();
    return false;
  }
}

async function main(): Promise<void> {
  const s = getSettings();

  const dbReady = await prepareDatabase();

  // Otherwise the first login with an unknown email pays ~200ms to build the
  // dummy hash, on the request.
  await warmPasswordHasher();

  // OFF by default: turning the scheduler on is a decision to start mailing
  // customers, and it must never happen merely because a service booted. Not
  // awaited — it runs for the life of the process.
  if (s.NOTIFICATION_SCHEDULER_ENABLED) {
    void schedulerLoop();
  } else {
    logger.info('notification scheduler is off (NOTIFICATION_SCHEDULER_ENABLED)');
  }

  const server = createApp().listen(s.PORT, () => {
    // Not "127.0.0.1": listen() with no host binds every interface, which is
    // what a container needs. Printing a loopback URL here reads as a bind
    // address and sends people looking for a networking bug that is not there.
    logger.info(
      'listening on port %d (%s), database %s',
      s.PORT,
      s.ENVIRONMENT,
      dbReady ? 'ready' : 'unavailable — /health will report 503',
    );
  });

  // Finish in-flight requests before exiting, so a deploy does not drop them.
  const shutdown = (signal: string) => {
    logger.info('%s received, shutting down', signal);
    stopScheduler();
    server.close(() => {
      void disconnect().finally(() => process.exit(0));
    });
    // Do not hang forever on a stuck connection.
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  logger.error('failed to start: %s', err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});
