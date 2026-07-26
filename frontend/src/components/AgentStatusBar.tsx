import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ChevronDown, Play, MinusCircle, CircleDot, Headset, HeadphoneOff, LogOut, PhoneCall,
} from 'lucide-react';
import { fetchWithAuth, getUser } from '../auth';

interface PauseReason {
  id: number;
  code: string;
  label: string;
  productive: number | boolean;
  color?: string | null;
  is_active: number | boolean;
}

/** Live agent presence derived from the WebSocket state (passed from App). */
export interface AgentPresence {
  ext: string;
  dnd: boolean;
  queueOn: boolean;   // logged into at least one queue
  paused: boolean;    // Not-Ready
  reason: string;     // pause reason (when paused)
  onCall: boolean;
}

interface AgentStatusBarProps {
  presence: AgentPresence | null;
  connected: boolean;
}

/**
 * Softphone status control, echo-style: a status selector that opens a menu of
 * transitions (Ready / Not-Ready reasons / DND / Log out), plus two always-on
 * switches on the right — a **DND toggle** and a **queue login/logout** headset
 * toggle. State comes live from the WebSocket (props); actions call the REST
 * endpoints and the socket broadcast flips the toggles back.
 */
export function AgentStatusBar({ presence, connected }: AgentStatusBarProps) {
  const { t } = useTranslation();
  const user = getUser();
  const [reasons, setReasons] = useState<PauseReason[]>([]);
  const [menuOpen, setMenuOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  const ext = presence?.ext || String(user?.extension || '');
  const hasExt = !!ext;

  useEffect(() => {
    if (!hasExt) return;
    fetchWithAuth('/api/pause-reasons?active_only=true')
      .then((r) => (r.ok ? r.json() : { reasons: [] }))
      .then((d) => setReasons((d.reasons || []).filter((x: PauseReason) => x.is_active)))
      .catch(() => { /* ignore */ });
  }, [hasExt]);

  useEffect(() => {
    if (!menuOpen) return;
    const onOutside = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', onOutside, true);
    return () => document.removeEventListener('mousedown', onOutside, true);
  }, [menuOpen]);

  if (!hasExt) return null;

  const dnd = !!presence?.dnd;
  const queueOn = !!presence?.queueOn;
  const paused = !!presence?.paused;
  const onCall = !!presence?.onCall;

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

  // Derived display state (colour + label). Priority: on-call → DND → not-ready → ready → idle.
  const view = onCall
    ? { color: 'var(--status-call, #58a6ff)', label: t('agent.onCall', 'On call') }
    : dnd
      ? { color: 'var(--status-ringing, #f85149)', label: t('agent.dnd', 'Do Not Disturb') }
      : queueOn && paused
        ? { color: '#d29922', label: `${t('agent.notReady', 'Not Ready')}${presence?.reason ? ` · ${presence.reason}` : ''}` }
        : queueOn
          ? { color: 'var(--status-idle, #3fb950)', label: t('agent.ready', 'Ready') }
          : { color: 'var(--text-muted, #6e7681)', label: t('agent.idle', 'Idle') };

  const menuable = !onCall;

  return (
    <div ref={wrapRef} className="agent-status-bar">
      <button
        type="button"
        className="agent-status-bar-main"
        onClick={() => { if (menuable) setMenuOpen((o) => !o); }}
        disabled={!menuable}
        title={ext}
      >
        <span className="agent-status-bar-dot" style={{ background: view.color }} />
        <span className="agent-status-bar-label">{view.label}</span>
        {menuable && <ChevronDown size={14} style={{ color: 'var(--text-muted)', flex: '0 0 auto' }} />}
      </button>

      <div className="agent-status-bar-right">
        {/* DND toggle switch */}
        <button
          type="button" role="switch" aria-checked={dnd}
          className={`agent-toggle${dnd ? ' on' : ''}`}
          style={{ ['--tg' as string]: dnd ? 'var(--status-ringing, #f85149)' : 'var(--status-unavailable, #6e7681)' }}
          onClick={() => { if (!busy && !onCall) setDnd(!dnd); }}
          disabled={busy || onCall}
          title={dnd ? t('agent.dndOff', 'Turn off DND') : t('agent.dnd', 'Do Not Disturb')}
          aria-label={t('agent.dnd', 'Do Not Disturb')}
        >
          <span className="agent-toggle-track">
            <span className="agent-toggle-knob">{dnd ? <MinusCircle size={12} /> : <CircleDot size={12} />}</span>
          </span>
        </button>

        {/* Queue login/logout headset toggle */}
        <button
          type="button" role="switch" aria-checked={queueOn}
          className={`agent-toggle${queueOn ? ' on' : ''}`}
          style={{ ['--tg' as string]: queueOn ? 'var(--status-idle, #3fb950)' : 'var(--status-unavailable, #6e7681)' }}
          onClick={() => { if (!busy && !onCall) (queueOn ? logout() : login()); }}
          disabled={busy || onCall}
          title={queueOn ? t('agent.logout', 'Log out of queues') : t('agent.login', 'Log in to queues')}
          aria-label={queueOn ? t('agent.logout', 'Log out') : t('agent.login', 'Log in')}
        >
          <span className="agent-toggle-track">
            <span className="agent-toggle-knob">{queueOn ? <Headset size={12} /> : <HeadphoneOff size={12} />}</span>
          </span>
        </button>

        <span title={connected ? t('header.softphoneRegistered', 'Registered') : t('header.softphoneNotRegistered', 'Not registered')}
          style={{ display: 'inline-flex', color: connected ? 'var(--status-idle, #3fb950)' : 'var(--status-ringing, #f85149)' }}>
          <PhoneCall size={13} />
        </span>
      </div>

      {menuOpen && menuable && (
        <div className="agent-status-menu">
          {/* Ready / come online */}
          {queueOn && paused && (
            <button type="button" className="agent-status-menu-item" onClick={goReady}>
              <Play size={13} style={{ color: 'var(--status-idle, #3fb950)' }} /> {t('agent.goReady', 'Ready')}
            </button>
          )}
          {!queueOn && (
            <button type="button" className="agent-status-menu-item" onClick={login}>
              <Headset size={13} style={{ color: 'var(--status-idle, #3fb950)' }} /> {t('agent.login', 'Log in to queues')}
            </button>
          )}

          {/* Not-Ready reasons (only meaningful when in a queue) */}
          {queueOn && (
            <>
              <div className="agent-status-menu-label">{t('agent.notReady', 'Not Ready')}</div>
              {reasons.length === 0 && <div className="agent-status-menu-label">{t('agent.noReasons', 'No reason codes')}</div>}
              {reasons.map((r) => (
                <button key={r.code} type="button" className="agent-status-menu-item" onClick={() => goNotReady(r.code)}>
                  <span className="agent-status-menu-swatch" style={{ background: r.color || 'var(--text-muted)' }} />
                  <span>{r.label}</span>
                  {!(r.productive === true || r.productive === 1) && (
                    <span style={{ marginInlineStart: 'auto', fontSize: 10, color: 'var(--text-muted)' }}>{t('agent.break', 'break')}</span>
                  )}
                </button>
              ))}
            </>
          )}

          {/* DND / clear DND */}
          <div className="agent-status-menu-sep" />
          {dnd ? (
            <button type="button" className="agent-status-menu-item" onClick={() => setDnd(false)}>
              <CircleDot size={13} style={{ color: 'var(--status-idle, #3fb950)' }} /> {t('agent.idle', 'Idle')}
            </button>
          ) : (
            <button type="button" className="agent-status-menu-item" onClick={() => setDnd(true)}>
              <MinusCircle size={13} style={{ color: 'var(--status-ringing, #f85149)' }} /> {t('agent.dnd', 'Do Not Disturb')}
            </button>
          )}

          {/* Log out */}
          {queueOn && (
            <>
              <div className="agent-status-menu-sep" />
              <button type="button" className="agent-status-menu-item danger" onClick={logout}>
                <LogOut size={13} /> {t('agent.logout', 'Log out of queues')}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
