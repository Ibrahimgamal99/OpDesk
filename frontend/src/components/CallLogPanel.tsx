import { useState, useEffect, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ArrowUpDown, Phone, Download, Play, Pause,
  Loader2, BarChart3, Route,
  PhoneIncoming, PhoneOutgoing, ListOrdered, PhoneCall, Share2, PhoneOff, PhoneMissed,
  Activity, History, ArrowLeftRight, ArrowUpRight, ArrowDownLeft, Gauge, RefreshCw,
  Ear, Mic, MicOff, Users, Music, Clock,
  Star, CheckCircle2, AlertTriangle, XCircle, type LucideIcon,
} from 'lucide-react';
import {
  Modal, Dropdown, SearchInput, Alert, Pagination, Page, Toolbar, Table, EmptyState,
  Badge, Loading, type Column, type DropdownOption,
} from './ui';
import type { CallLogRecord, QoSData, CallJourneyEvent } from '../types';
import { getAuthHeaders, fetchWithAuth } from '../auth';
import { PageRange } from './PageRange';
import type { DateRange } from './analyticsUtils';
import { fmtTimer } from '../lib/format';
import { countBy, presentOptions, showFilter } from '../lib/filters';
import { StatCard, StatRow } from './FigureCards';
import '../styles/work.css';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type TFunction = (key: string, options?: Record<string, unknown>) => string;

/** A call's length, in the one clock format live calls use (`mm:ss`, `hh:mm:ss`). */
function formatDuration(seconds: number): string {
  return fmtTimer(seconds);
}

function formatCallDate(dateStr: string, t: TFunction): { date: string; time: string } {
  const d = new Date(dateStr);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const callDay = new Date(d.getFullYear(), d.getMonth(), d.getDate());

  let dateLabel: string;
  if (callDay.getTime() === today.getTime()) {
    dateLabel = t('callLog.today');
  } else if (callDay.getTime() === yesterday.getTime()) {
    dateLabel = t('callLog.yesterday');
  } else {
    dateLabel = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  const timeLabel = d.toLocaleTimeString(undefined, {
    hour: '2-digit', minute: '2-digit', hour12: false
  });

  return { date: dateLabel, time: timeLabel };
}

function parseQoS(raw: string | null): QoSData | null {
  if (!raw || !raw.startsWith('QoS:')) return null;
  try {
    // Format: QoS:ssrc=..;themssrc=..;lp=..;rxjitter=..;rxcount=..;txjitter=..;txcount=..;rlp=..;rtt=..;rxmes=..;txmes=..,Caller:1234
    const parts = raw.split(',');
    const qosPart = parts[0].replace('QoS:', '');
    const callerPart = parts.find(p => p.startsWith('Caller:'));

    const metrics: Record<string, string> = {};
    qosPart.split(';').forEach(pair => {
      const [k, v] = pair.split('=');
      if (k && v !== undefined) metrics[k.trim()] = v.trim();
    });

    return {
      rxJitter: metrics.rxjitter ? parseFloat(metrics.rxjitter) : null,
      txJitter: metrics.txjitter ? parseFloat(metrics.txjitter) : null,
      rxPackets: metrics.rxcount ? parseInt(metrics.rxcount) : null,
      txPackets: metrics.txcount ? parseInt(metrics.txcount) : null,
      rxLoss: metrics.rlp ? parseFloat(metrics.rlp) : (metrics.lp ? parseFloat(metrics.lp) : null),
      txLoss: metrics.lp ? parseFloat(metrics.lp) : null,
      rxMes: metrics.rxmes ? parseFloat(metrics.rxmes) : null,
      txMes: metrics.txmes ? parseFloat(metrics.txmes) : null,
      rtt: metrics.rtt ? parseFloat(metrics.rtt) : null,
      caller: callerPart ? callerPart.replace('Caller:', '').trim() : null,
      raw,
    };
  } catch {
    return null;
  }
}

// Normalize MES to ensure it's within 0-100 range
function normalizeMesTo100(mes: number | null): number | null {
  if (mes === null) return null;
  return Math.max(0, Math.min(100, mes));
}

/** A QoS figure's verdict. Painted with the matching `u-fg-*` utility, never an inline colour. */
type Quality = 'success' | 'warning' | 'danger' | 'muted';

function getMesLabel(mes: number | null, t: TFunction): { Icon: LucideIcon | null; label: string; quality: Quality } {
  const normalized = normalizeMesTo100(mes);
  if (normalized === null) return { Icon: null, label: t('callLog.na'), quality: 'muted' };
  if (normalized >= 80) return { Icon: Star, label: t('callLog.audioQuality.excellent'), quality: 'success' };
  if (normalized >= 72) return { Icon: CheckCircle2, label: t('callLog.audioQuality.good'), quality: 'success' };
  if (normalized >= 60) return { Icon: AlertTriangle, label: t('callLog.audioQuality.fair'), quality: 'warning' };
  return { Icon: XCircle, label: t('callLog.audioQuality.poor'), quality: 'danger' };
}

function getJitterQuality(jitter: number | null): Quality {
  if (jitter === null) return 'muted';
  if (jitter < 20) return 'success';
  if (jitter < 50) return 'warning';
  return 'danger';
}

function getLossQuality(loss: number | null): Quality {
  if (loss === null) return 'muted';
  if (loss < 1) return 'success';
  if (loss < 5) return 'warning';
  return 'danger';
}

function calculateLostPackets(lossPercent: number | null, totalPackets: number | null): number | null {
  if (lossPercent === null || totalPackets === null) return null;
  return Math.round((lossPercent / 100) * totalPackets);
}

function getOverallScore(qos: QoSData, t: TFunction): { label: string; quality: Quality; color: string } {
  const scores: number[] = [];
  const rxNormalized = normalizeMesTo100(qos.rxMes);
  const txNormalized = normalizeMesTo100(qos.txMes);
  if (rxNormalized !== null) scores.push(rxNormalized);
  if (txNormalized !== null) scores.push(txNormalized);
  if (scores.length === 0) return { label: t('callLog.na'), quality: 'muted', color: 'var(--text-muted)' };
  const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
  if (avg >= 80) return { label: t('callLog.score.high'), quality: 'success', color: 'var(--accent-success)' };
  if (avg >= 60) return { label: t('callLog.score.medium'), quality: 'warning', color: 'var(--accent-warning)' };
  return { label: t('callLog.score.low'), quality: 'danger', color: 'var(--accent-danger)' };
}

function getAudioSummary(qos: QoSData, t: TFunction): string {
  const describe = (mes: number | null, directionKey: 'incoming' | 'outgoing') => {
    const normalized = normalizeMesTo100(mes);
    if (normalized === null) return '';
    const direction = t(`callLog.direction.${directionKey}`);
    if (normalized >= 80) return t('callLog.audioDesc.perfect', { direction });
    if (normalized >= 72) return t('callLog.audioDesc.veryGood', { direction });
    if (normalized >= 60) return t('callLog.audioDesc.fair', { direction });
    return t('callLog.audioDesc.poor', { direction });
  };
  const parts = [describe(qos.rxMes, 'incoming'), describe(qos.txMes, 'outgoing')].filter(Boolean);
  return parts.join('; ') || t('callLog.audioDesc.noData');
}

// Keyed on OpDesk's canonical outcome enum (backend/call_log.py CALL_OUTCOMES). Colours
// follow the scheme in styles/variables.css that the shared callStatus.ts uses: green =
// answered, amber = the callee did not take it, burnt = could not be placed, red = picked
// up but never reached a person.
const STATUS_COLOR: Record<string, string> = {
  ANSWERED:     'var(--accent-success)',
  NO_ANSWER:    'var(--accent-warning)',
  BUSY:         'var(--accent-warning)',
  FAILURE:      'var(--accent-fault)',
  ABANDONED:    'var(--accent-danger)',
  CANCELED:     'var(--text-secondary)',
  DROPPED:      'var(--status-dropped)',
  OUT_OF_REACH: 'var(--text-muted)',
  in_progress:  'var(--accent-primary)',
};
const STATUS_ORDER = Object.keys(STATUS_COLOR);

const statusColor = (s: string) => STATUS_COLOR[s] ?? 'var(--text-muted)';
const statusLabel = (t: TFunction, s: string) => t(`callLog.status.${s}`, { defaultValue: s });

function CallLogStatusBadge({ status }: { status: string }) {
  const { t } = useTranslation();
  return <Badge color={statusColor(status)}>{statusLabel(t, status)}</Badge>;
}

const ITEMS_PER_PAGE = 25;

/** A call party: the number, and the contact name as one truncated secondary line. */
function PartyCell({ number, name }: { number: string; name: string | null }) {
  return (
    <div className="cl-party">
      <span className="cl-phone">{number || '—'}</span>
      {name && <span className="cl-party-name" title={name}>{name}</span>}
    </div>
  );
}

/** A call's direction (or, for a ChanSpy row, its supervision mode) as a category label. */
function CallDirectionBadge({ call }: { call: Pick<CallLogRecord, 'is_supervision' | 'supervision' | 'call_type'> }) {
  const { t } = useTranslation();
  if (call.is_supervision) {
    const mode = call.supervision?.mode;
    return mode === 'whisper' ? <Badge tone="info" icon={<Mic size={14} />}>{t('callLog.supervision.WHISPER')}</Badge>
      : mode === 'barge' ? <Badge tone="info" icon={<Users size={14} />}>{t('callLog.supervision.BARGE')}</Badge>
      : <Badge tone="info" icon={<Ear size={14} />}>{t('callLog.supervision.LISTEN')}</Badge>;
  }
  if (call.call_type === 'IN') return <Badge tone="info" icon={<PhoneIncoming size={14} />}>{t('callLog.typeShort.IN', 'IN')}</Badge>;
  if (call.call_type === 'OUT') return <Badge tone="info" icon={<PhoneOutgoing size={14} />}>{t('callLog.typeShort.OUT', 'OUT')}</Badge>;
  if (call.call_type === 'INTERNAL') return <Badge tone="info" icon={<ArrowLeftRight size={14} />}>{t('callLog.typeShort.INT', 'INT')}</Badge>;
  return call.call_type ? <Badge tone="info">{call.call_type}</Badge> : <>—</>;
}

// ---------------------------------------------------------------------------
// Audio Player Component
// ---------------------------------------------------------------------------
interface AudioPlayerProps {
  recordingPath: string | null;
  recordingFile: string | null;
  onVadClick?: () => void;
}

function AudioPlayer({ recordingPath, recordingFile, onVadClick }: AudioPlayerProps) {
  const { t } = useTranslation();
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [errored, setErrored] = useState(false);

  if (!recordingPath || errored) {
    return (
      <span className="cl-no-recording u-inline-row u-gap-1" title={t('callLog.noRecording')}>
        <Music size={14} aria-hidden />
        <span className="ui-visually-hidden">{t('callLog.noRecording')}</span>
      </span>
    );
  }

  const token = getAuthHeaders().Authorization?.replace(/^Bearer\s+/i, '') || '';
  const audioUrl = `/api/recordings/${encodeURIComponent(recordingPath)}${token ? `?token=${encodeURIComponent(token)}` : ''}`;

  const togglePlay = () => {
    const el = audioRef.current;
    if (!el) return;
    if (playing) {
      el.pause();
    } else {
      el.play().catch(() => { setErrored(true); });
    }
  };

  const handleTimeUpdate = () => {
    if (audioRef.current) setCurrentTime(audioRef.current.currentTime);
  };
  const handleLoadedMetadata = () => {
    if (audioRef.current) {
      const d = audioRef.current.duration;
      if (!isFinite(d) || isNaN(d) || d <= 0) {
        setErrored(true);
        return;
      }
      setDuration(d);
      setLoaded(true);
    }
  };
  const handleEnded = () => setPlaying(false);
  const handlePlay = () => setPlaying(true);
  const handlePause = () => setPlaying(false);
  const handleError = () => setErrored(true);

  const seekTo = (seconds: number) => {
    if (!audioRef.current || !duration) return;
    audioRef.current.currentTime = Math.max(0, Math.min(duration, seconds));
  };

  const handleSeek = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    seekTo(pct * duration);
  };

  // The scrubber is a slider, so it answers the keys a slider is expected to answer.
  const handleSeekKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!duration) return;
    const step = e.shiftKey ? 30 : 5;
    const keys: Record<string, number> = {
      ArrowLeft: currentTime - step,
      ArrowRight: currentTime + step,
      ArrowDown: currentTime - step,
      ArrowUp: currentTime + step,
      Home: 0,
      End: duration,
    };
    if (!(e.key in keys)) return;
    e.preventDefault();
    seekTo(keys[e.key]);
  };

  const progress = duration > 0 ? (currentTime / duration) * 100 : 0;
  // The seek bar takes room, so only the row being listened to shows it.
  const active = loaded && (playing || currentTime > 0);
  const fileHint = recordingFile ? ` — ${recordingFile}` : '';

  return (
    <div className="cl-rec">
      <audio
        ref={audioRef}
        src={audioUrl}
        preload="metadata"
        onTimeUpdate={handleTimeUpdate}
        onLoadedMetadata={handleLoadedMetadata}
        onEnded={handleEnded}
        onPlay={handlePlay}
        onPause={handlePause}
        onError={handleError}
      />
      <div className="cl-rec-buttons">
        <button
          type="button"
          className="btn btn-ghost btn-sm btn-icon"
          onClick={togglePlay}
          title={`${playing ? t('callLog.pause') : t('callLog.play')}${fileHint}`}
          aria-label={playing ? t('callLog.pause') : t('callLog.play')}
        >
          {playing ? <Pause size={14} /> : <Play size={14} />}
        </button>
        <a
          className="btn btn-ghost btn-sm btn-icon"
          href={audioUrl}
          download={recordingFile || 'recording'}
          title={`${t('callLog.download')}${fileHint}`}
          aria-label={t('callLog.download')}
          onClick={e => e.stopPropagation()}
        >
          <Download size={14} />
        </a>
        {recordingFile && onVadClick && (
          <button
            type="button"
            className="btn btn-ghost btn-sm btn-icon"
            title={t('callLog.recordingVadTitle', '{{file}} — click to view voice activity', { file: recordingFile })}
            aria-label={t('callLog.vad.title', 'Voice Activity')}
            onClick={e => { e.stopPropagation(); onVadClick(); }}
          >
            <Activity size={14} />
          </button>
        )}
      </div>
      {active && (
        <div className="cl-rec-progress">
          <div
            className="cl-audio-progress-wrap"
            role="slider"
            tabIndex={0}
            aria-label={t('callLog.seek', 'Seek')}
            aria-valuemin={0}
            aria-valuemax={Math.round(duration) || 0}
            aria-valuenow={Math.round(currentTime) || 0}
            aria-valuetext={`${fmtTimer(currentTime)} / ${fmtTimer(duration)}`}
            onClick={handleSeek}
            onKeyDown={handleSeekKey}
          >
            <div className="cl-audio-progress-bg">
              <div className="cl-audio-progress-fill u-fill-x" style={{ '--u-fill': `${progress}%` } as React.CSSProperties} />
            </div>
          </div>
          <span className="cl-audio-time u-mono">
            {fmtTimer(currentTime)} / {fmtTimer(duration)}
          </span>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// QOS Modal Component
// ---------------------------------------------------------------------------
interface QoSModalProps {
  qos: QoSData;
  call: CallLogRecord;
  onClose: () => void;
}

function QoSModal({ qos, call, onClose }: QoSModalProps) {
  const { t } = useTranslation();
  const overall = getOverallScore(qos, t);
  const txMesInfo = getMesLabel(qos.txMes, t);
  const rxMesInfo = getMesLabel(qos.rxMes, t);

  const directions = [
    { key: 'tx', title: t('callLog.qos.audioFromSystem'), Icon: ArrowUpRight,
      mes: qos.txMes, info: txMesInfo, jitter: qos.txJitter, loss: qos.txLoss, packets: qos.txPackets },
    { key: 'rx', title: t('callLog.qos.audioToSystem'), Icon: ArrowDownLeft,
      mes: qos.rxMes, info: rxMesInfo, jitter: qos.rxJitter, loss: qos.rxLoss, packets: qos.rxPackets },
  ];

  return (
    <Modal
      open
      onClose={onClose}
      title={t('callLog.qos.title')}
      icon={<Gauge size={16} />}
      width="wide"
      className="cl-qos-modal"
      footer={<button type="button" className="btn" onClick={onClose}>{t('callLog.qos.close')}</button>}
    >
      <div className="cl-qos-body">
        {/* Hero: overall score, participants, plain-language summary */}
        <div className="cl-qos-hero" style={{ '--qos-accent': overall.color } as React.CSSProperties}>
          <div className="cl-qos-hero-top">
            <div className="cl-qos-hero-score">
              <span className="cl-qos-hero-label">{t('callLog.qos.overallScore')}</span>
              <span className={`cl-qos-hero-value u-fg-${overall.quality}`}>{overall.label}</span>
            </div>
            <div className="cl-qos-participants">
              <span className="cl-qos-badge agent">{call.extension || t('callLog.qos.agent')}</span>
              <ArrowLeftRight size={14} className="cl-qos-arrow" />
              <span className="cl-qos-badge customer">
                {qos.caller || call.phone_number || t('callLog.qos.customer')}
              </span>
            </div>
          </div>
          <p className="cl-qos-text">{getAudioSummary(qos, t)}</p>
        </div>

        {/* Per-direction audio quality cards */}
        <div className="cl-qos-cards">
          {directions.map(d => {
            const norm = normalizeMesTo100(d.mes);
            const lost = calculateLostPackets(d.loss, d.packets);
            return (
              <div className="cl-qos-card" key={d.key}>
                <div className="cl-qos-card-head">
                  <d.Icon size={14} />
                  <span>{d.title}</span>
                </div>
                <div className="cl-qos-card-score">
                  {d.mes !== null ? (<>
                    {d.info.Icon && <d.info.Icon size={14} className={`u-fg-${d.info.quality}`} aria-hidden />}
                    <span className={`cl-qos-card-num u-fg-${d.info.quality}`}>{norm?.toFixed(1) ?? '—'}</span>
                    <span className={`cl-qos-card-qual u-fg-${d.info.quality}`}>{d.info.label}</span>
                  </>) : <span className="cl-qos-card-num">—</span>}
                </div>
                <div className="cl-qos-card-metrics">
                  <div className="cl-qos-mrow">
                    <span className="cl-qos-mlabel">{t('callLog.qos.jitter')}</span>
                    <span className={`cl-qos-mval u-fg-${getJitterQuality(d.jitter)}`}>
                      {d.jitter !== null ? `${d.jitter.toFixed(2)} ms` : '—'}
                    </span>
                  </div>
                  <div className="cl-qos-mrow">
                    <span className="cl-qos-mlabel">{t('callLog.qos.dataLoss')}</span>
                    <span className={`cl-qos-mval u-fg-${getLossQuality(d.loss)}`}>
                      {lost !== null ? t('callLog.qos.packets', { count: lost }) : '—'}
                    </span>
                  </div>
                  <div className="cl-qos-mrow">
                    <span className="cl-qos-mlabel">{t('callLog.qos.totalPackets')}</span>
                    <span className="cl-qos-mval">{d.packets ?? '—'}</span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {/* Round-trip time */}
        <div className="cl-qos-net">
          <Gauge size={15} />
          <span className="cl-qos-net-label">{t('callLog.qos.rtt')}</span>
          <span className="cl-qos-net-value">{qos.rtt !== null ? `${qos.rtt.toFixed(2)} ms` : '—'}</span>
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Call Journey Modal — timeline, icons, structured details
// ---------------------------------------------------------------------------
const JOURNEY_EVENT_CONFIG: Record<string, { icon: React.ReactNode; color: string }> = {
  INBOUND:     { icon: <PhoneIncoming size={16} />, color: 'var(--journey-inbound)' },
  OUTBOUND:    { icon: <PhoneOutgoing size={16} />, color: 'var(--journey-outbound)' },
  QUEUE_ENTER: { icon: <ListOrdered size={16} />,   color: 'var(--journey-queue)' },
  RING:        { icon: <Phone size={16} />,         color: 'var(--journey-ring)' },
  ANSWER:      { icon: <PhoneCall size={16} />,     color: 'var(--journey-answer)' },
  NO_ANSWER:   { icon: <PhoneMissed size={16} />,   color: 'var(--journey-no-answer)' },
  TRANSFER:    { icon: <Share2 size={16} />,        color: 'var(--journey-transfer)' },
  HANGUP:      { icon: <PhoneOff size={16} />,      color: 'var(--journey-hangup)' },
};

interface CallJourneyModalProps {
  call: CallLogRecord;
  journey: CallJourneyEvent[];
  onClose: () => void;
}

function CallJourneyModal({ call, journey, onClose }: CallJourneyModalProps) {
  const { t } = useTranslation();

  const summary = formatCallDate(call.calldate, t);
  const getEventConfig = (eventType: string) =>
    JOURNEY_EVENT_CONFIG[eventType] ?? { icon: <Route size={16} />, color: 'var(--text-muted)' };
  const getEventLabel = (eventType: string) =>
    t(`callLog.journey.events.${eventType}`, { defaultValue: eventType.replace(/_/g, ' ') });

  const stepCount = journey.length;
  const stepsLabel = t(stepCount === 1 ? 'callLog.journey.steps' : 'callLog.journey.stepsPlural', { count: stepCount });

  return (
    <Modal
      open
      onClose={onClose}
      title={t('callLog.journey.title')}
      icon={<Route size={16} />}
      width="md"
      className="cl-journey-modal"
      headerAside={<span className="cl-journey-step-count">{stepsLabel}</span>}
      footer={<button type="button" className="btn" onClick={onClose}>{t('callLog.qos.close')}</button>}
    >
      <div className="cl-journey-body">
        <div className="cl-journey-summary">
          <div className="cl-journey-summary-row">
            <span className="cl-journey-summary-label">{t('callLog.journey.contact')}</span>
            <span className="cl-journey-summary-value cl-journey-phone">{call.phone_number || call.src || '—'}</span>
          </div>
          <div className="cl-journey-summary-meta">
            <span className="cl-journey-date">{summary.date}</span>
            <span className="cl-journey-dot" aria-hidden>·</span>
            <span className="cl-journey-time-summary">{summary.time}</span>
            {call.talk != null && call.talk > 0 && (
              <>
                <span className="cl-journey-dot" aria-hidden>·</span>
                <span className="cl-journey-duration u-mono">{t('callLog.journey.talkDuration', { duration: formatDuration(call.talk) })}</span>
              </>
            )}
          </div>
          <div className="cl-journey-badges">
            <CallDirectionBadge call={call} />
            {call.extension && (
              <Badge tone="info">{t('callLog.journey.agent', { id: call.extension })}</Badge>
            )}
          </div>
        </div>

        <div className="cl-journey-timeline-wrap">
          {journey.length === 0 ? (
            <EmptyState icon={Route} size="sm" title={t('callLog.journey.noData')} />
          ) : (
            <ul className="cl-journey-timeline" role="list">
              {journey.map((e, i) => {
                const cf = getEventConfig(e.event);
                const isLast = i === journey.length - 1;
                return (
                  <li
                    key={i}
                    className="cl-journey-timeline-item"
                    style={{ '--journey-color': cf.color, '--u-color': cf.color } as React.CSSProperties}
                  >
                    <div className="cl-journey-timeline-marker">
                      <span className="cl-journey-dot-icon u-fg-var">{cf.icon}</span>
                      {!isLast && <span className="cl-journey-timeline-line" />}
                    </div>
                    <div className="cl-journey-timeline-content">
                      <div className="cl-journey-event-time">{e.time}</div>
                      <div className="cl-journey-event-card">
                        <span className="cl-journey-event-name u-fg-var">{getEventLabel(e.event)}</span>
                        <div className="cl-journey-event-details">
                          {e.agent != null && <span className="cl-journey-detail-pill">{t('callLog.journey.agent', { id: e.agent })}</span>}
                          {e.queue != null && <span className="cl-journey-detail-pill">{t('callLog.journey.queue', { id: e.queue })}</span>}
                          {e.duration != null && e.duration > 0 && <span className="cl-journey-detail-pill u-mono">{e.duration}s</span>}
                          {e.reason != null && <span className="cl-journey-detail-pill">{e.reason}</span>}
                          {e.from_number != null && <span className="cl-journey-detail-pill">{t('callLog.journey.from', { number: e.from_number })}</span>}
                          {e.to_number != null && <span className="cl-journey-detail-pill">{t('callLog.journey.to', { number: e.to_number })}</span>}
                        </div>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// VAD Modal — voice activity timeline
// ---------------------------------------------------------------------------
interface VadSegment { start: number; end: number; }
interface VadData {
  uniqueid: string;
  base: string | null;
  duration: number | null;
  sp1_talk_seconds: number | null;
  sp2_talk_seconds: number | null;
  overlap_seconds: number | null;
  sp1_segments: number | null;
  sp2_segments: number | null;
  segments: { sp1?: VadSegment[]; sp2?: VadSegment[] } | null;
}

interface VadModalProps {
  vad: VadData;
  recordingFile: string | null;
  onClose: () => void;
}

function VadModal({ vad, recordingFile, onClose }: VadModalProps) {
  const { t } = useTranslation();
  const duration = vad.duration ?? 0;
  const sp1 = vad.segments?.sp1 ?? [];
  const sp2 = vad.segments?.sp2 ?? [];

  const sp1Talk = vad.sp1_talk_seconds ?? 0;
  const sp2Talk = vad.sp2_talk_seconds ?? 0;
  const overlap = vad.overlap_seconds ?? 0;
  const silence = Math.max(0, duration - sp1Talk - sp2Talk + overlap);

  const pct = (v: number) => duration > 0 ? `${((v / duration) * 100).toFixed(1)}%` : '0%';
  const fmt = (s: number) => `${s.toFixed(1)}s`;

  return (
    <Modal
      open
      onClose={onClose}
      title={t('callLog.vad.title', 'Voice Activity')}
      icon={<Activity size={16} />}
      width="lg"
      className="cl-vad-modal"
      footer={<button type="button" className="btn" onClick={onClose}>{t('callLog.qos.close')}</button>}
    >
      <div className="u-col u-gap-4">
        {recordingFile && (
          <p className="cl-vad-filename">{recordingFile}</p>
        )}

        {/* Summary stats. The speaker icons wear the same tones as their timeline
            tracks below (sp1 primary, sp2 success), so they double as the legend. */}
        <StatRow>
          <StatCard
            label={t('callLog.vad.duration', 'Duration')}
            icon={<Clock size={14} />}
            iconTone="muted"
            value={fmt(duration)}
          />
          <StatCard
            label={t('callLog.vad.speaker1', { count: vad.sp1_segments ?? 0, defaultValue: 'Speaker 1 ({{count}} segments)' })}
            icon={<Mic size={14} />}
            value={fmt(sp1Talk)}
            desc={pct(sp1Talk)}
          />
          <StatCard
            label={t('callLog.vad.speaker2', { count: vad.sp2_segments ?? 0, defaultValue: 'Speaker 2 ({{count}} segments)' })}
            icon={<Mic size={14} />}
            iconTone="success"
            value={fmt(sp2Talk)}
            desc={pct(sp2Talk)}
          />
          {overlap > 0 && (
            <StatCard
              label={t('callLog.vad.overlap', 'Overlap')}
              icon={<Users size={14} />}
              iconTone="warn"
              value={fmt(overlap)}
              desc={pct(overlap)}
            />
          )}
          <StatCard
            label={t('callLog.vad.silence', 'Silence')}
            icon={<MicOff size={14} />}
            iconTone="muted"
            value={fmt(silence)}
            desc={pct(silence)}
          />
        </StatRow>

        {/* Timeline. Segment offset/extent are passed as custom properties so the
            stylesheet keeps the logical property (RTL-safe). */}
        {duration > 0 && (
          <div className="cl-vad-timeline-wrap">
            {([
              { key: 'sp1', label: t('callLog.vad.speaker1Short', 'Speaker 1'), segs: sp1 },
              { key: 'sp2', label: t('callLog.vad.speaker2Short', 'Speaker 2'), segs: sp2 },
            ]).map(track => (
              <div key={track.key}>
                <div className="cl-vad-timeline-label">{track.label}</div>
                <div className="cl-vad-timeline-track">
                  {track.segs.map((seg, i) => (
                    <div
                      key={i}
                      className={`cl-vad-segment cl-vad-segment-${track.key}`}
                      style={{
                        '--seg-start': `${(seg.start / duration) * 100}%`,
                        '--seg-width': `${Math.max(0.3, ((seg.end - seg.start) / duration) * 100)}%`,
                      } as React.CSSProperties}
                      title={`${seg.start.toFixed(2)}s – ${seg.end.toFixed(2)}s`}
                    />
                  ))}
                </div>
              </div>
            ))}
            <div className="cl-vad-time-axis">
              <span>0s</span>
              <span>{fmt(duration / 2)}</span>
              <span>{fmt(duration)}</span>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Main CallLogPanel Component
// ---------------------------------------------------------------------------
interface CallLogPanelProps {
  dateRange: DateRange;
  onDateRangeChange: (r: DateRange) => void;
}

function callTypeDot(ct: string): DropdownOption['dot'] {
  if (ct === 'IN') return 'green';
  if (ct === 'OUT') return 'blue';
  return 'neutral';
}

export function CallLogPanel({ dateRange, onDateRangeChange }: CallLogPanelProps) {
  const { t } = useTranslation();

  // Data
  const [calls, setCalls] = useState<CallLogRecord[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Filters
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [callTypeFilter, setCallTypeFilter] = useState('');
  const [appFilter, setAppFilter] = useState('');
  // Supervision (listen/whisper/barge) rows are their own ChanSpy CDR calls. Hidden
  // by default; a filter surfaces them on demand.
  const [showSupervision, setShowSupervision] = useState(false);

  // Sort & pagination
  const [sortAsc, setSortAsc] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);

  // QOS modal
  const [qosModal, setQosModal] = useState<{ qos: QoSData; call: CallLogRecord } | null>(null);
  // Call Journey modal
  const [journeyModal, setJourneyModal] = useState<{ call: CallLogRecord; journey: CallJourneyEvent[] } | null>(null);
  const [journeyLoadingLinkedid, setJourneyLoadingLinkedid] = useState<string | null>(null);
  // VAD modal
  const [vadModal, setVadModal] = useState<{ vad: VadData; recordingFile: string | null } | null>(null);
  const [vadLoadingUniqueid, setVadLoadingUniqueid] = useState<string | null>(null);

  // ui/SearchInput owns the debounce, so `searchQuery` is already the settled term.
  const search = searchQuery.trim();

  // Only the newest request may paint: a slower, older search must not replace the
  // results of the term now in the box.
  const inflightRef = useRef<AbortController | null>(null);

  const fetchData = useCallback(async () => {
    inflightRef.current?.abort();
    const ac = new AbortController();
    inflightRef.current = ac;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      params.set('limit', '500');
      params.set('date_from', dateRange.from);
      params.set('date_to', dateRange.to);
      if (search) params.set('search', search);
      const res = await fetchWithAuth(`/api/call-log?${params.toString()}`, { signal: ac.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (ac.signal.aborted) return;
      setCalls(json.calls || []);
      setTotalCount(typeof json.total === 'number' ? json.total : (json.calls || []).length);
    } catch (err: unknown) {
      if (ac.signal.aborted) return;
      setError(err instanceof Error ? err.message : t('callLog.loadFailed', 'Failed to load call history'));
    } finally {
      if (inflightRef.current === ac) setLoading(false);
    }
  }, [dateRange, search, t]);

  useEffect(() => { fetchData(); }, [fetchData]);
  useEffect(() => () => inflightRef.current?.abort(), []);

  // Filters offer what occurs in the loaded calls (supervision rows only while shown),
  // each with its count; the selected value stays listed even at zero so it can be cleared.
  const listed = calls.filter(c => showSupervision || !c.is_supervision);
  const valuesOf = (counts: Record<string, number>, selected: string) =>
    [...new Set([...Object.keys(counts), ...(selected ? [selected] : [])])];

  const statusRank = (v: string) => {
    const i = STATUS_ORDER.indexOf(v);
    return i < 0 ? STATUS_ORDER.length : i;
  };
  const statusCounts = countBy(listed, c => c.status || undefined);
  const statusOptions = presentOptions(
    valuesOf(statusCounts, statusFilter)
      .sort((a, b) => statusRank(a) - statusRank(b) || a.localeCompare(b))
      .map(s => ({ value: s, label: statusLabel(t, s), dotColor: statusColor(s) })),
    statusCounts, statusFilter);
  const callTypeCounts = countBy(listed, c => c.call_type || undefined);
  const callTypeOptions = presentOptions(
    valuesOf(callTypeCounts, callTypeFilter).sort()
      .map(ct => ({ value: ct, label: ct, dot: callTypeDot(ct) })),
    callTypeCounts, callTypeFilter);
  const appCounts = countBy(listed, c => c.app || undefined);
  const appOptions = presentOptions(
    valuesOf(appCounts, appFilter).sort().map(a => ({ value: a, label: a })),
    appCounts, appFilter);
  // Count of hidden supervision rows in the loaded set, so the toggle is only
  // offered when there is something to reveal.
  const supervisionCount = calls.filter(c => c.is_supervision).length;

  // Filtered + sorted. Search is applied server-side; status/type/app stay
  // client-side over the fetched set.
  const filtered = calls.filter(c => {
    if (!showSupervision && c.is_supervision) return false;
    if (statusFilter && c.status !== statusFilter) return false;
    if (callTypeFilter && c.call_type !== callTypeFilter) return false;
    if (appFilter && c.app !== appFilter) return false;
    return true;
  });

  const sorted = [...filtered].sort((a, b) => {
    const da = new Date(a.calldate).getTime();
    const db = new Date(b.calldate).getTime();
    return sortAsc ? da - db : db - da;
  });

  // Pagination
  const totalPages = Math.max(1, Math.ceil(sorted.length / ITEMS_PER_PAGE));
  const safeCurrentPage = Math.min(currentPage, totalPages);
  const startIdx = (safeCurrentPage - 1) * ITEMS_PER_PAGE;
  const pageItems = sorted.slice(startIdx, startIdx + ITEMS_PER_PAGE);

  // Reset page on filter change
  useEffect(() => { setCurrentPage(1); }, [searchQuery, statusFilter, callTypeFilter, appFilter, showSupervision, dateRange]);

  const activeFilters = {
    status: Boolean(statusFilter),
    callType: Boolean(callTypeFilter),
    app: Boolean(appFilter),
    supervision: showSupervision,
  };
  const anyFilterActive = Boolean(search) || Object.values(activeFilters).some(Boolean);
  const clearFilters = () => {
    setSearchQuery('');
    setStatusFilter('');
    setCallTypeFilter('');
    setAppFilter('');
    setShowSupervision(false);
  };

  const handleOpenQos = (call: CallLogRecord) => {
    const qos = parseQoS(call.QoS);
    if (qos) setQosModal({ qos, call });
  };

  const handleOpenJourney = async (call: CallLogRecord) => {
    const linkedid = call.linkedid;
    if (!linkedid) return;
    setJourneyLoadingLinkedid(linkedid);
    try {
      const res = await fetchWithAuth(`/api/call-log/journey?linkedid=${encodeURIComponent(linkedid)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const journey = (json.journey || []) as CallJourneyEvent[];
      setJourneyModal({ call, journey });
    } catch {
      setJourneyModal({ call, journey: [] });
    } finally {
      setJourneyLoadingLinkedid(null);
    }
  };

  const handleOpenVad = async (call: CallLogRecord) => {
    const uniqueid = call.uniqueid;
    if (!uniqueid || vadLoadingUniqueid) return;
    setVadLoadingUniqueid(uniqueid);
    try {
      const res = await fetchWithAuth(`/api/call-log/vad/${encodeURIComponent(uniqueid)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const vad = await res.json() as VadData;
      setVadModal({ vad, recordingFile: call.recording_file });
    } catch {
      // no VAD data — show empty modal
      setVadModal({
        vad: { uniqueid: uniqueid, base: null, duration: null, sp1_talk_seconds: null, sp2_talk_seconds: null, overlap_seconds: null, sp1_segments: null, sp2_segments: null, segments: null },
        recordingFile: call.recording_file,
      });
    } finally {
      setVadLoadingUniqueid(null);
    }
  };

  const columns: Column<CallLogRecord>[] = [
    {
      // The number first, the contact name as a secondary line under whichever cell
      // holds the remote party (src inbound, dst outbound — what phone_number
      // resolves to server-side).
      key: 'src', header: t('callLog.table.src'), primary: true,
      cell: call => <PartyCell number={call.src} name={call.src === call.phone_number ? call.customer_name : null} />,
    },
    {
      key: 'dst', header: t('callLog.table.dest'),
      cell: call => <PartyCell number={call.dst} name={call.dst === call.phone_number ? call.customer_name : null} />,
    },
    { key: 'app', header: t('callLog.table.app'), cell: call => call.app || '—' },
    {
      key: 'direction', header: t('callLog.table.direction'),
      cell: call => <CallDirectionBadge call={call} />,
    },
    {
      key: 'status', header: t('callLog.table.status'),
      cell: call => (
        call.status === 'ANSWERED' && parseQoS(call.QoS) ? (
          <button type="button" className="cl-status-qos" onClick={() => handleOpenQos(call)} title={t('callLog.viewQoS')}>
            <CallLogStatusBadge status={call.status} />
          </button>
        ) : <CallLogStatusBadge status={call.status} />
      ),
    },
    {
      key: 'agent', header: t('callLog.table.agent'),
      cell: call => call.extension || '—',
    },
    {
      // Duration with talk time as its secondary line: one column, both figures.
      key: 'duration', header: t('callLog.table.duration'),
      cell: call => (
        <div className="cl-party">
          <span className="u-mono">{formatDuration(call.duration)}</span>
          <span className="cl-secondary">{t('callLog.journey.talkDuration', { duration: formatDuration(call.talk) })}</span>
        </div>
      ),
    },
    {
      key: 'recording', header: t('callLog.table.recording'),
      cell: call => (
        <AudioPlayer
          key={call.recording_path ?? ''}
          recordingPath={call.recording_path}
          recordingFile={call.recording_file}
          onVadClick={call.uniqueid ? () => handleOpenVad(call) : undefined}
        />
      ),
    },
    {
      key: 'dateTime', header: t('callLog.table.dateTime'),
      cell: call => {
        const dt = formatCallDate(call.calldate, t);
        return (
          <div className="cl-datetime">
            <span className="cl-date">{dt.date}</span>
            <span className="cl-time">{dt.time}</span>
          </div>
        );
      },
    },
    {
      key: 'journey', header: t('callLog.table.callJourney'),
      cell: call => (call.call_journey_count != null && call.call_journey_count > 1) ? (
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => handleOpenJourney(call)}
          disabled={journeyLoadingLinkedid !== null}
          title={t('callLog.showJourney')}
          aria-label={t('callLog.showJourney')}
        >
          {journeyLoadingLinkedid === call.linkedid ? <Loader2 size={14} className="spinner" /> : <Route size={14} />}
          {call.call_journey_count}
        </button>
      ) : (
        <span className="cl-no-qos">—</span>
      ),
    },
    {
      key: 'qos', header: t('callLog.table.qos'),
      cell: call => parseQoS(call.QoS) ? (
        <button
          type="button"
          className="btn btn-ghost btn-sm btn-icon"
          onClick={() => handleOpenQos(call)}
          title={t('callLog.viewQoS')}
          aria-label={t('callLog.viewQoS')}
        >
          <BarChart3 size={14} />
        </button>
      ) : (
        <span className="cl-no-qos">—</span>
      ),
    },
  ];

  return (
    <Page
      icon={History}
      title={t('callLog.title')}
      count={totalCount}
      scope={<PageRange value={dateRange} onChange={onDateRangeChange} />}
      flush
      toolbar={
        <Toolbar
          search={
            <SearchInput
              value={searchQuery}
              onChange={setSearchQuery}
              label={t('callLog.search', 'Search calls')}
              placeholder={t('callLog.searchPlaceholder')}
              loading={loading && Boolean(search)}
            />
          }
          filters={
            <>
              {showFilter(statusOptions, statusFilter) && (
                <div data-active={activeFilters.status || undefined}>
                  <Dropdown
                    value={statusFilter}
                    onChange={setStatusFilter}
                    size="md"
                    ariaLabel={t('callLog.table.status')}
                    options={[{ value: '', label: t('callLog.allStatuses') }, ...statusOptions]}
                  />
                </div>
              )}
              {showFilter(callTypeOptions, callTypeFilter) && (
                <div data-active={activeFilters.callType || undefined}>
                  <Dropdown
                    value={callTypeFilter}
                    onChange={setCallTypeFilter}
                    icon={ArrowUpDown}
                    size="md"
                    ariaLabel={t('callLog.table.direction')}
                    options={[{ value: '', label: t('callLog.allDirections') }, ...callTypeOptions]}
                  />
                </div>
              )}
              {showFilter(appOptions, appFilter) && (
                <div data-active={activeFilters.app || undefined}>
                  <Dropdown
                    value={appFilter}
                    onChange={setAppFilter}
                    size="md"
                    ariaLabel={t('callLog.table.app')}
                    options={[{ value: '', label: t('callLog.allApps') }, ...appOptions]}
                  />
                </div>
              )}
              {supervisionCount > 0 && (
                <div data-active={activeFilters.supervision || undefined}>
                  <Dropdown
                    value={showSupervision ? 'show' : ''}
                    onChange={(v) => setShowSupervision(v === 'show')}
                    size="md"
                    ariaLabel={t('callLog.supervisionShown')}
                    options={[
                      { value: '', label: t('callLog.supervisionHidden', { count: supervisionCount }) },
                      { value: 'show', label: t('callLog.supervisionShown') },
                    ]}
                  />
                </div>
              )}
            </>
          }
          actions={
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => setSortAsc(!sortAsc)}
              title={sortAsc ? t('callLog.sortOldest') : t('callLog.sortNewest')}
            >
              <ArrowUpDown size={14} />
              {sortAsc ? t('callLog.sortOldestBtn') : t('callLog.sortNewestBtn')}
            </button>
          }
        />
      }
    >
      {loading ? (
        <Loading label={t('callLog.loading')} />
      ) : error ? (
        <div className="u-p-3">
          <Alert action={<button type="button" className="btn" onClick={fetchData}><RefreshCw size={14} />{t('callLog.retry')}</button>}>
            {error}
          </Alert>
        </div>
      ) : (
        <Table
          columns={columns}
          rows={pageItems}
          rowKey={(call, idx) => `${call.calldate}-${idx}`}
          caption={t('callLog.title')}
          className="cl-log-table"
          empty={
            <EmptyState
              icon={Phone}
              title={search
                ? t('callLog.noMatches', 'No calls match "{{query}}"', { query: search })
                : t('callLog.noCallsFound')}
              description={anyFilterActive
                ? t('callLog.emptyFiltered', 'Clear the filters or try a different search.')
                : t('callLog.emptyRange', 'Try a wider date range.')}
              action={anyFilterActive ? (
                <button type="button" className="btn" onClick={clearFilters}>
                  {t('callLog.clearFilters', 'Clear filters')}
                </button>
              ) : undefined}
            />
          }
        />
      )}

      {!loading && sorted.length > 0 && (
        <Pagination
          page={safeCurrentPage}
          totalPages={totalPages}
          onPage={setCurrentPage}
          info={t('callLog.showing', {
            start: startIdx + 1,
            end: Math.min(startIdx + ITEMS_PER_PAGE, sorted.length),
            total: sorted.length,
          })}
        />
      )}

      {/* ui/Modal portals to <body> itself. */}
      {qosModal && (
        <QoSModal
          qos={qosModal.qos}
          call={qosModal.call}
          onClose={() => setQosModal(null)}
        />
      )}

      {journeyModal && (
        <CallJourneyModal
          call={journeyModal.call}
          journey={journeyModal.journey}
          onClose={() => setJourneyModal(null)}
        />
      )}

      {vadModal && (
        <VadModal
          vad={vadModal.vad}
          recordingFile={vadModal.recordingFile}
          onClose={() => setVadModal(null)}
        />
      )}
    </Page>
  );
}
