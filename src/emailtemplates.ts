/**
 * HTML email templates — loading, rendering, and the values every one shares.
 *
 * Ported from `app/emailtemplates.py`. The designed emails live as `.html` files
 * under `src/templates/emails`, byte-identical to the Python service's copies:
 * they are what the designer handed over, edited only to turn the sample data
 * into `{{placeholders}}`. Keeping them as files rather than strings in code
 * means a designer can re-export one without touching TypeScript.
 *
 * Rendering is a deliberately small subset of Mustache, implemented here rather
 * than pulled in as a dependency:
 *
 *   {{key}}            — the value, HTML-escaped;
 *   {{&key}}           — the value, inserted raw (only for markup we build);
 *   {{#key}}…{{/key}}  — a list repeats the block once per item, a truthy scalar
 *                        renders it once, a falsy one skips it;
 *   {{^key}}…{{/key}}  — the inverse, for "nothing to show here" copy;
 *   {{.}}              — the current item, inside a list of plain strings.
 *
 * Escaping is on by default because these templates interpolate
 * customer-supplied text — a display name, a company, an announcement body. A
 * name containing `<script>` must render as characters, not markup.
 *
 * **A missing value throws.** Every caller builds its own context, so an absent
 * key is a bug in that caller, and blanking it silently would ship an email with
 * a hole in it — or worse, a reset button with an empty `href`. `email.ts`
 * catches the error and falls back to the plain-text part, so a template bug
 * degrades the message rather than losing it.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { getSettings } from './config.js';
import { logger } from './logger.js';

const TEMPLATE_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'templates',
  'emails',
);

const TOKEN = /\{\{\s*([#/^&]?)\s*([A-Za-z0-9_.]+)\s*\}\}/g;

export class TemplateError extends Error {}
export class MissingValueError extends Error {}

export type Context = Record<string, unknown>;

// --- Parsing ----------------------------------------------------------------
// A template is parsed once into a tree of nodes and cached. Rendering then
// walks the tree, so the regex runs once per file rather than once per email.

type Node =
  | { kind: 'text'; text: string }
  | { kind: 'var'; key: string; raw: boolean }
  | { kind: 'section'; key: string; children: Node[]; inverted: boolean };

function parse(text: string): Node[] {
  const root: Node[] = [];
  const stack: Node[][] = [root];
  const openKeys: string[] = [];
  let pos = 0;

  TOKEN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TOKEN.exec(text)) !== null) {
    const literal = text.slice(pos, match.index);
    if (literal) stack[stack.length - 1]!.push({ kind: 'text', text: literal });
    pos = match.index + match[0].length;

    const sigil = match[1] ?? '';
    const key = match[2] as string;

    if (sigil === '#' || sigil === '^') {
      const children: Node[] = [];
      stack[stack.length - 1]!.push({
        kind: 'section',
        key,
        children,
        inverted: sigil === '^',
      });
      stack.push(children);
      openKeys.push(key);
    } else if (sigil === '/') {
      if (openKeys.length === 0 || openKeys[openKeys.length - 1] !== key) {
        const closes =
          openKeys.length > 0 ? `{{#${openKeys[openKeys.length - 1]}}}` : 'nothing';
        throw new TemplateError(`{{/${key}}} closes ${closes}`);
      }
      openKeys.pop();
      stack.pop();
    } else {
      stack[stack.length - 1]!.push({ kind: 'var', key, raw: sigil === '&' });
    }
  }

  if (openKeys.length > 0) {
    throw new TemplateError(`unclosed section {{#${openKeys[openKeys.length - 1]}}}`);
  }
  if (pos < text.length) root.push({ kind: 'text', text: text.slice(pos) });
  return root;
}

const treeCache = new Map<string, Node[]>();

/** Parse a template file. Cached: templates never change at runtime. */
function tree(name: string): Node[] {
  const cached = treeCache.get(name);
  if (cached) return cached;

  const file = path.join(TEMPLATE_DIR, `${name}.html`);
  let source: string;
  try {
    source = readFileSync(file, 'utf8');
  } catch {
    throw new Error(`No email template named '${name}' in ${TEMPLATE_DIR}`);
  }
  const parsed = parse(source);
  treeCache.set(name, parsed);
  return parsed;
}

// --- Rendering --------------------------------------------------------------

const MISSING = Symbol('missing');

/** Resolve a key against the context stack, innermost frame first. */
function lookup(key: string, stack: Context[]): unknown {
  if (key === '.') {
    const top = stack[stack.length - 1];
    return top && '.' in top ? top['.'] : MISSING;
  }
  for (let i = stack.length - 1; i >= 0; i -= 1) {
    const frame = stack[i];
    if (frame && Object.prototype.hasOwnProperty.call(frame, key)) return frame[key];
  }
  return MISSING;
}

function stringify(value: unknown): string {
  // A bare boolean or null in a text slot is almost always a context bug, and
  // "true" is never what the design meant to show.
  if (value === null || value === undefined || typeof value === 'boolean') return '';
  return String(value);
}

/** HTML-escape, including quotes — values land inside attributes too. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

function renderNodes(nodes: Node[], stack: Context[], out: string[], where: string): void {
  for (const node of nodes) {
    if (node.kind === 'text') {
      out.push(node.text);
      continue;
    }

    if (node.kind === 'var') {
      const value = lookup(node.key, stack);
      if (value === MISSING) {
        throw new MissingValueError(`${where}: no value for {{${node.key}}}`);
      }
      const text = stringify(value);
      out.push(node.raw ? text : escapeHtml(text));
      continue;
    }

    const value = lookup(node.key, stack);
    if (value === MISSING) {
      throw new MissingValueError(`${where}: no value for section {{#${node.key}}}`);
    }

    if (node.inverted) {
      if (!value || (Array.isArray(value) && value.length === 0)) {
        renderNodes(node.children, stack, out, where);
      }
      continue;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        const frame: Context =
          item !== null && typeof item === 'object' ? { ...(item as Context) } : {};
        // `{{.}}` inside a list of plain strings.
        frame['.'] = item;
        stack.push(frame);
        renderNodes(node.children, stack, out, where);
        stack.pop();
      }
    } else if (value !== null && typeof value === 'object') {
      stack.push(value as Context);
      renderNodes(node.children, stack, out, where);
      stack.pop();
    } else if (value) {
      renderNodes(node.children, stack, out, where);
    }
  }
}

/** Render `templates/emails/<name>.html` with `context` over the defaults. */
export function render(name: string, context: Context): string {
  const merged = { ...baseContext(), ...context };
  const out: string[] = [];
  renderNodes(tree(name), [merged], out, name);
  return out.join('');
}

// --- Shared values ----------------------------------------------------------

/**
 * Symbols for the currencies this service can be configured with. The code is
 * shown for anything else — better a correct "USD 40.00" than a wrong glyph.
 */
const CURRENCY_SYMBOLS: Record<string, string> = {
  INR: '₹',
  USD: '$',
  EUR: '€',
  GBP: '£',
};
const CURRENCY_NAMES: Record<string, string> = {
  INR: 'Indian rupees',
  USD: 'US dollars',
  EUR: 'Euros',
  GBP: 'Pounds sterling',
};

export function currencySymbol(): string {
  const code = getSettings().CURRENCY.toUpperCase();
  // The code, with a space, for anything unlisted: better a correct
  // "USD 40.00" than a confidently wrong glyph.
  return CURRENCY_SYMBOLS[code] ?? `${code} `;
}

export function currencyName(): string {
  const code = getSettings().CURRENCY.toUpperCase();
  return CURRENCY_NAMES[code] ?? code;
}

// --- Display formatting -----------------------------------------------------
// Everything is stored in UTC; a receipt has to read in the customer's clock.

function zone(): string {
  return getSettings().DISPLAY_TIMEZONE;
}

/** Parts of `moment` in the configured display zone. */
function localParts(moment: Date): Record<string, string> {
  let tz = zone();
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      day: '2-digit',
      month: 'long',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
      timeZoneName: 'short',
    }).formatToParts(moment);
  } catch {
    // A typo in DISPLAY_TIMEZONE must not stop a receipt going out; UTC is
    // wrong by hours, a crash is wrong entirely.
    logger.error('unknown DISPLAY_TIMEZONE %s; showing UTC', tz);
    tz = 'UTC';
    parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      day: '2-digit',
      month: 'long',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
      timeZoneName: 'short',
    }).formatToParts(moment);
  }
  return Object.fromEntries(parts.map((p) => [p.type, p.value]));
}

/** Now, in the configured display zone, as `{year, month, day, hour}` numbers.
 *
 * The scheduler decides what is due from this rather than from UTC: "send the
 * monthly report on the 1st at 6am" means the customer's 1st and the customer's
 * 6am, and in IST those are five and a half hours from the server's.
 */
export function localNow(now = new Date()): {
  year: number;
  month: number;
  day: number;
  hour: number;
} {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: zone(),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hour12: false,
  });
  const p = Object.fromEntries(fmt.formatToParts(now).map((x) => [x.type, x.value]));
  return {
    year: Number(p['year']),
    month: Number(p['month']),
    day: Number(p['day']),
    // 24-hour formatting renders midnight as "24" in some locales.
    hour: Number(p['hour']) % 24,
  };
}

/** `31 July 2026` — no leading-zero-stripping games, matching the Python form. */
export function fmtDate(moment: Date): string {
  const p = localParts(moment);
  return `${p['day']} ${p['month']} ${p['year']}`;
}

/** `06 AUG 2026`, the compact form the maintenance card uses. */
export function fmtShortDate(moment: Date): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: zone(),
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    })
      .formatToParts(moment)
      .map((x) => [x.type, x.value]),
  );
  return `${p['day']} ${String(p['month']).toUpperCase()} ${p['year']}`;
}

/** `6:59 PM IST` in the configured display zone. */
export function fmtTime(moment: Date): string {
  const p = localParts(moment);
  return `${p['hour']}:${p['minute']} ${String(p['dayPeriod']).toUpperCase()} ${p['timeZoneName']}`;
}

/** `Jul 2026` — the label on the month-over-month comparison. */
export function fmtMonth(moment: Date): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', { timeZone: zone(), month: 'short', year: 'numeric' })
      .formatToParts(moment)
      .map((x) => [x.type, x.value]),
  );
  return `${p['month']} ${p['year']}`;
}

/**
 * The header, footer and branding values every template asks for.
 *
 * Built per render rather than cached, so `{{year}}` is still right after a
 * process has been running across New Year.
 */
export function baseContext(): Context {
  const s = getSettings();
  const site = s.FRONTEND_URL.replace(/\/$/, '');
  return {
    year: new Date().getUTCFullYear(),
    support_email: s.SUPPORT_EMAIL,
    visit_url: s.MARKETING_URL,
    track_url: `${site}${s.TRACK_QUERY_PATH}`,
    dashboard_url: `${site}${s.DASHBOARD_PATH}`,
    login_url: `${site}${s.LOGIN_PATH}`,
    privacy_policy_url: `${s.MARKETING_URL.replace(/\/$/, '')}${s.PRIVACY_POLICY_PATH}`,
    terms_url: `${s.MARKETING_URL.replace(/\/$/, '')}${s.TERMS_PATH}`,
    currency_symbol: currencySymbol(),
    currency_name: currencyName(),
  };
}
