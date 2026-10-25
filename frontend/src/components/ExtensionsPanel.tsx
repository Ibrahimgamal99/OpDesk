import { useEffect, useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Phone, RefreshCw, Radio, Clock, Loader2, MinusCircle, CircleDot, Rows3, LayoutGrid } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { Extension, AgentStateInfo } from '../types';
import { getUser } from '../auth';
import { StatusBadge, AGENT_STATE_META, DEVICE_STATUS_META, resolveAgentMeta, type StatusMeta } from './statusBadge';
import { usePauseReasons } from '../hooks/usePauseReasons';
import { SuperviseActions } from './SuperviseActions';
import { countBy, presentOptions, showFilter } from '../lib/filters';
import { Badge, Dropdown, EmptyState, Page, SearchInput, Toolbar } from './ui';
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
  /** Extension -> webrtc 'yes'|'no'; shown as a read-only badge (toggling now lives in Users → Create/Edit). */
  webrtcMap?: Record<string, string>;
  /** Extensions the current user is allowed to toggle DND for */
  allowedDndExtensions?: Set<string>;
  onDndToggle?: (extension: string, enabled: boolean) => Promise<void>;
}

const COMPACT_STORAGE_KEY = 'opdesk:extensions-compact';

/** What the Status filter narrows by: the status the card's badge is showing. */
type StatusBucket = 'available' | 'in_call' | 'ringing' | 'on_hold' | 'offline' | 'dnd' | 'not_ready' | 'wrap_up';

/** One extension's resolved status: the badge it wears and the filter bucket it falls in. */
interface ResolvedStatus {
  meta: StatusMeta;
  label: string;
  title?: string;
  bucket: StatusBucket;
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
  const [compact, setCompact] = useState<boolean>(() => {
    try { return localStorage.getItem(COMPACT_STORAGE_KEY) === '1'; } catch { return false; }
  });

  useEffect(() => {
    try { localStorage.setItem(COMPACT_STORAGE_KEY, compact ? '1' : '0'); } catch { /* best-effort */ }
  }, [compact]);

  const rows = useMemo(() => Object.values(extensions)
    .sort((a, b) => a.extension.localeCompare(b.extension, undefined, { numeric: true }))
    .map((ext) => ({
      ext,
      status: resolveStatus(ext, agentStates[ext.extension], memberPresence[ext.extension], t, labelFor),
    })),
  [extensions, agentStates, memberPresence, t, labelFor]);

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
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => setCompact((c) => !c)}
            title={compact ? t('extensions.comfortableView') : t('extensions.compactView')}
            aria-pressed={compact}
          >
            {compact ? <LayoutGrid size={14} /> : <Rows3 size={14} />}
            {compact ? t('extensions.comfortable') : t('extensions.compact')}
          </button>
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
      ) : (
        <div className={`extensions-grid${compact ? ' compact' : ''}`}>
          <AnimatePresence>
            {filtered.map(({ ext, status }) => (
              <ExtensionCard
                key={ext.extension}
                extension={ext}
                status={status}
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
  extension, status, onSupervisorAction, webrtcEnabled, canToggleDnd, onDndToggle,
}: ExtensionCardProps) {
  const { t } = useTranslation();
  const [dndSaving, setDndSaving] = useState(false);
  const isInCall = extension.status === 'in_call' || extension.status === 'dialing';
  const isRinging = extension.status === 'ringing';
  const dndOn = !!extension.dnd;
  const { meta } = status;

  const handleDndClick = async () => {
    // DND cannot be toggled while the extension is on a call.
    if (!canToggleDnd || !onDndToggle || dndSaving || isInCall) return;
    setDndSaving(true);
    try {
      await onDndToggle(extension.extension, !dndOn);
    } finally {
      setDndSaving(false);
    }
  };

  const dndTitle = dndOn
    ? t('extensions.dndOn', 'Do Not Disturb: on')
    : t('extensions.dndOff', 'Do Not Disturb: off');

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
        {canToggleDnd && (
          <button
            type="button"
            role="switch"
            aria-checked={dndOn}
            className={`agent-dnd-toggle ext-dnd-toggle${dndOn ? ' on' : ''}`}
            onClick={(e) => { e.stopPropagation(); handleDndClick(); }}
            disabled={dndSaving || isInCall}
            title={dndTitle}
            aria-label={dndTitle}
          >
            <span className="agent-dnd-toggle-track">
              <span className="agent-dnd-toggle-knob">
                {dndSaving ? <Loader2 size={12} className="spinner" /> : dndOn ? <MinusCircle size={12} /> : <CircleDot size={12} />}
              </span>
            </span>
          </button>
        )}
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
