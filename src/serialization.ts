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
 * Fields that must never leave the server on a user object.
 *
 * A deny-list, matching the Python service field for field — and that match is
 * the point. An allow-list would be safer in isolation, because a field added
 * to the user document later would be hidden by default rather than exposed;
 * but the two services answer the same frontend from the same database, and a
 * response that quietly drops `_id` or `how_did_you_hear` is a broken page, not
 * a safer one.
 *
 * The safety this gives up is bought back by a test that asserts each of these
 * never appears in a response, so adding a secret field without adding it here
 * fails CI rather than shipping.
 */
const USER_SECRET_FIELDS = new Set([
  'password_hash',
  'reset_token_hash',
  'reset_token_expires',
  '_api_key_id',
  '_api_key_project_id',
  'verification_token_hash',
  'verification_token_expires',
  // Node-side additions, absent from the Python list only because that service
  // has no phone codes stored on the user in the same shape.
  'verification_code_hash',
  'verification_code_expires',
  'phone_code_hash',
  'phone_code_expires',
]);

/** Serialize a user document, stripping the fields that must not leave. */
export function publicUser(user: Record<string, unknown>): Record<string, unknown> {
  const full = jsonSafe(user) as Record<string, unknown>;
  return Object.fromEntries(
    Object.entries(full).filter(([key]) => !USER_SECRET_FIELDS.has(key)),
  );
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
