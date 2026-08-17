/**
 * Engine registry — the capabilities behind the customer-facing services.
 *
 * Ported from `app/engines.py`.
 *
 * **Whatever sits behind an engine is never named here** — not in an
 * identifier, a comment, a log line or an error message. Such a name spreads
 * into stored records and API responses, where anyone reading a stack trace or
 * an env var learns how the product is built. A capability can also be
 * re-provisioned without renaming a field that history is keyed on.
 *
 * **Free allowances ship unset.** Capacity is a fact about an arrangement this
 * code has no way to observe, and inventing one would produce a "remaining"
 * figure that reads as authoritative while being fiction — the same reason the
 * model rate table ships empty and invoices refuse to compute tax. Set them
 * with `ENGINE_FREE_QUOTAS` and `remaining` starts being reported; leave them
 * unset and consumption is still counted, with `remaining: null` stating
 * plainly that nobody has told this service how big the allowance is.
 */
export interface Engine {
  key: string;
  label: string;
  capability: string;
  /**
   * The unit the *engine* meters in, which need not match the unit we bill the
   * customer in: an engine may count the audio it processed including leading
   * silence, or the characters it synthesised including markup, where we bill
   * only what the customer sent.
   */
  unit: string;
}

const LIST: Engine[] = [
  { key: 'cb_vinu', label: 'CB Vinu', capability: 'Speech to Text', unit: 'minutes' },
  { key: 'cb_paluku', label: 'CB Paluku', capability: 'Text to Speech', unit: 'characters' },
  { key: 'cb_vaaradhi', label: 'CB Vaaradhi', capability: 'Translation', unit: 'tokens' },
  { key: 'cb_thodu', label: 'CB Thodu', capability: 'Chat + Voice Agent', unit: 'tokens' },
];

export const ENGINES: Record<string, Engine> = Object.fromEntries(
  LIST.map((e) => [e.key, e]),
);

/** Lower-case and collapse whitespace, as model keys are normalised. */
export function normalizeEngineKey(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

export function getEngine(key: string | null | undefined): Engine | undefined {
  if (!key) return undefined;
  return ENGINES[normalizeEngineKey(key)];
}

export function isKnown(key: string | null | undefined): boolean {
  return getEngine(key) !== undefined;
}

/** The configured allowance for an engine, or undefined if unset. */
export function freeQuota(
  key: string,
  quotas: Record<string, number>,
): number | undefined {
  return quotas[normalizeEngineKey(key)];
}

const round4 = (n: number): number => Math.round(n * 10_000) / 10_000;

/**
 * One engine's line in the operator view.
 *
 * `remaining` and `percent_used` are **null when no quota is configured**
 * rather than 0 or 100. Either number would be a claim about an allowance this
 * service has not been told the size of, and "0 remaining" in particular would
 * read as an outage that is not happening.
 */
export function summarise(
  key: string,
  consumed: number,
  events: number,
  quotas: Record<string, number>,
): Record<string, unknown> {
  const engine = getEngine(key);
  const quota = freeQuota(key, quotas);
  const remaining = quota === undefined ? null : Math.max(0, quota - consumed);
  const percent =
    !quota ? null : Math.round(Math.min(100, (consumed / quota) * 100) * 100) / 100;

  return {
    engine: key,
    label: engine?.label ?? key,
    capability: engine?.capability ?? null,
    unit: engine?.unit ?? null,
    consumed: round4(consumed),
    events,
    free_quota: quota ?? null,
    remaining: remaining === null ? null : round4(remaining),
    percent_used: percent,
    // True only when a quota is known *and* has been reached, so a caller
    // cannot mistake "we never configured this" for "we ran out".
    exhausted: quota !== undefined && consumed >= quota,
  };
}
