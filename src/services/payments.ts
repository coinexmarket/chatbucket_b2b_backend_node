/**
 * The payment gateway seam.
 *
 * Ported from `app/payments.py`. Like the SMTP and SMS seams, this is the only
 * module that talks to the gateway, so swapping providers is one file.
 *
 * Three signature-related rules, and getting any of them wrong means crediting
 * money that was never paid:
 *
 *   1. The checkout signature is HMAC-SHA256 over `orderId|paymentId` under the
 *      **key secret**.
 *   2. The webhook signature is HMAC-SHA256 over the **exact bytes received**
 *      under the **webhook secret** — a different secret, and a re-serialised
 *      JSON body produces a different digest, so every delivery would be
 *      rejected.
 *   3. Both compare in constant time.
 */
import crypto from 'node:crypto';

import { getSettings } from '../config.js';
import { toPaise, type AmountLike } from '../money.js';

const ORDERS_URL = 'https://api.razorpay.com/v1/orders';

export class PaymentGatewayError extends Error {}

export interface GatewayOrder {
  id: string;
  amount: number;
  currency: string;
}

/** True when both halves of the API credential are present. */
export function gatewayConfigured(): boolean {
  const s = getSettings();
  return Boolean(s.RAZORPAY_KEY_ID && s.RAZORPAY_KEY_SECRET);
}

/**
 * Create a gateway order. Returns null when no gateway is configured.
 *
 * Returning null rather than throwing keeps the service usable without a
 * gateway — the top-up is recorded locally and can be confirmed by the
 * shared-secret endpoint.
 */
export async function createOrder(
  amount: AmountLike,
  currency: string,
  receipt: string,
): Promise<GatewayOrder | null> {
  const s = getSettings();
  if (!gatewayConfigured()) return null;

  const token = Buffer.from(`${s.RAZORPAY_KEY_ID}:${s.RAZORPAY_KEY_SECRET}`).toString(
    'base64',
  );

  let response: Response;
  try {
    response = await fetch(ORDERS_URL, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        // Integer minor units — `toPaise` throws rather than rounding, so an
        // amount the gateway cannot charge exactly never reaches it.
        amount: toPaise(amount),
        currency,
        // The gateway returns the existing order for a repeated receipt rather
        // than creating a duplicate, which makes a retried top-up safe.
        receipt,
        payment_capture: 1,
      }),
      signal: AbortSignal.timeout(s.RAZORPAY_TIMEOUT_SECONDS * 1000),
    });
  } catch (err) {
    throw new PaymentGatewayError(
      `Could not reach the payment gateway: ${err instanceof Error ? err.message : err}`,
    );
  }

  const text = await response.text();
  if (!response.ok) {
    throw new PaymentGatewayError(
      `The payment gateway rejected the order (${response.status}): ${text.slice(0, 500)}`,
    );
  }

  try {
    return JSON.parse(text) as GatewayOrder;
  } catch {
    throw new PaymentGatewayError('The payment gateway returned a body that is not JSON.');
  }
}

/** Constant-time compare of two hex digests. */
function digestsMatch(expected: string, provided: string): boolean {
  if (typeof provided !== 'string' || provided.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(provided));
}

/** Verify the signature Checkout hands back to the browser. */
export function verifyCheckoutSignature(
  orderId: string,
  paymentId: string,
  signature: string,
): boolean {
  const secret = getSettings().RAZORPAY_KEY_SECRET;
  if (!secret) return false;

  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${orderId}|${paymentId}`, 'utf8')
    .digest('hex');
  return digestsMatch(expected, signature ?? '');
}

/**
 * Verify a webhook delivery against the **webhook** secret.
 *
 * Signed over the exact bytes received, so the raw body must be passed — a
 * re-serialised JSON body produces a different digest and every delivery would
 * be rejected.
 */
export function verifyWebhookSignature(rawBody: Buffer, signature: string): boolean {
  const secret = getSettings().RAZORPAY_WEBHOOK_SECRET;
  if (!secret) return false;

  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  return digestsMatch(expected, signature ?? '');
}
