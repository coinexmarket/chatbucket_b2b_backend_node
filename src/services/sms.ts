/**
 * Outbound SMS — the single place that sends a text message.
 *
 * Ported from `app/sms.py`. The same seam `email.ts` is for mail: nothing else
 * in the app talks to a gateway, so the gateway can change without touching a
 * route. Vendor-neutral — the request is built from `SMS_API_URL`,
 * `SMS_API_KEY`, `SMS_SENDER_ID` and `SMS_TEMPLATE_ID`, so swapping provider is
 * configuration.
 *
 * Backends, chosen with `SMS_BACKEND`:
 *   http     — really send;
 *   console  — log the message (local development);
 *   memory   — push to `outbox`, for tests to assert against;
 *   disabled — drop silently.
 *
 * **Sending never throws into a request handler**: a gateway outage must not
 * turn a successful signup into a 500.
 *
 * Two India-specific facts shape this module. TRAI requires the sender header
 * and the message template to be pre-registered on a DLT platform; an
 * unregistered pair is refused by the *operator* rather than the gateway, which
 * presents as silent non-delivery with a 200 response — and the gateway's own
 * delivery report says "Delivered" in that case too, so neither signal
 * distinguishes it from working. And an SMS costs money per message, which is
 * why the send route is rate-limited far more tightly than anything free.
 */
import { getSettings } from '../config.js';
import { logger } from '../logger.js';

/** Populated only by the `memory` backend. Tests read this; nothing else should. */
export const outbox: Array<{ to: string; body: string }> = [];

/**
 * Words that mean the gateway refused the message.
 *
 * It answers **200 with an error in the body** rather than an HTTP error code,
 * so the status alone cannot be trusted — checking only that would report every
 * rejection as a success and leave nobody to notice that no OTP ever arrives.
 */
const REFUSAL_MARKERS = [
  'invalid',
  'error',
  'fail',
  'insufficient',
  'unauthor',
  'denied',
  'not found',
  'missing',
  'blocked',
  'expire',
];

/**
 * E.164 to the digits the gateway expects.
 *
 * Numbers are stored `+919876543210`; this class of gateway wants bare ten-digit
 * numbers. Dropping the country code is therefore the default, but it is a
 * property of the gateway rather than of the number, so `SMS_STRIP_COUNTRY_CODE`
 * can turn it off for one that wants `91…`.
 */
export function localNumber(phone: string): string {
  const s = getSettings();
  const digits = phone.replace(/^\+/, '');
  if (!s.SMS_STRIP_COUNTRY_CODE) return digits;
  for (const code of s.smsCountryCodeList) {
    const bare = code.replace(/^\+/, '');
    if (digits.startsWith(bare)) return digits.slice(bare.length);
  }
  return digits;
}

/**
 * Hand one message to the gateway.
 *
 * **This is the one function to adapt to a different gateway.** Everything else
 * in this module, and every caller, is gateway-agnostic.
 *
 * A GET with query parameters, which is what this class of gateway speaks.
 * `URLSearchParams` does the escaping: the message contains spaces, an
 * apostrophe and full stops, and a hand-built query string is how those turn
 * into a mangled template that no longer matches the DLT registration.
 */
async function deliver(to: string, body: string): Promise<{ accepted: boolean; detail: string }> {
  const s = getSettings();
  const query = new URLSearchParams({
    username: s.SMS_USERNAME,
    apikey: s.SMS_API_KEY,
    senderid: s.SMS_SENDER_ID,
    mobile: localNumber(to),
    message: body,
    templateid: s.SMS_TEMPLATE_ID,
  });

  const response = await fetch(`${s.SMS_API_URL}?${query.toString()}`, {
    method: 'GET',
    signal: AbortSignal.timeout(s.SMS_TIMEOUT_SECONDS * 1000),
  });
  const text = (await response.text()).slice(0, 2000).trim();

  if (!response.ok) return { accepted: false, detail: text };

  // A message id means accepted; anything reading like a complaint means it was
  // not. Accepted is still not delivered — the handset's verdict would arrive
  // via a delivery-report callback this service does not consume, and that
  // report is not trustworthy anyway (see the module docstring).
  const lowered = text.toLowerCase();
  if (!text || REFUSAL_MARKERS.some((m) => lowered.includes(m))) {
    return { accepted: false, detail: text };
  }
  return { accepted: true, detail: text };
}

/**
 * Send one message. Resolves true if the gateway accepted it.
 *
 * Never rejects. Callers are request handlers where a gateway outage must not
 * fail the operation that triggered the message.
 */
export async function sendSms(to: string, body: string): Promise<boolean> {
  const s = getSettings();
  const backend = s.resolvedSmsBackend;

  if (backend === 'disabled') {
    logger.debug('sms backend disabled; dropping message to %s', to);
    return false;
  }
  if (!to) {
    logger.warn('refusing to send an SMS with no recipient');
    return false;
  }
  if (backend === 'memory') {
    outbox.push({ to, body });
    return true;
  }
  if (backend === 'console') {
    logger.warn('SMS (console backend, not delivered)\nTo: %s\n\n%s', to, body);
    return true;
  }
  if (!s.SMS_API_URL) {
    logger.error('SMS_BACKEND=http but SMS_API_URL is unset; dropping message');
    return false;
  }

  let result: { accepted: boolean; detail: string };
  try {
    result = await deliver(to, body);
  } catch (err) {
    logger.error('sms to %s failed: %s', to, err instanceof Error ? err.message : err);
    return false;
  }

  if (!result.accepted) {
    // The gateway's own body usually says why — an unregistered template, a
    // spent balance — and that is the whole diagnosis, so it is logged.
    logger.error('sms to %s not accepted by the gateway: %s', to, result.detail.slice(0, 300));
    return false;
  }

  // The message id is the only handle the gateway can trace a message by, so it
  // is logged rather than discarded.
  logger.info('sent verification SMS to %s (gateway ref: %s)', to, result.detail);
  return true;
}

// --- Messages --------------------------------------------------------------

/**
 * The DLT-registered template, verbatim.
 *
 * **Do not reword this to read better.** The operator matches the delivered text
 * against the registered template and silently drops anything that differs —
 * including a changed apostrophe or a fixed typo. If the registration is ever
 * updated, update this string in the same change.
 *
 * The trailing `{suffix}` exists for a registration that ends in a second
 * variable, and `SMS_TEMPLATE_SUFFIX` defaults to EMPTY. A trailing word the
 * registration does not have breaks the match invisibly: the gateway still
 * answers 200 and still reports "Delivered", and no message arrives. That is not
 * hypothetical — it is exactly what a guessed suffix did in the Python service
 * until it was emptied.
 */
const OTP_TEMPLATE =
  "ChatBucket: {code} is your OTP for secure access to ChatBucket. " +
  "It's valid for one attempt only. Don't share this OTP is confidential. {suffix}";

/** The OTP text, exactly as the registered template defines it. */
export function renderOtpMessage(code: string): string {
  const s = getSettings();
  return OTP_TEMPLATE.replace('{code}', code).replace('{suffix}', s.SMS_TEMPLATE_SUFFIX).trim();
}

/** Text the six-digit code that confirms a mobile number. */
export function sendPhoneVerification(to: string, code: string): Promise<boolean> {
  return sendSms(to, renderOtpMessage(code));
}
