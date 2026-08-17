/**
 * End-to-end smoke test for the ported routes.
 *
 * Mirrors `scripts/smoke_b2b.py`. Runs against a REAL MongoDB (a throwaway
 * database, dropped at both ends) rather than a mock, because the behaviour
 * being tested is largely *in* MongoDB: unique indexes, TTL expiry, atomic
 * `$inc` under `$gte`. A mock that reimplements those would be testing the mock.
 *
 *   MONGODB_URI=mongodb://127.0.0.1:27017 npm test
 */
export {}; // Marks this file a module, so top-level `await` below is allowed.

// Set before importing anything from src: `getSettings()` reads the environment
// once and caches it, so a later assignment would be silently ignored.
process.env['ENVIRONMENT'] = 'development';
process.env['JWT_SECRET'] = 'smoke-test-secret';
process.env['MONGODB_DB'] = 'chatbucket_b2b_nodetest';
// Never touch a real gateway from a test; assert against the outbox instead.
process.env['SMS_BACKEND'] = 'memory';
process.env['EMAIL_BACKEND'] = 'memory';
process.env['SMS_TEMPLATE_SUFFIX'] = '';
process.env['SIGNUP_BONUS_CREDITS'] = '100';

const { createApp } = await import('../src/app.js');
const { connect, disconnect, ensureIndexes, usersCollection, phoneVerificationsCollection } =
  await import('../src/database.js');
const { outbox, renderOtpMessage } = await import('../src/services/sms.js');
const { getSettings } = await import('../src/config.js');
const { toDecimal } = await import('../src/money.js');
const credits = await import('../src/services/credits.js');

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

/** Minimal HTTP client against the app, without binding a port for each call. */
function client(baseUrl: string) {
  return async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* non-JSON body; `text` is the detail */
    }
    return { status: res.status, json, text };
  };
}

async function main(): Promise<void> {
  await connect();
  // A clean slate, so a previous run cannot make this one pass or fail.
  const db = (await import('../src/database.js')).usersCollection().dbName;
  console.log(`\nSmoke test against ${db}\n`);
  await usersCollection().deleteMany({});
  await phoneVerificationsCollection().deleteMany({});
  await ensureIndexes();

  const server = createApp().listen(0);
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const call = client(`http://127.0.0.1:${port}`);

  try {
    // --- Health -------------------------------------------------------------
    let r = await call('GET', '/health');
    check('health responds', r.status === 200 && r.json?.status === true, r.text);
    check('and reports indexes ready', r.json?.indexes === 'ready', r.text);

    // --- Validation ---------------------------------------------------------
    r = await call('POST', '/auth/register', {
      name: 'No Terms',
      email: 'noterms@acme.io',
      password: 'supersecret1',
      mobile: '+919876543210',
      acceptTerms: false,
    });
    check('terms must be accepted -> 422', r.status === 422, r.text);

    r = await call('POST', '/auth/register', {
      name: 'Bad Phone',
      email: 'badphone@acme.io',
      password: 'supersecret1',
      mobile: '9876543210',
      acceptTerms: true,
    });
    check('a number with no country code -> 422', r.status === 422, r.text);

    r = await call('POST', '/auth/register', {
      name: 'Extra Field',
      email: 'extra@acme.io',
      password: 'supersecret1',
      mobile: '+919876543211',
      acceptTerms: true,
      nickname: 'oops',
    });
    check('unknown signup field -> 422, not silently dropped', r.status === 422, r.text);

    // --- The signup form's order: prove the number, THEN create the account ---
    outbox.length = 0;
    r = await call('POST', '/auth/verify-phone/resend', { mobile: '+919000000777' });
    check('an unregistered number is texted a code', outbox.length === 1, JSON.stringify(outbox));
    const pendingCode = r.json?.phone_code as string;
    check('dev mode returns the code to read', /^\d{6}$/.test(pendingCode ?? ''), r.text);
    check(
      'the text matches the DLT-registered template',
      outbox[0]?.body === renderOtpMessage(pendingCode),
      outbox[0]?.body,
    );
    check(
      'and carries no trailing suffix',
      !outbox[0]?.body.endsWith('ChatBucket'),
      outbox[0]?.body,
    );

    r = await call('POST', '/auth/verify-phone', { mobile: '+919000000777', code: '000000' });
    check('a wrong pre-signup code is refused', r.status === 400, r.text);
    r = await call('POST', '/auth/verify-phone', { mobile: '+919000000777', code: pendingCode });
    check('the right pre-signup code verifies the number', r.status === 200, r.text);

    outbox.length = 0;
    r = await call('POST', '/auth/register', {
      name: 'Pre Verified',
      email: 'pre@acme.io',
      password: 'supersecret1',
      mobile: '+919000000777',
      acceptTerms: true,
    });
    check('signup with a pre-verified number succeeds', r.status === 201, r.text);
    check('and no second code is texted', outbox.length === 0, JSON.stringify(outbox));
    check('the channel is reported as sms', r.json?.verification_channel === 'sms', r.text);
    check('the account is already phone-verified', r.json?.data?.phone_verified === true, r.text);
    check('a token comes back', typeof r.json?.access_token === 'string', r.text);
    check(
      'the password hash is never returned',
      !JSON.stringify(r.json).includes('password'),
      r.text,
    );

    // One proof, one account: otherwise a single number could be verified once
    // and spent repeatedly, each signup collecting the free credits.
    check(
      'the proof is consumed by the signup',
      (await phoneVerificationsCollection().findOne({ phone: '+919000000777' })) === null,
    );

    // The signup bonus actually landed, as an exact amount.
    const preUser = await usersCollection().findOne({ email: 'pre@acme.io' });
    const balance = await credits.balanceOf(preUser!['_id'] as any);
    check('the signup bonus is granted', balance.equals(toDecimal('100')), balance.toString());

    // --- Duplicates ---------------------------------------------------------
    r = await call('POST', '/auth/register', {
      name: 'Same Number',
      email: 'other@acme.io',
      password: 'supersecret1',
      mobile: '+919000000777',
      acceptTerms: true,
    });
    check('the same number cannot make a second account', r.status === 409, r.text);

    r = await call('POST', '/auth/register', {
      name: 'Same Email',
      email: 'pre@acme.io',
      password: 'supersecret1',
      mobile: '+919000000778',
      acceptTerms: true,
    });
    check('the same email cannot make a second account', r.status === 409, r.text);

    // --- An already-verified number is told, not stonewalled ----------------
    outbox.length = 0;
    r = await call('POST', '/auth/verify-phone/resend', { mobile: '+919000000777' });
    check('an already-verified number is not texted again', outbox.length === 0);
    check('and the caller is told it is already registered', r.status === 409, r.text);
    check(
      'with a message that says what to do instead',
      String(r.json?.detail ?? '').toLowerCase().includes('log in'),
      r.text,
    );

    // --- A non-SMS country never costs a message ----------------------------
    outbox.length = 0;
    r = await call('POST', '/auth/verify-phone/resend', { mobile: '+14155550123' });
    check('a non-SMS country is never texted', outbox.length === 0, JSON.stringify(outbox));
    check('and is answered without disclosing that', r.status === 200, r.text);

    r = await call('POST', '/auth/register', {
      name: 'Foreign User',
      email: 'us@acme.io',
      password: 'supersecret1',
      mobile: '+14155550199',
      acceptTerms: true,
    });
    check('a foreign signup verifies by email', r.json?.verification_channel === 'email', r.text);
    check('and no SMS is sent', outbox.length === 0, JSON.stringify(outbox));

    // --- Login --------------------------------------------------------------
    r = await call('POST', '/auth/login', { email: 'pre@acme.io', password: 'supersecret1' });
    check('login succeeds with the right password', r.status === 200, r.text);
    check('and returns a token', typeof r.json?.access_token === 'string', r.text);

    r = await call('POST', '/auth/login', { email: 'pre@acme.io', password: 'wrongpassword' });
    check('login fails with the wrong password', r.status === 401, r.text);

    r = await call('POST', '/auth/login', { email: 'nobody@acme.io', password: 'supersecret1' });
    check('an unknown email fails identically', r.status === 401, r.text);

    // --- Phone normalisation ------------------------------------------------
    r = await call('POST', '/auth/register', {
      name: 'Spaced Number',
      email: 'spaced@acme.io',
      password: 'supersecret1',
      mobile: '+91 90000-00999',
      acceptTerms: true,
    });
    check('a formatted number is accepted', r.status === 201, r.text);
    check('and stored in E.164', r.json?.data?.phone === '+919000000999', r.text);

    // --- Rate limiting ------------------------------------------------------
    // 3 sends per number per hour. Two have already been spent on this number
    // above (one send, one 409 which also counts), so drive it to the cap.
    let limited = false;
    for (let i = 0; i < 6; i += 1) {
      const rr = await call('POST', '/auth/verify-phone/resend', { mobile: '+919000000555' });
      if (rr.status === 429) {
        limited = true;
        break;
      }
    }
    check('sending an SMS is rate-limited per number', limited);

    // --- Money --------------------------------------------------------------
    // The reason this port is risky: float64 gets 0.1+0.2 wrong.
    const sum = toDecimal('0.1').plus(toDecimal('0.2'));
    check('decimal arithmetic is exact', sum.equals(toDecimal('0.3')), sum.toString());
    check('and a float would not have been', 0.1 + 0.2 !== 0.3);
  } finally {
    server.close();
    await usersCollection().deleteMany({});
    await phoneVerificationsCollection().deleteMany({});
    await disconnect();
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

await main();
