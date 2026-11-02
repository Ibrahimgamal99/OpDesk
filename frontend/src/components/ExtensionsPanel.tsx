import { useEffect, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Phone, PhoneIncoming, RefreshCw, Radio, Clock, List, LayoutGrid, Headset, HeadphoneOff, Pause, Smartphone,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { ActionMessage, Extension, AgentStateInfo, PauseReason } from '../types';
import { getUser } from '../auth';
import { StatusBadge, AGENT_STATE_META, DEVICE_STATUS_META, resolveAgentMeta, type StatusMeta } from './statusBadge';
import { usePauseReasons } from '../hooks/usePauseReasons';
import { breakPressure, type BreakPressure } from '../hooks/usePresenceControls';
import { SuperviseActions } from './SuperviseActions';
import { ExtensionActionsMenu } from './ExtensionActionsMenu';
import { AgentTimelineModal } from './AgentTimelineModal';
import { AgentCallsModal } from './AgentCallsModal';
import { todayStr } from './analyticsUtils';
import { countBy, presentOptions, showFilter } from '../lib/filters';
import { Dropdown, EmptyState, Page, SearchInput, Toolbar } from './ui';
import { fmtTimer } from '../lib/format';
import type { DropdownOption } from './ui';
import '../styles/live.css';

/** Live queue presence for an extension (Ready / Not-Ready · reason code), derived from
 *  `queue_members`. Only a fallback for a backend that sends no `agent_states`. */
export interface MemberPresence { queueOn: boolean; paused: boolean; reason: string }

interface ExtensionsPanelProps {
  extensions: Record<string, Extension>;
  /** Extension -> live agent presence (the WebSocket `agent_states`). Authoritative when present. */
  agentStates?: Record<string, AgentStateInfo>;
  /** Extension -> queue presence, used only when the backend sends no `agent_states`. */
  memberPresence?: Record<string, MemberPresence>;
  onSupervisorAction: (mode: 'listen' | 'whisper' | 'barge', target: string) => void;
  onSync?: () => void;
  /** Extension -> webrtc 'yes'|'no'; shown as a read-only chip (toggling lives in Users → Create/Edit). */
  webrtcMap?: Record<string, string>;
  /** The live socket's action channel: the ⋯ menu's state changes go through it with `agent`. */
  sendAction: (action: ActionMessage) => void;
  /** Put a number in the softphone and open it; absent when this user has no web phone. */
  onCallExtension?: (ext: string) => void;
}

type ViewMode = 'grid' | 'list';
const VIEW_STORAGE_KEY = 'opdesk:extensions-view';

/** Grid/List choice is per user: several people may share one browser. */
function viewStorageKey(): string {
  const id = getUser()?.id;
  return id != null ? `${VIEW_STORAGE_KEY}:${id}` : VIEW_STORAGE_KEY;
}

/** What the Status filter narrows by: the status the card's badge is showing. */
type StatusBucket = 'available' | 'in_call' | 'ringing' | 'on_hold' | 'offline' | 'dnd' | 'not_ready' | 'wrap_up';

/** One extension's resolved status: the badge it wears and the filter bucket it falls in. */
interface ResolvedStatus {
  meta: StatusMeta;
  label: string;
  title?: string;
  bucket: StatusBucket;
  /** Epoch ms the shown status began, for the card's time-in-state timer. Unset when unknown. */
  since?: number;
}

const DEVICE_BUCKET: Record<Extension['status'], StatusBucket> = {
  idle: 'available', ringing: 'ringing', in_call: 'in_call', dialing: 'in_call',
  on_hold: 'on_hold', unavailable: 'offline',
};

const AGENT_BUCKET: Record<AgentStateInfo['state'], StatusBucket> = {
  ready: 'available', available: 'available', on_call: 'in_call', wrap_up: 'wrap_up',
  not_ready: 'not_ready', dnd: 'dnd', logged_out: 'offline', break_offline: 'offline',
};

/**
 * One status per card, one badge. Resolved here rather than inside the card so the Status
 * filter and the badge cannot disagree.
 *  - An available extension (agent or plain): its availability IS the status (Available,
 *    Break with the reason's label, On Call, Wrap-up). A live call while Available lets the
 *    device status drive the card (Ringing / Dialing / On Hold read better than "On Call"),
 *    and DND shows when Available with the flag on. An Available extension whose phone is
 *    asleep (push) keeps the label but dims to grey.
 *  - Offline (no availability): DND when its flag is set, otherwise its raw device status.
 *  - A backend without `agent_states`: the queue-member fallback (Not-Ready / Ready).
 */
function resolveStatus(
  extension: Extension,
  agentState: AgentStateInfo | undefined,
  presence: MemberPresence | undefined,
  t: TFunction,
  labelFor: (code?: string | null) => string | null,
): ResolvedStatus {
  const device = (): ResolvedStatus => ({
    meta: DEVICE_STATUS_META[extension.status] ?? DEVICE_STATUS_META.unavailable,
    label: t(`extensions.status.${extension.status}`, { defaultValue: extension.status }),
    bucket: DEVICE_BUCKET[extension.status] ?? 'offline',
  });
  const deviceBusy = ['in_call', 'dialing', 'ringing', 'on_hold'].includes(extension.status);
  const notReadyLabel = (code?: string | null) => {
    const base = t('extensions.status.notReady', 'Not Ready');
    const reason = labelFor(code);
    return reason ? `${base} · ${reason}` : base;
  };

  // Availability is tracked for every reachable extension (agents and plain extensions).
  if (agentState && agentState.state !== 'logged_out') {
    const queueTitle = agentState.queue
      ? t('agent.state.queueLabel', { queue: agentState.queue, defaultValue: 'Queue: {{queue}}' })
      : undefined;
    const presenceIsIdle = agentState.state === 'ready' || agentState.state === 'available';
    if (deviceBusy && presenceIsIdle) return { ...device(), title: queueTitle };
    if (presenceIsIdle && (agentState.dnd || extension.dnd || agentState.state === 'dnd')) {
      return { meta: AGENT_STATE_META.dnd, label: t('extensions.status.dnd', 'Do Not Disturb'), bucket: 'dnd' };
    }
    const resolved = resolveAgentMeta(agentState.state, extension.status === 'unavailable');
    return {
      meta: resolved.meta,
      label: agentState.state === 'not_ready'
        ? notReadyLabel(agentState.reason_code)
        : t(resolved.meta.key, resolved.meta.fallback),
      title: resolved.asleep
        ? t('agent.state.deviceAsleep', 'Available, but the phone is asleep; it wakes on the next call')
        : queueTitle,
      bucket: AGENT_BUCKET[agentState.state] ?? 'offline',
    };
  }
  if (!deviceBusy && (extension.dnd || agentState?.state === 'dnd')) {
    return { meta: AGENT_STATE_META.dnd, label: t('extensions.status.dnd', 'Do Not Disturb'), bucket: 'dnd' };
  }
  if (!agentState && !deviceBusy && presence?.queueOn && presence.paused) {
    return { meta: AGENT_STATE_META.not_ready, label: notReadyLabel(presence.reason), bucket: 'not_ready' };
  }
  if (!agentState && !deviceBusy && presence?.queueOn && extension.status !== 'unavailable') {
    return { meta: AGENT_STATE_META.ready, label: t('extensions.status.ready', 'Ready'), bucket: 'available' };
  }
  return device();
}

/**
 * When the card's status began. A live call shows its own call timer instead. Otherwise the
 * agent presence's `since` when that presence is what the badge shows, else the server's
 * `status_since` when the badge shows the device status or DND (Idle, DND), never Unavailable.
 * A status neither describes (the queue-member Not-Ready fallback) gets no timer rather than a
 * wrong one.
 */
function stateSince(extension: Extension, agentState: AgentStateInfo | undefined, status: ResolvedStatus): number | undefined {
  if (['in_call', 'dialing', 'ringing', 'on_hold'].includes(extension.status)) return undefined;
  const parse = (iso?: string) => {
    const ms = iso ? Date.parse(iso) : NaN;
    return Number.isFinite(ms) ? ms : undefined;
  };
  if (agentState?.since && AGENT_BUCKET[agentState.state] === status.bucket) return parse(agentState.since);
  // Not for Unavailable: the server only sees a status begin once it is running, so an
  // unregistered phone would count from the last OpDesk restart, not from when it went away.
  if (extension.status === 'unavailable') return undefined;
  if (status.bucket === DEVICE_BUCKET[extension.status] || (status.bucket === 'dnd' && extension.dnd)) {
    return parse(extension.status_since);
  }
  return undefined;
}


/** What a card needs beyond its status: its presence row and the break window it is in. */
interface ExtensionRow {
  ext: Extension;
  status: ResolvedStatus;
  agent?: AgentStateInfo;
}

/** The live wiring every card and row shares, so the two views cannot drift apart. */
interface RowContext {
  now: number;
  reasons: PauseReason[];
  canSupervise: boolean;
  webrtcMap: Record<string, string>;
  onSupervisorAction: (mode: 'listen' | 'whisper' | 'barge', target: string) => void;
  sendAction: (action: ActionMessage) => void;
  onOpenTimeline: (ext: string, name: string) => void;
  onOpenCalls: (ext: string, name: string) => void;
  onCallExtension?: (ext: string) => void;
}

export function ExtensionsPanel({
  extensions,
  agentStates = {},
  memberPresence = {},
  onSupervisorAction,
  onSync,
  webrtcMap = {},
  sendAction,
  onCallExtension,
}: ExtensionsPanelProps) {
  const { t } = useTranslation();
  // Resolved once here and passed down: a hook per card would mean one
  // /api/pause-reasons request per extension.
  const { labelFor, reasons, selectable } = usePauseReasons();
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [storageKey] = useState(viewStorageKey);
  const [view, setView] = useState<ViewMode>(() => {
    try { return localStorage.getItem(storageKey) === 'list' ? 'list' : 'grid'; } catch { return 'grid'; }
  });
  const [timelineFor, setTimelineFor] = useState<{ ext: string; name: string } | null>(null);
  const [callsFor, setCallsFor] = useState<{ ext: string; name: string } | null>(null);

  useEffect(() => {
    try { localStorage.setItem(storageKey, view); } catch { /* best-effort */ }
  }, [storageKey, view]);

  const rows = useMemo<ExtensionRow[]>(() => Object.values(extensions)
    .sort((a, b) => a.extension.localeCompare(b.extension, undefined, { numeric: true }))
    .map((ext) => {
      const agent = agentStates[ext.extension];
      const status = resolveStatus(ext, agent, memberPresence[ext.extension], t, labelFor);
      return { ext, agent, status: { ...status, since: stateSince(ext, agent, status) } };
    }),
  [extensions, agentStates, memberPresence, t, labelFor]);

  // One clock for every card's time-in-state timer, ticking only while some card shows one.
  const [now, setNow] = useState(() => Date.now());
  const anyTimer = rows.some((r) => r.status.since !== undefined);
  useEffect(() => {
    if (!anyTimer) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [anyTimer]);

  // Filters offer only what is on the page: each status or type that occurs, with its count.
  const typeOf = (ext: string) => (webrtcMap[ext] === 'yes' ? 'webrtc' : 'desk');
  const statusCounts = countBy(rows, (r) => r.status.bucket);
  const typeCounts = Object.keys(webrtcMap).length > 0 ? countBy(rows, (r) => typeOf(r.ext.extension)) : {};

  const term = query.trim().toLowerCase();
  const filtered = rows.filter(({ ext, status }) => {
    if (term && !ext.extension.toLowerCase().includes(term) && !(ext.name || '').toLowerCase().includes(term)) return false;
    if (statusFilter && status.bucket !== statusFilter) return false;
    if (typeFilter && typeOf(ext.extension) !== typeFilter) return false;
    return true;
  });
  const filtering = Boolean(term || statusFilter || typeFilter);
  const clearFilters = () => { setQuery(''); setStatusFilter(''); setTypeFilter(''); };

  // Each option wears its badge colour, so the filter dots and the cards agree.
  const statusOption = (value: StatusBucket, meta: StatusMeta, label: string): DropdownOption =>
    ({ value, label, dotColor: `var(${meta.varName})` });
  const statusOptions = presentOptions([
    statusOption('available', DEVICE_STATUS_META.idle, t('extensions.status.idle')),
    statusOption('in_call', DEVICE_STATUS_META.in_call, t('extensions.status.in_call')),
    statusOption('ringing', DEVICE_STATUS_META.ringing, t('extensions.status.ringing')),
    statusOption('on_hold', DEVICE_STATUS_META.on_hold, t('extensions.status.on_hold')),
    statusOption('not_ready', AGENT_STATE_META.not_ready, t('extensions.status.notReady', 'Not Ready')),
    statusOption('wrap_up', AGENT_STATE_META.wrap_up, t('agent.state.wrapUp', 'Wrap-up')),
    statusOption('dnd', AGENT_STATE_META.dnd, t('extensions.status.dnd', 'Do Not Disturb')),
    statusOption('offline', DEVICE_STATUS_META.unavailable, t('extensions.status.unavailable')),
  ], statusCounts, statusFilter);
  const typeOptions = presentOptions([
    { value: 'webrtc', label: t('extensions.webrtcBadge') },
    { value: 'desk', label: t('extensions.filter.deskPhone', 'Desk phone') },
  ], typeCounts, typeFilter);

  const ctx: RowContext = {
    now,
    reasons,
    // Agents see the floor read-only; supervisors (their groups) and admins get the ⋯ menu.
    canSupervise: getUser()?.role !== 'agent',
    webrtcMap,
    onSupervisorAction,
    sendAction,
    // The live state is already scoped to the viewer, and the server checks again.
    onOpenTimeline: (ext, name) => setTimelineFor({ ext, name }),
    onOpenCalls: (ext, name) => setCallsFor({ ext, name }),
    onCallExtension,
  };
  // The menu offers only the reasons an agent could pick themselves.
  const menuReasons = selectable;
  const today = { from: todayStr(), to: todayStr() };

  return (
    <Page
      icon={Phone}
      title={t('nav.extensions')}
      count={rows.length}
      actions={
        <>
          <div className="ui-segmented" role="group" aria-label={t('extensions.view', 'View')}>
            <button
              type="button"
              className={`btn${view === 'grid' ? ' is-selected' : ''}`}
              aria-pressed={view === 'grid'}
              onClick={() => setView('grid')}
            >
              <LayoutGrid size={14} />
              {t('extensions.gridView', 'Grid View')}
            </button>
            <button
              type="button"
              className={`btn${view === 'list' ? ' is-selected' : ''}`}
              aria-pressed={view === 'list'}
              onClick={() => setView('list')}
            >
              <List size={14} />
              {t('extensions.listView', 'List View')}
            </button>
          </div>
          {onSync && (
            <button type="button" className="btn btn-ghost" onClick={onSync} title={t('common.syncAll')}>
              <RefreshCw size={14} />
              {t('common.sync')}
            </button>
          )}
        </>
      }
      toolbar={
        <Toolbar
          search={
            <SearchInput
              value={query}
              onChange={setQuery}
              debounceMs={0}
              label={t('extensions.search', 'Search extensions')}
              placeholder={t('extensions.searchPlaceholder', 'Search by number or name')}
            />
          }
          filters={
            <>
              {showFilter(statusOptions, statusFilter) && (
                <div data-active={statusFilter || undefined}>
                  <Dropdown
                    value={statusFilter}
                    onChange={setStatusFilter}
                    size="md"
                    ariaLabel={t('common.status', 'Status')}
                    options={[{ value: '', label: t('common.allStatuses', 'All statuses') }, ...statusOptions]}
                  />
                </div>
              )}
              {showFilter(typeOptions, typeFilter) && (
                <div data-active={typeFilter || undefined}>
                  <Dropdown
                    value={typeFilter}
                    onChange={setTypeFilter}
                    size="md"
                    ariaLabel={t('extensions.filter.type', 'Type')}
                    options={[{ value: '', label: t('extensions.filter.allTypes', 'All types') }, ...typeOptions]}
                  />
                </div>
              )}
            </>
          }
          actions={filtering && (
            <span className="u-text-sm u-fg-muted">
              {t('extensions.filter.matches', { shown: filtered.length, total: rows.length, defaultValue: '{{shown}} of {{total}}' })}
            </span>
          )}
        />
      }
    >
      {rows.length === 0 ? (
        <EmptyState icon={Phone} title={t('extensions.noExtensions')} />
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={Phone}
          title={t('extensions.noMatchesTitle', 'No matching extensions')}
          description={t('extensions.noMatches', 'No extensions match these filters.')}
          action={<button type="button" className="btn" onClick={clearFilters}>{t('common.clearFilters', 'Clear filters')}</button>}
        />
      ) : view === 'list' ? (
        <ExtensionsList rows={filtered} ctx={ctx} menuReasons={menuReasons} />
      ) : (
        <div className="extensions-grid">
          <AnimatePresence>
            {filtered.map((row) => (
              <ExtensionCard key={row.ext.extension} row={row} ctx={ctx} menuReasons={menuReasons} />
            ))}
          </AnimatePresence>
        </div>
      )}
      {timelineFor && (
        <AgentTimelineModal agent={timelineFor.ext} name={timelineFor.name} dateRange={today} onClose={() => setTimelineFor(null)} />
      )}
      {callsFor && (
        <AgentCallsModal agent={callsFor.ext} name={callsFor.name} dateRange={today} onClose={() => setCallsFor(null)} />
      )}
    </Page>
  );
}

/** Two-letter monogram from the display name, falling back to the extension digits. */
function monogram(name: string | undefined, ext: string): string {
  const src = (name || '').trim();
  if (!src) return ext.slice(0, 2);
  const parts = src.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return src.slice(0, 2).toUpperCase();
}

/** Where a break shown on the card stands against its reason's window. */
function breakState(row: ExtensionRow, reasons: PauseReason[], now: number): { pressure: BreakPressure; ratio: number; window: number } {
  const none = { pressure: '' as BreakPressure, ratio: 0, window: 0 };
  if (row.status.bucket !== 'not_ready' || row.agent?.state !== 'not_ready' || row.status.since === undefined) return none;
  const reason = reasons.find((r) => r.code === row.agent?.reason_code);
  return breakPressure(reason, Math.max(0, now - row.status.since) / 1000);
}

/** The monogram with the status ring, and a mark for how the phone is reachable. */
function ExtAvatar({ row, small }: { row: ExtensionRow; small?: boolean }) {
  const { t } = useTranslation();
  const via = row.agent?.reachable_via;
  return (
    <span className={`ext-avatar${small ? ' ext-avatar-sm' : ''}`} aria-hidden="true">
      {monogram(row.ext.name, row.ext.extension)}
      {via === 'sip' && <span className="ext-reg" title={t('extCard.registered', 'Registered')}><i /></span>}
      {via === 'push' && (
        <span className="ext-reg" title={t('extCard.asleep', 'Asleep, wakes by push')}><Smartphone size={10} /></span>
      )}
    </span>
  );
}

/**
 * The queue side of the card: the queues it is in (blue), paused in on a break (amber), or
 * why it is out (dashed): not logged in, or DND (restored when DND ends). A plain extension
 * with no queues says so.
 */
function QueueChips({ row }: { row: ExtensionRow }) {
  const { t } = useTranslation();
  const a = row.agent;
  if (!a || a.state === 'logged_out') return null;
  if (a.is_agent === false) return <span className="ext-chip">{t('extCard.noQueues', 'No queues · outbound')}</span>;
  if (!a.is_agent) return null;
  if (a.dnd || row.ext.dnd || a.state === 'dnd') {
    return (
      <span className="ext-chip is-out" title={t('extActions.queuesDnd', 'Out while DND is on · restored after')}>
        <HeadphoneOff size={12} />{t('extCard.outDnd', 'Out (DND)')}
      </span>
    );
  }
  if (!a.queue_logged_in) {
    return <span className="ext-chip is-out"><HeadphoneOff size={12} />{t('extCard.notInQueues', 'Not in queues')}</span>;
  }
  const paused = a.state === 'not_ready';
  const names = a.queues && a.queues.length > 0 ? a.queues : [t('extCard.inQueues', 'In queues')];
  return (
    <>
      {names.map((q) => (
        <span
          key={q}
          className={`ext-chip ${paused ? 'is-paused' : 'is-in'}`}
          title={paused ? t('agent.pausedInQueues', 'Paused in queues') : undefined}
        >
          {paused ? <Pause size={12} /> : <Headset size={12} />}{q}
        </span>
      ))}
    </>
  );
}

/** The break window as a thin bar: amber from 80%, red past it. Only on a break with a window. */
function BreakBar({ window: win, ratio, pressure }: { window: number; ratio: number; pressure: BreakPressure }) {
  const { t } = useTranslation();
  if (!win) return null;
  return (
    <span
      className={`ext-winbar${pressure ? ` is-${pressure}` : ''}`}
      role="meter"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(ratio * 100)}
      aria-label={t('extCard.window', 'Break window {{min}} min', { min: Math.round(win / 60) })}
      title={t('extCard.window', 'Break window {{min}} min', { min: Math.round(win / 60) })}
    >
      <i style={{ inlineSize: `${Math.round(ratio * 100)}%` }} />
    </span>
  );
}

/** How long the extension has been in its shown status, when that is known. */
function StateTimer({ status, now, pressure }: { status: ResolvedStatus; now: number; pressure?: BreakPressure }) {
  const { t } = useTranslation();
  if (status.since === undefined) return null;
  return (
    <span
      className={`ext-state-timer u-mono${pressure ? ` is-${pressure}` : ''}`}
      title={t('extensions.timeInState', { status: status.label, defaultValue: 'Time in {{status}}' })}
    >
      <Clock size={12} />
      {fmtTimer(Math.max(0, now - status.since) / 1000)}
    </span>
  );
}

/** The caller on a live or ringing call. */
function CallLine({ ext }: { ext: Extension }) {
  const call = ext.call_info;
  if (!call?.talking_to || call.talking_to === 'Unknown') return null;
  const Icon = ext.status === 'ringing' ? PhoneIncoming : Phone;
  return (
    <span className="ext-call-who">
      <Icon size={13} aria-hidden />
      {call.contact_name
        ? <><b>{call.contact_name}</b><span className="u-mono u-fg-muted">{call.talking_to}</span></>
        : <b className="u-mono">{call.talking_to}</b>}
    </span>
  );
}

function ActionsMenu({ row, ctx, menuReasons }: { row: ExtensionRow; ctx: RowContext; menuReasons: PauseReason[] }) {
  if (!ctx.canSupervise) return null;
  return (
    <ExtensionActionsMenu
      extension={row.ext}
      agentState={row.agent}
      reasons={menuReasons}
      sendAction={ctx.sendAction}
      onSupervisorAction={ctx.onSupervisorAction}
      onOpenTimeline={ctx.onOpenTimeline}
      onOpenCalls={ctx.onOpenCalls}
      onCallExtension={ctx.onCallExtension}
    />
  );
}

const accentStyle = (meta: StatusMeta) => ({
  '--ext-accent': `var(${meta.varName})`,
  '--ext-accent-bg': `var(${meta.bgVar})`,
}) as CSSProperties;

/**
 * Grid View card ("style A"): status stripe, the monogram with a status ring and a
 * reachability mark, the number and name, the ⋯ menu; then the status badge with its timer
 * (amber/red against the break window, with a bar), the queue and WebRTC chips, and the live
 * call with listen/whisper/barge.
 */
function ExtensionCard({ row, ctx, menuReasons }: { row: ExtensionRow; ctx: RowContext; menuReasons: PauseReason[] }) {
  const { t } = useTranslation();
  const { ext: extension, status } = row;
  const isInCall = extension.status === 'in_call' || extension.status === 'dialing';
  const isRinging = extension.status === 'ringing';
  const brk = breakState(row, ctx.reasons, ctx.now);

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.96 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.96 }}
      transition={{ duration: 0.2 }}
      className={`extension-card status-${extension.status}`}
      style={accentStyle(status.meta)}
    >
      <div className="ext-card-top">
        <ExtAvatar row={row} />
        <div className="ext-identity">
          <div className="extension-number">{extension.extension}</div>
          {extension.name && <div className="extension-name" title={extension.name}>{extension.name}</div>}
        </div>
        <ActionsMenu row={row} ctx={ctx} menuReasons={menuReasons} />
      </div>

      <div className="ext-status-row">
        <StatusBadge meta={status.meta} label={status.label} title={status.title} />
        <StateTimer status={status} now={ctx.now} pressure={brk.pressure} />
      </div>
      <BreakBar {...brk} />

      <div className="ext-chips">
        <QueueChips row={row} />
        {ctx.webrtcMap[extension.extension] === 'yes' && (
          <span className="ext-chip is-rtc" title={t('extensions.webrtcOn')}><Radio size={12} />{t('extensions.webrtcBadge')}</span>
        )}
      </div>

      {extension.call_info && (isInCall || isRinging) && (
        <div className="extension-info">
          <CallLine ext={extension} />
          <div className="ext-call-row">
            {extension.call_info.duration && (
              <span className="u-row u-gap-1 u-fg-muted u-mono"><Clock size={13} />{extension.call_info.duration}</span>
            )}
            {isInCall && ctx.canSupervise && (
              <span className="u-row u-gap-1 u-push-end">
                <SuperviseActions target={extension.extension} onAction={ctx.onSupervisorAction} />
              </span>
            )}
          </div>
        </div>
      )}
    </motion.div>
  );
}

/**
 * List View ("style C"): one row-card per extension with the card's content in columns:
 * who, status + timer (+ break bar), queues, the call, actions. It stacks on a narrow screen.
 */
function ExtensionsList({ rows, ctx, menuReasons }: { rows: ExtensionRow[]; ctx: RowContext; menuReasons: PauseReason[] }) {
  const { t } = useTranslation();
  return (
    <div className="ext-rows" role="list">
      <div className="ext-rows-head" aria-hidden="true">
        <span>{t('fields.extension')}</span>
        <span>{t('common.status', 'Status')}</span>
        <span>{t('nav.queues', 'Queues')}</span>
        <span>{t('activeCalls.table.talkingTo')}</span>
        <span />
      </div>
      {rows.map((row) => {
        const { ext, status } = row;
        const inCall = ext.status === 'in_call' || ext.status === 'dialing';
        const brk = breakState(row, ctx.reasons, ctx.now);
        return (
          <div key={ext.extension} className="ext-row" role="listitem" style={accentStyle(status.meta)}>
            <div className="ext-row-id">
              <ExtAvatar row={row} small />
              <span className="ext-row-who">
                <span className="u-row u-gap-2">
                  <span className="u-mono u-semibold">{ext.extension}</span>
                  {ctx.webrtcMap[ext.extension] === 'yes' && (
                    <span className="ext-chip is-rtc" title={t('extensions.webrtcOn')}><Radio size={12} />{t('extensions.webrtcBadge')}</span>
                  )}
                </span>
                {ext.name && <span className="ext-row-name" title={ext.name}>{ext.name}</span>}
              </span>
            </div>
            <div className="ext-row-status">
              <span className="u-row u-gap-2">
                <StatusBadge meta={status.meta} label={status.label} title={status.title} />
                <StateTimer status={status} now={ctx.now} pressure={brk.pressure} />
              </span>
              <BreakBar {...brk} />
            </div>
            <div className="ext-chips"><QueueChips row={row} /></div>
            <div className="ext-row-call">
              {(inCall || ext.status === 'ringing') && <CallLine ext={ext} />}
              {(inCall || ext.status === 'ringing') && ext.call_info?.duration && (
                <span className="u-mono u-fg-muted">{ext.call_info.duration}</span>
              )}
            </div>
            <div className="ext-row-actions">
              {inCall && ctx.canSupervise && <SuperviseActions target={ext.extension} onAction={ctx.onSupervisorAction} />}
              <ActionsMenu row={row} ctx={ctx} menuReasons={menuReasons} />
            </div>
          </div>
        );
      })}
    </div>
  );
}
