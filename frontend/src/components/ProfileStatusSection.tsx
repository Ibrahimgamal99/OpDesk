import { useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Bell, BellOff, Check, ChevronDown, ChevronRight, Headset, Lock, User } from 'lucide-react';
import { usePresenceControls } from '../hooks/usePresenceControls';
import { useWebPhoneContext } from '../contexts/WebPhoneContext';
import { fmtTimer } from '../lib/format';

/** The softphone's own call view: a call on this browser locks the controls, as it does there. */
function useOwnCallFlags() {
  const phone = useWebPhoneContext();
  return { onCall: phone.hasActiveCall, ringing: !!phone.incomingCall };
}

/**
 * The header profile button's face: the avatar with a ring in the state colour, the name, and
 * a line under it ("Lunch · 12:04"). Only the ringed avatar shows on a phone (CSS). Without an
 * extension it is the plain avatar and name.
 */
export function ProfileStatusButtonFace({ name }: { name: ReactNode }) {
  const pc = usePresenceControls(useOwnCallFlags());
  const ring = pc.myExt ? `var(${pc.online || pc.ringing ? pc.meta.varName : '--status-unavailable'})` : undefined;
  return (
    <>
      <span
        className={`header-profile-avatar${ring ? ' has-ring' : ''}`}
        style={ring ? ({ '--ring': ring } as CSSProperties) : undefined}
      >
        <User size={16} />
      </span>
      <span className="header-profile-text">
        <span className="header-profile-name">{name}</span>
        {ring && (
          <span
            className={`header-profile-state${pc.breakWindow.pressure ? ` is-${pc.breakWindow.pressure}` : ''}`}
            style={{ '--ring': ring } as CSSProperties}
          >
            {pc.label}
            {pc.online && <span className="u-mono"> · {fmtTimer(pc.elapsed)}</span>}
          </span>
        )}
      </span>
    </>
  );
}

/**
 * Status block of the header profile menu: Available, a Break with a reason, and DND + Queues
 * as one row of switches, the same controls as the softphone header and from the same hook,
 * so the two never disagree. The current state and timer are on the header button itself
 * (ProfileStatusButtonFace), not repeated here. The rules are the backend's (agent-state.ts):
 * a break while in queues pauses the member, DND leaves the queues and restores them when it
 * ends, picking a break ends DND, and everything locks during a call.
 */
export function ProfileStatusSection() {
  const { t } = useTranslation();
  const pc = usePresenceControls(useOwnCallFlags());
  const [reasonsOpen, setReasonsOpen] = useState(false);
  if (!pc.myExt) return null;

  const { actions } = pc;
  const lock = pc.busy;
  const locked = lock || !pc.online;

  const queueNames = pc.queues.join(', ');
  const queueSub = pc.isDnd
    ? t('profileStatus.queuesOutDnd', 'Out while DND is on · restored after')
    : !pc.queueOn
      ? t('profileStatus.queuesOff', 'Not taking queue calls')
      : pc.dState === 'not_ready'
        ? t('profileStatus.queuesPaused', '{{queues}} · paused (on break)', { queues: queueNames || t('nav.queues') })
        : queueNames || t('profileStatus.queuesOn', 'Taking queue calls');

  const isAvailable = pc.dState === 'ready';
  const pickBreak = (code: string) => { actions.setNotReady(code); setReasonsOpen(false); };

  return (
    <div className="profile-status" role="group" aria-label={t('profileStatus.title', 'Status')}>
      <div className="header-profile-section-label">{t('profileStatus.title', 'Status')}</div>

      {lock && (
        <div className="profile-status-lock"><Lock size={13} aria-hidden />{t('agent.lockedOnCall', 'Controls unlock when the call ends')}</div>
      )}

      {pc.dState === 'wrap_up' && !lock ? (
        <button type="button" className="status-menu-item" onClick={actions.finishWrap}>
          <span className="status-menu-dot" style={{ '--ring': 'var(--status-idle)' } as CSSProperties} />
          <span className="status-menu-text">{t('agent.finishWrap', 'Finish wrap-up')}</span>
        </button>
      ) : (
        <button
          type="button"
          className="status-menu-item"
          onClick={pc.isDnd ? () => actions.setDnd(false) : actions.setReady}
          disabled={locked || isAvailable}
          aria-current={isAvailable ? 'true' : undefined}
        >
          <span className="status-menu-dot" style={{ '--ring': 'var(--status-idle)' } as CSSProperties} />
          <span className="status-menu-text">
            {t('agent.state.available', 'Available')}
            {pc.isDnd && <small>{t('profileStatus.turnsDndOff', 'Turns DND off')}</small>}
          </span>
          {isAvailable && <Check size={15} className="status-menu-tick" aria-hidden />}
        </button>
      )}

      <button
        type="button"
        className="status-menu-item"
        onClick={() => setReasonsOpen((o) => !o)}
        disabled={locked || !(pc.canPickBreak || pc.isDnd)}
        aria-expanded={reasonsOpen}
      >
        <span className="status-menu-dot" style={{ '--ring': 'var(--warning)' } as CSSProperties} />
        <span className="status-menu-text">
          {pc.dState === 'not_ready' ? t('profileStatus.switchBreak', 'Switch break reason') : t('agent.state.break', 'Break')}
          <small>{pc.isDnd ? t('agent.pickBreakEndsDnd', 'Break, with a reason (turns DND off)') : t('profileStatus.pickReason', 'Pick a reason')}</small>
        </span>
        {reasonsOpen ? <ChevronDown size={15} aria-hidden /> : <ChevronRight size={15} className="u-flip-rtl" aria-hidden />}
      </button>
      {reasonsOpen && !locked && (
        <div className="status-menu-sub" role="menu">
          {pc.selectable.length === 0 && <div className="agent-bar-menu-empty">{t('agent.noReasons', 'No reason codes')}</div>}
          {pc.selectable.map((r) => (
            <button
              key={r.code}
              type="button"
              role="menuitem"
              className="status-menu-item"
              onClick={() => pickBreak(r.code)}
              aria-current={pc.reasonCode === r.code ? 'true' : undefined}
            >
              <span className="status-menu-swatch" style={{ '--ring': r.color || 'var(--text-muted)' } as CSSProperties} />
              <span className="status-menu-text">{r.label}</span>
              <span className="status-menu-meta u-mono">
                {r.max_break_secs ? `${Math.round(r.max_break_secs / 60)}m` : ''}
                {(r.productive === true || r.productive === 1) ? ` · ${t('profileStatus.paid', 'paid')}` : ''}
              </span>
              {pc.reasonCode === r.code && <Check size={15} className="status-menu-tick" aria-hidden />}
            </button>
          ))}
        </div>
      )}

      <div className="header-profile-divider" />

      {/* DND and Queues side by side, as on/off switches (their explanations are the tooltips). */}
      <div className="header-profile-row">
        <span className="header-profile-row-label"><Bell size={15} />{t('profileStatus.availability', 'Availability')}</span>
        <div className="header-profile-segmented" role="group" aria-label={t('profileStatus.availability', 'Availability')}>
          <button
            type="button"
            className={`header-profile-seg${pc.isDnd ? ' active' : ''}`}
            aria-pressed={pc.isDnd}
            title={t('profileStatus.dndSub', 'Blocks inbound, leaves queues')}
            onClick={() => actions.setDnd(!pc.isDnd)}
            disabled={lock}
          >
            <BellOff size={13} aria-hidden />{t('agent.dndShort', 'DND')}
          </button>
          {pc.isAgent && (
            <button
              type="button"
              className={`header-profile-seg${pc.queueOn && !pc.isDnd ? ' active' : ''}`}
              aria-pressed={pc.queueOn && !pc.isDnd}
              title={queueSub}
              onClick={pc.queueOn ? actions.queueLogout : actions.queueLogin}
              disabled={lock || pc.isDnd}
            >
              <Headset size={13} aria-hidden />{t('nav.queues', 'Queues')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
