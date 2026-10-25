import { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import {
  Phone,
  PhoneOff,
  PhoneForwarded,
  Trash2,
  Search,
  Delete,
  Pause,
  MicOff,
  ArrowRightLeft,
  ChevronRight,
  ChevronDown,
  Volume2,
  Mic,
  Signal,
  SignalHigh,
  SignalMedium,
  SignalLow,
  SignalZero,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useWebPhoneContext } from '../contexts/WebPhoneContext';
import { useAudioLevels } from '../hooks/useAudioLevels';
import { AgentStatusHeader } from './AgentStatusHeader';
import { Alert } from './ui';
import { useCallOutcome } from '../contexts/CallOutcomeContext';
import { CallStatusBadge } from './CallStatusBadge';

/** How long the last call's status stays on the softphone after hangup. */
const OUTCOME_NOTICE_MS = 15_000;

// Map a live MOS (1–5) to a single signal-strength icon + tone class, matching the
// Call History QoS labels so the live and recorded quality read the same.
function mosSignal(v: number | null): { Icon: LucideIcon; tone: string; labelKey: string } {
  if (v == null) return { Icon: SignalZero,   tone: 'u-fg-muted',   labelKey: 'softphone.qos_na' };
  if (v >= 4.3)  return { Icon: SignalHigh,    tone: 'u-fg-success', labelKey: 'softphone.qos_excellent' };
  if (v >= 4.0)  return { Icon: Signal,        tone: 'u-fg-success', labelKey: 'softphone.qos_good' };
  if (v >= 3.5)  return { Icon: SignalMedium,  tone: 'u-fg-warning', labelKey: 'softphone.qos_fair' };
  return                { Icon: SignalLow,     tone: 'u-fg-danger',  labelKey: 'softphone.qos_poor' };
}

// Softphone log line colour by entry type.
const LOG_TONE: Record<string, string> = {
  error: 'u-fg-danger',
  success: 'u-fg-success',
  warn: 'u-fg-warning',
};

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
    callStats,
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
    connect,
    disconnect,
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

  // The last call's status, shown for a moment after hangup. Keyed on the outcome's seq,
  // so a second identical outcome (two Busy calls in a row) shows again.
  const outcome = useCallOutcome();
  const [expiredOutcomeSeq, setExpiredOutcomeSeq] = useState(0);
  useEffect(() => {
    if (!outcome) return;
    const timer = window.setTimeout(() => setExpiredOutcomeSeq(outcome.seq), OUTCOME_NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [outcome]);
  const outcomeNotice = outcome && outcome.seq !== expiredOutcomeSeq ? outcome.status : null;

  // Force a fresh registration: drop the current (possibly stuck) WebPhone first so
  // connect()'s "already connecting" guard doesn't swallow the attempt.
  const reconnect = () => {
    disconnect('reconnect');
    connect();
  };

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

  const closeTransfer = () => {
    setShowTransfer(false);
    setTransferDest('');
  };

  /** The web phone reports its call status in English (lib/webPhone.ts); show it translated. */
  const callStatusLabel = (s: string): string => {
    if (s === 'Incoming call...') return t('softphone.callStatus.incoming', 'Incoming call...');
    if (s === 'Ringing...') return t('softphone.callStatus.ringing', 'Ringing...');
    if (s === 'In call') return t('common.inCall', 'In call');
    if (s === 'Call error') return t('softphone.callStatus.callError', 'Call error');
    if (s === 'Error') return t('softphone.status.error', 'Error');
    const calling = /^Calling (.+)\.\.\.$/.exec(s);
    if (calling) return t('softphone.callStatus.calling', 'Calling {{number}}...', { number: calling[1] });
    if (s.startsWith('In call with ')) return t('softphone.callStatus.inCallWith', 'In call with {{number}}', { number: s.slice('In call with '.length) });
    return s;
  };

  const header = (withConfigActions: boolean) => (
    <AgentStatusHeader
      title={t('softphone.title')}
      icon={<Phone size={16} className="softphone-header-icon" />}
      isConnected={isConnected}
      onCall={hasActiveCall}
      ringing={!!incomingCall}
      {...(withConfigActions
        ? { onRefresh: refetchConfig, refreshDisabled: configLoading, onReconnect: reconnect }
        : {})}
    />
  );

  // Incoming call screen
  if (incomingCall) {
    return (
      <div className="softphone-panel softphone-incoming">
        {header(false)}
        <div className="softphone-incoming-body">
          <div className="softphone-caller-number">{incomingCall.callerNumber}</div>
          <div className="softphone-caller-name">{incomingCall.callerName || t('common.incomingCall')}</div>
          <div className="softphone-status-row">
            <span className="softphone-status-badge">{callStatusLabel('Incoming call...')}</span>
          </div>
          <div className="softphone-answer-actions">
            <button
              type="button"
              className="softphone-btn-decline"
              onClick={() => incomingCall.reject()}
              title={t('softphone.decline')}
              aria-label={t('softphone.decline')}
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
              aria-label={t('softphone.answer')}
            >
              <Phone size={24} />
            </button>
          </div>
        </div>
        <audio className="u-hidden" ref={remoteAudioRef} autoPlay playsInline />
      </div>
    );
  }

  // In-call view
  const inCallNumber =
    activeCallRemoteNumber ||
    (callStatus.startsWith('In call with ') ? callStatus.slice('In call with '.length) : '') ||
    (isOutgoingRinging ? (dialNumber.trim() || lastDialedNumber) : '');
  const inCallName = activeCallRemoteName || (isOutgoingRinging ? t('softphone.status.connecting') : t('common.incomingCall'));
  const inCallDuration = callDuration || '00:00';

  if (isCallAnswered || isOutgoingRinging) {
    const runTransfer = () => {
      const dest = transferDest.trim();
      if (!dest) return;
      transfer(dest);
      closeTransfer();
    };
    return (
      <div className="softphone-panel softphone-incall">
        {header(false)}
        <div className="softphone-incall-body">
          <div className="softphone-incall-number">{inCallNumber || '—'}</div>
          <div className="softphone-incall-name">{inCallName}</div>
          <div className="softphone-incall-duration">{inCallDuration}</div>
          {isCallAnswered && callStats && callStats.mos != null && (() => {
            const sig = mosSignal(callStats.mos);
            return (
              <div className="softphone-quality" title={t(sig.labelKey)}>
                <div className="softphone-quality-head">
                  <sig.Icon size={16} className={sig.tone} />
                  <span className={`softphone-quality-mos ${sig.tone}`}>
                    {t('softphone.quality_mos')} {callStats.mos.toFixed(1)}
                  </span>
                </div>
                <span className="softphone-quality-detail">
                  {callStats.jitterMs != null && <>{t('softphone.quality_jitter')} {Math.round(callStats.jitterMs)}ms</>}
                  {callStats.packetLossPct != null && <> · {t('softphone.quality_loss')} {callStats.packetLossPct.toFixed(1)}%</>}
                  {callStats.rttMs != null && <> · {t('common.latency')} {Math.round(callStats.rttMs)}ms</>}
                </span>
              </div>
            );
          })()}
          <div className="softphone-audio-levels">
            <div className="softphone-level-item" title={t('softphone.levelSpeaker', 'Speaker (incoming volume)')}>
              <Volume2 size={18} className="softphone-level-icon" />
              <div className="softphone-level-bar-wrap">
                <div
                  className="softphone-level-bar softphone-level-speaker"
                  style={{ '--u-fill': `${Math.round(speakerLevel * 100)}%` } as CSSProperties}
                />
              </div>
            </div>
            <div className="softphone-level-item" title={t('softphone.levelMic', 'Microphone (your voice)')}>
              <Mic size={18} className="softphone-level-icon" />
              <div className="softphone-level-bar-wrap">
                <div
                  className="softphone-level-bar softphone-level-mic"
                  style={{ '--u-fill': `${Math.round(micLevel * 100)}%` } as CSSProperties}
                />
              </div>
            </div>
          </div>
          <div className="softphone-incall-grid">
            <button
              type="button"
              className={`softphone-incall-btn ${isOnHold ? 'softphone-incall-btn-active' : ''}`}
              title={isOnHold ? t('common.resume') : t('softphone.hold')}
              onClick={toggleHold}
            >
              <Pause size={22} />
              <span>{isOnHold ? t('common.resume') : t('softphone.hold')}</span>
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
              className={`softphone-incall-btn ${showTransfer ? 'softphone-incall-btn-active' : ''}`}
              title={t('common.transfer')}
              onClick={() => setShowTransfer((prev) => !prev)}
              aria-expanded={showTransfer}
            >
              <ArrowRightLeft size={22} />
              <span>{t('common.transfer')}</span>
            </button>
          </div>
          {/* Transfer panel: pick a destination, then hand the call over (blind
              transfer via SIP REFER — the only transfer OpDesk's web phone does). */}
          {showTransfer && (
            <div className="softphone-transfer">
              <div className="sp-xfer-head">
                <span className="sp-xfer-title">{t('softphone.transferToExtension')}</span>
                <button type="button" className="btn btn-ghost btn-sm" onClick={closeTransfer}>
                  {t('common.cancel')}
                </button>
              </div>
              <input
                type="text"
                value={transferDest}
                onChange={(e) => setTransferDest(e.target.value)}
                placeholder={t('softphone.transferPlaceholder')}
                aria-label={t('softphone.transferToExtension')}
                className="form-input sp-xfer-input"
              />
              <button
                type="button"
                className="sp-xfer-option"
                disabled={!transferDest.trim()}
                onClick={runTransfer}
              >
                <span className="sp-xfer-option-icon">
                  <PhoneForwarded size={18} />
                </span>
                <span className="sp-xfer-option-text">
                  <span className="sp-xfer-option-label">{t('softphone.blindTransfer', 'Blind transfer')}</span>
                  <span className="sp-xfer-option-desc">
                    {t('softphone.blindTransferHint', 'Sends the caller straight there. You leave the call now.')}
                  </span>
                </span>
                <ChevronRight size={16} className="sp-xfer-option-go" />
              </button>
            </div>
          )}
          <button
            type="button"
            className="softphone-btn-hangup"
            onClick={hangup}
            title={t('common.endCall')}
            aria-label={t('common.endCall')}
          >
            <PhoneOff size={24} />
          </button>
        </div>
        <audio className="u-hidden" ref={remoteAudioRef} autoPlay playsInline />
      </div>
    );
  }

  // Dialpad view
  return (
    <div className="softphone-panel">
      {header(true)}

      <div className="softphone-dial-area">
        <div className="softphone-search-wrap">
          <Search size={16} className="softphone-search-icon" />
          <input
            type="text"
            className="softphone-search-input"
            placeholder={lastDialedNumber || t('softphone.enterNumber')}
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
            onClick={hasActiveCall ? hangup : () => makeCall()}
            disabled={!isConnected || (!hasActiveCall && !dialNumber.trim() && !lastDialedNumber)}
            title={hasActiveCall ? t('common.endCall') : t('softphone.answer')}
            aria-label={hasActiveCall ? t('common.endCall') : t('softphone.answer')}
          >
            <Phone size={26} />
          </button>
          <button
            type="button"
            className="softphone-bottom-btn"
            onClick={backspace}
            disabled={!dialNumber}
            title={t('softphone.backspace')}
            aria-label={t('softphone.backspace')}
          >
            <Delete size={20} />
          </button>
        </div>
      </div>

      {/* Config / Connect strip */}
      {configError && (
        <Alert className="softphone-alert">{configError}</Alert>
      )}
      {status === 'error' && config?.server?.trim().startsWith('wss://') && (() => {
        const s = config.server.trim().replace(/^wss:\/\//, '').split('/')[0];
        const httpsUrl = s ? `https://${s}` : '';
        return httpsUrl ? (
          <p className="softphone-hint u-mt-1h">
            <strong>{t('softphone.firefoxHint.lead', 'Firefox?')}</strong> {t('softphone.firefoxHint.open', 'Open')}{' '}
            <a href={httpsUrl} target="_blank" rel="noopener noreferrer">
              {httpsUrl}
            </a>{' '}
            {t('softphone.firefoxHint.rest', 'in a new tab, accept the certificate, then try again.')}
          </p>
        ) : null;
      })()}
      {!config?.server?.trim() && !configLoading && (
        <p className="softphone-hint">
          {t('softphone.adminServerHint.before', 'Admin: set')} <strong>WEBRTC_PBX_SERVER</strong> {t('softphone.adminServerHint.after', 'in Settings.')}
        </p>
      )}
      {config?.server?.trim() && (!config?.extension?.trim() || !config?.extension_secret?.trim()) && !configLoading && (
        <p className="softphone-hint">
          {t('softphone.credentialsHint.setYour', 'Set your')} <strong>{t('softphone.credentialsHint.extension', 'extension')}</strong> {t('softphone.credentialsHint.and', 'and')} <strong>{t('softphone.credentialsHint.secret', 'extension secret')}</strong> {t('softphone.credentialsHint.byAdmin', '(configured by an administrator).')}
        </p>
      )}
      {/* Call status & duration */}
      {(callStatus || callDuration) && (
        <div className="softphone-call-status">
          <span>{callStatusLabel(callStatus)}</span>
          {callDuration && <span className="softphone-duration">{callDuration}</span>}
        </div>
      )}
      {/* How the last call ended, as the backend decided it at hangup. */}
      {outcomeNotice && !callStatus && !incomingCall && (
        <div className="softphone-call-status" role="status">
          <span>{t('softphone.lastCall', 'Last call')}</span>
          <CallStatusBadge status={outcomeNotice} />
        </div>
      )}

      {/* Log (collapsible) */}
      <div className="softphone-log-section">
        <button
          type="button"
          className="softphone-log-toggle u-row u-gap-1h"
          onClick={() => setShowLog(!showLog)}
          aria-expanded={showLog}
        >
          {t('softphone.log')}
          {showLog ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>
        {showLog && (
          <div className="softphone-log-box">
            <div className="softphone-log-header">
              <span>{t('softphone.log')}</span>
              {logs.length > 0 && (
                <button
                  type="button"
                  className="btn btn-ghost btn-sm btn-icon"
                  onClick={clearLogs}
                  aria-label={t('softphone.clearLog', 'Clear log')}
                  title={t('softphone.clearLog', 'Clear log')}
                >
                  <Trash2 size={14} />
                </button>
              )}
            </div>
            <div className="softphone-log-content">
              {logs.length === 0 ? (
                <span className="u-fg-muted">{t('softphone.noEntries')}</span>
              ) : (
                logs.map((entry, i) => (
                  <div key={i} className={LOG_TONE[entry.type] ?? 'u-fg-secondary'}>
                    [{entry.time}] {entry.message}
                  </div>
                ))
              )}
            </div>
          </div>
        )}
      </div>

      <audio className="u-hidden" ref={remoteAudioRef} autoPlay playsInline />
    </div>
  );
}
