/**
 * Small Python-compatibility helpers for the port.
 *
 * The API contract was written by Python: naive server-local datetimes rendered by
 * isoformat(), banker's rounding, int() that refuses "12abc". These helpers keep
 * the TypeScript behaviour identical where a client or the database can tell.
 */

import { performance } from 'perf_hooks';
import { pyStr } from './logger';

const p2 = (n: number) => String(n).padStart(2, '0');

/** datetime.isoformat() of a naive local datetime: `2026-10-18T21:00:00[.123000]`. */
export function isoformat(d: Date, sep = 'T'): string {
  const base =
    `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}${sep}` +
    `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
  const ms = d.getMilliseconds();
  return ms ? `${base}.${String(ms).padStart(3, '0')}000` : base;
}

/** str(datetime): isoformat with a space, the form json.dumps(default=str) wrote. */
export function pyDatetimeStr(d: Date): string {
  return isoformat(d, ' ');
}

/** date.isoformat(): `2026-10-18`. */
export function dateIso(d: Date): string {
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}

/** `YYYY-MM-DD HH:MM:SS`, the MySQL DATETIME literal for a local time. */
export function mysqlDatetime(d: Date): string {
  return (
    `${dateIso(d)} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`
  );
}

/** datetime.now().isoformat() */
export function nowIso(): string {
  return isoformat(new Date());
}

/** time.time(): seconds since the epoch, as a float. */
export function time(): number {
  return Date.now() / 1000;
}

/** time.monotonic() / loop.time(): seconds on a clock that never goes backwards. */
export function monotonic(): number {
  return performance.now() / 1000;
}

/** asyncio.sleep(seconds) */
export function sleep(seconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, seconds * 1000)));
}

/**
 * datetime.fromisoformat() for the forms clients send. A string with no offset is a
 * naive local time (what Python produced); one with Z / ±HH:MM is converted to local.
 * Returns null when it does not parse, where Python raised ValueError.
 */
export function fromisoformat(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?)?(Z|[+-]\d{2}:?\d{2})?$/.exec(
    s.trim(),
  );
  if (!m) return null;
  const [, y, mo, d, h = '0', mi = '0', sec = '0', frac = '0', tz] = m;
  const ms = Math.floor(Number(frac.padEnd(6, '0')) / 1000);
  let out: Date;
  if (tz) {
    const iso = `${y}-${mo}-${d}T${p2(+h)}:${p2(+mi)}:${p2(+sec)}.${String(ms).padStart(3, '0')}${
      tz === 'Z' ? 'Z' : tz.length === 5 ? `${tz.slice(0, 3)}:${tz.slice(3)}` : tz
    }`;
    out = new Date(iso);
  } else {
    out = new Date(+y, +mo - 1, +d, +h, +mi, +sec, ms);
  }
  if (Number.isNaN(out.getTime())) return null;
  // new Date(2026, 1, 31) silently rolls into March; Python refuses the date.
  if (!tz && (out.getMonth() !== +mo - 1 || out.getDate() !== +d)) return null;
  return out;
}

/** timedelta arithmetic on a Date: addSeconds(d, -3600) is `d - timedelta(hours=1)`. */
export function addSeconds(d: Date, seconds: number): Date {
  return new Date(d.getTime() + seconds * 1000);
}

/**
 * round(x, n) with Python semantics: half-to-even on the exact binary value. JS's
 * Math.round is half-up, which moves every .5 and changes analytics output.
 */
export function pyRound(x: number, ndigits = 0): number {
  if (!Number.isFinite(x)) return x;
  // toFixed(k) with a large k is the exact decimal expansion of the binary value, so
  // a tie is a tie only when it really is one (2.675 is 2.67499999... and is not).
  const exact = Math.abs(x).toFixed(Math.min(100, ndigits + 70));
  const dot = exact.indexOf('.');
  const tail = exact.slice(dot + 1 + ndigits);
  let out: number;
  if (tail[0] === '5' && /^0*$/.test(tail.slice(1))) {
    const kept = exact.slice(0, dot + 1 + ndigits).replace(/\.$/, '');
    const lastDigit = Number(kept[kept.length - 1]);
    const down = Number(kept);
    out = lastDigit % 2 === 0 ? down : down + 10 ** -ndigits;
    out = Number(out.toFixed(Math.max(0, ndigits)));
  } else {
    out = Number(Math.abs(x).toFixed(ndigits));
  }
  return x < 0 ? -out : out;
}

/** Python's `a // b` (floors toward -inf). */
export function floorDiv(a: number, b: number): number {
  return Math.floor(a / b);
}

/** Python's `a % b` (result takes the sign of b). */
export function pyMod(a: number, b: number): number {
  return ((a % b) + b) % b;
}

/**
 * int(x) as Python parses it: an integer literal with optional sign and surrounding
 * whitespace, or a number (truncated). Returns null where Python raised ValueError /
 * TypeError, so the caller keeps its except branch.
 */
export function pyInt(x: unknown): number | null {
  if (typeof x === 'number') return Number.isFinite(x) ? Math.trunc(x) : null;
  if (typeof x === 'boolean') return x ? 1 : 0;
  if (typeof x === 'string') {
    const s = x.trim().replace(/_/g, '');
    return /^[+-]?\d+$/.test(s) ? parseInt(s, 10) : null;
  }
  return null;
}

/** float(x): null where Python raised. */
export function pyFloat(x: unknown): number | null {
  if (typeof x === 'number') return x;
  if (typeof x === 'boolean') return x ? 1 : 0;
  if (typeof x === 'string') {
    const s = x.trim().toLowerCase();
    if (s === '' || !/^[+-]?(\d+\.?\d*(e[+-]?\d+)?|\.\d+(e[+-]?\d+)?|inf|infinity|nan)$/.test(s)) return null;
    if (s.endsWith('inf') || s.endsWith('infinity')) return s.startsWith('-') ? -Infinity : Infinity;
    return Number(s);
  }
  return null;
}

/** Python truthiness: None, False, 0, '', [], {} are false. */
export function truthy(v: unknown): boolean {
  if (v === null || v === undefined || v === false || v === 0 || v === '') return false;
  if (Number.isNaN(v)) return false;
  if (Array.isArray(v)) return v.length > 0;
  if (v instanceof Map || v instanceof Set) return v.size > 0;
  if (typeof v === 'object' && !(v instanceof Date)) return Object.keys(v as object).length > 0;
  return true;
}

/** The `str(x).strip().lower() in ('true', '1', 'yes')` setting test used everywhere. */
export function isTrueish(v: unknown, extra: string[] = []): boolean {
  if (v === null || v === undefined) return false;
  return ['true', '1', 'yes', ...extra].includes(String(v).trim().toLowerCase());
}

/**
 * asyncio.create_task(coro) for fire-and-forget work: runs it and logs a rejection
 * instead of letting it become an unhandled rejection that kills the process.
 */
export function createTask<T>(p: Promise<T>, onError?: (e: unknown) => void): Promise<T | undefined> {
  return p.catch((e) => {
    if (onError) onError(e);
    else process.stderr.write(`Task exception was never retrieved: ${e instanceof Error ? e.stack : String(e)}\n`);
    return undefined;
  });
}

/** asyncio.wait_for(p, timeout): rejects with TimeoutError after `seconds`. */
export class TimeoutError extends Error {
  constructor(message = 'timed out') {
    super(message);
    this.name = 'TimeoutError';
  }
}

export function waitFor<T>(p: Promise<T>, seconds: number): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    p,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new TimeoutError()), seconds * 1000);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** asyncio.Lock: `await lock.run(async () => {...})` serialises the critical sections. */
export class AsyncLock {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => Promise<T> | T): Promise<T> {
    const result = this.tail.then(() => fn());
    this.tail = result.catch(() => undefined);
    return result;
  }
}

/**
 * json.dumps(value) byte-for-byte: `', '` / `': '` separators, non-ASCII escaped as \uXXXX
 * (ensure_ascii, the default), NaN/Infinity literals. `defaultStr` is json.dumps(default=str):
 * a datetime becomes str(dt), anything else unknown becomes str(x). Use it wherever the exact
 * bytes matter: a value stored and compared later, a signature, a payload a CRM stored.
 */
export function pyJsonDumps(value: unknown, opts: { ensureAscii?: boolean; defaultStr?: boolean } = {}): string {
  const ensureAscii = opts.ensureAscii ?? true;
  const defaultStr = opts.defaultStr ?? false;
  const quote = (s: string): string => {
    const j = JSON.stringify(s);
    return ensureAscii ? j.replace(/[\u0080-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`) : j;
  };
  const enc = (v: unknown): string => {
    if (v === null || v === undefined) return 'null';
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    if (typeof v === 'number') {
      if (Number.isNaN(v)) return 'NaN';
      if (!Number.isFinite(v)) return v > 0 ? 'Infinity' : '-Infinity';
      return String(v);
    }
    if (typeof v === 'bigint') return v.toString();
    if (typeof v === 'string') return quote(v);
    if (Array.isArray(v)) return `[${v.map(enc).join(', ')}]`;
    if (v instanceof Date) {
      if (defaultStr) return quote(pyDatetimeStr(v));
      throw new TypeError('Object of type datetime is not JSON serializable');
    }
    if (typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) {
      const parts: string[] = [];
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        if (x === undefined) continue;
        parts.push(`${quote(k)}: ${enc(x)}`);
      }
      return `{${parts.join(', ')}}`;
    }
    if (defaultStr) return quote(pyStr(v));
    throw new TypeError(`Object of type ${typeof v} is not JSON serializable`);
  };
  return enc(value);
}
