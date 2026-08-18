/**
 * The status prober — the third way a service's status gets recorded.
 *
 * Ported from `_probe_services_forever` in `app/main.py`. `status.ts` accepts
 * three sources: `heartbeat` (a service reports in), `manual` (a human declares
 * an incident), and `probe` — this, where the platform polls a health URL
 * itself.
 *
 * Only runs when `STATUS_PROBE_URLS` is set, so a deployment that reports by
 * heartbeat instead pays nothing for it.
 *
 * The three-way verdict matters more than it looks. A 5xx means the service is
 * answering but broken, which is **down**. A 4xx means it answered and refused,
 * which is **degraded** — the process is alive, so calling it down would page
 * somebody for the wrong thing. Anything that does not answer at all is down.
 */
import { getSettings } from '../config.js';
import { logger } from '../logger.js';
import * as serviceStatus from './status.js';

/** A probe that hangs must not hold the loop up behind it. */
const PROBE_TIMEOUT_MS = 5_000;

let stopped = false;

/** Stop the loop. Used by tests and by graceful shutdown. */
export function stopProber(): void {
  stopped = true;
}

/** Poll one URL and decide what it says about the service. */
export async function probe(url: string): Promise<string> {
  try {
    const response = await fetch(url, {
      method: 'GET',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      redirect: 'follow',
    });
    if (response.ok) return serviceStatus.OPERATIONAL;
    // It answered, just not happily. 5xx is broken; 4xx is alive and refusing,
    // which is degraded rather than down.
    return response.status >= 500 ? serviceStatus.DOWN : serviceStatus.DEGRADED;
  } catch {
    // Timed out, DNS failed, connection refused — nothing answered.
    return serviceStatus.DOWN;
  }
}

/**
 * Poll each configured health URL on a timer and record the result.
 *
 * Never exits on error: a prober that dies on one bad tick is worse than no
 * prober, because the status page keeps showing whatever it last recorded and
 * looks like it is still being checked.
 */
export async function proberLoop(): Promise<void> {
  const s = getSettings();
  const probes = Object.entries(s.statusProbeMap);
  if (probes.length === 0) return;

  stopped = false;
  logger.info(
    'status prober on: %d service(s), every %ds',
    probes.length,
    s.STATUS_PROBE_INTERVAL_SECONDS,
  );

  while (!stopped) {
    for (const [key, url] of probes) {
      if (stopped) break;
      try {
        await serviceStatus.record(key, await probe(url), serviceStatus.SOURCE_PROBE);
      } catch (err) {
        // An unknown system key, or Mongo being unreachable. Logged and skipped
        // rather than allowed to kill the loop — the next tick may well work.
        logger.error(
          'status probe for %s failed: %s',
          key,
          err instanceof Error ? err.message : err,
        );
      }
    }
    await new Promise((resolve) =>
      setTimeout(resolve, s.STATUS_PROBE_INTERVAL_SECONDS * 1000).unref(),
    );
  }
}
