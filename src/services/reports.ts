/**
 * The monthly usage report — the figures behind `monthly_report.html`.
 *
 * Ported from `app/reports.py`. Kept out of `email.ts` because it is arithmetic
 * over the usage collection, not message construction.
 *
 * Every figure here is computed from records this service actually stored. The
 * design ships with sample metrics ("conversations", "messages processed") that
 * this platform does not meter; rather than invent them, the four headline cards
 * are labelled with what *is* metered — requests, spend, voice minutes and agent
 * interactions — and the labels travel with the values so a card and its number
 * can never disagree.
 */
import type { ObjectId } from 'mongodb';

import { getSettings } from '../config.js';
import { creditAccountsCollection, usageCollection } from '../database.js';
import * as templates from '../emailtemplates.js';
import { Decimal, toDecimal, toJson, total as sumOf, type AmountLike } from '../money.js';
import { getPlan } from '../plans.js';
import { SERVICES } from '../pricing.js';
import { fromUnits } from './credits.js';

/**
 * Services billed by the minute, and services that are an "agent interaction".
 * Derived from the rate card rather than hard-coded, so a new minute-priced
 * service joins the voice total the day it is priced.
 */
const MINUTE_SERVICES = Object.values(SERVICES)
  .filter((s) => s.unit === 'minutes')
  .map((s) => s.key);
const AGENT_SERVICES = ['chat_agent', 'voice_agent_web', 'voip_call'];

/** Legend colours, in the order the design uses them. */
const SERVICE_COLORS = ['#5421C7', '#7C4DEE', '#A07BF5', '#C4AAFA', '#E2D6FD'];

/**
 * Short names for the report only.
 *
 * The legend and share bars are narrow columns beside a right-aligned
 * percentage, and the rate card's full labels ("Speech-to-Text (streaming)")
 * wrap onto two lines there and collide with it. `pricing.ts` keeps the precise
 * names — an invoice needs to say which variant was billed; a chart legend does
 * not.
 */
const SHORT_LABELS: Record<string, string> = {
  stt_streaming: 'Speech to Text',
  stt_offline: 'Speech to Text (file)',
  tts_streaming: 'Text to Speech',
  tts_offline: 'Text to Speech (file)',
  translation: 'Translation',
  chat_agent: 'Chat Agent',
  voice_agent_web: 'Voice Agent',
  voip_call: 'Voice Agent (call)',
};

function serviceLabel(key: string): string {
  return SHORT_LABELS[key] ?? SERVICES[key]?.label ?? key;
}

/** Height of the stacked bar beside the legend, in pixels. */
const CHART_HEIGHT = 140;
const MIN_SLICE = 4;

const UP = '↑';
const DOWN = '↓';
const FLAT = '→';
const GREEN = '#239653';
const GREEN_BG = '#DDF5E6';
const RED = '#C2334D';
const RED_BG = '#FBE4E9';
const GREY = '#70697C';
const GREY_BG = '#EFEDF4';

/** The calendar month containing `when`, as `[start, nextStart)`. */
export function monthWindow(when: Date): [Date, Date] {
  const start = new Date(Date.UTC(when.getUTCFullYear(), when.getUTCMonth(), 1));
  // Adding 32 days and snapping back to the 1st lands on the next month for
  // every month length, which arithmetic on `month + 1` does not.
  const plus32 = new Date(start.getTime() + 32 * 86_400_000);
  const following = new Date(Date.UTC(plus32.getUTCFullYear(), plus32.getUTCMonth(), 1));
  return [start, following];
}

export function previousMonthWindow(start: Date): [Date, Date] {
  const dayBefore = new Date(start.getTime() - 86_400_000);
  const previousStart = new Date(
    Date.UTC(dayBefore.getUTCFullYear(), dayBefore.getUTCMonth(), 1),
  );
  return [previousStart, start];
}

interface Totals {
  requests: number;
  cost: Decimal;
  minutes: number;
  agentRequests: number;
  byService: Map<string, Record<string, unknown>>;
}

/** Requests, spend, voice minutes and agent interactions for one window. */
async function totalsFor(userId: ObjectId, begin: Date, finish: Date): Promise<Totals> {
  const rows = await usageCollection()
    .aggregate([
      { $match: { user_id: userId, created_at: { $gte: begin, $lt: finish } } },
      {
        $group: {
          _id: '$service',
          cost: { $sum: '$cost' },
          quantity: { $sum: '$quantity' },
          requests: { $sum: 1 },
        },
      },
    ])
    .toArray();

  const byService = new Map(rows.map((r) => [String(r['_id']), r]));
  const sumOver = (keys: string[], field: string): number =>
    keys.reduce((n, k) => n + Number(byService.get(k)?.[field] ?? 0), 0);

  return {
    requests: rows.reduce((n, r) => n + Number(r['requests'] ?? 0), 0),
    cost: sumOf(rows.map((r) => (r['cost'] ?? 0) as AmountLike)),
    minutes: sumOver(MINUTE_SERVICES, 'quantity'),
    agentRequests: sumOver(AGENT_SERVICES, 'requests'),
    byService,
  };
}

/**
 * `[label, arrow, colour, pill background]` for a month-over-month move.
 *
 * With no previous month there is no percentage to state: "100%" and "0%" would
 * both be inventions, so it reads "new" and renders neutral.
 */
function change(current: AmountLike, previous: AmountLike): [string, string, string, string] {
  const now = toDecimal(current);
  const before = toDecimal(previous);

  if (before.isZero()) {
    if (now.isZero()) return ['no change', FLAT, GREY, GREY_BG];
    return ['new', UP, GREEN, GREEN_BG];
  }
  const percent = now.minus(before).dividedBy(before).times(100);
  if (percent.greaterThan(0)) return [`${percent.toFixed(1)}%`, UP, GREEN, GREEN_BG];
  if (percent.lessThan(0)) return [`${percent.abs().toFixed(1)}%`, DOWN, RED, RED_BG];
  return ['0.0%', FLAT, GREY, GREY_BG];
}

/**
 * One headline card.
 *
 * `current` and `previous` are the raw figures — the direction of travel is
 * computed from those, never from rendered text, or "₹1,000" would compare as
 * smaller than "₹900".
 */
function metric(
  index: number,
  label: string,
  current: AmountLike,
  previous: AmountLike,
  render: (v: AmountLike) => string,
): Record<string, unknown> {
  const [text, arrow, color, background] = change(current, previous);
  return {
    [`metric${index}_label`]: label,
    [`metric${index}_value`]: render(current),
    [`metric${index}_previous`]: render(previous),
    [`metric${index}_change`]: text,
    [`metric${index}_arrow`]: arrow,
    [`metric${index}_color`]: color,
    [`metric${index}_background`]: background,
  };
}

const group = (n: number): string => n.toLocaleString('en-US');

const count = (value: AmountLike): string => group(Math.trunc(toDecimal(value).toNumber()));

const amount = (value: AmountLike): string =>
  `${templates.currencySymbol()}${toJson(value).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

/** Minutes read as whole numbers unless the month really was fractional. */
function roundQuantity(value: AmountLike): string {
  const quantity = Math.round(toDecimal(value).toNumber() * 10) / 10;
  return Number.isInteger(quantity)
    ? group(quantity)
    : quantity.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

/** The five biggest services by spend, with share, colour and bar height. */
function topServices(
  byService: Map<string, Record<string, unknown>>,
  totalCost: Decimal,
): Array<Record<string, unknown>> {
  const ranked = [...byService.entries()]
    .map(([key, row]) => [key, toDecimal((row['cost'] ?? 0) as AmountLike)] as const)
    .sort((a, b) => b[1].comparedTo(a[1]))
    .slice(0, 5);

  return ranked.map(([key, cost], position) => {
    const share = totalCost.isZero()
      ? 0
      : cost.dividedBy(totalCost).times(100).toNumber();
    return {
      name: serviceLabel(key),
      percent: String(Math.round(share)),
      value: amount(cost),
      color: SERVICE_COLORS[position % SERVICE_COLORS.length],
      // A service with a rounding-error share still needs a visible sliver, or
      // the bar silently loses a row the legend still lists.
      bar_height: Math.max(Math.round((CHART_HEIGHT * share) / 100), MIN_SLICE),
    };
  });
}

/** Three plain observations, drawn from the same figures as the cards. */
function insights(
  current: Totals,
  previous: Totals,
  services: Array<Record<string, unknown>>,
): Record<string, unknown> {
  const [spendChange] = change(current.cost, previous.cost);
  const grew = current.cost.greaterThan(previous.cost);

  let first: [string, string];
  if (previous.requests === 0 && current.requests > 0) {
    first = ["You're off the ground!", 'This is your first month of metered usage. Nice work.'];
  } else if (grew) {
    first = ["You're Growing!", `Your spend is up ${spendChange} on last month. Keep going!`];
  } else if (current.requests === 0) {
    first = ['A quiet month', "No metered calls this month. We're here when you need us."];
  } else {
    first = ['Steady month', `Your spend moved ${spendChange} against last month.`];
  }

  const second: [string, string] = current.agentRequests
    ? [
        'Automation at work',
        `Agents handled ${group(current.agentRequests)} interactions this month.`,
      ]
    : [
        'Try an agent',
        'Chat and voice agents can handle the repetitive conversations for you.',
      ];

  const third: [string, string] = services.length
    ? ['Pro Tip', `${String(services[0]!['name'])} is your biggest line. Batch those calls to cut cost.`]
    : ['Pro Tip', 'Start with a single prompt and let the builder assemble the agent for you.'];

  return {
    insight1_title: first[0],
    insight1_text: first[1],
    insight2_title: second[0],
    insight2_text: second[1],
    insight3_title: third[0],
    insight3_text: third[1],
  };
}

/** Everything `monthly_report.html` needs for one account and one month. */
export async function buildMonthlyReport(
  user: Record<string, unknown>,
  monthStart: Date,
): Promise<Record<string, unknown>> {
  const s = getSettings();
  const userId = user['_id'] as ObjectId;
  const [begin, finish] = monthWindow(monthStart);
  const [previousBegin, previousFinish] = previousMonthWindow(begin);

  const current = await totalsFor(userId, begin, finish);
  const previous = await totalsFor(userId, previousBegin, previousFinish);

  const plan = getPlan(user['plan'] as string | undefined);
  const account: Record<string, unknown> =
    (await creditAccountsCollection().findOne({ user_id: userId })) ?? {};
  const balance = fromUnits(Number(account['balance_units'] ?? 0));

  const services = topServices(current.byService, current.cost);

  // The three bars under "Your Plan & Usage". The design's quota bars do not
  // apply — this is prepaid credit, there is no monthly allowance to fill — so
  // they show each top service's share of the month's spend instead, which is a
  // proportion that genuinely has a denominator.
  const totalLabel = amount(current.cost);
  const bars: Record<string, unknown> = {};
  for (let index = 1; index <= 3; index += 1) {
    const service = services[index - 1];
    bars[`bar${index}_label`] = service ? service['name'] : '-';
    bars[`bar${index}_percent`] = service ? service['percent'] : '0';
    bars[`bar${index}_amount`] = service ? `${String(service['value'])} / ${totalLabel}` : '-';
  }

  const dashboard = `${s.FRONTEND_URL.replace(/\/$/, '')}${s.DASHBOARD_PATH}`;
  // `finish` is exclusive, so the last day of the month is the day before it.
  const lastDay = new Date(finish.getTime() - 86_400_000);

  return {
    period: `${templates.fmtDate(begin)} - ${templates.fmtDate(lastDay)}`,
    previous_period: templates.fmtMonth(previousBegin),
    generated_on: templates.fmtDate(new Date()),
    plan_name: plan.label,
    // Prepaid: an account is "active" while it can still pay for a call.
    plan_status: balance.greaterThan(0) ? 'Active' : 'No credits',
    analytics_url: dashboard,
    upgrade_url: dashboard,
    bar_height: CHART_HEIGHT,
    services,
    // Two halves of one sentence in the design; the second is emphasised.
    // Congratulating an account on a month its usage fell would be worse than
    // saying nothing, so both halves move together.
    headline_note: current.cost.greaterThan(previous.cost)
      ? 'Your usage grew against last month.'
      : `Measured against ${templates.fmtMonth(previousBegin)}.`,
    headline_cheer: current.cost.greaterThan(previous.cost) ? 'Great job! 🚀' : '',
    ...metric(1, 'Total Requests', current.requests, previous.requests, count),
    ...metric(2, 'Total Spend', current.cost, previous.cost, amount),
    ...metric(3, 'Voice Minutes Used', current.minutes, previous.minutes, roundQuantity),
    ...metric(4, 'Agent Interactions', current.agentRequests, previous.agentRequests, count),
    ...bars,
    ...insights(current, previous, services),
    has_usage: current.requests > 0,
  };
}
