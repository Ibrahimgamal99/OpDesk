import { useState } from 'react';
import type { CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Activity, BellOff, Check, ChevronDown, ChevronRight, Ear, Headset, HeadphoneOff, History,
  MicVocal, MoreHorizontal, Pause, Phone, Play, UserPlus,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { getAllowedMonitorModes } from '../auth';
import type { ActionMessage, AgentStateInfo, Extension, PauseReason } from '../types';
import type { SuperviseMode } from './SuperviseActions';
import { Popover } from './ui';

export interface ExtensionActionsProps {
  extension: Extension;
  agentState?: AgentStateInfo;
  /** Break reasons an agent may be put on (active, not system). Loaded once by the page. */
  reasons: PauseReason[];
  sendAction: (action: ActionMessage) => void;
  onSupervisorAction: (mode: SuperviseMode, target: string) => void;
  onOpenTimeline: (ext: string, name: string) => void;
  onOpenCalls: (ext: string, name: string) => void;
  /** Put the number in the softphone and open it. Absent when this user has no web phone. */
  onCallExtension?: (ext: string) => void;
}

const SUPERVISE: { mode: SuperviseMode; Icon: LucideIcon; key: string }[] = [
  { mode: 'listen', Icon: Ear, key: 'activeCalls.actions.listen' },
  { mode: 'whisper', Icon: MicVocal, key: 'activeCalls.actions.whisper' },
  { mode: 'barge', Icon: UserPlus, key: 'activeCalls.actions.barge' },
];

/**
 * The supervisor's ⋯ menu on an extension card or row: force a break (or switch its reason),
 * back to Available, finish wrap-up, queue login/logout and DND, plus listen/whisper/barge on
 * a live call, the agent's timeline, their calls today, and dialling them.
 *
 * Every state change is the same WebSocket action the agent's own controls send, with
 * `agent: <ext>`; the backend checks the scope (supervisor: their groups; admin: all), tags
 * the change `supervisor`, tells the agent and writes the audit log. During a call the state
 * items lock, as they do for the agent.
 */
export function ExtensionActionsMenu({
  extension, agentState, reasons, sendAction, onSupervisorAction, onOpenTimeline, onOpenCalls, onCallExtension,
}: ExtensionActionsProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [reasonsOpen, setReasonsOpen] = useState(false);
  const ext = extension.extension;
  const name = extension.name || ext;

  const state = agentState?.state;
  const busy = ['in_call', 'dialing', 'ringing', 'on_hold'].includes(extension.status) || state === 'on_call';
  const inCall = extension.status === 'in_call' || extension.status === 'dialing' || extension.status === 'on_hold';
  const online = !!agentState && state !== 'logged_out' && state !== 'break_offline';
  const isDnd = !!agentState?.dnd || !!extension.dnd || state === 'dnd';
  const onBreak = state === 'not_ready';
  const isAgent = !!agentState?.is_agent;
  const queueOn = !!agentState?.queue_logged_in;
  const allowed = getAllowedMonitorModes();

  const close = () => { setOpen(false); setReasonsOpen(false); };
  const act = (msg: Record<string, unknown> & { action: string }) => { sendAction({ ...msg, agent: ext }); close(); };
  const label = t('extActions.menu', 'Actions for {{ext}}', { ext });

  return (
    <Popover
      open={open}
      onOpenChange={(next) => { setOpen(next); if (!next) setReasonsOpen(false); }}
      label={label}
      minWidth={250}
      align="end"
      deps={[reasonsOpen]}
      className="status-menu"
      trigger={({ ref, ...triggerProps }) => (
        <button
          {...triggerProps}
          ref={ref}
          type="button"
          className="btn btn-ghost btn-sm btn-icon ext-more"
          title={label}
          aria-label={label}
          onClick={(e) => { e.stopPropagation(); triggerProps.onClick(); }}
        >
          <MoreHorizontal size={16} />
        </button>
      )}
    >
      <div className="status-menu-head">
        <b>{ext} · {name}</b>
      </div>

      {busy && inCall && SUPERVISE.filter((m) => allowed.includes(m.mode)).map(({ mode, Icon, key }) => (
        <button key={mode} type="button" className="status-menu-item" onClick={() => { onSupervisorAction(mode, ext); close(); }}>
          <Icon size={15} aria-hidden /><span className="status-menu-text">{t(key)}</span>
        </button>
      ))}

      {busy ? (
        <div className="status-menu-note">{t('extActions.lockedOnCall', 'Break, queue and DND unlock when the call ends.')}</div>
      ) : !online ? (
        <div className="status-menu-note">{t('extActions.offline', 'The phone is offline. Its status changes when it registers.')}</div>
      ) : (
        <>
          {state === 'wrap_up' && (
            <button type="button" className="status-menu-item" onClick={() => act({ action: 'agent_wrapup_done' })}>
              <Check size={15} aria-hidden /><span className="status-menu-text">{t('agent.finishWrap', 'Finish wrap-up')}</span>
            </button>
          )}
          {(onBreak || isDnd) && (
            <button
              type="button"
              className="status-menu-item"
              onClick={() => (isDnd
                ? act({ action: 'agent_set_status', status: 'dnd', enabled: false })
                : act({ action: 'agent_set_status', status: 'ready' }))}
            >
              <Play size={15} aria-hidden />
              <span className="status-menu-text">
                {t('agentBoard.setAvailable', 'Set Available')}
                {isDnd && <small>{t('profileStatus.turnsDndOff', 'Turns DND off')}</small>}
              </span>
            </button>
          )}
          {state !== 'wrap_up' && (
            <button type="button" className="status-menu-item" onClick={() => setReasonsOpen((o) => !o)} aria-expanded={reasonsOpen}>
              <Pause size={15} aria-hidden />
              <span className="status-menu-text">
                {onBreak ? t('profileStatus.switchBreak', 'Switch break reason') : t('extActions.forceBreak', 'Set a break')}
                {isDnd && <small>{t('profileStatus.turnsDndOff', 'Turns DND off')}</small>}
              </span>
              {reasonsOpen ? <ChevronDown size={15} aria-hidden /> : <ChevronRight size={15} className="u-flip-rtl" aria-hidden />}
            </button>
          )}
          {reasonsOpen && (
            <div className="status-menu-sub">
              {reasons.length === 0 && <div className="agent-bar-menu-empty">{t('agent.noReasons', 'No reason codes')}</div>}
              {reasons.map((r) => (
                <button
                  key={r.code}
                  type="button"
                  className="status-menu-item"
                  onClick={() => act({ action: 'agent_set_status', status: 'not_ready', reason_code: r.code })}
                  aria-current={onBreak && agentState?.reason_code === r.code ? 'true' : undefined}
                >
                  <span className="status-menu-swatch" style={{ '--ring': r.color || 'var(--text-muted)' } as CSSProperties} />
                  <span className="status-menu-text">{r.label}</span>
                  {onBreak && agentState?.reason_code === r.code && <Check size={15} className="status-menu-tick" aria-hidden />}
                </button>
              ))}
            </div>
          )}
          {isAgent && (
            <button
              type="button"
              className="status-menu-item"
              disabled={isDnd}
              onClick={() => act({ action: queueOn ? 'agent_logout' : 'agent_login' })}
            >
              {queueOn ? <HeadphoneOff size={15} aria-hidden /> : <Headset size={15} aria-hidden />}
              <span className="status-menu-text">
                {queueOn ? t('agent.queueLogout', 'Log out of queues') : t('agent.queueLogin', 'Log in to queues')}
                <small>
                  {isDnd
                    ? t('extActions.queuesDnd', 'Out while DND is on · restored after')
                    : (agentState?.queues || []).join(', ')}
                </small>
              </span>
            </button>
          )}
          <button
            type="button"
            className="status-menu-item"
            onClick={() => act({ action: 'agent_set_status', status: 'dnd', enabled: !isDnd })}
          >
            <BellOff size={15} aria-hidden />
            <span className="status-menu-text">
              {isDnd ? t('agent.dndOff', 'Turn DND off') : t('agent.dndOn', 'Turn on Do Not Disturb')}
              {!isDnd && <small>{t('profileStatus.dndSub', 'Blocks inbound, leaves queues')}</small>}
            </span>
          </button>
        </>
      )}

      <div className="header-profile-divider" />
      <button type="button" className="status-menu-item" onClick={() => { onOpenTimeline(ext, name); close(); }}>
        <Activity size={15} aria-hidden /><span className="status-menu-text">{t('extActions.timeline', 'Open timeline')}</span>
      </button>
      <button type="button" className="status-menu-item" onClick={() => { onOpenCalls(ext, name); close(); }}>
        <History size={15} aria-hidden /><span className="status-menu-text">{t('extActions.calls', 'Calls today')}</span>
      </button>
      {onCallExtension && (
        <button type="button" className="status-menu-item" onClick={() => { onCallExtension(ext); close(); }}>
          <Phone size={15} aria-hidden /><span className="status-menu-text">{t('extActions.call', 'Call {{ext}}', { ext })}</span>
        </button>
      )}
    </Popover>
  );
}
