/**
 * Lifecycle email jobs — the sends that are not triggered by a request.
 *
 * Ported from `app/notifications.py`. Six of the designed templates have no
 * single moment in a request cycle that produces them: a monthly report is due
 * when a month ends, a credit reminder when a window is closing, an
 * announcement when someone decides to make one.
 *
 * Two rules apply to every job here, because the failure modes of bulk mail are
 * worse than the failure modes of one-off mail:
 *
 * **Send once.** Each send claims a row in `notifications` first, under a unique
 * index on (user, kind, key). A job that is retried, run twice by an overlapping
 * schedule, or re-run by hand skips whoever already has the row. The claim is
 * taken *before* the send and released again if the send fails, so a mail outage
 * does not permanently mark a customer as notified.
 *
 * **Send slowly.** Recipients are worked through in bounded batches
 * (`BROADCAST_CONCURRENCY`), not fanned out at once. Opening one SMTP connection
 * per customer in parallel is the quickest route to a throttled sending domain,
 * and a report run over a large base would do exactly that.
 */
import { MongoServerError, type ObjectId } from 'mongodb';

import { getSettings } from '../config.js';
import {
  creditLedgerCollection,
  jobRunsCollection,
  notificationsCollection,
  usageCollection,
  usersCollection,
} from '../database.js';
import * as templates from '../emailtemplates.js';
import { logger } from '../logger.js';
import * as credits from './credits.js';
import * as email from './email.js';
import * as reports from './reports.js';
import * as verification from './verification.js';

/** `kind` values in the notifications collection. */
export const KIND_MONTHLY_REPORT = 'monthly_report';
export const KIND_ONBOARDING_NUDGE = 'onboarding_nudge';
export const KIND_VERIFICATION_REMINDER = 'verification_reminder';
export const KIND_FREE_CREDITS_EXPIRING = 'free_credits_expiring';
export const KIND_ANNOUNCEMENT = 'announcement';
export const KIND_MAINTENANCE = 'maintenance';

/** What a job did, in the shape an operator needs to read it. */
export interface RunResult {
  considered: number;
  sent: number;
  skipped: number;
  failed: number;
  truncated: boolean;
}

function emptyResult(considered = 0): RunResult {
  return { considered, sent: 0, skipped: 0, failed: 0, truncated: false };
}

type Outcome = 'sent' | 'skipped' | 'failed';

// --- Send-once --------------------------------------------------------------

/** Reserve one send. False means somebody already has it. */
async function claim(userId: ObjectId, kind: string, key: string): Promise<boolean> {
  try {
    await notificationsCollection().insertOne({
      user_id: userId,
      kind,
      key,
      sent_at: new Date(),
    });
    return true;
  } catch (err) {
    if (err instanceof MongoServerError && err.code === 11000) return false;
    throw err;
  }
}

/** Give the claim back after a failed send, so a retry can take it. */
async function release(userId: ObjectId, kind: string, key: string): Promise<void> {
  await notificationsCollection().deleteOne({ user_id: userId, kind, key });
}

/** Claim, send, and unclaim on failure. */
async function sendOnce(
  userId: ObjectId,
  kind: string,
  key: string,
  send: () => Promise<boolean>,
): Promise<Outcome> {
  if (!(await claim(userId, kind, key))) return 'skipped';

  let delivered = false;
  try {
    delivered = await send();
  } catch (err) {
    logger.error('%s to %s raised: %s', kind, String(userId), err instanceof Error ? err.message : err);
  }
  if (!delivered) {
    await release(userId, kind, key);
    return 'failed';
  }
  return 'sent';
}

/** Work through `items` `BROADCAST_CONCURRENCY` at a time. */
async function runBatched<T>(
  items: T[],
  handler: (item: T) => Promise<Outcome>,
): Promise<RunResult> {
  const size = getSettings().BROADCAST_CONCURRENCY;
  const result = emptyResult(items.length);

  for (let start = 0; start < items.length; start += size) {
    const batch = items.slice(start, start + size);
    const outcomes = await Promise.allSettled(batch.map((item) => handler(item)));
    for (const outcome of outcomes) {
      if (outcome.status === 'rejected') {
        logger.error('notification batch item failed: %s', String(outcome.reason));
        result.failed += 1;
      } else if (outcome.value === 'sent') {
        result.sent += 1;
      } else if (outcome.value === 'skipped') {
        result.skipped += 1;
      } else {
        result.failed += 1;
      }
    }
  }
  return result;
}

/**
 * Accounts to mail, capped at `BROADCAST_MAX_RECIPIENTS`.
 *
 * `verifiedOnly` is the safer default for anything promotional: an address
 * nobody has confirmed is as likely to be a typo of a stranger's inbox as it is
 * to be the customer's.
 */
async function recipients(
  verifiedOnly: boolean,
  extraQuery: Record<string, unknown> = {},
): Promise<[Array<Record<string, unknown>>, boolean]> {
  const limit = getSettings().BROADCAST_MAX_RECIPIENTS;

  // A closed account keeps its row (invoices point at it) with the address
  // replaced by a `@deleted.invalid` placeholder. Mailing those is a bounce per
  // closed account, every broadcast, straight into the sender reputation.
  const query: Record<string, unknown> = { deleted_at: { $exists: false }, ...extraQuery };
  if (verifiedOnly) query['email_verified'] = true;

  // One over the cap, so "exactly at the cap" is distinguishable from "more
  // than the cap" without a second count query.
  const docs = await usersCollection()
    .find(query, { projection: { email: 1, name: 1, plan: 1, created_at: 1 } })
    .limit(limit + 1)
    .toArray();

  return docs.length > limit ? [docs.slice(0, limit), true] : [docs, false];
}

// --- Broadcasts -------------------------------------------------------------

/**
 * Strip anything that could forge a log line.
 *
 * The schemas already reject control characters in a reference id, but these
 * builders are callable directly — from a script, or a future job — so the log
 * site does not depend on the caller having come through the API.
 */
function logSafe(value: unknown): string {
  return String(value)
    .split('')
    .filter((c) => c >= ' ' && c !== '\x7f')
    .join('')
    .slice(0, 64);
}

export function buildAnnouncement(input: {
  subject: string;
  headline: string;
  heroTitle?: string;
  heroSubtitle?: string;
  summary: string;
  highlights?: string[];
  quote?: string;
  quoteAuthor?: string;
  category?: string;
  referenceId: string;
  when?: Date;
}): templates.Context {
  const moment = input.when ?? new Date();
  return {
    subject: input.subject,
    headline: input.headline,
    hero_title: input.heroTitle ?? input.headline,
    hero_subtitle: input.heroSubtitle ?? '',
    summary: input.summary,
    highlights: input.highlights ?? [],
    quote: input.quote ?? '',
    quote_author: input.quoteAuthor ?? '',
    category: input.category ?? 'Product',
    date: templates.fmtDate(moment),
    time: templates.fmtTime(moment),
    reference_id: input.referenceId,
  };
}

export function buildMaintenanceWindow(input: {
  subject: string;
  maintenanceType?: string;
  start: Date;
  end: Date;
  referenceId: string;
}): templates.Context {
  return {
    subject: input.subject,
    maintenance_type: input.maintenanceType ?? 'Scheduled maintenance',
    start_date: templates.fmtShortDate(input.start),
    start_time: templates.fmtTime(input.start),
    end_date: templates.fmtShortDate(input.end),
    end_time: templates.fmtTime(input.end),
    reference_id: input.referenceId,
  };
}

export async function broadcastAnnouncement(
  announcement: templates.Context,
  verifiedOnly = true,
): Promise<RunResult> {
  const [people, truncated] = await recipients(verifiedOnly);
  const key = String(announcement['reference_id']);

  const result = await runBatched(people, (person) =>
    sendOnce(person['_id'] as ObjectId, KIND_ANNOUNCEMENT, key, () =>
      email.sendAnnouncement(String(person['email'] ?? ''), announcement),
    ),
  );
  result.truncated = truncated;
  logger.info('announcement %s: %j', logSafe(key), result);
  return result;
}

export async function broadcastMaintenance(
  window: templates.Context,
  verifiedOnly = false,
): Promise<RunResult> {
  const [people, truncated] = await recipients(verifiedOnly);
  const key = String(window['reference_id']);

  const result = await runBatched(people, (person) =>
    sendOnce(person['_id'] as ObjectId, KIND_MAINTENANCE, key, () =>
      email.sendMaintenanceNotice(
        String(person['email'] ?? ''),
        person['name'] as string,
        window,
      ),
    ),
  );
  result.truncated = truncated;
  logger.info('maintenance notice %s: %j', logSafe(key), result);
  return result;
}

// --- Scheduled jobs ---------------------------------------------------------

/**
 * Send every account its report for a month.
 *
 * Defaults to the month that has just ended, which is what a run on the 1st
 * wants; pass `monthStart` to re-send an older one.
 */
export async function sendMonthlyReports(monthStart?: Date): Promise<RunResult> {
  let start = monthStart;
  if (!start) {
    const [thisMonth] = reports.monthWindow(new Date());
    [start] = reports.previousMonthWindow(thisMonth);
  }
  const [begin] = reports.monthWindow(start);
  const key = begin.toISOString().slice(0, 7); // YYYY-MM

  const [people, truncated] = await recipients(false);

  const result = await runBatched(people, async (person): Promise<Outcome> => {
    const report = await reports.buildMonthlyReport(person, begin);
    if (!report['has_usage']) {
      // A report of zeroes is not information, and an account that did not use
      // the service in a month did not opt into a monthly email about not
      // using the service.
      return 'skipped';
    }
    return sendOnce(person['_id'] as ObjectId, KIND_MONTHLY_REPORT, key, () =>
      email.sendMonthlyReport(
        String(person['email'] ?? ''),
        person['name'] as string,
        report,
      ),
    );
  });

  result.truncated = truncated;
  logger.info('monthly reports for %s: %j', key, result);
  return result;
}

/** Nudge accounts that registered a while ago and never called the API. */
export async function sendOnboardingNudges(now = new Date()): Promise<RunResult> {
  const s = getSettings();
  const cutoff = new Date(now.getTime() - s.ONBOARDING_NUDGE_AFTER_DAYS * 86_400_000);
  const [people, truncated] = await recipients(false, { created_at: { $lte: cutoff } });

  const result = await runBatched(people, async (person): Promise<Outcome> => {
    // One record is enough to disqualify them; `findOne` stops there rather
    // than counting a busy account's whole history.
    const used = await usageCollection().findOne(
      { user_id: person['_id'] },
      { projection: { _id: 1 } },
    );
    if (used) return 'skipped';

    return sendOnce(person['_id'] as ObjectId, KIND_ONBOARDING_NUDGE, 'once', () =>
      email.sendOnboardingNudge(String(person['email'] ?? ''), person['name'] as string),
    );
  });

  result.truncated = truncated;
  logger.info('onboarding nudges: %j', result);
  return result;
}

/**
 * Chase accounts that registered but never confirmed their address.
 *
 * With `REQUIRE_EMAIL_VERIFICATION` on, an unverified account is a stuck
 * account: it can sign in, it has been granted its signup credits, and it can do
 * nothing with them. Nothing else in the system chases those.
 *
 * A **fresh** code and link are minted. The pair issued at signup is long dead
 * by now — the code lasts ten minutes — and re-sending a dead credential is
 * worse than sending nothing, because the customer tries it and concludes the
 * product is broken.
 *
 * Sent once per account, ever. Somebody who has decided not to verify does not
 * need reminding weekly.
 */
export async function sendVerificationReminders(now = new Date()): Promise<RunResult> {
  const s = getSettings();
  const cutoff = new Date(now.getTime() - s.VERIFICATION_REMINDER_AFTER_HOURS * 3_600_000);

  const [people, truncated] = await recipients(false, {
    created_at: { $lte: cutoff },
    email_verified: { $ne: true },
  });

  const result = await runBatched(people, (person) =>
    sendOnce(person['_id'] as ObjectId, KIND_VERIFICATION_REMINDER, 'once', async () => {
      const [token, code] = await verification.issueCredentials(person['_id'] as ObjectId);
      return email.sendVerificationEmail(
        String(person['email'] ?? ''),
        token,
        code,
        person['name'] as string,
      );
    }),
  );

  result.truncated = truncated;
  logger.info('verification reminders: %j', result);
  return result;
}

/**
 * Remind accounts whose signup bonus is nearing the end of its window.
 *
 * Nothing here expires credits — the product line is that credits do not expire,
 * and this job does not change that. What it counts down is the window the
 * welcome email promised (`FREE_CREDIT_VALIDITY_DAYS`), measured from when the
 * bonus was granted, and it only writes to anyone who still has a balance.
 */
export async function sendFreeCreditReminders(now = new Date()): Promise<RunResult> {
  const s = getSettings();
  const validityMs = s.FREE_CREDIT_VALIDITY_DAYS * 86_400_000;

  // Granted early enough that the window closes within the reminder period, but
  // not so long ago that it has already closed.
  const newest = new Date(
    now.getTime() - (validityMs - s.FREE_CREDIT_REMINDER_DAYS * 86_400_000),
  );
  const oldest = new Date(now.getTime() - validityMs);

  const grants = await creditLedgerCollection()
    .find({ kind: credits.KIND_SIGNUP_BONUS, created_at: { $gt: oldest, $lte: newest } })
    .limit(s.BROADCAST_MAX_RECIPIENTS)
    .toArray();

  const result = await runBatched(grants, async (grant): Promise<Outcome> => {
    const user = await usersCollection().findOne({
      _id: grant['user_id'] as ObjectId,
      deleted_at: { $exists: false },
    });
    if (!user) return 'skipped';

    const grantedAt = grant['created_at'] as Date;
    const expiresAt = new Date(grantedAt.getTime() + validityMs);
    // Rounded up: with 30 hours left, "expires in 1 day" is the honest reading
    // and "in 2 days" is not.
    const daysRemaining = Math.max(
      Math.floor((expiresAt.getTime() - now.getTime() + 23 * 3_600_000) / 86_400_000),
      1,
    );

    if ((await credits.balanceUnits(user['_id'] as ObjectId)) <= 0) {
      // Nothing left to spend, so nothing to be reminded about.
      return 'skipped';
    }

    return sendOnce(
      user['_id'] as ObjectId,
      KIND_FREE_CREDITS_EXPIRING,
      expiresAt.toISOString().slice(0, 10),
      () =>
        email.sendFreeCreditsExpiring(String(user['email'] ?? ''), user['name'] as string, {
          days_remaining: daysRemaining,
          expiry_date: templates.fmtDate(expiresAt),
          expiry_time: templates.fmtTime(expiresAt),
        }),
    );
  });

  logger.info('free credit reminders: %j', result);
  return result;
}

// --- Scheduling -------------------------------------------------------------
//
// The recurring jobs run on a timer inside the app rather than from an external
// cron, because this service deploys as a single component and adding a
// scheduled-job component to run three curls is more moving parts than the
// problem deserves.
//
// Two things make that safe. The app runs several workers, each with its own
// copy of this loop, so every run is claimed in `job_runs` under a unique
// (job, period) index — one worker wins, the rest skip. And the claim is
// released if the run throws, so a transient failure is retried on the next tick
// rather than marking the period done for good.

export const JOB_MONTHLY_REPORT = 'monthly_reports';
export const JOB_FREE_CREDIT_REMINDERS = 'free_credit_reminders';
export const JOB_ONBOARDING_NUDGES = 'onboarding_nudges';
export const JOB_VERIFICATION_REMINDERS = 'verification_reminders';

/**
 * How long after the configured day the monthly report will still go out.
 *
 * It exists so an outage on the 1st does not silently skip a month — and it is
 * bounded so that *enabling* the scheduler late in the month does not fire a
 * surprise retroactive send to the whole customer base.
 */
const MONTHLY_CATCHUP_DAYS = 7;

/** Reserve one job for one period. False means another worker has it. */
async function claimRun(job: string, period: string): Promise<boolean> {
  try {
    await jobRunsCollection().insertOne({ job, period, started_at: new Date() });
    return true;
  } catch (err) {
    if (err instanceof MongoServerError && err.code === 11000) return false;
    throw err;
  }
}

async function finishRun(job: string, period: string, result: RunResult): Promise<void> {
  await jobRunsCollection().updateOne(
    { job, period },
    { $set: { finished_at: new Date(), result } },
  );
}

/** Hand the period back so the next tick retries it. */
async function releaseRun(job: string, period: string): Promise<void> {
  await jobRunsCollection().deleteOne({ job, period });
}

/** Claim, run, record. Null means somebody else had it, or it failed. */
async function runClaimed(
  job: string,
  period: string,
  run: () => Promise<RunResult>,
): Promise<RunResult | null> {
  if (!(await claimRun(job, period))) return null;

  let result: RunResult;
  try {
    result = await run();
  } catch (err) {
    // Released rather than left claimed: a Mongo blip during the monthly run
    // must not mean nobody gets a report this month.
    logger.error(
      'scheduled job %s (%s) failed, will retry: %s',
      job,
      period,
      err instanceof Error ? err.message : err,
    );
    await releaseRun(job, period);
    return null;
  }
  await finishRun(job, period, result);
  logger.info('scheduled job %s (%s): %j', job, period, result);
  return result;
}

/**
 * The (job, period) pairs eligible right now, in the display timezone.
 *
 * Eligibility is a pure function of the clock; whether a job has *already* run
 * for its period is the claim's business, not this function's.
 */
export function dueJobs(local: { year: number; month: number; day: number; hour: number }): Array<[string, string]> {
  const s = getSettings();
  if (local.hour < s.NOTIFICATION_SCHEDULER_HOUR) return [];

  const pad = (n: number) => String(n).padStart(2, '0');
  const today = `${local.year}-${pad(local.month)}-${pad(local.day)}`;

  const due: Array<[string, string]> = [
    [JOB_FREE_CREDIT_REMINDERS, today],
    [JOB_ONBOARDING_NUDGES, today],
    [JOB_VERIFICATION_REMINDERS, today],
  ];

  // The monthly report's period is the month it *covers*, not the month it is
  // sent in, so claiming it on the 1st cannot be re-claimed on the 2nd.
  const startDay = s.NOTIFICATION_MONTHLY_REPORT_DAY;
  if (local.day >= startDay && local.day < startDay + MONTHLY_CATCHUP_DAYS) {
    const firstOfThisMonth = new Date(Date.UTC(local.year, local.month - 1, 1));
    const lastMonth = new Date(firstOfThisMonth.getTime() - 86_400_000);
    due.push([JOB_MONTHLY_REPORT, lastMonth.toISOString().slice(0, 7)]);
  }
  return due;
}

/** Run whatever is due and not already claimed. Safe to call any time. */
export async function runDueJobs(
  local = templates.localNow(),
): Promise<Record<string, unknown>> {
  const runners: Record<string, (period: string) => Promise<RunResult>> = {
    [JOB_FREE_CREDIT_REMINDERS]: () => sendFreeCreditReminders(),
    [JOB_ONBOARDING_NUDGES]: () => sendOnboardingNudges(),
    [JOB_VERIFICATION_REMINDERS]: () => sendVerificationReminders(),
    // The period *is* the month to report on, so a catch-up run on the 3rd
    // still reports the right month rather than whatever "last month" means at
    // the moment it happens to execute.
    [JOB_MONTHLY_REPORT]: (period) => {
      const [year, month] = period.split('-').map(Number);
      return sendMonthlyReports(new Date(Date.UTC(year as number, (month as number) - 1, 1)));
    },
  };

  const ran: Record<string, unknown> = {};
  for (const [job, period] of dueJobs(local)) {
    const result = await runClaimed(job, period, () => runners[job]!(period));
    if (result !== null) ran[job] = { period, ...result };
  }
  return ran;
}

let stopped = false;

/** Stop the loop. Used by tests and by graceful shutdown. */
export function stopScheduler(): void {
  stopped = true;
}

/**
 * Wake periodically and run anything due. Started from the app entry point.
 *
 * Never exits on error: a scheduler that dies on one bad tick is worse than no
 * scheduler, because it looks like one.
 */
export async function schedulerLoop(): Promise<void> {
  const s = getSettings();
  const interval = s.NOTIFICATION_SCHEDULER_INTERVAL_SECONDS;
  stopped = false;

  logger.info(
    'notification scheduler on: checking every %ds, daily jobs at %s:00 %s, monthly report on day %d',
    interval,
    String(s.NOTIFICATION_SCHEDULER_HOUR).padStart(2, '0'),
    s.DISPLAY_TIMEZONE,
    s.NOTIFICATION_MONTHLY_REPORT_DAY,
  );

  while (!stopped) {
    // Sleeps first, so a restart loop cannot hammer the jobs and so a deploy
    // does not fire mail the instant it boots.
    await new Promise((resolve) => setTimeout(resolve, interval * 1000).unref());
    if (stopped) break;
    try {
      await runDueJobs();
    } catch (err) {
      logger.error(
        'notification scheduler tick failed: %s',
        err instanceof Error ? err.message : err,
      );
    }
  }
}
