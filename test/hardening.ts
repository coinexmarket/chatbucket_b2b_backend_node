export {}; // Marks this file a module, so top-level `await` below is allowed.

/**
 * The settings whose *default* is the safety property.
 *
 * Each of these was a gap found by diffing the Node config against the Python
 * one, and two of them had security consequences that no functional test would
 * have shown — the service worked perfectly either way.
 *
 * They are tested here rather than in the end-to-end suite because what matters
 * is the behaviour when nobody has configured anything, which is exactly the
 * state a fresh deployment is in.
 */
process.env['ENVIRONMENT'] = 'development';
process.env['JWT_SECRET'] = 'hardening-test-secret';
process.env['MONGODB_DB'] = 'chatbucket_b2b_nodetest';
process.env['EMAIL_BACKEND'] = 'memory';
process.env['SMS_BACKEND'] = 'memory';

const { getSettings, resetSettings } = await import('../src/config.js');

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

/** Read a setting with the environment temporarily overridden. */
function withEnv<T>(overrides: Record<string, string | undefined>, read: () => T): T {
  const previous: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(overrides)) {
    previous[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetSettings();
  try {
    return read();
  } finally {
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    resetSettings();
  }
}

console.log('\nSafety defaults\n');

// --- Proxy trust -------------------------------------------------------------
//
// The one with teeth. `X-Forwarded-For` is trivially forged, so believing it
// with nothing in front lets any caller invent an address per request and walk
// past every per-IP limit — including the OTP send cap, which costs real money.

check(
  'X-Forwarded-For is NOT trusted by default',
  withEnv({ TRUST_PROXY_HEADERS: undefined }, () => getSettings().TRUST_PROXY_HEADERS) === false,
);
check(
  'and is trusted only when explicitly enabled',
  withEnv({ TRUST_PROXY_HEADERS: 'true' }, () => getSettings().TRUST_PROXY_HEADERS) === true,
);

// The app must actually apply it, not just read it.
const appModule = await import('../src/app.js');
const untrusting = withEnv({ TRUST_PROXY_HEADERS: undefined }, () => appModule.createApp());
check(
  "Express's trust proxy is off when the setting is",
  untrusting.get('trust proxy') === false,
  String(untrusting.get('trust proxy')),
);
const trusting = withEnv({ TRUST_PROXY_HEADERS: 'true' }, () => appModule.createApp());
check(
  'and on when it is',
  trusting.get('trust proxy') === true,
  String(trusting.get('trust proxy')),
);

// --- Rate limiting -----------------------------------------------------------

check(
  'rate limiting is ON by default',
  withEnv({ RATE_LIMIT_ENABLED: undefined }, () => getSettings().RATE_LIMIT_ENABLED) === true,
);
check(
  'and can be switched off deliberately',
  withEnv({ RATE_LIMIT_ENABLED: 'false' }, () => getSettings().RATE_LIMIT_ENABLED) === false,
);

// --- The other defaults that carry a decision --------------------------------

check(
  'the notification scheduler is OFF by default — booting must not start mailing',
  withEnv({ NOTIFICATION_SCHEDULER_ENABLED: undefined }, () =>
    getSettings().NOTIFICATION_SCHEDULER_ENABLED,
  ) === false,
);
check(
  'SMS_TEMPLATE_SUFFIX is EMPTY by default — a word the DLT registration lacks kills delivery silently',
  withEnv({ SMS_TEMPLATE_SUFFIX: undefined }, () => getSettings().SMS_TEMPLATE_SUFFIX) === '',
);
check(
  'engine quotas ship unset, so "remaining" reads null rather than inventing an allowance',
  Object.keys(withEnv({ ENGINE_FREE_QUOTAS: undefined }, () => getSettings().engineQuotaMap))
    .length === 0,
);
check(
  'no status probes are configured by default, so no prober runs',
  Object.keys(withEnv({ STATUS_PROBE_URLS: undefined }, () => getSettings().statusProbeMap))
    .length === 0,
);

// --- Parsing the pair-shaped settings ----------------------------------------

const probes = withEnv(
  { STATUS_PROBE_URLS: 'tts=https://tts.example.com/health,stt=https://stt.example.com/health' },
  () => getSettings().statusProbeMap,
);
check('probe pairs parse', Object.keys(probes).length === 2, JSON.stringify(probes));
check(
  'and the URL keeps its own "=" and colons — split on the FIRST separator only',
  withEnv({ STATUS_PROBE_URLS: 'tts=https://x.example.com/health?k=v' }, () =>
    getSettings().statusProbeMap,
  )['tts'] === 'https://x.example.com/health?k=v',
  JSON.stringify(
    withEnv({ STATUS_PROBE_URLS: 'tts=https://x.example.com/health?k=v' }, () =>
      getSettings().statusProbeMap,
    ),
  ),
);

const quotas = withEnv({ ENGINE_FREE_QUOTAS: 'cb_vinu=1000,CB_Paluku=250.5' }, () =>
  getSettings().engineQuotaMap,
);
check('quota pairs parse and are case-folded', quotas['cb_paluku'] === 250.5, JSON.stringify(quotas));

// --- Currency ----------------------------------------------------------------

const templates = await import('../src/emailtemplates.js');
check(
  'currency defaults to the rupee',
  withEnv({ CURRENCY: undefined }, () => templates.currencySymbol()) === '₹',
);
check(
  'and follows the setting',
  withEnv({ CURRENCY: 'USD' }, () => templates.currencySymbol()) === '$',
  withEnv({ CURRENCY: 'USD' }, () => templates.currencySymbol()),
);
check(
  'an unlisted currency shows its code rather than a wrong glyph',
  withEnv({ CURRENCY: 'AED' }, () => templates.currencySymbol()) === 'AED ',
  withEnv({ CURRENCY: 'AED' }, () => templates.currencySymbol()),
);

// --- The prober's three-way verdict ------------------------------------------
//
// A 5xx means the service answered but is broken (down); a 4xx means it
// answered and refused (degraded — the process is alive, so paging for "down"
// would be wrong); no answer at all is down.

const prober = await import('../src/services/prober.js');
const status = await import('../src/services/status.js');

const server = (await import('node:http')).createServer((req, res) => {
  const code = Number(req.url?.slice(1) ?? 200);
  res.writeHead(code).end('x');
});
await new Promise<void>((resolve) => server.listen(0, resolve));
const port = (server.address() as { port: number }).port;

check('a 200 reads operational', (await prober.probe(`http://127.0.0.1:${port}/200`)) === status.OPERATIONAL);
check('a 404 reads degraded, not down — it answered', (await prober.probe(`http://127.0.0.1:${port}/404`)) === status.DEGRADED);
check('a 503 reads down', (await prober.probe(`http://127.0.0.1:${port}/503`)) === status.DOWN);
server.close();
check('an unreachable host reads down', (await prober.probe('http://127.0.0.1:1/health')) === status.DOWN);

// --- The user serialization deny-list ----------------------------------------
//
// publicUser matches the Python contract by stripping named fields rather than
// allowing named ones, so the frontend keeps getting `_id` and the rest. The
// risk that trades away is a new secret field being exposed by default — bought
// back here, by asserting that a user document carrying every secret we know of
// leaks none of them.

const { publicUser } = await import('../src/serialization.js');

const SECRETS = [
  'password_hash',
  'reset_token_hash',
  'reset_token_expires',
  'verification_token_hash',
  'verification_token_expires',
  'verification_code_hash',
  'verification_code_expires',
  'phone_code_hash',
  'phone_code_expires',
  '_api_key_id',
  '_api_key_project_id',
];

const loaded = publicUser({
  _id: 'abc',
  email: 'a@example.com',
  name: 'Ada',
  how_did_you_hear: 'Google Search',
  ...Object.fromEntries(SECRETS.map((k) => [k, 'SHOULD-NOT-LEAK'])),
});

for (const field of SECRETS) {
  check(`publicUser strips ${field}`, !(field in loaded), JSON.stringify(Object.keys(loaded)));
}
check(
  'and no secret VALUE survives anywhere in the output',
  !JSON.stringify(loaded).includes('SHOULD-NOT-LEAK'),
  JSON.stringify(loaded),
);
// The contract half: the fields the frontend reads are still there.
check('while keeping _id, which the frontend reads', loaded['_id'] === 'abc');
check('and the non-secret profile fields', loaded['how_did_you_hear'] === 'Google Search');

// --- Email validation agrees with pydantic -----------------------------------
//
// zod's `.email()` and pydantic's `EmailStr` disagree on exactly one thing:
// the RFC 6761 reserved TLDs, which can never receive mail. Found by diffing
// the live services, where the same login attempt returned 401 from Node and
// 422 from Python. Left alone, this service would accept a registration the
// other half of the system considers invalid.

const { RegisterRequest } = await import('../src/schemas/auth.js');

const EMAILS: Array<[string, boolean]> = [
  ['nobody@example.invalid', false],
  ['someone@thing.test', false],
  ['user@localhost', false],
  ['a@b', false],
  ['no-tld@example', false],
  ['ok@example.com', true],
  ['x@sub.example.co.uk', true],
];

for (const [address, shouldPass] of EMAILS) {
  const result = RegisterRequest.safeParse({
    name: 'Ada',
    email: address,
    password: 'supersecret1',
    mobile: '+919000000123',
    acceptTerms: true,
  });
  check(
    `${shouldPass ? 'accepts' : 'rejects'} ${address}`,
    result.success === shouldPass,
    `got ${result.success ? 'accepted' : 'rejected'}`,
  );
}

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
