import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { WifiOff } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useAgentPresence } from '../contexts/AgentPresenceContext';
import { usePauseReasons } from './usePauseReasons';
import { AGENT_STATE_META, DEVICE_STATUS_META, type StatusMeta } from '../components/statusBadge';
import type { AgentState, AgentStateInfo, PauseReason } from '../types';

/** How far into its break window a break is: '' (fine or no window), 'near' (80%+), 'over'. */
export type BreakPressure = '' | 'near' | 'over';

/** Seconds since the state was entered: the server's `since` when it parses, else the
 *  snapshot's `duration_secs` (an older backend, or a clock it could not express). */
export function secondsInState(presence: AgentStateInfo | null | undefined, now: number): number {
  if (!presence) return 0;
  const since = presence.since ? Date.parse(presence.since) : NaN;
  if (Number.isFinite(since)) return Math.max(0, (now - since) / 1000);
  return presence.duration_secs ?? 0;
}

/**
 * Where a break stands against its reason's window (`pause_reasons.max_break_secs`): amber
 * from 80% of the window, red past it. Nothing ends on its own; this is only the colour.
 */
export function breakPressure(reason: PauseReason | undefined | null, secs: number): { pressure: BreakPressure; ratio: number; window: number } {
  const win = reason?.max_break_secs ?? 0;
  if (!win || win <= 0) return { pressure: '', ratio: 0, window: 0 };
  const ratio = secs / win;
  return { pressure: ratio > 1 ? 'over' : ratio >= 0.8 ? 'near' : '', ratio: Math.min(1, ratio), window: win };
}

interface Options {
  /** This device has a live call (the softphone's own view): On Call, controls lock. */
  onCall?: boolean;
  /** A call is ringing in on this device: shows Ringing, controls lock. */
  ringing?: boolean;
}

/**
 * The signed-in user's own availability, queue login and DND: what to show and how to change
 * it. One source for the softphone header and the header profile menu, so the two always
 * agree (both read the backend's `agent_states[myExt]` and send the same actions).
 */
export function usePresenceControls({ onCall, ringing }: Options = {}) {
  const { t } = useTranslation();
  const { myExt, isAgent, presence, dnd, onCall: extOnCall, sendAction } = useAgentPresence();
  const { selectable, reasons, labelFor } = usePauseReasons();
  const [now, setNow] = useState(() => Date.now());

  // No presence row = offline (the phone is not registered).
  const state: AgentState = presence?.state ?? 'logged_out';
  const online = state !== 'logged_out';
  const queueOn = !!presence?.queue_logged_in;

  useEffect(() => {
    // Every available state carries a count-up timer.
    if (!online) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [online]);

  const elapsed = useMemo(() => secondsInState(presence, now), [presence, now]);

  // DND is a flag beside availability (legacy 'dnd' presence rows still read as DND).
  const isDnd = !!presence?.dnd || dnd || state === 'dnd';
  const busy = !!onCall || !!ringing || extOnCall || state === 'on_call';
  // A live call shows On Call, except during wrap-up (it already follows a call). DND
  // overrides everything else: it is the status itself (the time counts as Idle).
  const dState: AgentState = busy && state !== 'wrap_up'
    ? 'on_call'
    : isDnd ? 'dnd' : (state === 'available' ? 'ready' : state);
  // An unanswered incoming call is busy (controls lock) but shows as Ringing.
  const meta: StatusMeta = ringing ? DEVICE_STATUS_META.ringing : AGENT_STATE_META[dState];
  // Offline reads as "no connection" (wifi-off), not the generic logged-out glyph.
  const Icon: LucideIcon = !ringing && !online ? WifiOff : meta.Icon;
  const reasonLabel = dState === 'not_ready' ? labelFor(presence?.reason_code) : null;
  // On a break the label names the reason (Lunch); its colour says it is a break.
  const label = (!ringing && reasonLabel) || t(meta.key, meta.fallback);
  const asleep = online && presence?.reachable_via === 'push';
  // A break can be picked from Available, or to switch reason.
  const canPickBreak = !busy && online && (state === 'ready' || state === 'available' || state === 'not_ready');
  const reason = dState === 'not_ready' ? reasons.find((r) => r.code === presence?.reason_code) : undefined;
  const breakWindow = breakPressure(reason, elapsed);

  const send = (action: Record<string, unknown> & { action: string }) => sendAction(action);
  const actions = {
    setReady: () => send({ action: 'agent_set_status', status: 'ready' }),
    finishWrap: () => send({ action: 'agent_wrapup_done' }),
    setNotReady: (code: string) => {
      // A break without a valid reason is refused by the backend; never send one.
      if (!selectable.some((r) => r.code === code)) return;
      send({ action: 'agent_set_status', status: 'not_ready', reason_code: code });
    },
    setDnd: (enabled: boolean) => send({ action: 'agent_set_status', status: 'dnd', enabled }),
    queueLogin: () => send({ action: 'agent_login' }),
    queueLogout: () => send({ action: 'agent_logout' }),
  };

  return {
    myExt, isAgent, presence, state, dState, online, busy, ringing: !!ringing, asleep,
    isDnd, queueOn, queues: presence?.queues ?? [],
    meta, Icon, label, elapsed, canPickBreak,
    reasonCode: dState === 'not_ready' ? presence?.reason_code ?? null : null,
    breakWindow,
    selectable,
    actions,
  };
}

export type PresenceControls = ReturnType<typeof usePresenceControls>;
