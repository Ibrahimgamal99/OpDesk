import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  LayoutDashboard, PhoneCall, Clock, PhoneMissed, Phone,
  Users, UserCheck, Timer, Activity, PhoneIncoming, Hourglass, Radio,
  PhoneForwarded, CircleSlash, CheckCircle2, TrendingUp,
} from 'lucide-react';
import { LineChart, Line, Tooltip, ResponsiveContainer } from 'recharts';
import type { AppState, QueueMember, ExecutiveKPIResponse, CallLogRecord, VolumeTrendPoint } from '../types';
import { fetchWithAuth, getUser } from '../auth';
import { todayStr } from './analyticsUtils';
import '../styles/dashboard.css';

interface DashboardPanelProps {
  state: AppState | null;
  connected: boolean;
  lastUpdate: Date | null;
}

type Tone = '' | 'accent' | 'success' | 'warn' | 'danger';

/** "HH:MM:SS" or "MM:SS" (backend _format_duration) → seconds. */
function parseClock(s: string | null | undefined): number {
  if (!s) return 0;
  const parts = s.split(':').map((p) => parseInt(p, 10));
  if (parts.some((n) => Number.isNaN(n))) return 0;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0] || 0;
}

/** Seconds → compact human duration ("45s", "3m 20s", "1h 5m"). */
function fmtDur(secs: number | null | undefined): string {
  if (secs === null || secs === undefined) return '—';
  if (secs < 60) return `${secs}s`;
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  if (m < 60) return s ? `${m}m ${s}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return mm ? `${h}h ${mm}m` : `${h}h`;
}

function fmtPct(v: number | null | undefined): string {
  if (v === null || v === undefined) return '—';
  return `${Math.round(v)}%`;
}

/** Classify a queue member into a live availability bucket (mirrors QueuesPanel). */
function memberState(m: QueueMember): 'paused' | 'unavailable' | 'busy' | 'available' {
  if (m.paused) return 'paused';
  const s = (m.status || '').toLowerCase();
  if (s === 'unavailable' || s === 'invalid' || m.status === '4' || m.status === '5') return 'unavailable';
  if (s === 'in use' || s === 'busy' || s === 'ring+in use' || m.status === '2' || m.status === '3') return 'busy';
  return 'available';
}

interface TodayTotals {
  totalCalls: number;
  answered: number;
  missed: number;
  answerRate: number | null;
  slaPct: number | null;
  avgWaitSecs: number | null;
  ahtSecs: number | null;
  abandonRate: number | null;
  fcrPct: number | null;
  outboundTotal: number | null;
  outboundAnswered: number | null;
  hasQueueMetrics: boolean;
}

function Tile({
  icon, label, value, tone = '', sub,
}: { icon: React.ReactNode; label: string; value: React.ReactNode; tone?: Tone; sub?: string }) {
  return (
    <div className={`dash-tile${tone ? ` ${tone}` : ''}`}>
      <div className="dash-tile-icon">{icon}</div>
      <div className="dash-tile-body">
        <div className="dash-tile-value">{value}</div>
        <div className="dash-tile-label">{label}</div>
        {sub && <div className="dash-tile-sub">{sub}</div>}
      </div>
    </div>
  );
}

function HeroStat({
  icon, label, value, tone = '',
}: { icon: React.ReactNode; label: string; value: React.ReactNode; tone?: Tone }) {
  return (
    <div className={`dash-hero-stat${tone ? ` ${tone}` : ''}`}>
      <span className="dash-hero-stat-icon">{icon}</span>
      <span className="dash-hero-stat-value">{value}</span>
      <span className="dash-hero-stat-label">{label}</span>
    </div>
  );
}

export function DashboardPanel({ state, connected, lastUpdate }: DashboardPanelProps) {
  const { t } = useTranslation();
  const isAgent = getUser()?.role === 'agent';

  // ── Live figures derived from the WebSocket state ──
  const live = useMemo(() => {
    const exts = Object.values(state?.extensions ?? {});
    const available = exts.filter((e) => e.status === 'idle').length;
    const onCall = exts.filter((e) => ['in_call', 'dialing', 'on_hold'].includes(e.status)).length;
    const ringing = exts.filter((e) => e.status === 'ringing').length;
    const total = exts.length;
    const offline = Math.max(0, total - available - onCall - ringing);
    const entries = Object.values(state?.queue_entries ?? {});
    const longestWait = entries.reduce((max, e) => Math.max(max, parseClock(e.wait_time)), 0);
    return {
      activeCalls: state?.stats.active_calls_count ?? 0,
      waiting: state?.stats.total_waiting ?? 0,
      available, onCall, ringing, offline, total, longestWait,
    };
  }, [state]);

  // ── Per-queue live board ──
  const queueRows = useMemo(() => {
    const queues = Object.values(state?.queues ?? {});
    const members = Object.values(state?.queue_members ?? {});
    const entries = Object.values(state?.queue_entries ?? {});
    return queues
      .map((q) => {
        const ext = q.extension ?? q.name;
        const qMembers = members.filter((m) => m.queue === ext);
        const buckets = qMembers.reduce(
          (acc, m) => { acc[memberState(m)]++; return acc; },
          { available: 0, busy: 0, paused: 0, unavailable: 0 } as Record<string, number>,
        );
        const qEntries = entries.filter((e) => e.queue === ext);
        const longest = qEntries.reduce((max, e) => Math.max(max, parseClock(e.wait_time)), 0);
        return {
          ext,
          name: q.extension != null && q.extension !== q.name ? `${q.extension} · ${q.name}` : q.name,
          waiting: q.calls_waiting ?? 0,
          longest, total: qMembers.length,
          available: buckets.available, busy: buckets.busy, paused: buckets.paused, unavailable: buckets.unavailable,
        };
      })
      .sort((a, b) => (b.waiting - a.waiting) || a.name.localeCompare(b.name));
  }, [state]);

  // ── Today's totals ──
  const [today, setToday] = useState<TodayTotals | null>(null);
  const [todayUnavailable, setTodayUnavailable] = useState(false);
  const [trend, setTrend] = useState<VolumeTrendPoint[]>([]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const d = todayStr();
      try {
        if (!isAgent) {
          const r = await fetchWithAuth(`/api/analytics/overview?date_from=${d}&date_to=${d}`);
          if (!r.ok) throw new Error(String(r.status));
          const data: ExecutiveKPIResponse = await r.json();
          const cur = data.current;
          if (cancelled) return;
          // Total calls / Answered render the COMBINED (inbound + outbound) figures,
          // so the answer rate must come from the same pair — deriving it from the
          // inbound-only fields made the percentage contradict the two numbers
          // displayed beside it whenever there was outbound traffic.
          const rateTotal = cur.combined?.total_calls ?? cur.total_calls;
          const rateAnswered = cur.combined?.answered_calls ?? cur.answered_calls;
          setToday({
            totalCalls: rateTotal,
            answered: rateAnswered,
            missed: cur.abandoned_calls,
            answerRate: rateTotal > 0 ? (rateAnswered / rateTotal) * 100 : null,
            slaPct: cur.sla_pct,
            avgWaitSecs: cur.avg_wait_secs,
            ahtSecs: cur.aht_secs,
            abandonRate: cur.abandonment_rate,
            fcrPct: cur.fcr_pct,
            outboundTotal: cur.outbound?.total_calls ?? null,
            outboundAnswered: cur.outbound?.answered_calls ?? null,
            hasQueueMetrics: true,
          });
          setTodayUnavailable(false);
        } else {
          const r = await fetchWithAuth(`/api/call-log?date=${d}&limit=1000`);
          if (!r.ok) throw new Error(String(r.status));
          const { calls } = (await r.json()) as { calls: CallLogRecord[] };
          if (cancelled) return;
          const answeredRows = calls.filter((c) => (c.disposition || '').toUpperCase() === 'ANSWERED');
          const talk = answeredRows.map((c) => c.talk || 0).filter((x) => x > 0);
          setToday({
            totalCalls: calls.length,
            answered: answeredRows.length,
            missed: calls.length - answeredRows.length,
            answerRate: calls.length > 0 ? (answeredRows.length / calls.length) * 100 : null,
            slaPct: null, avgWaitSecs: null,
            ahtSecs: talk.length ? Math.round(talk.reduce((a, b) => a + b, 0) / talk.length) : null,
            abandonRate: null, fcrPct: null, outboundTotal: null, outboundAnswered: null,
            hasQueueMetrics: false,
          });
          setTodayUnavailable(false);
        }
      } catch {
        if (!cancelled) { setToday(null); setTodayUnavailable(true); }
      }
    };
    load();
    const id = window.setInterval(load, 60000);
    return () => { cancelled = true; window.clearInterval(id); };
  }, [isAgent]);

  // ── Rolling 7-day volume trend (admin/supervisor only) ──
  useEffect(() => {
    if (isAgent) { setTrend([]); return; }
    let cancelled = false;
    const load = async () => {
      const to = todayStr();
      const from = new Date(Date.now() - 6 * 86400000).toISOString().slice(0, 10);
      try {
        const r = await fetchWithAuth(`/api/analytics/trend?date_from=${from}&date_to=${to}`);
        if (!r.ok) throw new Error(String(r.status));
        const { trend: pts } = (await r.json()) as { trend: VolumeTrendPoint[] };
        if (!cancelled) setTrend(pts || []);
      } catch {
        if (!cancelled) setTrend([]);
      }
    };
    load();
    const id = window.setInterval(load, 300000);
    return () => { cancelled = true; window.clearInterval(id); };
  }, [isAgent]);

  const answerTone: Tone = today?.answerRate == null ? '' : today.answerRate >= 80 ? 'success' : today.answerRate >= 50 ? 'warn' : 'danger';
  const slaTone: Tone = today?.slaPct == null ? '' : today.slaPct >= 80 ? 'success' : today.slaPct >= 60 ? 'warn' : 'danger';
  const abandonTone: Tone = today?.abandonRate == null ? '' : today.abandonRate <= 5 ? 'success' : today.abandonRate <= 10 ? 'warn' : 'danger';
  const fcrTone: Tone = today?.fcrPct == null ? '' : today.fcrPct >= 85 ? 'success' : today.fcrPct >= 70 ? 'warn' : 'danger';
  const trendHasData = trend.some((p) => p.total_calls > 0 || p.outbound_total > 0);

  const wfSegments = [
    { key: 'available', n: live.available, label: t('dashboard.kpi.available', 'Available') },
    { key: 'busy', n: live.onCall, label: t('dashboard.kpi.onCall', 'On call') },
    { key: 'ringing', n: live.ringing, label: t('dashboard.kpi.ringing', 'Ringing') },
    { key: 'offline', n: live.offline, label: t('dashboard.workforce.offline', 'Offline') },
  ];

  return (
    <div className="panel dashboard">
      <div className="panel-header">
        <h2 className="panel-title">
          <LayoutDashboard size={18} className="panel-title-icon" />
          {t('dashboard.title', 'Dashboard')}
        </h2>
        <div className={`dash-live-badge${connected ? ' on' : ''}`}>
          <span className="dash-live-dot" />
          <span>{connected ? t('dashboard.liveNow', 'Live') : t('header.disconnected', 'Disconnected')}</span>
          {lastUpdate && (
            <span className="dash-live-time">{lastUpdate.toLocaleTimeString()}</span>
          )}
        </div>
      </div>

      <div className="panel-content dashboard-content">
        {!state ? (
          <div className="dash-waiting">
            <Activity size={20} className="dash-waiting-icon" />
            {t('dashboard.waitingForData', 'Waiting for live data…')}
          </div>
        ) : (
          <>
            {/* ── Live hero band ── */}
            <div className="dash-hero">
              <div className="dash-hero-main">
                <div className="dash-hero-eyebrow">
                  <Radio size={13} />{t('dashboard.live', 'Live')}
                </div>
                <div className={`dash-hero-figure${live.activeCalls > 0 ? ' active' : ''}`}>
                  <span className="dash-hero-value">{live.activeCalls}</span>
                  <span className="dash-hero-label">{t('dashboard.kpi.activeCalls', 'Active calls')}</span>
                </div>
                <div className="dash-hero-stats">
                  <HeroStat icon={<Hourglass size={16} />} label={t('dashboard.kpi.waiting', 'Waiting')} value={live.waiting} tone={live.waiting > 0 ? 'warn' : ''} />
                  <HeroStat icon={<PhoneIncoming size={16} />} label={t('dashboard.kpi.ringing', 'Ringing')} value={live.ringing} tone={live.ringing > 0 ? 'danger' : ''} />
                  <HeroStat icon={<Clock size={16} />} label={t('dashboard.kpi.longestWait', 'Longest wait')} value={fmtDur(live.longestWait)} tone={live.longestWait >= 60 ? 'danger' : live.longestWait > 0 ? 'warn' : ''} />
                </div>
              </div>

              <div className="dash-hero-wf">
                <div className="dash-hero-wf-head">
                  <span className="dash-hero-wf-title">
                    <Users size={14} />{t('dashboard.workforce.title', 'Workforce')}
                  </span>
                  <span className="dash-hero-wf-total">{t('dashboard.workforce.total', { count: live.total, defaultValue: `${live.total} total` })}</span>
                </div>
                <div className="dash-wf-bar" role="img" aria-label={t('dashboard.workforce.title', 'Workforce')}>
                  {live.total === 0
                    ? <div className="dash-wf-seg empty" style={{ flex: 1 }} />
                    : wfSegments.filter((s) => s.n > 0).map((s) => (
                        <div key={s.key} className={`dash-wf-seg ${s.key}`} style={{ flex: s.n }} title={`${s.label}: ${s.n}`} />
                      ))}
                </div>
                <div className="dash-wf-legend">
                  {wfSegments.map((s) => (
                    <span key={s.key} className={`dash-wf-leg ${s.key}`}>
                      <i />{s.label}<b>{s.n}</b>
                    </span>
                  ))}
                </div>
              </div>
            </div>

            {/* ── Today section ── */}
            <div className="dash-section-label"><Activity size={13} />{t('dashboard.today', 'Today')}</div>
            {todayUnavailable ? (
              <div className="dash-waiting">{t('dashboard.todayUnavailable', 'Today’s metrics are unavailable.')}</div>
            ) : (
              <div className="dash-grid">
                <Tile icon={<PhoneCall size={22} />} label={t('dashboard.kpi.totalCalls', 'Total calls')} value={today ? today.totalCalls.toLocaleString() : '—'} tone="accent" />
                <Tile icon={<UserCheck size={22} />} label={t('dashboard.kpi.answered', 'Answered')} value={today ? today.answered.toLocaleString() : '—'} tone="success" />
                <Tile icon={<PhoneMissed size={22} />} label={isAgent ? t('dashboard.kpi.missed', 'Missed') : t('dashboard.kpi.abandoned', 'Abandoned')} value={today ? today.missed.toLocaleString() : '—'} tone={today && today.missed > 0 ? 'danger' : ''} />
                <Tile icon={<Users size={22} />} label={t('dashboard.kpi.answerRate', 'Answer rate')} value={fmtPct(today?.answerRate)} tone={answerTone} />
                {today?.hasQueueMetrics && (
                  <Tile icon={<Activity size={22} />} label={t('dashboard.kpi.sla', 'SLA')} value={fmtPct(today?.slaPct)} tone={slaTone} />
                )}
                {today?.hasQueueMetrics && (
                  <Tile icon={<CircleSlash size={22} />} label={t('dashboard.kpi.abandonRate', 'Abandon rate')} value={fmtPct(today?.abandonRate)} tone={abandonTone} />
                )}
                {today?.hasQueueMetrics && (
                  <Tile icon={<CheckCircle2 size={22} />} label={t('dashboard.kpi.fcr', 'FCR')} value={fmtPct(today?.fcrPct)} tone={fcrTone} />
                )}
                {today?.hasQueueMetrics && (
                  <Tile icon={<Hourglass size={22} />} label={t('dashboard.kpi.avgWait', 'Avg wait')} value={fmtDur(today?.avgWaitSecs)} />
                )}
                <Tile icon={<Timer size={22} />} label={t('dashboard.kpi.aht', 'AHT')} value={fmtDur(today?.ahtSecs)} />
                {today?.hasQueueMetrics && today.outboundTotal != null && (
                  <Tile
                    icon={<PhoneForwarded size={22} />}
                    label={t('dashboard.kpi.outbound', 'Outbound')}
                    value={today.outboundTotal.toLocaleString()}
                    sub={today.outboundAnswered != null ? t('dashboard.kpi.outboundAnsweredSub', { count: today.outboundAnswered, defaultValue: `${today.outboundAnswered} answered` }) : undefined}
                  />
                )}
              </div>
            )}

            {/* ── 7-day volume trend ── */}
            {!isAgent && !todayUnavailable && trendHasData && (
              <div className="dash-trend">
                <div className="dash-trend-head">
                  <span className="dash-trend-title"><TrendingUp size={14} />{t('dashboard.trend.title', '7-day volume')}</span>
                  <span className="dash-trend-legend">
                    <span className="dash-trend-key in"><i />{t('dashboard.trend.inbound', 'Inbound')}</span>
                    <span className="dash-trend-key out"><i />{t('dashboard.trend.outbound', 'Outbound')}</span>
                  </span>
                </div>
                <div className="dash-trend-chart" dir="ltr">
                  <ResponsiveContainer width="100%" height={80}>
                    <LineChart data={trend} margin={{ top: 6, right: 6, bottom: 0, left: 6 }}>
                      <Tooltip
                        contentStyle={{
                          background: 'var(--bg-card)',
                          border: '1px solid var(--border-primary)',
                          borderRadius: 'var(--radius-md)',
                          fontSize: 'var(--text-xs)',
                          color: 'var(--text-primary)',
                          boxShadow: 'var(--shadow-md)',
                        }}
                        labelStyle={{ color: 'var(--text-muted)' }}
                        cursor={{ stroke: 'var(--border-accent)' }}
                        labelFormatter={(idx) => trend[idx as number]?.date ?? ''}
                      />
                      <Line type="monotone" dataKey="total_calls" name={t('dashboard.trend.inbound', 'Inbound')} stroke="var(--accent-primary)" strokeWidth={2} dot={false} />
                      <Line type="monotone" dataKey="outbound_total" name={t('dashboard.trend.outbound', 'Outbound')} stroke="var(--accent-teal)" strokeWidth={2} dot={false} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </div>
            )}

            {/* ── Live queue board ── */}
            {!isAgent && (
              <>
                <div className="dash-section-label"><Users size={13} />{t('dashboard.queues.title', 'Live queues')}</div>
                {queueRows.length === 0 ? (
                  <div className="dash-waiting">{t('dashboard.queues.none', 'No queues')}</div>
                ) : (
                  <div className="dash-queue-board">
                    {queueRows.map((q) => {
                      const segs = [
                        { key: 'available', n: q.available },
                        { key: 'busy', n: q.busy },
                        { key: 'paused', n: q.paused },
                        { key: 'unavailable', n: q.unavailable },
                      ];
                      return (
                        <div key={q.ext} className={`dash-queue-card${q.waiting > 0 ? ' has-waiting' : ''}`}>
                          <div className="dash-queue-head">
                            <span className="dash-queue-name" title={q.name}>{q.name}</span>
                            <span className={`dash-queue-waiting${q.waiting > 0 ? ' active' : ''}`}>
                              <Phone size={13} />{q.waiting}
                            </span>
                          </div>
                          <div className="dash-queue-metrics">
                            <div className="dash-queue-metric">
                              <span className="dash-queue-metric-label">{t('dashboard.queues.longestWait', 'Longest wait')}</span>
                              <span className={`dash-queue-metric-val${q.longest >= 60 ? ' danger' : q.longest > 0 ? ' warn' : ''}`}>{fmtDur(q.longest)}</span>
                            </div>
                            <div className="dash-queue-metric">
                              <span className="dash-queue-metric-label">{t('dashboard.queues.agents', 'Agents')}</span>
                              <span className="dash-queue-metric-val">{q.total}</span>
                            </div>
                          </div>
                          <div className="dash-queue-wf">
                            <div className="dash-wf-bar sm" role="img" aria-label={t('dashboard.queues.agents', 'Agents')}>
                              {q.total === 0
                                ? <div className="dash-wf-seg empty" style={{ flex: 1 }} />
                                : segs.filter((s) => s.n > 0).map((s) => (
                                    <div key={s.key} className={`dash-wf-seg ${s.key}`} style={{ flex: s.n }} />
                                  ))}
                            </div>
                            <div className="dash-queue-agents">
                              <span className="dash-agent-pill available"><i />{q.available} {t('dashboard.queues.available', 'available')}</span>
                              <span className="dash-agent-pill busy"><i />{q.busy} {t('dashboard.queues.busy', 'busy')}</span>
                              <span className="dash-agent-pill paused"><i />{q.paused} {t('dashboard.queues.paused', 'paused')}</span>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
