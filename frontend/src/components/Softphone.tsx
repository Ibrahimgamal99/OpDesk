import { useState } from 'react';
import {
  Phone,
  PhoneOff,
  RefreshCw,
  Trash2,
  Search,
  Delete,
  Pause,
  MicOff,
  ArrowRightLeft,
  Volume2,
  Mic,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useWebPhoneContext } from '../contexts/WebPhoneContext';
import { useAudioLevels } from '../hooks/useAudioLevels';

const DIAL_PAD = [
  [['1', ''], ['2', 'ABC'], ['3', 'DEF']],
  [['4', 'GHI'], ['5', 'JKL'], ['6', 'MNO']],
  [['7', 'PQRS'], ['8', 'TUV'], ['9', 'WXYZ']],
  [['*', ''], ['0', '+'], ['#', '']],
];

export function Softphone() {
  const { t } = useTranslation();
  const {
    config,
    configLoading,
    configError,
    status,
    callStatus,
    callDuration,
    logs,
    incomingCall,
    activeCallRemoteNumber,
    activeCallRemoteName,
    dialNumber,
    setDialNumber,
    lastDialedNumber,
    isConnected,
    hasActiveCall,
    isCallAnswered,
    isOutgoingRinging,
    makeCall,
    hangup,
    addDigit,
    backspace,
    clearLogs,
    refetchConfig,
    remoteAudioRef,
    localStream,
    remoteStream,
    isMuted,
    toggleMute,
    isOnHold,
    toggleHold,
    transfer,
    unlockRemoteAudio,
  } = useWebPhoneContext();

  const [showLog, setShowLog] = useState(false);
  const [showTransfer, setShowTransfer] = useState(false);
  const [transferDest, setTransferDest] = useState('');
  const { micLevel, speakerLevel } = useAudioLevels(localStream, remoteStream);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    if (e.key === 'Enter') {
      e.preventDefault();
      makeCall();
      return;
    }

    if (e.key === 'Backspace') {
      e.preventDefault();
      backspace();
      return;
    }

    if (/^[0-9*#]$/.test(e.key)) {
      e.preventDefault();
      addDigit(e.key);
    }
  };

  const statusLabel =
    status === 'connecting'
      ? t('softphone.status.connecting')
      : status === 'connected'
        ? t('softphone.status.registered')
        : status === 'error'
          ? t('softphone.status.error')
          : t('softphone.status.notRegistered');

  // Incoming call screen
  if (incomingCall) {
    return (
      <div className="softphone-panel softphone-incoming">
        <div className="softphone-header">
          <Phone size={18} className="softphone-header-icon" />
          <span className="softphone-header-title">{t('softphone.title')}</span>
          <div className="softphone-header-right">
            <span
              className={`softphone-status-dot ${isConnected ? 'registered' : ''}`}
              title={statusLabel}
            />
          </div>
        </div>
        <div className="softphone-incoming-body">
          <div className="softphone-caller-number">{incomingCall.callerNumber}</div>
          <div className="softphone-caller-name">{incomingCall.callerName || t('softphone.incomingCall')}</div>
          <div className="softphone-status-row">
            <button type="button" className="softphone-status-badge" disabled>
              {statusLabel}
            </button>
          </div>
          <div className="softphone-answer-actions">
            <button
              type="button"
              className="softphone-btn-decline"
              onClick={() => incomingCall.reject()}
              title={t('softphone.decline')}
            >
              <PhoneOff size={24} />
            </button>
            <button
              type="button"
              className="softphone-btn-answer"
              onClick={() => {
                // Unlock the remote audio element synchronously before any async
                // SIP/WebRTC operations break the user-gesture chain on iOS Safari.
                unlockRemoteAudio();
                incomingCall.accept();
              }}
              title={t('softphone.answer')}
            >
              <Phone size={24} />
            </button>
          </div>
        </div>
        <audio ref={remoteAudioRef} autoPlay playsInline style={{ display: 'none' }} />
      </div>
    );
  }

  // In-call view
  const inCallNumber =
    activeCallRemoteNumber ||
    (callStatus.startsWith('In call with ') ? callStatus.slice('In call with '.length) : '') ||
    (isOutgoingRinging ? dialNumber : '');
  const inCallName = activeCallRemoteName || (isOutgoingRinging ? t('softphone.status.connecting') : t('softphone.incomingCall'));
  const inCallDuration = callDuration || '00:00';

  if (isCallAnswered || isOutgoingRinging) {
    return (
      <div className="softphone-panel softphone-incall">
        <div className="softphone-header">
          <Phone size={18} className="softphone-header-icon" />
          <span className="softphone-header-title">{t('softphone.title')}</span>
          <div className="softphone-header-right">
            <span
              className={`softphone-status-dot ${isConnected ? 'registered' : ''}`}
              title={statusLabel}
            />
          </div>
        </div>
        <div className="softphone-incall-body">
          <div className="softphone-incall-number">{inCallNumber || '—'}</div>
          <div className="softphone-incall-name">{inCallName}</div>
          <div className="softphone-incall-duration">{inCallDuration}</div>
          <div className="softphone-audio-levels">
            <div className="softphone-level-item" title="Speaker (incoming volume)">
              <Volume2 size={18} className="softphone-level-icon" />
              <div className="softphone-level-bar-wrap">
                <div
                  className="softphone-level-bar softphone-level-speaker"
                  style={{ height: `${Math.round(speakerLevel * 100)}%` }}
                />
              </div>
            </div>
            <div className="softphone-level-item" title="Microphone (your voice)">
              <Mic size={18} className="softphone-level-icon" />
              <div className="softphone-level-bar-wrap">
                <div
                  className="softphone-level-bar softphone-level-mic"
                  style={{ height: `${Math.round(micLevel * 100)}%` }}
                />
              </div>
            </div>
          </div>
          <div className="softphone-incall-grid">
            <button
              type="button"
              className={`softphone-incall-btn ${isOnHold ? 'softphone-incall-btn-active' : ''}`}
              title={isOnHold ? t('softphone.resume') : t('softphone.hold')}
              onClick={toggleHold}
            >
              <Pause size={22} />
              <span>{isOnHold ? t('softphone.resume') : t('softphone.hold')}</span>
            </button>
            <button
              type="button"
              className={`softphone-incall-btn ${isMuted ? 'softphone-incall-btn-active' : ''}`}
              onClick={toggleMute}
              title={isMuted ? t('softphone.unmute') : t('softphone.mute')}
            >
              {isMuted ? <Mic size={22} /> : <MicOff size={22} />}
              <span>{isMuted ? t('softphone.unmute') : t('softphone.mute')}</span>
            </button>
            <button
              type="button"
              className="softphone-incall-btn"
              title={t('softphone.transfer')}
              onClick={() => setShowTransfer((prev) => !prev)}
            >
              <ArrowRightLeft size={22} />
              <span>{t('softphone.transfer')}</span>
            </button>
          </div>
          {showTransfer && (
            <div className="softphone-transfer">
              <span className="softphone-transfer-label">
                {t('softphone.transferToExtension')}
              </span>
              <input
                type="text"
                value={transferDest}
                onChange={(e) => setTransferDest(e.target.value)}
                placeholder={t('softphone.transferPlaceholder')}
                className="form-input softphone-transfer-input"
              />
              <button
                type="button"
                className="btn btn-primary"
                disabled={!transferDest.trim()}
                onClick={() => {
                  const dest = transferDest.trim();
                  if (!dest) return;
                  transfer(dest);
                  setShowTransfer(false);
                  setTransferDest('');
                }}
              >
                {t('softphone.transfer')}
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => {
                  setShowTransfer(false);
                  setTransferDest('');
                }}
              >
                {t('softphone.cancel')}
              </button>
            </div>
          )}
          <button
            type="button"
            className="softphone-btn-hangup"
            onClick={hangup}
            title={t('softphone.endCall')}
          >
            <PhoneOff size={24} />
          </button>
        </div>
        <audio ref={remoteAudioRef} autoPlay playsInline style={{ display: 'none' }} />
      </div>
    );
  }

  // Dialpad view
  return (
    <div className="softphone-panel">
      <div className="softphone-header">
        <Phone size={18} className="softphone-header-icon" />
        <span className="softphone-header-title">{t('softphone.title')}</span>
        <div className="softphone-header-right">
          <span
            className={`softphone-status-dot ${isConnected ? 'registered' : ''}`}
            title={statusLabel}
          />
          <button
            type="button"
            className="softphone-header-btn"
            onClick={refetchConfig}
            disabled={configLoading}
            title={t('softphone.refresh')}
          >
            <RefreshCw size={14} />
          </button>
        </div>
      </div>

      <div className="softphone-dial-area">
        <div className="softphone-search-wrap">
          <Search size={16} className="softphone-search-icon" />
          <input
            type="text"
            className="softphone-search-input"
            placeholder={lastDialedNumber ? lastDialedNumber : t('softphone.enterNumber')}
            value={dialNumber}
            onChange={(e) => setDialNumber(e.target.value.replace(/[^0-9*#+\-\s()]/g, ''))}
            onKeyDown={handleKeyDown}
            disabled={!!incomingCall}
          />
          <span className="softphone-call-using-label">{t('softphone.browser')}</span>
        </div>

        <div className="softphone-dialpad">
          {DIAL_PAD.map((row, rowIdx) => (
            <div key={rowIdx} className="softphone-dialpad-row">
              {row.map(([digit, letters]) => (
                <button
                  key={digit}
                  type="button"
                  className="softphone-dialpad-key"
                  onClick={() => addDigit(digit)}
                  disabled={!isConnected}
                >
                  <span className="softphone-dialpad-digit">{digit}</span>
                  {letters && <span className="softphone-dialpad-letters">{letters}</span>}
                </button>
              ))}
            </div>
          ))}
        </div>

        <div className="softphone-bottom-actions">
          <button
            type="button"
            className="softphone-bottom-btn softphone-call-btn"
            onClick={hasActiveCall ? hangup : makeCall}
            disabled={!isConnected || (!hasActiveCall && !dialNumber.trim() && !lastDialedNumber)}
            title={hasActiveCall ? t('softphone.endCall') : t('softphone.answer')}
          >
            <Phone size={26} />
          </button>
          <button
            type="button"
            className="softphone-bottom-btn"
            onClick={backspace}
            disabled={!dialNumber}
            title={t('softphone.backspace')}
          >
            <Delete size={20} />
          </button>
        </div>
      </div>

      {/* Config / Connect strip */}
      {configError && (
        <div className="softphone-alert error">{configError}</div>
      )}
      {status === 'error' && config?.server?.trim().startsWith('wss://') && (() => {
        const s = config.server.trim().replace(/^wss:\/\//, '').split('/')[0];
        const httpsUrl = s ? `https://${s}` : '';
        return httpsUrl ? (
          <p className="softphone-hint" style={{ marginTop: 6 }}>
            <strong>Firefox?</strong> Open{' '}
            <a href={httpsUrl} target="_blank" rel="noopener noreferrer" style={{ textDecoration: 'underline' }}>
              {httpsUrl}
            </a>{' '}
            in a new tab, accept the certificate, then try again.
          </p>
        ) : null;
      })()}
      {!config?.server?.trim() && !configLoading && (
        <p className="softphone-hint">
          Admin: set <strong>WEBRTC_PBX_SERVER</strong> in Settings.
        </p>
      )}
      {config?.server?.trim() && (!config?.extension?.trim() || !config?.extension_secret?.trim()) && !configLoading && (
        <p className="softphone-hint">
          Set your <strong>extension</strong> and <strong>extension secret</strong> (configured by an administrator).
        </p>
      )}
      {/* Call status & duration */}
      {(callStatus || callDuration) && (
        <div className="softphone-call-status">
          <span>{callStatus}</span>
          {callDuration && <span className="softphone-duration">{callDuration}</span>}
        </div>
      )}

      {/* Log (collapsible) */}
      <div className="softphone-log-section">
        <button
          type="button"
          className="softphone-log-toggle"
          onClick={() => setShowLog(!showLog)}
        >
          {t('softphone.log')} {showLog ? '▼' : '▶'}
        </button>
        {showLog && (
          <div className="softphone-log-box">
            <div className="softphone-log-header">
              <span>{t('softphone.log')}</span>
              {logs.length > 0 && (
                <button type="button" className="btn" onClick={clearLogs} style={{ padding: '4px 8px', fontSize: 11 }}>
                  <Trash2 size={12} />
                </button>
              )}
            </div>
            <div className="softphone-log-content">
              {logs.length === 0 ? (
                <span className="text-muted">{t('softphone.noEntries')}</span>
              ) : (
                logs.map((entry, i) => (
                  <div
                    key={i}
                    style={{
                      color:
                        entry.type === 'error'
                          ? 'var(--accent-danger)'
                          : entry.type === 'success'
                            ? 'var(--accent-success)'
                            : entry.type === 'warn'
                              ? 'var(--accent-warning)'
                              : 'var(--text-secondary)',
                    }}
                  >
                    [{entry.time}] {entry.message}
                  </div>
                ))
              )}
            </div>
          </div>
        )}
      </div>

      <audio ref={remoteAudioRef} autoPlay playsInline style={{ display: 'none' }} />
    </div>
  );
}
