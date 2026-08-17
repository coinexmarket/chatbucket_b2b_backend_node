/**
 * MongoDB connection and collection accessors.
 *
 * Ported from `app/database.py`. Collections are reached through the functions
 * below rather than by string literal, so a name is spelt once and a typo is a
 * compile error instead of a silently-empty query against a collection that
 * does not exist.
 *
 * The same database as the Python service, deliberately: during the cutover
 * both run side by side and must see the same data.
 */
import { MongoClient, type Collection, type Db, type Document } from 'mongodb';

import { getSettings } from './config.js';
import { logger } from './logger.js';

interface State {
  client: MongoClient | null;
  b2b: Db | null;
  blog: Db | null;
  indexesReady: boolean;
}

const state: State = { client: null, b2b: null, blog: null, indexesReady: false };

export async function connect(): Promise<void> {
  if (state.client) return;
  const s = getSettings();
  const client = new MongoClient(s.MONGODB_URI, {
    // Fail a request rather than hang it forever when the primary is gone.
    serverSelectionTimeoutMS: 10_000,
  });
  await client.connect();
  state.client = client;
  state.b2b = client.db(s.MONGODB_DB);
  state.blog = client.db(s.MONGODB_BLOG_DB);
  logger.info('mongodb connected (db: %s)', s.MONGODB_DB);
}

export async function disconnect(): Promise<void> {
  await state.client?.close();
  state.client = null;
  state.b2b = null;
  state.blog = null;
  state.indexesReady = false;
}

function b2bDb(): Db {
  if (!state.b2b) throw new Error('MongoDB not connected. Did startup run?');
  return state.b2b;
}

function blogDb(): Db {
  if (!state.blog) throw new Error('MongoDB not connected. Did startup run?');
  return state.blog;
}

/** Test hook: point the accessors at an already-open database. */
export function useDatabases(b2b: Db, blog: Db = b2b): void {
  state.b2b = b2b;
  state.blog = blog;
}

/** True when the indexes the app depends on are known to exist. */
export function indexesReady(): boolean {
  return state.indexesReady;
}

// --- Collections -----------------------------------------------------------

export const usersCollection = (): Collection<Document> => b2bDb().collection('users');
export const apiKeysCollection = (): Collection<Document> => b2bDb().collection('api_keys');
export const usageCollection = (): Collection<Document> => b2bDb().collection('usage');
export const creditAccountsCollection = (): Collection<Document> =>
  b2bDb().collection('credit_accounts');
export const creditLedgerCollection = (): Collection<Document> =>
  b2bDb().collection('credit_ledger');
export const paymentsCollection = (): Collection<Document> => b2bDb().collection('payments');
export const invoicesCollection = (): Collection<Document> => b2bDb().collection('invoices');
export const projectsCollection = (): Collection<Document> => b2bDb().collection('projects');
export const rateLimitsCollection = (): Collection<Document> => b2bDb().collection('rate_limits');
export const refreshTokensCollection = (): Collection<Document> =>
  b2bDb().collection('refresh_tokens');
export const notificationsCollection = (): Collection<Document> =>
  b2bDb().collection('notifications');
export const jobRunsCollection = (): Collection<Document> => b2bDb().collection('job_runs');
export const countersCollection = (): Collection<Document> => b2bDb().collection('counters');
export const demoRequestsCollection = (): Collection<Document> =>
  b2bDb().collection('demo_requests');
export const subscriptionsCollection = (): Collection<Document> =>
  b2bDb().collection('subscriptions');
export const serviceStatusCollection = (): Collection<Document> =>
  b2bDb().collection('service_status');
export const serviceStatusDaysCollection = (): Collection<Document> =>
  b2bDb().collection('service_status_days');

export const blogsCollection = (): Collection<Document> => blogDb().collection('blogs');

/**
 * A mobile number proven **before** an account exists for it.
 *
 * The signup form asks for the number, texts a code and checks it while the
 * customer is still filling the form in, so at that moment there is no user
 * document to hang the code off — hence a collection keyed by the number itself.
 *
 * Deliberately separate from `users`: these are unauthenticated, cheap to create
 * and expire quickly, and mixing them into `users` would mean half-real accounts
 * that every other query has to learn to skip.
 */
export const phoneVerificationsCollection = (): Collection<Document> =>
  b2bDb().collection('phone_verifications');

// --- Indexes ---------------------------------------------------------------

export async function ensureIndexes(): Promise<void> {
  await usersCollection().createIndex({ email: 1 }, { unique: true });

  // A number must identify one account: `verify-phone` looks an account up by
  // it, and the signup bonus would otherwise be farmable by re-registering the
  // same mobile against new addresses.
  //
  // Partial, so the many historical users with no phone do not collide on null.
  // Wrapped, because this index CANNOT be built on data that already holds
  // duplicates — and letting it throw would abort every index below it, leaving
  // the app running with no unique constraint on email either.
  try {
    await usersCollection().createIndex(
      { phone: 1 },
      { unique: true, partialFilterExpression: { phone: { $type: 'string' } } },
    );
  } catch (err) {
    logger.error(
      'could not create the unique index on users.phone — check for duplicate ' +
        'numbers and re-run: %s',
      err instanceof Error ? err.message : err,
    );
  }

  await apiKeysCollection().createIndex({ key_hash: 1 }, { unique: true });
  await apiKeysCollection().createIndex({ user_id: 1 });

  await usageCollection().createIndex({ user_id: 1, created_at: -1 });
  await usageCollection().createIndex({ service: 1 });
  // Backs the per-model breakdown and the `?model=` filter. Partial because
  // records from callers that never report a model would otherwise all index
  // a null.
  await usageCollection().createIndex(
    { user_id: 1, model_key: 1 },
    { partialFilterExpression: { model_key: { $type: 'string' } } },
  );
  // Makes `POST /usage` retries safe: one usage record per (customer, key).
  // Scoped per user so two customers can pick the same key, and partial so the
  // many records sent without a key never collide with each other.
  await usageCollection().createIndex(
    { user_id: 1, idempotency_key: 1 },
    { unique: true, partialFilterExpression: { idempotency_key: { $exists: true } } },
  );
  await usageCollection().createIndex(
    { user_id: 1, project_id: 1 },
    { partialFilterExpression: { project_id: { $type: 'string' } } },
  );

  // Project names are unique per customer (on the case-folded key), so a second
  // "Production" is rejected rather than creating a confusing twin.
  await projectsCollection().createIndex({ user_id: 1, name_key: 1 }, { unique: true });

  // One credit account per user; unique so a race on first touch cannot create
  // two balances for the same customer.
  await creditAccountsCollection().createIndex({ user_id: 1 }, { unique: true });
  await creditLedgerCollection().createIndex({ user_id: 1, created_at: -1 });
  await paymentsCollection().createIndex({ user_id: 1, created_at: -1 });
  // Set by the gateway webhook; unique so a redelivered callback cannot credit
  // the same payment twice. Webhooks arrive keyed by order id, so two local
  // payments sharing one order would be ambiguous.
  await paymentsCollection().createIndex(
    { provider_order_id: 1 },
    { unique: true, partialFilterExpression: { provider_order_id: { $exists: true } } },
  );
  await paymentsCollection().createIndex(
    { provider_payment_id: 1 },
    { unique: true, partialFilterExpression: { provider_payment_id: { $exists: true } } },
  );

  await subscriptionsCollection().createIndex({ email: 1 }, { unique: true });
  await demoRequestsCollection().createIndex({ created_at: -1 });
  await demoRequestsCollection().createIndex({ email: 1 });

  await serviceStatusCollection().createIndex({ service: 1 }, { unique: true });
  await serviceStatusDaysCollection().createIndex(
    { service: 1, day: 1 },
    { unique: true },
  );

  await invoicesCollection().createIndex({ invoice_number: 1 }, { unique: true });
  await invoicesCollection().createIndex({ user_id: 1, issued_at: -1 });

  // Mongo expires these itself, so nothing has to remember to sweep them.
  await rateLimitsCollection().createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 });
  await refreshTokensCollection().createIndex({ token_hash: 1 }, { unique: true });
  await refreshTokensCollection().createIndex({ user_id: 1 });
  await refreshTokensCollection().createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 });

  // What makes a lifecycle email send-once. `key` distinguishes instances of the
  // same kind — the month for a report, the window id for a reminder — so a
  // re-run of either is a duplicate the database refuses.
  await notificationsCollection().createIndex(
    { user_id: 1, kind: 1, key: 1 },
    { unique: true },
  );

  // The scheduler's mutual exclusion: of two workers waking at the same moment,
  // exactly one insert succeeds and the other reads its own duplicate-key error
  // as "somebody else has this".
  await jobRunsCollection().createIndex({ job: 1, period: 1 }, { unique: true });

  // One live code per number, so a resend replaces the previous code rather than
  // leaving two valid ones with one attempt counter between them.
  await phoneVerificationsCollection().createIndex({ phone: 1 }, { unique: true });
  // These are worthless once spent and hold a code hash for a number belonging
  // to somebody who never became a customer. Mongo expires them on `purge_at`.
  await phoneVerificationsCollection().createIndex(
    { purge_at: 1 },
    { expireAfterSeconds: 0 },
  );

  state.indexesReady = true;
}
