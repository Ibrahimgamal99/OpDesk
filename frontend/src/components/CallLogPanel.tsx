import { useState, useEffect, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ArrowUpDown, Phone, Download, Play, Pause,
  Loader2, BarChart3, Route,
  PhoneIncoming, PhoneOutgoing, ListOrdered, PhoneCall, Share2, PhoneOff, PhoneMissed,
  Activity, History, ArrowLeftRight, ArrowUpRight, ArrowDownLeft, Gauge, RefreshCw,
  Ear, Mic, MicOff, Users, Music, Clock, Copy, Check, Lock, ListTree, FileDown,
  Star, CheckCircle2, AlertTriangle, XCircle, type LucideIcon,
} from 'lucide-react';
import {
  Modal, Dropdown, SearchInput, Alert, Pagination, Page, Toolbar, Table, EmptyState,
  Badge, Loading, type Column, type DropdownOption,
} from './ui';
import type { CallLogRecord, QoSData, CallJourneyEvent } from '../types';
import { fetchWithAuth, getUser, RecordingFetchError } from '../auth';
import { downloadObjectUrl, useRecordingBlob } from '../hooks/useRecordingBlob';
import { downloadWithAuth } from '../lib/download';
import { messageOf } from '../lib/api';
import { PageRange } from './PageRange';
import type { DateRange } from './analyticsUtils';
import { fmtTimer } from '../lib/format';
import { StatCard, StatRow } from './FigureCards';
import { CallStatusBadge } from './CallStatusBadge';
import { CALL_STATUS_ORDER, callStatusColor, callStatusLabel } from './callStatus';
import '../styles/work.css';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type TFunction = (key: string, options?: Record<string, unknown>) => string;

/** A call's length, in the one clock format live calls use (`mm:ss`, `hh:mm:ss`). */
export function formatDuration(seconds: number): string {
  return fmtTimer(seconds);
}

/** Journey events carry a naive ISO timestamp; render it in the viewer's locale. */
function formatEventTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString(undefined, {
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
}

/** "Ended by agent 100" / "Ended by the customer" / "Ended by the system", or null. */
function endedByLabel(
  t: TFunction,
  endedBy: 'agent' | 'customer' | 'system' | null | undefined,
  agent: string | null | undefined,
): string | null {
  if (endedBy === 'agent') return t('callLog.journey.endedByAgent', { id: agent ?? '' });
  if (endedBy === 'customer') return t('callLog.journey.endedByCustomer');
  if (endedBy === 'system') return t('callLog.journey.endedBySystem');
  return null;
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
    dateLabel = t('common.today');
  } else if (callDay.getTime() === yesterday.getTime()) {
    dateLabel = t('common.yesterday');
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

/** The side a call counts on. */
type CallSide = 'inbound' | 'outbound' | 'internal';

/**
 * A call's side from its `route` (inbound_queue -> inbound), the server's reading of the
 * call's own legs; `call_type` only for a server that sends no route.
 */
function callSide(call: Pick<CallLogRecord, 'route' | 'call_type'>): CallSide | null {
  const side = call.route?.split('_')[0];
  if (side === 'inbound' || side === 'outbound' || side === 'internal') return side;
  if (call.call_type === 'IN') return 'inbound';
  if (call.call_type === 'OUT') return 'outbound';
  if (call.call_type === 'INTERNAL') return 'internal';
  return null;
}

/** A call's direction (or, for a ChanSpy row, its supervision mode) as a category label. */
function CallDirectionBadge({ call }: { call: Pick<CallLogRecord, 'is_supervision' | 'supervision' | 'call_type' | 'route'> }) {
  const { t } = useTranslation();
  if (call.is_supervision || call.route === 'internal_supervision') {
    const mode = call.supervision?.mode;
    return mode === 'whisper' ? <Badge tone="info" icon={<Mic size={14} />}>{t('callLog.supervision.WHISPER')}</Badge>
      : mode === 'barge' ? <Badge tone="info" icon={<Users size={14} />}>{t('callLog.supervision.BARGE')}</Badge>
      : <Badge tone="info" icon={<Ear size={14} />}>{t('callLog.supervision.LISTEN')}</Badge>;
  }
  const side = callSide(call);
  if (side === 'inbound') return <Badge tone="info" icon={<PhoneIncoming size={14} />}>{t('callLog.typeShort.IN', 'IN')}</Badge>;
  if (side === 'outbound') return <Badge tone="info" icon={<PhoneOutgoing size={14} />}>{t('callLog.typeShort.OUT', 'OUT')}</Badge>;
  if (side === 'internal') return <Badge tone="info" icon={<ArrowLeftRight size={14} />}>{t('callLog.typeShort.INT', 'INT')}</Badge>;
  return call.call_type ? <Badge tone="info">{call.call_type}</Badge> : <>—</>;
}

// ---------------------------------------------------------------------------
// Audio Player Component
// ---------------------------------------------------------------------------
export interface AudioPlayerProps {
  recordingPath: string | null;
  recordingFile: string | null;
  onVadClick?: () => void;
}

/**
 * A recording's player: play/pause, download, voice activity, and a seek bar while it plays.
 *
 * The file is fetched on the first play or download, with the Authorization header, and
 * played from a blob URL (useRecordingBlob): the recordings route takes no token in the
 * query string, so the token never lands in a URL, an access log or browser history. A row
 * whose call is outside the viewer's scope (403) shows a lock instead of a player.
 */
export function AudioPlayer({ recordingPath, recordingFile, onVadClick }: AudioPlayerProps) {
  const { t } = useTranslation();
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [failure, setFailure] = useState<'missing' | 'forbidden' | null>(null);
  // True while the recording downloads (first play or download).
  const [fetching, setFetching] = useState(false);
  const { load } = useRecordingBlob();

  if (!recordingPath || failure === 'missing') {
    return (
      <span className="cl-no-recording u-inline-row u-gap-1" title={t('callLog.noRecording')}>
        <Music size={14} aria-hidden />
        <span className="ui-visually-hidden">{t('callLog.noRecording')}</span>
      </span>
    );
  }
  if (failure === 'forbidden') {
    return (
      <span className="cl-no-recording u-inline-row u-gap-1" title={t('callLog.recordingForbidden')}>
        <Lock size={14} aria-hidden />
        <span className="ui-visually-hidden">{t('callLog.recordingForbidden')}</span>
      </span>
    );
  }

  /** The blob URL for this recording, attached to the <audio> element on first use. */
  const ensureSource = async (): Promise<string | null> => {
    setFetching(true);
    try {
      const url = await load(recordingPath);
      const el = audioRef.current;
      if (el && el.src !== url) el.src = url;
      return url;
    } catch (e) {
      setFailure(e instanceof RecordingFetchError && e.status === 403 ? 'forbidden' : 'missing');
      return null;
    } finally {
      setFetching(false);
    }
  };

  const togglePlay = async () => {
    const el = audioRef.current;
    if (!el) return;
    if (playing) {
      el.pause();
      return;
    }
    if (!(await ensureSource())) return;
    el.play().catch((err: unknown) => {
      // The download outlived the click's user activation: the audio is loaded, so the
      // next press plays at once. Anything else means it cannot be played.
      if (!(err instanceof DOMException && err.name === 'NotAllowedError')) setFailure('missing');
    });
  };

  const handleDownload = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const url = await ensureSource();
    if (url) downloadObjectUrl(url, recordingFile || 'recording');
  };

  const handleTimeUpdate = () => {
    if (audioRef.current) setCurrentTime(audioRef.current.currentTime);
  };
  const handleLoadedMetadata = () => {
    if (audioRef.current) {
      const d = audioRef.current.duration;
      if (!isFinite(d) || isNaN(d) || d <= 0) {
        setFailure('missing');
        return;
      }
      setDuration(d);
      setLoaded(true);
    }
  };
  const handleEnded = () => setPlaying(false);
  const handlePlay = () => setPlaying(true);
  const handlePause = () => setPlaying(false);
  // An <audio> with no source yet fires no error; one that fails to decode the blob does.
  const handleError = () => { if (audioRef.current?.getAttribute('src')) setFailure('missing'); };

  const seekTo = (seconds: number) => {
    if (!audioRef.current || !duration) return;
    audioRef.current.currentTime = Math.max(0, Math.min(duration, seconds));
  };

  const handleSeek = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    // The bar fills from the inline start, so in RTL the click distance runs from the right.
    const rtl = getComputedStyle(e.currentTarget).direction === 'rtl';
    seekTo((rtl ? 1 - pct : pct) * duration);
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
          disabled={fetching}
          aria-busy={fetching}
          title={`${playing ? t('common.pause') : t('callLog.play')}${fileHint}`}
          aria-label={playing ? t('common.pause') : t('callLog.play')}
        >
          {fetching ? <Loader2 size={14} className="spinner" /> : playing ? <Pause size={14} /> : <Play size={14} />}
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-sm btn-icon"
          onClick={handleDownload}
          disabled={fetching}
          title={`${t('callLog.download')}${fileHint}`}
          aria-label={t('callLog.download')}
        >
          <Download size={14} />
        </button>
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
      footer={<button type="button" className="btn" onClick={onClose}>{t('common.close')}</button>}
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
              <span className="cl-qos-badge agent">{call.extension || t('fields.agent')}</span>
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
  IVR:         { icon: <ListTree size={16} />,      color: 'var(--journey-queue)' },
  QUEUE_ENTER: { icon: <ListOrdered size={16} />,   color: 'var(--journey-queue)' },
  RING:        { icon: <Phone size={16} />,         color: 'var(--journey-ring)' },
  ANSWER:      { icon: <PhoneCall size={16} />,     color: 'var(--journey-answer)' },
  UNANSWERED:  { icon: <PhoneMissed size={16} />,   color: 'var(--journey-no-answer)' },
  TRANSFER:    { icon: <Share2 size={16} />,        color: 'var(--journey-transfer)' },
  LISTEN:      { icon: <Ear size={16} />,           color: 'var(--journey-supervision)' },
  WHISPER:     { icon: <Mic size={16} />,           color: 'var(--journey-supervision)' },
  BARGE:       { icon: <Users size={16} />,         color: 'var(--journey-supervision)' },
  HANGUP:      { icon: <PhoneOff size={16} />,      color: 'var(--journey-hangup)' },
};

/** Why a journey could not be shown: the call is outside the viewer's scope, or the request failed. */
export type JourneyError = 'forbidden' | 'failed';

interface CallJourneyModalProps {
  call: CallLogRecord;
  journey: CallJourneyEvent[];
  error?: JourneyError | null;
  onClose: () => void;
}

/**
 * Open a call's journey: fetch its timeline, then hand back what CallJourneyModal needs.
 * A failed fetch still opens the modal, saying why (a call outside the viewer's scope
 * answers 403), rather than leaving the click with no answer.
 */
export function useCallJourney<C extends CallLogRecord = CallLogRecord>() {
  const [journey, setJourney] = useState<{ call: C; journey: CallJourneyEvent[]; error: JourneyError | null } | null>(null);
  const [loadingLinkedid, setLoadingLinkedid] = useState<string | null>(null);
  const open = async (call: C) => {
    const linkedid = call.linkedid;
    if (!linkedid) return;
    setLoadingLinkedid(linkedid);
    try {
      const res = await fetchWithAuth(`/api/call-log/journey?linkedid=${encodeURIComponent(linkedid)}`);
      if (!res.ok) {
        setJourney({ call, journey: [], error: res.status === 403 ? 'forbidden' : 'failed' });
        return;
      }
      const json = await res.json();
      setJourney({ call, journey: (json.journey || []) as CallJourneyEvent[], error: null });
    } catch {
      setJourney({ call, journey: [], error: 'failed' });
    } finally {
      setLoadingLinkedid(null);
    }
  };
  return { journey, loadingLinkedid, open, close: () => setJourney(null) };
}

/** A call's journey: who it reached, in order, and who ended it. */
export function CallJourneyModal({ call, journey, error = null, onClose }: CallJourneyModalProps) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);

  // The Call ID is the call-log row identifier (linkedid): the same value the CRM stores and
  // that the call-history search matches. One click copies it.
  const callId = call.linkedid || call.uniqueid || '';
  const copyCallId = useCallback(() => {
    if (!callId) return;
    navigator.clipboard?.writeText(callId).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  }, [callId]);

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
      headerAside={error ? undefined : <span className="cl-journey-step-count">{stepsLabel}</span>}
      footer={<button type="button" className="btn" onClick={onClose}>{t('common.close')}</button>}
    >
      <div className="cl-journey-body">
        <div className="cl-journey-summary">
          <div className="cl-journey-summary-row">
            <span className="cl-journey-summary-label">{t('callLog.journey.contact')}</span>
            <span className="cl-journey-summary-value cl-journey-phone">
              {call.customer_name ? `${call.customer_name} · ` : ''}{call.phone_number || call.src || '—'}
            </span>
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
            {call.status && <CallStatusBadge status={call.status} />}
            {call.extension && (
              <Badge tone="info">
                {t('callLog.journey.agent', { id: call.agent_name ? `${call.agent_name} (${call.extension})` : call.extension })}
              </Badge>
            )}
          </div>
          {callId && (
            <div className="cl-journey-summary-id">
              <span className="cl-journey-summary-label">{t('callLog.journey.callId')}</span>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={copyCallId}
                title={t('callLog.journey.copyId')}
                aria-label={t('callLog.journey.copyId')}
              >
                <code dir="ltr">{callId}</code>
                {copied ? <Check size={14} /> : <Copy size={14} />}
              </button>
            </div>
          )}
        </div>

        <div className="cl-journey-timeline-wrap">
          {error ? (
            <EmptyState
              icon={error === 'forbidden' ? Lock : AlertTriangle}
              size="sm"
              title={error === 'forbidden' ? t('callLog.journey.forbidden') : t('callLog.journey.loadFailed')}
            />
          ) : journey.length === 0 ? (
            <EmptyState icon={Route} size="sm" title={t('callLog.journey.noData')} />
          ) : (
            <ul className="cl-journey-timeline" role="list">
              {journey.map((e, i) => {
                const cf = getEventConfig(e.event);
                const isLast = i === journey.length - 1;
                const endedBy = endedByLabel(t, e.ended_by, e.ended_by_agent);
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
                      <div className="cl-journey-event-time">{formatEventTime(e.time)}</div>
                      <div className="cl-journey-event-card">
                        <span className="cl-journey-event-name u-fg-var">{getEventLabel(e.event)}</span>
                        <div className="cl-journey-event-details">
                          {e.ivr != null && <span className="cl-journey-detail-pill">{t('callLog.journey.ivr', { name: e.ivr })}</span>}
                          {e.selection != null && <span className="cl-journey-detail-pill">{t('callLog.journey.selection', { key: e.selection })}</span>}
                          {e.agent != null && <span className="cl-journey-detail-pill">{t('callLog.journey.agent', { id: e.agent })}</span>}
                          {e.queue != null && <span className="cl-journey-detail-pill">{t('callLog.journey.queue', { id: e.queue })}</span>}
                          {e.duration != null && e.duration > 0 && <span className="cl-journey-detail-pill u-mono">{formatDuration(e.duration)}</span>}
                          {endedBy && <span className="cl-journey-detail-pill">{endedBy}</span>}
                          {e.from_number != null && <span className="cl-journey-detail-pill">{t('callLog.journey.from', { number: e.from_number })}</span>}
                          {e.to_number != null && <span className="cl-journey-detail-pill">{t('callLog.journey.to', { number: e.to_number })}</span>}
                          {e.supervisor != null && <span className="cl-journey-detail-pill">{t('callLog.journey.supervisor', { id: e.supervisor })}</span>}
                          {e.target != null && <span className="cl-journey-detail-pill">{t('callLog.journey.target', { id: e.target })}</span>}
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
      footer={<button type="button" className="btn" onClick={onClose}>{t('common.close')}</button>}
    >
      <div className="u-col u-gap-4">
        {recordingFile && (
          <p className="cl-vad-filename">{recordingFile}</p>
        )}

        {/* Summary stats. The speaker icons wear the same tones as their timeline
            tracks below (sp1 primary, sp2 success), so they double as the legend. */}
        <StatRow>
          <StatCard
            label={t('fields.duration', 'Duration')}
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
  /** Call History's Calls/Recordings tab bar, from App; admins only. */
  tabs?: React.ReactNode;
}

const DIRECTIONS: { value: CallSide; dot: DropdownOption['dot'] }[] = [
  { value: 'inbound', dot: 'green' },
  { value: 'outbound', dot: 'blue' },
  { value: 'internal', dot: 'neutral' },
];
const APPS = ['queue', 'ivr', 'direct'];

export function CallLogPanel({ dateRange, onDateRangeChange, tabs }: CallLogPanelProps) {
  const { t } = useTranslation();
  // Supervisors' Listen/Whisper/Barge calls are never shown to an agent (the server
  // drops them), so the toggle is offered only to those who can see them.
  const canSeeSupervision = getUser()?.role !== 'agent';

  // Data: one server page, the total behind it, and the cursor of the page after it.
  const [calls, setCalls] = useState<CallLogRecord[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [capped, setCapped] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Filters, all applied by the server
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [directionFilter, setDirectionFilter] = useState('');
  const [appFilter, setAppFilter] = useState('');
  // Supervision (listen/whisper/barge) rows are their own ChanSpy CDR calls. Hidden
  // by default; a filter surfaces them on demand.
  const [showSupervision, setShowSupervision] = useState(false);

  // Sort & pagination. The server pages with a cursor: `stack` holds the cursor of each
  // visited page so Previous can go back (stack[0] is the first page). A cursor encodes a
  // position in one result set, so the stack belongs to one set of filters: when they
  // change the table is on the first page at once, with no request for a stale page.
  const [sortAsc, setSortAsc] = useState(false);
  const filterKey = JSON.stringify([searchQuery.trim(), statusFilter, directionFilter, appFilter, showSupervision, dateRange, sortAsc]);
  const [pagesAt, setPagesAt] = useState<{ key: string; stack: (string | null)[] }>({ key: filterKey, stack: [null] });
  const stack = pagesAt.key === filterKey ? pagesAt.stack : [null];
  const pageIndex = stack.length - 1;
  const cursor = stack[pageIndex];
  const setStack = (next: (string | null)[]) => setPagesAt({ key: filterKey, stack: next });

  // QOS modal
  const [qosModal, setQosModal] = useState<{ qos: QoSData; call: CallLogRecord } | null>(null);
  // Call Journey modal
  const { journey: journeyModal, loadingLinkedid: journeyLoadingLinkedid, open: handleOpenJourney, close: closeJourney } = useCallJourney();
  // CSV export
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  // VAD modal
  const [vadModal, setVadModal] = useState<{ vad: VadData; recordingFile: string | null } | null>(null);
  const [vadLoadingUniqueid, setVadLoadingUniqueid] = useState<string | null>(null);

  // ui/SearchInput owns the debounce, so `searchQuery` is already the settled term.
  const search = searchQuery.trim();

  /**
   * The query every request shares: the list, the CSV. A search spans all history (the
   * server ignores the date default for it), so it is not pinned to the visible range --
   * a Call ID the CRM stored can be from any time.
   */
  const filterParams = useCallback(() => {
    const params = new URLSearchParams();
    if (search) {
      params.set('search', search);
    } else {
      params.set('date_from', dateRange.from);
      params.set('date_to', dateRange.to);
    }
    if (statusFilter) params.set('status', statusFilter);
    if (directionFilter) params.set('route', directionFilter);
    if (appFilter) params.set('app', appFilter);
    params.set('include_supervision', showSupervision ? 'true' : 'false');
    return params;
  }, [search, dateRange, statusFilter, directionFilter, appFilter, showSupervision]);

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
      const params = filterParams();
      params.set('limit', String(ITEMS_PER_PAGE));
      if (cursor) params.set('cursor', cursor);
      params.set('order', sortAsc ? 'asc' : 'desc');
      const res = await fetchWithAuth(`/api/call-log?${params.toString()}`, { signal: ac.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (ac.signal.aborted) return;
      setCalls(json.calls || []);
      setTotalCount(typeof json.total === 'number' ? json.total : (json.calls || []).length);
      setNextCursor(json.next_cursor ?? null);
      setCapped(Boolean(json.capped));
    } catch (err: unknown) {
      if (ac.signal.aborted) return;
      setError(err instanceof Error ? err.message : t('callLog.loadFailed', 'Failed to load call history'));
    } finally {
      if (inflightRef.current === ac) setLoading(false);
    }
  }, [filterParams, cursor, sortAsc, t]);

  useEffect(() => { fetchData(); }, [fetchData]);
  useEffect(() => () => inflightRef.current?.abort(), []);

  // The filters offer the whole vocabulary: the page holds 25 calls, not the set the
  // filter runs over.
  const statusOptions: DropdownOption[] = CALL_STATUS_ORDER.map(s => ({
    value: s, label: callStatusLabel(t, s), dotColor: callStatusColor(s),
  }));
  const directionOptions: DropdownOption[] = DIRECTIONS.map(d => ({
    value: d.value, label: t(`direction.${d.value}`), dot: d.dot,
  }));
  const appOptions: DropdownOption[] = APPS.map(a => ({ value: a, label: a }));

  const startIdx = pageIndex * ITEMS_PER_PAGE;

  const activeFilters = {
    status: Boolean(statusFilter),
    direction: Boolean(directionFilter),
    app: Boolean(appFilter),
    supervision: showSupervision,
  };
  const anyFilterActive = Boolean(search) || Object.values(activeFilters).some(Boolean);
  const clearFilters = () => {
    setSearchQuery('');
    setStatusFilter('');
    setDirectionFilter('');
    setAppFilter('');
    setShowSupervision(false);
  };

  const handleOpenQos = (call: CallLogRecord) => {
    const qos = parseQoS(call.QoS);
    if (qos) setQosModal({ qos, call });
  };

  /**
   * Download the calls the filters select as CSV: the same query as the list (date range
   * or search, the status/direction/app filters, and the caller's scope), every page of
   * it, capped by the server at 50,000 rows.
   */
  const handleExport = async () => {
    setExporting(true);
    setExportError(null);
    try {
      await downloadWithAuth(
        `/api/call-log/export?${filterParams().toString()}`,
        `call_history_${dateRange.from}_${dateRange.to}.csv`,
      );
    } catch (e) {
      setExportError(messageOf(e, t('callLog.exportFailed')));
    } finally {
      setExporting(false);
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
      key: 'direction', header: t('fields.direction'),
      cell: call => <CallDirectionBadge call={call} />,
    },
    {
      // The status, with who ended the call as its secondary line.
      key: 'status', header: t('common.status'),
      cell: call => {
        const endedBy = endedByLabel(t, call.ended_by, call.ended_by_agent);
        const badge = call.status === 'ANSWERED' && parseQoS(call.QoS) ? (
          <button type="button" className="cl-status-qos" onClick={() => handleOpenQos(call)} title={t('callLog.viewQoS')}>
            <CallStatusBadge status={call.status} />
          </button>
        ) : <CallStatusBadge status={call.status} />;
        return endedBy ? (
          <div className="cl-party">
            {badge}
            <span className="cl-secondary">{endedBy}</span>
          </div>
        ) : badge;
      },
    },
    {
      // The agent's name, with the extension as its secondary line.
      key: 'agent', header: t('fields.agent'),
      cell: call => call.agent_name ? (
        <div className="cl-party">
          <span className="cl-party-name" title={call.agent_name}>{call.agent_name}</span>
          <span className="cl-secondary u-mono">{call.extension}</span>
        </div>
      ) : (call.extension || '—'),
    },
    {
      // Duration with talk time as its secondary line: one column, both figures.
      key: 'duration', header: t('fields.duration'),
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
      // Every call with a linkedid has a journey: even a single leg says who ended it.
      // The leg count shows only when there is more than one.
      key: 'journey', header: t('callLog.journey.title'),
      cell: call => call.linkedid ? (
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => handleOpenJourney(call)}
          disabled={journeyLoadingLinkedid !== null}
          title={t('callLog.showJourney')}
          aria-label={t('callLog.showJourney')}
        >
          {journeyLoadingLinkedid === call.linkedid ? <Loader2 size={14} className="spinner" /> : <Route size={14} />}
          {call.call_journey_count != null && call.call_journey_count > 1 && call.call_journey_count}
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
      title={t('nav.callHistory')}
      count={totalCount}
      scope={<PageRange value={dateRange} onChange={onDateRangeChange} />}
      tabs={tabs}
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
              <div data-active={activeFilters.status || undefined}>
                <Dropdown
                  value={statusFilter}
                  onChange={setStatusFilter}
                  size="md"
                  ariaLabel={t('common.status')}
                  options={[{ value: '', label: t('common.allStatuses') }, ...statusOptions]}
                />
              </div>
              <div data-active={activeFilters.direction || undefined}>
                <Dropdown
                  value={directionFilter}
                  onChange={setDirectionFilter}
                  icon={ArrowUpDown}
                  size="md"
                  ariaLabel={t('fields.direction')}
                  options={[{ value: '', label: t('direction.all') }, ...directionOptions]}
                />
              </div>
              <div data-active={activeFilters.app || undefined}>
                <Dropdown
                  value={appFilter}
                  onChange={setAppFilter}
                  size="md"
                  ariaLabel={t('callLog.table.app')}
                  options={[{ value: '', label: t('callLog.allApps') }, ...appOptions]}
                />
              </div>
              {canSeeSupervision && (
                <div data-active={activeFilters.supervision || undefined}>
                  <Dropdown
                    value={showSupervision ? 'show' : ''}
                    onChange={(v) => setShowSupervision(v === 'show')}
                    size="md"
                    ariaLabel={t('callLog.supervisionShown')}
                    options={[
                      { value: '', label: t('callLog.supervisionOff') },
                      { value: 'show', label: t('callLog.supervisionShown') },
                    ]}
                  />
                </div>
              )}
            </>
          }
          actions={
            <>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => setSortAsc(!sortAsc)}
                title={sortAsc ? t('callLog.sortOldest') : t('callLog.sortNewest')}
              >
                <ArrowUpDown size={14} />
                {sortAsc ? t('callLog.sortOldestBtn') : t('callLog.sortNewestBtn')}
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={handleExport}
                disabled={exporting || loading}
                aria-busy={exporting}
                title={t('callLog.exportCsvHint')}
              >
                {exporting ? <Loader2 size={14} className="spinner" /> : <FileDown size={14} />}
                {t('callLog.exportCsv')}
              </button>
            </>
          }
        />
      }
    >
      {/* A search deliberately ignores the date range server-side, so say so. Otherwise
          the header control appears to have stopped working: the range changes and the
          results do not. */}
      {search && <p className="cl-scope-note">{t('callLog.searchScopeNote')}</p>}
      {exportError && (
        <div className="u-p-3">
          <Alert onDismiss={() => setExportError(null)}>{exportError}</Alert>
        </div>
      )}
      {loading ? (
        <Loading label={t('callLog.loading')} />
      ) : error ? (
        <div className="u-p-3">
          <Alert action={<button type="button" className="btn" onClick={fetchData}><RefreshCw size={14} />{t('common.retry')}</button>}>
            {error}
          </Alert>
        </div>
      ) : (
        <Table
          columns={columns}
          rows={calls}
          rowKey={(call, idx) => call.linkedid ? `${call.linkedid}-${idx}` : `${call.calldate}-${idx}`}
          caption={t('nav.callHistory')}
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
                  {t('common.clearFilters', 'Clear filters')}
                </button>
              ) : undefined}
            />
          }
        />
      )}

      {!loading && !error && calls.length > 0 && (
        <Pagination
          mode="cursor"
          hasPrev={pageIndex > 0}
          hasNext={Boolean(nextCursor)}
          onPrev={() => setStack(stack.slice(0, -1))}
          onNext={() => setStack([...stack, nextCursor])}
          info={t(capped ? 'callLog.showingCapped' : 'callLog.showing', {
            start: startIdx + 1,
            end: startIdx + calls.length,
            total: totalCount,
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
          error={journeyModal.error}
          onClose={closeJourney}
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
