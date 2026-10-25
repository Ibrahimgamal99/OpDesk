import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BellRing, CalendarDays, Clock, Hourglass, LayoutDashboard, Phone, Radio, TrendingUp, Users } from 'lucide-react';
import { LineChart, Line, Tooltip as ChartTooltip, ResponsiveContainer } from 'recharts';
import type { AppState, ExecutiveKPIResponse, CallLogRecord, VolumeTrendPoint } from '../types';
import { fetchWithAuth, getUser } from '../auth';
import { fmtTimer, parseClock } from '../lib/format';
import { Alert, Badge, EmptyState, Loading, Page, SegmentedBar, Tooltip } from './ui';
import { todayStr } from './analyticsUtils';
import { memberBucket } from './queueMemberState';
import { splitByDirection } from './liveRoute';
import { DirectionCards, SummaryStats, figuresFromCalls, figuresFromOverview, type PeriodFigures } from './DirectionCards';
import '../styles/dashboard.css';
import '../styles/live.css';

interface DashboardPanelProps {
  state: AppState | null;
  connected: boolean;
  lastUpdate: Date | null;
}

type Tone = '' | 'accent' | 'success' | 'warn' | 'danger';

/** The service-level target when the queue has none of its own (the backend default). */
const DEFAULT_SLA_SECS = 20;

/** Tooltip props: the sentence and the icon's name. */
interface Tip { content: string; label: string }

/** A single inline figure inside the live strip. */
function HeroStat({
  icon, label, value, tone = '', tip,
}: { icon: React.ReactNode; label: string; value: React.ReactNode; tone?: Tone; tip: Tip }) {
  return (
    <Tooltip
      {...tip}
      trigger={({ ref, ...triggerProps }) => (
        <div {...triggerProps} ref={ref} tabIndex={0} className={`dash-hero-stat${tone ? ` ${tone}` : ''}`}>
          <span className="dash-hero-stat-icon">{icon}</span>
          <span className="dash-hero-stat-value">{value}</span>
          <span className="dash-hero-stat-label">{label}</span>
        </div>
      )}
    />
  );
}

/**
 * The Dashboard: the whole system on one screen, live and for today.
 *   * the live strip -- calls in progress, callers waiting, the longest wait, ringing, workforce;
 *   * today's figures: the all-calls row (SummaryStats), then inbound and outbound (DirectionCards),
 *     the same components Analytics shows a date range with;
 *   * the 7-day volume trend and the live queue board (supervisors and admins).
 * Live figures move with the WebSocket state; today's are polled every minute.
 */
export function DashboardPanel({ state, connected, lastUpdate }: DashboardPanelProps) {
  const { t } = useTranslation();
  const isAgent = getUser()?.role === 'agent';

  // ── Live figures derived from the WebSocket state ──
  const live = useMemo(() => {
    const exts = Object.values(state?.extensions ?? {});
    const ringing = exts.filter((e) => e.status === 'ringing').length;
    const entries = Object.values(state?.queue_entries ?? {});
    const longestWait = entries.reduce((max, e) => Math.max(max, parseClock(e.wait_time)), 0);
    const base = {
      activeCalls: state?.stats.active_calls_count ?? 0,
      waiting: state?.stats.total_waiting ?? 0,
      direction: splitByDirection(Object.values(state?.active_calls ?? {})),
      ringing, longestWait,
    };

    // Who can take a call, from the agents' own presence rather than from their handsets: an
    // agent on DND, Not Ready or in wrap-up has an idle phone but is not available. Only queue
    // agents count; with no presence at all (contact-centre mode unused) the device states
    // stand in.
    const agents = Object.values(state?.agent_states ?? {}).filter((a) => a.is_agent !== false);
    if (agents.length > 0) {
      const byState = (...wanted: string[]) => agents.filter((a) => wanted.includes(a.state)).length;
      const ready = byState('ready');
      return {
        ...base,
        // Ringing is a device fact, not a presence: the agent being offered a call is still
        // Ready, so take them out of Available rather than count them twice.
        available: ready - Math.min(ringing, ready),
        onCall: byState('on_call'),
        wrapUp: byState('wrap_up'),
        notReady: byState('not_ready'),
        dnd: byState('dnd'),
        offline: byState('logged_out'),
        total: agents.length,
        fromPresence: true,
      };
    }
    const available = exts.filter((e) => e.status === 'idle').length;
    const onCall = exts.filter((e) => ['in_call', 'dialing', 'on_hold'].includes(e.status)).length;
    const total = exts.length;
    return {
      ...base,
      available, onCall, wrapUp: 0, notReady: 0, dnd: 0,
      offline: Math.max(0, total - available - onCall - ringing),
      total,
      fromPresence: false,
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
          (acc, m) => { acc[memberBucket(m)]++; return acc; },
          { available: 0, busy: 0, paused: 0, unavailable: 0 } as Record<string, number>,
        );
        const qEntries = entries.filter((e) => e.queue === ext);
        const longest = qEntries.reduce((max, e) => Math.max(max, parseClock(e.wait_time)), 0);
        const waiting = q.calls_waiting ?? 0;
        // The service-level target the queue is held to (Analytics settings), default 20 s.
        const slaSecs = q.sla_secs ?? DEFAULT_SLA_SECS;
        return {
          ext,
          name: q.extension != null && q.extension !== q.name ? `${q.extension} · ${q.name}` : q.name,
          waiting,
          longest, total: qMembers.length, slaSecs,
          available: buckets.available, busy: buckets.busy, paused: buckets.paused, unavailable: buckets.unavailable,
          // Callers holding and nobody ready to take them; someone holding past the target.
          understaffed: waiting > 0 && buckets.available === 0,
          pastTarget: waiting > 0 && longest > slaSecs,
        };
      })
      .sort((a, b) => (b.waiting - a.waiting) || a.name.localeCompare(b.name));
  }, [state]);

  // ── Today so far (analytics API for admin/supervisor, own call log for agents) ──
  const [today, setToday] = useState<PeriodFigures | null>(null);
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
          if (cancelled) return;
          setToday(figuresFromOverview(data));
        } else {
          const r = await fetchWithAuth(`/api/call-log?date=${d}&limit=1000`);
          if (!r.ok) throw new Error(String(r.status));
          const { calls } = (await r.json()) as { calls: CallLogRecord[] };
          if (cancelled) return;
          setToday(figuresFromCalls(calls));
        }
        setTodayUnavailable(false);
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
      const from = todayStr(-6);
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

  const trendHasData = trend.some((p) => p.total_calls > 0 || p.outbound_total > 0);
  const tip = (name: string, label: string, fallback: string): Tip =>
    ({ content: t(`dashboard.tip.${name}.text`, fallback), label });

  // Workforce availability segments for the hero bar. A zero-count segment still shows in
  // the legend so the row does not reflow as people move about; it just draws no band.
  const wfSegments = [
    { key: 'available', n: live.available, label: t('dashboard.kpi.available', 'Available') },
    { key: 'busy', n: live.onCall, label: t('agent.state.onCall', 'On call') },
    { key: 'ringing', n: live.ringing, label: t('dashboard.kpi.ringing', 'Ringing') },
    ...(live.fromPresence ? [
      { key: 'wrapup', n: live.wrapUp, label: t('agent.state.wrapUp', 'Wrap-up') },
      { key: 'notready', n: live.notReady, label: t('agent.state.notReady', 'Not ready') },
      { key: 'dnd', n: live.dnd, label: t('agent.state.dnd', 'Do not disturb') },
    ] : []),
    { key: 'offline', n: live.offline, label: t('dashboard.workforce.offline', 'Offline') },
  ];

  const alerts = queueRows.filter((q) => q.understaffed || q.pastTarget);

  const liveBadge = (
    <Badge tone={connected ? 'live' : 'neutral'} dot>
      {connected ? t('common.live', 'Live') : t('header.disconnected')}
      {lastUpdate && <span className="u-mono u-fg-muted">{lastUpdate.toLocaleTimeString()}</span>}
    </Badge>
  );

  return (
    <Page icon={LayoutDashboard} title={t('nav.dashboard', 'Dashboard')} actions={liveBadge}>
      <div className="dashboard-content">
        {!state ? (
          <Loading label={t('dashboard.waitingForData', 'Waiting for live data…')} />
        ) : (
          <>
            {/* ── Live strip: the whole system at a glance ── */}
            <div className="dash-hero">
              <div className="dash-hero-main">
                <div className="dash-hero-eyebrow">
                  <Radio size={14} />{t('common.live', 'Live')}
                </div>
                <div className={`dash-hero-figure${live.activeCalls > 0 ? ' active' : ''}`}>
                  <span className="dash-hero-value">{live.activeCalls}</span>
                  <span className="dash-hero-label">
                    {t('nav.activeCalls', 'Active calls')}
                    <Tooltip {...tip('activeCalls', t('nav.activeCalls', 'Active calls'), 'Calls happening right now.')} />
                  </span>
                </div>
                <div className="u-text-sm u-fg-muted">
                  {t('dashboard.kpi.totalSplitInternal', {
                    in: live.direction.inbound, out: live.direction.outbound, internal: live.direction.internal,
                  })}
                </div>
                <div className="dash-hero-stats">
                  <HeroStat
                    icon={<Hourglass size={16} />} label={t('dashboard.kpi.waiting', 'Waiting')} value={live.waiting}
                    tone={alerts.some((q) => q.understaffed) ? 'danger' : live.waiting > 0 ? 'warn' : ''}
                    tip={tip('waiting', t('dashboard.kpi.waiting', 'Waiting'), 'Callers on hold waiting for someone to pick up.')}
                  />
                  <HeroStat
                    icon={<Clock size={16} />} label={t('dashboard.kpi.longestWait', 'Longest wait')}
                    value={<span className="u-mono">{fmtTimer(live.longestWait)}</span>}
                    tone={live.longestWait >= 60 ? 'danger' : live.longestWait > 0 ? 'warn' : ''}
                    tip={tip('longestWaitLive', t('dashboard.kpi.longestWait', 'Longest wait'),
                      'How long the person who has been waiting longest has been holding. Turns red past one minute.')}
                  />
                  <HeroStat
                    icon={<BellRing size={16} />} label={t('dashboard.kpi.ringing', 'Ringing')} value={live.ringing}
                    tone={live.ringing > 0 ? 'danger' : ''}
                    tip={tip('ringing', t('dashboard.kpi.ringing', 'Ringing'), 'Phones ringing right now.')}
                  />
                </div>
              </div>

              <div className="dash-hero-wf">
                <div className="dash-hero-wf-head">
                  <span className="dash-hero-wf-title">
                    <Users size={14} />{t('dashboard.workforce.title', 'Workforce')}
                  </span>
                  <span className="dash-hero-wf-total">
                    {t('dashboard.workforce.total', { count: live.total, defaultValue: '{{count}} total' })}
                  </span>
                </div>
                <SegmentedBar
                  label={t('dashboard.workforce.title', 'Workforce')}
                  segments={wfSegments.map((s) => ({ key: s.key, value: s.n, label: s.label }))}
                  segmentClass={(s) => `dash-wf-seg ${s.key}`}
                />
                <div className="dash-wf-legend">
                  {wfSegments.map((s) => (
                    <span key={s.key} className={`dash-wf-leg ${s.key}`}>
                      <i />{s.label}<b>{s.n}</b>
                    </span>
                  ))}
                </div>
              </div>
            </div>

            {/* ── Alerts: the queues a supervisor has to act on now ── */}
            {alerts.length > 0 && (
              <div className="u-col u-gap-2">
                {alerts.map((q) => (
                  <Alert key={q.ext} tone={q.understaffed ? 'error' : 'warning'}>
                    {q.understaffed
                      ? t('dashboard.alert.understaffed', { queue: q.name, waiting: q.waiting })
                      : t('dashboard.alert.pastTarget', { queue: q.name, wait: fmtTimer(q.longest), target: fmtTimer(q.slaSecs) })}
                  </Alert>
                ))}
              </div>
            )}

            {/* ── Today ── */}
            {todayUnavailable && (
              <Alert tone="info">{t('dashboard.todayUnavailable', 'Today’s metrics are unavailable.')}</Alert>
            )}
            {!todayUnavailable && (
              <>
                <div className="dash-section-label"><CalendarDays size={14} />{t('common.today', 'Today')}</div>
                {today ? (
                  <>
                    <SummaryStats figures={today} isAgent={isAgent} />
                    <DirectionCards figures={today} periodLabel={t('dashboard.todaySoFar', 'Today so far')} />
                  </>
                ) : <Loading />}
              </>
            )}

            {/* ── 7-day volume trend ── */}
            {!isAgent && !todayUnavailable && trendHasData && (
              <div className="an-section dash-trend">
                <div className="an-section-header">
                  <span className="an-section-title u-row u-gap-1h">
                    <TrendingUp size={14} />{t('dashboard.trend.title', '7-day volume')}
                  </span>
                  <span className="dash-trend-legend">
                    <span className="dash-trend-key in"><i />{t('direction.inbound', 'Inbound')}</span>
                    <span className="dash-trend-key out"><i />{t('direction.outbound', 'Outbound')}</span>
                  </span>
                </div>
                <div dir="ltr">
                  <ResponsiveContainer width="100%" height={80}>
                    <LineChart data={trend} margin={{ top: 6, right: 6, bottom: 0, left: 6 }}>
                      <ChartTooltip
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
                      <Line type="monotone" dataKey="total_calls" name={t('direction.inbound', 'Inbound')} stroke="var(--accent-primary)" strokeWidth={2} dot={false} />
                      <Line type="monotone" dataKey="outbound_total" name={t('direction.outbound', 'Outbound')} stroke="var(--accent-teal)" strokeWidth={2} dot={false} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </div>
            )}

            {/* ── Queues, now ── An agent sees the queues of the groups they belong to (the
                server scopes the live state), so the board shows for them whenever any
                are in that scope, and stays out of the way when none are. */}
            {(!isAgent || queueRows.length > 0) && (
              <>
                <div className="dash-section-label"><Users size={14} />{t('dashboard.queues.title', 'Live queues')}</div>
                {queueRows.length === 0 ? (
                  <EmptyState icon={Users} size="sm" title={t('dashboard.queues.none', 'No queues')} />
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
                        <div key={q.ext} className={`dash-queue-card${q.understaffed || q.pastTarget ? ' has-alert' : q.waiting > 0 ? ' has-waiting' : ''}`}>
                          <div className="dash-queue-head">
                            <span className="dash-queue-name" title={q.name}>{q.name}</span>
                            <Tooltip
                              {...tip('queueWaiting', t('dashboard.queues.waiting', 'Waiting'), 'Callers holding in this queue right now.')}
                              trigger={({ ref, ...triggerProps }) => (
                                <span
                                  {...triggerProps}
                                  ref={ref}
                                  tabIndex={0}
                                  className={`dash-queue-waiting${q.waiting > 0 ? ' active' : ''}`}
                                >
                                  <Phone size={14} />{q.waiting}
                                </span>
                              )}
                            />
                          </div>
                          <div className="dash-queue-metrics">
                            <div className="dash-queue-metric">
                              <span className="dash-queue-metric-label">
                                {t('dashboard.queues.longestWait', 'Longest wait')}
                                <Tooltip {...tip('queueLongest', t('dashboard.queues.longestWait', 'Longest wait'), 'The longest anyone has been holding in this queue.')} />
                              </span>
                              <span className={`dash-queue-metric-val u-mono${q.longest > q.slaSecs ? ' danger' : q.longest > 0 ? ' warn' : ''}`}>
                                {fmtTimer(q.longest)}
                              </span>
                            </div>
                            <div className="dash-queue-metric">
                              <span className="dash-queue-metric-label">
                                {t('dashboard.queues.agents', 'Agents')}
                                <Tooltip {...tip('queueAgents', t('dashboard.queues.agents', 'Agents'), 'Agents on this queue and what they’re doing.')} />
                              </span>
                              <span className="dash-queue-metric-val">{q.total}</span>
                            </div>
                          </div>
                          <div className="dash-queue-wf">
                            <SegmentedBar
                              size="sm"
                              label={t('dashboard.queues.agents', 'Agents')}
                              segments={segs.map((s) => ({ key: s.key, value: s.n }))}
                              segmentClass={(s) => `dash-wf-seg ${s.key}`}
                            />
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
    </Page>
  );
}
