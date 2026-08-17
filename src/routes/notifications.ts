/**
 * Operator-triggered email — announcements, maintenance notices and the runs.
 *
 * Ported from `app/routers/notifications.py`.
 *
 *   POST /notifications/announcement            press note / product news
 *   POST /notifications/maintenance             a maintenance window
 *   POST /notifications/monthly-reports         usage report for a month
 *   POST /notifications/onboarding-nudges       registered, never called the API
 *   POST /notifications/verification-reminders  registered, never verified
 *   POST /notifications/free-credit-reminders   trial window closing
 *
 * **Gated by `OPS_SECRET`, not a user session**: the caller is an operator or a
 * cron job, and nothing a customer can authenticate as should be able to mail
 * the entire customer base. Unset means 503 rather than falling open.
 *
 * Every broadcast takes either `testEmail` — send one copy there, record
 * nothing — or `confirm: true`. **There is no way to reach real customers by
 * leaving a field out.** That is the whole design of these bodies: the
 * dangerous action requires an affirmative statement, and the safe one is what
 * you get by accident.
 */
import { Router, type Request } from 'express';
import { z } from 'zod';

import { getSettings } from '../config.js';
import { asyncHandler } from '../errors.js';
import { requireSecret } from '../middleware/secret.js';
import * as email from '../services/email.js';
import * as notifications from '../services/notifications.js';

export const notificationsRouter = Router();

/**
 * A reference id that is safe to put in a log line.
 *
 * Constrained at the boundary rather than escaped at each log site: a value
 * containing a newline lets a caller write what looks like a separate,
 * legitimate entry into the log an operator later reads.
 */
const referenceId = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9._-]+$/, 'Use letters, digits, dot, underscore or hyphen only.');

/**
 * Either send one test copy, or say `confirm: true`. Never both, never neither.
 *
 * A broadcast with no explicit intent is the mistake this shape exists to make
 * impossible — "I thought it was a dry run" is not recoverable once mail is out.
 */
const broadcastGuard = {
  testEmail: z.string().email().nullish(),
  confirm: z.boolean().default(false),
};

function assertIntent(payload: { testEmail?: string | null; confirm: boolean }): void {
  if (!payload.testEmail && !payload.confirm) {
    throw new Error('Send `testEmail` to preview, or `confirm: true` to broadcast.');
  }
}

const AnnouncementRequest = z
  .object({
    subject: z.string().min(1).max(200),
    headline: z.string().min(1).max(200),
    heroTitle: z.string().max(200).nullish(),
    heroSubtitle: z.string().max(200).nullish(),
    summary: z.string().min(1).max(2000),
    highlights: z.array(z.string().max(300)).max(10).default([]),
    quote: z.string().max(500).nullish(),
    quoteAuthor: z.string().max(120).nullish(),
    category: z.string().max(60).nullish(),
    referenceId,
    verifiedOnly: z.boolean().default(true),
    ...broadcastGuard,
  })
  .strict()
  .refine((v) => Boolean(v.testEmail) || v.confirm, {
    message: 'Send `testEmail` to preview, or `confirm: true` to broadcast.',
  });

const MaintenanceRequest = z
  .object({
    subject: z.string().min(1).max(200),
    maintenanceType: z.string().max(120).nullish(),
    startsAt: z.coerce.date(),
    endsAt: z.coerce.date(),
    referenceId,
    verifiedOnly: z.boolean().default(false),
    ...broadcastGuard,
  })
  .strict()
  .refine((v) => Boolean(v.testEmail) || v.confirm, {
    message: 'Send `testEmail` to preview, or `confirm: true` to broadcast.',
  })
  .refine((v) => v.endsAt > v.startsAt, {
    message: 'The window must end after it starts.',
  });

const RunRequest = z.object({ confirm: z.literal(true) }).strict();

const MonthlyReportRequest = z
  .object({
    // "YYYY-MM": the month to report on, not the month it is sent in.
    month: z
      .string()
      .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use YYYY-MM.')
      .nullish(),
    confirm: z.literal(true),
  })
  .strict();

function guard(req: Request): void {
  requireSecret(
    req.get('X-Ops-Secret'),
    getSettings().OPS_SECRET,
    'Notification sending is not configured (OPS_SECRET unset).',
    'Invalid ops secret.',
  );
}

function preview(delivered: boolean, refId: string | null = null) {
  return {
    status: true,
    preview: true,
    message: 'Sent one copy to the test address. Nothing was recorded.',
    reference_id: refId,
    delivered,
  };
}

notificationsRouter.post(
  '/announcement',
  asyncHandler(async (req: Request, res) => {
    guard(req);
    const payload = AnnouncementRequest.parse(req.body);
    assertIntent(payload);

    const announcement = notifications.buildAnnouncement({
      subject: payload.subject,
      headline: payload.headline,
      heroTitle: payload.heroTitle ?? undefined,
      heroSubtitle: payload.heroSubtitle ?? undefined,
      summary: payload.summary,
      highlights: payload.highlights,
      quote: payload.quote ?? undefined,
      quoteAuthor: payload.quoteAuthor ?? undefined,
      category: payload.category ?? undefined,
      referenceId: payload.referenceId,
    });

    if (payload.testEmail) {
      const delivered = await email.sendAnnouncement(payload.testEmail, announcement);
      res.json(preview(delivered, payload.referenceId));
      return;
    }

    const result = await notifications.broadcastAnnouncement(
      announcement,
      payload.verifiedOnly,
    );
    res.json({ status: true, reference_id: payload.referenceId, data: result });
  }),
);

notificationsRouter.post(
  '/maintenance',
  asyncHandler(async (req: Request, res) => {
    guard(req);
    const payload = MaintenanceRequest.parse(req.body);
    assertIntent(payload);

    const window = notifications.buildMaintenanceWindow({
      subject: payload.subject,
      maintenanceType: payload.maintenanceType ?? undefined,
      start: payload.startsAt,
      end: payload.endsAt,
      referenceId: payload.referenceId,
    });

    if (payload.testEmail) {
      const delivered = await email.sendMaintenanceNotice(payload.testEmail, 'there', window);
      res.json(preview(delivered, payload.referenceId));
      return;
    }

    const result = await notifications.broadcastMaintenance(window, payload.verifiedOnly);
    res.json({ status: true, reference_id: payload.referenceId, data: result });
  }),
);

notificationsRouter.post(
  '/monthly-reports',
  asyncHandler(async (req: Request, res) => {
    guard(req);
    const payload = MonthlyReportRequest.parse(req.body);

    // The month to report on. Omitted means the one that just ended, which is
    // what a run on the 1st wants.
    let monthStart: Date | undefined;
    if (payload.month) {
      const [year, month] = payload.month.split('-').map(Number);
      monthStart = new Date(Date.UTC(year as number, (month as number) - 1, 1));
    }

    const result = await notifications.sendMonthlyReports(monthStart);
    res.json({ status: true, month: payload.month ?? null, data: result });
  }),
);

notificationsRouter.post(
  '/onboarding-nudges',
  asyncHandler(async (req: Request, res) => {
    guard(req);
    RunRequest.parse(req.body);
    res.json({ status: true, data: await notifications.sendOnboardingNudges() });
  }),
);

notificationsRouter.post(
  '/verification-reminders',
  asyncHandler(async (req: Request, res) => {
    guard(req);
    RunRequest.parse(req.body);
    res.json({ status: true, data: await notifications.sendVerificationReminders() });
  }),
);

notificationsRouter.post(
  '/free-credit-reminders',
  asyncHandler(async (req: Request, res) => {
    guard(req);
    RunRequest.parse(req.body);
    res.json({ status: true, data: await notifications.sendFreeCreditReminders() });
  }),
);
