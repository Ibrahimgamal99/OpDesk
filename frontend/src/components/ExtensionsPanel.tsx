import { useEffect, useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Phone, RefreshCw, Radio, Clock, Loader2, MinusCircle, CircleDot, List, LayoutGrid } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { Extension, AgentStateInfo } from '../types';
import { getUser } from '../auth';
import { StatusBadge, AGENT_STATE_META, DEVICE_STATUS_META, resolveAgentMeta, type StatusMeta } from './statusBadge';
import { usePauseReasons } from '../hooks/usePauseReasons';
import { SuperviseActions } from './SuperviseActions';
import { countBy, presentOptions, showFilter } from '../lib/filters';
import { Badge, Dropdown, EmptyState, Page, SearchInput, Table, Toolbar } from './ui';
import { fmtTimer } from '../lib/format';
import type { Column, DropdownOption } from './ui';
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
  /** Extension -> webrtc 'yes'|'no'; shown as a read-only badge (toggling now lives in Users → Create/Edit). */
  webrtcMap?: Record<string, string>;
  /** Extensions the current user is allowed to toggle DND for */
  allowedDndExtensions?: Set<string>;
  onDndToggle?: (extension: string, enabled: boolean) => Promise<void>;
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
  not_ready: 'not_ready', dnd: 'dnd', logged_out: 'offline',
};

/**
 * One status per card, one badge. Resolved here rather than inside the card so the Status
 * filter and the badge cannot disagree.
 *  - A queue agent: their live presence IS the status (login -> Ready, logout -> Offline,
 *    DND, pause -> Not-Ready with the reason's label, On Call, Wrap-up). Presence only
 *    tracks queue calls, so a direct call while Ready lets the live device status drive the
 *    card instead of a misleading green Ready. A Ready agent whose phone is unregistered
 *    keeps the label but dims to grey (a mobile softphone asleep until the next call).
 *  - A plain extension: DND when its DND flag is set, otherwise its raw device status.
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

  if (agentState && agentState.is_agent !== false) {
    const queueTitle = agentState.queue
      ? t('agent.state.queueLabel', { queue: agentState.queue, defaultValue: 'Queue: {{queue}}' })
      : undefined;
    const presenceIsIdle = agentState.state === 'ready' || agentState.state === 'available';
    if (deviceBusy && presenceIsIdle) return { ...device(), title: queueTitle };
    const resolved = resolveAgentMeta(agentState.state, extension.status === 'unavailable');
    return {
      meta: resolved.meta,
      label: agentState.state === 'not_ready'
        ? notReadyLabel(agentState.reason_code)
        : t(resolved.meta.key, resolved.meta.fallback),
      title: resolved.asleep
        ? t('agent.state.deviceAsleep', 'Ready, but the phone is asleep; it wakes on the next call')
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

export function ExtensionsPanel({
  extensions,
  agentStates = {},
  memberPresence = {},
  onSupervisorAction,
  onSync,
  webrtcMap = {},
  allowedDndExtensions = new Set(),
  onDndToggle,
}: ExtensionsPanelProps) {
  const { t } = useTranslation();
  // Resolved once here and passed down: a hook per card would mean one
  // /api/pause-reasons request per extension.
  const { labelFor } = usePauseReasons();
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [storageKey] = useState(viewStorageKey);
  const [view, setView] = useState<ViewMode>(() => {
    try { return localStorage.getItem(storageKey) === 'list' ? 'list' : 'grid'; } catch { return 'grid'; }
  });

  useEffect(() => {
    try { localStorage.setItem(storageKey, view); } catch { /* best-effort */ }
  }, [storageKey, view]);

  const rows = useMemo(() => Object.values(extensions)
    .sort((a, b) => a.extension.localeCompare(b.extension, undefined, { numeric: true }))
    .map((ext) => {
      const status = resolveStatus(ext, agentStates[ext.extension], memberPresence[ext.extension], t, labelFor);
      return { ext, status: { ...status, since: stateSince(ext, agentStates[ext.extension], status) } };
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
        <ExtensionsList
          rows={filtered}
          now={now}
          onSupervisorAction={onSupervisorAction}
          webrtcMap={webrtcMap}
          allowedDndExtensions={allowedDndExtensions}
          onDndToggle={onDndToggle}
        />
      ) : (
        <div className="extensions-grid">
          <AnimatePresence>
            {filtered.map(({ ext, status }) => (
              <ExtensionCard
                key={ext.extension}
                extension={ext}
                status={status}
                now={now}
                onSupervisorAction={onSupervisorAction}
                webrtcEnabled={webrtcMap[ext.extension] === 'yes'}
                canToggleDnd={allowedDndExtensions.has(ext.extension)}
                onDndToggle={onDndToggle}
              />
            ))}
          </AnimatePresence>
        </div>
      )}
    </Page>
  );
}

interface ExtensionCardProps {
  extension: Extension;
  status: ResolvedStatus;
  /** Shared clock (epoch ms) for the time-in-state timer. */
  now: number;
  onSupervisorAction: (mode: 'listen' | 'whisper' | 'barge', target: string) => void;
  webrtcEnabled: boolean;
  canToggleDnd: boolean;
  onDndToggle?: (extension: string, enabled: boolean) => Promise<void>;
}

/** Two-letter monogram from the display name, falling back to the extension digits. */
function monogram(name: string | undefined, ext: string): string {
  const src = (name || '').trim();
  if (!src) return ext.slice(0, 2);
  const parts = src.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return src.slice(0, 2).toUpperCase();
}

function ExtensionCard({
  extension, status, now, onSupervisorAction, webrtcEnabled, canToggleDnd, onDndToggle,
}: ExtensionCardProps) {
  const { t } = useTranslation();
  const isInCall = extension.status === 'in_call' || extension.status === 'dialing';
  const isRinging = extension.status === 'ringing';
  const { meta } = status;

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.9 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.9 }}
      transition={{ duration: 0.2 }}
      className={`extension-card status-${extension.status}`}
      style={{
        ['--ext-accent' as string]: `var(${meta.varName})`,
        ['--ext-accent-bg' as string]: `var(${meta.bgVar})`,
      }}
    >
      <div className="ext-card-top">
        <div className="ext-avatar" aria-hidden="true">
          {monogram(extension.name, extension.extension)}
        </div>
        <div className="ext-identity">
          <div className="ext-identity-head">
            <div className="extension-number">{extension.extension}</div>
            {webrtcEnabled && (
              <Badge tone="info" icon={<Radio size={14} />} title={t('extensions.webrtcOn')}>
                {t('extensions.webrtcBadge')}
              </Badge>
            )}
          </div>
          {extension.name && (
            <div className="extension-name" title={extension.name}>{extension.name}</div>
          )}
        </div>
      </div>

      <div className="ext-badges">
        <StatusBadge meta={meta} label={status.label} title={status.title} />
        <StateTimer status={status} now={now} />
        {canToggleDnd && onDndToggle && <DndToggle extension={extension} onDndToggle={onDndToggle} />}
      </div>

      {extension.call_info && (isInCall || isRinging) && (
        <div className="extension-info">
          {extension.call_info.talking_to && extension.call_info.talking_to !== 'Unknown' && (
            <div className="extension-info-row">
              <Phone size={14} />
              {extension.call_info.contact_name
                ? <>{extension.call_info.contact_name} <span className="u-fg-muted u-mono">({extension.call_info.talking_to})</span></>
                : extension.call_info.talking_to}
            </div>
          )}
          {extension.call_info.duration && (
            <div className="extension-info-row u-fg-muted">
              <Clock size={14} />
              <span className="u-mono">{extension.call_info.duration}</span>
            </div>
          )}
        </div>
      )}

      {isInCall && getUser()?.role !== 'agent' && (
        <div className="u-row-stretch u-gap-2 u-mt-4 u-justify-center">
          <SuperviseActions target={extension.extension} onAction={onSupervisorAction} />
        </div>
      )}
    </motion.div>
  );
}

/** How long the extension has been in its shown status, when that is known. */
function StateTimer({ status, now }: { status: ResolvedStatus; now: number }) {
  const { t } = useTranslation();
  if (status.since === undefined) return null;
  return (
    <span
      className="ext-state-timer u-mono"
      title={t('extensions.timeInState', { status: status.label, defaultValue: 'Time in {{status}}' })}
    >
      <Clock size={12} />
      {fmtTimer(Math.max(0, now - status.since) / 1000)}
    </span>
  );
}

/** The DND switch of one extension; disabled while it is on a call. */
function DndToggle({ extension, onDndToggle }: {
  extension: Extension;
  onDndToggle: (extension: string, enabled: boolean) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [saving, setSaving] = useState(false);
  const isInCall = extension.status === 'in_call' || extension.status === 'dialing';
  const on = !!extension.dnd;
  const title = on ? t('extensions.dndOn', 'Do Not Disturb: on') : t('extensions.dndOff', 'Do Not Disturb: off');

  const handleClick = async () => {
    if (saving || isInCall) return;
    setSaving(true);
    try {
      await onDndToggle(extension.extension, !on);
    } finally {
      setSaving(false);
    }
  };

  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      className={`agent-dnd-toggle ext-dnd-toggle${on ? ' on' : ''}`}
      onClick={(e) => { e.stopPropagation(); handleClick(); }}
      disabled={saving || isInCall}
      title={title}
      aria-label={title}
    >
      <span className="agent-dnd-toggle-track">
        <span className="agent-dnd-toggle-knob">
          {saving ? <Loader2 size={12} className="spinner" /> : on ? <MinusCircle size={12} /> : <CircleDot size={12} />}
        </span>
      </span>
    </button>
  );
}

interface ExtensionRow {
  ext: Extension;
  status: ResolvedStatus;
}

interface ExtensionsListProps {
  rows: ExtensionRow[];
  now: number;
  onSupervisorAction: (mode: 'listen' | 'whisper' | 'barge', target: string) => void;
  webrtcMap: Record<string, string>;
  allowedDndExtensions: Set<string>;
  onDndToggle?: (extension: string, enabled: boolean) => Promise<void>;
}

/** List View: the cards' content as one table row per extension. */
function ExtensionsList({ rows, now, onSupervisorAction, webrtcMap, allowedDndExtensions, onDndToggle }: ExtensionsListProps) {
  const { t } = useTranslation();
  const canSupervise = getUser()?.role !== 'agent';
  const inCall = (ext: Extension) => ext.status === 'in_call' || ext.status === 'dialing';
  const anyDnd = Boolean(onDndToggle) && rows.some(({ ext }) => allowedDndExtensions.has(ext.extension));

  const columns: Column<ExtensionRow>[] = [
    {
      key: 'extension', header: t('fields.extension'), primary: true,
      cell: ({ ext }) => (
        <span className="u-row u-gap-2">
          <span className="u-mono u-semibold">{ext.extension}</span>
          {ext.name && <span className="u-fg-muted">{ext.name}</span>}
          {webrtcMap[ext.extension] === 'yes' && (
            <Badge tone="info" icon={<Radio size={14} />} title={t('extensions.webrtcOn')}>
              {t('extensions.webrtcBadge')}
            </Badge>
          )}
        </span>
      ),
    },
    {
      key: 'status', header: t('common.status', 'Status'),
      cell: ({ status }) => (
        <span className="u-row u-gap-2">
          <StatusBadge meta={status.meta} label={status.label} title={status.title} />
          <StateTimer status={status} now={now} />
        </span>
      ),
    },
    {
      key: 'talkingTo', header: t('activeCalls.table.talkingTo'),
      cell: ({ ext }) => {
        const call = ext.call_info;
        if (!call?.talking_to || call.talking_to === 'Unknown') return <span className="u-fg-muted">—</span>;
        return call.contact_name
          ? <>{call.contact_name} <span className="u-fg-muted u-mono">({call.talking_to})</span></>
          : <span className="u-mono">{call.talking_to}</span>;
      },
    },
    {
      key: 'duration', header: t('fields.duration'),
      cell: ({ ext }) => <span className="u-mono">{ext.call_info?.duration || '—'}</span>,
    },
    ...(anyDnd && onDndToggle ? [{
      key: 'dnd', header: t('extensions.status.dnd', 'Do Not Disturb'),
      cell: ({ ext }: ExtensionRow) => (allowedDndExtensions.has(ext.extension)
        ? <DndToggle extension={ext} onDndToggle={onDndToggle} />
        : null),
    }] : []),
    ...(canSupervise ? [{
      key: 'actions', header: t('common.actions'), label: '',
      cell: ({ ext }: ExtensionRow) => (inCall(ext)
        ? <SuperviseActions target={ext.extension} onAction={onSupervisorAction} />
        : null),
    }] : []),
  ];

  return (
    <Table
      columns={columns}
      rows={rows}
      rowKey={({ ext }) => ext.extension}
      framed
      className="extensions-list"
    />
  );
}
