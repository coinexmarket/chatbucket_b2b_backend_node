/**
 * Time bucketing for the usage charts.
 *
 * Ported from `app/analytics.py`. The dashboard plots spend, requests and
 * quantity over time at Daily / Hourly / Minute granularity across a date
 * range. Two things make that more than a `$group`:
 *
 * **Gaps must be filled.** A day with no usage still needs a zero point, or the
 * chart's x-axis silently skips it and a quiet Tuesday looks like it never
 * happened. So the full range of buckets is generated here and the aggregation
 * results are merged onto it.
 *
 * **Ranges must be bounded.** A minute-granularity query over a year is 525,600
 * buckets; nothing good comes of building that response. Each granularity caps
 * the span it will serve and says so.
 */
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export interface Granularity {
  key: string;
  /**
   * Shared by Mongo's `$dateToString` and the label generator below, so the
   * keys they produce match and the merge lines up.
   */
  fmt: string;
  /** Bucket width, in milliseconds. */
  stepMs: number;
  /** The widest window this granularity will serve. */
  maxSpanMs: number;
  /** The window used when the caller gives no range. */
  defaultSpanMs: number;
}

const LIST: Granularity[] = [
  { key: 'daily', fmt: '%Y-%m-%d', stepMs: DAY, maxSpanMs: 731 * DAY, defaultSpanMs: 30 * DAY },
  { key: 'hourly', fmt: '%Y-%m-%dT%H:00', stepMs: HOUR, maxSpanMs: 62 * DAY, defaultSpanMs: 2 * DAY },
  { key: 'minute', fmt: '%Y-%m-%dT%H:%M', stepMs: MINUTE, maxSpanMs: 2 * DAY, defaultSpanMs: 6 * HOUR },
];

export const GRANULARITIES: Record<string, Granularity> = Object.fromEntries(
  LIST.map((g) => [g.key, g]),
);

export class RangeTooLargeError extends Error {}

export function getGranularity(key: string | null | undefined): Granularity {
  const granularity = GRANULARITIES[(key || 'daily').toLowerCase()];
  if (!granularity) {
    throw new Error(
      `Unknown granularity '${key}'. Valid: ${Object.keys(GRANULARITIES).join(', ')}`,
    );
  }
  return granularity;
}

/**
 * Parse an ISO date or datetime as UTC.
 *
 * Accepts "2026-04-12" as well as a full timestamp, because the date pickers
 * send the former. A value with no zone is read as UTC rather than local, so
 * the same request means the same thing wherever it is issued from — which is
 * why this does not just call `new Date(value)`: JavaScript reads a bare
 * datetime as *local* time, and the same query would then cover a different
 * window depending on the server's timezone.
 */
export function parseInstant(value: string): Date {
  const text = value.trim();
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(text);
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(text);

  const parsed = new Date(hasZone || dateOnly ? text : `${text}Z`);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`'${value}' is not a valid date or timestamp.`);
  }
  return parsed;
}

/** Snap an instant down to the start of its bucket. */
export function truncate(moment: Date, granularity: Granularity): Date {
  const d = new Date(moment.getTime());
  if (granularity.key === 'daily') {
    d.setUTCHours(0, 0, 0, 0);
  } else if (granularity.key === 'hourly') {
    d.setUTCMinutes(0, 0, 0);
  } else {
    d.setUTCSeconds(0, 0);
  }
  return d;
}

/**
 * Work out the window to report, defaulting and validating it.
 *
 * `to` defaults to now and `from` to one default span before it. The bucket
 * containing `to` is included.
 */
export function resolveRange(
  granularity: Granularity,
  start?: string | null,
  end?: string | null,
  now = new Date(),
): [Date, Date] {
  const finish = end ? parseInstant(end) : now;
  const begin = start
    ? parseInstant(start)
    : new Date(finish.getTime() - granularity.defaultSpanMs);

  if (begin.getTime() > finish.getTime()) {
    throw new Error("'from' must not be after 'to'.");
  }

  const span = finish.getTime() - begin.getTime();
  if (span > granularity.maxSpanMs) {
    const maxDays = Math.max(Math.floor(granularity.maxSpanMs / DAY), 2);
    const gotDays = Math.floor(span / DAY);
    throw new RangeTooLargeError(
      `A ${granularity.key} range may span at most ${maxDays} days; ` +
        `got ${gotDays} days. Narrow the range or use a coarser granularity.`,
    );
  }
  return [begin, finish];
}

const pad = (n: number): string => String(n).padStart(2, '0');

/**
 * Format one bucket start the way Mongo's `$dateToString` formats it.
 *
 * Only the three formats above are supported, which is the point: the label the
 * aggregation produces and the label generated here must be byte-identical or
 * the merge silently misses and every bucket reads zero.
 */
function formatBucket(moment: Date, granularity: Granularity): string {
  const y = moment.getUTCFullYear();
  const m = pad(moment.getUTCMonth() + 1);
  const d = pad(moment.getUTCDate());
  if (granularity.key === 'daily') return `${y}-${m}-${d}`;
  const h = pad(moment.getUTCHours());
  if (granularity.key === 'hourly') return `${y}-${m}-${d}T${h}:00`;
  return `${y}-${m}-${d}T${h}:${pad(moment.getUTCMinutes())}`;
}

/** Every bucket label in the range, including the empty ones. */
export function bucketLabels(
  begin: Date,
  finish: Date,
  granularity: Granularity,
): string[] {
  const labels: string[] = [];
  const last = truncate(finish, granularity).getTime();
  let cursor = truncate(begin, granularity).getTime();

  while (cursor <= last) {
    labels.push(formatBucket(new Date(cursor), granularity));
    // Stepping by a fixed millisecond width is correct here because every
    // bucket is UTC: there are no DST-length days to skip or repeat.
    cursor += granularity.stepMs;
  }
  return labels;
}
