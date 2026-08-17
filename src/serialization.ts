/**
 * Turning database documents into JSON responses.
 *
 * Ported from `app/serialization.py`. The point of this module is that the shape
 * of a user in a response is defined **once**. A route that builds its own dict
 * is a route that will one day include `password_hash`.
 */
import { Decimal128, ObjectId } from 'mongodb';

import { toJson } from './money.js';

/**
 * The fields of a user that are safe to return.
 *
 * An allow-list, never a deny-list. With a deny-list, every field added to the
 * user document later is exposed by default — and the fields we add tend to be
 * exactly the ones that must not be (`password_hash`, `verification_code_hash`,
 * `phone_code_hash`).
 */
export function publicUser(user: Record<string, unknown>): Record<string, unknown> {
  return {
    id: String(user['_id'] ?? ''),
    name: user['name'] ?? null,
    email: user['email'] ?? null,
    company: user['company'] ?? null,
    phone: user['phone'] ?? null,
    plan: user['plan'] ?? 'free',
    email_verified: Boolean(user['email_verified']),
    phone_verified: Boolean(user['phone_verified']),
    created_at: toIso(user['created_at']),
  };
}

/** ISO-8601, or null. Dates cross the wire as strings, never as Date objects. */
export function toIso(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return value;
  return null;
}

/**
 * Make a document JSON-safe: ObjectIds to strings, Decimal128 to numbers.
 *
 * `Decimal128` is the only place a float appears, and it appears here because
 * JSON has no decimal type — see `money.toJson`.
 */
export function jsonSafe(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (value instanceof ObjectId) return value.toHexString();
  if (value instanceof Decimal128) return toJson(value);
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = jsonSafe(v);
    }
    return out;
  }
  return value;
}
