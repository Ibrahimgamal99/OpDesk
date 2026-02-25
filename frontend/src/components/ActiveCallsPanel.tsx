import { motion, AnimatePresence } from 'framer-motion';
import { PhoneCall, Ear, MicVocal, UserPlus, Phone, RefreshCw } from 'lucide-react';
import type { CallInfo } from '../types';
import { getUser, getAllowedMonitorModes } from '../auth';

interface ActiveCallsPanelProps {
  calls: Record<string, CallInfo>;
  onSupervisorAction: (mode: 'listen' | 'whisper' | 'barge', target: string) => void;
  onSync?: () => void;
}

export function ActiveCallsPanel({ calls, onSupervisorAction, onSync }: ActiveCallsPanelProps) {
  const callList = Object.values(calls).sort((a, b) => 
    a.extension.localeCompare(b.extension, undefined, { numeric: true })
  );

  return (
    <div className="panel">
      <div className="panel-header">
        <h2 className="panel-title">
          <PhoneCall size={18} className="panel-title-icon" />
          Active Calls ({callList.length})
        </h2>
        {onSync && (
          <button type="button" className="btn btn-panel-sync" onClick={onSync} title="Sync all data">
            <RefreshCw size={14} />
            Sync
          </button>
        )}
      </div>
      <div className="panel-content" style={{ padding: 0 }}>
        {callList.length === 0 ? (
          <div className="empty-state">
            <Phone size={48} className="empty-state-icon" />
            <p className="empty-state-text">No active calls</p>
          </div>
        ) : (
          <table className="calls-table">
            <thead>
              <tr>
                <th>Extension</th>
                <th>State</th>
                <th>Talking To</th>
                <th>Duration</th>
                <th>Talk Time</th>
                {getUser()?.role !== 'agent' && <th>Actions</th>}
              </tr>
            </thead>
            <tbody>
              <AnimatePresence>
                {callList.map((call) => (
                  <CallRow
                    key={call.extension}
                    call={call}
                    onSupervisorAction={onSupervisorAction}
                  />
                ))}
              </AnimatePresence>
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

interface CallRowProps {
  call: CallInfo;
  onSupervisorAction: (mode: 'listen' | 'whisper' | 'barge', target: string) => void;
}

function CallRow({ call, onSupervisorAction }: CallRowProps) {
  const stateClass = call.state.toLowerCase().replace(/\s+/g, '_');
  
  return (
    <motion.tr
      initial={{ opacity: 0, y: -10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 10 }}
      transition={{ duration: 0.2 }}
    >
      <td>
        <span className="call-ext">{call.extension}</span>
      </td>
      <td>
        <span className={`call-state ${stateClass}`}>
          {call.state}
        </span>
      </td>
      <td>
        <span className="call-talking-to">
          {call.talking_to || '—'}
        </span>
      </td>
      <td>
        <span className="call-duration">
          {call.duration || '—'}
        </span>
      </td>
      <td>
        <span className="call-duration">
          {call.talk_time || '—'}
        </span>
      </td>
      {getUser()?.role !== 'agent' && (
        <td>
          <div className="call-actions">
            {getAllowedMonitorModes().includes('listen') && (
              <button 
                className="btn btn-icon btn-listen"
                onClick={() => onSupervisorAction('listen', call.extension)}
                title="Listen (Silent)"
              >
                <Ear size={18} />
              </button>
            )}
            {getAllowedMonitorModes().includes('whisper') && (
              <button 
                className="btn btn-icon btn-whisper"
                onClick={() => onSupervisorAction('whisper', call.extension)}
                title="Whisper to Agent"
              >
                <MicVocal size={18} />
              </button>
            )}
            {getAllowedMonitorModes().includes('barge') && (
              <button 
                className="btn btn-icon btn-barge"
                onClick={() => onSupervisorAction('barge', call.extension)}
                title="Barge In"
              >
                <UserPlus size={18} />
              </button>
            )}
          </div>
        </td>
      )}
    </motion.tr>
  );
}

