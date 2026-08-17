/**
 * Process entry point: connect, build indexes, warm the hasher, serve.
 *
 * The equivalent of FastAPI's lifespan. Order matters — indexes and the password
 * hasher are both ready *before* the port opens, so the first request does not
 * pay for them.
 */
import { createApp } from './app.js';
import { getSettings } from './config.js';
import { connect, disconnect, ensureIndexes } from './database.js';
import { logger } from './logger.js';
import { warmPasswordHasher } from './security.js';

async function main(): Promise<void> {
  const s = getSettings();

  await connect();
  await ensureIndexes();
  // Otherwise the first login with an unknown email pays ~200ms to build the
  // dummy hash, on the request.
  await warmPasswordHasher();

  const server = createApp().listen(s.PORT, () => {
    logger.info('listening on http://127.0.0.1:%d (%s)', s.PORT, s.ENVIRONMENT);
  });

  // Finish in-flight requests before exiting, so a deploy does not drop them.
  const shutdown = (signal: string) => {
    logger.info('%s received, shutting down', signal);
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
