import {
  Phone, PhoneIncoming, PhoneCall, PhoneOff, Pause,
  MinusCircle, CheckCircle2, LogOut, CircleDot, Clock,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { AgentState, ExtensionStatus } from '../types';
import { Badge } from './ui';

/**
 * Single source of truth for status presentation across the app. Agent presence
 * (login → Ready / logout → Offline / DND / pause → Not-Ready / On-Call / Wrap-up)
 * and plain-extension device status (Idle / Ringing / DND …) all resolve to a
 * StatusMeta and render through the one <StatusBadge> pill (the shared Badge).
 * Keeps ExtensionsPanel, AgentBoardPanel and AgentStatusHeader in sync.
 */
/** Agent presence, as the backend's agent-state manager reports it (`agent_states`). */
export type { AgentState };

export interface StatusMeta {
  /** color token, e.g. '--danger' */
  varName: string;
  /** background token, e.g. '--status-ringing-bg' */
  bgVar: string;
  /** i18n key */
  key: string;
  /** i18n fallback */
  fallback: string;
  /** lucide icon that represents this status */
  Icon: LucideIcon;
}

// Agent presence tokens. DND uses the danger color + the Slack/Teams-style
// minus-circle icon (business-comms "do not disturb", not the Apple moon).
export const AGENT_STATE_META: Record<AgentState, StatusMeta> = {
  ready:      { varName: '--status-idle',        bgVar: '--status-idle-bg',        key: 'agent.state.ready',     fallback: 'Ready',          Icon: CheckCircle2 },
  on_call:    { varName: '--status-call',        bgVar: '--status-call-bg',        key: 'agent.state.onCall',    fallback: 'On Call',        Icon: PhoneCall },
  wrap_up:    { varName: '--status-hold',        bgVar: '--status-hold-bg',        key: 'agent.state.wrapUp',    fallback: 'Wrap-up',        Icon: Clock },
  not_ready:  { varName: '--warning',            bgVar: '--status-ringing-bg',     key: 'agent.state.notReady',  fallback: 'Not Ready',      Icon: Pause },
  dnd:        { varName: '--danger',             bgVar: '--status-ringing-bg',     key: 'agent.state.dnd',       fallback: 'Do Not Disturb', Icon: MinusCircle },
  logged_out: { varName: '--status-unavailable', bgVar: '--status-unavailable-bg', key: 'agent.state.loggedOut', fallback: 'Offline',        Icon: LogOut },
  available:  { varName: '--status-idle',        bgVar: '--status-idle-bg',        key: 'agent.state.available', fallback: 'Available',     Icon: CircleDot },
};

// Device (telephony) status tokens — used for plain extensions with no overriding
// presence. Same shape as agent meta so both feed the identical badge.
export const DEVICE_STATUS_META: Record<ExtensionStatus, StatusMeta> = {
  idle:        { varName: '--status-idle',        bgVar: '--status-idle-bg',        key: 'extensions.status.idle',        fallback: 'Available',   Icon: Phone },
  ringing:     { varName: '--status-ringing',     bgVar: '--status-ringing-bg',     key: 'extensions.status.ringing',     fallback: 'Ringing',     Icon: PhoneIncoming },
  in_call:     { varName: '--status-call',        bgVar: '--status-call-bg',        key: 'extensions.status.in_call',     fallback: 'In Call',     Icon: PhoneCall },
  dialing:     { varName: '--status-call',        bgVar: '--status-call-bg',        key: 'extensions.status.dialing',     fallback: 'Dialing',     Icon: PhoneCall },
  unavailable: { varName: '--status-unavailable', bgVar: '--status-unavailable-bg', key: 'extensions.status.unavailable', fallback: 'Offline',     Icon: PhoneOff },
  on_hold:     { varName: '--status-hold',        bgVar: '--status-hold-bg',        key: 'extensions.status.on_hold',     fallback: 'On Hold',     Icon: Pause },
};

// Gray "asleep" tokens (same as Offline/Unavailable) for a Ready agent whose
// device is currently Unavailable — i.e. not holding a live registration. This is
// the normal resting state of a backgrounded mobile softphone, which is woken
// on-demand by push (FCM/APNs → CallKit) on the next incoming call. Presence stays
// Ready (routing is unchanged, the agent is reachable); only the color dims so the
// board reads honestly: "Ready, but the phone isn't registered right now."
const ASLEEP_VAR = '--status-unavailable';
const ASLEEP_BG = '--status-unavailable-bg';

/**
 * Resolve an agent's badge meta, dimming Ready/Available to gray when the device
 * is Unavailable (unregistered). The label/icon are untouched — a Ready agent
 * still reads "Ready" — only the color tokens go gray. `asleep` lets callers add
 * an explanatory tooltip. Keeps ExtensionsPanel and AgentBoardPanel identical.
 */
export function resolveAgentMeta(
  state: AgentState,
  deviceUnavailable: boolean,
): { meta: StatusMeta; asleep: boolean } {
  const base = AGENT_STATE_META[state] ?? AGENT_STATE_META.logged_out;
  const asleep = deviceUnavailable && (state === 'ready' || state === 'available');
  if (!asleep) return { meta: base, asleep: false };
  return { meta: { ...base, varName: ASLEEP_VAR, bgVar: ASLEEP_BG }, asleep: true };
}

interface StatusBadgeProps {
  meta: StatusMeta;
  label: string;
  title?: string;
  className?: string;
}

/** The one presence pill, drawn as the shared <Badge> in the status's colour token so
 *  it has the same shape as every other status in the product. */
export function StatusBadge({ meta, label, title, className }: StatusBadgeProps) {
  const { Icon } = meta;
  return (
    <Badge color={`var(${meta.varName})`} icon={<Icon size={14} />} title={title} className={className}>
      {label}
    </Badge>
  );
}
