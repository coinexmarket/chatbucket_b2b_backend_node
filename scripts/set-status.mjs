/**
 * Set every system's status by hand.
 *
 * Ported from `scripts/set_status.py`. For when the truth is known but nothing
 * reports it yet — a fresh deployment where the AI services do not send
 * heartbeats and no probe URLs are configured. Without this, the status page
 * correctly reads `unknown` for everything.
 *
 *   node scripts/set-status.mjs                        # all systems operational
 *   node scripts/set-status.mjs down "DB failover"     # all systems down
 *   node scripts/set-status.mjs --service tts degraded "Slow synthesis"
 *
 * Writes straight to Mongo through the app's own database layer, so it needs
 * MONGODB_URI but no running server and no STATUS_WEBHOOK_SECRET.
 *
 * A manual status does not go stale — it stands until something changes it —
 * which is the point here and also the thing to remember: setting everything
 * `operational` by hand means the page will keep saying so through a real
 * outage, until a heartbeat or a probe says otherwise.
 */
import process from 'node:process';

const db = await import('../dist/database.js').catch(() => import('../src/database.js'));
const status = await import('../dist/services/status.js').catch(() =>
  import('../src/services/status.js'),
);

const argv = process.argv.slice(2);
let service = null;

const at = argv.indexOf('--service');
if (at !== -1) {
  service = argv[at + 1];
  argv.splice(at, 2);
}

const [state = status.OPERATIONAL, detail = null] = argv;

if (!status.STATUSES.includes(state)) {
  console.error(`Unknown status '${state}'. Valid: ${status.STATUSES.join(', ')}`);
  process.exit(2);
}

const keys = service ? [service] : Object.keys(status.SYSTEMS);
for (const key of keys) {
  if (!(key in status.SYSTEMS)) {
    console.error(`Unknown system '${key}'. Valid: ${Object.keys(status.SYSTEMS).join(', ')}`);
    process.exit(2);
  }
}

await db.connect();
try {
  for (const key of keys) {
    await status.record(key, state, status.SOURCE_MANUAL, detail);
    console.log(`  ${key.padEnd(12)} -> ${state}${detail ? `  (${detail})` : ''}`);
  }
  console.log(`\n${keys.length} system(s) set manually. This will not go stale.`);
} finally {
  await db.disconnect();
}
