/**
 * Copy the non-TypeScript assets into `dist`.
 *
 * `tsc` emits only what it compiles, so the 13 designed email templates —
 * plain `.html` files read at runtime — never reach the build output on their
 * own. A shipped image without them still starts, still serves every endpoint
 * and still sends mail: `email.ts` catches the missing-template error and falls
 * back to the plain-text part. Every customer email would quietly lose its
 * design and nothing would fail.
 *
 * That is precisely the kind of failure worth a build step rather than a note
 * in a README, so `npm run build` runs this and `verify` below fails the build
 * if the count does not match.
 */
import { cp, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const ASSETS = [{ from: 'src/templates', to: 'dist/templates' }];

for (const { from, to } of ASSETS) {
  await mkdir(path.dirname(to), { recursive: true });
  await cp(from, to, { recursive: true });
}

// Verify rather than assume: a silent no-op here is the bug this file exists
// to prevent.
const source = await readdir('src/templates/emails');
const copied = await readdir('dist/templates/emails');
const expected = source.filter((f) => f.endsWith('.html')).length;
const actual = copied.filter((f) => f.endsWith('.html')).length;

if (actual !== expected || actual === 0) {
  console.error(`copy-assets: expected ${expected} templates in dist, found ${actual}`);
  process.exit(1);
}
console.log(`copy-assets: ${actual} email templates copied into dist`);
