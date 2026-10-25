import type { CSSProperties } from 'react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { History, LogIn, LogOut, UserCheck } from 'lucide-react';
import type { AgentTimeline, AgentTimelineEntry } from '../types';
import type { DateRange } from './analyticsUtils';
import { fmtSecs, buildDateParams, analyticsGet, useAnalyticsFetch } from './analyticsUtils';
import { AGENT_STATE_META, StatusBadge } from './statusBadge';
import { usePauseReasons } from '../hooks/usePauseReasons';
import { Alert, Badge, EmptyState, Loading, Modal } from './ui';

interface Props {
  agent: string;
  name: string;
  dateRange: DateRange;
  onClose: () => void;
}

/** ISO -> local HH:MM:SS. The trace is read against the wall clock, so it keeps seconds. */
function fmtTime(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/** ISO -> local date, shown once per session so a multi-day range stays readable. */
function fmtDay(iso: string): string {
  return new Date(iso).toLocaleDateString([], { weekday: 'short', day: '2-digit', month: 'short' });
}

/**
 * Sources worth naming on a move. The agent's own web action ('ui') is the unremarkable
 * case and 'system' is a restart artefact; the others each say something a supervisor
 * would want to know: the agent used a feature code on the handset, or a supervisor
 * moved them.
 */
const SHOWN_SOURCES: Record<string, { key: string; fallback: string }> = {
  ami:        { key: 'agent.timeline.source.ami',        fallback: 'phone' },
  supervisor: { key: 'agent.timeline.source.supervisor', fallback: 'supervisor' },
};

/**
 * What this move WAS, in one line: the state, plus the reason when the state alone does
 * not say it (Not Ready means little without "Lunch"). Wrap-up carries the system
 * wrap-up reason, which would only restate the state, so it is dropped.
 */
function entryLabel(e: AgentTimelineEntry, t: TFunction, labelFor: (code?: string | null) => string | null): string {
  const meta = AGENT_STATE_META[e.state] ?? AGENT_STATE_META.logged_out;
  const base = t(meta.key, meta.fallback);
  const reason = e.state === 'not_ready' ? (e.reason_label || labelFor(e.reason_code)) : null;
  if (reason) {
    // Interpolated, not concatenated: under Arabic (RTL) two runs joined in JS land in the
    // wrong visual order.
    return t('agent.timeline.stateWithReason', '{{state}} · {{reason}}', { state: base, reason });
  }
  return base;
}

/**
 * Agent Adherence row click: one agent's state-change trace for the selected period
 * (GET /api/analytics/agent-adherence/timeline).
 *
 * Grouped by login session (newest first), because "every move" only makes sense against
 * the shift it happened in: a logout ends a session and the next login starts a new one.
 * Inside a session every presence state the agent held is listed in order with its clock
 * time and duration. Logins and logouts are the session's boundaries rather than rows,
 * since a logout writes no segment of its own.
 */
export function AgentTimelineModal({ agent, name, dateRange, onClose }: Props) {
  const { t } = useTranslation();
  const { labelFor } = usePauseReasons({ activeOnly: false });
  const { data, loading, error } = useAnalyticsFetch<AgentTimeline>(
    () => {
      const params = buildDateParams(dateRange.from, dateRange.to);
      params.set('agent', agent);
      return analyticsGet<AgentTimeline>(`/api/analytics/agent-adherence/timeline?${params}`);
    },
    [agent, dateRange],
  );

  const sessions = data?.sessions ?? [];
  // The route answers 403 for an agent outside the caller's scope.
  const forbidden = !!error && /\b403\b/.test(error);

  return (
    <Modal
      open
      onClose={onClose}
      width="xl"
      className="an-tl-modal"
      icon={<UserCheck size={16} />}
      title={name && name !== agent ? `${name} · ${agent}` : agent}
      headerAside={
        <span className="an-tl-period">
          {dateRange.from === dateRange.to
            ? dateRange.from
            : t('agent.timeline.period', '{{from}} to {{to}}', { from: dateRange.from, to: dateRange.to })}
        </span>
      }
      footer={<button type="button" className="btn" onClick={onClose}>{t('common.close', 'Close')}</button>}
    >
      <div className="an-tl-body">
        {loading && <Loading size="sm" label={t('analytics.loading')} />}
        {!loading && error && (
          <Alert>
            {forbidden
              ? t('agent.timeline.forbidden', 'You are not allowed to see this agent\'s activity.')
              : t('analytics.error')}
          </Alert>
        )}
        {!loading && !error && sessions.length === 0 && (
          <EmptyState
            icon={History}
            size="sm"
            title={t('agent.timeline.empty', 'No activity for this period')}
            description={t('agent.timeline.emptyHint', 'This agent did not log in during the selected dates.')}
          />
        )}

        {!loading && !error && sessions.map((s, i) => (
          <section className="an-tl-session" key={`${s.login}-${i}`}>
            <div className="an-tl-session-head">
              <div className="an-tl-session-when">
                <span className="an-tl-day">{fmtDay(s.login)}</span>
                <span className="an-tl-bound">
                  <LogIn size={14} aria-hidden /> {fmtTime(s.login)}
                </span>
                <span className="an-tl-arrow" aria-hidden>→</span>
                {s.open ? (
                  <Badge tone="success">{t('agent.adherence.stillIn', 'In')}</Badge>
                ) : (
                  <span className="an-tl-bound">
                    <LogOut size={14} aria-hidden /> {fmtTime(s.logout)}
                    {/* DND drops the agent from every queue exactly as a logout does, so a
                        shift can end there. Said plainly, or the row looks like a logout
                        that never happened. */}
                    {s.closed_by === 'dnd' && (
                      <Badge tone="neutral">{t('agent.timeline.leftOnDnd', 'left on DND')}</Badge>
                    )}
                  </span>
                )}
              </div>
              <div className="an-tl-session-dur">
                {t('agent.timeline.sessionLength', 'Session')} <strong>{fmtSecs(s.duration_secs)}</strong>
              </div>
            </div>

            <ol className="an-tl-list">
              {s.entries.map(e => {
                const meta = AGENT_STATE_META[e.state] ?? AGENT_STATE_META.logged_out;
                return (
                  <li className="an-tl-item" key={e.id}>
                    <span className="an-tl-time">{fmtTime(e.started_at)}</span>
                    <span className="an-tl-rail" style={{ '--tl-dot': `var(${meta.varName})` } as CSSProperties} />
                    <span className="an-tl-state">
                      <StatusBadge meta={meta} label={entryLabel(e, t, labelFor)} />
                    </span>
                    <span className="an-tl-meta">
                      {e.queue && (
                        <Badge tone="info">{t('agent.timeline.queue', { queue: e.queue, defaultValue: 'Queue {{queue}}' })}</Badge>
                      )}
                      {/* Who made the move, when it was not the agent in the web app.
                          'system' (a restart re-opening the same state) is left out. */}
                      {e.source && SHOWN_SOURCES[e.source] && (
                        <Badge tone="info">
                          {t(SHOWN_SOURCES[e.source].key, SHOWN_SOURCES[e.source].fallback)}
                        </Badge>
                      )}
                    </span>
                    <span className="an-tl-dur">
                      {e.open
                        ? <em>{t('agent.timeline.ongoing', { duration: fmtSecs(e.duration_secs), defaultValue: 'ongoing · {{duration}}' })}</em>
                        : fmtSecs(e.duration_secs)}
                    </span>
                  </li>
                );
              })}
            </ol>
          </section>
        ))}
      </div>
    </Modal>
  );
}
