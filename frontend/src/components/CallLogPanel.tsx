import { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { 
  ArrowUpDown, Search, Phone, X, Download, Play, Pause, 
  ChevronLeft, ChevronRight, Loader2, BarChart3, Route,
  PhoneIncoming, PhoneOutgoing, ListOrdered, PhoneCall, Share2, PhoneOff, PhoneMissed
} from 'lucide-react';
import type { CallLogRecord, QoSData, CallJourneyEvent } from '../types';
import { getAuthHeaders } from '../auth';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function formatCallDate(dateStr: string): { date: string; time: string } {
  const d = new Date(dateStr);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const callDay = new Date(d.getFullYear(), d.getMonth(), d.getDate());

  let dateLabel: string;
  if (callDay.getTime() === today.getTime()) {
    dateLabel = 'Today';
  } else if (callDay.getTime() === yesterday.getTime()) {
    dateLabel = 'Yesterday';
  } else {
    dateLabel = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  const timeLabel = d.toLocaleTimeString('en-US', { 
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
  // Use raw value, just ensure it's within 0-100 range
  return Math.max(0, Math.min(100, mes));
}

function getMesLabel(mes: number | null): { emoji: string; label: string; color: string } {
  const normalized = normalizeMesTo100(mes);
  if (normalized === null) return { emoji: '—', label: 'N/A', color: 'var(--text-muted)' };
  // 0-100 scale thresholds
  if (normalized >= 80) return { emoji: '⭐', label: 'EXCELLENT', color: '#10b981' };
  if (normalized >= 72) return { emoji: '✅', label: 'GOOD', color: '#22c55e' };
  if (normalized >= 60) return { emoji: '⚠️', label: 'FAIR', color: '#f59e0b' };
  return { emoji: '❌', label: 'POOR', color: '#ef4444' };
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

function getOverallScore(qos: QoSData): { label: string; color: string } {
  const scores: number[] = [];
  const rxNormalized = normalizeMesTo100(qos.rxMes);
  const txNormalized = normalizeMesTo100(qos.txMes);
  if (rxNormalized !== null) scores.push(rxNormalized);
  if (txNormalized !== null) scores.push(txNormalized);
  if (scores.length === 0) return { label: 'N/A', color: 'var(--text-muted)' };
  const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
  // Use same thresholds as getMesLabel (0-100 scale)
  if (avg >= 80) return { label: 'High', color: '#10b981' };
  if (avg >= 60) return { label: 'Medium', color: '#f59e0b' };
  return { label: 'Low', color: '#ef4444' };
}

function getAudioSummary(qos: QoSData): string {
  const describe = (mes: number | null, direction: string) => {
    const normalized = normalizeMesTo100(mes);
    if (normalized === null) return '';
    if (normalized >= 80) return `${direction} audio is perfect`;
    if (normalized >= 72) return `${direction} audio is very good`;
    if (normalized >= 60) return `${direction} audio is fair`;
    return `${direction} audio is poor`;
  };
  const parts = [describe(qos.rxMes, 'Incoming'), describe(qos.txMes, 'outgoing')].filter(Boolean);
  return parts.join('; ') || 'No audio quality data available';
}

const STATUS_CONFIG: Record<string, { label: string; color: string; bg: string }> = {
  completed:  { label: 'Completed',    color: '#3fb950', bg: 'rgba(63,185,80,0.12)' },
  failed:     { label: 'Failed',       color: '#f85149', bg: 'rgba(248,81,73,0.12)' },
  no_answer:  { label: 'No Answer',    color: '#d29922', bg: 'rgba(210,153,34,0.12)' },
  in_progress:{ label: 'In Progress',  color: '#58a6ff', bg: 'rgba(88,166,255,0.12)' },
  busy:       { label: 'Busy',         color: '#f0883e', bg: 'rgba(240,136,62,0.12)' },
  switched_off:{ label: 'Switched Off', color: '#6e7681', bg: 'rgba(110,118,129,0.12)' },
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
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [errored, setErrored] = useState(false);

  if (!recordingPath || errored) {
    return (
      <span className="cl-no-recording">🎵 No recording</span>
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
      <button className="cl-audio-btn cl-audio-play" onClick={togglePlay} title={playing ? 'Pause' : 'Play'}>
        {playing ? <Pause size={14} /> : <Play size={14} />}
      </button>
      <a
        className="cl-audio-btn cl-audio-download"
        href={audioUrl}
        download={recordingFile || 'recording'}
        title="Download"
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
  const overall = getOverallScore(qos);
  const txMesInfo = getMesLabel(qos.txMes);
  const rxMesInfo = getMesLabel(qos.rxMes);

  // Close on escape and prevent body scroll
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    
    // Prevent body scroll when modal is open
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
          <h3 className="modal-title">📊 Quality of Service Report</h3>
          <button className="modal-close" onClick={onClose}>
            <X size={20} />
          </button>
        </div>

        {/* Body */}
        <div className="modal-body" style={{ padding: 0 }}>
          {/* Summary Section */}
          <div className="cl-qos-summary">
            <p className="cl-qos-text">{getAudioSummary(qos)}</p>
            <div className="cl-qos-participants">
              <span className="cl-qos-badge agent">
                {call.extension || 'Agent'}
              </span>
              <span className="cl-qos-arrow">↔</span>
              <span className="cl-qos-badge customer">
                {qos.caller || call.phone_number || 'Customer'}
              </span>
            </div>
            <div className="cl-qos-overall">
              Overall Score:{' '}
              <span style={{ color: overall.color, fontWeight: 700 }}>{overall.label}</span>
            </div>
          </div>

          {/* QOS Metrics Table */}
          <div className="cl-qos-table-wrap">
            <table className="cl-qos-table">
              <thead>
                <tr>
                  <th>Metric</th>
                  <th>Audio from system (TX)</th>
                  <th>Audio to system (RX)</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>Total Packets</td>
                  <td>{qos.txPackets ?? '—'}</td>
                  <td>{qos.rxPackets ?? '—'}</td>
                </tr>
                <tr>
                  <td>Jitter (Timing)</td>
                  <td style={{ color: getJitterColor(qos.txJitter) }}>
                    {qos.txJitter !== null ? `${qos.txJitter.toFixed(2)} ms` : '—'}
                  </td>
                  <td style={{ color: getJitterColor(qos.rxJitter) }}>
                    {qos.rxJitter !== null ? `${qos.rxJitter.toFixed(2)} ms` : '—'}
                  </td>
                </tr>
                <tr>
                  <td>Data Loss</td>
                  <td style={{ color: getLossColor(qos.txLoss) }}>
                    {(() => {
                      const lostPackets = calculateLostPackets(qos.txLoss, qos.txPackets);
                      return lostPackets !== null ? `${lostPackets} packets` : '—';
                    })()}
                  </td>
                  <td style={{ color: getLossColor(qos.rxLoss) }}>
                    {(() => {
                      const lostPackets = calculateLostPackets(qos.rxLoss, qos.rxPackets);
                      return lostPackets !== null ? `${lostPackets} packets` : '—';
                    })()}
                  </td>
                </tr>
                <tr>
                  <td>Audio Score (MES)</td>
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
                  <td>RTT (Round Trip Time)</td>
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
          <button className="btn" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Call Journey Modal — timeline, icons, structured details
// ---------------------------------------------------------------------------
const JOURNEY_EVENT_CONFIG: Record<string, { label: string; icon: React.ReactNode; color: string }> = {
  INBOUND:      { label: 'Inbound',    icon: <PhoneIncoming size={16} />, color: 'var(--journey-inbound)' },
  OUTBOUND:     { label: 'Outbound',   icon: <PhoneOutgoing size={16} />, color: 'var(--journey-outbound)' },
  QUEUE_ENTER:  { label: 'Queue',      icon: <ListOrdered size={16} />,   color: 'var(--journey-queue)' },
  RING:         { label: 'Ringing',    icon: <Phone size={16} />,         color: 'var(--journey-ring)' },
  ANSWER:       { label: 'Answered',  icon: <PhoneCall size={16} />,   color: 'var(--journey-answer)' },
  NO_ANSWER:    { label: 'No Answer', icon: <PhoneMissed size={16} />, color: 'var(--journey-no-answer)' },
  TRANSFER:     { label: 'Transfer',   icon: <Share2 size={16} />,       color: 'var(--journey-transfer)' },
  HANGUP:       { label: 'Hangup',    icon: <PhoneOff size={16} />,     color: 'var(--journey-hangup)' },
};

interface CallJourneyModalProps {
  call: CallLogRecord;
  journey: CallJourneyEvent[];
  onClose: () => void;
}

function CallJourneyModal({ call, journey, onClose }: CallJourneyModalProps) {
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

  const summary = formatCallDate(call.calldate);
  const config = (eventType: string) =>
    JOURNEY_EVENT_CONFIG[eventType] ?? { label: eventType.replace(/_/g, ' '), icon: <Route size={16} />, color: 'var(--text-muted)' };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="cl-qos-modal cl-journey-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header cl-journey-header">
          <div className="cl-journey-header-top">
            <h3 className="modal-title">Call Journey</h3>
            <span className="cl-journey-step-count">{journey.length} step{journey.length !== 1 ? 's' : ''}</span>
          </div>
          <button className="modal-close" onClick={onClose} aria-label="Close">
            <X size={20} />
          </button>
        </div>
        <div className="modal-body cl-journey-body">
          <div className="cl-journey-summary">
            <div className="cl-journey-summary-row">
              <span className="cl-journey-summary-label">Contact</span>
              <span className="cl-journey-summary-value cl-journey-phone">{call.phone_number || call.src || '—'}</span>
            </div>
            <div className="cl-journey-summary-meta">
              <span className="cl-journey-date">{summary.date}</span>
              <span className="cl-journey-dot" aria-hidden>·</span>
              <span className="cl-journey-time-summary">{summary.time}</span>
              {call.talk != null && call.talk > 0 && (
                <>
                  <span className="cl-journey-dot" aria-hidden>·</span>
                  <span className="cl-journey-duration">Talk {formatDuration(call.talk)}</span>
                </>
              )}
            </div>
            <div className="cl-journey-badges">
              <span className={`cl-journey-direction cl-direction-${(call.call_type || '').toLowerCase()}`}>
                {call.call_type || '—'}
              </span>
              {call.extension && (
                <span className="cl-journey-agent-badge">Agent {call.extension}</span>
              )}
            </div>
          </div>

          <div className="cl-journey-timeline-wrap">
            {journey.length === 0 ? (
              <p className="cl-journey-empty">No journey data for this call.</p>
            ) : (
              <ul className="cl-journey-timeline" role="list">
                {journey.map((e, i) => {
                  const cf = config(e.event);
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
                          <span className="cl-journey-event-name" style={{ color: cf.color }}>{cf.label}</span>
                          <div className="cl-journey-event-details">
                            {e.agent != null && <span className="cl-journey-detail-pill">Agent {e.agent}</span>}
                            {e.queue != null && <span className="cl-journey-detail-pill">Queue {e.queue}</span>}
                            {e.duration != null && e.duration > 0 && <span className="cl-journey-detail-pill">{e.duration}s</span>}
                            {e.reason != null && <span className="cl-journey-detail-pill">{e.reason}</span>}
                            {e.from_number != null && <span className="cl-journey-detail-pill">From {e.from_number}</span>}
                            {e.to_number != null && <span className="cl-journey-detail-pill">To {e.to_number}</span>}
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
          <button className="btn" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main CallLogPanel Component
// ---------------------------------------------------------------------------
export function CallLogPanel() {
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
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');

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
      if (dateFrom) params.set('date_from', dateFrom);
      if (dateTo) params.set('date_to', dateTo);
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
  }, [dateFrom, dateTo]);

  useEffect(() => { fetchData(); }, [fetchData]);

  // Derived: unique values for dropdowns
  const statusOptions = Array.from(new Set(calls.map(c => c.status))).filter(Boolean).sort();
  const callTypeOptions = Array.from(new Set(calls.map(c => c.call_type))).filter(Boolean).sort();
  const appOptions = Array.from(new Set(calls.map(c => c.app))).filter(Boolean).sort();

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
  useEffect(() => { setCurrentPage(1); }, [searchQuery, statusFilter, callTypeFilter, appFilter, dateFrom, dateTo]);

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
          <h2 className="cl-title">📈 Call History</h2>
          <p className="cl-subtitle">View and manage call records</p>
        </div>
        <div className="cl-header-right">
          <button 
            className="btn" 
            onClick={() => setSortAsc(!sortAsc)} 
            title={sortAsc ? 'Sort: Oldest First' : 'Sort: Newest First'}
          >
            <ArrowUpDown size={14} />
            {sortAsc ? 'Oldest First' : 'Newest First'}
          </button>
          <div className="cl-stats-card">
            <span className="cl-stats-count">{totalCount}</span>
            <span className="cl-stats-label">Total Calls</span>
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
            placeholder="Search by src or dest..."
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
          <select
            className="cl-filter-select"
            value={statusFilter}
            onChange={e => setStatusFilter(e.target.value)}
          >
            <option value="">All Statuses</option>
            {statusOptions.map(s => (
              <option key={s} value={s}>
                {STATUS_CONFIG[s]?.label || s}
              </option>
            ))}
          </select>
        </div>
        <div className="cl-filter-item">
          <select
            className="cl-filter-select"
            value={callTypeFilter}
            onChange={e => setCallTypeFilter(e.target.value)}
          >
            <option value="">All Directions</option>
            {callTypeOptions.map(t => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
        </div>
        <div className="cl-filter-item">
          <select
            className="cl-filter-select"
            value={appFilter}
            onChange={e => setAppFilter(e.target.value)}
          >
            <option value="">All Apps</option>
            {appOptions.map(a => (
              <option key={a} value={a}>{a}</option>
            ))}
          </select>
        </div>
        <div className="cl-filter-item">
          <input
            className="cl-filter-input cl-filter-date"
            type="date"
            value={dateFrom}
            onChange={e => setDateFrom(e.target.value)}
            title="Date From"
          />
        </div>
        <div className="cl-filter-item">
          <input
            className="cl-filter-input cl-filter-date"
            type="date"
            value={dateTo}
            onChange={e => setDateTo(e.target.value)}
            title="Date To"
          />
        </div>
      </div>

      {/* Table */}
      <div className="cl-table-wrap">
        {loading ? (
          <div className="cl-loading">
            <Loader2 size={32} className="spinner" />
            <p>Loading call history...</p>
          </div>
        ) : error ? (
          <div className="cl-error">
            <p>⚠️ {error}</p>
            <button className="btn btn-primary" onClick={fetchData}>Retry</button>
          </div>
        ) : pageItems.length === 0 ? (
          <div className="cl-empty">
            <Phone size={48} />
            <p>📞 No calls found</p>
          </div>
        ) : (
          <table className="cl-table">
            <thead>
              <tr>
                <th>Src</th>
                <th>Dest</th>
                <th>App</th>
                <th>Direction</th>
                <th>Status</th>
                <th>Agent</th>
                <th>Duration</th>
                <th>Talk</th>
                <th>Recording</th>
                <th>Date & Time</th>
                <th>Call Journey</th>
                <th>QOS</th>
              </tr>
            </thead>
            <tbody>
              {pageItems.map((call, idx) => {
                const st = STATUS_CONFIG[call.status] || { label: call.status, color: '#6e7681', bg: 'rgba(110,118,129,0.12)' };
                const dt = formatCallDate(call.calldate);
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
                        {call.call_type || '—'}
                      </span>
                    </td>
                    <td>
                      <span
                        className="cl-status-badge"
                        style={{ color: st.color, background: st.bg, borderColor: st.color }}
                        onClick={() => { if (call.status === 'completed' && hasQos) handleOpenQos(call); }}
                        role={call.status === 'completed' && hasQos ? 'button' : undefined}
                      >
                        {st.label}
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
                          title="Show call journey"
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
                          title="View QOS Report"
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
            Showing {startIdx + 1} to {Math.min(startIdx + ITEMS_PER_PAGE, sorted.length)} of {sorted.length} calls
          </span>
          <div className="cl-pagination-controls">
            <button
              className="btn cl-page-btn"
              disabled={safeCurrentPage <= 1}
              onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
            >
              <ChevronLeft size={16} />
              Previous
            </button>
            <span className="cl-page-current">{safeCurrentPage}</span>
            <button
              className="btn cl-page-btn"
              disabled={safeCurrentPage >= totalPages}
              onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
            >
              Next
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

