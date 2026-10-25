import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ChevronDown, Play, RefreshCw, RotateCw, MinusCircle, CircleDot, CheckCircle2,
  Headset, HeadphoneOff, LogOut,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useAgentPresence } from '../contexts/AgentPresenceContext';
import { usePauseReasons } from '../hooks/usePauseReasons';
import { AGENT_STATE_META, DEVICE_STATUS_META } from './statusBadge';
import type { AgentState, AgentStateInfo } from '../types';
import { fmtTimer } from '../lib/format';
import { Badge } from './ui';

/**
 * The softphone header: a contact-center-style status control.
 *
 * The live status is a *selector*: a state icon + label (+ a count-up timer while in the
 * queue) that opens a menu of the transitions valid for the current state (Not-Ready
 * reasons / Ready / Finish wrap-up / Do Not Disturb / Log out). The only always-on
 * controls beside it are one switch and the registration signal glyph:
 *   - a queue agent gets the **headset toggle** (in/out of the queue); DND is in the menu;
 *   - a plain extension gets a **DND toggle** (Available / DND) and no menu.
 *
 * Out of the queue an agent is treated like a plain extension: logged out reads as
 * **Available** (direct calls ring) and DND blocks them. Going Available from DND logs the
 * agent out rather than rejoining the queue.
 *
 * Presence is the backend's agent-state manager (`agent_states[myExt]`), so the timer
 * counts from the server's `since` and survives a reload. Transitions go back over the
 * same socket (`agent_login`, `agent_logout`, `agent_set_status`, `agent_wrapup_done`);
 * the next state broadcast flips the header. Going Not-Ready always names a reason: the
 * menu offers only the active, non-system reasons, and the backend refuses anything else.
 */

/** Registration signal glyph: green bars when registered, red slashed when not. */
function RegSignal({ on }: { on: boolean }) {
  return (
    <svg width="15" height="14" viewBox="0 0 20 18" fill="none" aria-hidden="true">
      <rect x="1" y="12" width="3.4" height="5" rx="1" fill="currentColor" opacity={on ? 1 : 0.3} />
      <rect x="6.3" y="8" width="3.4" height="9" rx="1" fill="currentColor" opacity={on ? 1 : 0.3} />
      <rect x="11.6" y="4" width="3.4" height="13" rx="1" fill="currentColor" opacity={on ? 1 : 0.3} />
      {!on && <path d="M2.5 16 L16 2.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />}
    </svg>
  );
}

/** Seconds since the state was entered: the server's `since` when it parses, else the
 *  snapshot's `duration_secs` (an older backend, or a clock it could not express). */
function secondsInState(presence: AgentStateInfo | null, now: number): number {
  if (!presence) return 0;
  const since = presence.since ? Date.parse(presence.since) : NaN;
  if (Number.isFinite(since)) return Math.max(0, (now - since) / 1000);
  return presence.duration_secs ?? 0;
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
  onRefresh?: () => void;
  refreshDisabled?: boolean;
  /** Force a fresh softphone registration attempt. */
  onReconnect?: () => void;
}

export function AgentStatusHeader({ title, icon, isConnected, onCall, ringing, onRefresh, refreshDisabled, onReconnect }: Props) {
  const { t } = useTranslation();
  const { myExt, isAgent, presence, dnd, onCall: extOnCall, sendAction } = useAgentPresence();
  const { selectable, labelFor } = usePauseReasons();
  const [menuOpen, setMenuOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const rootRef = useRef<HTMLDivElement>(null);

  // No presence row for a queue agent = not logged in to any queue.
  const state: AgentState = presence?.state ?? 'logged_out';
  // In the queue = the ACD states; everything else is the out-of-queue Available/DND control.
  const queueOn = isAgent && (state === 'ready' || state === 'not_ready' || state === 'wrap_up' || state === 'on_call');

  useEffect(() => {
    // Only the in-queue states carry a count-up timer.
    if (!queueOn) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [queueOn]);

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
          {!isConnected && onReconnect && (
            <button
              type="button"
              className="softphone-header-btn"
              onClick={onReconnect}
              title={t('softphone.reconnect', 'Reconnect')}
            >
              <RotateCw size={14} />
            </button>
          )}
          {onRefresh && (
            <button
              type="button"
              className="softphone-header-btn"
              onClick={onRefresh}
              disabled={refreshDisabled}
              title={t('common.refresh', 'Refresh')}
            >
              <RefreshCw size={14} />
            </button>
          )}
        </div>
      </div>
    );
  }

  // DND: the presence state when the manager reports it, else the extension's own flag.
  const isDnd = state === 'dnd' || (!queueOn && dnd);
  const busy = !!onCall || extOnCall || state === 'on_call';
  // Display state: in the queue shows the ACD state (a live call shows On Call, except
  // during wrap-up, which already follows a call); out of it Available / DND / On Call.
  const dState: AgentState = queueOn
    ? (busy && state !== 'wrap_up' ? 'on_call' : state)
    : (busy ? 'on_call' : isDnd ? 'dnd' : 'available');
  // An unanswered incoming call is busy (controls lock) but shows as Ringing.
  const meta = ringing ? DEVICE_STATUS_META.ringing : AGENT_STATE_META[dState];
  const StateIcon = meta.Icon;
  const stateLabel = (!ringing && dState === 'not_ready' && labelFor(presence?.reason_code)) || t(meta.key, meta.fallback);
  // A plain extension only toggles Available / DND, so it gets an inline switch instead of
  // the menu. Agents keep the menu (queue states + reasons).
  const plainToggle = !isAgent;
  const menuable = !busy && !plainToggle;

  const act = (action: Record<string, unknown> & { action: string }) => {
    sendAction(action);
    setMenuOpen(false);
  };
  const login = () => act({ action: 'agent_login' });
  const logout = () => act({ action: 'agent_logout' });
  const setReady = () => act({ action: 'agent_set_status', status: 'ready' });
  const finishWrap = () => act({ action: 'agent_wrapup_done' });
  const setNotReady = (code: string) => {
    // A Not-Ready without a valid reason is refused by the backend; never send one.
    if (!selectable.some((r) => r.code === code)) return;
    act({ action: 'agent_set_status', status: 'not_ready', reason_code: code });
  };
  const setDnd = () => act({ action: 'agent_set_status', status: 'dnd' });
  // Go Available from DND: an agent logs out (set_available would rejoin the queue);
  // a plain extension just clears DND.
  const goAvailable = () => act(isAgent ? { action: 'agent_logout' } : { action: 'agent_set_status', status: 'available' });

  const showReasons = state === 'ready' || state === 'not_ready';
  const showDnd = !isDnd && (state === 'ready' || state === 'not_ready' || state === 'wrap_up' || !queueOn);
  // Whether any item precedes DND in the menu (so the divider is never the first row).
  const hasAbove = showReasons || state === 'wrap_up' || !queueOn;

  const mItem = (Ic: LucideIcon, label: string, onClick: () => void, danger = false) => (
    <button
      type="button"
      role="menuitem"
      className={`agent-bar-menu-item${danger ? ' agent-header-menu-danger' : ''}`}
      onClick={onClick}
    >
      <Ic size={14} /> <span>{label}</span>
    </button>
  );

  return (
    <div
      ref={rootRef}
      className={`agent-header agent-header-${ringing ? 'ringing' : dState}`}
      style={{ ['--ah-color' as string]: `var(${meta.varName})`, ['--ah-bg' as string]: `var(${meta.bgVar})` }}
    >
      {/* Status selector: opens the transition menu (locked while on a call). For a plain
          extension it is a static label; the DND toggle lives on the right. */}
      <button
        type="button"
        className="agent-header-main"
        onClick={() => { if (menuable) setMenuOpen((o) => !o); }}
        disabled={!menuable}
        aria-haspopup={menuable ? 'menu' : undefined}
        aria-expanded={menuable ? menuOpen : undefined}
        title={myExt}
      >
        <span className="agent-header-ic"><StateIcon size={15} /></span>
        <span className="agent-header-state">{stateLabel}</span>
        {queueOn && <span className="agent-header-timer">{fmtTimer(elapsed)}</span>}
        {menuable && <ChevronDown size={15} className="agent-header-caret" />}
      </button>

      <div className="agent-header-right">
        {plainToggle && (
          /* Do-Not-Disturb toggle, the plain-extension status control.
             On = DND (calls blocked); off = Available. Locked mid-call. */
          <button
            type="button"
            role="switch"
            aria-checked={isDnd}
            className={`agent-dnd-toggle ${isDnd ? 'on' : ''}`}
            onClick={() => { if (busy) return; if (isDnd) goAvailable(); else setDnd(); }}
            disabled={busy}
            title={isDnd ? t('agent.state.available', 'Available') : t('agent.state.dnd', 'Do Not Disturb')}
            aria-label={t('agent.state.dnd', 'Do Not Disturb')}
          >
            <span className="agent-dnd-toggle-track">
              <span className="agent-dnd-toggle-knob">
                {isDnd ? <MinusCircle size={14} /> : <CircleDot size={14} />}
              </span>
            </span>
          </button>
        )}
        {isAgent && (
          /* Queue login/logout: headset (in queue) / headset-off (out). Locked mid-call. */
          <button
            type="button"
            role="switch"
            aria-checked={queueOn}
            className={`agent-queue-toggle ${queueOn ? 'on' : ''}`}
            onClick={() => { if (busy) return; if (queueOn) logout(); else login(); }}
            disabled={busy}
            title={queueOn ? t('agent.logout', 'Log out') : t('common.logIn', 'Log in')}
            aria-label={queueOn ? t('agent.logout', 'Log out') : t('common.logIn', 'Log in')}
          >
            <span className="agent-queue-toggle-track">
              <span className="agent-queue-toggle-knob">
                {queueOn ? <Headset size={14} /> : <HeadphoneOff size={14} />}
              </span>
            </span>
          </button>
        )}
        <span
          className={`agent-header-reg ${isConnected ? 'on' : 'off'}`}
          title={isConnected ? t('header.softphoneRegistered', 'Registered') : t('header.softphoneNotRegistered', 'Not registered')}
        >
          <RegSignal on={isConnected} />
        </span>
        {!isConnected && onReconnect && (
          <button
            type="button"
            className="agent-header-refresh"
            onClick={onReconnect}
            title={t('softphone.reconnect', 'Reconnect')}
          >
            <RotateCw size={14} />
          </button>
        )}
        {onRefresh && (
          <button type="button" className="agent-header-refresh" onClick={onRefresh} disabled={refreshDisabled} title={t('common.refresh', 'Refresh')}>
            <RefreshCw size={14} />
          </button>
        )}
      </div>

      {menuOpen && menuable && (
        <div className="agent-header-menu" role="menu">
          {/* Return-to-ready / come-online transitions */}
          {state === 'not_ready' && mItem(Play, t('agent.state.ready', 'Ready'), setReady)}
          {state === 'wrap_up' && mItem(CheckCircle2, t('agent.finishWrap', 'Finish wrap-up'), finishWrap)}
          {!queueOn && mItem(Play, t('agent.state.ready', 'Ready'), login)}

          {/* Not-Ready reasons (only meaningful in the queue). A reason is required, so
              there is no reasonless "Not Ready" item. */}
          {showReasons && (
            <>
              <div className="agent-header-menu-label">{t('agent.pickReason', 'Not ready, with a reason')}</div>
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
            </>
          )}

          {/* Do Not Disturb (from any online / idle state) or, when in DND, go Available */}
          {showDnd && (
            <>
              {hasAbove && <div className="agent-header-menu-sep" />}
              {mItem(MinusCircle, t('agent.state.dnd', 'Do Not Disturb'), setDnd)}
            </>
          )}
          {isDnd && mItem(CircleDot, t('agent.state.available', 'Available'), goAvailable)}

          {/* Log out (leaves the queue). Out of the queue the headset toggle logs in. */}
          {queueOn && (
            <>
              <div className="agent-header-menu-sep" />
              {mItem(LogOut, t('agent.logout', 'Log out'), logout, true)}
            </>
          )}
        </div>
      )}
    </div>
  );
}
