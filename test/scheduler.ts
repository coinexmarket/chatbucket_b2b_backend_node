export {}; // Marks this file a module, so top-level `await` below is allowed.

// Guard first: the suites drop their database, and MONGODB_URI comes from
// .env, which may point at production.
await import('./local-only.js');

/**
 * The scheduler and the lifecycle jobs.
 *
 * The dangerous failure here is not "no email sent" — it is **the same email
 * sent twice**, to the whole customer base. Two mechanisms prevent that and both
 * are tested directly against MongoDB, because both are unique indexes:
 *
 *   - send-once, on (user, kind, key) in `notifications`;
 *   - job locking, on (job, period) in `job_runs`.
 *
 * The second dangerous failure is a claim that is never released: a Mongo blip
 * during the monthly run must not mean nobody gets a report this month. So the
 * release-on-failure path is tested too.
 */
process.env['ENVIRONMENT'] = 'development';
process.env['JWT_SECRET'] = 'scheduler-test-secret';
process.env['MONGODB_DB'] = 'chatbucket_b2b_nodetest';
process.env['EMAIL_BACKEND'] = 'memory';
process.env['SMS_BACKEND'] = 'memory';
process.env['DISPLAY_TIMEZONE'] = 'Asia/Kolkata';
process.env['NOTIFICATION_SCHEDULER_HOUR'] = '6';
process.env['NOTIFICATION_MONTHLY_REPORT_DAY'] = '1';
process.env['SIGNUP_BONUS_CREDITS'] = '100';

import { ObjectId } from 'mongodb';

const db = await import('../src/database.js');
const notifications = await import('../src/services/notifications.js');
const reports = await import('../src/services/reports.js');
const credits = await import('../src/services/credits.js');
const email = await import('../src/services/email.js');
const { toBson } = await import('../src/money.js');

let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail ? `  ${detail}` : ''}`);
  }
}

async function reset(): Promise<void> {
  await Promise.all([
    db.usersCollection().deleteMany({}),
    db.usageCollection().deleteMany({}),
    db.notificationsCollection().deleteMany({}),
    db.jobRunsCollection().deleteMany({}),
    db.creditAccountsCollection().deleteMany({}),
    db.creditLedgerCollection().deleteMany({}),
  ]);
}

console.log('\nScheduler and lifecycle jobs\n');

await db.connect();
await reset();
await db.ensureIndexes();

try {
  // --- Which jobs are due, as a pure function of the clock -------------------

  check(
    'nothing is due before the configured hour',
    notifications.dueJobs({ year: 2026, month: 8, day: 3, hour: 5 }).length === 0,
  );

  // Day 10 is outside the monthly catch-up window, so only the daily jobs run.
  const daily = notifications.dueJobs({ year: 2026, month: 8, day: 10, hour: 6 });
  check('the daily jobs are due after it', daily.length === 3, JSON.stringify(daily));
  check(
    'and the monthly report is not among them outside its window',
    !daily.some(([job]) => job === notifications.JOB_MONTHLY_REPORT),
    JSON.stringify(daily),
  );

  const firstOfMonth = notifications.dueJobs({ year: 2026, month: 8, day: 1, hour: 7 });
  const monthly = firstOfMonth.find(([job]) => job === notifications.JOB_MONTHLY_REPORT);
  check('...but it is on the 1st', monthly !== undefined);
  check(
    'and it reports the month that just ended, not the current one',
    monthly?.[1] === '2026-07',
    String(monthly?.[1]),
  );

  // An outage on the 1st must not silently skip a month — but enabling the
  // scheduler late in the month must not fire a surprise retroactive send.
  const catchUp = notifications.dueJobs({ year: 2026, month: 8, day: 5, hour: 7 });
  check(
    'a missed run is caught up within the window',
    catchUp.some(([job, period]) => job === notifications.JOB_MONTHLY_REPORT && period === '2026-07'),
    JSON.stringify(catchUp),
  );
  const tooLate = notifications.dueJobs({ year: 2026, month: 8, day: 20, hour: 7 });
  check(
    'but not weeks later, which would be a surprise mailshot',
    !tooLate.some(([job]) => job === notifications.JOB_MONTHLY_REPORT),
    JSON.stringify(tooLate),
  );

  // The year boundary is where naive month arithmetic breaks.
  const january = notifications.dueJobs({ year: 2026, month: 1, day: 1, hour: 7 });
  check(
    'the year boundary rolls correctly',
    january.some(([job, period]) => job === notifications.JOB_MONTHLY_REPORT && period === '2025-12'),
    JSON.stringify(january),
  );
  const march = notifications.dueJobs({ year: 2026, month: 3, day: 1, hour: 7 });
  check(
    'and February is handled',
    march.some(([job, period]) => job === notifications.JOB_MONTHLY_REPORT && period === '2026-02'),
    JSON.stringify(march),
  );

  // --- Month windows ---------------------------------------------------------

  const [begin, finish] = reports.monthWindow(new Date('2026-02-14T10:00:00Z'));
  check('a month window starts on the 1st', begin.toISOString().startsWith('2026-02-01'), begin.toISOString());
  check(
    'and ends at the start of the next month, whatever its length',
    finish.toISOString().startsWith('2026-03-01'),
    finish.toISOString(),
  );
  const [prevBegin] = reports.previousMonthWindow(begin);
  check('the previous window steps back one month', prevBegin.toISOString().startsWith('2026-01-01'), prevBegin.toISOString());

  // --- Send-once -------------------------------------------------------------

  const userId = new ObjectId();
  await db.usersCollection().insertOne({
    _id: userId,
    email: 'nudge@example.com',
    name: 'Ada Lovelace',
    plan: 'starter',
    email_verified: true,
    // Old enough to qualify for the nudge.
    created_at: new Date(Date.now() - 30 * 86_400_000),
  });

  email.outbox.length = 0;
  let result = await notifications.sendOnboardingNudges();
  check('an idle account is nudged', result.sent === 1, JSON.stringify(result));
  check('and one email went out', email.outbox.length === 1, String(email.outbox.length));

  email.outbox.length = 0;
  result = await notifications.sendOnboardingNudges();
  check('running the job again sends nothing', result.sent === 0, JSON.stringify(result));
  check('it is recorded as skipped, not failed', result.skipped === 1, JSON.stringify(result));
  check('and no second email went out', email.outbox.length === 0, String(email.outbox.length));

  // An account that has used the service is not "idle" and must not be nudged.
  const activeId = new ObjectId();
  await db.usersCollection().insertOne({
    _id: activeId,
    email: 'active@example.com',
    name: 'Grace',
    created_at: new Date(Date.now() - 30 * 86_400_000),
  });
  await db.usageCollection().insertOne({
    user_id: activeId,
    service: 'tts_offline',
    cost: toBson('0.78'),
    quantity: 1000,
    created_at: new Date(),
  });

  email.outbox.length = 0;
  result = await notifications.sendOnboardingNudges();
  check('an account that has called the API is not nudged', result.sent === 0, JSON.stringify(result));

  // A failed send releases the claim, so a retry can take it. Otherwise a mail
  // outage would permanently mark a customer as notified.
  await db.notificationsCollection().deleteMany({});
  const failing = new ObjectId();
  await db.usersCollection().insertOne({
    _id: failing,
    // No address: sendEmail refuses and returns false.
    email: '',
    name: 'No Address',
    created_at: new Date(Date.now() - 30 * 86_400_000),
  });
  result = await notifications.sendOnboardingNudges();
  check('a failed send is counted as failed', result.failed >= 1, JSON.stringify(result));
  const leftover = await db.notificationsCollection().countDocuments({ user_id: failing });
  check('and its claim is released for a retry', leftover === 0, String(leftover));
  await db.usersCollection().deleteOne({ _id: failing });

  // --- Monthly reports -------------------------------------------------------

  await db.notificationsCollection().deleteMany({});
  const lastMonth = reports.previousMonthWindow(reports.monthWindow(new Date())[0])[0];

  // Usage inside the reported month, so the account has something to report.
  await db.usageCollection().insertOne({
    user_id: activeId,
    service: 'stt_streaming',
    label: 'Speech-to-Text (streaming)',
    cost: toBson('12.50'),
    quantity: 24,
    created_at: new Date(lastMonth.getTime() + 5 * 86_400_000),
  });

  email.outbox.length = 0;
  result = await notifications.sendMonthlyReports(lastMonth);
  check('an account with usage gets a report', result.sent === 1, JSON.stringify(result));
  check(
    'an account with none is skipped, not sent a page of zeroes',
    result.skipped >= 1,
    JSON.stringify(result),
  );
  const report = email.outbox[0];
  check('the report renders as HTML', typeof report?.html === 'string' && report.html.length > 0);
  check(
    'and no placeholder survives into it',
    !/\{\{[^}]+\}\}/.test(report?.html ?? ''),
    (report?.html ?? '').match(/\{\{[^}]+\}\}/)?.[0] ?? '',
  );

  email.outbox.length = 0;
  result = await notifications.sendMonthlyReports(lastMonth);
  check('re-running the month sends nothing', result.sent === 0, JSON.stringify(result));

  // --- Job locking -----------------------------------------------------------

  await db.jobRunsCollection().deleteMany({});
  await db.notificationsCollection().deleteMany({});

  // Two workers waking on the same tick: exactly one must run each job.
  const [runA, runB] = await Promise.all([
    notifications.runDueJobs({ year: 2026, month: 8, day: 3, hour: 7 }),
    notifications.runDueJobs({ year: 2026, month: 8, day: 3, hour: 7 }),
  ]);
  const claimedBy = (job: string) =>
    (job in (runA as object) ? 1 : 0) + (job in (runB as object) ? 1 : 0);
  check(
    'of two workers on one tick, exactly one runs each job',
    claimedBy(notifications.JOB_ONBOARDING_NUDGES) === 1,
    JSON.stringify({ runA, runB }),
  );

  const runs = await db.jobRunsCollection().countDocuments({
    job: notifications.JOB_ONBOARDING_NUDGES,
    period: '2026-08-03',
  });
  check('and the period is recorded exactly once', runs === 1, String(runs));

  const again = await notifications.runDueJobs({ year: 2026, month: 8, day: 3, hour: 7 });
  check(
    'a later tick in the same period does nothing',
    Object.keys(again).length === 0,
    JSON.stringify(again),
  );

  const nextDay = await notifications.runDueJobs({ year: 2026, month: 8, day: 4, hour: 7 });
  check(
    'but the next day is a new period and runs again',
    Object.keys(nextDay).length > 0,
    JSON.stringify(nextDay),
  );

  const finished = await db.jobRunsCollection().findOne({
    job: notifications.JOB_ONBOARDING_NUDGES,
    period: '2026-08-03',
  });
  check('a finished run records its outcome', finished?.['finished_at'] instanceof Date);
  check('including what it did', typeof finished?.['result'] === 'object');

  // --- Free-credit reminders -------------------------------------------------

  await db.notificationsCollection().deleteMany({});
  const trialId = new ObjectId();
  await db.usersCollection().insertOne({
    _id: trialId,
    email: 'trial@example.com',
    name: 'Trial User',
    created_at: new Date(),
  });
  await credits.grant(trialId, credits.toUnits('100'), credits.KIND_SIGNUP_BONUS, 'Welcome credits');
  // Backdate the grant so its window is closing.
  await db.creditLedgerCollection().updateOne(
    { user_id: trialId },
    { $set: { created_at: new Date(Date.now() - 25 * 86_400_000) } },
  );

  email.outbox.length = 0;
  result = await notifications.sendFreeCreditReminders();
  check('a closing trial window is reminded', result.sent === 1, JSON.stringify(result));

  // Nothing to spend means nothing to be reminded about.
  await db.notificationsCollection().deleteMany({});
  await db.creditAccountsCollection().updateOne(
    { user_id: trialId },
    { $set: { balance_units: 0 } },
  );
  email.outbox.length = 0;
  result = await notifications.sendFreeCreditReminders();
  check('a spent balance is not reminded', result.sent === 0, JSON.stringify(result));
} finally {
  await reset();
  await db.disconnect();
}

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
