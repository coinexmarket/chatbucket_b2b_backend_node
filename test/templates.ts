export {}; // Marks this file a module, so top-level `await` below is allowed.

/**
 * Every email template renders, and renders safely.
 *
 * The renderer throws on a missing value by design, and `email.ts` catches that
 * and falls back to plain text. That is the right runtime behaviour and a
 * terrible thing to discover in production: the customer gets a text-only email
 * and nothing fails loudly. So this suite renders every template through the
 * real message builders and asserts the HTML part actually came out.
 *
 * It also checks the two properties that matter beyond "it rendered":
 *   - customer-supplied text is escaped, so a display name containing markup
 *     cannot inject it into the email;
 *   - no `{{placeholder}}` survives into the output.
 */
process.env['ENVIRONMENT'] = 'development';
process.env['JWT_SECRET'] = 'template-test-secret';
process.env['EMAIL_BACKEND'] = 'memory';
process.env['SALES_EMAIL'] = 'sales@example.com';
process.env['DISPLAY_TIMEZONE'] = 'Asia/Kolkata';

import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const templates = await import('../src/emailtemplates.js');
const email = await import('../src/services/email.js');

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

console.log('\nEmail templates\n');

// --- Every file on disk is accounted for ------------------------------------

const dir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
  'templates',
  'emails',
);
const onDisk = readdirSync(dir)
  .filter((f) => f.endsWith('.html'))
  .map((f) => f.replace(/\.html$/, ''))
  .sort();

check('all 13 designed templates are present', onDisk.length === 13, String(onDisk.length));

// --- The renderer itself ----------------------------------------------------

check(
  'a value is HTML-escaped by default',
  templates
    .render('welcome', {
      name: '<script>alert(1)</script>',
      bonus_credits: '',
      credit_validity_days: 30,
    })
    .includes('&lt;script&gt;'),
  'customer-supplied markup reached the output unescaped',
);

let threw = false;
try {
  // `name` deliberately omitted.
  templates.render('welcome', { bonus_credits: '', credit_validity_days: 30 });
} catch (err) {
  threw = err instanceof templates.MissingValueError;
}
check('a missing value throws rather than blanking the slot', threw);

// A section repeats for a list, renders once for a truthy scalar, skips a falsy
// one — the behaviour the free-credits panel depends on.
const withBonus = templates.render('welcome', {
  name: 'Ada',
  bonus_credits: '100',
  credit_validity_days: 30,
});
const withoutBonus = templates.render('welcome', {
  name: 'Ada',
  bonus_credits: '',
  credit_validity_days: 30,
});
check('a truthy section renders its block', withBonus.includes('100'));
check(
  'and a falsy one hides it, rather than promising zero credits',
  withoutBonus.length < withBonus.length,
  `${withoutBonus.length} vs ${withBonus.length}`,
);

// --- Formatting -------------------------------------------------------------

const moment = new Date('2026-07-31T13:29:00Z'); // 18:59 IST
check('fmtDate reads as a date', templates.fmtDate(moment) === '31 July 2026', templates.fmtDate(moment));
check(
  'fmtShortDate is the compact card form',
  templates.fmtShortDate(moment) === '31 JUL 2026',
  templates.fmtShortDate(moment),
);
check(
  'fmtTime is in the display zone, not UTC',
  templates.fmtTime(moment).startsWith('6:59 PM'),
  templates.fmtTime(moment),
);
check('fmtMonth labels the comparison', templates.fmtMonth(moment) === 'Jul 2026', templates.fmtMonth(moment));

// A bad timezone must not stop a receipt going out.
process.env['DISPLAY_TIMEZONE'] = 'Not/AZone';
const { resetSettings } = await import('../src/config.js');
resetSettings();
check('an unknown DISPLAY_TIMEZONE falls back to UTC rather than throwing', (() => {
  try {
    templates.fmtDate(moment);
    return true;
  } catch {
    return false;
  }
})());
process.env['DISPLAY_TIMEZONE'] = 'Asia/Kolkata';
resetSettings();

// --- Every message builder produces HTML ------------------------------------
//
// Called through the real senders, so the contexts under test are the ones the
// app actually passes — not a hand-written set that happens to be complete.

const sent = email.outbox;
sent.length = 0;

// The report the reports module produces. Written out in full because the
// monthly_report template asks for ~50 keys, and a fixture that quietly omits
// one is exactly the failure this suite exists to catch.
const report: Record<string, unknown> = {
  period: 'Jul 2026',
  previous_period: 'Jun 2026',
  generated_on: '01 August 2026',
  headline_cheer: 'A strong month.',
  headline_note: 'Usage grew across every service.',
  plan_name: 'Pro',
  plan_status: 'Active',
  analytics_url: 'https://app.chatbucket.business/dashboard',
  upgrade_url: 'https://app.chatbucket.business/dashboard',
  bar_height: 140,
  services: [
    { name: 'Speech-to-Text', percent: 66, value: '820.10', color: '#6C4CF1' },
    { name: 'Text-to-Speech', percent: 34, value: '420.40', color: '#22C55E' },
  ],
};
for (let i = 1; i <= 4; i += 1) {
  Object.assign(report, {
    [`metric${i}_label`]: `Metric ${i}`,
    [`metric${i}_value`]: '1,240.50',
    [`metric${i}_previous`]: '980.00',
    [`metric${i}_change`]: '+26.6%',
    [`metric${i}_arrow`]: '↑',
    [`metric${i}_color`]: '#22C55E',
    [`metric${i}_background`]: '#ECFDF5',
  });
}
for (let i = 1; i <= 3; i += 1) {
  Object.assign(report, {
    [`bar${i}_label`]: `Service ${i}`,
    [`bar${i}_amount`]: '820.10',
    [`bar${i}_percent`]: 66,
    [`insight${i}_title`]: `Insight ${i}`,
    [`insight${i}_text`]: 'Speech-to-Text was your busiest service.',
  });
}

await email.sendWelcome('a@example.com', 'Ada Lovelace', '100');
await email.sendVerificationEmail('a@example.com', 'tok', '482913', 'Ada');
await email.sendEmailVerified('a@example.com', 'Ada', '100');
await email.sendPasswordReset('a@example.com', 'tok', 'Ada');
await email.sendContactReceived({
  _id: 'abc123',
  name: 'Ada',
  email: 'a@example.com',
  created_at: new Date('2026-07-31T13:29:00Z'),
});
await email.sendDemoRequestNotification({
  _id: 'abc123',
  name: 'Ada',
  type: 'business',
  email: 'a@example.com',
  company_name: 'Analytical Engines Ltd',
});
await email.sendSubscriptionConfirmation('a@example.com');
await email.sendOnboardingNudge('a@example.com', 'Ada');
await email.sendDepositReceipt('a@example.com', 'Ada', {
  amount: '10,000.00',
  balance: '11,100.00',
  transaction_id: 'cb_top_abc',
  payment_method: 'UPI',
  payment_provider: 'Gateway',
  date: '31 July 2026',
  time: '6:59 PM IST',
  transaction_url: 'https://app.chatbucket.business/dashboard',
});
await email.sendFreeCreditsExpiring('a@example.com', 'Ada', {
  days_remaining: 3,
  expiry_date: '31 July 2026',
  expiry_time: '11:59 PM IST',
});
await email.sendMonthlyReport('a@example.com', 'Ada', report);
await email.sendAnnouncement('a@example.com', {
  subject: 'Six new voices',
  headline: 'Six new voices',
  hero_title: 'Six new voices',
  hero_subtitle: 'Now in more Indian languages',
  summary: 'We have added six new Indian-language voices.',
  highlights: ['Two new Telugu voices', 'Improved Hindi prosody'],
  quote: 'This is the best release yet.',
  quote_author: 'The team',
  category: 'Product',
  date: '31 July 2026',
  time: '6:59 PM IST',
  reference_id: 'ANN-2026-07',
});
await email.sendMaintenanceNotice('a@example.com', 'Ada', {
  subject: 'Scheduled ChatBucket maintenance',
  maintenance_type: 'Scheduled maintenance',
  start_date: '06 AUG 2026',
  start_time: '2:00 AM IST',
  end_date: '06 AUG 2026',
  end_time: '4:00 AM IST',
  reference_id: 'MNT-2026-08',
});

check(`every builder sent a message (${sent.length})`, sent.length === 13, String(sent.length));

/**
 * The one message with no designed template, on purpose.
 *
 * The sales notification goes to a colleague for pasting into a CRM, not to a
 * customer, so a styled email would only get in the way. Named explicitly
 * rather than skipped by a loose rule, so a template that stops rendering can
 * never be mistaken for one that never had a template.
 */
const PLAIN_TEXT_ONLY = ['New demo request:'];

for (const message of sent) {
  const label = message.subject.slice(0, 44);
  const plainOnly = PLAIN_TEXT_ONLY.some((prefix) => message.subject.startsWith(prefix));

  if (plainOnly) {
    check(`plain text by design: ${label}`, message.html === undefined,
      'this one should carry no HTML part');
  } else {
    check(`HTML rendered: ${label}`, typeof message.html === 'string' && message.html.length > 0,
      'fell back to plain text — a context key is missing');
  }
  check(`no unrendered placeholder: ${label}`, !/\{\{[^}]+\}\}/.test(message.html ?? ''),
    (message.html ?? '').match(/\{\{[^}]+\}\}/)?.[0] ?? '');
  check(`a plain-text part exists: ${label}`, message.text.trim().length > 0);
}

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
