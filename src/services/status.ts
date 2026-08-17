/**
 * Service status: the registry, and how a status is decided.
 *
 * Ported from `app/status.py`. This backend cannot observe the AI services
 * directly, so status has to be *reported* to it. Three sources, all writing the
 * same record: `heartbeat` (a service says "I'm alive" on a schedule, which
 * works behind NAT), `probe` (this app polls a health URL), and `manual` (set by
 * hand during an incident).
 *
 * **A status goes stale rather than staying true.** If a heartbeat or probe has
 * not reported inside `STATUS_STALE_AFTER_SECONDS`, the service reads `unknown`
 * — never `operational`. A status page claiming everything is fine because
 * nothing has reported in is worse than one admitting it does not know, and that
 * is the failure mode these pages are famous for.
 *
 * Manual statuses do not go stale: a human saying "this is down" stands until a
 * human says otherwise.
 */
import { getSettings } from '../config.js';
import {
  serviceStatusCollection,
  serviceStatusDaysCollection,
} from '../database.js';

export const OPERATIONAL = 'operational';
export const DEGRADED = 'degraded';
export const DOWN = 'down';
export const MAINTENANCE = 'maintenance';
export const UNKNOWN = 'unknown';

/** Worst-first, so `worst()` can pick the headline status for the whole page. */
export const SEVERITY: Record<string, number> = {
  [DOWN]: 4,
  [DEGRADED]: 3,
  [MAINTENANCE]: 2,
  [UNKNOWN]: 1,
  [OPERATIONAL]: 0,
};
export const STATUSES = Object.keys(SEVERITY);

export const SOURCE_HEARTBEAT = 'heartbeat';
export const SOURCE_PROBE = 'probe';
export const SOURCE_MANUAL = 'manual';

export interface SystemDef {
  key: string;
  name: string;
  components: number;
}

/**
 * The six systems the status page lists, with their component counts.
 *
 * Deliberately its own list rather than derived from the rate card: OCR is shown
 * here but is not a billed service, and "API Dashboard" is this platform itself.
 */
const SYSTEM_LIST: SystemDef[] = [
  { key: 'tts', name: 'Text to Speech', components: 2 },
  { key: 'stt', name: 'Speech to Text', components: 6 },
  { key: 'translate', name: 'Translate', components: 3 },
  { key: 'chat', name: 'Chat API', components: 1 },
  { key: 'ocr', name: 'Document Digitization (OCR)', components: 1 },
  { key: 'dashboard', name: 'API Dashboard', components: 1 },
];

export const SYSTEMS: Record<string, SystemDef> = Object.fromEntries(
  SYSTEM_LIST.map((s) => [s.key, s]),
);

export class UnknownSystemError extends Error {}

export function getSystem(key: string): SystemDef {
  const system = SYSTEMS[key];
  if (!system) {
    throw new UnknownSystemError(
      `Unknown system '${key}'. Valid: ${Object.keys(SYSTEMS).join(', ')}`,
    );
  }
  return system;
}

/** The worst of several statuses — the headline for the whole page. */
export function worst(statuses: string[]): string {
  let picked = OPERATIONAL;
  for (const s of statuses) {
    if ((SEVERITY[s] ?? 0) > (SEVERITY[picked] ?? 0)) picked = s;
  }
  return picked;
}

function dayKey(moment: Date): string {
  return moment.toISOString().slice(0, 10);
}

/**
 * The status as it should be *read*, accounting for silence.
 *
 * A heartbeat or probe that stopped reporting means we no longer know, so it
 * reads `unknown`. A manual status is a human assertion and stands.
 */
export function applyStaleness(
  doc: Record<string, unknown> | null | undefined,
  now = new Date(),
): string {
  if (!doc) return UNKNOWN;
  const status = String(doc['status'] ?? UNKNOWN);
  if (doc['source'] === SOURCE_MANUAL) return status;

  const reported = doc['reported_at'];
  if (!(reported instanceof Date)) return UNKNOWN;
  const cutoff = now.getTime() - getSettings().STATUS_STALE_AFTER_SECONDS * 1000;
  return reported.getTime() >= cutoff ? status : UNKNOWN;
}

/** Store a status report and fold it into the day's rollup. */
export async function record(
  key: string,
  status: string,
  source: string,
  detail: string | null = null,
): Promise<Record<string, unknown>> {
  const system = getSystem(key);
  if (!(status in SEVERITY)) {
    throw new Error(`Unknown status '${status}'. Valid: ${STATUSES.join(', ')}`);
  }

  const now = new Date();
  const document = {
    service: system.key,
    status,
    source,
    detail,
    reported_at: now,
  };
  await serviceStatusCollection().updateOne(
    { service: system.key },
    { $set: document },
    { upsert: true },
  );

  // The 90-bar strip shows the *worst* status each day, not the latest: a day
  // containing an outage should stay red once it recovers, or the history
  // quietly erases every incident that was fixed.
  const day = dayKey(now);
  const existing = await serviceStatusDaysCollection().findOne({
    service: system.key,
    day,
  });
  const rolled = existing
    ? worst([status, String(existing['status'] ?? OPERATIONAL)])
    : status;

  await serviceStatusDaysCollection().updateOne(
    { service: system.key, day },
    { $set: { service: system.key, day, status: rolled }, $inc: { reports: 1 } },
    { upsert: true },
  );
  return document;
}

/** Daily status for the last `days`, oldest first, gaps filled `unknown`. */
export async function history(
  key: string,
  days: number,
  now = new Date(),
): Promise<Array<{ date: string; status: string }>> {
  const today = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  const start = new Date(today.getTime() - (days - 1) * 86_400_000);

  const rows = await serviceStatusDaysCollection()
    .find({ service: key, day: { $gte: dayKey(start) } })
    .toArray();
  const found = new Map(rows.map((r) => [String(r['day']), String(r['status'] ?? UNKNOWN)]));

  // Days before the service ever reported are `unknown`, not `operational` — we
  // have no evidence about them either way.
  return Array.from({ length: days }, (_, offset) => {
    const date = dayKey(new Date(start.getTime() + offset * 86_400_000));
    return { date, status: found.get(date) ?? UNKNOWN };
  });
}
