/**
 * Outbound email — the single place that sends a message.
 *
 * Ported from `app/email.py`. Every message is **multipart/alternative**: a
 * plain-text part and the designed HTML. The text part is not a formality — it
 * is what renders in a client that blocks HTML, and it is the fallback when a
 * template fails to render (see `html()` below).
 *
 * Backends, chosen with `EMAIL_BACKEND`:
 *   smtp     — really send;
 *   console  — log the message (local development);
 *   memory   — push to `outbox`, for tests to assert against;
 *   disabled — drop silently.
 *
 * **Sending never throws into a request handler.** A mail server outage must not
 * turn a successful signup into a 500 — the account exists, and a missing
 * welcome email is a far smaller problem than a failed registration.
 */
import nodemailer, { type Transporter } from 'nodemailer';

import { getSettings } from '../config.js';
import * as templates from '../emailtemplates.js';
import { logger } from '../logger.js';

export interface SentMessage {
  to: string;
  subject: string;
  text: string;
  html?: string | undefined;
  replyTo?: string | undefined;
}

/** Populated only by the `memory` backend. Tests read this; nothing else should. */
export const outbox: SentMessage[] = [];

let transport: Transporter | null = null;

function getTransport(): Transporter {
  if (transport) return transport;
  const s = getSettings();
  transport = nodemailer.createTransport({
    host: s.SMTP_HOST,
    port: s.SMTP_PORT,
    // STARTTLS on 587, implicit TLS on 465. `secure` means "TLS from the first
    // byte", which is only true for 465 — setting it for 587 fails to connect.
    secure: s.SMTP_PORT === 465,
    requireTLS: s.SMTP_USE_TLS && s.SMTP_PORT !== 465,
    auth: s.SMTP_USERNAME ? { user: s.SMTP_USERNAME, pass: s.SMTP_PASSWORD } : undefined,
  });
  return transport;
}

/** Send one message. Resolves true if the server accepted it. Never rejects. */
export async function sendEmail(message: SentMessage): Promise<boolean> {
  const s = getSettings();
  const backend = s.resolvedEmailBackend;

  if (backend === 'disabled') return false;
  if (!message.to) {
    logger.warn('refusing to send an email with no recipient');
    return false;
  }
  if (backend === 'memory') {
    outbox.push(message);
    return true;
  }
  if (backend === 'console') {
    logger.warn(
      'EMAIL (console backend, not delivered)\nTo: %s\nSubject: %s\n\n%s',
      message.to,
      message.subject,
      message.text,
    );
    return true;
  }

  try {
    await getTransport().sendMail({
      from: `"${s.EMAIL_FROM_NAME}" <${s.EMAIL_FROM}>`,
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
      replyTo: message.replyTo ?? s.SUPPORT_EMAIL,
      // Quoted-printable, explicitly. The Python service settled on this after
      // 8-bit bodies were rejected by servers that do not advertise 8BITMIME;
      // the same constraint applies here regardless of library.
      encoding: 'quoted-printable',
    });
    logger.info('sent "%s" to %s', message.subject, message.to);
    return true;
  } catch (err) {
    // Includes auth failures, DNS/connect errors and timeouts. Logged with the
    // subject and recipient so a delivery gap is diagnosable.
    logger.error(
      'failed to send "%s" to %s: %s',
      message.subject,
      message.to,
      err instanceof Error ? err.message : err,
    );
    return false;
  }
}

/**
 * Render a template, or return undefined if it cannot be rendered.
 *
 * A missing context value is a bug in the caller, and one worth seeing in the
 * log — but not one worth withholding a password-reset link over. The message
 * then goes out as plain text alone, which every client can still read.
 */
function html(template: string, context: templates.Context): string | undefined {
  try {
    return templates.render(template, context);
  } catch (err) {
    logger.error(
      'could not render email template "%s": %s',
      template,
      err instanceof Error ? err.message : err,
    );
    return undefined;
  }
}

/**
 * The greeting each design opens with. Falls back to something neutral.
 *
 * Accounts predating the signup form have no name, and "Hi ," reads as a broken
 * mail merge — which is exactly what it is.
 */
function firstName(name: string | null | undefined): string {
  return (name ?? '').trim().split(' ')[0] || 'there';
}

function appUrl(pathname: string): string {
  return `${getSettings().FRONTEND_URL.replace(/\/$/, '')}${pathname}`;
}

// --- Messages ---------------------------------------------------------------

/**
 * Email a password-reset link.
 *
 * Called without awaiting so the response is sent first: doing it inline would
 * make `forgot-password` measurably slower for a registered address than an
 * unregistered one, reintroducing the account-enumeration oracle the endpoint's
 * identical responses exist to close.
 */
export function sendPasswordReset(
  to: string,
  token: string,
  name?: string | null,
): Promise<boolean> {
  const s = getSettings();
  const link = `${appUrl('/reset-password')}?token=${token}`;
  const minutes = s.RESET_TOKEN_EXPIRE_MINUTES;
  const greeting = firstName(name);

  const text =
    `Hi ${greeting},\n\n` +
    'We received a request to reset your ChatBucket password. Open the link ' +
    'below to choose a new one:\n\n' +
    `${link}\n\n` +
    `The link expires in ${minutes} minutes and can be used once.\n\n` +
    "If you didn't request this, you can ignore this email - your password " +
    'will not change.\n\n-- ChatBucket\n';

  return sendEmail({
    to,
    subject: 'Reset your ChatBucket password',
    text,
    html: html('password_reset', { name: greeting, reset_url: link, expiry_minutes: minutes }),
  });
}

/**
 * Email the verification code, and the link that does the same job.
 *
 * Both are sent because they suit different situations: the code is what someone
 * types back into a form they already have open, the link is what works from a
 * phone reading mail in another app. Either one verifies the address.
 */
export function sendVerificationEmail(
  to: string,
  token: string,
  code: string,
  name?: string | null,
): Promise<boolean> {
  const s = getSettings();
  const link = `${appUrl('/verify-email')}?token=${token}`;
  const minutes = s.EMAIL_OTP_EXPIRE_MINUTES;
  const hours = s.VERIFICATION_TOKEN_EXPIRE_HOURS;

  const text =
    `Hi ${firstName(name)},\n\n` +
    `Your ChatBucket verification code is ${code}\n\n` +
    `It expires in ${minutes} minutes. Do not share it with anyone.\n\n` +
    `You can also confirm this address by opening:\n\n${link}\n\n` +
    `That link expires in ${hours} hours.\n\n` +
    'If you did not create an account, you can ignore this email.\n\n-- ChatBucket\n';

  const context: templates.Context = {
    otp: code,
    expiry_minutes: minutes,
    verify_url: link,
  };
  // The design sets each digit in its own box.
  code.split('').forEach((digit, i) => {
    context[`otp_${i + 1}`] = digit;
  });

  return sendEmail({
    to,
    subject: `${code} is your ChatBucket verification code`,
    text,
    html: html('email_verification', context),
  });
}

/**
 * Confirm that an address has been verified and the account is unlocked.
 *
 * Sent after verification rather than instead of it: until this point the
 * account could sign in but not create an API key, so "verified" is a real
 * change in what the customer can do, not a formality.
 */
export function sendEmailVerified(
  to: string,
  name?: string | null,
  creditsAvailable?: string | null,
): Promise<boolean> {
  const s = getSettings();
  const greeting = firstName(name);
  const symbol = templates.currencySymbol();

  const lines = [
    `Hi ${greeting},`,
    '',
    'Your email address is verified and your ChatBucket account is now fully ' +
      'active. You can create an API key and start building.',
    '',
  ];
  if (creditsAvailable) {
    lines.push(`You have ${symbol}${creditsAvailable} of credits ready to spend.`, '');
  }
  lines.push(`Dashboard: ${appUrl(s.DASHBOARD_PATH)}`, '', '-- ChatBucket', '');

  return sendEmail({
    to,
    subject: 'Your ChatBucket email is verified',
    text: lines.join('\n'),
    html: html('email_verified', { name: greeting, credits: creditsAvailable || '0' }),
    replyTo: s.SUPPORT_EMAIL,
  });
}

/**
 * Welcome a new account, and say what its trial balance is worth.
 *
 * `bonusCredits` is null when the deployment grants none, which hides the
 * free-credits panel entirely rather than promising ₹0 of demo usage.
 */
export function sendWelcome(
  to: string,
  name: string | null | undefined,
  bonusCredits?: string | null,
): Promise<boolean> {
  const s = getSettings();
  const symbol = templates.currencySymbol();
  const days = s.FREE_CREDIT_VALIDITY_DAYS;
  const greeting = firstName(name);

  const lines = [`Hi ${greeting},`, '', 'Welcome to ChatBucket. Your account is ready.', ''];
  if (bonusCredits) {
    lines.push(
      `We have added ${symbol}${bonusCredits} of free credits to get you started. ` +
        `They are good for ${days} days.`,
      '',
    );
  }
  lines.push(
    `Open your dashboard: ${appUrl(s.DASHBOARD_PATH)}`,
    '',
    `Questions? Reply to this note or write to ${s.SUPPORT_EMAIL}.`,
    '',
    '-- ChatBucket',
    '',
  );

  return sendEmail({
    to,
    subject: 'Welcome to ChatBucket',
    text: lines.join('\n'),
    html: html('welcome', {
      name: greeting,
      bonus_credits: bonusCredits || '',
      credit_validity_days: days,
    }),
    replyTo: s.SUPPORT_EMAIL,
  });
}

/**
 * Acknowledge a demo request to the person who sent it.
 *
 * Separate from `sendDemoRequestNotification`, which tells sales. Both are
 * queued off the same submission; this is the half the customer sees.
 */
export function sendContactReceived(lead: Record<string, unknown>): Promise<boolean> {
  const s = getSettings();
  const received = (lead['created_at'] as Date) ?? new Date();
  const queryId = String(lead['_id'] ?? '');
  const greeting = firstName(lead['name'] as string);
  const to = String(lead['email'] ?? '');

  const text = [
    `Hi ${greeting},`,
    '',
    'Thanks for reaching out to ChatBucket. We have your message and someone ' +
      'will come back to you within 24 business hours.',
    '',
    `Your query ID: ${queryId}`,
    `Received: ${templates.fmtDate(received)}, ${templates.fmtTime(received)}`,
    `Submitted email: ${to}`,
    '',
    `You can check on it any time at ${appUrl(s.TRACK_QUERY_PATH)}`,
    '',
    '-- ChatBucket',
    '',
  ].join('\n');

  return sendEmail({
    to,
    subject: "We've received your query",
    text,
    html: html('contact_received', {
      name: greeting,
      query_id: queryId,
      received_date: templates.fmtDate(received),
      received_time: templates.fmtTime(received),
      submitted_email: to,
    }),
    replyTo: s.SUPPORT_EMAIL,
  });
}

/**
 * Tell sales about a new demo request.
 *
 * No-op when `SALES_EMAIL` is unset, so the endpoint still records the lead.
 * Plain text on purpose: this one goes to a colleague, not a customer, and a
 * designed template would only get in the way of pasting it into a CRM.
 */
export function sendDemoRequestNotification(
  lead: Record<string, unknown>,
): Promise<boolean> {
  const s = getSettings();
  if (!s.SALES_EMAIL) {
    logger.info(
      'SALES_EMAIL not set; demo request %s not notified',
      String(lead['_id'] ?? ''),
    );
    return Promise.resolve(false);
  }

  const lines = [
    `New ${String(lead['type'] ?? 'unknown')} demo request.`,
    '',
    `Name:    ${String(lead['name'] ?? '')}`,
    `Email:   ${String(lead['email'] ?? '')}`,
    `Mobile:  ${String(lead['mobile'] ?? '')}`,
  ];
  if (lead['company_name']) lines.push(`Company: ${String(lead['company_name'])}`);
  if (lead['company_details']) {
    lines.push('', 'Company details:', String(lead['company_details']));
  }
  if (lead['how_did_you_hear']) {
    lines.push('', 'How they heard about us:', String(lead['how_did_you_hear']));
  }
  lines.push(
    '',
    `Wants product updates: ${lead['marketing_consent'] ? 'yes' : 'no'}`,
    `Lead id: ${String(lead['_id'] ?? '')}`,
  );

  let subject = `New demo request: ${String(lead['name'] ?? 'unknown')}`;
  if (lead['company_name']) subject += ` (${String(lead['company_name'])})`;

  return sendEmail({
    to: s.SALES_EMAIL,
    subject,
    text: lines.join('\n'),
    replyTo: (lead['email'] as string) || undefined,
  });
}

/** Confirm an app-launch subscription. */
export function sendSubscriptionConfirmation(to: string): Promise<boolean> {
  return sendEmail({
    to,
    subject: "You're on the list",
    text: [
      "Thanks for subscribing. We'll email you the moment the ChatBucket app",
      'launches.',
      '',
      '-- ChatBucket',
      '',
    ].join('\n'),
    html: html('subscribed', {}),
  });
}

/**
 * A receipt for credits added to the account.
 *
 * The caller supplies the figures already formatted for display: this function
 * turns them into a message, it does not decide what they are.
 */
export function sendDepositReceipt(
  to: string,
  name: string | null | undefined,
  context: templates.Context,
): Promise<boolean> {
  const s = getSettings();
  const greeting = firstName(name);
  const symbol = templates.currencySymbol();

  const text =
    `Hi ${greeting},\n\n` +
    `${symbol}${String(context['amount'] ?? '')} has been added to your ChatBucket ` +
    'account.\n\n' +
    `New balance: ${symbol}${String(context['balance'] ?? '')}\n` +
    `Transaction: ${String(context['transaction_id'] ?? '')}\n` +
    `Paid by: ${String(context['payment_method'] ?? '')}\n` +
    `On: ${String(context['date'] ?? '')}, ${String(context['time'] ?? '')}\n\n` +
    '-- ChatBucket\n';

  return sendEmail({
    to,
    subject: 'Credits added to your ChatBucket account',
    text,
    html: html('deposit', { name: greeting, ...context }),
    replyTo: s.SUPPORT_EMAIL,
  });
}

/** Warn that free signup credits are about to expire. */
export function sendFreeCreditsExpiring(
  to: string,
  name: string | null | undefined,
  context: templates.Context,
): Promise<boolean> {
  const greeting = firstName(name);

  const text =
    `Hi ${greeting},\n\n` +
    `Your free ChatBucket credits expire in ${String(context['days_remaining'] ?? '')} ` +
    `days, on ${String(context['expiry_date'] ?? '')} at ` +
    `${String(context['expiry_time'] ?? '')}.\n\n` +
    `Use them: ${appUrl(getSettings().DASHBOARD_PATH)}\n\n-- ChatBucket\n`;

  return sendEmail({
    to,
    subject: 'Your free ChatBucket credits are expiring',
    text,
    html: html('free_credits_expiring', { name: greeting, ...context }),
  });
}

/** Nudge an account that signed up but never made a call. */
export function sendOnboardingNudge(
  to: string,
  name: string | null | undefined,
): Promise<boolean> {
  const s = getSettings();
  const greeting = firstName(name);
  const dashboard = appUrl(s.DASHBOARD_PATH);

  const text =
    `Hi ${greeting},\n\n` +
    'You created a ChatBucket account but have not made your first API call ' +
    'yet. Your key and the quickstart are waiting in the dashboard:\n\n' +
    `${dashboard}\n\n-- ChatBucket\n`;

  return sendEmail({
    to,
    subject: 'Make your first ChatBucket API call',
    text,
    html: html('onboarding_nudge', {
      name: greeting,
      // All three CTAs land on the dashboard; the builder is one surface, not
      // three pages, so pointing them anywhere else would 404.
      appointment_url: dashboard,
      voice_agent_url: dashboard,
      prompt_url: dashboard,
    }),
  });
}

/**
 * Send one account its usage report for a month.
 *
 * `report` is built by the reports module, which is where the figures come
 * from; this function only turns them into a message.
 */
export function sendMonthlyReport(
  to: string,
  name: string | null | undefined,
  report: templates.Context,
): Promise<boolean> {
  const s = getSettings();
  const greeting = firstName(name);

  const lines = [
    `Hi ${greeting},`,
    '',
    `Your ChatBucket usage for ${String(report['period'])}:`,
    '',
  ];
  for (let i = 1; i <= 4; i += 1) {
    lines.push(
      `  ${String(report[`metric${i}_label`])}: ${String(report[`metric${i}_value`])}` +
        `  (${String(report[`metric${i}_change`])} vs ${String(report['previous_period'])}:` +
        ` ${String(report[`metric${i}_previous`])})`,
    );
  }
  const services = (report['services'] ?? []) as Array<Record<string, unknown>>;
  if (services.length > 0) {
    lines.push('', 'Top services by spend:');
    for (const service of services) {
      lines.push(
        `  ${String(service['name'])}: ${String(service['percent'])}% (${String(service['value'])})`,
      );
    }
  }
  lines.push(
    '',
    `Plan: ${String(report['plan_name'])} (${String(report['plan_status'])})`,
    '',
    `Full analytics: ${String(report['analytics_url'])}`,
    '',
    '-- ChatBucket',
    '',
  );

  return sendEmail({
    to,
    subject: `Your ChatBucket usage report - ${String(report['period'])}`,
    text: lines.join('\n'),
    html: html('monthly_report', { name: greeting, ...report }),
    replyTo: s.SUPPORT_EMAIL,
  });
}

/**
 * Send one announcement to one recipient.
 *
 * `announcement` carries the copy and the reference id; the broadcast job builds
 * it once and fans it out.
 */
export function sendAnnouncement(
  to: string,
  announcement: templates.Context,
): Promise<boolean> {
  const s = getSettings();
  const lines = [String(announcement['headline']), '', String(announcement['summary']), ''];
  for (const point of (announcement['highlights'] ?? []) as unknown[]) {
    lines.push(`  * ${String(point)}`);
  }
  if (announcement['quote']) {
    lines.push(
      '',
      `"${String(announcement['quote'])}"`,
      `  - ${String(announcement['quote_author'])}`,
    );
  }
  lines.push(
    '',
    `${String(announcement['category'])} | ${String(announcement['date'])} ${String(announcement['time'])}`,
    `Reference: ${String(announcement['reference_id'])}`,
    '',
    `More at ${s.MARKETING_URL}`,
    '',
    '-- ChatBucket',
    '',
  );

  return sendEmail({
    to,
    subject: String(announcement['subject']),
    text: lines.join('\n'),
    html: html('announcement', announcement),
  });
}

/** Tell one customer about a maintenance window. */
export function sendMaintenanceNotice(
  to: string,
  name: string | null | undefined,
  window: templates.Context,
): Promise<boolean> {
  const s = getSettings();
  const greeting = firstName(name);

  const text =
    `Hi ${greeting},\n\n` +
    `${String(window['maintenance_type'])} is planned for ChatBucket.\n\n` +
    `Starts: ${String(window['start_date'])}, ${String(window['start_time'])}\n` +
    `Ends:   ${String(window['end_date'])}, ${String(window['end_time'])}\n` +
    `Reference: ${String(window['reference_id'])}\n\n` +
    'Messaging, voice and video, translation, chat and voice agents, and ' +
    'analytics may be intermittently unavailable during the window. Your data ' +
    'is not affected.\n\n' +
    `Live status: ${appUrl(s.TRACK_QUERY_PATH)}\n\n-- ChatBucket\n`;

  return sendEmail({
    to,
    subject: String(window['subject']),
    text,
    html: html('maintenance', { name: greeting, ...window }),
  });
}
