import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  BellOff, Check, ChevronDown, Headset, HeadphoneOff, Play, RefreshCw, WifiOff,
} from 'lucide-react';
import { useAgentPresence } from '../contexts/AgentPresenceContext';
import { usePauseReasons } from '../hooks/usePauseReasons';
import { AGENT_STATE_META, DEVICE_STATUS_META } from './statusBadge';
import type { AgentState, AgentStateInfo } from '../types';
import { fmtTimer } from '../lib/format';
import { Badge } from './ui';

/**
 * The softphone header: availability + queue login + DND, as three independent controls.
 *
 * One row (design A, "status pill"):
 *
 *   ( ✓ Available 12:04 ▾ ) [▶]        ● 1001  [🎧] [🔕]  ↻
 *
 *   - **Availability** (the pill, every extension): the state's icon, label and a count-up
 *     timer; ▾ opens the break-reason menu. On a break a quick ▶ Resume sits beside it (the
 *     menu still switches reason); in wrap-up a quick ✓ Finish wrap-up. Offline (wifi-off)
 *     means the phone is not registered — there is no "go offline" item.
 *   - **Extension** with a registration dot.
 *   - **Queues** (headset icon, queue agents only): in / out of the queues, blue when in. It
 *     never changes availability. On a break the agent joins paused with the break's reason.
 *   - **DND** (bell-off icon, everyone): red when on. It overrides everything — it ends a
 *     break and becomes the status (the time counts as Idle), blocks inbound calls and takes
 *     the agent out of the queues; turning it off returns to Available and rejoins them.
 *     Picking a break turns DND off. Outbound calls still work.
 *   - **Sync** (see SyncButton): reload settings, or reconnect when not registered.
 *
 * Every control locks during a call.
 *
 * Presence is the backend's agent-state manager (`agent_states[myExt]`), so the timer
 * counts from the server's `since` and survives a reload. Going on a break always names a
 * reason: the menu offers only the active, non-system reasons.
 */

/** Seconds since the state was entered: the server's `since` when it parses, else the
 *  snapshot's `duration_secs` (an older backend, or a clock it could not express). */
function secondsInState(presence: AgentStateInfo | null, now: number): number {
  if (!presence) return 0;
  const since = presence.since ? Date.parse(presence.since) : NaN;
  if (Number.isFinite(since)) return Math.max(0, (now - since) / 1000);
  return presence.duration_secs ?? 0;
}

/**
 * The softphone's one sync icon, whose action follows the registration:
 *   - registered     -> reload the WebRTC config (an admin changed the server or extension);
 *   - not registered -> reload the config AND register again with it (tinted, so it shows).
 * It spins and locks while the action runs, so a double click is one attempt.
 */
function SyncButton({ className, isConnected, onRefresh, onReconnect, refreshDisabled }: {
  className: string;
  isConnected: boolean;
  onRefresh?: () => unknown;
  onReconnect?: () => unknown;
  refreshDisabled?: boolean;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const reconnect = !isConnected && !!onReconnect;
  const action = reconnect ? onReconnect : onRefresh;
  if (!action) return null;
  const label = reconnect
    ? t('softphone.reconnectHint', 'Not registered: reload settings and reconnect')
    : t('softphone.refreshHint', 'Reload phone settings');
  const run = async () => {
    setBusy(true);
    try { await action(); } finally { setBusy(false); }
  };
  return (
    <button
      type="button"
      className={`${className} sync-btn${reconnect ? ' is-reconnect' : ''}${busy ? ' is-busy' : ''}`}
      onClick={() => { void run(); }}
      disabled={busy || (!reconnect && refreshDisabled)}
      title={label}
      aria-label={label}
    >
      <RefreshCw size={14} />
    </button>
  );
}

interface Props {
  /** Fallback title when the user has no extension. */
  title: string;
  icon: ReactNode;
  isConnected: boolean;
  /** This device has a live call: the status shows On Call and controls lock. */
  onCall?: boolean;
  /** A call is ringing in on this device (not answered yet): shows Ringing, not On Call. */
  ringing?: boolean;
  /** Reload the WebRTC config (the sync icon while registered). */
  onRefresh?: () => unknown;
  refreshDisabled?: boolean;
  /** Reload the config and register again (the sync icon while not registered). */
  onReconnect?: () => unknown;
}

export function AgentStatusHeader({ title, icon, isConnected, onCall, ringing, onRefresh, refreshDisabled, onReconnect }: Props) {
  const { t } = useTranslation();
  const { myExt, isAgent, presence, dnd, onCall: extOnCall, sendAction } = useAgentPresence();
  const { selectable, labelFor } = usePauseReasons();
  const [menuOpen, setMenuOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const rootRef = useRef<HTMLDivElement>(null);

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

  useEffect(() => {
    if (!menuOpen) return;
    const onOutside = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenuOpen(false); };
    document.addEventListener('mousedown', onOutside, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onOutside, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  const elapsed = useMemo(() => secondsInState(presence, now), [presence, now]);

  // No extension at all: the classic title header.
  if (!myExt) {
    return (
      <div className="softphone-header">
        {icon}
        <span className="softphone-header-title">{title}</span>
        <div className="softphone-header-right">
          <span className={`softphone-status-dot ${isConnected ? 'registered' : ''}`} />
          <SyncButton
            className="softphone-header-btn"
            isConnected={isConnected}
            onRefresh={onRefresh}
            onReconnect={onReconnect}
            refreshDisabled={refreshDisabled}
          />
        </div>
      </div>
    );
  }

  // DND is a flag beside availability (legacy 'dnd' presence rows still read as DND).
  const isDnd = !!presence?.dnd || dnd || state === 'dnd';
  const busy = !!onCall || extOnCall || state === 'on_call';
  // A live call shows On Call, except during wrap-up (it already follows a call). DND
  // overrides everything else: it is the status itself (the time counts as Idle).
  const dState: AgentState = busy && state !== 'wrap_up'
    ? 'on_call'
    : isDnd ? 'dnd' : (state === 'available' ? 'ready' : state);
  // An unanswered incoming call is busy (controls lock) but shows as Ringing.
  const meta = ringing ? DEVICE_STATUS_META.ringing : AGENT_STATE_META[dState];
  // Offline reads as "no connection" (wifi-off), not the generic logged-out glyph.
  const PillIcon = !ringing && !online ? WifiOff : meta.Icon;
  // On a break the pill names the reason (Lunch); its tooltip and colour say it is a break.
  const stateLabel = (!ringing && dState === 'not_ready' && labelFor(presence?.reason_code)) || t(meta.key, meta.fallback);
  const asleep = online && presence?.reachable_via === 'push';
  // The break menu exists only where a break can be picked (Available, or switching reason).
  const showReasons = state === 'ready' || state === 'not_ready';
  const menuable = !busy && online && showReasons;

  // What the pill means, beyond its label: its tooltip.
  const pillHint = busy
    ? t('agent.lockedOnCall', 'Controls unlock when the call ends')
    : !online
      ? t('agent.offlineHint', 'Offline — availability starts when the phone registers')
      : asleep
        ? t('agent.asleepHint', 'The app is asleep; calls wake it by push')
        : dState === 'dnd'
          ? t('agent.dndSub', 'Inbound blocked · outbound still works')
          : dState === 'not_ready' && isAgent && queueOn
            ? t('agent.pausedInQueues', 'Paused in queues')
            : '';
  const extHint = isConnected
    ? t('agent.extRegistered', 'Ext {{ext}} · Registered', { ext: myExt })
    : t('agent.extNotRegistered', 'Ext {{ext}} · Not registered', { ext: myExt });

  const act = (action: Record<string, unknown> & { action: string }) => {
    sendAction(action);
    setMenuOpen(false);
  };
  const login = () => act({ action: 'agent_login' });
  const logout = () => act({ action: 'agent_logout' });
  const setReady = () => act({ action: 'agent_set_status', status: 'ready' });
  const finishWrap = () => act({ action: 'agent_wrapup_done' });
  const setNotReady = (code: string) => {
    // A break without a valid reason is refused by the backend; never send one.
    if (!selectable.some((r) => r.code === code)) return;
    act({ action: 'agent_set_status', status: 'not_ready', reason_code: code });
  };
  const setDnd = () => act({ action: 'agent_set_status', status: 'dnd', enabled: true });
  const clearDnd = () => act({ action: 'agent_set_status', status: 'dnd', enabled: false });

  // The one-tap way back to Available, beside the pill: Resume on a break, Finish in wrap-up.
  const quick = busy || !online
    ? null
    : state === 'not_ready'
      ? { Icon: Play, label: t('agent.resume', 'Resume'), onClick: setReady }
      : state === 'wrap_up'
        ? { Icon: Check, label: t('agent.finishWrap', 'Finish wrap-up'), onClick: finishWrap }
        : null;

  return (
    <div
      ref={rootRef}
      className={`agent-header agent-header-${ringing ? 'ringing' : online ? dState : 'logged_out'}`}
      style={{ ['--ah-color' as string]: `var(${meta.varName})`, ['--ah-bg' as string]: `var(${meta.bgVar})` }}
    >
      {/* The state pill: icon, label, timer; opens the break menu (locked on a call or offline). */}
      <button
        type="button"
        className="agent-pill"
        onClick={() => { if (menuable) setMenuOpen((o) => !o); }}
        disabled={!menuable}
        aria-haspopup={menuable ? 'menu' : undefined}
        aria-expanded={menuable ? menuOpen : undefined}
        title={pillHint || undefined}
      >
        <PillIcon size={14} className="agent-pill-ic" />
        <span className="agent-pill-label">{stateLabel}</span>
        {online && <span className="agent-pill-timer">{fmtTimer(elapsed)}</span>}
        {menuable && <ChevronDown size={14} className="agent-pill-caret" />}
      </button>
      {quick && (
        <button
          type="button"
          className="agent-quick"
          onClick={quick.onClick}
          title={quick.label}
          aria-label={quick.label}
        >
          <quick.Icon size={15} />
        </button>
      )}

      <span className="agent-header-spacer" />

      <span className="agent-ext" title={extHint}>
        <span className={`agent-ext-dot${isConnected ? ' is-on' : ''}`} />
        {myExt}
      </span>
      {isAgent && (
        /* Queue login/logout. Locked mid-call. */
        <button
          type="button"
          role="switch"
          aria-checked={queueOn}
          className={`agent-icon-btn agent-icon-queue${queueOn ? ' on' : ''}`}
          onClick={() => { if (busy) return; if (queueOn) logout(); else login(); }}
          disabled={busy}
          title={queueOn ? t('agent.queueLogout', 'Log out of queues') : t('agent.queueLogin', 'Log in to queues')}
          aria-label={queueOn ? t('agent.queueLogout', 'Log out of queues') : t('agent.queueLogin', 'Log in to queues')}
        >
          {queueOn ? <Headset size={17} /> : <HeadphoneOff size={17} />}
        </button>
      )}
      {/* DND: blocks inbound calls (and leaves the queues). Locked mid-call. */}
      <button
        type="button"
        role="switch"
        aria-checked={isDnd}
        className={`agent-icon-btn agent-icon-dnd${isDnd ? ' on' : ''}`}
        onClick={() => { if (busy) return; if (isDnd) clearDnd(); else setDnd(); }}
        disabled={busy}
        title={isDnd ? t('agent.dndOff', 'Turn DND off') : t('agent.dndOn', 'Turn on Do Not Disturb')}
        aria-label={t('agent.state.dnd', 'Do Not Disturb')}
      >
        <BellOff size={17} />
      </button>
      <SyncButton
        className="agent-header-refresh"
        isConnected={isConnected}
        onRefresh={onRefresh}
        onReconnect={onReconnect}
        refreshDisabled={refreshDisabled}
      />

      {menuOpen && menuable && (
        <div className="agent-header-menu" role="menu">
          {/* Break reasons. A reason is required, so there is no reasonless item. */}
          <div className="agent-header-menu-label">
            {isDnd ? t('agent.pickBreakEndsDnd', 'Break, with a reason (turns DND off)') : t('agent.pickBreak', 'Break, with a reason')}
          </div>
          {selectable.length === 0 && (
            <div className="agent-bar-menu-empty">{t('agent.noReasons', 'No reason codes')}</div>
          )}
          {selectable.map((r) => (
            <button
              key={r.code}
              type="button"
              role="menuitem"
              className="agent-bar-menu-item"
              onClick={() => setNotReady(r.code)}
              aria-current={state === 'not_ready' && presence?.reason_code === r.code ? 'true' : undefined}
            >
              <span
                className="agent-header-menu-swatch u-bg-var"
                style={{ '--u-color': r.color || 'var(--text-muted)' } as CSSProperties}
              />
              <span>{r.label}</span>
              {!(r.productive === true || r.productive === 1) && (
                <Badge tone="neutral" className="u-push-end">{t('agent.unpaid', 'break')}</Badge>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
