/**
 * Settings — the ONE module that reads `process.env`.
 *
 * Ported from `app/config.py`. Everything else imports `getSettings()`, so a
 * value can be renamed, defaulted or validated in one place instead of being
 * read with `process.env.X ?? 'guess'` in twenty. Reading env vars directly
 * anywhere else in this codebase is a bug.
 *
 * Validation happens once, at boot, and a bad value **stops the process**
 * rather than surfacing as a confusing failure on the first request that
 * happens to need it. `JWT_SECRET` in production is the sharp example: a
 * service that silently falls back to a dev secret is a service anybody can
 * mint tokens for.
 */
import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

/** `"1"`/`"true"`/`"yes"`/`"on"` are all true; anything else is false. */
const boolish = (fallback: boolean) =>
  z
    .string()
    .optional()
    .transform((v) =>
      v === undefined || v === ''
        ? fallback
        : ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase()),
    );

const intish = (fallback: number, min?: number, max?: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? fallback : Number(v)))
    .pipe(
      (() => {
        let n = z.number().int();
        if (min !== undefined) n = n.min(min);
        if (max !== undefined) n = n.max(max);
        return n;
      })(),
    );

const str = (fallback = '') =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined ? fallback : v));

const Schema = z.object({
  ENVIRONMENT: str('development'),
  LOG_LEVEL: str('INFO'),
  PORT: intish(8001, 1, 65535),

  // --- Database -----------------------------------------------------------
  MONGODB_URI: str('mongodb://127.0.0.1:27017'),
  MONGODB_DB: str('chatbucket_b2b'),
  MONGODB_BLOG_DB: str('chatbucket'),

  // --- Tokens -------------------------------------------------------------
  JWT_SECRET: str('dev-secret-change-me'),
  JWT_ALGORITHM: str('HS256'),
  ACCESS_TOKEN_EXPIRE_MINUTES: intish(60 * 24, 1),
  REFRESH_TOKEN_EXPIRE_DAYS: intish(30, 1),

  // --- Verification -------------------------------------------------------
  REQUIRE_EMAIL_VERIFICATION: boolish(false),
  VERIFICATION_TOKEN_EXPIRE_HOURS: intish(48, 1),
  EMAIL_OTP_EXPIRE_MINUTES: intish(10, 1, 60),
  EMAIL_OTP_MAX_ATTEMPTS: intish(5, 1, 20),
  // Short by design: a reset link is a password in the post. Long enough to
  // find the mail, short enough that one sitting in an abandoned inbox is not
  // still usable next week.
  RESET_TOKEN_EXPIRE_MINUTES: intish(60, 1),

  // --- Credits ------------------------------------------------------------
  // Granted on signup. A string, not a number: it is an exact money amount and
  // must not go anywhere near a binary float on the way in.
  SIGNUP_BONUS_CREDITS: str('100'),
  FREE_CREDIT_VALIDITY_DAYS: intish(30, 1),
  // Whether a metered call is refused when the balance cannot cover it. Off
  // means the balance is allowed to go negative — the consumption happened
  // either way, and a negative balance is the honest record of it.
  ENFORCE_CREDIT_BALANCE: boolish(true),
  // Counted per (account, service) in Mongo, so the ceiling holds across worker
  // processes — an in-process counter would give a customer N times the limit
  // on an N-worker deployment.
  ENFORCE_PLAN_RATE_LIMITS: boolish(true),

  // --- Lifecycle notifications ---------------------------------------------
  // How many days before the promised free-credit window closes to write.
  FREE_CREDIT_REMINDER_DAYS: intish(7, 1),
  // How long after signup an account that never called the API gets a nudge.
  ONBOARDING_NUDGE_AFTER_DAYS: intish(3, 1),
  VERIFICATION_REMINDER_AFTER_HOURS: intish(24, 1),
  // A ceiling on any one broadcast, so a bug cannot mail the whole base twice.
  BROADCAST_MAX_RECIPIENTS: intish(5000, 1),
  // Recipients are worked in batches of this size. Opening one SMTP connection
  // per customer in parallel is the quickest route to a throttled domain.
  BROADCAST_CONCURRENCY: intish(5, 1, 50),
  // OFF by default: turning the scheduler on is a decision to start mailing
  // customers, and it should never happen merely because a service booted.
  NOTIFICATION_SCHEDULER_ENABLED: boolish(false),
  NOTIFICATION_SCHEDULER_INTERVAL_SECONDS: intish(900, 60),
  // Local to DISPLAY_TIMEZONE, not UTC: "6am" means the customer's 6am.
  NOTIFICATION_SCHEDULER_HOUR: intish(6, 0, 23),
  // Capped at 28 so the monthly report has a valid day in February.
  NOTIFICATION_MONTHLY_REPORT_DAY: intish(1, 1, 28),

  // --- Billing -------------------------------------------------------------
  // Guards the payment-confirmation webhook. UNSET MEANS THE ROUTE REFUSES
  // EVERYTHING (503) rather than accepting anything — an unset secret must not
  // read as "anyone may grant credits".
  BILLING_WEBHOOK_SECRET: str(),
  INVOICE_NUMBER_PREFIX: str('INV-'),
  INVOICE_NUMBER_PADDING: intish(4, 1, 12),

  // --- Machine-facing secrets ----------------------------------------------
  // Each fails CLOSED when unset (503), never open. Anyone able to set a system
  // to "operational" could hide a real outage from every customer at once.
  STATUS_WEBHOOK_SECRET: str(),
  OPS_SECRET: str(),
  // How long a heartbeat or probe stays trusted. Past this the service reads
  // `unknown` rather than `operational` — a status page claiming all is well
  // because nothing reported in is the classic failure of these pages.
  STATUS_STALE_AFTER_SECONDS: intish(300, 30),

  // --- CORS ---------------------------------------------------------------
  // Exact origins only. `allow_credentials` is on, so a permissive value here
  // would let any site read authenticated responses.
  CORS_ORIGINS: str('http://localhost:3000'),

  // --- SMTP ---------------------------------------------------------------
  EMAIL_BACKEND: str('auto'), // auto | smtp | console | memory | disabled
  SMTP_HOST: str(),
  SMTP_PORT: intish(587, 1, 65535),
  SMTP_USERNAME: str(),
  SMTP_PASSWORD: str(),
  SMTP_USE_TLS: boolish(true),
  EMAIL_FROM: str('support@chatbucket.business'),
  EMAIL_FROM_NAME: str('ChatBucket'),
  SUPPORT_EMAIL: str('support@chatbucket.business'),
  // Where demo-request notifications go. Unset means the lead is still stored
  // and acknowledged — only the internal notification is skipped.
  SALES_EMAIL: str(),

  // --- SMS / phone verification -------------------------------------------
  // An Indian number verifies by SMS and is sent no email code; every other
  // country verifies by email. `verification.channelFor` owns that rule.
  SMS_BACKEND: str('auto'), // auto | http | console | memory | disabled
  SMS_API_URL: str(),
  SMS_USERNAME: str(),
  SMS_API_KEY: str(),
  SMS_SENDER_ID: str(),
  SMS_TEMPLATE_ID: str(),
  // Appended to the OTP text, for a registration whose template ends in a
  // second variable. LEAVE EMPTY unless the registered template really has
  // one — a trailing word the registration does not have makes the delivered
  // text stop matching it, and the operator then drops the message while the
  // gateway still answers 200 and reports "Delivered".
  SMS_TEMPLATE_SUFFIX: str(),
  SMS_STRIP_COUNTRY_CODE: boolish(true),
  SMS_TIMEOUT_SECONDS: intish(15, 1),
  SMS_COUNTRY_CODES: str('+91'),
  PHONE_OTP_EXPIRE_MINUTES: intish(10, 1, 60),
  PHONE_OTP_MAX_ATTEMPTS: intish(5, 1, 20),
  // How long a number proven on the signup form stays usable for creating the
  // account. Bounded so a number verified once cannot be attached to an
  // account somebody creates hours later.
  PHONE_VERIFICATION_GRACE_MINUTES: intish(30, 1, 1440),

  // --- Links used in emails -----------------------------------------------
  FRONTEND_URL: str('http://localhost:3000'),
  // Paths appended to FRONTEND_URL / MARKETING_URL to build the links every
  // template shows. Configurable because the site owns its own routing — a
  // hardcoded /dashboard breaks silently the day the frontend renames it.
  DASHBOARD_PATH: str('/dashboard'),
  LOGIN_PATH: str('/login'),
  TRACK_QUERY_PATH: str('/support/tickets'),
  PRIVACY_POLICY_PATH: str('/privacy-policy'),
  TERMS_PATH: str('/terms-of-service'),
  MARKETING_URL: str('https://chatbucket.business'),
  DISPLAY_TIMEZONE: str('Asia/Kolkata'),
  TERMS_VERSION: str('2025-01-01'),
});

export type RawSettings = z.infer<typeof Schema>;

export interface Settings extends RawSettings {
  readonly isDev: boolean;
  readonly isProduction: boolean;
  /** Dial codes that verify by SMS, e.g. `['+91']`. */
  readonly smsCountryCodeList: string[];
  readonly corsOriginList: string[];
  /** `SMS_BACKEND` with `auto` resolved against whether a gateway is configured. */
  readonly resolvedSmsBackend: string;
  /** `EMAIL_BACKEND` with `auto` resolved against whether SMTP is configured. */
  readonly resolvedEmailBackend: string;
}

let cached: Settings | null = null;

function splitList(value: string): string[] {
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function build(): Settings {
  const parsed = Schema.safeParse(process.env);
  if (!parsed.success) {
    // Fail at boot, loudly, with every bad value at once — not one per restart.
    const lines = parsed.error.issues.map(
      (i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`,
    );
    throw new Error(`Invalid configuration:\n${lines.join('\n')}`);
  }
  const raw = parsed.data;
  const isProduction = raw.ENVIRONMENT.toLowerCase() === 'production';

  if (isProduction && raw.JWT_SECRET === 'dev-secret-change-me') {
    // Anybody who has read this repo could otherwise mint a valid token.
    throw new Error('JWT_SECRET must be set to a real secret in production.');
  }

  const resolvedSmsBackend =
    raw.SMS_BACKEND === 'auto' ? (raw.SMS_API_URL ? 'http' : 'console') : raw.SMS_BACKEND;
  const resolvedEmailBackend =
    raw.EMAIL_BACKEND === 'auto' ? (raw.SMTP_HOST ? 'smtp' : 'console') : raw.EMAIL_BACKEND;

  return {
    ...raw,
    isDev: !isProduction,
    isProduction,
    smsCountryCodeList: splitList(raw.SMS_COUNTRY_CODES),
    corsOriginList: splitList(raw.CORS_ORIGINS),
    resolvedSmsBackend,
    resolvedEmailBackend,
  };
}

/** The settings, built and validated once. */
export function getSettings(): Settings {
  if (cached === null) cached = build();
  return cached;
}

/** Test hook: forget the cached settings so the next call re-reads `process.env`. */
export function resetSettings(): void {
  cached = null;
}
