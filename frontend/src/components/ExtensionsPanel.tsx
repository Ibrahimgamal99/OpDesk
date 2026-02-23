import { motion, AnimatePresence } from 'framer-motion';
import { Phone, PhoneCall, PhoneIncoming, PhoneOff, Pause, Headphones, MessageSquare, Radio, RefreshCw } from 'lucide-react';
import type { Extension, ExtensionStatus } from '../types';
import { getUser, getAllowedMonitorModes } from '../auth';

interface ExtensionsPanelProps {
  extensions: Record<string, Extension>;
  onSupervisorAction: (mode: 'listen' | 'whisper' | 'barge', target: string) => void;
  onSync?: () => void;
}

const statusConfig: Record<ExtensionStatus, { icon: typeof Phone; label: string }> = {
  idle: { icon: Phone, label: 'Idle' },
  ringing: { icon: PhoneIncoming, label: 'Ringing' },
  in_call: { icon: PhoneCall, label: 'In Call' },
  dialing: { icon: PhoneCall, label: 'Dialing' },
  unavailable: { icon: PhoneOff, label: 'Unavailable' },
  on_hold: { icon: Pause, label: 'On Hold' },
};

export function ExtensionsPanel({ extensions, onSupervisorAction, onSync }: ExtensionsPanelProps) {
  const extensionList = Object.values(extensions).sort((a, b) => 
    a.extension.localeCompare(b.extension, undefined, { numeric: true })
  );

  return (
    <div className="panel">
      <div className="panel-header">
        <h2 className="panel-title">
          <Phone size={18} className="panel-title-icon" />
          Extensions ({extensionList.length})
        </h2>
        {onSync && (
          <button type="button" className="btn btn-panel-sync" onClick={onSync} title="Sync all data">
            <RefreshCw size={14} />
            Sync
          </button>
        )}
      </div>
      <div className="panel-content">
        {extensionList.length === 0 ? (
          <div className="empty-state">
            <Phone size={48} className="empty-state-icon" />
            <p className="empty-state-text">No extensions being monitored</p>
          </div>
        ) : (
          <div className="extensions-grid">
            <AnimatePresence>
              {extensionList.map((ext) => (
                <ExtensionCard
                  key={ext.extension}
                  extension={ext}
                  onSupervisorAction={onSupervisorAction}
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
}

function ExtensionCard({ extension, onSupervisorAction }: ExtensionCardProps) {
  const config = statusConfig[extension.status] || statusConfig.unavailable;
  const StatusIcon = config.icon;
  const isInCall = extension.status === 'in_call' || extension.status === 'dialing';
  const isRinging = extension.status === 'ringing';

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.9 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.9 }}
      transition={{ duration: 0.2 }}
      className={`extension-card status-${extension.status}`}
    >
      <div className="extension-header">
        <div className="extension-number">{extension.extension}</div>
        {extension.name && (
          <div className="extension-name">{extension.name}</div>
        )}
      </div>
      
      <div className={`extension-status ${extension.status}`}>
        <StatusIcon size={16} />
        {config.label}
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
                title="Listen (Silent)"
              >
                <Headphones size={18} />
              </button>
            )}
            {allowed.includes('whisper') && (
              <button 
                className="btn btn-icon btn-whisper"
                onClick={(e) => {
                  e.stopPropagation();
                  onSupervisorAction('whisper', extension.extension);
                }}
                title="Whisper to Agent"
              >
                <MessageSquare size={18} />
              </button>
            )}
            {allowed.includes('barge') && (
              <button 
                className="btn btn-icon btn-barge"
                onClick={(e) => {
                  e.stopPropagation();
                  onSupervisorAction('barge', extension.extension);
                }}
                title="Barge In"
              >
                <Radio size={18} />
              </button>
            )}
          </div>
        );
      })()}
    </motion.div>
  );
}

