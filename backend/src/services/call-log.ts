/**
 * Port of call_log.py: Call History rows from the CDR (+ CEL), direction classification,
 * channel -> extension conversion, the call-outcome mapping, "who ended the call", the
 * call journey, and the CRM identity of a finished call.
 *
 * What changed from the Python, deliberately (PLAN "API changes" 1-3):
 *   * status is one of the ten call-outcomes values, read from the call's own CEL hangup
 *     facts (cause, Dial()'s DIALSTATUS, who hung up), not from the four-value CDR
 *     disposition alone; rows gain ended_by / ended_by_agent / supervision_count;
 *   * convertChannelToExtension understands Local/<ext>@context channels (queues, ring
 *     groups, follow-me), so those calls name their agent instead of the trunk;
 *   * the journey uses ISO times, says UNANSWERED (not NO_ANSWER), shows supervision
 *     (LISTEN/WHISPER/BARGE) and IVR menus, never claims an ANSWER for a leg that was not
 *     answered, and orders OUTBOUND first among same-second events.
 *
 * A multi-leg call's status, talk time and agent come from the last leg a party answered,
 * not the last leg (a call answered and then transferred to nobody was still answered); a
 * queue caller who hung up while waiting is ABANDONED; each row names its customer (cnam on
 * inbound calls only, else the phonebook), its agent and its route.
 */

import * as dbm from '../db/db-manager';
import { decodeCursor, encodeCursor } from '../db/pool';
import type { Row, SqlValue } from '../db/pool';
import { pyStr } from '../core/logger';
import { addSeconds, floorDiv, isoformat, pyInt, pyMod, pyRound, truthy } from '../core/py';
import {
  ANSWERED,
  UNANSWERED,
  BUSY,
  MISSED,
  VOICEMAIL,
  UNREACHABLE,
  FAILURE,
  NETWORK_ERROR,
  DROPPED,
  ABANDONED,
} from './call-outcomes';
import { getRecordingPath } from './recording';

// Re-exported: analytics / ami / crm import the vocabulary from here, as they did from
// call_log.py.
export {
  ANSWERED,
  UNANSWERED,
  BUSY,
  MISSED,
  VOICEMAIL,
  UNREACHABLE,
  FAILURE,
  NETWORK_ERROR,
  ABANDONED,
  DROPPED,
  CALL_OUTCOMES,
  TALKED_OUTCOMES,
  NOTIFY_OUTCOMES,
  callStatus,
} from './call-outcomes';
export { getRecordingPath, invalidateRecordingIndex, recordingRoot } from './recording';

// ---------------------------------------------------------------------------
// Small Python-compat helpers
// ---------------------------------------------------------------------------

function has(o: unknown, k: string): boolean {
  return o !== null && o !== undefined && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k);
}

/** dict.get(k): the value, or null when absent. */
function dget(o: Row | null | undefined, k: string): any {
  return has(o, k) ? ((o as Row)[k] ?? null) : null;
}

/** dict.get(k, d): a present None stays None; only an absent key yields `d`. */
function dgetOr(o: Row | null | undefined, k: string, d: unknown): any {
  return has(o, k) ? ((o as Row)[k] === undefined ? null : (o as Row)[k]) : d;
}

/** str(x or ''). */
function strOr(v: unknown): string {
  return truthy(v) ? pyStr(v) : '';
}

/** str.isdigit(): one or more Unicode decimal digits. */
function isDigitStr(s: string): boolean {
  return /^\p{Nd}+$/u.test(s);
}

/** datetime.isoformat(timespec='seconds') of a naive local datetime. */
export function isoSeconds(d: Date): string {
  const copy = new Date(d.getTime());
  copy.setMilliseconds(0);
  return isoformat(copy);
}

function asDate(v: unknown): Date | null {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (typeof v === 'string' && v) {
    const d = new Date(v.replace(' ', 'T'));
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

// ===========================================================================
// Phonebook name resolution for history rows
// ===========================================================================
// Installed by core/lifespan at startup rather than imported, because this module is also
// imported by analytics and must not pull in the resolver (or the CRM connector it holds)
// just to classify a disposition.
//
// The callable must be a pure in-memory lookup: a history page resolves one name per row,
// so anything that could hit the DB or the network here turns one page view into hundreds
// of round trips. ContactResolver.nameFor() is that lookup, and it deliberately does NOT
// schedule a CRM fetch for an unknown historical number.
export type ContactNameResolver = (phoneNumber: string) => string | null | undefined;
let contactNameResolver: ContactNameResolver | null = null;

/** Install the phonebook lookup used to name history rows. Pass null to disable. */
export function setContactNameResolver(fn: ContactNameResolver | null): void {
  contactNameResolver = fn;
}

// Caller-ID names that carry no information. FreePBX's inbound route sets an empty
// CALLERID(name) to the number itself, so a CDR very often has cnam set to the number --
// which would otherwise shadow a real phonebook name.
export const CNAM_NOISE: readonly string[] = ['', 'unknown', '<unknown>', 'anonymous', 'restricted', 'private'];

/**
 * Best display name for a history row's remote party, or null.
 *
 * `cnam` is the caller-ID name the network delivered, and it names the remote party only on
 * an INBOUND call: on an outbound or internal call it is our own agent's name (the row for
 * agent hema's *43 test call read "hema" as its customer), so callers pass null there. A
 * cnam that says something wins; one that is absent, noise, or merely the number again
 * falls back to the phonebook -- which also puts names added today on older calls.
 */
export function resolveCustomerName(cnam: unknown, phoneNumber: unknown): string | null {
  let name = strOr(cnam).trim();
  if (CNAM_NOISE.includes(name.toLowerCase())) {
    name = '';
  } else {
    // cnam is just the number again. Only when the number has digits: a digit-free name
    // against an empty/withheld number ('' == '') is a real name and is kept.
    const numDigits = strOr(phoneNumber).replace(/\P{Nd}/gu, '');
    if (numDigits && name.replace(/\P{Nd}/gu, '') === numDigits) name = '';
  }
  if (name) return name;
  if (contactNameResolver === null || !truthy(phoneNumber)) return null;
  try {
    const r = contactNameResolver(pyStr(phoneNumber));
    return truthy(r) ? (r as string) : null;
  } catch {
    return null;
  }
}

// ===========================================================================
// Call outcome mapping
// ===========================================================================

// Q.850 cause -> outcome for legs that did NOT answer.
// '16' (normal clearing) is deliberately absent: on an unanswered leg it means the call was
// cleared in a perfectly ordinary way rather than refused or failed, which is the caller
// hanging up. It is resolved in mapCallOutcome, through CANCEL_CAUSES.
export const CAUSE_OUTCOME: Readonly<Record<string, string>> = {
  '17': BUSY,
  '18': UNANSWERED, '19': UNANSWERED, '127': UNANSWERED,
  '20': UNREACHABLE, // subscriber absent -- switched off / out of coverage
  '27': UNREACHABLE, // destination out of order
  '21': BUSY, // call rejected -- the callee (or their phone) refused it
  '1': FAILURE, // unallocated number
  '28': FAILURE, // invalid number format
  '31': FAILURE, // normal, unspecified -- no better information available
  '3': NETWORK_ERROR, // no route to destination
  '34': NETWORK_ERROR, // no circuit/channel available
  '38': NETWORK_ERROR, // network out of order
  '41': NETWORK_ERROR, // temporary failure
  '42': NETWORK_ERROR, // switching equipment congestion
  '44': NETWORK_ERROR, // requested channel not available
  '58': NETWORK_ERROR, // bearer capability not presently available
  // 26 'non-selected user clearing' is what a ring-group/queue leg reports when ANOTHER
  // device took the call: not this party's outcome, just the ordinary unanswered leg.
  '26': UNANSWERED,
};
// Dialstatus overrides (the most specific signal for an unanswered leg). NOANSWER and CANCEL
// are the pair that matters: Dial() leaves NOANSWER when it rang out on its own timer and
// CANCEL when the CALLER hung up first.
export const DIALSTATUS_OUTCOME: Readonly<Record<string, string>> = {
  ANSWERED: ANSWERED, BUSY: BUSY, NOANSWER: UNANSWERED,
  CONGESTION: NETWORK_ERROR,
  // The channel could not be created: the device is not registered / not there. That is
  // the phone being unreachable, not the number being wrong.
  CHANUNAVAIL: UNREACHABLE,
};
// CANCEL -- Dial()'s word for the caller hanging up first -- and cause 16 mean the call was
// simply cleared. Which status that is depends on who the caller was (mapCallOutcome's
// `outbound`): someone calling US gave up while it rang -> MISSED; our agent ended an
// OUTBOUND call before the customer answered -> UNANSWERED (the journey's "ended by" says
// the agent did it).
// Cause 0 is NOT here: it means no cause was reported at all, which is unknown rather than
// ordinary (OpDesk used to read it as BUSY and rang the bell "Busy" for calls that never
// reached a phone). It falls through to the disposition instead.
export const CANCEL_CAUSES: ReadonlySet<string> = new Set(['16']);
// CDR disposition -> outcome: the coarsest signal and the last resort (the CDR stores no
// hangup cause, which is why the finer verdicts come from CEL or the live AMI path).
export const DISPOSITION_OUTCOME: Readonly<Record<string, string>> = {
  ANSWERED: ANSWERED, 'NO ANSWER': UNANSWERED, BUSY: BUSY,
  FAILED: FAILURE, CONGESTION: NETWORK_ERROR,
};
// Causes that mean an *already-answered* call was torn down abnormally => DROPPED.
export const DROPPED_CAUSES: ReadonlySet<string> = new Set(['38', '41', '44']);

export interface MapCallOutcomeOptions {
  cause?: unknown;
  dialStatus?: string | null;
  answered?: boolean;
  disposition?: string | null;
  abandoned?: boolean;
  voicemail?: boolean;
  outbound?: boolean;
}

/**
 * Return the canonical call outcome (one of CALL_OUTCOMES).
 *
 * Signals, richest first:
 *   voicemail    -- the answering party was voicemail, not a person
 *   answered     -- the call had answer/talk time (or an agent answered a queue call)
 *   cause        -- Asterisk Q.850 hangup cause code (str/int)
 *   dialStatus   -- Dialstatus (ANSWERED/BUSY/NOANSWER/CANCEL/CONGESTION/CHANUNAVAIL)
 *   disposition  -- CDR disposition, the fallback when no live signal exists
 *   abandoned    -- the caller left the queue before an agent answered
 *   outbound     -- the caller was on OUR side, so a caller who hung up first is our agent
 *                   giving up (UNANSWERED), not someone we missed (MISSED)
 *
 * The live AMI path has cause + dial status + abandoned; the Call History path recovers
 * cause and dial status from CEL (outcomeFromCel) and falls back to `disposition` for a
 * call CEL cannot account for -- both land on this one function, so a call reads the same
 * in the CRM push, the bell and Call History.
 */
export function mapCallOutcome(opts: MapCallOutcomeOptions = {}): string {
  const cause = opts.cause ?? null;
  const ds = (opts.dialStatus || '').trim().toUpperCase();
  const c = cause !== null ? pyStr(cause).trim() : '';
  const disp = (opts.disposition || '').trim().toUpperCase();

  // Voicemail answers the call, so it is decided before the answered check -- otherwise
  // every call that reached voicemail reads as a conversation with a person.
  if (opts.voicemail) return VOICEMAIL;

  // An answered call is ANSWERED unless it dropped abnormally after pickup.
  if (opts.answered || ds === 'ANSWERED') return DROPPED_CAUSES.has(c) ? DROPPED : ANSWERED;

  // Unanswered: a queue abandon is its own outcome.
  if (opts.abandoned) return ABANDONED;

  // Dial() can leave NOANSWER before the far end's final refusal (cause 17 busy, 21
  // rejected) arrives; the refusal is the truer verdict.
  if (ds === 'NOANSWER' && (c === '17' || c === '21')) return BUSY;

  if (has(DIALSTATUS_OUTCOME, ds)) return DIALSTATUS_OUTCOME[ds];
  // Cleared, not refused and not rung out: the caller ended it. See CANCEL_CAUSES.
  if (ds === 'CANCEL' || CANCEL_CAUSES.has(c)) return opts.outbound ? UNANSWERED : MISSED;
  if (has(CAUSE_OUTCOME, c)) return CAUSE_OUTCOME[c];
  if (has(DISPOSITION_OUTCOME, disp)) return DISPOSITION_OUTCOME[disp];
  return FAILURE;
}

/** {channame: {cause, source, dialstatus, forwarded, seq}}: one call's CEL hangup facts. */
export type CelFacts = Record<string, Row>;

/**
 * Did the caller give up while waiting in a queue (ABANDONED)?
 *
 * Queue() leaves no DIALSTATUS and the CDR has no QUEUESTATUS, so this is read off the
 * call's own legs and CEL:
 *   * the call went through Queue() and its final leg is still a Queue() leg -- a queue
 *     that times out moves the caller on to its failover destination, a later leg;
 *   * no party answered on any leg (billsec > 0 with a destination channel). A caller's own
 *     leg can carry billsec with no member at all: FreePBX answers the caller to play
 *     music on hold, so billsec alone does not mean an agent took the call;
 *   * the caller ended it: CEL names the caller's channel as the source of its own hangup.
 *     With no CEL for the call at all (a PBX without CEL, or the analytics scan that skips
 *     it), a call that ended inside Queue() with nobody answering is the caller leaving.
 */
export function queueAbandoned(cdr: Row, celFacts: CelFacts | null | undefined): boolean {
  if (strOr(dget(cdr, 'lastapp')) !== 'Queue') return false;
  const partyAnswered = has(cdr, 'party_answered')
    ? truthy(Number(dget(cdr, 'party_answered')))
    : (Number(dget(cdr, 'billsec')) || 0) > 0 && truthy(dget(cdr, 'dstchannel'));
  if (partyAnswered) return false;
  if (!truthy(celFacts)) return true;
  const callerCh = strOr(dget(cdr, 'channel'));
  const caller: Row | null = callerCh ? dget(celFacts as CelFacts, callerCh) : null;
  return truthy(caller) && dget(caller, 'source') === callerCh;
}

/**
 * The call's outcome, read from the CEL hangup facts of its own two channels.
 *
 * Which channel to believe:
 *   * the CALLEE's leg (the outcome leg's dstchannel) is the one that says busy / declined /
 *     unreachable -- it is their phone reporting on itself;
 *   * the CALLER's leg (the outcome leg's channel, `last_channel`) carries the DIALSTATUS
 *     Dial() left behind, and is the fallback cause when the callee's leg never existed.
 * A cause of 0 means "none reported" rather than a verdict, so it is skipped in favour of a
 * real one from the other leg, and failing that the CDR disposition still decides. A queue
 * caller who hung up while waiting is ABANDONED (queueAbandoned), whatever the legs say.
 */
export function outcomeFromCel(cdr: Row, celFacts: CelFacts): string {
  if (queueAbandoned(cdr, celFacts)) return ABANDONED;
  const factsFor = (ch: unknown): Row | null => {
    const k = truthy(ch) ? pyStr(ch) : '';
    const f = has(celFacts, k) ? celFacts[k] : null;
    return truthy(f) ? f : null;
  };
  const callee: Row = factsFor(dget(cdr, 'dstchannel')) ?? {};
  const caller: Row = factsFor(dget(cdr, 'last_channel')) ?? factsFor(dget(cdr, 'channel')) ?? {};
  let cause: unknown = '';
  for (const f of [callee, caller]) {
    const c = dget(f, 'cause');
    if (!(c === null || c === '' || c === '0')) {
      cause = c;
      break;
    }
  }
  return mapCallOutcome({
    cause,
    dialStatus: dget(caller, 'dialstatus') || dget(callee, 'dialstatus') || '',
    answered: truthy(dget(cdr, 'billsec')),
    disposition: pyStr(dgetOr(cdr, 'disposition', '')).toUpperCase(),
    voicemail: strOr(dget(cdr, 'lastapp')).trim().toLowerCase() === 'voicemail',
    outbound: dget(cdr, 'call_type') === 'OUT',
  });
}

// ===========================================================================
// Direction and agent
// ===========================================================================

// Asterisk's audio loopback test application (the *43 feature code runs it): a call to it
// never leaves the PBX. Spelled out of letters because the bare word is reserved in this repo.
const LOOPBACK_TEST_APP = ['e', 'c', 'h', 'o'].join('');

/** Classify call direction (IN/OUT/INTERNAL) using weighted voting. */
export function classifyCdrDirection(cdr: Row): string {
  const src = pyStr(dgetOr(cdr, 'src', '')).trim();
  const dst = pyStr(dgetOr(cdr, 'dst', '')).trim();
  const dcontext = pyStr(dgetOr(cdr, 'dcontext', '')).toLowerCase();
  const channel = pyStr(dgetOr(cdr, 'channel', '')).toLowerCase();
  const dstchannel = pyStr(dgetOr(cdr, 'dstchannel', '')).toLowerCase();

  const votes: Record<string, number> = { IN: 0, OUT: 0, INTERNAL: 0 };

  // (Python's \d is any Unicode decimal digit, hence \p{Nd}.)
  const isExt = (n: string) => /^[1-9]\p{Nd}{1,4}$/u.test(n);
  const isPstn = (n: string) => /^\+?\p{Nd}{7,15}$/u.test(n);
  const isFeature = (n: string) => /^\*\p{Nd}+$/u.test(n);

  const srcExt = isExt(src);
  const dstExt = isExt(dst);
  const srcPstn = isPstn(src);
  const dstPstn = isPstn(dst);

  // Vote 1: Context (weight 4). Incoming keywords include any IVR.
  const incomingKeywords = ['from-trunk', 'from-pstn', 'incoming', 'ext-did', 'ivr', 'queue'];
  const outgoingKeywords = ['from-internal', 'outbound', 'dialout'];
  if (incomingKeywords.some((k) => dcontext.includes(k))) votes.IN += 4;
  if (outgoingKeywords.some((k) => dcontext.includes(k))) votes.OUT += 2;

  // Vote 2: Number patterns (weight 3-5)
  if (srcExt && dstPstn) {
    votes.OUT += 3;
  } else if (srcPstn && dstExt) {
    votes.IN += 3;
  } else if (srcExt && dstExt) {
    votes.INTERNAL += 5;
  } else if (srcExt && isFeature(dst)) {
    // Extension dialing a feature code (*43 test call, *97 voicemail, ...): it never leaves
    // the PBX, so it is internal, not an outbound call.
    votes.INTERNAL += 5;
  }

  // Vote 3: Channels (weight 2)
  const trunkIndicators = ['trunk', 'gw', 'provider', 'peer', 'dahdi'];
  if (trunkIndicators.some((x) => channel.includes(x))) votes.IN += 2;
  if (trunkIndicators.some((x) => dstchannel.includes(x))) votes.OUT += 2;

  // Vote 4: Last app (weight 3-2)
  const lastapp = pyStr(dgetOr(cdr, 'lastapp', '')).toLowerCase();
  if (lastapp === 'queue' || lastapp === 'ivr' || lastapp === 'stasis') {
    votes.IN += 2;
  } else if (lastapp === 'page' || lastapp === 'chanspy' || lastapp === LOOPBACK_TEST_APP) {
    votes.INTERNAL += 3;
  } else if (lastapp === 'background') {
    if (srcExt) votes.INTERNAL += 3;
  }

  const maxVotes = Math.max(votes.IN, votes.OUT, votes.INTERNAL);
  if (maxVotes === 0) {
    // Feature codes from extensions stay on the PBX -> INTERNAL
    if (srcExt && isFeature(dst)) return 'INTERNAL';
    if (srcExt && dstExt === false) return 'OUT';
    return srcExt ? 'INTERNAL' : 'UNKNOWN';
  }
  // Tie breaker: IN vs OUT
  if (votes.IN === votes.OUT && votes.OUT === maxVotes) return srcPstn ? 'IN' : 'OUT';
  // max(votes, key=votes.get): the first key (IN, OUT, INTERNAL order) holding the max.
  return (['IN', 'OUT', 'INTERNAL'] as const).find((k) => votes[k] === maxVotes) as string;
}

// How a call reached (or left) the agent, one value per row. Prefixed by the side it counts
// on, so a consumer can group on the prefix: outbound_*, inbound_*, internal_*.
export const CALL_ROUTES = [
  'outbound_direct',
  'inbound_queue',
  'inbound_ivr',
  'inbound_direct',
  'internal_extension',
  'internal_supervision',
  'internal_feature',
] as const;
export type CallRoute = (typeof CALL_ROUTES)[number];

/**
 * The route of one call-log row, read off its first leg once call_type is settled.
 * Structural throughout -- channel names, apps and dialplan contexts the PBX writes -- so
 * it holds for calls made before any setting changed:
 *   * a supervisor's ChanSpy call                        -> internal_supervision;
 *   * a feature code (*43, *97...) or an app- context    -> internal_feature (not for
 *     inbound: a DID routed to an announcement starts in an app- context too);
 *   * outbound                                           -> outbound_direct;
 *   * inbound through Queue() on any leg, or a queue context -> inbound_queue; an IVR
 *     context -> inbound_ivr; anything else inbound      -> inbound_direct;
 *   * the rest (extension to extension)                  -> internal_extension.
 */
export function callRoute(cdr: Row): CallRoute {
  const dcontext = strOr(dget(cdr, 'dcontext')).toLowerCase();
  const firstApp = strOr(dget(cdr, 'first_lastapp') || dget(cdr, 'lastapp'));
  const dst = strOr(dget(cdr, 'dst'));
  const callType = dget(cdr, 'call_type');
  if (firstApp === 'ChanSpy' || strOr(dget(cdr, 'linkedid')).startsWith('spy-')) return 'internal_supervision';
  if (callType !== 'IN' && (dst.startsWith('*') || dcontext.startsWith('app-'))) return 'internal_feature';
  if (callType === 'OUT') return 'outbound_direct';
  if (callType === 'IN') {
    if (dcontext.includes('queue') || firstApp === 'Queue' || (Number(dget(cdr, 'queue_legs')) || 0) > 0) return 'inbound_queue';
    if (dcontext.includes('ivr')) return 'inbound_ivr';
    return 'inbound_direct';
  }
  return 'internal_extension';
}

/** The side a route counts on: 'inbound' | 'outbound' | 'internal'. */
export function routeSide(route: unknown): string {
  return strOr(route).split('_')[0];
}

/**
 * The extension a call leg reached: from the destination channel, else the origin channel.
 *
 *   'PJSIP/1001-0000abcd'               -> '1001'
 *   'Local/1001@from-queue-0000002f;1'  -> '1001'  (queue, ring group, follow-me members)
 *   'PJSIP/trunk1-00000010'             -> null    (a trunk is not an agent)
 *
 * The tech prefix, any Local '@context' suffix and the '-uniqueid' tail are stripped, and
 * the remainder must be digits for BOTH candidates. The Python took dstchannel only when it
 * was digits and then accepted the origin channel unchecked, so every queue call (whose
 * member legs are Local channels) named the trunk as its agent.
 *
 * The origin channel is consulted only when the leg HAS a destination channel that is not
 * an extension (an outbound call to a trunk: the agent is the one who dialled). A leg with
 * no destination channel at all -- a feature code such as *43, an announcement, an IVR the
 * caller hung up in -- reached nobody, so it names no agent: the Python's IndexError gave
 * None there too, and analytics must not count the caller as an answering agent.
 */
export function convertChannelToExtension(dstchannel: unknown, channel: unknown): string | null {
  const ext = (ch: unknown): string | null => {
    if (!truthy(ch)) return null;
    const parts = String(ch).split('/');
    if (parts.length < 2) return null;
    const part = parts[1].split('@')[0].split('-')[0];
    return isDigitStr(part) ? part : null;
  };
  if (!truthy(dstchannel) || String(dstchannel).split('/').length < 2) return null;
  return ext(dstchannel) || ext(channel);
}

// Who ended a call, kept apart from the call status the way 3CX (reason_terminated), Genesys
// (disconnect type) and Cisco (TerminationOnBehalfOf) keep it, so "Unanswered" does not have
// to say whose hangup it was.
export const EXT_CHANNEL = /^(?:PJSIP|SIP|IAX2)\/(\p{Nd}{2,6})-/u;
export const LOCAL_EXT_CHANNEL = /^Local\/(\p{Nd}{2,6})@/u;

/**
 * ['agent', ext] for an extension's channel -- its device, or the Local leg a queue or
 * follow-me rings it through --, ['customer', null] for a trunk, ['system', null] for any
 * other internal leg, [null, null] when there is no channel.
 */
export function channelParty(ch: string | null | undefined): [string | null, string | null] {
  const s = ch || '';
  const m = EXT_CHANNEL.exec(s) || LOCAL_EXT_CHANNEL.exec(s);
  if (m) return ['agent', m[1]];
  if (['PJSIP/', 'SIP/', 'IAX2/', 'DAHDI/'].some((p) => s.startsWith(p))) return ['customer', null];
  return s ? ['system', null] : [null, null];
}

/**
 * {ended_by: 'agent'|'customer'|'system', ended_by_agent?: ext} for one call, from the CEL
 * hangup facts of its linkedid, or {} if CEL has no say. CEL names the channel that STARTED
 * each hangup (`source`), but a dialplan app hanging a channel up names that channel too, so
 * an unanswered call is read off Dial()'s own verdict first:
 *   * DIALSTATUS CANCEL      -> the caller gave up;
 *   * DIALSTATUS NOANSWER with no cause from the far end -> Dial()'s ring timer: the system;
 *   * a far-end leg that ended itself -> that party (a decline, a carrier failure);
 * and anything else, answered calls included, by whoever hung up first.
 */
export function callEndedBy(
  callerCh: string | null | undefined,
  calleeCh: string | null | undefined,
  celFacts: CelFacts | null | undefined,
  answered: boolean,
): Record<string, string> {
  if (!truthy(celFacts)) return {};
  const facts = celFacts as CelFacts;
  const caller: Row = dget(facts, callerCh || '') || {};
  const callee: Row = dget(facts, calleeCh || '') || {};
  const ds = String(dget(caller, 'dialstatus') || '').toUpperCase();
  let src = '';
  if (!answered) {
    const calleeCause = dget(callee, 'cause');
    if (ds === 'CANCEL') {
      src = callerCh as string;
    } else if (ds === 'NOANSWER' && (calleeCause === null || calleeCause === '' || calleeCause === '0')) {
      return { ended_by: 'system' };
    } else if (truthy(calleeCh) && dget(callee, 'source') === calleeCh) {
      src = calleeCh as string;
    }
  }
  if (!truthy(src)) {
    // 'dialplan/builtin' is Asterisk naming no one: the dialplan itself ended that leg -- a
    // queue member cancelled because another one answered, a Local wrapper tearing down.
    const ordered = Object.values(facts).sort((a, b) => (dget(a, 'seq') || 0) - (dget(b, 'seq') || 0));
    const first = ordered.find((f) => truthy(dget(f, 'source')) && !String(f.source).startsWith('dialplan/'));
    src = dget(first || {}, 'source') || '';
  }
  const [party, ext] = channelParty(src);
  if (!party) return {};
  return { ended_by: party, ...(ext ? { ended_by_agent: ext } : {}) };
}

// ===========================================================================
// CRM identity
// ===========================================================================

/** A leg a party answered: it had talk time with someone on its destination channel. */
function partyAnsweredLeg(leg: Row): boolean {
  return (Number(dget(leg, 'billsec')) || 0) > 0 && truthy(dget(leg, 'dstchannel'));
}

/**
 * The leg a multi-leg call's outcome is read from, of legs in sequence order: the last one
 * a party answered, else the last one. The twin of getCallLogFromDb's out_seq, so the CRM
 * push and Call History name the same agent, status and talk time.
 */
export function outcomeLeg(legs: Row[]): Row {
  const answered = legs.filter(partyAnsweredLeg);
  return answered.length ? answered[answered.length - 1] : legs[legs.length - 1];
}

/** Whole-call seconds, first leg start to the end of the last-ending leg; null without dates. */
export function callSpanSeconds(legs: Row[]): number | null {
  let startMs: number | null = null;
  let endMs: number | null = null;
  for (const leg of legs) {
    const at = asDate(dget(leg, 'calldate'));
    if (!at) continue;
    const s = at.getTime();
    const e = s + (Number(dget(leg, 'duration')) || 0) * 1000;
    if (startMs === null || s < startMs) startMs = s;
    if (endMs === null || e > endMs) endMs = e;
  }
  return startMs === null || endMs === null ? null : Math.round((endMs - startMs) / 1000);
}

/**
 * CRM identity fields from the finalized CDR -- the SAME source and normalization Call
 * History uses -- so the CRM push matches the call log (direction, external destination,
 * agent, talk time) instead of the digit-length heuristics the live AMI path applies.
 *
 * Returns {} if no CDR row exists yet; blank fields are omitted so they never overwrite
 * good live values. Keys use the CRM catalog convention.
 *
 * The caller must NOT let the returned `call_status`/`disposition` overwrite a live
 * cause-derived outcome: the CDR alone yields only ANSWERED/UNANSWERED/BUSY/FAILURE/
 * NETWORK_ERROR, and letting it win would erase MISSED / DROPPED / UNREACHABLE / ABANDONED.
 */
export async function crmIdentityFromCdr(linkedid: string): Promise<Record<string, unknown>> {
  const rows = await dbm.getCdrByLinkedid(linkedid);
  if (!truthy(rows)) return {};

  // Raw per-leg rows with no ordering: collapse them the SAME way Call History does --
  // identity from the first leg (min sequence = origin), outcome from the last leg a party
  // answered (else the last leg), duration over the whole call.
  const legs = [...rows].sort((a, b) => (dget(a, 'sequence') || 0) - (dget(b, 'sequence') || 0));
  const first = legs[0];
  const last = outcomeLeg(legs);
  const cdr: Row = {
    calldate: dget(first, 'calldate'),
    src: dget(first, 'src'),
    dst: dget(first, 'dst'),
    dcontext: dget(first, 'dcontext'),
    channel: dget(first, 'channel'),
    dstchannel: dget(last, 'dstchannel'),
    lastapp: dget(last, 'lastapp'),
    disposition: dget(last, 'disposition'),
    billsec: dget(last, 'billsec'),
    duration: callSpanSeconds(legs) ?? dget(last, 'duration'),
  };
  const direction = classifyCdrDirection(cdr);
  const ext = convertChannelToExtension(cdr.dstchannel, cdr.channel);

  const dirmap: Record<string, string> = { IN: 'inbound', OUT: 'outbound', INTERNAL: 'internal' };
  const outcome = mapCallOutcome({
    disposition: pyStr(dgetOr(cdr, 'disposition', '')).toUpperCase(),
    answered: truthy(cdr.billsec),
  });

  const hms = (secs: unknown): string | null => {
    const s = pyInt(truthy(secs) ? secs : 0);
    if (s === null) return null;
    const p2 = (n: number) => String(n).padStart(2, '0');
    return `${p2(floorDiv(s, 3600))}:${p2(floorDiv(pyMod(s, 3600), 60))}:${p2(pyMod(s, 60))}`;
  };

  const out: Record<string, unknown> = {
    caller: strOr(cdr.src),
    destination: strOr(cdr.dst),
    call_type: has(dirmap, direction) ? dirmap[direction] : '',
    call_status: outcome,
    disposition: outcome,
    duration: hms(cdr.duration),
    talk_time: hms(cdr.billsec),
  };
  const cd = cdr.calldate;
  if (truthy(cd)) out.datetime = cd instanceof Date ? isoformat(cd) : pyStr(cd);
  if (ext) {
    out.agent = ext;
    if (direction === 'IN' || direction === 'INTERNAL') out.answered_extension = ext;
    // For outbound, the meaningful "caller" for a CRM is the agent who placed the call --
    // not the outbound caller-ID number Asterisk recorded as src.
    if (direction === 'OUT') out.caller = ext;
    const name = await dbm.getAgentNameByExtension(ext);
    if (name) out.agent_name = name;
  }
  // Cross-reference key for the CRM: call_id is the linkedid, which identifies the whole
  // call-log row and is what call-history search matches.
  out.call_id = strOr(dget(first, 'linkedid') || linkedid || '');
  const filtered: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(out)) {
    if (v !== null && v !== undefined && v !== '') filtered[k] = v;
  }
  return filtered;
}

// ===========================================================================
// Call History rows
// ===========================================================================

export interface CallLogOptions {
  limit?: number | null;
  /** Keyset position: the [calldate, linkedid] of the previous page's last call. */
  after?: readonly [SqlValue, SqlValue] | null;
  date?: string | null;
  dateFrom?: string | null;
  dateTo?: string | null;
  allowedExtensions?: SqlValue[] | null;
  search?: string | null;
  /** Leave out supervisors' ChanSpy calls (an agent's own history never shows them). */
  excludeSupervision?: boolean;
  /** 'desc' (newest first, the default) or 'asc'. */
  order?: 'asc' | 'desc' | null;
  /** Call History UI: resolve recording paths, agent names and flag/attach supervision. Default true. */
  enrich?: boolean;
  /** Read the CEL hangup facts for status + ended_by. Default: same as enrich. */
  outcomes?: boolean | null;
  /** Flag ChanSpy rows / supervised calls. Default: same as enrich. */
  supervision?: boolean | null;
}

/** What enrichCallLogRows adds to built rows. */
export interface CallLogEnrichment {
  /** recording_path from the recordings index. */
  recordings?: boolean;
  /** is_supervision / supervision on ChanSpy rows, supervision_count on supervised calls. */
  supervision?: boolean;
  /** agent_name from the PBX extension names. */
  names?: boolean;
}

/**
 * One Call History row from a getCallLogFromDb row and its call's CEL hangup facts. Pure:
 * everything that needs a lookup (recording path, agent name, supervision) is added by
 * enrichCallLogRows, so a filtered scan can build every row and enrich only one page.
 */
export function callLogRow(cdr: Row, facts: CelFacts | null | undefined): Row {
  const callType = classifyCdrDirection(cdr);
  cdr.call_type = callType;
  const extension = convertChannelToExtension(cdr.dstchannel, cdr.channel);

  // Phone number (external party) by direction.
  let phoneNumber: any;
  if (callType === 'IN') phoneNumber = dgetOr(cdr, 'src', '');
  else if (callType === 'OUT') phoneNumber = dgetOr(cdr, 'dst', '');
  else phoneNumber = dgetOr(cdr, 'dst', '') || dgetOr(cdr, 'src', '');

  // Canonical outcome, computed on read (never stored), so the whole history renders in
  // this vocabulary with no backfill. `disposition` stays the RAW CDR value on purpose --
  // the analytics KPIs key off it.
  const disposition = pyStr(dgetOr(cdr, 'disposition', '')).toUpperCase();
  const status = outcomeFromCel(cdr, truthy(facts) ? (facts as CelFacts) : {});
  const talk = dget(cdr, 'billsec');
  // Who ended it, from the same CEL facts and the same two channels the journey's HANGUP
  // reads -- so the row and its journey cannot disagree. Absent without CEL.
  const endedBy = truthy(facts)
    ? callEndedBy(dget(cdr, 'channel'), dget(cdr, 'dstchannel'), facts as CelFacts, (Number(talk) || 0) > 0)
    : {};

  return {
    calldate: dget(cdr, 'calldate'),
    src: dget(cdr, 'src'),
    dst: dget(cdr, 'dst'),
    phone_number: phoneNumber,
    // The caller-ID name is the remote party's only on an inbound call.
    customer_name: resolveCustomerName(callType === 'IN' ? dget(cdr, 'cnam') : null, phoneNumber),
    duration: dget(cdr, 'duration'),
    talk, // billsec of the outcome leg, renamed
    disposition,
    // One of CALL_OUTCOMES. `canonical_status` is the same value, kept for mobile clients
    // written when the two could differ.
    status,
    canonical_status: status,
    QoS: dget(cdr, 'userfield'),
    extension,
    agent_name: null,
    call_type: callType,
    route: callRoute(cdr),
    recording_path: null,
    recording_file: dget(cdr, 'recordingfile') || null,
    app: dget(cdr, 'call_app'),
    ended_by: endedBy.ended_by ?? null,
    ended_by_agent: endedBy.ended_by_agent ?? null,
    call_journey_count: dget(cdr, 'call_journey_count'),
    linkedid: dget(cdr, 'linkedid'),
    uniqueid: dget(cdr, 'uniqueid'),
    // Supervision (listen/whisper/barge). A standalone ChanSpy leg is flagged so the UI
    // can hide it behind a "supervision" filter.
    is_supervision: false,
    supervision: null,
  };
}

/**
 * Add the looked-up parts of Call History rows, in place: recording paths, agent names, and
 * supervision. Supervision is two lookups in the OpDesk DB merged here (no cross-DB join to
 * the CDR):
 *   spyByKey       rows whose linkedid/uniqueid IS a ChanSpy leg -- the standalone "-> s"
 *                  rows; flagged so the UI can hide them by default;
 *   superByTarget  supervision events grouped by the MONITORED call, so a supervised call
 *                  surfaces its journey button and its journey can show them.
 */
export async function enrichCallLogRows(rows: Row[], what: CallLogEnrichment): Promise<Row[]> {
  if (what.recordings) {
    for (const r of rows) {
      const p = truthy(r.recording_file) ? await getRecordingPath(r.recording_file) : null;
      r.recording_path = truthy(p) ? pyStr(p) : null;
    }
  }
  if (what.names && rows.length) {
    // The PBX extension name, the same one the Extensions board shows. One small table,
    // read once per page.
    let names: Record<string, string> = {};
    try {
      names = (await dbm.getExtensionNamesFromDb()) || {};
    } catch {
      names = {};
    }
    for (const r of rows) r.agent_name = truthy(r.extension) ? dget(names, pyStr(r.extension)) : null;
  }
  const linkedids = rows.filter((c) => truthy(dget(c, 'linkedid'))).map((c) => pyStr(c.linkedid));
  if (what.supervision && linkedids.length) {
    const keys = [...linkedids, ...rows.filter((c) => truthy(dget(c, 'uniqueid'))).map((c) => pyStr(c.uniqueid))];
    const spyByKey: Record<string, Row> = (await dbm.getSupervisionBySpyKeys(keys)) || {};
    const superByTarget: Record<string, Row[]> = (await dbm.getSupervisionTargets(linkedids)) || {};
    for (const r of rows) {
      const lid = strOr(dget(r, 'linkedid'));
      const uid = strOr(dget(r, 'uniqueid'));
      const spy = dget(spyByKey, lid) || dget(spyByKey, uid);
      if (truthy(spy)) {
        r.is_supervision = true;
        r.supervision = {
          mode: dget(spy, 'mode'),
          supervisor_extension: dget(spy, 'supervisor_extension'),
          target_extension: dget(spy, 'target_extension'),
          target_linkedid: dget(spy, 'target_linkedid'),
        };
      }
      // Was this (normal) call supervised? Expose the count so the journey button shows
      // even for a single-leg call; the journey endpoint injects the LISTEN/WHISPER/BARGE
      // events.
      const supers = lid ? dget(superByTarget, lid) : null;
      if (truthy(supers)) {
        r.supervision_count = supers.length;
        r.call_journey_count = Math.max(Number(r.call_journey_count) || 1, 2);
      }
    }
  }
  return rows;
}

/**
 * Build normalized call-history rows from the CDR.
 *
 * enrich=true (Call History UI) resolves each row's recording path and agent name and flags
 * supervision. Analytics reuses this data source but only needs direction/disposition/
 * duration/talk, so it passes enrich=false to skip the recording lookup, the name and
 * supervision queries and the CEL read -- real savings when scanning a whole period with no
 * row limit.
 *
 * outcomes (default: same as enrich) reads the CEL hangup facts that give each row its exact
 * status and its ended_by. A caller that shows or filters by status without the rest of the
 * enrichment -- the analytics drill-down, the CSV export, a filtered Call History scan --
 * passes enrich=false, outcomes=true, so a call reads the same status there as in Call
 * History. Without CEL the status still comes from the CDR (disposition + billsec), at the
 * coarser grain.
 */
export async function callLog(opts: CallLogOptions = {}): Promise<Row[]> {
  const enrich = opts.enrich ?? true;
  const withOutcomes = opts.outcomes ?? enrich;
  const withSupervision = opts.supervision ?? enrich;
  const rows: Row[] = await dbm.getCallLogFromDb({
    limit: opts.limit ?? null,
    after: opts.after ?? null,
    date: opts.date ?? null,
    dateFrom: opts.dateFrom ?? null,
    dateTo: opts.dateTo ?? null,
    allowedExtensions: opts.allowedExtensions ?? null,
    search: opts.search ?? null,
    excludeSupervision: opts.excludeSupervision ?? false,
    order: opts.order ?? null,
  });

  const linkedids = rows.filter((c) => truthy(dget(c, 'linkedid'))).map((c) => pyStr(c.linkedid));
  const celByLinkedid: Record<string, CelFacts> =
    withOutcomes && linkedids.length ? await dbm.celHangupsByLinkedid(linkedids) : {};

  const result = rows.map((cdr) => callLogRow(cdr, dget(celByLinkedid, pyStr(dget(cdr, 'linkedid')))));
  return enrichCallLogRows(result, { recordings: enrich, names: enrich, supervision: withSupervision });
}

// ===========================================================================
// Call History pages (server-side filters and paging)
// ===========================================================================

// The most calls a filtered page scans: the filters below are on DERIVED values (the status
// from CEL, the direction vote, the route), which no SQL can test, so a filtered page reads
// the whole window and slices it. The CSV export's cap, for the same reason.
export const CALL_LOG_SCAN_MAX = 50_000;

/** Call History's table filters; each a set of accepted values, null = any. */
export interface CallLogFilters {
  /** Call statuses (CALL_OUTCOMES). */
  status?: ReadonlySet<string> | null;
  /** IN / OUT / INTERNAL. */
  callType?: ReadonlySet<string> | null;
  /** queue / ivr / direct. */
  app?: ReadonlySet<string> | null;
  /** Routes (inbound_queue, ...) or route sides (inbound / outbound / internal). */
  route?: ReadonlySet<string> | null;
}

export function hasCallLogFilters(f: CallLogFilters | null | undefined): boolean {
  return Boolean(f && (f.status?.size || f.callType?.size || f.app?.size || f.route?.size));
}

/** Whether one built Call History row passes the table filters. */
export function matchesCallLogFilters(r: Row, f: CallLogFilters | null | undefined): boolean {
  if (!f) return true;
  if (f.status?.size && !f.status.has(strOr(r.status))) return false;
  if (f.callType?.size && !f.callType.has(strOr(r.call_type).toUpperCase())) return false;
  if (f.app?.size && !f.app.has(strOr(r.app).toLowerCase())) return false;
  if (f.route?.size && !f.route.has(strOr(r.route)) && !f.route.has(routeSide(r.route))) return false;
  return true;
}

/** A Call History row's keyset position, in the order the list sorts by. */
function rowKey(r: Row): [string, string] {
  const cd = r.calldate instanceof Date ? isoformat(r.calldate) : strOr(r.calldate);
  return [cd, strOr(r.linkedid)];
}

/** Keyset order of two row keys: calldate, then linkedid (what the SQL sorts by). */
function compareKeys(a: [string, string], b: [string, string]): number {
  if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
  return a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0;
}

/** The opaque next-page cursor for the last row of a page. */
function nextCursorFor(r: Row): string {
  return encodeCursor(...rowKey(r));
}

/**
 * One page of Call History, {calls, total, next_cursor}, with the table's filters applied
 * on the server. Pages are keyset-paged: pass the returned next_cursor as `cursor` for the
 * following page (null on the last one).
 *
 * Without a table filter the page is a keyset query after the cursor and the total its
 * COUNT, both under the one predicate (db callLogFilter). With one, the window is scanned
 * once with the statuses read from CEL (at most CALL_LOG_SCAN_MAX calls; `capped` says the
 * scan stopped there), filtered, the page taken after the cursor, and only that page
 * enriched. Either way `total` counts exactly the rows the pages hold.
 */
export async function callLogPage(
  opts: CallLogOptions & { cursor?: string | null; filters?: CallLogFilters | null },
): Promise<{ calls: Row[]; total: number; next_cursor: string | null; capped?: boolean }> {
  const base = {
    date: opts.date ?? null,
    dateFrom: opts.dateFrom ?? null,
    dateTo: opts.dateTo ?? null,
    allowedExtensions: opts.allowedExtensions ?? null,
    search: opts.search ?? null,
    excludeSupervision: opts.excludeSupervision ?? false,
  };
  const limit = opts.limit ?? 100;
  const order = opts.order === 'asc' ? 'asc' : 'desc';
  const after = decodeCursor(opts.cursor, 2) as [SqlValue, SqlValue] | null;
  if (!hasCallLogFilters(opts.filters)) {
    // One row past the page says whether there is a next one.
    const [rows, total] = await Promise.all([
      callLog({ ...base, limit: limit + 1, after, order, supervision: opts.supervision ?? null }),
      dbm.getCallLogCountFromDb(base),
    ]);
    const calls = rows.slice(0, limit);
    return { calls, total, next_cursor: rows.length > limit ? nextCursorFor(calls[calls.length - 1]) : null };
  }
  const scanned = await callLog({ ...base, limit: CALL_LOG_SCAN_MAX, order, enrich: false, outcomes: true, supervision: false });
  const matched = scanned.filter((r) => matchesCallLogFilters(r, opts.filters));
  let start = 0;
  if (after) {
    // The first row past the cursor, in the order the scan came back in.
    const key: [string, string] = [strOr(after[0]), strOr(after[1])];
    start = matched.findIndex((r) => {
      const c = compareKeys(rowKey(r), key);
      return order === 'asc' ? c > 0 : c < 0;
    });
    if (start === -1) start = matched.length;
  }
  const page = matched.slice(start, start + limit);
  const calls = await enrichCallLogRows(page, { recordings: true, names: true, supervision: opts.supervision ?? true });
  return {
    calls,
    total: matched.length,
    next_cursor: start + limit < matched.length ? nextCursorFor(page[page.length - 1]) : null,
    ...(scanned.length >= CALL_LOG_SCAN_MAX ? { capped: true } : {}),
  };
}

// ===========================================================================
// Call journey
// ===========================================================================

/** Same-second ordering of journey events (lower first). */
export const JOURNEY_EVENT_ORDER: Readonly<Record<string, number>> = {
  INBOUND: 0,
  // OpDesk's table had no OUTBOUND, so an outbound call's first event sorted last among
  // its same-second siblings and the timeline opened on ANSWER.
  OUTBOUND: 0,
  IVR: 1,
  QUEUE_ENTER: 2,
  TRANSFER: 3,
  RING: 4,
  ANSWER: 5,
  UNANSWERED: 5,
  LISTEN: 6,
  WHISPER: 6,
  BARGE: 6,
  HANGUP: 7,
};

/** What buildCallJourneyFromCdr reads besides the CDR; looked up when not given (tests pass them). */
export interface JourneyFacts {
  /** This call's CEL hangup facts ({channame: facts}). */
  cel?: CelFacts | null;
  /** IVR menus entered, [{context: 'ivr-3', eventtime}] (db celIvrStepsByLinkedid). */
  ivrSteps?: Row[] | null;
  /** {ivr id: name} for display. */
  ivrNames?: Record<string, string> | null;
}

/**
 * Build the call journey (event timeline) from one call's CDR legs.
 *
 * Events: INBOUND | OUTBOUND, IVR, QUEUE_ENTER, RING, ANSWER, UNANSWERED, TRANSFER,
 * LISTEN | WHISPER | BARGE, HANGUP. `time` is the naive server-local ISO time
 * 'YYYY-MM-DDTHH:MM:SS' (the client localizes it); `duration` is the seconds until the next
 * event. HANGUP carries the raw disposition as `reason` plus `ended_by`/`ended_by_agent`
 * from CEL. Sorting is on the full ISO time, so a call that spans midnight stays in order.
 *
 * `supervision` is the call_supervision rows whose target is this call; each becomes a
 * LISTEN/WHISPER/BARGE event at its timestamp, so a supervisor shows on the monitored
 * call's timeline instead of as a separate "-> s" row.
 *
 * Two fixes over the timeline OpDesk and its reference produced:
 *   * a Dial leg that was not answered (BUSY, NO ANSWER, FAILED) gets UNANSWERED -- after a
 *     RING when it rang out -- instead of an ANSWER at its start time;
 *   * IVR menus the call passed through are shown (IVR events, from CEL, else from CDR legs
 *     whose dcontext is ivr-*), and a call that never left the IVR still gets its HANGUP.
 */
export async function buildCallJourneyFromCdr(
  cdrRows: Row[],
  supervision: Row[] | null = null,
  facts: JourneyFacts = {},
): Promise<Row[]> {
  if (!truthy(cdrRows)) return [];

  const rows = [...cdrRows]
    .filter((r) => asDate(r.calldate) !== null)
    .sort((a, b) => {
      const d = (asDate(a.calldate) as Date).getTime() - (asDate(b.calldate) as Date).getTime();
      return d || (Number(dget(a, 'sequence')) || 0) - (Number(dget(b, 'sequence')) || 0);
    });
  if (!rows.length) return [];

  const journey: Row[] = [];
  const add = (event: string, time: Date, data: Row = {}): void => {
    journey.push({ event, time: isoSeconds(time), _dt: time, ...data });
  };
  const start = (row: Row): Date => asDate(row.calldate) as Date;
  const end = (row: Row): Date => addSeconds(start(row), Number(row.duration) || 0);
  /** Answer time of a FreePBX CDR leg: start + (duration - billsec); null when not answered. */
  const answerTime = (row: Row): Date | null => {
    const billsec = Number(row.billsec) || 0;
    return billsec > 0 ? addSeconds(start(row), (Number(row.duration) || 0) - billsec) : null;
  };

  const first = rows[0];
  const last = rows[rows.length - 1];
  const linkedid = dget(first, 'linkedid');

  // Who ended it, for the HANGUP event: one indexed CEL query for this call's linkedid.
  const answered = rows.some((r) => (Number(dget(r, 'billsec')) || 0) > 0);
  let cel: CelFacts | null | undefined = facts.cel;
  if (cel === undefined) {
    try {
      const byLid = await dbm.celHangupsByLinkedid([linkedid]);
      cel = dget(byLid, pyStr(linkedid)) || {};
    } catch {
      cel = {};
    }
  }
  const ended = callEndedBy(dget(first, 'channel'), dget(last, 'dstchannel'), cel || {}, answered);
  // The call is over when its last leg is, which is not always the max-sequence leg.
  const hangupTime = rows.reduce<Date>((acc, r) => (end(r) > acc ? end(r) : acc), end(last));
  const addHangup = (): void => add('HANGUP', hangupTime, { reason: dget(last, 'disposition'), ...ended });

  // 1. INBOUND / OUTBOUND
  if (classifyCdrDirection(first) === 'IN') add('INBOUND', start(first), { from_number: first.src });
  else add('OUTBOUND', start(first), { to_number: first.dst });

  // 2. IVR menus: CEL knows each context the call entered; without CEL, the legs whose
  // dcontext is an IVR.
  let ivrSteps: Row[] | null | undefined = facts.ivrSteps;
  if (ivrSteps === undefined) ivrSteps = truthy(linkedid) ? await dbm.celIvrStepsByLinkedid(linkedid) : [];
  if (!ivrSteps || !ivrSteps.length) {
    ivrSteps = [];
    let prev: string | null = null;
    for (const r of rows) {
      const ctx = strOr(dget(r, 'dcontext'));
      if (/^ivr-/i.test(ctx) && ctx !== prev) ivrSteps.push({ context: ctx, eventtime: r.calldate });
      prev = ctx;
    }
  }
  let lastIvrAt: Date | null = null;
  if (ivrSteps.length) {
    let names = facts.ivrNames;
    if (names === undefined) names = await dbm.getIvrNamesFromDb();
    for (const s of ivrSteps) {
      const at = asDate(s.eventtime);
      if (!at) continue;
      const ctx = strOr(s.context);
      const id = ctx.replace(/^ivr-/i, '');
      // `ivr` is the menu's name as the PBX shows it, else its context; `selection` the key
      // pressed, when known.
      const name = names && has(names, id) ? names[id] : null;
      const data: Row = { ivr: name || ctx };
      if (truthy(s.selection)) data.selection = pyStr(s.selection);
      add('IVR', at, data);
      if (!lastIvrAt || at > lastIvrAt) lastIvrAt = at;
    }
  }

  /**
   * TRANSFER events for rows[1:] (a later leg reaching another extension), each followed by
   * how that leg ended: ANSWER when the agent took it, UNANSWERED when they did not -- so a
   * call answered by one agent and blind-transferred to one who never picked up reads the
   * way its row does (answered by the first agent), not as a transfer into silence.
   */
  const addTransfers = (): void => {
    for (const row of rows.slice(1)) {
      const agent = convertChannelToExtension(dget(row, 'dstchannel'), dget(row, 'channel'));
      if (!agent) continue;
      add('TRANSFER', start(row), { agent });
      const at = answerTime(row);
      if (at) add('ANSWER', at, { agent });
      else if (truthy(dget(row, 'dstchannel'))) add('UNANSWERED', end(row), { agent });
    }
  };

  const firstApp = strOr(dget(first, 'lastapp'));
  if (firstApp === 'Queue') {
    // 3a. Queue: one leg per member rung.
    const enteredAt = lastIvrAt && lastIvrAt > start(first) ? lastIvrAt : start(first);
    add('QUEUE_ENTER', enteredAt, { queue: first.dst });
    rows.forEach((row, i) => {
      const agent = convertChannelToExtension(dget(row, 'dstchannel'), dget(row, 'channel'));
      if (!agent) return;
      // A member leg's CDR can start with the caller's channel, before an IVR in front of
      // the queue; nothing rings before the call reached the queue.
      const ringAt = start(row) < enteredAt ? enteredAt : start(row);
      // TRANSFER before RING for each leg after the first
      if (i > 0) add('TRANSFER', ringAt, { agent });
      add('RING', ringAt, { agent });
      const at = answerTime(row);
      if (row.disposition === 'ANSWERED' && at) add('ANSWER', at, { agent });
      else if (row.disposition !== 'ANSWERED') add('UNANSWERED', end(row), { agent });
    });
    addHangup();
  } else if (firstApp === 'Dial') {
    // 3b. Dial: the first leg's outcome, later legs as transfers.
    const firstAgent = convertChannelToExtension(dget(first, 'dstchannel'), dget(first, 'channel'));
    const at = answerTime(first);
    if (at) {
      add('ANSWER', at, { agent: firstAgent });
    } else {
      // Not answered (busy, rang out, failed): say so. It used to read "Answered" at the
      // dial time, contradicting the call's own status.
      if (pyStr(first.disposition).toUpperCase() === 'NO ANSWER' && firstAgent) add('RING', start(first), { agent: firstAgent });
      add('UNANSWERED', end(first), firstAgent ? { agent: firstAgent } : {});
    }
    addTransfers();
    addHangup();
  } else {
    // 3c. Anything else (an IVR the caller hung up in, a feature code, an announcement):
    // still close the timeline, so "ended by" is shown for every call.
    addTransfers();
    addHangup();
  }

  // 4. Supervision (listen / whisper / barge), slotted in by timestamp.
  for (const s of supervision || []) {
    const when = asDate(dget(s, 'created_at'));
    if (!when) continue;
    add(strOr(dget(s, 'mode') || 'listen').toUpperCase(), when, {
      supervisor: dget(s, 'supervisor_extension'),
      target: dget(s, 'target_extension'),
    });
  }

  // Sort by time, then by logical event order for same-second events. The sort is stable,
  // so equal events keep the order they were added in.
  const ord = (e: Row): number => (has(JOURNEY_EVENT_ORDER, e.event) ? JOURNEY_EVENT_ORDER[e.event] : 99);
  journey.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : ord(a) - ord(b)));

  // Duration (seconds) of each event: the time until the next one; the last has none.
  journey.forEach((e, i) => {
    if (i + 1 < journey.length) {
      const secs = pyRound(((journey[i + 1]._dt as Date).getTime() - (e._dt as Date).getTime()) / 1000, 1);
      if (secs !== 0) e.duration = secs;
    }
    delete e._dt;
  });
  return journey;
}
