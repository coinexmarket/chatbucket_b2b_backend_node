/**
 * Mark existing accounts as already-notified, so enabling the scheduler does not
 * mail the entire back catalogue on its first tick.
 *
 * The lifecycle jobs select on a one-sided cutoff — `created_at <= now - N`,
 * with no lower bound — and they have never run, so the `notifications`
 * collection holds nothing for them. Switched on as-is, the first tick would
 * treat every account that has ever existed as due: an onboarding nudge to
 * every inactive signup, and a freshly minted verification code and link to
 * every address that was never confirmed, some of them months old. Those sends
 * cannot be recalled, and a batch of unexpected mail to stale addresses is how
 * a sending domain earns a spam reputation — particularly one whose SPF, DKIM
 * and DMARC were only set up this week.
 *
 * So this writes the rows those sends *would* have written. `claim()` inserts
 * `{user_id, kind, key, sent_at}` and reads a duplicate-key error as "somebody
 * already has this", which is exactly what a pre-existing row produces. The
 * jobs then skip every historical account and fire only for genuinely new ones.
 *
 * Idempotent: re-running inserts nothing new, because it collides with its own
 * rows the same way.
 *
 * Sends no mail. Reads users, writes notifications, touches nothing else.
 *
 *   MONGODB_URI='...' node scripts/backfill-notifications.mjs --dry-run
 *   MONGODB_URI='...' node scripts/backfill-notifications.mjs --commit
 */
import { MongoClient } from 'mongodb';

const URI = process.env.MONGODB_URI;
const DB = process.env.MONGODB_DB || 'chatbucket_b2b';

// Must match src/services/notifications.ts. If a KIND_* constant there is
// renamed, the rows written here stop matching and the job sends anyway.
const KIND_MONTHLY_REPORT = 'monthly_report';
const KIND_ONBOARDING_NUDGE = 'onboarding_nudge';
const KIND_VERIFICATION_REMINDER = 'verification_reminder';

// The two jobs keyed 'once' — sent at most once per account, ever.
const ONCE_KINDS = [KIND_ONBOARDING_NUDGE, KIND_VERIFICATION_REMINDER];

const commit = process.argv.includes('--commit');
const dryRun = process.argv.includes('--dry-run');

if (!URI) {
  console.error('  MONGODB_URI is not set.');
  process.exit(2);
}
if (commit === dryRun) {
  console.error('  Pass exactly one of --dry-run or --commit.');
  process.exit(2);
}

/** Every month from the earliest account up to and including last month. */
function monthsToCover(earliest, now) {
  const keys = [];
  const cursor = new Date(Date.UTC(earliest.getUTCFullYear(), earliest.getUTCMonth(), 1));
  // Up to but excluding the current month: the month in progress has not been
  // reported yet and its report is a real, future send that should happen.
  const stop = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  while (cursor < stop) {
    keys.push(cursor.toISOString().slice(0, 7)); // YYYY-MM
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return keys;
}

const client = new MongoClient(URI);

try {
  await client.connect();
  const db = client.db(DB);
  const users = db.collection('users');
  const notifications = db.collection('notifications');

  // Closed accounts keep their row with a @deleted.invalid address and are
  // already excluded by the jobs, so there is nothing to suppress for them.
  const people = await users
    .find({ deleted_at: { $exists: false } }, { projection: { _id: 1, created_at: 1 } })
    .toArray();

  if (people.length === 0) {
    console.log('  no accounts found — nothing to backfill');
    process.exit(0);
  }

  const now = new Date();
  const earliest = people
    .map((p) => p.created_at)
    .filter(Boolean)
    .reduce((a, b) => (a < b ? a : b), now);
  const months = monthsToCover(earliest instanceof Date ? earliest : now, now);

  const rows = [];
  for (const person of people) {
    for (const kind of ONCE_KINDS) {
      rows.push({ user_id: person._id, kind, key: 'once', sent_at: now });
    }
    for (const key of months) {
      rows.push({ user_id: person._id, kind: KIND_MONTHLY_REPORT, key, sent_at: now });
    }
  }

  const existing = await notifications.countDocuments({});
  console.log(`  accounts            ${people.length}`);
  console.log(`  months covered      ${months.length}` +
              (months.length ? ` (${months[0]} … ${months[months.length - 1]})` : ' (none yet)'));
  console.log(`  rows to write       ${rows.length}`);
  console.log(`  notifications now   ${existing}`);

  if (dryRun) {
    console.log('\n  dry run — nothing written. Re-run with --commit to apply.');
    process.exit(0);
  }

  // Unordered so the whole batch is attempted: duplicates are the expected
  // outcome on a re-run, not a reason to stop.
  let inserted = 0;
  let duplicates = 0;
  const CHUNK = 1000;
  for (let i = 0; i < rows.length; i += CHUNK) {
    try {
      const res = await notifications.insertMany(rows.slice(i, i + CHUNK), { ordered: false });
      inserted += res.insertedCount;
    } catch (err) {
      inserted += err.result?.insertedCount ?? 0;
      const dupes = (err.writeErrors ?? []).filter((e) => e.err?.code === 11000).length;
      duplicates += dupes;
      const other = (err.writeErrors ?? []).length - dupes;
      if (other > 0) {
        console.error(`  ${other} non-duplicate write errors — stopping`);
        console.error(err.writeErrors?.find((e) => e.err?.code !== 11000)?.err);
        process.exit(1);
      }
    }
  }

  console.log(`\n  inserted            ${inserted}`);
  console.log(`  already present     ${duplicates}`);
  console.log(`  notifications total ${await notifications.countDocuments({})}`);
  console.log('\n  Done. The lifecycle jobs will now skip every account above.');
  console.log('  Enable the scheduler with NOTIFICATION_SCHEDULER_ENABLED=true.');
} finally {
  await client.close();
}
