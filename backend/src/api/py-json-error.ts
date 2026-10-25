/**
 * Where and why Python's json.loads() rejects a text: the (pos, msg) of its JSONDecodeError.
 *
 * FastAPI answered a malformed JSON body with a 422 whose field path is that position and
 * whose params.error is that message ("Expecting value", "Expecting ',' delimiter", ...).
 * Node's JSON.parse reports neither in a stable form, so this re-scans the raw text with the
 * rules of CPython 3.11's C scanner (Modules/_json.c) -- only to locate the first error, never
 * to produce a value. Returns null when Python would have accepted the text.
 */

export interface PyJsonError {
  pos: number;
  msg: string;
}

class Fail extends Error {
  constructor(
    readonly pos: number,
    readonly msgText: string,
  ) {
    super(msgText);
  }
}

/** scan_once's StopIteration: "no value starts here" (raw_decode turns it into "Expecting value"). */
class NoValue extends Error {
  constructor(readonly pos: number) {
    super('no value');
  }
}

const WS = new Set([' ', '\t', '\n', '\r']);
const NUMBER_RE = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][-+]?\d+)?/y;
const HEX = /^[0-9a-fA-F]$/;

function skipWs(s: string, i: number): number {
  while (i < s.length && WS.has(s[i])) i++;
  return i;
}

/** scanstring_unicode: `end` is just past the opening quote; returns the index past the closing one. */
function scanString(s: string, end: number): number {
  const begin = end - 1;
  for (;;) {
    let next = end;
    while (next < s.length) {
      const c = s[next];
      if (c === '"' || c === '\\') break;
      if (c.charCodeAt(0) <= 0x1f) throw new Fail(next, 'Invalid control character at');
      next++;
    }
    if (next >= s.length) throw new Fail(begin, 'Unterminated string starting at');
    if (s[next] === '"') return next + 1;
    // A backslash escape.
    next++;
    if (next >= s.length) throw new Fail(begin, 'Unterminated string starting at');
    const c = s[next];
    if (c !== 'u') {
      if (!'"\\/bfnrt'.includes(c)) throw new Fail(next - 1, 'Invalid \\escape');
      end = next + 1;
      continue;
    }
    next++;
    if (next + 4 > s.length) throw new Fail(next - 1, 'Invalid \\uXXXX escape');
    for (let k = 0; k < 4; k++) {
      if (!HEX.test(s[next + k])) throw new Fail(next - 1, 'Invalid \\uXXXX escape');
    }
    end = next + 4;
  }
}

function scanObject(s: string, idx: number): number {
  // idx is just past '{'
  idx = skipWs(s, idx);
  if (idx < s.length && s[idx] === '}') return idx + 1;
  for (;;) {
    if (idx >= s.length || s[idx] !== '"') throw new Fail(idx, 'Expecting property name enclosed in double quotes');
    idx = scanString(s, idx + 1);
    idx = skipWs(s, idx);
    if (idx >= s.length || s[idx] !== ':') throw new Fail(idx, "Expecting ':' delimiter");
    idx = skipWs(s, idx + 1);
    idx = scanOnce(s, idx);
    idx = skipWs(s, idx);
    if (idx < s.length && s[idx] === '}') return idx + 1;
    if (idx >= s.length || s[idx] !== ',') throw new Fail(idx, "Expecting ',' delimiter");
    idx = skipWs(s, idx + 1);
  }
}

function scanArray(s: string, idx: number): number {
  // idx is just past '['
  idx = skipWs(s, idx);
  if (idx < s.length && s[idx] === ']') return idx + 1;
  for (;;) {
    idx = scanOnce(s, idx);
    idx = skipWs(s, idx);
    if (idx < s.length && s[idx] === ']') return idx + 1;
    if (idx >= s.length || s[idx] !== ',') throw new Fail(idx, "Expecting ',' delimiter");
    idx = skipWs(s, idx + 1);
  }
}

function scanOnce(s: string, idx: number): number {
  if (idx >= s.length) throw new NoValue(idx);
  const c = s[idx];
  if (c === '"') return scanString(s, idx + 1);
  if (c === '{') return scanObject(s, idx + 1);
  if (c === '[') return scanArray(s, idx + 1);
  for (const lit of ['null', 'true', 'false', 'NaN', 'Infinity', '-Infinity']) {
    if (s.startsWith(lit, idx)) return idx + lit.length;
  }
  NUMBER_RE.lastIndex = idx;
  const m = NUMBER_RE.exec(s);
  if (m && m[0].length) return idx + m[0].length;
  throw new NoValue(idx);
}

/** The error json.loads(text) would raise, or null if it parses. */
export function pyJsonError(text: string): PyJsonError | null {
  try {
    let idx = skipWs(text, 0);
    try {
      idx = scanOnce(text, idx);
    } catch (e) {
      if (e instanceof NoValue) throw new Fail(e.pos, 'Expecting value');
      throw e;
    }
    idx = skipWs(text, idx);
    if (idx !== text.length) throw new Fail(idx, 'Extra data');
    return null;
  } catch (e) {
    // Python counts code points; a JS index counts UTF-16 units (an emoji is two).
    const cp = (i: number) => Array.from(text.slice(0, i)).length;
    if (e instanceof Fail) return { pos: cp(e.pos), msg: e.msgText };
    if (e instanceof NoValue) return { pos: cp(e.pos), msg: 'Expecting value' };
    throw e;
  }
}
