import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ChevronDown, Play, CheckCircle2, RefreshCw, RotateCw, MinusCircle, CircleDot,
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
 * The softphone header — a contact-center-style status control (echo parity).
 *
 * The live status is a *selector*: a state icon + label (+ count-up timer while
 * in queue) that opens a menu of the transitions valid for the current state
 * (Not-Ready reasons / Go Ready / Do Not Disturb / Log out). The only always-on
 * controls beside it are one switch and the **registration signal** glyph:
 *   - a queue agent (extension with login queues) gets the **headset toggle**
 *     (in/out of the queue); DND lives in the menu;
 *   - a plain extension gets a **DND toggle** (Idle ⇄ DND) and no menu.
 *
 * Out of the queue an agent is treated like a plain extension — Idle ⇄ DND, no
 * "Offline": logged out reads as **Available** (direct calls ring) and DND blocks
 * them. Echo's agent rules, composed from OpDesk's REST endpoints:
 *   - log in   = clear DND, then join the queues Ready;
 *   - DND      = leave the queues (logout), then set the DND flag;
 *   - go Idle  = logout (which also clears DND).
 * State is live from the WebSocket (the `presence` prop, derived in App.tsx);
 * the socket broadcast after each call flips the header back.
 */

/** Registration signal glyph — green bars when registered, red slashed when not. */
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

// Display states (echo's agent states minus wrap-up, which OpDesk doesn't track).
// Each carries its own colour + tinted background token so the band reads by state.
type DState = 'ready' | 'not_ready' | 'on_call' | 'dnd' | 'available';
const STATE_META: Record<DState, { Icon: LucideIcon; color: string; bg: string; key: string; fallback: string }> = {
  ready:     { Icon: CheckCircle2, color: 'var(--status-idle)',    bg: 'var(--status-idle-bg)',    key: 'agent.state.ready',     fallback: 'Ready' },
  on_call:   { Icon: PhoneCall,    color: 'var(--status-call)',    bg: 'var(--status-call-bg)',    key: 'agent.state.onCall',    fallback: 'On Call' },
  not_ready: { Icon: Pause,        color: 'var(--accent-warning)', bg: 'var(--status-ringing-bg)', key: 'agent.state.notReady',  fallback: 'Not Ready' },
  dnd:       { Icon: MinusCircle,  color: 'var(--accent-danger)',  bg: 'var(--status-ringing-bg)', key: 'agent.state.dnd',       fallback: 'Do Not Disturb' },
  available: { Icon: CircleDot,    color: 'var(--status-idle)',    bg: 'var(--status-idle-bg)',    key: 'agent.state.available', fallback: 'Available' },
};

interface Props {
  /** Fallback title when the user is not an agent (no extension). */
  title: string;
  icon: ReactNode;
  isConnected: boolean;
  /** Live agent presence (from the WebSocket, derived in App). */
  presence: AgentPresence | null;
  /** This device has a live call — the status shows On Call and controls lock. */
  onCall?: boolean;
  onRefresh?: () => void;
  refreshDisabled?: boolean;
  /** Force a fresh softphone registration attempt. */
  onReconnect?: () => void;
}

export function AgentStatusHeader({ title, icon, isConnected, presence, onCall, onRefresh, refreshDisabled, onReconnect }: Props) {
  const { t } = useTranslation();
  const user = getUser();
  const [reasons, setReasons] = useState<PauseReason[]>([]);
  const [menuOpen, setMenuOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const rootRef = useRef<HTMLDivElement>(null);

  const myExt = presence?.ext || String(user?.extension || '');
  // Servers that predate `is_agent` leave it undefined: fall back to the agent
  // layout, whose menu still reaches DND, so no control goes missing.
  const isAgent = !!myExt && (user?.is_agent ?? true);

  const isDnd = !!presence?.dnd;
  const member = !!presence?.queueOn;
  const liveCall = !!onCall || !!presence?.onCall;

  // In the queue = the ACD states; everything else is the out-of-queue Idle/DND
  // control. DND takes the agent out of the queue (echo), so it wins here too.
  const queueOn = isAgent && member && !isDnd;
  const dState: DState = liveCall
    ? 'on_call'
    : queueOn
      ? (presence?.paused ? 'not_ready' : 'ready')
      : isDnd ? 'dnd' : 'available';

  // Count-up timer for the in-queue states. Presence carries no server `since`,
  // so latch the moment the display state changes and count from there.
  const sinceRef = useRef<number>(Date.now());
  const lastStateRef = useRef<DState>(dState);
  if (lastStateRef.current !== dState) {
    lastStateRef.current = dState;
    sinceRef.current = Date.now();
  }

  useEffect(() => {
    if (!isAgent) return;
    fetchWithAuth('/api/pause-reasons?active_only=true')
      .then((r) => (r.ok ? r.json() : { reasons: [] }))
      .then((d) => setReasons((d.reasons || []).filter((x: PauseReason) => x.is_active)))
      .catch(() => { /* ignore */ });
  }, [isAgent]);

  useEffect(() => {
    // Only the in-queue ACD states carry a count-up timer.
    if (!queueOn) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [queueOn]);

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
  const stateLabel = (dState === 'not_ready' && presence?.reason) || t(meta.key, meta.fallback);
  // A plain extension only ever toggles Idle ⇄ DND, so it gets an inline switch
  // instead of the dropdown menu. Agents keep the menu (queue states + reasons).
  const plainToggle = !isAgent;
  // The selector opens the status menu unless we're on a call or it's a plain ext.
  const locked = liveCall || pending;
  const menuable = !liveCall && !plainToggle;

  // Run a chain of REST transitions in order; state comes back over the socket.
  const run = async (...steps: Array<[string, unknown?]>) => {
    setMenuOpen(false);
    setPending(true);
    try {
      for (const [path, body] of steps) {
        await fetchWithAuth(path, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body ?? {}),
        });
      }
    } catch { /* ignore; state comes from the socket */ }
    finally { setPending(false); }
  };

  const dndPath = `/api/extensions/${myExt}/dnd`;
  // Log in clears DND first (echo: coming online makes direct calls ring again).
  const login = () => run(...(isDnd ? [[dndPath, { enabled: false }] as [string, unknown]] : []), ['/api/agent/login', { ready: true }]);
  // Log out also clears DND server-side.
  const logout = () => run(['/api/agent/logout']);
  const setReady = () => run(['/api/agent/status', { ready: true }]);
  const setNotReady = (code: string) => run(['/api/agent/status', { ready: false, reason_code: code }]);
  // DND takes an agent out of the queue as well as blocking direct calls.
  const setDnd = () => run(...(isAgent && member ? [['/api/agent/logout'] as [string, unknown?]] : []), [dndPath, { enabled: true }]);
  // Go Idle (clear DND, stay reachable). An agent logs out (which clears DND and
  // drops any stale membership); a plain extension just clears DND.
  const goIdle = () => run(isAgent ? ['/api/agent/logout'] : [dndPath, { enabled: false }]);

  const showReasons = queueOn;
  const showDnd = !isDnd;
  // Whether any item precedes DND in the menu (so the divider isn't the first row).
  const hasAbove = showReasons || !queueOn;

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
      {/* Status selector — opens the transition menu (locked while on a call).
         For a plain extension it's a static label; the DND toggle lives on the right. */}
      <button
        type="button"
        className="agent-header-main"
        onClick={() => { if (menuable) setMenuOpen((o) => !o); }}
        disabled={!menuable}
        title={myExt}
      >
        <span className="agent-header-ic"><StateIcon size={15} /></span>
        <span className="agent-header-state">{stateLabel}</span>
        {queueOn && <span className="agent-header-timer">{fmtTimer(elapsed)}</span>}
        {menuable && <ChevronDown size={15} className="agent-header-caret" />}
      </button>

      <div className="agent-header-right">
        {plainToggle && (
          /* Do-Not-Disturb toggle — the plain-extension status control.
             On = DND (calls blocked); off = Idle (reachable). Locked mid-call. */
          <button
            type="button"
            role="switch"
            aria-checked={isDnd}
            className={`agent-dnd-toggle ${isDnd ? 'on' : ''}`}
            onClick={() => { if (locked) return; if (isDnd) goIdle(); else setDnd(); }}
            disabled={locked}
            title={isDnd ? t('agent.state.available', 'Available') : t('agent.dnd', 'Do Not Disturb')}
            aria-label={t('agent.dnd', 'Do Not Disturb')}
          >
            <span className="agent-dnd-toggle-track">
              <span className="agent-dnd-toggle-knob">
                {isDnd ? <MinusCircle size={12} /> : <CircleDot size={12} />}
              </span>
            </span>
          </button>
        )}
        {isAgent && (
          /* Queue login/logout — headset (in queue) / headset-off (out). Locked
             mid-call (can't leave the queue while connected). */
          <button
            type="button"
            role="switch"
            aria-checked={queueOn}
            className={`agent-queue-toggle ${queueOn ? 'on' : ''}`}
            onClick={() => { if (locked) return; if (queueOn) logout(); else login(); }}
            disabled={locked}
            title={queueOn ? t('agent.logout', 'Log out') : t('agent.login', 'Log in')}
            aria-label={queueOn ? t('agent.logout', 'Log out') : t('agent.login', 'Log in')}
          >
            <span className="agent-queue-toggle-track">
              <span className="agent-queue-toggle-knob">
                {queueOn ? <Headset size={12} /> : <HeadphoneOff size={12} />}
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
            <RotateCw size={13} />
          </button>
        )}
        {onRefresh && (
          <button type="button" className="agent-header-refresh" onClick={onRefresh} disabled={refreshDisabled} title={t('softphone.refresh', 'Refresh')}>
            <RefreshCw size={13} />
          </button>
        )}
      </div>

      {menuOpen && menuable && (
        <div className="agent-header-menu">
          {/* Return-to-ready / come-online transitions */}
          {dState === 'not_ready' && mItem(Play, t('agent.goReady', 'Ready'), setReady)}
          {!queueOn && mItem(Play, t('agent.goReady', 'Ready'), login)}

          {/* Not-Ready reasons (only meaningful in queue) */}
          {showReasons && (
            <>
              <div className="agent-header-menu-label">{t('agent.notReady', 'Not Ready')}</div>
              {reasons.length === 0 && (
                <div className="agent-header-menu-empty">{t('agent.noReasons', 'No reason codes')}</div>
              )}
              {reasons.map((r) => (
                <button key={r.code} type="button" className="agent-header-menu-item" onClick={() => setNotReady(r.code)}>
                  <span className="agent-header-menu-swatch" style={{ background: r.color || 'var(--text-muted)' }} />
                  <span>{r.label}</span>
                  {!(r.productive === true || r.productive === 1) && (
                    <span className="agent-header-menu-tag">{t('agent.unpaid', 'break')}</span>
                  )}
                </button>
              ))}
            </>
          )}

          {/* Do Not Disturb (from any online / idle state) or, when in DND, go Idle */}
          {showDnd && (
            <>
              {hasAbove && <div className="agent-header-menu-sep" />}
              {mItem(MinusCircle, t('agent.dnd', 'Do Not Disturb'), setDnd)}
            </>
          )}
          {isDnd && mItem(CircleDot, t('agent.state.available', 'Available'), goIdle)}

          {/* Log out (leaves the queue → Idle). Out of queue you use the headset toggle. */}
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
