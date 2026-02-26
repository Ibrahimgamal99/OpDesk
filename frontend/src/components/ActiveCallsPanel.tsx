import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { PhoneCall, Ear, MicVocal, UserPlus, Phone, RefreshCw, PhoneOff, ArrowRightLeft, User } from 'lucide-react';
import type { CallInfo } from '../types';
import { getUser, getAllowedMonitorModes } from '../auth';

interface ActiveCallsPanelProps {
  calls: Record<string, CallInfo>;
  onSupervisorAction: (mode: 'listen' | 'whisper' | 'barge', target: string) => void;
  onHangup?: (target: string) => void;
  onTransfer?: (source: string, destination: string) => void;
  onTakeOver?: (source: string) => void;
  onSync?: () => void;
}

export function ActiveCallsPanel({ calls, onSupervisorAction, onHangup, onTransfer, onTakeOver, onSync }: ActiveCallsPanelProps) {
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
                    onHangup={onHangup}
                    onTransfer={onTransfer}
                    onTakeOver={onTakeOver}
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
  onHangup?: (target: string) => void;
  onTransfer?: (source: string, destination: string) => void;
  onTakeOver?: (source: string) => void;
}

/** Build the two legs of a call for transfer source selection. */
function getCallLegs(call: CallInfo): Array<{ value: string; label: string }> {
  const legs: Array<{ value: string; label: string }> = [
    { value: call.extension, label: `Extension (${call.extension})` },
  ];
  if (call.talking_to?.trim()) {
    legs.push({ value: call.talking_to.trim(), label: `Talking to (${call.talking_to.trim()})` });
  }
  return legs;
}

function CallRow({ call, onSupervisorAction, onHangup, onTransfer, onTakeOver }: CallRowProps) {
  const stateClass = call.state.toLowerCase().replace(/\s+/g, '_');
  const [showTransfer, setShowTransfer] = useState(false);
  const [transferSource, setTransferSource] = useState('');
  const [transferDest, setTransferDest] = useState('');
  const callLegs = getCallLegs(call);

  const openTransfer = () => {
    setShowTransfer(true);
    setTransferSource(call.extension);
    setTransferDest('');
  };

  const closeTransfer = () => {
    setShowTransfer(false);
    setTransferSource('');
    setTransferDest('');
  };

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
          <div className="call-actions" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
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
              {onTransfer && (
                <button
                  className="btn btn-icon"
                  onClick={() => (showTransfer ? closeTransfer() : openTransfer())}
                  title="Transfer Call"
                >
                  <ArrowRightLeft size={18} />
                </button>
              )}
              {onHangup && (
                <button
                  className="btn btn-icon btn-danger"
                  onClick={() => onHangup(call.extension)}
                  title="End Call"
                >
                  <PhoneOff size={18} />
                </button>
              )}
            </div>
            {onTransfer && showTransfer && (
              <div
                style={{
                  marginTop: 4,
                  padding: 8,
                  borderRadius: 'var(--radius-sm)',
                  background: 'var(--bg-secondary)',
                  border: '1px solid var(--border-primary)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 8,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <label style={{ fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                    Source
                  </label>
                  <select
                    value={transferSource}
                    onChange={(e) => setTransferSource(e.target.value)}
                    className="form-input"
                    style={{ minWidth: 120, fontSize: 12, padding: '4px 6px' }}
                  >
                    {callLegs.map((leg) => (
                      <option key={leg.value} value={leg.value}>
                        {leg.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Option 1:</span>
                  <span style={{ fontSize: 11 }}>Transfer to</span>
                  <input
                    type="text"
                    value={transferDest}
                    onChange={(e) => setTransferDest(e.target.value)}
                    placeholder="Ext or number"
                    className="form-input"
                    style={{ maxWidth: 100, fontSize: 12, padding: '4px 6px' }}
                  />
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={!transferDest.trim()}
                    style={{ fontSize: 11, padding: '4px 8px' }}
                    onClick={() => {
                      const dest = transferDest.trim();
                      if (!dest) return;
                      onTransfer(transferSource, dest);
                      closeTransfer();
                    }}
                  >
                    Transfer
                  </button>
                </div>
                {onTakeOver && getUser()?.extension && call.talking_to?.trim() && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Option 2:</span>
                    <button
                      type="button"
                      className="btn"
                      style={{ fontSize: 11, padding: '4px 8px' }}
                      onClick={() => {
                        onTakeOver(call.talking_to!.trim());
                        closeTransfer();
                      }}
                      title={`Transfer caller (${call.talking_to?.trim()}) to your extension (${getUser()?.extension})`}
                    >
                      <User size={14} style={{ verticalAlign: -2, marginRight: 4 }} />
                      Take over
                    </button>
                  </div>
                )}
                <button
                  type="button"
                  className="btn"
                  style={{ fontSize: 11, padding: '4px 8px', alignSelf: 'flex-start' }}
                  onClick={closeTransfer}
                >
                  Cancel
                </button>
              </div>
            )}
          </div>
        </td>
      )}
    </motion.tr>
  );
}

