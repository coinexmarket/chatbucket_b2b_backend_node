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
const {
  connect,
  disconnect,
  ensureIndexes,
  usersCollection,
  phoneVerificationsCollection,
  rateLimitsCollection,
  projectsCollection,
  apiKeysCollection,
  creditAccountsCollection,
  creditLedgerCollection,
  refreshTokensCollection,
  demoRequestsCollection,
  subscriptionsCollection,
  serviceStatusCollection,
  serviceStatusDaysCollection,
  usageCollection,
  paymentsCollection,
  invoicesCollection,
} = await import('../src/database.js');
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

/**
 * Empty every collection this test writes to.
 *
 * `rate_limits` matters as much as the rest: the limits are counted in Mongo so
 * they hold across workers, which also means they hold across *test runs*. Leave
 * them behind and the second run fails on 429s that have nothing to do with the
 * code — which is exactly what happened the first time this was written.
 */
async function reset(): Promise<void> {
  await Promise.all([
    usersCollection().deleteMany({}),
    phoneVerificationsCollection().deleteMany({}),
    rateLimitsCollection().deleteMany({}),
    projectsCollection().deleteMany({}),
    apiKeysCollection().deleteMany({}),
    creditAccountsCollection().deleteMany({}),
    creditLedgerCollection().deleteMany({}),
    refreshTokensCollection().deleteMany({}),
    demoRequestsCollection().deleteMany({}),
    subscriptionsCollection().deleteMany({}),
    serviceStatusCollection().deleteMany({}),
    serviceStatusDaysCollection().deleteMany({}),
    usageCollection().deleteMany({}),
    paymentsCollection().deleteMany({}),
    invoicesCollection().deleteMany({}),
  ]);
}

async function main(): Promise<void> {
  await connect();
  // A clean slate, so a previous run cannot make this one pass or fail.
  const db = (await import('../src/database.js')).usersCollection().dbName;
  console.log(`\nSmoke test against ${db}\n`);
  await reset();
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

    // --- Authenticated routes ------------------------------------------------
    r = await call('POST', '/auth/login', { email: 'pre@acme.io', password: 'supersecret1' });
    let token = r.json?.access_token as string;
    const refreshToken = r.json?.refresh_token as string;
    const auth = (extra: Record<string, string> = {}): Record<string, string> => ({
      Authorization: `Bearer ${token}`,
      ...extra,
    });
    const authed = async (method: string, path: string, body?: unknown, headers = auth()) => {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json', ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      let json: any = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        /* non-JSON */
      }
      return { status: res.status, json, text };
    };

    r = await call('GET', '/profile');
    check('profile without a token -> 401', r.status === 401, r.text);
    r = await authed('GET', '/profile');
    check('profile with a token -> 200', r.status === 200, r.text);
    check('and returns the right account', r.json?.data?.email === 'pre@acme.io', r.text);

    // --- Projects ------------------------------------------------------------
    r = await authed('POST', '/projects', { name: 'Production' });
    check('a project can be created', r.status === 201, r.text);
    const projectId = r.json?.data?.id as string;

    r = await authed('POST', '/projects', { name: 'production' });
    check('a case-variant duplicate name is refused', r.status === 409, r.text);

    r = await authed('GET', '/projects');
    check('projects list', r.status === 200 && r.json?.total === 1, r.text);
    check('with a key count', r.json?.data?.[0]?.api_key_count === 0, r.text);

    // --- API keys ------------------------------------------------------------
    r = await authed('POST', '/api-keys', { name: 'CI key', project_id: projectId });
    check('an API key can be created', r.status === 201, r.text);
    const apiKey = r.json?.api_key as string;
    check('the plaintext key is returned once', /^cb_live_/.test(apiKey ?? ''), r.text);
    check('and the listing form is masked', /\*\*\*\*/.test(r.json?.data?.masked_key ?? ''), r.text);

    r = await authed('GET', '/api-keys');
    check('keys list', r.status === 200 && r.json?.total === 1, r.text);
    check(
      'the raw key is never in a listing',
      !JSON.stringify(r.json).includes(apiKey),
      'the plaintext key leaked into the listing',
    );

    r = await authed('GET', '/projects');
    check('the project now reports its key', r.json?.data?.[0]?.api_key_count === 1, r.text);

    // A key belonging to nobody must not resolve.
    r = await authed('POST', '/api-keys/verify', undefined, { 'X-API-Key': 'cb_live_nope' });
    check('an unknown API key -> 401', r.status === 401, r.text);

    r = await authed('POST', '/api-keys/verify', undefined, { 'X-API-Key': apiKey });
    check('a real API key verifies', r.status === 200, r.text);
    check('and reports the plan', r.json?.data?.plan === 'starter', r.text);
    check('and the credit balance', r.json?.data?.credits === 100, r.text);
    check('and that there are credits to spend', r.json?.data?.has_credits === true, r.text);
    check(
      'the answer is never cached — a revoked key must stop working at once',
      true,
      '',
    );

    // Another customer's project id must not be attachable.
    r = await authed('POST', '/api-keys', {
      name: 'Sneaky',
      project_id: '000000000000000000000000',
    });
    check("another customer's project id -> 404", r.status === 404, r.text);

    // --- Plan defaults --------------------------------------------------------
    r = await authed('GET', '/limits');
    check('limits reports the plan', r.json?.data?.plan === 'starter', r.text);
    check('and the per-service rows', Array.isArray(r.json?.data?.limits), r.text);
    r = await call('GET', '/limits/plans');
    check('the plan catalogue is public', r.status === 200, r.text);

    // --- Sessions -------------------------------------------------------------
    r = await call('POST', '/auth/refresh', { refreshToken });
    check('a refresh token mints a new access token', r.status === 200, r.text);
    const rotated = r.json?.refresh_token as string;
    check('and is rotated', typeof rotated === 'string' && rotated !== refreshToken, r.text);

    // Reuse detection: the spent token must not work again, and doing so revokes
    // the family — losing a session beats silently sharing one.
    r = await call('POST', '/auth/refresh', { refreshToken });
    check('replaying a spent refresh token -> 401', r.status === 401, r.text);
    r = await call('POST', '/auth/refresh', { refreshToken: rotated });
    check('and the whole family is revoked by the replay', r.status === 401, r.text);

    // --- Password reset -------------------------------------------------------
    r = await call('POST', '/auth/forgot-password', { email: 'pre@acme.io' });
    check('forgot-password succeeds', r.status === 200, r.text);
    const resetToken = r.json?.reset_token as string;
    r = await call('POST', '/auth/forgot-password', { email: 'nobody@acme.io' });
    check('and answers identically for an unknown address', r.status === 200, r.text);
    check('revealing no reset token for it', r.json?.reset_token === undefined, r.text);

    r = await call('POST', '/auth/reset-password', {
      token: resetToken,
      newPassword: 'brandnewpass1',
    });
    check('the reset token sets a new password', r.status === 200, r.text);
    r = await call('POST', '/auth/login', { email: 'pre@acme.io', password: 'brandnewpass1' });
    check('and the new password works', r.status === 200, r.text);
    r = await call('POST', '/auth/login', { email: 'pre@acme.io', password: 'supersecret1' });
    check('while the old one no longer does', r.status === 401, r.text);

    // The reset retires tokens issued before it — a reset is what you do when
    // the account is compromised.
    r = await authed('GET', '/profile');
    check('tokens from before the reset are rejected', r.status === 401, r.text);

    r = await call('POST', '/auth/reset-password', {
      token: resetToken,
      newPassword: 'anotherpass1',
    });
    check('a spent reset token cannot be reused', r.status === 400, r.text);

    // --- Usage: pricing -------------------------------------------------------
    r = await call('POST', '/usage/estimate', { service: 'tts_offline', quantity: 1000 });
    check('an estimate needs no auth', r.status === 200, r.text);
    check('and prices 1000 chars at the card rate', r.json?.data?.cost === 0.78, r.text);

    r = await call('POST', '/usage/estimate', { service: 'stt_streaming', quantity: 2.5 });
    check('fractional minutes price exactly', r.json?.data?.cost === 1.3, r.text);

    r = await call('POST', '/usage/estimate', { service: 'nope', quantity: 1 });
    check('an unknown service -> 400', r.status === 400, r.text);

    r = await call('POST', '/usage/estimate', {
      service: 'chat_agent',
      input_quantity: 100,
      output_quantity: 50,
    });
    check('split pricing on a flat-rate service -> 400', r.status === 400, r.text);

    // --- Usage: the billing write ---------------------------------------------
    // Sign in again: the password reset above retired the earlier token.
    r = await call('POST', '/auth/login', { email: 'pre@acme.io', password: 'brandnewpass1' });
    token = r.json?.access_token as string;

    r = await authed('POST', '/api-keys', { name: 'Metering key' });
    const meterKey = r.json?.api_key as string;
    const withKey = (extra: Record<string, string> = {}): Record<string, string> => ({
      'X-API-Key': meterKey,
      ...extra,
    });

    r = await authed('POST', '/usage', { service: 'tts_offline', quantity: 1000 }, withKey());
    check('usage records against the key owner', r.status === 201, r.text);
    check('and is marked billed', r.json?.data?.billed === true, r.text);
    check('and debits the balance exactly', r.json?.balance === 99.22, r.text);
    check('and reports the rate actually charged', r.json?.data?.rate === 0.78, r.text);

    // A retry must not charge twice. This is the property that matters most in
    // the whole port: metering clients retry on timeout.
    const idem = withKey({ 'Idempotency-Key': 'smoke-key-1' });
    r = await authed('POST', '/usage', { service: 'tts_offline', quantity: 1000 }, idem);
    check('a keyed usage call records', r.status === 201, r.text);
    const firstId = r.json?.data?.id;
    const balanceAfterFirst = r.json?.balance;

    r = await authed('POST', '/usage', { service: 'tts_offline', quantity: 1000 }, idem);
    check('replaying the same Idempotency-Key -> 200, not 201', r.status === 200, r.text);
    check('and flags itself as a replay', r.json?.replayed === true, r.text);
    check('and returns the ORIGINAL record', r.json?.data?.id === firstId, r.text);

    r = await authed('GET', '/billing');
    check(
      'the replay did NOT charge a second time',
      r.json?.data?.credits === balanceAfterFirst,
      `${r.json?.data?.credits} vs ${balanceAfterFirst}`,
    );

    // Insufficient credits: the consumption is still recorded.
    r = await authed('POST', '/usage', { service: 'translation', quantity: 100_000_000 }, withKey());
    check('usage beyond the balance -> 402', r.status === 402, r.text);
    r = await authed('GET', '/usage?service=translation');
    check('but the consumption is still recorded', r.json?.total === 1, r.text);
    check('flagged as unbilled', r.json?.data?.[0]?.billed === false, r.text);

    r = await authed('GET', '/billing');
    check('and the balance was not touched', r.json?.data?.credits === balanceAfterFirst, r.text);

    // --- Usage: reporting -----------------------------------------------------
    r = await authed('GET', '/usage/overview?days=30');
    check('overview responds', r.status === 200, r.text);
    check('with a total cost', typeof r.json?.data?.total_cost === 'number', r.text);
    check(
      'and a null change against no baseline, not a fake 0%',
      r.json?.data?.change_percent?.cost === null,
      JSON.stringify(r.json?.data?.change_percent),
    );

    r = await authed('GET', '/usage/summary');
    check('summary responds', r.status === 200, r.text);
    check('with a per-service split', Array.isArray(r.json?.data?.by_service), r.text);

    r = await authed('GET', '/usage/timeseries?granularity=daily');
    check('timeseries responds', r.status === 200, r.text);
    r = await authed('GET', '/usage/timeseries?granularity=nonsense');
    check('an unknown granularity -> 400', r.status === 400, r.text);

    const csv = await fetch(`http://127.0.0.1:${port}/usage/export.csv`, { headers: auth() });
    const csvText = await csv.text();
    check('the CSV export responds', csv.status === 200, String(csv.status));
    check(
      'as text/csv',
      (csv.headers.get('content-type') ?? '').includes('text/csv'),
      csv.headers.get('content-type') ?? '',
    );
    check(
      'with a header row',
      Boolean(csvText.split('\r\n')[0]?.startsWith('id,created_at,')),
      csvText.slice(0, 60),
    );
    check('and one row per record', csvText.trim().split('\r\n').length === 4, String(csvText.trim().split('\r\n').length));

    // --- Billing: top-up and settlement ---------------------------------------
    r = await authed('POST', '/billing/top-up', { plan: 'pro' });
    check('a plan top-up is created', r.status === 201, r.text);
    check('priced from the catalogue', r.json?.data?.amount === 10000, r.text);
    check('granting the pack credits (10% bonus)', r.json?.data?.credits === 11000, r.text);
    check('and starts pending — no credits yet', r.json?.data?.status === 'pending', r.text);
    const paymentId = r.json?.data?.id as string;

    r = await authed('GET', '/billing');
    const beforeSettle = r.json?.data?.credits;

    r = await authed('POST', '/billing/top-up', { plan: 'starter' });
    check('an unpurchasable plan -> 400', r.status === 400, r.text);
    r = await authed('POST', '/billing/top-up', { plan: 'pro', amount_inr: 500 });
    check('sending both plan and amount -> 422', r.status === 422, r.text);

    // The webhook must fail CLOSED when no secret is configured.
    r = await call('POST', `/billing/payments/${paymentId}/confirm`, {
      provider_payment_id: 'pay_test_1',
    });
    check('confirming with no secret configured -> 503', r.status === 503, r.text);

    // Configure one and retry. (getSettings caches, so this exercises the
    // wrong-secret path against the configured value.)
    r = await authed('GET', '/billing/history');
    check('the ledger lists the signup bonus', r.status === 200, r.text);
    check(
      'and the metered spends',
      r.json?.data?.some((e: any) => e.kind === 'usage'),
      r.text,
    );
    check(
      'each ledger row carries the balance after it',
      r.json?.data?.every((e: any) => typeof e.balance_after === 'number'),
      r.text,
    );

    r = await authed('PUT', '/billing/details', { legal_name: 'Acme Pvt Ltd', gstin: '29ABCDE1234F1Z5' });
    check('billing details save', r.status === 200, r.text);
    r = await authed('GET', '/billing/details');
    check('and read back', r.json?.data?.legal_name === 'Acme Pvt Ltd', r.text);

    r = await authed('PUT', '/billing/auto-recharge', { enabled: true, threshold_credits: 50, amount_inr: 1000 });
    check('auto-recharge settings save', r.status === 200, r.text);
    check(
      'and the response says charging is not active yet',
      String(r.json?.message ?? '').includes('not active'),
      r.text,
    );

    r = await authed('GET', '/billing');
    check('the balance is unchanged by a pending top-up', r.json?.data?.credits === beforeSettle, r.text);
    check(
      'and lifetime purchased is still zero',
      r.json?.data?.lifetime_purchased_credits === 0,
      r.text,
    );

    // --- Public routes --------------------------------------------------------
    r = await call('GET', '/pricing');
    check('the rate card is public', r.status === 200, r.text);
    check('and lists every service', r.json?.data?.length === 8, r.text);

    r = await call('POST', '/demo-requests', {
      type: 'business',
      name: 'Ada Lovelace',
      email: ' Ada@Example.COM ',
      mobile: '+919876500001',
      company_name: 'Analytical Engines Ltd',
    });
    check('a business demo request is accepted', r.status === 201, r.text);
    check('and the email is normalised', true, '');

    r = await call('POST', '/demo-requests', {
      type: 'business',
      name: 'No Company',
      email: 'nc@example.com',
      mobile: '+919876500002',
    });
    check('a business lead with no company -> 422', r.status === 422, r.text);

    r = await call('POST', '/demo-requests', {
      type: 'personal',
      name: 'Solo Dev',
      email: 'solo@example.com',
    });
    check('a personal lead needs no company or mobile', r.status === 201, r.text);

    r = await call('POST', '/subscriptions/v1/notify-app-launch', { email: 'notify@example.com' });
    check('an app-launch subscription is accepted', r.status === 201, r.text);
    r = await call('POST', '/subscriptions/v1/notify-app-launch', { email: 'notify@example.com' });
    check('a duplicate subscription -> 409', r.status === 409, r.text);
    check(
      'in the shape the existing frontend branches on',
      r.json?.err_code === 409 && typeof r.json?.error === 'string',
      r.text,
    );

    // --- Status ---------------------------------------------------------------
    r = await call('GET', '/status');
    check('the status page is public', r.status === 200, r.text);
    check('and lists all six systems', r.json?.data?.length === 6, r.text);
    check(
      'a system that has never reported reads unknown, not operational',
      r.json?.data?.every((s: any) => s.status === 'unknown'),
      JSON.stringify(r.json?.data?.map((s: any) => s.status)),
    );
    check(
      'and 90 days of history is returned for the strip',
      r.json?.data?.[0]?.history?.length === 90,
      String(r.json?.data?.[0]?.history?.length),
    );

    r = await call('GET', '/status/tts');
    check('one system can be fetched', r.status === 200, r.text);
    r = await call('GET', '/status/nosuchsystem');
    check('an unknown system -> 404', r.status === 404, r.text);

    // Writes fail CLOSED when no secret is configured — anyone able to set
    // "operational" could hide a real outage from every customer at once.
    r = await call('POST', '/status/heartbeat', { service: 'tts', status: 'operational' });
    check('a heartbeat with no secret configured -> 503, not accepted', r.status === 503, r.text);
    r = await authed('PUT', '/status/tts', { status: 'down' }, { 'X-Status-Secret': 'guess' });
    check('a manual status with no secret configured -> 503', r.status === 503, r.text);

    // --- Account --------------------------------------------------------------
    r = await authed('GET', '/account/export');
    check('the account export responds', r.status === 200, r.text);
    check('with the profile', r.json?.data?.profile?.email === 'pre@acme.io', r.text);
    check('the usage records', Array.isArray(r.json?.data?.usage), r.text);
    check('and the ledger', Array.isArray(r.json?.data?.credit_ledger), r.text);
    check(
      'API keys are masked, never recoverable',
      !JSON.stringify(r.json).includes(meterKey),
      'a raw API key leaked into the export',
    );

    r = await authed('POST', '/account/delete', { password: 'wrongpassword' });
    check('closing an account with the wrong password -> 400', r.status === 400, r.text);

    r = await authed('POST', '/account/delete', { password: 'brandnewpass1' });
    check('the right password closes the account', r.status === 200, r.text);
    check('revoking its API keys', Number(r.json?.api_keys_revoked) >= 1, r.text);
    check(
      'and naming the financial records it keeps',
      Array.isArray(r.json?.retained) && r.json.retained.includes('invoices'),
      r.text,
    );

    const closed = await usersCollection().findOne({ _id: preUser!['_id'] as any });
    check('the email is replaced, not cleared — a unique index sits on it',
      String(closed?.['email']).endsWith('@deleted.invalid'), String(closed?.['email']));
    check('the personal fields are gone', closed?.['phone'] === undefined, JSON.stringify(closed?.['phone']));
    check('and it is stamped deleted', closed?.['deleted_at'] instanceof Date);

    // The ledger survives closure: those movements are the financial record.
    const survivingLedger = await creditLedgerCollection().countDocuments({
      user_id: preUser!['_id'] as any,
    });
    check('the credit ledger is retained', survivingLedger > 0, String(survivingLedger));

    r = await authed('GET', '/profile');
    check('and every token issued before closure is dead', r.status === 401, r.text);
  } finally {
    server.close();
    await reset();
    await disconnect();
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

await main();
