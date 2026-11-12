import type { LoggerService, LogLevel } from '@nestjs/common';

/*
 * Structured logging (Phase 14 Part 3). One JSON object per line, for log collectors, with every
 * message passed through redact() first: logs must never carry tokens, passwords, cookies, email
 * addresses or the query strings that may hold them (AGENTS.md section 19).
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const RULES: [RegExp, (match: string, ...groups: string[]) => string][] = [
  // Authorization and cookie values.
  [/(bearer\s+)[A-Za-z0-9._~+/=-]+/gi, (_m, key) => `${key}[redacted]`],
  [/((?:set-)?cookie["']?\s*[:=]\s*)[^\s,;}]+/gi, (_m, key) => `${key}[redacted]`],
  // Named secrets in key=value or "key": "value" form.
  [
    /((?:password|passwd|secret|token|api[_-]?key|recovery[_-]?code|code)["']?\s*[:=]\s*["']?)[^\s"',&})]+/gi,
    (_m, key) => `${key}[redacted]`,
  ],
  // Query strings and #fragments (tokens travel in links).
  [/(\/[^\s?#"']*)[?#][^\s"')]*/g, (_m, path) => `${path}?[redacted]`],
  // Email addresses.
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, () => '[email]'],
  // Long opaque strings (session tokens, keys): 32 or more base64url characters. Ids (UUIDs)
  // stay, since they are what makes a log line traceable.
  [/\b[A-Za-z0-9_-]{32,}\b/g, (match) => (UUID.test(match) ? match : '[redacted]')],
];

/** Removes anything that looks secret or personal from a log message. */
export function redact(text: string): string {
  return RULES.reduce((out, [pattern, replace]) => out.replace(pattern, replace), text);
}

const ORDER: LogLevel[] = ['verbose', 'debug', 'log', 'warn', 'error', 'fatal'];
const NAMES: Record<LogLevel, string> = {
  verbose: 'trace',
  debug: 'debug',
  log: 'info',
  warn: 'warn',
  error: 'error',
  fatal: 'fatal',
};

/** A Nest logger writing redacted JSON lines; levels below the minimum are dropped. */
export class JsonLogger implements LoggerService {
  private readonly min: number;

  constructor(
    minimum: LogLevel = 'log',
    private readonly write: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
    private readonly now: () => Date = () => new Date(),
  ) {
    this.min = ORDER.indexOf(minimum);
  }

  log(message: unknown, ...rest: unknown[]) {
    this.emit('log', message, rest);
  }
  error(message: unknown, ...rest: unknown[]) {
    this.emit('error', message, rest);
  }
  warn(message: unknown, ...rest: unknown[]) {
    this.emit('warn', message, rest);
  }
  debug(message: unknown, ...rest: unknown[]) {
    this.emit('debug', message, rest);
  }
  verbose(message: unknown, ...rest: unknown[]) {
    this.emit('verbose', message, rest);
  }
  fatal(message: unknown, ...rest: unknown[]) {
    this.emit('fatal', message, rest);
  }

  private emit(level: LogLevel, message: unknown, rest: unknown[]) {
    if (ORDER.indexOf(level) < this.min) return;
    // Nest passes the context last; for errors, a stack may come before it.
    const context = typeof rest[rest.length - 1] === 'string' ? (rest.pop() as string) : undefined;
    const stack =
      level === 'error' && typeof rest[0] === 'string' ? (rest[0] as string) : undefined;
    const text =
      message instanceof Error
        ? `${message.name}: ${message.message}`
        : typeof message === 'string'
          ? message
          : JSON.stringify(message);
    const entry: Record<string, string> = {
      time: this.now().toISOString(),
      level: NAMES[level],
      ...(context ? { context } : {}),
      message: redact(text ?? ''),
    };
    if (stack) entry.stack = redact(stack);
    this.write(JSON.stringify(entry));
  }
}
