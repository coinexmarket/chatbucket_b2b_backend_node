/**
 * Render every designed email, and optionally send them.
 *
 * Ported from `scripts/send_test_emails.py`.
 *
 *   node scripts/send-test-emails.mjs --list
 *   node scripts/send-test-emails.mjs --out ./preview      # render to disk
 *   node scripts/send-test-emails.mjs --to you@example.com # actually send
 *   node scripts/send-test-emails.mjs --only welcome,deposit
 *
 * Every sample is rendered through the **real message builders**, not a
 * hand-written context, so a preview cannot look right while the live email is
 * missing a value. The renderer throws on a missing key; `email.ts` catches
 * that and falls back to plain text, so this script checks for the HTML part
 * and reports a fallback as a failure rather than letting it pass silently.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const argv = process.argv.slice(2);
const flag = (name) => {
  const at = argv.indexOf(name);
  return at === -1 ? null : argv[at + 1];
};
const has = (name) => argv.includes(name);

const to = flag('--to');
const outDir = flag('--out');
const only = flag('--only');

// Nothing is sent unless --to is given, so a mistyped flag renders rather than
// mails. The memory backend also lets the HTML be inspected either way.
process.env.EMAIL_BACKEND = to ? (process.env.EMAIL_BACKEND ?? 'smtp') : 'memory';
process.env.JWT_SECRET ??= 'send-test-emails';

const email = await import('../dist/services/email.js').catch(() =>
  import('../src/services/email.js'),
);

const now = new Date('2026-07-31T13:29:00Z');

const report = {
  period: '01 July 2026 - 31 July 2026',
  previous_period: 'Jun 2026',
  generated_on: '01 August 2026',
  headline_cheer: 'Great job! 🚀',
  headline_note: 'Your usage grew against last month.',
  plan_name: 'Pro',
  plan_status: 'Active',
  analytics_url: 'https://chatbucket.business/dashboard',
  upgrade_url: 'https://chatbucket.business/dashboard',
  bar_height: 140,
  services: [
    { name: 'Speech to Text', percent: '66', value: '₹820.10', color: '#5421C7', bar_height: 92 },
    { name: 'Text to Speech', percent: '34', value: '₹420.40', color: '#7C4DEE', bar_height: 48 },
  ],
};
for (let i = 1; i <= 4; i += 1) {
  Object.assign(report, {
    [`metric${i}_label`]: ['Total Requests', 'Total Spend', 'Voice Minutes Used', 'Agent Interactions'][i - 1],
    [`metric${i}_value`]: '8,421',
    [`metric${i}_previous`]: '6,650',
    [`metric${i}_change`]: '26.6%',
    [`metric${i}_arrow`]: '↑',
    [`metric${i}_color`]: '#239653',
    [`metric${i}_background`]: '#DDF5E6',
  });
}
for (let i = 1; i <= 3; i += 1) {
  Object.assign(report, {
    [`bar${i}_label`]: ['Speech to Text', 'Text to Speech', 'Translation'][i - 1],
    [`bar${i}_amount`]: '₹820.10 / ₹1,240.50',
    [`bar${i}_percent`]: '66',
    [`insight${i}_title`]: ["You're Growing!", 'Automation at work', 'Pro Tip'][i - 1],
    [`insight${i}_text`]: 'Speech to Text is your biggest line. Batch those calls to cut cost.',
  });
}

const SAMPLES = {
  welcome: () => email.sendWelcome(to ?? 'sample@example.com', 'Ada Lovelace', '100'),
  email_verification: () =>
    email.sendVerificationEmail(to ?? 'sample@example.com', 'sample-token', '482913', 'Ada'),
  email_verified: () => email.sendEmailVerified(to ?? 'sample@example.com', 'Ada', '100'),
  password_reset: () =>
    email.sendPasswordReset(to ?? 'sample@example.com', 'sample-token', 'Ada'),
  contact_received: () =>
    email.sendContactReceived({
      _id: 'CBQ-2026-0714',
      name: 'Ada',
      email: to ?? 'sample@example.com',
      created_at: now,
    }),
  subscribed: () => email.sendSubscriptionConfirmation(to ?? 'sample@example.com'),
  onboarding_nudge: () => email.sendOnboardingNudge(to ?? 'sample@example.com', 'Ada'),
  deposit: () =>
    email.sendDepositReceipt(to ?? 'sample@example.com', 'Ada', {
      amount: '10,000.00',
      balance: '11,100.00',
      transaction_id: 'cb_top_9f2a1c',
      payment_method: 'UPI',
      payment_provider: 'Gateway',
      date: '31 July 2026',
      time: '6:59 PM IST',
      transaction_url: 'https://chatbucket.business/dashboard',
    }),
  free_credits_expiring: () =>
    email.sendFreeCreditsExpiring(to ?? 'sample@example.com', 'Ada', {
      days_remaining: 3,
      expiry_date: '31 July 2026',
      expiry_time: '11:59 PM IST',
    }),
  monthly_report: () => email.sendMonthlyReport(to ?? 'sample@example.com', 'Ada', report),
  announcement: () =>
    email.sendAnnouncement(to ?? 'sample@example.com', {
      subject: 'Six new Indian-language voices',
      headline: 'Six new voices',
      hero_title: 'Six new voices',
      hero_subtitle: 'Now in more Indian languages',
      summary: 'We have added six new Indian-language voices to Text to Speech.',
      highlights: ['Two new Telugu voices', 'Improved Hindi prosody', 'Faster streaming'],
      quote: 'This is the best release yet.',
      quote_author: 'The ChatBucket team',
      category: 'Product',
      date: '31 July 2026',
      time: '6:59 PM IST',
      reference_id: 'ANN-2026-07',
    }),
  maintenance: () =>
    email.sendMaintenanceNotice(to ?? 'sample@example.com', 'Ada', {
      subject: 'Scheduled ChatBucket maintenance',
      maintenance_type: 'Scheduled maintenance',
      start_date: '06 AUG 2026',
      start_time: '2:00 AM IST',
      end_date: '06 AUG 2026',
      end_time: '4:00 AM IST',
      reference_id: 'MNT-2026-08',
    }),
};

if (has('--list')) {
  console.log(Object.keys(SAMPLES).join('\n'));
  process.exit(0);
}

const wanted = only
  ? only.split(',').map((s) => s.trim()).filter(Boolean)
  : Object.keys(SAMPLES);

for (const name of wanted) {
  if (!(name in SAMPLES)) {
    console.error(`Unknown sample '${name}'. Use --list to see them.`);
    process.exit(2);
  }
}

if (outDir) await mkdir(outDir, { recursive: true });

let failures = 0;
for (const name of wanted) {
  email.outbox.length = 0;
  const delivered = await SAMPLES[name]();
  const message = email.outbox[0];

  // The sales notification is plain text by design; everything else must carry
  // HTML, and a fallback here means a context key is missing.
  const expectHtml = name !== 'demo_notification';
  const html = message?.html;

  if (expectHtml && !html) {
    console.error(`  FAIL  ${name}: fell back to plain text — a context key is missing`);
    failures += 1;
    continue;
  }
  if (html && /\{\{[^}]+\}\}/.test(html)) {
    console.error(`  FAIL  ${name}: unrendered placeholder ${html.match(/\{\{[^}]+\}\}/)[0]}`);
    failures += 1;
    continue;
  }

  if (outDir && html) {
    await writeFile(path.join(outDir, `${name}.html`), html, 'utf8');
  }
  const where = to ? (delivered ? `sent to ${to}` : 'NOT DELIVERED') : 'rendered';
  console.log(`  ok    ${name.padEnd(22)} ${String(html?.length ?? 0).padStart(6)} bytes  ${where}`);
  if (to && !delivered) failures += 1;
}

console.log(
  `\n${wanted.length - failures}/${wanted.length} ok` +
    (outDir ? `; HTML written to ${outDir}` : ''),
);
process.exit(failures > 0 ? 1 : 0);
