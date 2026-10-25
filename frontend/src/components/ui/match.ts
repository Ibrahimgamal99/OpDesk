/**
 * The one text matcher.
 *
 * Five places were filtering with `x.toLowerCase().includes(q)` -- the dropdown
 * and the Users, Groups, Settings and Notes panels. Each was independently
 * case-insensitive and independently wrong about everything else, so this is not
 * a merge of working behaviour: ranking, folding and highlight ranges are all new
 * and land in all five at once.
 *
 * Two things it does that the five copies did not:
 *
 * 1. RANKS. `includes` returns source order, so typing "sup" put "Unsupervised"
 *    above "Support". Matches are tiered exact > prefix > word-start > substring.
 *
 * 2. FOLDS Arabic. This is the one that was losing results rather than merely
 *    misordering them: `احمد` did not match `أحمد`, and `100` did not match
 *    `١٠٠` -- which for a PBX means extension numbers typed on a Latin keyboard
 *    found nothing. Unicode NFD already decomposes أ إ آ ؤ ئ into a base letter
 *    plus a mark, so stripping the mark ranges folds those for free; only ى ة ک ی,
 *    the tatweel and the two digit blocks need naming.
 *
 * Every query is matched token-by-token: "ahmed sales" finds "Ahmed Hassan --
 * Sales Queue". All tokens must match, in any field, in any order.
 */

/** A run in the ORIGINAL string -- what the highlighter paints. */
export interface MatchRange {
  start: number;
  end: number;
}

/** Ranked, ascending: a lower tier sorts first. */
export const TIER_EXACT = 0;
export const TIER_PREFIX = 1;
export const TIER_WORD_START = 2;
export const TIER_SUBSTRING = 3;

export interface Match {
  /** The WORST tier across the query's tokens -- one weak token weakens the hit. */
  tier: number;
  /** Earliest match position in the primary field. Ties break on it. */
  position: number;
  /** Length of the primary field, so a hit in a short label outranks a long one. */
  length: number;
  /** Non-overlapping, ascending, indexed into the ORIGINAL primary text. */
  ranges: MatchRange[];
}

/**
 * Combining marks removed during folding.
 *
 * U+0300-036F  Latin  (José -> jose)
 * U+064B-065F  Arabic tashkeel AND the hamza marks that NFD splits off أ إ آ ؤ ئ
 * U+0670       superscript alef
 * U+06D6-06ED  Quranic annotation marks
 */
const MARKS = /[\u0300-\u036F\u064B-\u065F\u0670\u06D6-\u06ED]/g;

/** Letters that NFD leaves alone, so they have to be folded by name. */
const CHAR_MAP = new Map<string, string>([
  ['ـ', ''],          // tatweel (kashida) -- decorative stretching, never typed
  ['ى', 'ي'],    // ى -> ي  alef maksura
  ['ة', 'ه'],    // ة -> ه  teh marbuta
  ['ک', 'ك'],    // ک -> ك  Persian keheh
  ['ی', 'ي'],    // ی -> ي  Persian yeh
  ['ۀ', 'ه'],    // ۀ -> ه
]);

// Arabic-Indic (٠-٩) and extended/Persian (۰-۹) digits fold to ASCII, so an
// extension typed on either keyboard finds the same record.
for (let d = 0; d <= 9; d++) {
  CHAR_MAP.set(String.fromCharCode(0x0660 + d), String(d));
  CHAR_MAP.set(String.fromCharCode(0x06F0 + d), String(d));
}

/** Anything that can be inside a word. Its negation is a word boundary. */
const WORDY = /[\p{L}\p{N}]/u;

/**
 * Folded text plus the bookkeeping needed to map a hit back to the original.
 * Built once per option, never per keystroke -- folding a 400-option list on
 * every character is exactly the cost the windowing was added to avoid.
 */
export interface Folded {
  /** Normalized, mark-stripped, lowercased. */
  text: string;
  /** map[i] is the index in the ORIGINAL string that produced text[i]. */
  map: number[];
  /** wordStart[i] is true where text[i] begins a word. */
  wordStart: boolean[];
  /** Length of the original, for ranges that run to the end. */
  sourceLength: number;
}

function foldChar(ch: string): string {
  const mapped = CHAR_MAP.get(ch);
  if (mapped !== undefined) return mapped;
  return ch.normalize('NFD').replace(MARKS, '').toLowerCase();
}

/**
 * Fold, keeping a per-character index back to the source.
 *
 * Deliberately walks UTF-16 units rather than code points when filling `map`:
 * `text` is indexed by `indexOf` in UTF-16 units, so a map indexed by code point
 * would silently drift by one for every emoji earlier in the string.
 */
export function fold(input: string): Folded {
  const chars: string[] = [];
  const map: number[] = [];
  let at = 0;

  for (const ch of input) {
    const piece = foldChar(ch);
    for (let k = 0; k < piece.length; k++) {
      chars.push(piece[k]);
      map.push(at);
    }
    at += ch.length;
  }

  return {
    text: chars.join(''),
    map,
    wordStart: chars.map((_, i) => i === 0 || !WORDY.test(chars[i - 1])),
    sourceLength: input.length,
  };
}

/**
 * Fold without the index bookkeeping, for callers that only need a yes/no.
 * Normalizes the whole string in one pass instead of per character, which is
 * what makes it cheap enough to run over a table on every keystroke.
 */
export function foldPlain(input: string): string {
  const stripped = input.normalize('NFD').replace(MARKS, '');
  let out = '';
  for (const ch of stripped) out += CHAR_MAP.get(ch) ?? ch;
  return out.toLowerCase();
}

export interface Query {
  /** What the user typed, unfolded. For repeating back in empty states. */
  raw: string;
  /** Folded, whitespace-split. Every one must match for the item to match. */
  tokens: string[];
}

/** Returns null for a blank query, which callers read as "no filter". */
export function prepareQuery(raw: string): Query | null {
  const tokens = foldPlain(raw.trim()).split(/\s+/).filter(Boolean);
  return tokens.length ? { raw: raw.trim(), tokens } : null;
}

interface TokenHit {
  tier: number;
  start: number;
  end: number;
}

function matchToken(field: Folded, token: string): TokenHit | null {
  const first = field.text.indexOf(token);
  if (first < 0) return null;

  if (field.text === token) return { tier: TIER_EXACT, start: 0, end: token.length };
  if (first === 0) return { tier: TIER_PREFIX, start: 0, end: token.length };

  // Prefer a word-start occurrence over the earliest one: in "Sales Supervisor",
  // "sup" should highlight and rank on "Supervisor", not on the "s" of "Sales".
  for (let at = first; at >= 0; at = field.text.indexOf(token, at + 1)) {
    if (field.wordStart[at]) {
      return { tier: TIER_WORD_START, start: at, end: at + token.length };
    }
  }

  return { tier: TIER_SUBSTRING, start: first, end: first + token.length };
}

function toRange(field: Folded, start: number, end: number): MatchRange {
  return {
    start: field.map[start] ?? 0,
    end: end < field.map.length ? field.map[end] : field.sourceLength,
  };
}

/** Sort, then coalesce touching or overlapping runs -- two tokens can land on
 *  the same word and would otherwise paint nested <mark>s. */
function mergeRanges(ranges: MatchRange[]): MatchRange[] {
  if (ranges.length < 2) return ranges;
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const out: MatchRange[] = [sorted[0]];
  for (const r of sorted.slice(1)) {
    const last = out[out.length - 1];
    if (r.start <= last.end) last.end = Math.max(last.end, r.end);
    else out.push(r);
  }
  return out;
}

/**
 * An item, folded ahead of time. `primary` is the field that gets drawn and
 * highlighted; `secondary` is searched but never painted -- for the dropdown
 * that is the option's value, so an extension number is findable without the
 * highlight landing on text nobody can see.
 */
export interface Prepared {
  primary: Folded;
  secondary?: Folded;
}

export function prepare(primary: string, secondary?: string): Prepared {
  return {
    primary: fold(primary),
    secondary: secondary === undefined ? undefined : fold(secondary),
  };
}

export function matchPrepared(query: Query, item: Prepared): Match | null {
  let tier = TIER_EXACT;
  let position = Number.MAX_SAFE_INTEGER;
  const ranges: MatchRange[] = [];

  for (const token of query.tokens) {
    const onPrimary = matchToken(item.primary, token);
    const onSecondary = item.secondary ? matchToken(item.secondary, token) : null;

    const best = onPrimary && onSecondary
      ? (onPrimary.tier <= onSecondary.tier ? onPrimary : onSecondary)
      : (onPrimary ?? onSecondary);
    if (!best) return null;                      // every token has to land somewhere

    tier = Math.max(tier, best.tier);
    if (onPrimary) {
      position = Math.min(position, onPrimary.start);
      ranges.push(toRange(item.primary, onPrimary.start, onPrimary.end));
    }
  }

  return { tier, position, length: item.primary.sourceLength, ranges: mergeRanges(ranges) };
}

/**
 * Best first. Callers sort with this on a stable `Array.sort`, so items that tie
 * on every axis keep the order their source gave them.
 */
export function byRelevance(a: Match, b: Match): number {
  if (a.tier !== b.tier) return a.tier - b.tier;
  if (a.position !== b.position) return a.position - b.position;
  // A hit in a short label is more often the one meant: "Sales" over
  // "Sales Escalation Overflow Queue" for the query "sales".
  return a.length - b.length;
}

/**
 * Yes/no across several fields, for callers that filter a table and neither rank
 * nor highlight. A null query passes everything, so a blank box is not a filter.
 */
export function matches(
  query: Query | null,
  ...fields: (string | null | undefined)[]
): boolean {
  if (!query) return true;
  const hay = fields.filter((f): f is string => !!f).map(foldPlain);
  return query.tokens.every(token => hay.some(field => field.includes(token)));
}
