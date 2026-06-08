import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Phone, PhoneCall, PhoneIncoming, PhoneOff, Pause, Ear, MicVocal, UserPlus, RefreshCw, Loader2, Wifi, WifiOff } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Extension, ExtensionStatus } from '../types';
import { getUser, getAllowedMonitorModes } from '../auth';

interface ExtensionsPanelProps {
  extensions: Record<string, Extension>;
  onSupervisorAction: (mode: 'listen' | 'whisper' | 'barge', target: string) => void;
  onSync?: () => void;
  /** Extension -> webrtc 'yes'|'no' for extensions current user can manage */
  webrtcMap?: Record<string, string>;
  /** Extensions the current user is allowed to toggle WebRTC for */
  allowedWebrtcExtensions?: Set<string>;
  onWebrtcToggle?: (extension: string, enabled: boolean) => Promise<void>;
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
  onSupervisorAction,
  onSync,
  webrtcMap = {},
  allowedWebrtcExtensions = new Set(),
  onWebrtcToggle,
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
                  canToggleWebrtc={allowedWebrtcExtensions.has(ext.extension)}
                  onWebrtcToggle={onWebrtcToggle}
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
  canToggleWebrtc: boolean;
  onWebrtcToggle?: (extension: string, enabled: boolean) => Promise<void>;
}

function ExtensionCard({ extension, onSupervisorAction, webrtcEnabled, canToggleWebrtc, onWebrtcToggle }: ExtensionCardProps) {
  const { t } = useTranslation();
  const [webrtcSaving, setWebrtcSaving] = useState(false);
  const StatusIcon = STATUS_ICONS[extension.status] || PhoneOff;
  const statusLabel = t(`extensions.status.${extension.status}`, { defaultValue: extension.status });
  const isInCall = extension.status === 'in_call' || extension.status === 'dialing';
  const isRinging = extension.status === 'ringing';

  const handleWebrtcClick = async () => {
    if (!canToggleWebrtc || !onWebrtcToggle || webrtcSaving) return;
    setWebrtcSaving(true);
    try {
      await onWebrtcToggle(extension.extension, !webrtcEnabled);
    } finally {
      setWebrtcSaving(false);
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.9 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.9 }}
      transition={{ duration: 0.2 }}
      className={`extension-card status-${extension.status}`}
    >
      <div className="extension-header" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="extension-number">{extension.extension}</div>
          {extension.name && (
            <div className="extension-name">{extension.name}</div>
          )}
        </div>
        {canToggleWebrtc && (
          <button
            type="button"
            className="btn btn-icon"
            onClick={(e) => { e.stopPropagation(); handleWebrtcClick(); }}
            disabled={webrtcSaving}
            title={webrtcEnabled ? t('extensions.webrtcEnabled') : t('extensions.webrtcDisabled')}
            style={{ flexShrink: 0, padding: 4 }}
            aria-label={webrtcEnabled ? t('extensions.webrtcOn') : t('extensions.webrtcOff')}
          >
            {webrtcSaving ? (
              <Loader2 size={18} className="spinner" />
            ) : webrtcEnabled ? (
              <Wifi size={18} style={{ color: 'var(--status-idle)' }} />
            ) : (
              <WifiOff size={18} style={{ color: 'var(--text-muted)' }} />
            )}
          </button>
        )}
      </div>

      <div className={`extension-status ${extension.status}`}>
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
