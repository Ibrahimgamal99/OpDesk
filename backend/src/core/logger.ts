/**
 * Logging: the app-wide LOG_LEVEL, a Python-logging-shaped API, and the filter
 * that keeps tokens in URLs out of the logs.
 *
 * Lines keep the Python format so journald greps and alerts written against the
 * old server still match:  `2026-10-18 21:00:00,123 - INFO - services.ami - message`.
 * Messages accept %-style placeholders (%s %d %r %i %f %.2f %%) so a ported
 * `log.info("x=%s", x)` keeps its argument list. A trailing Error beyond the
 * placeholders appends its stack, the way exc_info=True appended the traceback.
 */

import { env } from './config';

export type LogLevel = 'DEBUG' | 'INFO' | 'WARNING' | 'ERROR' | 'CRITICAL';

const LEVELS: Record<LogLevel, number> = { DEBUG: 10, INFO: 20, WARNING: 30, ERROR: 40, CRITICAL: 50 };

function resolveLevel(): number {
  const name = env('LOG_LEVEL', 'INFO').trim().toUpperCase() as LogLevel;
  return LEVELS[name] ?? LEVELS.INFO;
}

// Single app-wide logging level, controlled by LOG_LEVEL (DEBUG | INFO | WARNING | ERROR).
export let LOG_LEVEL = resolveLevel();

export function setLogLevel(level: LogLevel): void {
  LOG_LEVEL = LEVELS[level] ?? LEVELS.INFO;
}

// Query parameters that carry a credential. Old app builds still open the WebSocket
// as /ws?token=<jwt> and fetch recordings with ?token=, so without this the token
// lands in journald verbatim.
const TOKEN_QUERY_RE = /((?:^|[?&])(?:token|access_token|id_token|refresh_token|auth_token)=)[^&\s"']+/gi;

export function redactUrlTokens(text: string): string {
  return text.replace(TOKEN_QUERY_RE, '$1<redacted>');
}

function pyRepr(v: unknown): string {
  if (v === null || v === undefined) return 'None';
  if (typeof v === 'string') return `'${v}'`;
  if (typeof v === 'boolean') return v ? 'True' : 'False';
  return pyStr(v);
}

/** str(x) the way Python prints it in a log line or f-string. */
export function pyStr(v: unknown): string {
  if (v === null || v === undefined) return 'None';
  if (typeof v === 'boolean') return v ? 'True' : 'False';
  if (v instanceof Error) return v.message;
  if (typeof v === 'object') {
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  }
  return String(v);
}

/** Python's `fmt % args` for the conversions the code base uses. Returns the text and
 *  how many args it consumed. */
export function pyFormat(fmt: string, args: unknown[]): { text: string; used: number } {
  let i = 0;
  const text = fmt.replace(/%(%|s|r|d|i|(?:\.(\d+))?f)/g, (m, conv: string, prec?: string) => {
    if (conv === '%') return '%';
    if (i >= args.length) return m;
    const a = args[i++];
    switch (conv[conv.length - 1]) {
      case 's':
        return pyStr(a);
      case 'r':
        return pyRepr(a);
      case 'd':
      case 'i':
        return String(Math.trunc(Number(a)));
      default:
        return Number(a).toFixed(prec !== undefined ? Number(prec) : 6);
    }
  });
  return { text, used: i };
}

function timestamp(d = new Date()): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())},${p(d.getMilliseconds(), 3)}`
  );
}

export class Logger {
  constructor(readonly name: string) {}

  isEnabledFor(level: LogLevel): boolean {
    return LEVELS[level] >= LOG_LEVEL;
  }

  log(level: LogLevel, msg: string, ...args: unknown[]): void {
    if (LEVELS[level] < LOG_LEVEL) return;
    // Each argument is redacted on its own (an argument may itself start with `token=`),
    // then the whole line, which catches tokens inside a formatted URL.
    const safeArgs = args.map((a) => (typeof a === 'string' && a.includes('=') ? redactUrlTokens(a) : a));
    const { text, used } = pyFormat(String(msg), safeArgs);
    let line = `${timestamp()} - ${level} - ${this.name} - ${text}`;
    for (const extra of args.slice(used)) {
      if (extra instanceof Error && extra.stack) line += `\n${extra.stack}`;
    }
    if (line.includes('=')) line = redactUrlTokens(line);
    (LEVELS[level] >= LEVELS.WARNING ? process.stderr : process.stdout).write(line + '\n');
  }

  debug(msg: string, ...args: unknown[]): void {
    this.log('DEBUG', msg, ...args);
  }

  info(msg: string, ...args: unknown[]): void {
    this.log('INFO', msg, ...args);
  }

  warning(msg: string, ...args: unknown[]): void {
    this.log('WARNING', msg, ...args);
  }

  /** Alias so `log.warn` (the JS habit) does not silently fail to compile into nothing. */
  warn(msg: string, ...args: unknown[]): void {
    this.log('WARNING', msg, ...args);
  }

  error(msg: string, ...args: unknown[]): void {
    this.log('ERROR', msg, ...args);
  }

  critical(msg: string, ...args: unknown[]): void {
    this.log('CRITICAL', msg, ...args);
  }

  /** log.exception: ERROR plus the stack of `err` (pass the caught error last). */
  exception(msg: string, ...args: unknown[]): void {
    this.log('ERROR', msg, ...args);
  }
}

const loggers = new Map<string, Logger>();

/** logging.getLogger(name). Use the Python module path ("services.ami") as the name. */
export function getLogger(name: string): Logger {
  let l = loggers.get(name);
  if (!l) {
    l = new Logger(name);
    loggers.set(name, l);
  }
  return l;
}

// Access-log noise: successful polls of these prefixes are dropped. A 4xx or 5xx on
// a polled endpoint is exactly the event worth seeing, so those keep their line.
const QUIET_PREFIXES = [
  '/api/call-notifications',
  '/api/internal/mobile-wake',
  // The System Logs panel polls these every couple of seconds while it is open.
  '/api/logs',
  '/health',
];

const accessLog = getLogger('uvicorn.access');

/** One uvicorn-style access line per request, minus the quiet polls. */
export function logAccess(client: string, method: string, url: string, httpVersion: string, status: number): void {
  if (status < 400 && QUIET_PREFIXES.some((p) => url.startsWith(p))) return;
  accessLog.info('%s - "%s %s HTTP/%s" %d', client, method, redactUrlTokens(url), httpVersion, status);
}
