import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Phone, PhoneCall, PhoneIncoming, PhoneOff, Pause, Ear, MicVocal, UserPlus, RefreshCw, Loader2, Radio, BellOff, MinusCircle, PauseCircle, CircleDot } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Extension, ExtensionStatus } from '../types';
import { getUser, getAllowedMonitorModes } from '../auth';

/** Live queue presence for an extension (Ready / Not-Ready · reason). */
export interface MemberPresence { queueOn: boolean; paused: boolean; reason: string }

interface ExtensionsPanelProps {
  extensions: Record<string, Extension>;
  /** Extension -> queue presence, so the card reflects agent status like echo. */
  memberPresence?: Record<string, MemberPresence>;
  onSupervisorAction: (mode: 'listen' | 'whisper' | 'barge', target: string) => void;
  onSync?: () => void;
  /** Extension -> webrtc 'yes'|'no'; shown as a read-only badge (toggling now lives in Users → Create/Edit). */
  webrtcMap?: Record<string, string>;
  /** Extensions the current user is allowed to toggle DND for */
  allowedDndExtensions?: Set<string>;
  onDndToggle?: (extension: string, enabled: boolean) => Promise<void>;
}

const STATUS_ICONS: Record<ExtensionStatus, typeof Phone> = {
  idle: Phone,
  ringing: PhoneIncoming,
  in_call: PhoneCall,
  dialing: PhoneCall,
  unavailable: PhoneOff,
  on_hold: Pause,
};

export function ExtensionsPanel({
  extensions,
  memberPresence = {},
  onSupervisorAction,
  onSync,
  webrtcMap = {},
  allowedDndExtensions = new Set(),
  onDndToggle,
}: ExtensionsPanelProps) {
  const { t } = useTranslation();
  const extensionList = Object.values(extensions).sort((a, b) =>
    a.extension.localeCompare(b.extension, undefined, { numeric: true })
  );

  return (
    <div className="panel">
      <div className="panel-header">
        <h2 className="panel-title">
          <Phone size={18} className="panel-title-icon" />
          {t('extensions.title')} ({extensionList.length})
        </h2>
        {onSync && (
          <button type="button" className="btn btn-panel-sync" onClick={onSync} title={t('extensions.syncAll')}>
            <RefreshCw size={14} />
            {t('extensions.sync')}
          </button>
        )}
      </div>
      <div className="panel-content">
        {extensionList.length === 0 ? (
          <div className="empty-state">
            <Phone size={48} className="empty-state-icon" />
            <p className="empty-state-text">{t('extensions.noExtensions')}</p>
          </div>
        ) : (
          <div className="extensions-grid">
            <AnimatePresence>
              {extensionList.map((ext) => (
                <ExtensionCard
                  key={ext.extension}
                  extension={ext}
                  onSupervisorAction={onSupervisorAction}
                  webrtcEnabled={webrtcMap[ext.extension] === 'yes'}
                  canToggleDnd={allowedDndExtensions.has(ext.extension)}
                  onDndToggle={onDndToggle}
                  presence={memberPresence[ext.extension]}
                />
              ))}
            </AnimatePresence>
          </div>
        )}
      </div>
    </div>
  );
}

interface ExtensionCardProps {
  extension: Extension;
  onSupervisorAction: (mode: 'listen' | 'whisper' | 'barge', target: string) => void;
  webrtcEnabled: boolean;
  canToggleDnd: boolean;
  onDndToggle?: (extension: string, enabled: boolean) => Promise<void>;
  presence?: MemberPresence;
}

function ExtensionCard({ extension, onSupervisorAction, webrtcEnabled, canToggleDnd, onDndToggle, presence }: ExtensionCardProps) {
  const { t } = useTranslation();
  const [dndSaving, setDndSaving] = useState(false);
  const isInCall = extension.status === 'in_call' || extension.status === 'dialing';
  const isRinging = extension.status === 'ringing';
  const dndOn = !!extension.dnd;
  const deviceBusy = isInCall || isRinging || extension.status === 'on_hold';

  // Status shown on the card, echo-style. Live telephony wins (a real call/ring must
  // show), then DND, then queue presence (Not-Ready · reason / Ready), then raw device.
  let displayStatus = extension.status as string;
  let StatusIcon = STATUS_ICONS[extension.status] || PhoneOff;
  let statusLabel = t(`extensions.status.${extension.status}`, { defaultValue: extension.status });
  if (!deviceBusy && dndOn) {
    displayStatus = 'dnd';
    StatusIcon = BellOff;
    statusLabel = t('extensions.status.dnd', { defaultValue: 'Do Not Disturb' });
  } else if (!deviceBusy && presence?.queueOn && presence.paused) {
    displayStatus = 'not_ready';
    StatusIcon = PauseCircle;
    const base = t('extensions.status.notReady', { defaultValue: 'Not Ready' });
    statusLabel = presence.reason ? `${base} · ${presence.reason}` : base;
  } else if (!deviceBusy && presence?.queueOn && extension.status !== 'unavailable') {
    displayStatus = 'ready';
    StatusIcon = CircleDot;
    statusLabel = t('extensions.status.ready', { defaultValue: 'Ready' });
  }

  const handleDndClick = async () => {
    // DND cannot be toggled while the extension is on a call.
    if (!canToggleDnd || !onDndToggle || dndSaving || isInCall) return;
    setDndSaving(true);
    try {
      await onDndToggle(extension.extension, !dndOn);
    } finally {
      setDndSaving(false);
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.9 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.9 }}
      transition={{ duration: 0.2 }}
      className={`extension-card status-${displayStatus}`}
    >
      <div className="extension-header" style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="extension-number">{extension.extension}</div>
          {extension.name && (
            <div className="extension-name">{extension.name}</div>
          )}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6, flexShrink: 0 }}>
          {webrtcEnabled && (
            <span className="ext-webrtc-tag" title={t('extensions.webrtcOn')}>
              <Radio size={11} />
              {t('extensions.webrtcBadge')}
            </span>
          )}
          {canToggleDnd && (
            <button
              type="button"
              role="switch"
              aria-checked={dndOn}
              className={`agent-dnd-toggle${dndOn ? ' on' : ''}`}
              style={{ ['--dt-color' as string]: dndOn ? 'var(--accent-danger)' : 'var(--status-unavailable)' }}
              onClick={(e) => { e.stopPropagation(); handleDndClick(); }}
              disabled={dndSaving || isInCall}
              title={dndOn ? t('extensions.dndOn', { defaultValue: 'Do Not Disturb: on' }) : t('extensions.dndOff', { defaultValue: 'Do Not Disturb: off' })}
              aria-label={dndOn ? 'DND on' : 'DND off'}
            >
              <span className="agent-dnd-toggle-track">
                <span className="agent-dnd-toggle-knob">
                  {dndSaving ? <Loader2 size={12} className="spinner" /> : dndOn ? <MinusCircle size={12} /> : <CircleDot size={12} />}
                </span>
              </span>
            </button>
          )}
        </div>
      </div>

      <div className={`extension-status ${displayStatus}`}>
        <StatusIcon size={16} />
        {statusLabel}
      </div>

      {extension.call_info && (isInCall || isRinging) && (
        <div className="extension-info">
          {extension.call_info.talking_to && extension.call_info.talking_to !== 'Unknown' && (
            <div className="extension-info-row">
              <Phone size={14} />
              {extension.call_info.talking_to}
            </div>
          )}
          {extension.call_info.duration && (
            <div className="extension-info-row" style={{ color: 'var(--text-muted)' }}>
              ⏱ {extension.call_info.duration}
            </div>
          )}
        </div>
      )}

      {isInCall && getUser()?.role !== 'agent' && (() => {
        const allowed = getAllowedMonitorModes();
        return (
          <div style={{
            display: 'flex',
            gap: 8,
            marginTop: 16,
            justifyContent: 'center',
          }}>
            {allowed.includes('listen') && (
              <button
                className="btn btn-icon btn-listen"
                onClick={(e) => {
                  e.stopPropagation();
                  onSupervisorAction('listen', extension.extension);
                }}
                title={t('activeCalls.actions.listen')}
              >
                <Ear size={18} />
              </button>
            )}
            {allowed.includes('whisper') && (
              <button
                className="btn btn-icon btn-whisper"
                onClick={(e) => {
                  e.stopPropagation();
                  onSupervisorAction('whisper', extension.extension);
                }}
                title={t('activeCalls.actions.whisper')}
              >
                <MicVocal size={18} />
              </button>
            )}
            {allowed.includes('barge') && (
              <button
                className="btn btn-icon btn-barge"
                onClick={(e) => {
                  e.stopPropagation();
                  onSupervisorAction('barge', extension.extension);
                }}
                title={t('activeCalls.actions.barge')}
              >
                <UserPlus size={18} />
              </button>
            )}
          </div>
        );
      })()}
    </motion.div>
  );
}
