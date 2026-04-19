import { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import {
  ArrowUpDown, Search, Phone, X, Download, Play, Pause,
  ChevronLeft, ChevronRight, Loader2, BarChart3, Route,
  PhoneIncoming, PhoneOutgoing, ListOrdered, PhoneCall, Share2, PhoneOff, PhoneMissed,
} from 'lucide-react';
import { FilterSelect, type SelectOption } from './FilterSelect';
import type { CallLogRecord, QoSData, CallJourneyEvent } from '../types';
import { getAuthHeaders } from '../auth';
import { PeriodPicker } from './AnalyticsPanel';
import type { DateRange } from './analyticsUtils';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type TFunction = (key: string, options?: Record<string, unknown>) => string;

function formatDuration(seconds: number): string {
  if (!seconds || seconds <= 0) return '0s';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m === 0) return `${s}s`;
  return `${m}m ${s}s`;
}

function formatAudioTime(seconds: number): string {
  if (!seconds || isNaN(seconds)) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
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

function getMesLabel(mes: number | null, t: TFunction): { emoji: string; label: string; color: string } {
  const normalized = normalizeMesTo100(mes);
  if (normalized === null) return { emoji: '—', label: t('callLog.na'), color: 'var(--text-muted)' };
  if (normalized >= 80) return { emoji: '⭐', label: t('callLog.audioQuality.excellent'), color: '#10b981' };
  if (normalized >= 72) return { emoji: '✅', label: t('callLog.audioQuality.good'), color: '#22c55e' };
  if (normalized >= 60) return { emoji: '⚠️', label: t('callLog.audioQuality.fair'), color: '#f59e0b' };
  return { emoji: '❌', label: t('callLog.audioQuality.poor'), color: '#ef4444' };
}

function getJitterColor(jitter: number | null): string {
  if (jitter === null) return 'var(--text-muted)';
  if (jitter < 20) return '#3fb950';
  if (jitter < 50) return '#d29922';
  return '#f85149';
}

function getLossColor(loss: number | null): string {
  if (loss === null) return 'var(--text-muted)';
  if (loss < 1) return '#3fb950';
  if (loss < 5) return '#d29922';
  return '#f85149';
}

function calculateLostPackets(lossPercent: number | null, totalPackets: number | null): number | null {
  if (lossPercent === null || totalPackets === null) return null;
  return Math.round((lossPercent / 100) * totalPackets);
}

function getOverallScore(qos: QoSData, t: TFunction): { label: string; color: string } {
  const scores: number[] = [];
  const rxNormalized = normalizeMesTo100(qos.rxMes);
  const txNormalized = normalizeMesTo100(qos.txMes);
  if (rxNormalized !== null) scores.push(rxNormalized);
  if (txNormalized !== null) scores.push(txNormalized);
  if (scores.length === 0) return { label: t('callLog.na'), color: 'var(--text-muted)' };
  const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
  if (avg >= 80) return { label: t('callLog.score.high'), color: '#10b981' };
  if (avg >= 60) return { label: t('callLog.score.medium'), color: '#f59e0b' };
  return { label: t('callLog.score.low'), color: '#ef4444' };
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

const STATUS_CONFIG: Record<string, { color: string; bg: string }> = {
  completed:   { color: '#3fb950', bg: 'rgba(63,185,80,0.12)' },
  failed:      { color: '#f85149', bg: 'rgba(248,81,73,0.12)' },
  no_answer:   { color: '#d29922', bg: 'rgba(210,153,34,0.12)' },
  in_progress: { color: '#58a6ff', bg: 'rgba(88,166,255,0.12)' },
  busy:        { color: '#f0883e', bg: 'rgba(240,136,62,0.12)' },
  switched_off:{ color: '#6e7681', bg: 'rgba(110,118,129,0.12)' },
};

const ITEMS_PER_PAGE = 25;

// ---------------------------------------------------------------------------
// Audio Player Component
// ---------------------------------------------------------------------------
interface AudioPlayerProps {
  recordingPath: string | null;
  recordingFile: string | null;
}

function AudioPlayer({ recordingPath, recordingFile }: AudioPlayerProps) {
  const { t } = useTranslation();
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [errored, setErrored] = useState(false);

  if (!recordingPath || errored) {
    return (
      <span className="cl-no-recording">🎵 {t('callLog.noRecording')}</span>
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

  const handleSeek = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!audioRef.current || !duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    audioRef.current.currentTime = pct * duration;
  };

  const progress = duration > 0 ? (currentTime / duration) * 100 : 0;

  return (
    <div className="cl-audio-player">
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
      <button className="cl-audio-btn cl-audio-play" onClick={togglePlay} title={playing ? t('callLog.pause') : t('callLog.play')}>
        {playing ? <Pause size={14} /> : <Play size={14} />}
      </button>
      <a
        className="cl-audio-btn cl-audio-download"
        href={audioUrl}
        download={recordingFile || 'recording'}
        title={t('callLog.download')}
        onClick={e => e.stopPropagation()}
      >
        <Download size={14} />
      </a>
      <div className="cl-audio-progress-wrap" onClick={handleSeek}>
        <div className="cl-audio-progress-bg">
          <div className="cl-audio-progress-fill" style={{ width: `${progress}%` }} />
        </div>
      </div>
      <span className="cl-audio-time">
        {formatAudioTime(currentTime)} / {loaded ? formatAudioTime(duration) : '--:--'}
      </span>
      {recordingFile && (
        <span className="cl-audio-filename" title={recordingFile}>
          {recordingFile.length > 20 ? recordingFile.slice(0, 17) + '...' : recordingFile}
        </span>
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

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', handler);
      document.body.style.overflow = originalOverflow;
    };
  }, [onClose]);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="cl-qos-modal" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="modal-header">
          <h3 className="modal-title">{t('callLog.qos.title')}</h3>
          <button className="modal-close" onClick={onClose}>
            <X size={20} />
          </button>
        </div>

        {/* Body */}
        <div className="modal-body" style={{ padding: 0 }}>
          {/* Summary Section */}
          <div className="cl-qos-summary">
            <p className="cl-qos-text">{getAudioSummary(qos, t)}</p>
            <div className="cl-qos-participants">
              <span className="cl-qos-badge agent">
                {call.extension || t('callLog.qos.agent')}
              </span>
              <span className="cl-qos-arrow">↔</span>
              <span className="cl-qos-badge customer">
                {qos.caller || call.phone_number || t('callLog.qos.customer')}
              </span>
            </div>
            <div className="cl-qos-overall">
              {t('callLog.qos.overallScore')}{' '}
              <span style={{ color: overall.color, fontWeight: 700 }}>{overall.label}</span>
            </div>
          </div>

          {/* QOS Metrics Table */}
          <div className="cl-qos-table-wrap">
            <table className="cl-qos-table">
              <thead>
                <tr>
                  <th>{t('callLog.qos.metric')}</th>
                  <th>{t('callLog.qos.audioFromSystem')}</th>
                  <th>{t('callLog.qos.audioToSystem')}</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>{t('callLog.qos.totalPackets')}</td>
                  <td>{qos.txPackets ?? '—'}</td>
                  <td>{qos.rxPackets ?? '—'}</td>
                </tr>
                <tr>
                  <td>{t('callLog.qos.jitter')}</td>
                  <td style={{ color: getJitterColor(qos.txJitter) }}>
                    {qos.txJitter !== null ? `${qos.txJitter.toFixed(2)} ms` : '—'}
                  </td>
                  <td style={{ color: getJitterColor(qos.rxJitter) }}>
                    {qos.rxJitter !== null ? `${qos.rxJitter.toFixed(2)} ms` : '—'}
                  </td>
                </tr>
                <tr>
                  <td>{t('callLog.qos.dataLoss')}</td>
                  <td style={{ color: getLossColor(qos.txLoss) }}>
                    {(() => {
                      const lostPackets = calculateLostPackets(qos.txLoss, qos.txPackets);
                      return lostPackets !== null ? t('callLog.qos.packets', { count: lostPackets }) : '—';
                    })()}
                  </td>
                  <td style={{ color: getLossColor(qos.rxLoss) }}>
                    {(() => {
                      const lostPackets = calculateLostPackets(qos.rxLoss, qos.rxPackets);
                      return lostPackets !== null ? t('callLog.qos.packets', { count: lostPackets }) : '—';
                    })()}
                  </td>
                </tr>
                <tr>
                  <td>{t('callLog.qos.audioScore')}</td>
                  <td style={{ color: txMesInfo.color }}>
                    {qos.txMes !== null ? (
                      <>{txMesInfo.emoji} {normalizeMesTo100(qos.txMes)?.toFixed(2) ?? '—'} — {txMesInfo.label}</>
                    ) : '—'}
                  </td>
                  <td style={{ color: rxMesInfo.color }}>
                    {qos.rxMes !== null ? (
                      <>{rxMesInfo.emoji} {normalizeMesTo100(qos.rxMes)?.toFixed(2) ?? '—'} — {rxMesInfo.label}</>
                    ) : '—'}
                  </td>
                </tr>
                <tr>
                  <td>{t('callLog.qos.rtt')}</td>
                  <td colSpan={2} style={{ textAlign: 'center' }}>
                    {qos.rtt !== null ? `${qos.rtt.toFixed(2)} ms` : '—'}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        {/* Footer */}
        <div className="modal-footer">
          <button className="btn" onClick={onClose}>{t('callLog.qos.close')}</button>
        </div>
      </div>
    </div>
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

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', handler);
      document.body.style.overflow = originalOverflow;
    };
  }, [onClose]);

  const summary = formatCallDate(call.calldate, t);
  const getEventConfig = (eventType: string) =>
    JOURNEY_EVENT_CONFIG[eventType] ?? { icon: <Route size={16} />, color: 'var(--text-muted)' };
  const getEventLabel = (eventType: string) =>
    t(`callLog.journey.events.${eventType}`, { defaultValue: eventType.replace(/_/g, ' ') });

  const stepCount = journey.length;
  const stepsLabel = t(stepCount === 1 ? 'callLog.journey.steps' : 'callLog.journey.stepsPlural', { count: stepCount });

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="cl-qos-modal cl-journey-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header cl-journey-header">
          <div className="cl-journey-header-top">
            <h3 className="modal-title">{t('callLog.journey.title')}</h3>
            <span className="cl-journey-step-count">{stepsLabel}</span>
          </div>
          <button className="modal-close" onClick={onClose} aria-label="Close">
            <X size={20} />
          </button>
        </div>
        <div className="modal-body cl-journey-body">
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
                  <span className="cl-journey-duration">{t('callLog.journey.talkDuration', { duration: formatDuration(call.talk) })}</span>
                </>
              )}
            </div>
            <div className="cl-journey-badges">
              <span className={`cl-journey-direction cl-direction-${(call.call_type || '').toLowerCase()}`}>
                {call.call_type === 'IN' ? '📥 IN' :
                 call.call_type === 'OUT' ? '📤 OUT' :
                 call.call_type === 'INTERNAL' ? '🔄 INT' :
                 call.call_type || '—'}
              </span>
              {call.extension && (
                <span className="cl-journey-agent-badge">{t('callLog.journey.agent', { id: call.extension })}</span>
              )}
            </div>
          </div>

          <div className="cl-journey-timeline-wrap">
            {journey.length === 0 ? (
              <p className="cl-journey-empty">{t('callLog.journey.noData')}</p>
            ) : (
              <ul className="cl-journey-timeline" role="list">
                {journey.map((e, i) => {
                  const cf = getEventConfig(e.event);
                  const isLast = i === journey.length - 1;
                  return (
                    <li key={i} className="cl-journey-timeline-item" style={{ '--journey-color': cf.color } as React.CSSProperties}>
                      <div className="cl-journey-timeline-marker">
                        <span className="cl-journey-dot-icon" style={{ color: cf.color }}>{cf.icon}</span>
                        {!isLast && <span className="cl-journey-timeline-line" />}
                      </div>
                      <div className="cl-journey-timeline-content">
                        <div className="cl-journey-event-time">{e.time}</div>
                        <div className="cl-journey-event-card">
                          <span className="cl-journey-event-name" style={{ color: cf.color }}>{getEventLabel(e.event)}</span>
                          <div className="cl-journey-event-details">
                            {e.agent != null && <span className="cl-journey-detail-pill">{t('callLog.journey.agent', { id: e.agent })}</span>}
                            {e.queue != null && <span className="cl-journey-detail-pill">{t('callLog.journey.queue', { id: e.queue })}</span>}
                            {e.duration != null && e.duration > 0 && <span className="cl-journey-detail-pill">{e.duration}s</span>}
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
        <div className="modal-footer">
          <button className="btn" onClick={onClose}>{t('callLog.qos.close')}</button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main CallLogPanel Component
// ---------------------------------------------------------------------------
interface CallLogPanelProps {
  dateRange: DateRange;
  onDateRangeChange: (r: DateRange) => void;
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

  // Sort & pagination
  const [sortAsc, setSortAsc] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);

  // QOS modal
  const [qosModal, setQosModal] = useState<{ qos: QoSData; call: CallLogRecord } | null>(null);
  // Call Journey modal
  const [journeyModal, setJourneyModal] = useState<{ call: CallLogRecord; journey: CallJourneyEvent[] } | null>(null);
  const [journeyLoadingLinkedid, setJourneyLoadingLinkedid] = useState<string | null>(null);

  // Fetch data
  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      params.set('limit', '500');
      params.set('date_from', dateRange.from);
      params.set('date_to', dateRange.to);
      const res = await fetch(`/api/call-log?${params.toString()}`, { headers: getAuthHeaders() });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setCalls(json.calls || []);
      setTotalCount(typeof json.total === 'number' ? json.total : (json.calls || []).length);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load call history');
    } finally {
      setLoading(false);
    }
  }, [dateRange]);

  useEffect(() => { fetchData(); }, [fetchData]);

  // Derived: unique values for dropdowns
  const statusOptions = Array.from(new Set(calls.map(c => c.status))).filter(Boolean).sort();
  const callTypeOptions = Array.from(new Set(calls.map(c => c.call_type))).filter(Boolean).sort();
  const appOptions = Array.from(new Set(calls.map(c => c.app))).filter(Boolean).sort();

  function statusDot(s: string): SelectOption['dot'] {
    if (s === 'ANSWERED') return 'green';
    if (s === 'NO ANSWER' || s === 'BUSY') return 'orange';
    if (s === 'FAILED') return 'red';
    return 'neutral';
  }

  function callTypeDot(ct: string): SelectOption['dot'] {
    if (ct === 'IN') return 'green';
    if (ct === 'OUT') return 'blue';
    return 'neutral';
  }

  // Filtered + sorted
  const filtered = calls.filter(c => {
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      const matchSrc = c.src?.toLowerCase().includes(q);
      const matchDst = c.dst?.toLowerCase().includes(q);
      if (!matchSrc && !matchDst) return false;
    }
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
  useEffect(() => { setCurrentPage(1); }, [searchQuery, statusFilter, callTypeFilter, appFilter, dateRange]);

  const handleOpenQos = (call: CallLogRecord) => {
    const qos = parseQoS(call.QoS);
    if (qos) setQosModal({ qos, call });
  };

  const handleOpenJourney = async (call: CallLogRecord) => {
    const linkedid = call.linkedid;
    if (!linkedid) return;
    setJourneyLoadingLinkedid(linkedid);
    try {
      const res = await fetch(`/api/call-log/journey?linkedid=${encodeURIComponent(linkedid)}`, { headers: getAuthHeaders() });
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

  return (
    <div className="cl-panel">
      {/* Header */}
      <div className="cl-header">
        <div className="cl-header-left">
          <h2 className="cl-title">📈 {t('callLog.title')}</h2>
          <p className="cl-subtitle">{t('callLog.viewManage')}</p>
        </div>
        <div className="cl-header-right">
          <button
            className="btn"
            onClick={() => setSortAsc(!sortAsc)}
            title={sortAsc ? t('callLog.sortOldest') : t('callLog.sortNewest')}
          >
            <ArrowUpDown size={14} />
            {sortAsc ? t('callLog.sortOldestBtn') : t('callLog.sortNewestBtn')}
          </button>
          <div className="cl-stats-card">
            <span className="cl-stats-count">{totalCount}</span>
            <span className="cl-stats-label">{t('callLog.totalCalls')}</span>
          </div>
        </div>
      </div>

      {/* Filters */}
      <div className="cl-filters">
        <div className="cl-filter-item cl-filter-search">
          <Search size={16} className="cl-filter-icon" />
          <input
            className="cl-filter-input"
            type="text"
            placeholder={t('callLog.searchPlaceholder')}
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
          />
          {searchQuery && (
            <button className="cl-filter-clear" onClick={() => setSearchQuery('')}>
              <X size={14} />
            </button>
          )}
        </div>
        <div className="cl-filter-item">
          <FilterSelect
            value={statusFilter}
            onChange={setStatusFilter}
            style={{ width: '100%' }}
            options={[
              { value: '', label: t('callLog.allStatuses') },
              ...statusOptions.map(s => ({
                value: s,
                label: t(`callLog.status.${s}`, { defaultValue: s }),
                dot: statusDot(s),
              })),
            ]}
          />
        </div>
        <div className="cl-filter-item">
          <FilterSelect
            value={callTypeFilter}
            onChange={setCallTypeFilter}
            icon={ArrowUpDown}
            style={{ width: '100%' }}
            options={[
              { value: '', label: t('callLog.allDirections') },
              ...callTypeOptions.map(ct => ({
                value: ct,
                label: ct,
                dot: callTypeDot(ct),
              })),
            ]}
          />
        </div>
        <div className="cl-filter-item">
          <FilterSelect
            value={appFilter}
            onChange={setAppFilter}
            style={{ width: '100%' }}
            options={[
              { value: '', label: t('callLog.allApps') },
              ...appOptions.map(a => ({ value: a, label: a })),
            ]}
          />
        </div>
        <PeriodPicker value={dateRange} onChange={onDateRangeChange} />
      </div>

      {/* Table */}
      <div className="cl-table-wrap">
        {loading ? (
          <div className="cl-loading">
            <Loader2 size={32} className="spinner" />
            <p>{t('callLog.loading')}</p>
          </div>
        ) : error ? (
          <div className="cl-error">
            <p>⚠️ {error}</p>
            <button className="btn btn-primary" onClick={fetchData}>{t('callLog.retry')}</button>
          </div>
        ) : pageItems.length === 0 ? (
          <div className="cl-empty">
            <Phone size={48} />
            <p>📞 {t('callLog.noCallsFound')}</p>
          </div>
        ) : (
          <table className="cl-table">
            <thead>
              <tr>
                <th>{t('callLog.table.src')}</th>
                <th>{t('callLog.table.dest')}</th>
                <th>{t('callLog.table.app')}</th>
                <th>{t('callLog.table.direction')}</th>
                <th>{t('callLog.table.status')}</th>
                <th>{t('callLog.table.agent')}</th>
                <th>{t('callLog.table.duration')}</th>
                <th>{t('callLog.table.talk')}</th>
                <th>{t('callLog.table.recording')}</th>
                <th>{t('callLog.table.dateTime')}</th>
                <th>{t('callLog.table.callJourney')}</th>
                <th>{t('callLog.table.qos')}</th>
              </tr>
            </thead>
            <tbody>
              {pageItems.map((call, idx) => {
                const st = STATUS_CONFIG[call.status] || { color: '#6e7681', bg: 'rgba(110,118,129,0.12)' };
                const stLabel = t(`callLog.status.${call.status}`, { defaultValue: call.status });
                const dt = formatCallDate(call.calldate, t);
                const hasQos = !!parseQoS(call.QoS);

                return (
                  <tr key={`${call.calldate}-${idx}`} className={idx % 2 === 0 ? 'cl-row-even' : 'cl-row-odd'}>
                    <td>
                      <span className="cl-phone">{call.src || '—'}</span>
                    </td>
                    <td>
                      <span className="cl-phone">
                        {call.dst || '—'}
                      </span>
                    </td>
                    <td>{call.app || '—'}</td>
                    <td>
                      <span className={`cl-direction cl-direction-${call.call_type?.toLowerCase()}`}>
                        {call.call_type === 'IN' ? '📥 IN' :
                         call.call_type === 'OUT' ? '📤 OUT' :
                         call.call_type === 'INTERNAL' ? '🔄 INT' :
                         call.call_type || '—'}
                      </span>
                    </td>
                    <td>
                      <span
                        className="cl-status-badge"
                        style={{ color: st.color, background: st.bg, borderColor: st.color }}
                        onClick={() => { if (call.status === 'completed' && hasQos) handleOpenQos(call); }}
                        role={call.status === 'completed' && hasQos ? 'button' : undefined}
                      >
                        {stLabel}
                      </span>
                    </td>
                    <td>{call.extension || '—'}</td>
                    <td>
                      <span className="cl-duration">{formatDuration(call.duration)}</span>
                    </td>
                    <td>
                      <span className="cl-duration">{formatDuration(call.talk)}</span>
                    </td>
                    <td>
                      <AudioPlayer recordingPath={call.recording_path} recordingFile={call.recording_file} />
                    </td>
                    <td>
                      <div className="cl-datetime">
                        <span className="cl-date">{dt.date}</span>
                        <span className="cl-time">{dt.time}</span>
                      </div>
                    </td>
                    <td>
                      {(call.call_journey_count != null && call.call_journey_count > 1) ? (
                        <button
                          className="cl-qos-btn cl-journey-btn"
                          onClick={() => handleOpenJourney(call)}
                          disabled={journeyLoadingLinkedid !== null}
                          title={t('callLog.showJourney')}
                        >
                          {journeyLoadingLinkedid === call.linkedid ? <Loader2 size={16} className="spinner" /> : <Route size={16} />}
                          <span className="cl-journey-count">{call.call_journey_count}</span>
                        </button>
                      ) : (
                        <span className="cl-no-qos">—</span>
                      )}
                    </td>
                    <td>
                      {hasQos ? (
                        <button
                          className="cl-qos-btn"
                          onClick={() => handleOpenQos(call)}
                          title={t('callLog.viewQoS')}
                        >
                          <BarChart3 size={16} />
                        </button>
                      ) : (
                        <span className="cl-no-qos">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Pagination */}
      {!loading && sorted.length > 0 && (
        <div className="cl-pagination">
          <span className="cl-pagination-info">
            {t('callLog.showing', { start: startIdx + 1, end: Math.min(startIdx + ITEMS_PER_PAGE, sorted.length), total: sorted.length })}
          </span>
          <div className="cl-pagination-controls">
            <button
              className="btn cl-page-btn"
              disabled={safeCurrentPage <= 1}
              onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
            >
              <ChevronLeft size={16} />
              {t('callLog.previous')}
            </button>
            <span className="cl-page-current">{safeCurrentPage}</span>
            <button
              className="btn cl-page-btn"
              disabled={safeCurrentPage >= totalPages}
              onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
            >
              {t('callLog.next')}
              <ChevronRight size={16} />
            </button>
          </div>
        </div>
      )}

      {/* QOS Modal - Rendered via Portal to be independent of scroll */}
      {qosModal && createPortal(
        <QoSModal
          qos={qosModal.qos}
          call={qosModal.call}
          onClose={() => setQosModal(null)}
        />,
        document.body
      )}

      {journeyModal && createPortal(
        <CallJourneyModal
          call={journeyModal.call}
          journey={journeyModal.journey}
          onClose={() => setJourneyModal(null)}
        />,
        document.body
      )}
    </div>
  );
}
