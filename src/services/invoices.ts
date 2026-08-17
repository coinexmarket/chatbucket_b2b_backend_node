/**
 * Invoices for confirmed payments.
 *
 * Ported from `app/invoices.py`.
 *
 * **Tax is not computed.** Every invoice carries `tax_status: "not_computed"`
 * rather than a zero, because a zero is a claim — that GST was considered and
 * found to be nil — and this service is not equipped to make it. A field that
 * says "not computed" is honest and can be filled in later; a zero silently
 * becomes wrong the day the first taxable sale happens.
 */
import type { ObjectId } from 'mongodb';

import { getSettings } from '../config.js';
import { countersCollection, invoicesCollection } from '../database.js';
import { logger } from '../logger.js';
import { toJson, type AmountLike } from '../money.js';
import { toIso } from '../serialization.js';
import { fromUnits } from './credits.js';

const INVOICE_COUNTER = 'invoice_number';

/**
 * The next number in the sequence, e.g. `INV-0001`.
 *
 * Atomic: the increment and the read are one operation, so two payments landing
 * at once cannot be handed the same number.
 */
export async function nextInvoiceNumber(): Promise<string> {
  const s = getSettings();
  const doc = await countersCollection().findOneAndUpdate(
    { _id: INVOICE_COUNTER as unknown as ObjectId },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: 'after' },
  );
  const seq = String(Number(doc?.['seq'] ?? 1)).padStart(s.INVOICE_NUMBER_PADDING, '0');
  return `${s.INVOICE_NUMBER_PREFIX}${seq}`;
}

/**
 * Copy the billing details as they stand right now.
 *
 * Falls back to the account's name/company/email so an invoice is still
 * identifiable when the customer never filled the billing form in. Frozen at
 * issue time: editing the details later must not rewrite an invoice already
 * sent, or history stops being a record of what was true.
 */
export function billingSnapshot(user: Record<string, unknown>): Record<string, unknown> {
  const details = (user['billing_details'] ?? {}) as Record<string, unknown>;
  return {
    legal_name: details['legal_name'] || user['company'] || user['name'] || null,
    email: user['email'] ?? null,
    gstin: details['gstin'] ?? null,
    address_line1: details['address_line1'] ?? null,
    address_line2: details['address_line2'] ?? null,
    city: details['city'] ?? null,
    state: details['state'] ?? null,
    postal_code: details['postal_code'] ?? null,
    country: details['country'] ?? null,
    // Lets finance chase the customers whose invoices are missing the details a
    // compliant document needs, instead of finding out later.
    complete: Boolean(details['legal_name'] && details['address_line1']),
  };
}

/**
 * Create the invoice for a confirmed payment. Returns it, or null.
 *
 * **Never throws**: the payment has already succeeded and the credits are
 * already granted, so a numbering hiccup must not turn a paid top-up into an
 * error. A missing invoice is recoverable; a failed confirmation is not.
 */
export async function issueForPayment(
  payment: Record<string, unknown>,
  user: Record<string, unknown>,
): Promise<Record<string, unknown> | null> {
  try {
    const document: Record<string, unknown> = {
      invoice_number: await nextInvoiceNumber(),
      payment_id: payment['_id'],
      user_id: payment['user_id'],
      amount: payment['amount_inr'],
      currency: payment['currency'] ?? 'INR',
      credits: payment['credit_units'] ?? 0,
      plan: payment['plan'] ?? null,
      description: payment['description'] ?? 'Credit top-up',
      method: payment['method'] ?? null,
      provider_payment_id: payment['provider_payment_id'] ?? null,
      // Set when the gateway issues its own (GST-compliant) invoice.
      provider_invoice_id: payment['provider_invoice_id'] ?? null,
      provider_invoice_url: payment['provider_invoice_url'] ?? null,
      bill_to: billingSnapshot(user),
      // Deliberately not a zero — see the module docstring.
      tax_status: 'not_computed',
      status: 'issued',
      issued_at: new Date(),
    };
    const result = await invoicesCollection().insertOne(document);
    document['_id'] = result.insertedId;
    return document;
  } catch (err) {
    logger.error(
      'could not issue an invoice for payment %s: %s',
      String(payment['_id']),
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

export function serialize(invoice: Record<string, unknown>): Record<string, unknown> {
  return {
    id: String(invoice['_id']),
    invoice_number: invoice['invoice_number'] ?? null,
    payment_id: String(invoice['payment_id']),
    amount: toJson((invoice['amount'] ?? 0) as AmountLike),
    currency: invoice['currency'] ?? null,
    credits: fromUnits(Number(invoice['credits'] ?? 0)).toNumber(),
    plan: invoice['plan'] ?? null,
    description: invoice['description'] ?? null,
    method: invoice['method'] ?? null,
    provider_payment_id: invoice['provider_payment_id'] ?? null,
    provider_invoice_id: invoice['provider_invoice_id'] ?? null,
    provider_invoice_url: invoice['provider_invoice_url'] ?? null,
    bill_to: invoice['bill_to'] ?? null,
    tax_status: invoice['tax_status'] ?? null,
    status: invoice['status'] ?? null,
    issued_at: toIso(invoice['issued_at']),
  };
}
