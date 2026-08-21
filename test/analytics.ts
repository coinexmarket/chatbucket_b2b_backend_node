export {}; // Marks this file a module, so top-level `await` below is allowed.

// Guard first: the suites drop their database, and MONGODB_URI comes from
// .env, which may point at production.
await import('./local-only.js');

/**
 * Time bucketing for the usage charts.
 *
 * This file exists because the first version of `/usage/timeseries` shipped
 * without it and was wrong in a way its own smoke test could not see: the test
 * asserted "timeseries responds" and "an unknown granularity is refused", both
 * of which passed while empty days were being dropped from the response
 * entirely. A chart built from that silently skips a quiet Tuesday.
 *
 * So these tests assert the two properties that actually matter — every bucket
 * in the range is present, and a range too wide to serve is refused — plus the
 * label formats, because a label that does not match what Mongo's
 * `$dateToString` produces makes the merge miss and every bucket read zero.
 */
process.env['ENVIRONMENT'] = 'development';
process.env['JWT_SECRET'] = 'analytics-test-secret';

const analytics = await import('../src/analytics.js');

let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail ? `  ${detail}` : ''}`);
  }
}

console.log('\nUsage chart bucketing\n');

// --- Granularities ----------------------------------------------------------

check(
  'the three granularities the dashboard offers exist',
  Object.keys(analytics.GRANULARITIES).sort().join(',') === 'daily,hourly,minute',
  Object.keys(analytics.GRANULARITIES).join(','),
);
check('an absent granularity defaults to daily', analytics.getGranularity(undefined).key === 'daily');
check('as does an empty one', analytics.getGranularity('').key === 'daily');
check('and case does not matter', analytics.getGranularity('HOURLY').key === 'hourly');

let threw = false;
try {
  analytics.getGranularity('monthly');
} catch {
  threw = true;
}
check('an unsupported granularity is refused, not silently coerced', threw);

// --- Parsing ----------------------------------------------------------------

check(
  'a bare date is read as UTC midnight',
  analytics.parseInstant('2026-04-12').toISOString() === '2026-04-12T00:00:00.000Z',
  analytics.parseInstant('2026-04-12').toISOString(),
);
check(
  'a zoneless timestamp is read as UTC, not local',
  analytics.parseInstant('2026-04-12T09:30:00').toISOString() === '2026-04-12T09:30:00.000Z',
  analytics.parseInstant('2026-04-12T09:30:00').toISOString(),
);
check(
  'an explicit offset is honoured',
  analytics.parseInstant('2026-04-12T09:30:00+05:30').toISOString() === '2026-04-12T04:00:00.000Z',
  analytics.parseInstant('2026-04-12T09:30:00+05:30').toISOString(),
);
check('Z is accepted', analytics.parseInstant('2026-04-12T04:00:00Z').toISOString() === '2026-04-12T04:00:00.000Z');

let badThrew = false;
try {
  analytics.parseInstant('not-a-date');
} catch {
  badThrew = true;
}
check('a malformed date is refused', badThrew);

// --- Truncation -------------------------------------------------------------

const moment = new Date('2026-04-12T09:37:42.512Z');
const daily = analytics.getGranularity('daily');
const hourly = analytics.getGranularity('hourly');
const minute = analytics.getGranularity('minute');

check(
  'daily snaps to midnight',
  analytics.truncate(moment, daily).toISOString() === '2026-04-12T00:00:00.000Z',
  analytics.truncate(moment, daily).toISOString(),
);
check(
  'hourly snaps to the hour',
  analytics.truncate(moment, hourly).toISOString() === '2026-04-12T09:00:00.000Z',
  analytics.truncate(moment, hourly).toISOString(),
);
check(
  'minute snaps to the minute',
  analytics.truncate(moment, minute).toISOString() === '2026-04-12T09:37:00.000Z',
  analytics.truncate(moment, minute).toISOString(),
);

// --- Range resolution -------------------------------------------------------

const now = new Date('2026-04-12T12:00:00Z');

let [begin, finish] = analytics.resolveRange(daily, null, null, now);
check('with no range, `to` defaults to now', finish.getTime() === now.getTime());
check(
  'and `from` to one default span before it (30 days for daily)',
  (finish.getTime() - begin.getTime()) / 86_400_000 === 30,
  String((finish.getTime() - begin.getTime()) / 86_400_000),
);

[begin, finish] = analytics.resolveRange(minute, null, null, now);
check(
  'minute defaults to a 6-hour window, not 30 days',
  (finish.getTime() - begin.getTime()) / 3_600_000 === 6,
  String((finish.getTime() - begin.getTime()) / 3_600_000),
);

let reversed = false;
try {
  analytics.resolveRange(daily, '2026-04-12', '2026-04-01', now);
} catch {
  reversed = true;
}
check('a backwards range is refused', reversed);

// The reason ranges are bounded at all: a minute query over a year would be
// 525,600 buckets, and building that response helps nobody.
let tooLarge = false;
let message = '';
try {
  analytics.resolveRange(minute, '2025-04-12', '2026-04-12', now);
} catch (err) {
  tooLarge = err instanceof analytics.RangeTooLargeError;
  message = err instanceof Error ? err.message : '';
}
check('a minute range over a year is refused', tooLarge);
check(
  'and the message says how to fix it',
  message.includes('coarser granularity'),
  message,
);
check(
  'a minute range inside the cap is allowed',
  (() => {
    try {
      analytics.resolveRange(minute, '2026-04-11', '2026-04-12', now);
      return true;
    } catch {
      return false;
    }
  })(),
);
check(
  'daily tolerates two years',
  (() => {
    try {
      analytics.resolveRange(daily, '2024-05-12', '2026-04-12', now);
      return true;
    } catch {
      return false;
    }
  })(),
);

// --- Bucket labels ----------------------------------------------------------
//
// The property the original endpoint got wrong: every bucket in the range is
// present, including the ones with no usage.

const dayLabels = analytics.bucketLabels(
  new Date('2026-04-10T13:00:00Z'),
  new Date('2026-04-12T02:00:00Z'),
  daily,
);
check(
  'daily labels cover every day in the range, inclusive',
  dayLabels.join(',') === '2026-04-10,2026-04-11,2026-04-12',
  dayLabels.join(','),
);

const hourLabels = analytics.bucketLabels(
  new Date('2026-04-12T22:10:00Z'),
  new Date('2026-04-13T01:05:00Z'),
  hourly,
);
check(
  'hourly labels roll across midnight',
  hourLabels.join(',') === '2026-04-12T22:00,2026-04-12T23:00,2026-04-13T00:00,2026-04-13T01:00',
  hourLabels.join(','),
);

const minuteLabels = analytics.bucketLabels(
  new Date('2026-04-12T09:58:30Z'),
  new Date('2026-04-12T10:01:00Z'),
  minute,
);
check(
  'minute labels roll across the hour',
  minuteLabels.join(',') === '2026-04-12T09:58,2026-04-12T09:59,2026-04-12T10:00,2026-04-12T10:01',
  minuteLabels.join(','),
);

check(
  'a range inside one bucket still yields that bucket',
  analytics.bucketLabels(
    new Date('2026-04-12T09:10:00Z'),
    new Date('2026-04-12T09:50:00Z'),
    daily,
  ).length === 1,
);

// A month boundary is where a naive "add a day" loop drifts.
const monthEnd = analytics.bucketLabels(
  new Date('2026-02-27T00:00:00Z'),
  new Date('2026-03-02T00:00:00Z'),
  daily,
);
check(
  'the February boundary is walked correctly',
  monthEnd.join(',') === '2026-02-27,2026-02-28,2026-03-01,2026-03-02',
  monthEnd.join(','),
);

// The labels must match what Mongo's $dateToString produces for the same
// format, or the merge misses and every bucket reads zero.
check(
  'daily labels match the Mongo format %Y-%m-%d',
  /^\d{4}-\d{2}-\d{2}$/.test(dayLabels[0] as string),
  dayLabels[0],
);
check(
  'hourly labels match %Y-%m-%dT%H:00',
  /^\d{4}-\d{2}-\d{2}T\d{2}:00$/.test(hourLabels[0] as string),
  hourLabels[0],
);
check(
  'minute labels match %Y-%m-%dT%H:%M',
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(minuteLabels[0] as string),
  minuteLabels[0],
);

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
