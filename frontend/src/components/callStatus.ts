import type { TFunction } from 'i18next';

/**
 * How one call status presents itself: its colour, its label, its tooltip, its order.
 *
 * ONE vocabulary for the whole product. Call History and its filters, the call journey,
 * the notification bell, the Analytics drill-down, the Outbound card's breakdown and the
 * CRM outcome mapping all receive the same ten UPPERCASE values from the backend
 * (services/call-outcomes.ts CALL_OUTCOMES) and render them through this file, so a status
 * is the same word and the same colour on every screen. The backend projects every retired
 * spelling (NO_ANSWER, CANCELED, OUT_OF_REACH, the bell's old lowercase reasons) onto these
 * ten before it answers, so nothing here maps them.
 *
 * Colours follow the scheme in styles/variables.css, so the warm band spreads by verdict
 * rather than crowding onto one red: rose = nobody took it (MISSED), red = picked up but
 * never reached a person (ABANDONED), burnt = the call could not be placed (FAILURE,
 * NETWORK_ERROR), amber = the callee did not take it (UNANSWERED, BUSY).
 *
 * This is only the per-call STATUS vocabulary. Live channel states (ringing, in call) and
 * agent presence (statusBadge.tsx) are not call statuses and stay with the screens that
 * show them.
 */
export interface CallStatusMeta {
  /** Foreground colour token. */
  color: string;
  /** Badge background, the same token at low alpha. */
  bg: string;
  labelKey: string;
  fallback: string;
  /** What the status means, for a tooltip. */
  tipKey: string;
  tipFallback: string;
}

const meta = (status: string, color: string, rgb: string, fallback: string, tipFallback: string): CallStatusMeta => ({
  color,
  bg: `rgb(var(${rgb}) / .12)`,
  labelKey: `callStatus.${status}`,
  fallback,
  tipKey: `callStatusTip.${status}`,
  tipFallback,
});

export const CALL_STATUS_META: Record<string, CallStatusMeta> = {
  ANSWERED:      meta('ANSWERED', 'var(--accent-success)', '--accent-success-rgb', 'Answered',
    'Someone picked up and the two sides talked.'),
  UNANSWERED:    meta('UNANSWERED', 'var(--accent-warning)', '--accent-warning-rgb', 'Unanswered',
    'It rang until it timed out, or our side gave up while it rang.'),
  // A decline is BUSY too: the network reports the two identically.
  BUSY:          meta('BUSY', 'var(--accent-warning)', '--accent-warning-rgb', 'Busy',
    'The callee was busy or declined the call.'),
  MISSED:        meta('MISSED', 'var(--accent-missed)', '--accent-missed-rgb', 'Missed',
    'The caller hung up while it was still ringing.'),
  VOICEMAIL:     meta('VOICEMAIL', 'var(--text-secondary)', '--text-muted-rgb', 'Voicemail',
    'Voicemail took the call.'),
  UNREACHABLE:   meta('UNREACHABLE', 'var(--text-muted)', '--text-muted-rgb', 'Unreachable',
    'The phone was switched off, unregistered or out of service.'),
  FAILURE:       meta('FAILURE', 'var(--accent-fault)', '--accent-fault-rgb', 'Failure',
    'The call could not be placed, for example a wrong number.'),
  NETWORK_ERROR: meta('NETWORK_ERROR', 'var(--accent-fault)', '--accent-fault-rgb', 'Network error',
    'The route or the carrier failed: congestion or no circuit.'),
  ABANDONED:     meta('ABANDONED', 'var(--accent-danger)', '--accent-danger-rgb', 'Abandoned',
    'The caller hung up while waiting in a queue.'),
  DROPPED:       meta('DROPPED', 'var(--status-dropped)', '--status-dropped-rgb', 'Dropped',
    'The call was answered, then cut off abnormally.'),
};

/** What anything outside the vocabulary wears: muted, and labelled with its own raw text. */
export const UNKNOWN_STATUS_STYLE = { color: 'var(--text-muted)', bg: 'rgb(var(--text-muted-rgb) / .12)' };

/**
 * The statuses in reading order: the one everybody wants first, then the callee's verdicts,
 * then the ones about the call itself. Filters, chart series and outcome tables follow it,
 * so the same status sits in the same place everywhere.
 */
export const CALL_STATUS_ORDER: string[] = [
  'ANSWERED', 'UNANSWERED', 'BUSY', 'MISSED', 'VOICEMAIL',
  'UNREACHABLE', 'FAILURE', 'NETWORK_ERROR', 'ABANDONED', 'DROPPED',
];

/** The status's meta, whatever case it arrives in, or undefined when it is not a call status. */
export function callStatusMeta(status: string | null | undefined): CallStatusMeta | undefined {
  return status ? CALL_STATUS_META[String(status).trim().toUpperCase()] : undefined;
}

/** Whether a value is one of the ten call statuses (as opposed to some other reason). */
export function isCallStatus(status: string | null | undefined): boolean {
  return callStatusMeta(status) !== undefined;
}

/** One status's translated label, falling back to the raw value for anything unmapped. */
export function callStatusLabel(t: TFunction, status: string): string {
  const m = callStatusMeta(status);
  return m ? t(m.labelKey, m.fallback) : status;
}

/** One status's translated explanation, or undefined for anything unmapped. */
export function callStatusTip(t: TFunction, status: string): string | undefined {
  const m = callStatusMeta(status);
  return m ? t(m.tipKey, m.tipFallback) : undefined;
}

/** One status's colour, or the muted default for anything unmapped. */
export function callStatusColor(status: string): string {
  return callStatusMeta(status)?.color ?? UNKNOWN_STATUS_STYLE.color;
}

/** One status's badge colours, or the muted default for anything unmapped. */
export function callStatusStyle(status: string): { color: string; bg: string } {
  return callStatusMeta(status) ?? UNKNOWN_STATUS_STYLE;
}

/** Rank of a status in CALL_STATUS_ORDER, anything unmapped after the ten. */
export function callStatusRank(status: string): number {
  const i = CALL_STATUS_ORDER.indexOf(String(status).trim().toUpperCase());
  return i < 0 ? CALL_STATUS_ORDER.length : i;
}
