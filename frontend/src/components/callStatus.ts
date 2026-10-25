import type { TFunction } from 'i18next';

/**
 * How one call outcome presents itself: its colour, its label, its order.
 *
 * ONE vocabulary for the whole product, keyed on OpDesk's canonical outcomes
 * (backend/call_log.py CALL_OUTCOMES, plus the call log's `in_progress`). Call History,
 * its filters, the notification bell, the Analytics drill-down and the Outbound card's
 * breakdown all render outcomes through this file, so an outcome is the same word and the
 * same colour on every screen.
 *
 * The raw spellings that still reach the UI are folded onto the canonical value by
 * `canonicalCallStatus`: CDR dispositions ('NO ANSWER', 'FAILED') in Analytics, and the
 * bell's lowercase notification reasons ('no_answer', 'busy', 'failed').
 *
 * Colours follow the scheme in styles/variables.css: green = answered, amber = the callee did
 * not take it, burnt = the call could not be placed, red = picked up but never reached a
 * person.
 */
export interface CallStatusMeta {
  /** Foreground colour token. */
  color: string;
  /** Badge background, the same token at low alpha. */
  bg: string;
  labelKey: string;
  fallback: string;
}

export const CALL_STATUS_META: Record<string, CallStatusMeta> = {
  ANSWERED:     { color: 'var(--accent-success)', bg: 'rgb(var(--accent-success-rgb) / .12)', labelKey: 'callStatus.ANSWERED',     fallback: 'Answered' },
  NO_ANSWER:    { color: 'var(--accent-warning)', bg: 'rgb(var(--accent-warning-rgb) / .12)', labelKey: 'callStatus.NO_ANSWER',    fallback: 'No answer' },
  BUSY:         { color: 'var(--accent-warning)', bg: 'rgb(var(--accent-warning-rgb) / .12)', labelKey: 'callStatus.BUSY',         fallback: 'Busy' },
  FAILURE:      { color: 'var(--accent-fault)',   bg: 'rgb(var(--accent-fault-rgb) / .12)',   labelKey: 'callStatus.FAILURE',      fallback: 'Failed' },
  ABANDONED:    { color: 'var(--accent-danger)',  bg: 'rgb(var(--accent-danger-rgb) / .12)',  labelKey: 'callStatus.ABANDONED',    fallback: 'Abandoned' },
  CANCELED:     { color: 'var(--text-secondary)', bg: 'rgb(var(--text-muted-rgb) / .12)',     labelKey: 'callStatus.CANCELED',     fallback: 'Canceled' },
  DROPPED:      { color: 'var(--status-dropped)', bg: 'rgb(var(--status-dropped-rgb) / .12)', labelKey: 'callStatus.DROPPED',      fallback: 'Dropped' },
  OUT_OF_REACH: { color: 'var(--text-muted)',     bg: 'rgb(var(--text-muted-rgb) / .12)',     labelKey: 'callStatus.OUT_OF_REACH', fallback: 'Out of reach' },
  IN_PROGRESS:  { color: 'var(--accent-primary)', bg: 'rgb(var(--accent-primary-rgb) / .12)', labelKey: 'callStatus.IN_PROGRESS',  fallback: 'In progress' },
};

/** What anything outside the vocabulary wears: muted, and labelled with its own raw text. */
export const UNKNOWN_STATUS_STYLE = { color: 'var(--text-muted)', bg: 'rgb(var(--text-muted-rgb) / .12)' };

/** The outcomes in reading order: the one everybody wants first, then the callee's verdicts,
 *  then the ones about the call itself. Filters follow it. */
export const CALL_STATUS_ORDER: string[] = [
  'ANSWERED', 'NO_ANSWER', 'BUSY', 'FAILURE', 'ABANDONED', 'CANCELED', 'DROPPED', 'OUT_OF_REACH', 'IN_PROGRESS',
];

/** Raw spellings of the same outcomes: CDR dispositions, Dialstatus, notification reasons. */
const ALIASES: Record<string, string> = {
  NOANSWER: 'NO_ANSWER',
  FAILED: 'FAILURE',
  CONGESTION: 'FAILURE',
  CHANUNAVAIL: 'FAILURE',
  CANCEL: 'CANCELED',
};

/** The canonical outcome for any spelling of it, or the input upper-cased when it is not one. */
export function canonicalCallStatus(status: string): string {
  const s = String(status).trim().toUpperCase().replace(/\s+/g, '_');
  return ALIASES[s.replace(/_/g, '')] ?? ALIASES[s] ?? s;
}

/** The outcome's meta, whatever spelling it arrives in, or undefined when it is not one. */
export function callStatusMeta(status: string | null | undefined): CallStatusMeta | undefined {
  return status ? CALL_STATUS_META[canonicalCallStatus(status)] : undefined;
}

/** One outcome's translated label, falling back to the raw value for anything unmapped. */
export function callStatusLabel(t: TFunction, status: string): string {
  const meta = callStatusMeta(status);
  return meta ? t(meta.labelKey, meta.fallback) : status;
}

/** One outcome's colour, or the muted default for anything unmapped. */
export function callStatusColor(status: string): string {
  return callStatusMeta(status)?.color ?? UNKNOWN_STATUS_STYLE.color;
}
