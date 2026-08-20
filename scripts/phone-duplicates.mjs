/**
 * Find, and optionally resolve, accounts sharing a mobile number.
 *
 * `users.phone` is meant to be unique — `verify-phone` looks an account up by
 * the number alone, and without the constraint one number can re-register for
 * the signup bonus repeatedly. The index is partial, on `phone` being a string,
 * so the many accounts with no number at all do not collide on null.
 *
 * It does not currently exist. Mongo has refused to build it on every startup
 * since at least the cutover, because some number is on more than one row, and
 * both services log the failure and carry on with an application-level check
 * instead. That check is real but it is not the same guarantee: it cannot see a
 * concurrent registration the way a unique index can.
 *
 * Resolving it means one account keeps the number and the others let it go.
 * Letting go is `$unset` of `phone`, not deletion: the account, its keys, its
 * usage and its invoices are all untouched, and the partial index simply stops
 * considering it. Deleting real accounts to satisfy an index would be a far
 * worse trade.
 *
 * Which one keeps it, in order:
 *
 *   1. a live account over a closed one — a closed row is a tombstone kept for
 *      its invoices, and it has no use for a number;
 *   2. a phone-verified account over an unverified one — somebody proved they
 *      held that handset;
 *   3. the oldest — first claim wins, and it is the one most likely to have
 *      history pointing at it.
 *
 * Read-only unless --commit. Report first, always:
 *
 *   MONGODB_URI='...' node scripts/phone-duplicates.mjs
 *   MONGODB_URI='...' node scripts/phone-duplicates.mjs --commit
 */
import { MongoClient } from 'mongodb';

const URI = process.env.MONGODB_URI;
const DB = process.env.MONGODB_DB || 'chatbucket_b2b';
const commit = process.argv.includes('--commit');

if (!URI) {
  console.error('  MONGODB_URI is not set.');
  process.exit(2);
}

/** Lower sorts first, and first keeps the number. */
function rank(u) {
  return [
    u.deleted_at ? 1 : 0,
    u.phone_verified ? 0 : 1,
    u.created_at instanceof Date ? u.created_at.getTime() : Number.MAX_SAFE_INTEGER,
  ];
}

function cmp(a, b) {
  const [x, y] = [rank(a), rank(b)];
  for (let i = 0; i < x.length; i += 1) if (x[i] !== y[i]) return x[i] - y[i];
  return String(a._id).localeCompare(String(b._id));
}

const client = new MongoClient(URI);

try {
  await client.connect();
  const db = client.db(DB);
  const users = db.collection('users');

  // Only string phones: exactly what the partial index considers.
  const groups = await users.aggregate([
    { $match: { phone: { $type: 'string' } } },
    { $group: { _id: '$phone', ids: { $push: '$_id' }, n: { $sum: 1 } } },
    { $match: { n: { $gt: 1 } } },
    { $sort: { n: -1 } },
  ]).toArray();

  if (groups.length === 0) {
    console.log('  no duplicate numbers — the index should build on next start');
    process.exit(0);
  }

  console.log(`  ${groups.length} number(s) on more than one account\n`);

  const toClear = [];
  for (const g of groups) {
    const rows = await users
      .find(
        { _id: { $in: g.ids } },
        { projection: { email: 1, created_at: 1, phone_verified: 1, deleted_at: 1, email_verified: 1 } },
      )
      .toArray();
    rows.sort(cmp);

    console.log(`  ${g._id}  (${g.n} accounts)`);
    for (const [i, u] of rows.entries()) {
      const keeps = i === 0;
      // Usage and keys are what make an account real rather than abandoned.
      const [usage, keys] = await Promise.all([
        db.collection('usage').countDocuments({ user_id: u._id }, { limit: 1 }),
        db.collection('api_keys').countDocuments({ user_id: u._id }, { limit: 1 }),
      ]);
      const flags = [
        u.deleted_at ? 'closed' : 'live',
        u.phone_verified ? 'phone-verified' : 'phone-unverified',
        u.email_verified ? 'email-verified' : 'email-unverified',
        usage ? 'has-usage' : 'no-usage',
        keys ? 'has-keys' : 'no-keys',
      ].join(', ');
      const created = u.created_at instanceof Date ? u.created_at.toISOString().slice(0, 10) : '?';
      console.log(`    ${keeps ? 'KEEP ' : 'clear'}  ${String(u._id)}  ${created}  ${String(u.email ?? '')}`);
      console.log(`            ${flags}`);
      if (!keeps) toClear.push(u._id);
    }
    console.log();
  }

  console.log(`  ${toClear.length} account(s) would have their phone cleared; nothing deleted.`);

  if (!commit) {
    console.log('\n  Report only — nothing changed. Re-run with --commit to apply.');
    process.exit(0);
  }

  const res = await users.updateMany(
    { _id: { $in: toClear } },
    // The verification state goes with the number: keeping phone_verified true
    // on a row with no phone would claim somebody proved a number that is no
    // longer there.
    { $unset: { phone: '', phone_verified: '', phone_verified_at: '', phone_code_hash: '', phone_code_expires: '', phone_code_attempts: '' } },
  );
  console.log(`\n  cleared: ${res.modifiedCount}`);

  const left = await users.aggregate([
    { $match: { phone: { $type: 'string' } } },
    { $group: { _id: '$phone', n: { $sum: 1 } } },
    { $match: { n: { $gt: 1 } } },
  ]).toArray();
  console.log(`  duplicates remaining: ${left.length}`);
  console.log('\n  Restart the app so the index builds:');
  console.log('  doctl apps create-deployment 779b0f28-1691-4bf1-b599-17995f615658');
} finally {
  await client.close();
}
