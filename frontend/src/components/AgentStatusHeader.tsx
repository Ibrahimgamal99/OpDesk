import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ChevronDown, Play, CheckCircle2, RefreshCw, MinusCircle, CircleDot,
  Pause, PhoneCall, Headset, HeadphoneOff, LogOut,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { fetchWithAuth, getUser } from '../auth';
import type { AgentPresence } from './AgentStatusBar';

interface PauseReason {
  id: number;
  code: string;
  label: string;
  productive: number | boolean;
  color?: string | null;
  is_active: number | boolean;
}

/**
 * The softphone header — an echo/Avaya-style agent status band.
 *
 * Replaces the plain title header (and the old separate <AgentStatusBar>) with a
 * single state-tinted band: a state-icon chip + label (+ count-up timer while in
 * queue) that opens a menu of the transitions valid for the current state (Go
 * Ready / Not-Ready reasons / Do Not Disturb / Log out), plus two always-on
 * switches — a **DND toggle** and a **queue login/logout** headset toggle — and a
 * registration-signal glyph. State is live from the WebSocket (the `presence`
 * prop, derived in App.tsx); actions POST to the REST endpoints and the socket
 * broadcast flips the band back.
 *
 * When the user has no extension (not an agent) it falls back to the classic
 * title header so the dialer still reads sensibly.
 */

/** Registration signal glyph — bars when registered, slashed when not. */
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

function fmtTimer(secs: number): string {
  const s = Math.max(0, Math.floor(secs));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}

// Display states derived from OpDesk's presence model (dnd / queueOn / paused /
// onCall). Each carries its own colour + tinted background token so the band
// reads by state. Priority when resolving: on-call → DND → not-ready → ready → idle.
type DState = 'on_call' | 'dnd' | 'not_ready' | 'ready' | 'idle';
const STATE_META: Record<DState, { Icon: LucideIcon; color: string; bg: string; key: string; fallback: string }> = {
  on_call:   { Icon: PhoneCall,   color: 'var(--status-call)',        bg: 'var(--status-call-bg)',        key: 'agent.onCall',   fallback: 'On call' },
  dnd:       { Icon: MinusCircle, color: 'var(--accent-danger)',      bg: 'var(--status-ringing-bg)',     key: 'agent.dnd',      fallback: 'Do Not Disturb' },
  not_ready: { Icon: Pause,       color: 'var(--accent-warning)',     bg: 'var(--status-ringing-bg)',     key: 'agent.notReady', fallback: 'Not Ready' },
  ready:     { Icon: CheckCircle2, color: 'var(--status-idle)',       bg: 'var(--status-idle-bg)',        key: 'agent.ready',    fallback: 'Ready' },
  idle:      { Icon: CircleDot,   color: 'var(--status-unavailable)', bg: 'var(--status-unavailable-bg)', key: 'agent.idle',     fallback: 'Idle' },
};

interface Props {
  /** Fallback title when the user is not an agent (no extension). */
  title: string;
  icon: ReactNode;
  isConnected: boolean;
  /** Live agent presence (from the WebSocket, derived in App). */
  presence: AgentPresence | null;
  /** This device has a live call — controls lock and the band shows On Call. */
  onCall?: boolean;
  onRefresh?: () => void;
  refreshDisabled?: boolean;
}

export function AgentStatusHeader({ title, icon, isConnected, presence, onCall, onRefresh, refreshDisabled }: Props) {
  const { t } = useTranslation();
  const user = getUser();
  const [reasons, setReasons] = useState<PauseReason[]>([]);
  const [menuOpen, setMenuOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const rootRef = useRef<HTMLDivElement>(null);

  const ext = presence?.ext || String(user?.extension || '');
  const hasExt = !!ext;

  const dnd = !!presence?.dnd;
  const queueOn = !!presence?.queueOn;
  const paused = !!presence?.paused;
  const liveCall = !!onCall || !!presence?.onCall;

  // Resolve the display state.
  const dState: DState = liveCall
    ? 'on_call'
    : dnd
      ? 'dnd'
      : queueOn && paused
        ? 'not_ready'
        : queueOn
          ? 'ready'
          : 'idle';

  // Count-up timer per state. Presence carries no server `since`, so we latch the
  // moment the display state changes and count from there — resetting on each
  // transition, like the echo band.
  const sinceRef = useRef<number>(Date.now());
  const lastStateRef = useRef<DState>(dState);
  if (lastStateRef.current !== dState) {
    lastStateRef.current = dState;
    sinceRef.current = Date.now();
  }
  const showTimer = queueOn || liveCall;

  useEffect(() => {
    if (!hasExt) return;
    fetchWithAuth('/api/pause-reasons?active_only=true')
      .then((r) => (r.ok ? r.json() : { reasons: [] }))
      .then((d) => setReasons((d.reasons || []).filter((x: PauseReason) => x.is_active)))
      .catch(() => { /* ignore */ });
  }, [hasExt]);

  useEffect(() => {
    if (!showTimer) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [showTimer]);

  useEffect(() => {
    if (!menuOpen) return;
    const onOutside = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', onOutside, true);
    return () => document.removeEventListener('mousedown', onOutside, true);
  }, [menuOpen]);

  const elapsed = useMemo(() => (now - sinceRef.current) / 1000, [now]);

  // Not an agent extension at all → classic title header.
  if (!hasExt) {
    return (
      <div className="softphone-header">
        {icon}
        <span className="softphone-header-title">{title}</span>
        <div className="softphone-header-right">
          <span className={`softphone-status-dot ${isConnected ? 'registered' : ''}`} />
          {onRefresh && (
            <button type="button" className="softphone-header-btn" onClick={onRefresh} disabled={refreshDisabled}>
              <RefreshCw size={14} />
            </button>
          )}
        </div>
      </div>
    );
  }

  const meta = STATE_META[dState];
  const StateIcon = meta.Icon;
  const stateLabel = (dState === 'not_ready' && presence?.reason)
    ? presence.reason
    : t(meta.key, meta.fallback);
  // On a call, the selector + toggles lock (can't leave the queue while connected).
  const menuable = !liveCall;

  const call = async (path: string, body?: unknown) => {
    setBusy(true);
    try {
      await fetchWithAuth(path, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
      });
    } catch { /* ignore; state comes from the socket */ }
    finally { setBusy(false); setMenuOpen(false); }
  };

  const setDnd = (on: boolean) => call(`/api/extensions/${ext}/dnd`, { enabled: on });
  const login = () => call('/api/agent/login', { ready: true });
  const logout = () => call('/api/agent/logout');
  const goReady = () => call('/api/agent/status', { ready: true });
  const goNotReady = (code: string) => call('/api/agent/status', { ready: false, reason_code: code });

  const mItem = (Ic: LucideIcon, label: string, onClick: () => void, danger = false) => (
    <button type="button" className={`agent-header-menu-item${danger ? ' danger' : ''}`} onClick={onClick}>
      <Ic size={13} /> <span>{label}</span>
    </button>
  );

  return (
    <div
      ref={rootRef}
      className={`agent-header agent-header-${dState}`}
      style={{ ['--ah-color' as string]: meta.color, ['--ah-bg' as string]: meta.bg }}
    >
      {/* Status selector — opens the transition menu (locked while on a call). */}
      <button
        type="button"
        className="agent-header-main"
        onClick={() => { if (menuable) setMenuOpen((o) => !o); }}
        disabled={!menuable}
        title={ext}
      >
        <span className="agent-header-ic"><StateIcon size={15} /></span>
        <span className="agent-header-state">{stateLabel}</span>
        {showTimer && <span className="agent-header-timer">{fmtTimer(elapsed)}</span>}
        {menuable && <ChevronDown size={15} className="agent-header-caret" />}
      </button>

      <div className="agent-header-right">
        {/* DND toggle */}
        <button
          type="button" role="switch" aria-checked={dnd}
          className={`agent-dnd-toggle${dnd ? ' on' : ''}`}
          style={{ ['--dt-color' as string]: dnd ? 'var(--accent-danger)' : 'var(--status-unavailable)' }}
          onClick={() => { if (!busy && !liveCall) setDnd(!dnd); }}
          disabled={busy || liveCall}
          title={dnd ? t('agent.dndOff', 'Turn off DND') : t('agent.dnd', 'Do Not Disturb')}
          aria-label={t('agent.dnd', 'Do Not Disturb')}
        >
          <span className="agent-dnd-toggle-track">
            <span className="agent-dnd-toggle-knob">{dnd ? <MinusCircle size={12} /> : <CircleDot size={12} />}</span>
          </span>
        </button>

        {/* Queue login/logout headset toggle */}
        <button
          type="button" role="switch" aria-checked={queueOn}
          className={`agent-queue-toggle${queueOn ? ' on' : ''}`}
          style={{ ['--qt-color' as string]: queueOn ? 'var(--status-idle)' : 'var(--status-unavailable)' }}
          onClick={() => { if (!busy && !liveCall) (queueOn ? logout() : login()); }}
          disabled={busy || liveCall}
          title={queueOn ? t('agent.logout', 'Log out of queues') : t('agent.login', 'Log in to queues')}
          aria-label={queueOn ? t('agent.logout', 'Log out') : t('agent.login', 'Log in')}
        >
          <span className="agent-queue-toggle-track">
            <span className="agent-queue-toggle-knob">{queueOn ? <Headset size={12} /> : <HeadphoneOff size={12} />}</span>
          </span>
        </button>

        <span
          className={`agent-header-reg ${isConnected ? 'on' : 'off'}`}
          title={isConnected ? t('header.softphoneRegistered', 'Registered') : t('header.softphoneNotRegistered', 'Not registered')}
        >
          <RegSignal on={isConnected} />
        </span>

        {onRefresh && (
          <button type="button" className="agent-header-refresh" onClick={onRefresh} disabled={refreshDisabled} title={t('softphone.refresh', 'Refresh')}>
            <RefreshCw size={13} />
          </button>
        )}
      </div>

      {menuOpen && menuable && (
        <div className="agent-header-menu">
          {/* Return-to-ready / come-online */}
          {queueOn && paused && mItem(Play, t('agent.goReady', 'Ready'), goReady)}
          {!queueOn && mItem(Headset, t('agent.login', 'Log in to queues'), login)}

          {/* Not-Ready reasons (only meaningful when in a queue) */}
          {queueOn && (
            <>
              <div className="agent-header-menu-label">{t('agent.notReady', 'Not Ready')}</div>
              {reasons.length === 0 && <div className="agent-header-menu-label">{t('agent.noReasons', 'No reason codes')}</div>}
              {reasons.map((r) => (
                <button key={r.code} type="button" className="agent-header-menu-item" onClick={() => goNotReady(r.code)}>
                  <span className="agent-header-menu-swatch" style={{ background: r.color || 'var(--text-muted)' }} />
                  <span>{r.label}</span>
                  {!(r.productive === true || r.productive === 1) && (
                    <span style={{ marginInlineStart: 'auto', fontSize: 10, color: 'var(--text-muted)' }}>{t('agent.break', 'break')}</span>
                  )}
                </button>
              ))}
            </>
          )}

          {/* DND / clear DND */}
          <div className="agent-header-menu-sep" />
          {dnd
            ? mItem(CircleDot, t('agent.idle', 'Idle'), () => setDnd(false))
            : mItem(MinusCircle, t('agent.dnd', 'Do Not Disturb'), () => setDnd(true))}

          {/* Log out of queues */}
          {queueOn && (
            <>
              <div className="agent-header-menu-sep" />
              {mItem(LogOut, t('agent.logout', 'Log out of queues'), logout, true)}
            </>
          )}
        </div>
      )}
    </div>
  );
}
