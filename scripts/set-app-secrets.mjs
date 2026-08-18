/**
 * Set an App Platform app's secret environment variables, interactively.
 *
 *   node scripts/set-app-secrets.mjs <app-id>
 *
 * Exists because the App Platform UI puts environment variables in two places —
 * app level and component level — and a component-level variable silently
 * overrides an app-level one of the same name. Setting the right value in the
 * wrong place looks like it worked and changes nothing, which is exactly the
 * failure this script avoids: it edits the component's own list, which is what
 * the running container actually reads.
 *
 * Values are read with the terminal echo turned off and passed to `doctl`
 * through a temporary spec file that is deleted immediately afterwards, so no
 * secret reaches your shell history, the process list, or this repository.
 *
 * Press Enter on any prompt to leave that variable unchanged.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline';

const appId = process.argv[2];
if (!appId) {
  console.error('usage: node scripts/set-app-secrets.mjs <app-id>');
  console.error('  find it with: doctl apps list');
  process.exit(2);
}

/** Read one line without echoing it to the terminal. */
function askHidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const onData = (char) => {
      // Re-print the prompt with nothing after it, so the value never appears.
      if ([`\n`, `\r`, ``].includes(char.toString())) {
        process.stdin.removeListener('data', onData);
      } else {
        readline.clearLine(process.stdout, 0);
        readline.cursorTo(process.stdout, 0);
        process.stdout.write(question);
      }
    };
    process.stdin.on('data', onData);
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer.trim());
    });
  });
}

function doctl(args) {
  return execFileSync('doctl', args, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
}

// --- Read the app's current spec ---------------------------------------------

let specText;
try {
  specText = doctl(['apps', 'spec', 'get', appId]);
} catch (err) {
  console.error(`could not read the spec for ${appId}: ${err.message}`);
  process.exit(1);
}

// A deliberately small YAML edit rather than a parse-and-regenerate: rewriting
// the whole document risks dropping a field doctl round-trips but this script
// does not model. Only the `value:` line under a named key is replaced.
function setSecret(text, key, value) {
  const lines = text.split('\n');
  let inKey = false;
  let changed = false;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\s*-?\s*key:\s*/.test(line)) {
      inKey = line.replace(/^\s*-?\s*key:\s*/, '').trim() === key;
      continue;
    }
    if (inKey && /^\s*value:\s*/.test(line)) {
      const indent = line.match(/^\s*/)[0];
      // Single-quoted, with internal quotes doubled: a password containing a
      // colon or a '#' would otherwise change the meaning of the YAML.
      lines[i] = `${indent}value: '${value.replace(/'/g, "''")}'`;
      changed = true;
      inKey = false;
    }
  }
  return { text: lines.join('\n'), changed };
}

// The secrets this service needs. Ordered with the two that break silently
// first, because those are the ones worth pasting carefully.
const SECRETS = [
  ['MONGODB_URI', 'the SAME cluster as the Python service'],
  ['JWT_SECRET', 'must be BYTE-IDENTICAL to the Python service'],
  ['BILLING_WEBHOOK_SECRET', ''],
  ['STATUS_WEBHOOK_SECRET', ''],
  ['OPS_SECRET', ''],
  ['SMTP_PASSWORD', ''],
  ['RAZORPAY_KEY_SECRET', ''],
  ['RAZORPAY_WEBHOOK_SECRET', 'a DIFFERENT value from the key secret'],
];

console.log(`\nSetting component secrets on ${appId}`);
console.log('Press Enter to leave a value unchanged.\n');

let updated = specText;
const applied = [];

for (const [key, note] of SECRETS) {
  const label = note ? `${key}  (${note})` : key;
  const value = await askHidden(`  ${label}\n    > `);
  if (!value) continue;

  const result = setSecret(updated, key, value);
  if (!result.changed) {
    console.log(`    ! ${key} is not in this app's spec — skipped`);
    continue;
  }
  updated = result.text;
  applied.push(key);
}

if (applied.length === 0) {
  console.log('\nNothing to change.');
  process.exit(0);
}

// --- Apply -------------------------------------------------------------------

const dir = mkdtempSync(path.join(tmpdir(), 'cb-spec-'));
const file = path.join(dir, 'spec.yaml');

try {
  writeFileSync(file, updated, { encoding: 'utf8', mode: 0o600 });
  console.log(`\nUpdating ${applied.length} secret(s): ${applied.join(', ')}`);
  doctl(['apps', 'update', appId, '--spec', file, '--wait']);
  console.log('Updated. App Platform redeploys automatically.');
} catch (err) {
  console.error(`update failed: ${err.message}`);
  process.exitCode = 1;
} finally {
  // The spec held the plaintext values; remove it whether or not the update
  // succeeded.
  rmSync(dir, { recursive: true, force: true });
}
