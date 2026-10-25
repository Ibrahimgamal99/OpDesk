import type { TFunction } from 'i18next';

/**
 * How one call status presents itself: its colour, its label, its order.
 *
 * ONE vocabulary for the whole product. Call history, the Auto Dialer's lead grid, the
 * Dashboard's Campaign Performance tab, analytics drill-downs, missed-call notifications and
 * the CRM outcome mapping all receive the same ten UPPERCASE values from the backend
 * (backend/src/services/call-log.ts CALL_OUTCOMES) and all render them through this file, so a status is the
 * same word and the same colour on every screen. Nothing retired (DECLINED, CANCELED,
 * OUT_OF_REACH, the dialer's old lowercase spellings) is sent any more, so nothing here maps it.
 *
 * Colours follow the scheme documented in styles/variables.css, so the warm band spreads by
 * verdict rather than crowding onto one red: rose = nobody took it (MISSED), red = picked up
 * but never reached a person (ABANDONED), burnt = the call could not be placed (FAILURE,
 * NETWORK_ERROR), amber = the callee did not take it (UNANSWERED, BUSY).
 *
 * This is only the per-call STATUS vocabulary. Campaign lifecycle states (draft/running/…), a
 * lead's own lifecycle (pending/exhausted/…) and agent/device presence (statusBadge.tsx) are
 * not call statuses and stay with the screens that show them.
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
  ANSWERED:      { color: 'var(--accent-success)', bg: 'rgb(var(--accent-success-rgb) / .12)', labelKey: 'callStatus.ANSWERED',      fallback: 'Answered' },
  UNANSWERED:     { color: 'var(--accent-warning)', bg: 'rgb(var(--accent-warning-rgb) / .12)', labelKey: 'callStatus.UNANSWERED',     fallback: 'Unanswered' },
  // A decline is BUSY too: the trunk reports the two identically, and the backend classifies
  // both as one status for that reason.
  BUSY:          { color: 'var(--accent-warning)', bg: 'rgb(var(--accent-warning-rgb) / .12)', labelKey: 'callStatus.BUSY',          fallback: 'Busy' },
  MISSED:        { color: 'var(--accent-missed)',  bg: 'rgb(var(--accent-missed-rgb) / .12)',  labelKey: 'callStatus.MISSED',        fallback: 'Missed' },
  VOICEMAIL:     { color: 'var(--text-secondary)', bg: 'rgb(var(--text-muted-rgb) / .12)',     labelKey: 'callStatus.VOICEMAIL',     fallback: 'Voicemail' },
  UNREACHABLE:   { color: 'var(--text-muted)',     bg: 'rgb(var(--text-muted-rgb) / .12)',     labelKey: 'callStatus.UNREACHABLE',   fallback: 'Unreachable' },
  FAILURE:       { color: 'var(--accent-fault)',   bg: 'rgb(var(--accent-fault-rgb) / .12)',   labelKey: 'callStatus.FAILURE',       fallback: 'Failure' },
  NETWORK_ERROR: { color: 'var(--accent-fault)',   bg: 'rgb(var(--accent-fault-rgb) / .12)',   labelKey: 'callStatus.NETWORK_ERROR', fallback: 'Network error' },
  ABANDONED:     { color: 'var(--accent-danger)',  bg: 'rgb(var(--accent-danger-rgb) / .12)',  labelKey: 'callStatus.ABANDONED',     fallback: 'Abandoned' },
  DROPPED:       { color: 'var(--status-dropped)', bg: 'rgb(var(--status-dropped-rgb) / .12)', labelKey: 'callStatus.DROPPED',       fallback: 'Dropped' },
};

/** What anything outside the vocabulary wears: muted, and labelled with its own raw text. */
export const UNKNOWN_STATUS_STYLE = { color: 'var(--text-muted)', bg: 'rgb(var(--text-muted-rgb) / .12)' };

/**
 * The statuses in reading order: the one everybody wants first, then the callee's verdicts,
 * then the ones about the call itself. Filters, chart series, outcome tables and the CRM
 * mapping all follow it, so the same status sits in the same place everywhere.
 */
export const CALL_STATUS_ORDER: string[] = [
  'ANSWERED', 'UNANSWERED', 'BUSY', 'MISSED', 'VOICEMAIL',
  'UNREACHABLE', 'FAILURE', 'NETWORK_ERROR', 'ABANDONED', 'DROPPED',
];

/**
 * The dialer's two retry settings that are not call statuses of their own. The engine acts on them
 * separately -- AGENT_NOANSWER re-rings the agents outside the customer's attempt cap; AGENT_HANGUP
 * redials a customer whose phone was still ringing when our agent gave up -- so the retry picker
 * names them apart, while every result they produce is reported as MISSED and UNANSWERED
 * (Unanswered) respectively.
 */
export const RETRY_PICKER_LABELS: Record<string, { labelKey: string; fallback: string }> = {
  AGENT_NOANSWER: { labelKey: 'callStatus.pickerAgentNoAnswer', fallback: 'Missed — agent never answered' },
  AGENT_HANGUP:   { labelKey: 'callStatus.pickerAgentHangup',   fallback: 'Unanswered — agent hung up while ringing' },
};

/** The status's meta, whatever case it arrives in, or undefined when it is not a call status. */
export function callStatusMeta(status: string | null | undefined): CallStatusMeta | undefined {
  return status ? CALL_STATUS_META[String(status).toUpperCase()] : undefined;
}

/** Whether a value is one of the ten call statuses (as opposed to a lifecycle state). */
export function isCallStatus(status: string | null | undefined): boolean {
  return callStatusMeta(status) !== undefined;
}

/** One status's translated label, falling back to the raw value for anything unmapped. */
export function callStatusLabel(t: TFunction, status: string): string {
  const meta = callStatusMeta(status);
  return meta ? t(meta.labelKey, meta.fallback) : status;
}

/** One status's colour, or the muted default for anything unmapped. */
export function callStatusColor(status: string): string {
  return callStatusMeta(status)?.color ?? UNKNOWN_STATUS_STYLE.color;
}

/** One status's badge colours, or the muted default for anything unmapped. */
export function callStatusStyle(status: string): { color: string; bg: string } {
  return callStatusMeta(status) ?? UNKNOWN_STATUS_STYLE;
}
