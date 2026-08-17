/**
 * Outbound email — the single place that sends a message.
 *
 * Ported from `app/email.py` (the transport half; the 13 HTML templates and
 * their renderer are still to come — see the README).
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
import { logger } from '../logger.js';

export interface SentMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
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

/**
 * Send one message. Resolves true if the server accepted it. Never rejects.
 */
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
      replyTo: s.SUPPORT_EMAIL,
      // Quoted-printable, explicitly. The Python service settled on this after
      // 8-bit bodies were rejected by servers that do not advertise 8BITMIME;
      // the same constraint applies here regardless of library.
      encoding: 'quoted-printable',
    });
    logger.info('sent "%s" to %s', message.subject, message.to);
    return true;
  } catch (err) {
    logger.error(
      'email "%s" to %s failed: %s',
      message.subject,
      message.to,
      err instanceof Error ? err.message : err,
    );
    return false;
  }
}

// --- Messages ---------------------------------------------------------------
// Plain-text for now. The designed HTML templates are a separate piece of work
// (see the README); wiring them in means replacing the bodies below, not the
// call sites, which is the point of routing everything through this module.

function link(path: string): string {
  return `${getSettings().FRONTEND_URL.replace(/\/$/, '')}${path}`;
}

export function sendWelcome(to: string, name: string, bonus: string | null): Promise<boolean> {
  const credits = bonus ? `\n\nWe've added ₹${bonus} of free credits to your account.` : '';
  return sendEmail({
    to,
    subject: 'Welcome to ChatBucket',
    text: `Hi ${name},\n\nYour ChatBucket account is ready.${credits}\n\n${link('/overview')}`,
  });
}

export function sendVerificationEmail(
  to: string,
  token: string,
  code: string,
  name?: string,
): Promise<boolean> {
  return sendEmail({
    to,
    subject: 'Confirm your email address',
    text:
      `Hi ${name ?? 'there'},\n\nYour verification code is ${code}\n\n` +
      `Or open this link: ${link(`/verify-email?token=${token}`)}`,
  });
}

export function sendEmailVerified(
  to: string,
  name?: string,
  balance?: string | null,
): Promise<boolean> {
  const available = balance ? `\n\nYou have ₹${balance} of credits available.` : '';
  return sendEmail({
    to,
    subject: 'Your ChatBucket account is verified',
    text: `Hi ${name ?? 'there'},\n\nYour email is confirmed.${available}\n\n${link('/overview')}`,
  });
}

export function sendPasswordReset(to: string, token: string, name?: string): Promise<boolean> {
  return sendEmail({
    to,
    subject: 'Reset your ChatBucket password',
    text:
      `Hi ${name ?? 'there'},\n\nReset your password here:\n` +
      `${link(`/reset-password?token=${token}`)}\n\n` +
      `If you did not ask for this, you can ignore this email.`,
  });
}
