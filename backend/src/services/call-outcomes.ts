/**
 * The call-status vocabulary: the ONE set of words for how a call ended, used by every API,
 * WebSocket event, the CRM push, the missed-call bell and the web app.
 *
 * Kept in a module of its own, with no imports, so every backend module can share it --
 * db/manager/call-log included, which services/call-log imports and so cannot import back.
 *
 * It replaces the eight-value set OpDesk used before (ANSWERED, NO_ANSWER, BUSY, FAILURE,
 * ABANDONED, CANCELED, DROPPED, OUT_OF_REACH) and the separate lowercase vocabulary the bell
 * stored (busy, noanswer, switched_off, failed, invalid_number, completed). Nothing writes
 * those any more; RETIRED_SPELLINGS maps them to today's word on read, so rows stored before
 * the change need no backfill.
 */

// ===========================================================================
// Canonical call-outcome vocabulary
// ===========================================================================
// Values are derived from Asterisk's Q.850 hangup cause + Dialstatus + whether the call was
// answered (see call-log.mapCallOutcome). Cause meanings per the Q.850 reference: 16 normal
// clearing, 17 busy, 18/19 no answer, 20 subscriber absent (phone off/unreachable), 21
// rejected, 28 invalid number format, 34 no circuit available.
// Each value answers one question: what happened to this call, in the words an operator
// would use. Where two of them differ only in WHO ended the call, that distinction is the
// whole point of having both.

/** a person picked up and there was talk time */
export const ANSWERED = 'ANSWERED';
/**
 * "Unanswered": the callee never picked up -- it rang out, the carrier gave up on the
 * ring, or, on an OUTBOUND call, our agent hung up before they did. WHO ended it is not
 * part of the status: Call Journey says so ("ended by"), the way 3CX pairs "Unanswered"
 * with reason_terminated and Genesys pairs the call result with its disconnect type.
 */
export const UNANSWERED = 'UNANSWERED';
/**
 * the callee did not take it and said so: their line was busy (Q.850 17) or they declined
 * it outright (21). One value for both, because from the operator's side they are one
 * fact -- the callee refused the call.
 */
export const BUSY = 'BUSY';
/**
 * WE missed it: the call came to our side and nobody here took it -- an inbound or
 * internal caller gave up while it rang. Never an outbound call our agent ended: that is
 * UNANSWERED, because the missed call is the customer's, not ours. Kept apart from
 * ABANDONED, which the abandon rate is computed from.
 */
export const MISSED = 'MISSED';
/** the callee did not pick up; their voicemail answered instead */
export const VOICEMAIL = 'VOICEMAIL';
/** the number is right, the phone is not there (off, out of coverage, unregistered) */
export const UNREACHABLE = 'UNREACHABLE';
/** the number is wrong -- unallocated, invalid format */
export const FAILURE = 'FAILURE';
/** number and phone are both fine; the network failed (congestion, no route, no circuit available) */
export const NETWORK_ERROR = 'NETWORK_ERROR';
/**
 * queue: the caller gave up before an agent answered. Kept apart from MISSED because the
 * abandon rate is computed from it (see analytics).
 */
export const ABANDONED = 'ABANDONED';
/** answered, then torn down abnormally (network drop) */
export const DROPPED = 'DROPPED';

export const CALL_OUTCOMES: readonly string[] = [
  ANSWERED, UNANSWERED, BUSY, MISSED, VOICEMAIL,
  UNREACHABLE, FAILURE, NETWORK_ERROR, ABANDONED, DROPPED,
];

// The outcomes where the far end was really connected, so the call has real talk time.
export const TALKED_OUTCOMES: ReadonlySet<string> = new Set([ANSWERED, VOICEMAIL, DROPPED]);

// Every other spelling a call outcome has ever been stored or published under, mapped to the
// word that replaced it. CALL_OUTCOMES above is the ONE call-status vocabulary on every API,
// every WebSocket event and the CRM push, always in this UPPERCASE spelling. The table exists
// only so data written before that -- notification reasons, a CRM status remap an operator
// saved -- reads as today's word.
export const RETIRED_SPELLINGS: Readonly<Record<string, string>> = {
  DECLINED: BUSY, // cause 21; merged into BUSY
  CANCELED: MISSED, // OpDesk's word for a caller who gave up mid-ring
  CANCELLED: MISSED,
  OUT_OF_REACH: UNREACHABLE, // OpDesk's CRM push spelling
  NO_ANSWER: UNANSWERED, // OpDesk's name for this status
  NOANSWER: UNANSWERED, // the bell's stored 'noanswer'
  FAILED: FAILURE, // the bell's 'failed'
  MACHINE: VOICEMAIL,
  COMPLETED: ANSWERED, // the bell's 'completed'
  SWITCHED_OFF: UNREACHABLE, // the bell's 'switched_off'
  INVALID_NUMBER: FAILURE, // the bell's 'invalid_number'
};

/** `str(value or '')`: Python's str() of a truthy value (True -> 'True'), '' otherwise. */
export function strOrEmpty(value: unknown): string {
  if (value === null || value === undefined || value === false || value === 0 || value === '') return '';
  if (value === true) return 'True';
  return String(value);
}

/**
 * The call status for `value` in any spelling OpDesk has ever used -- one of CALL_OUTCOMES --
 * or null when it is not a call status at all (a blank, a free-text reason). The single
 * projection every API, event and payload goes through; see RETIRED_SPELLINGS.
 */
export function callStatus(value: unknown): string | null {
  let s = strOrEmpty(value).trim().toUpperCase();
  s = Object.prototype.hasOwnProperty.call(RETIRED_SPELLINGS, s) ? RETIRED_SPELLINGS[s] : s;
  return CALL_OUTCOMES.includes(s) ? s : null;
}

/**
 * The outcomes the missed-call bell notifies on (the agent's phone rang, or was meant to,
 * and the call did not connect). MISSED is included on purpose -- the caller gave up while
 * the agent's phone rang, which is exactly what the bell is for; VOICEMAIL and ABANDONED
 * are not (the caller was looked after, or the queue's own report covers it).
 */
export const NOTIFY_OUTCOMES: ReadonlySet<string> = new Set([
  BUSY, UNANSWERED, MISSED, UNREACHABLE, FAILURE, NETWORK_ERROR,
]);
