/**
 * Shared-secret guards for the machine-facing routes.
 *
 * Some callers are not customers: the AI services reporting status, the payment
 * gateway confirming a top-up, an operator pulling engine burn. They hold a
 * shared secret rather than a session.
 *
 * Two rules, both of which have to hold everywhere this is used:
 *
 *   1. **Fail closed when unconfigured.** An unset secret returns 503, never
 *      "allow". Falling open would mean anyone could set every system to
 *      "operational" during a real outage, or grant themselves credits.
 *   2. **Compare in constant time.** A plain `!==` returns as soon as two bytes
 *      differ, which leaks the secret one character at a time to anyone who can
 *      measure the response.
 */
import crypto from 'node:crypto';

import { HttpError } from '../errors.js';

export function requireSecret(
  provided: string | undefined,
  expected: string,
  unsetMessage: string,
  invalidMessage: string,
): void {
  if (!expected) throw new HttpError(503, unsetMessage);

  const supplied = provided ?? '';
  // Length is checked first because timingSafeEqual throws on a length
  // mismatch. Length alone is not the secret, so this leaks nothing useful.
  const ok =
    supplied.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));

  if (!ok) throw new HttpError(401, invalidMessage);
}
