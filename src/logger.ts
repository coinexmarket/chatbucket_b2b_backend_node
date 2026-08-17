/**
 * Logging, configured from `LOG_LEVEL`.
 *
 * Deliberately explicit rather than left to a library default. In the Python
 * service the root logger sat at WARNING, so every `logger.info` was discarded
 * in production and the documented "grep for the SMS line to see whether a code
 * was sent" advice was simply false. Anything worth logging at info must
 * actually reach the log, or the operator ends up debugging blind.
 */
const LEVELS = { DEBUG: 10, INFO: 20, WARNING: 30, ERROR: 40 } as const;
type LevelName = keyof typeof LEVELS;

function currentLevel(): number {
  // Read directly rather than via getSettings(): the logger is used inside
  // config validation failures, and importing config here would be circular.
  const raw = (process.env['LOG_LEVEL'] ?? 'INFO').toUpperCase();
  return LEVELS[raw as LevelName] ?? LEVELS.INFO;
}

function emit(level: LevelName, args: unknown[]): void {
  if (LEVELS[level] < currentLevel()) return;
  const stamp = new Date().toISOString();
  const sink = LEVELS[level] >= LEVELS.WARNING ? console.error : console.log;
  const [first, ...rest] = args;
  sink(`${stamp} ${level} ${String(first)}`, ...rest);
}

export const logger = {
  debug: (...args: unknown[]) => emit('DEBUG', args),
  info: (...args: unknown[]) => emit('INFO', args),
  warn: (...args: unknown[]) => emit('WARNING', args),
  error: (...args: unknown[]) => emit('ERROR', args),
};

/**
 * Strip anything from caller-supplied text that could forge a log line.
 *
 * A newline in a value lets an attacker write what looks like a separate,
 * legitimate entry into the log an operator later reads.
 */
export function logSafe(value: unknown, max = 120): string {
  return String(value).replace(/[\r\n\t]+/g, ' ').slice(0, max);
}
