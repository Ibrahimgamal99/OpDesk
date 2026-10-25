import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import type React from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  Terminal, Send, Play, Pause, Download, Trash2, Tag, ScrollText, Braces, Loader2,
  ChevronRight, RefreshCw, Copy, Check, ArrowDown, Inbox, PhoneIncoming, PhoneOutgoing,
  ArrowLeftRight, RotateCcw, History, Repeat,
} from 'lucide-react';
import { fetchWithAuth } from '../auth';
import { PageRange } from './PageRange';
import { quickRanges } from './analyticsUtils';
import type { DateRange } from './analyticsUtils';
import {
  Alert, Badge, Card, Dropdown, EmptyState, Loading, Modal, Page, Pagination, SearchInput,
  Table, Tabs, Toggle, Toolbar, useActionError, useConfirm, type BadgeTone, type Column,
} from './ui';
import type {
  AmiEvent, WebhookDelivery, WebhookDeliveryDetail, WebhookDeliveryFacets, WebhookDeliveryStatus,
} from '../types';
import { api, apiList, messageFrom, messageOf, toApiError } from '../lib/api';
import { countBy, presentOptions } from '../lib/filters';
import { AuditPanel } from './AuditPanel';

type LogsTab = 'system' | 'deliveries' | 'audit';
const LOGS_TABS: readonly LogsTab[] = ['system', 'deliveries', 'audit'];

// ===========================================================================
// Shell
// ===========================================================================
export function LogsPanel() {
  const { t } = useTranslation();
  // Sub-tab lives in the URL so /logs?tab=audit is deep-linkable and survives a
  // refresh, matching how Settings handles its sub-tabs.
  const [searchParams, setSearchParams] = useSearchParams();
  const requested = searchParams.get('tab') as LogsTab | null;
  const tab: LogsTab = requested && LOGS_TABS.includes(requested) ? requested : 'system';

  // Capture state lives here rather than in the tab so pausing and the AMI switch
  // survive a trip through the Deliveries tab.
  const [amiEnabled, setAmiEnabled] = useState(false);
  const [amiBusy, setAmiBusy] = useState(false);
  const [paused, setPaused] = useState(false);
  const { error: amiError, setError: setAmiError, clear: clearAmiError } = useActionError();

  useEffect(() => {
    (async () => {
      try {
        const res = await fetchWithAuth('/api/logs/ami');
        if (res.ok) setAmiEnabled(!!(await res.json()).enabled);
      } catch { /* leave as off */ }
    })();
  }, []);

  const toggleAmi = async () => {
    setAmiBusy(true);
    clearAmiError();
    try {
      const res = await fetchWithAuth('/api/logs/ami', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !amiEnabled }),
      });
      const data = await res.json().catch(() => null);
      if (res.ok) setAmiEnabled(!!data?.enabled);
      else setAmiError(messageFrom(data, t('logs.amiToggleError', 'Could not toggle the AMI event stream.')));
    } catch {
      setAmiError(t('logs.amiToggleError', 'Could not toggle the AMI event stream.'));
    }
    setAmiBusy(false);
  };

  // Each tab owns its toolbar, so each renders its own <Page> and receives the
  // shared tab strip. Only one is mounted at a time, so the header and tab strip
  // are still rendered exactly once.
  const tabStrip = (
    <Tabs
      tabs={[
        { key: 'system', label: t('logs.tabs.system', 'System'), icon: <Terminal size={14} /> },
        { key: 'deliveries', label: t('logs.tabs.deliveries', 'CRM Deliveries'), icon: <Send size={14} /> },
        { key: 'audit', label: t('logs.tabs.audit', 'Audit log'), icon: <History size={14} /> },
      ]}
      active={tab}
      onChange={(k) => setSearchParams({ tab: k }, { replace: true })}
      ariaLabel={t('nav.logs', 'Logs')}
    />
  );

  if (tab === 'audit') return <AuditPanel tabStrip={tabStrip} />;
  return tab === 'system'
    ? (
      <SystemLogsTab
        tabStrip={tabStrip}
        amiEnabled={amiEnabled}
        amiBusy={amiBusy}
        onToggleAmi={toggleAmi}
        amiError={amiError}
        onDismissAmiError={clearAmiError}
        paused={paused}
        setPaused={setPaused}
      />
    )
    : <DeliveriesTab tabStrip={tabStrip} />;
}

// ===========================================================================
// System tab — live AMI event stream
// ===========================================================================
const MAX_LINES = 3000;
const POLL_MS = 1500;

/* Colour groups the event by what it tells you about, not by severity — nothing in a raw
   AMI stream is an error, so no event is painted danger-red. */
function eventColor(name: string): string {
  if (name === 'SIP') return 'var(--accent-primary)';
  if (name.startsWith('Queue') || name.startsWith('Agent')) return 'var(--accent-primary)';
  if (name === 'Hangup' || name.endsWith('Status') || name.startsWith('Device')) return 'var(--accent-warning)';
  if (name.startsWith('Dial') || name === 'Bridge' || name === 'Newchannel' || name === 'Newstate') return 'var(--accent-success)';
  if (name === 'OriginateResponse' || name === 'UserEvent') return 'var(--accent-purple)';
  return 'var(--text-muted)';
}

interface SystemLogsTabProps {
  tabStrip: React.ReactNode;
  amiEnabled: boolean;
  amiBusy: boolean;
  onToggleAmi: () => void;
  amiError: string | null;
  onDismissAmiError: () => void;
  paused: boolean;
  setPaused: (fn: (p: boolean) => boolean) => void;
}

function SystemLogsTab({
  tabStrip, amiEnabled, amiBusy, onToggleAmi, amiError, onDismissAmiError, paused, setPaused,
}: SystemLogsTabProps) {
  const { t } = useTranslation();
  const [events, setEvents] = useState<AmiEvent[]>([]);
  const [eventNames, setEventNames] = useState<string[]>([]);
  const [eventFilter, setEventFilter] = useState('');
  // The per-event counts on screen when an event filter was picked. A picked filter
  // refetches only that event, so the other options keep the counts they had before.
  const [unfilteredCounts, setUnfilteredCounts] = useState<Record<string, number>>({});
  const [search, setSearch] = useState('');
  const [autoscroll, setAutoscroll] = useState(true);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sipEnabled, setSipEnabled] = useState(false);
  const [sipBusy, setSipBusy] = useState(false);
  const [sipError, setSipError] = useState<string | null>(null);

  // Refs so the poll closure always reads current values without re-creating the interval.
  const sinceRef = useRef(0);
  const pausedRef = useRef(paused);
  const eventFilterRef = useRef(eventFilter);
  const searchRef = useRef(search);
  const autoscrollRef = useRef(autoscroll);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => { pausedRef.current = paused; }, [paused]);
  useEffect(() => { eventFilterRef.current = eventFilter; }, [eventFilter]);
  useEffect(() => { searchRef.current = search; }, [search]);
  useEffect(() => { autoscrollRef.current = autoscroll; }, [autoscroll]);

  const poll = useCallback(async () => {
    if (pausedRef.current) return;
    try {
      const params = new URLSearchParams({ since: String(sinceRef.current) });
      if (eventFilterRef.current) params.set('event', eventFilterRef.current);
      if (searchRef.current) params.set('q', searchRef.current);
      const res = await fetchWithAuth(`/api/logs?${params}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const incoming: AmiEvent[] = data.lines || [];
      setError(null);
      if (!incoming.length) return;
      sinceRef.current = Math.max(sinceRef.current, ...incoming.map((e) => e.seq));
      setEvents((prev) => {
        const next = [...prev, ...incoming];
        return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next;
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    poll();
    const id = setInterval(poll, POLL_MS);
    return () => clearInterval(id);
  }, [poll]);

  // Filters are applied server-side, so changing one resets the cursor and buffer.
  useEffect(() => {
    sinceRef.current = 0;
    setEvents([]);
    setExpanded(null);
    const id = setTimeout(poll, 250);
    return () => clearTimeout(id);
  }, [eventFilter, search, poll]);

  // Refresh the event-name dropdown periodically — new event types appear over time.
  useEffect(() => {
    const load = async () => {
      try {
        const res = await fetchWithAuth('/api/logs/events');
        if (res.ok) setEventNames((await res.json()).events || []);
      } catch { /* dropdown is cosmetic; ignore */ }
    };
    load();
    const id = setInterval(load, 15000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetchWithAuth('/api/logs/siptrace');
        if (!res.ok) return;
        const d = await res.json();
        setSipEnabled(!!d.enabled);
        if (d.error) setSipError(d.error);
      } catch { /* leave as off */ }
    })();
  }, []);

  const toggleSip = async () => {
    setSipBusy(true);
    setSipError(null);
    try {
      const res = await fetchWithAuth('/api/logs/siptrace', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !sipEnabled }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        // A failure here is nearly always the tracer not being able to read Asterisk's
        // log file, so surface the server's message rather than a generic error.
        setSipError(messageFrom(data, t('logs.system.sipFail', 'Failed to toggle SIP trace')));
        return;
      }
      setSipEnabled(!!data?.enabled);
      if (data?.error) setSipError(data.error);
    } catch {
      setSipError(t('logs.system.sipFail', 'Failed to toggle SIP trace'));
    } finally {
      setSipBusy(false);
    }
  };

  // Autoscroll on append, unless the user has scrolled away from the bottom.
  useEffect(() => {
    if (autoscrollRef.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [events]);

  const exportTxt = () => {
    const text = events
      .map((e) => `${new Date(e.ts * 1000).toISOString()}  ${e.event}  ${e.summary}`)
      .join('\n');
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `opdesk-ami-events-${Date.now()}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    if (atBottom !== autoscrollRef.current) setAutoscroll(atBottom);
  };

  // Every known event type stays offered (new ones appear over time); the ones in the
  // stream on screen carry their count.
  const liveCounts = useMemo(() => countBy(events, (e) => e.event), [events]);
  const eventCounts = eventFilter
    ? { ...unfilteredCounts, [eventFilter]: liveCounts[eventFilter] ?? 0 }
    : liveCounts;
  const eventOptions = [...new Set([...eventNames, ...Object.keys(eventCounts)])]
    .sort()
    .map((n) => ({ value: n, label: n, count: eventCounts[n] || undefined }));
  const pickEvent = (next: string) => {
    if (!eventFilter) setUnfilteredCounts(liveCounts);
    setEventFilter(next);
  };

  // The stream carries AMI events and, when the trace is on, SIP lines.
  const live = amiEnabled || sipEnabled;

  return (
    <Page
      icon={ScrollText}
      title={t('nav.logs', 'Logs')}
      tabs={tabStrip}
      className="logs-page"
      actions={
        <Badge tone={!amiEnabled ? 'neutral' : paused ? 'warning' : 'success'} dot={amiEnabled && !paused}>
          {!amiEnabled
            ? t('logs.system.off', 'Off')
            : paused
              ? t('logs.system.paused', 'Paused')
              : t('common.live', 'Live')}
        </Badge>
      }
      toolbar={
        <Toolbar
          search={
            <SearchInput
              value={search}
              onChange={setSearch}
              label={t('logs.system.search', 'Search')}
              placeholder={t('logs.system.searchPlaceholder', 'Channel, caller ID, queue…')}
            />
          }
          filters={
            <>
              <div data-active={eventFilter || undefined}>
                <Dropdown
                  size="md"
                  value={eventFilter}
                  onChange={pickEvent}
                  ariaLabel={t('logs.system.eventType', 'Event type')}
                  icon={Tag}
                  options={[{ value: '', label: t('logs.system.allEvents', 'All events') }, ...eventOptions]}
                />
              </div>
              {/* Switches, not solid buttons: a toolbar holds no primary action,
                  and on/off reads at a glance from a switch. */}
              <Toggle
                checked={amiEnabled}
                onChange={() => { onToggleAmi(); }}
                disabled={amiBusy}
                label={t('logs.amiToggle', 'Record AMI events')}
              />
              <Toggle
                checked={sipEnabled}
                onChange={() => { void toggleSip(); }}
                disabled={sipBusy}
                label={t('logs.sipToggle', 'Show SIP trace')}
              />
            </>
          }
          actions={
            <>
              <button type="button" className="btn btn-ghost" onClick={() => setPaused((p) => !p)}>
                {paused ? <Play size={14} /> : <Pause size={14} />}
                {paused ? t('common.resume', 'Resume') : t('common.pause', 'Pause')}
              </button>
              <button type="button" className="btn btn-ghost" onClick={exportTxt} disabled={!events.length}>
                <Download size={14} />
                {t('logs.system.export', 'Export')}
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => { setEvents([]); setExpanded(null); }}
                disabled={!events.length}
              >
                <Trash2 size={14} />
                {t('common.clear', 'Clear')}
              </button>
            </>
          }
        />
      }
    >
      <Alert>{sipError}</Alert>
      <Alert onDismiss={onDismissAmiError}>{amiError}</Alert>
      <Alert>{error}</Alert>

      <Card flush className="logs-viewer-card" bodyClassName="logs-viewer-body">
        <div className="logs-viewer" ref={scrollRef} onScroll={onScroll}>
          {!events.length ? (
            !live ? (
              <EmptyState
                icon={Terminal}
                title={t('logs.offTitle', 'Recording is off')}
                description={t('logs.system.offHint', 'Recording is off — turn AMI on to stream live events.')}
              />
            ) : paused ? (
              <EmptyState
                icon={Pause}
                title={t('logs.pausedTitle', 'Stream paused')}
                description={t('logs.system.pausedHint', 'Stream paused — resume to receive AMI events.')}
              />
            ) : (
              <EmptyState
                icon={Terminal}
                title={t('logs.waitingTitle', 'Waiting for AMI activity')}
                description={t('logs.waitingDesc', 'Events appear here as Asterisk reports them.')}
              />
            )
          ) : (
            events.map((e) => {
              const open = expanded === e.seq;
              return (
                <div key={e.seq}>
                  {/* Expander: a button so it is tabbable and Enter/Space work, and
                      aria-expanded so the collapsed/expanded state is announced. */}
                  <button
                    type="button"
                    className={`logs-line${open ? ' is-open' : ''}`}
                    aria-expanded={open}
                    onClick={() => setExpanded(open ? null : e.seq)}
                  >
                    <ChevronRight size={14} className="logs-line-chevron" />
                    <span className="logs-line-ts">
                      {new Date(e.ts * 1000).toLocaleTimeString(undefined, { hour12: false })}
                    </span>
                    <span
                      className="logs-line-level u-fg-var"
                      style={{ '--u-color': eventColor(e.event) } as React.CSSProperties}
                    >
                      {e.event}
                    </span>
                    <span className="logs-line-text">{e.summary}</span>
                  </button>
                  {open && (
                    <div className="logs-line-fields">
                      {Object.entries(e.fields).map(([k, v]) => (
                        <div className="u-contents" key={k}>
                          <span className="logs-line-field-key">{k}</span>
                          <span className="logs-line-field-val">{String(v)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
        <div className="logs-viewer-footer">
          <span>{t('logs.system.eventCount', '{{count}} events', { count: events.length })}</span>
          {!autoscroll && (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => {
                setAutoscroll(true);
                if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
              }}
            >
              <ArrowDown size={14} />
              {t('logs.system.jumpToLatest', 'Jump to latest')}
            </button>
          )}
        </div>
      </Card>
    </Page>
  );
}

// ===========================================================================
// Deliveries tab — persisted CRM webhook delivery log
// ===========================================================================
const PAGE_SIZE = 50;

/** CRM error responses are frequently HTML or plain text — never assume JSON. */
function prettyOrRaw(s?: string | null): string {
  if (!s) return '—';
  try {
    return JSON.stringify(JSON.parse(s), null, 2);
  } catch {
    return s;
  }
}

function CopyButton({ text }: { text: string }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="btn btn-ghost btn-sm"
      onClick={() => {
        navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        }).catch(() => { /* clipboard blocked: the text stays selectable */ });
      }}
    >
      {copied ? <Check size={14} /> : <Copy size={14} />}
      {copied ? t('common.copied', 'Copied') : t('common.copy', 'Copy')}
    </button>
  );
}

function DirectionBadge({ type }: { type?: string | null }) {
  const { t } = useTranslation();
  if (!type) return <>—</>;
  if (type === 'inbound') {
    return <Badge tone="info" icon={<PhoneIncoming size={14} />}>{t('direction.inbound', 'Inbound')}</Badge>;
  }
  if (type === 'outbound') {
    return <Badge tone="info" icon={<PhoneOutgoing size={14} />}>{t('direction.outbound', 'Outbound')}</Badge>;
  }
  if (type === 'internal') {
    return <Badge tone="info" icon={<ArrowLeftRight size={14} />}>{t('direction.internal', 'Internal')}</Badge>;
  }
  return <Badge tone="info">{type}</Badge>;
}

const DELIVERY_STATUSES: readonly WebhookDeliveryStatus[] = ['pending', 'delivered', 'failed', 'abandoned'];
const DELIVERY_STATUS_TONE: Record<WebhookDeliveryStatus, BadgeTone> = {
  pending: 'warning', delivered: 'success', failed: 'danger', abandoned: 'danger',
};
const DELIVERY_STATUS_DOT: Record<WebhookDeliveryStatus, 'orange' | 'green' | 'red'> = {
  pending: 'orange', delivered: 'green', failed: 'red', abandoned: 'red',
};
const DELIVERY_STATUS_LABELS: Record<WebhookDeliveryStatus, string> = {
  pending: 'Retrying', delivered: 'Delivered', failed: 'Failed', abandoned: 'Gave up',
};

/** A row's queue status; rows written before the retry queue only carry `success`. */
function deliveryStatus(r: WebhookDelivery): WebhookDeliveryStatus {
  return r.status ?? (r.success ? 'delivered' : 'failed');
}

/** A delivery the operator may retry in place: not landed, and its body is replayable. */
function canRetry(r: WebhookDelivery): boolean {
  return deliveryStatus(r) !== 'delivered' && !r.truncated;
}

function DeliveriesTab({ tabStrip }: { tabStrip: React.ReactNode }) {
  const { t } = useTranslation();
  const statusLabel = (s: WebhookDeliveryStatus) => t(`logs.deliveries.status.${s}`, DELIVERY_STATUS_LABELS[s]);
  const [rows, setRows] = useState<WebhookDelivery[]>([]);
  // Cursor pagination. `stack` holds the cursor for each visited page so Previous
  // can go back -- a forward-only cursor has no way to address the page before it.
  // stack[0] is always null (the first page).
  const [stack, setStack] = useState<(string | null)[]>([null]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState('');       // '' | 'unresolved' | a WebhookDeliveryStatus
  const [direction, setDirection] = useState(''); // '' | inbound | outbound | internal
  // `search` is already the settled term — ui/SearchInput owns the debounce.
  const [search, setSearch] = useState('');
  const [dateRange, setDateRange] = useState<DateRange>(() => quickRanges()['7d']);
  const pageIndex = stack.length - 1;
  const [openRow, setOpenRow] = useState<WebhookDelivery | null>(null);
  const [detail, setDetail] = useState<Record<number, WebhookDeliveryDetail>>({});
  const [detailLoading, setDetailLoading] = useState<number | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [resendingId, setResendingId] = useState<number | null>(null);
  const [retryingId, setRetryingId] = useState<number | null>(null);
  // Totals per status (whole log) and the filters' per-value counts (current query).
  const [counts, setCounts] = useState<Partial<Record<WebhookDeliveryStatus, number>> | null>(null);
  const [facets, setFacets] = useState<WebhookDeliveryFacets | null>(null);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [confirm, confirmDialog] = useConfirm();

  const fetchPage = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE), facets: '1' });
      const cur = stack[stack.length - 1];
      if (cur) params.set('cursor', cur);
      if (status) params.set('status', status);
      if (direction) params.set('call_type', direction);
      if (search) params.set('search', search);
      if (dateRange?.from) params.set('date_from', dateRange.from);
      if (dateRange?.to) params.set('date_to', dateRange.to);
      const { items, page, meta } = await apiList<WebhookDelivery>(`/api/logs/deliveries?${params}`);
      setRows(items);
      setNextCursor(page.next_cursor);
      setCounts((meta.counts as Partial<Record<WebhookDeliveryStatus, number>>) ?? null);
      setFacets((meta.facets as WebhookDeliveryFacets) ?? null);
      setError(null);
    } catch (e) {
      setError(toApiError(e).message);
    } finally {
      setLoading(false);
    }
  }, [stack, status, direction, search, dateRange]);

  useEffect(() => { fetchPage(); }, [fetchPage]);
  // Any filter change invalidates every cursor: they encode a position within
  // the OLD result set, so paging on would silently skip or repeat rows.
  useEffect(() => { setStack([null]); }, [search, status, direction, dateRange]);

  const openDetail = async (row: WebhookDelivery) => {
    setOpenRow(row);
    setDetailError(null);
    if (detail[row.id]) return;
    setDetailLoading(row.id);
    try {
      const full = await api<WebhookDeliveryDetail>(`/api/logs/deliveries/${row.id}`);
      setDetail((d) => ({ ...d, [row.id]: full }));
    } catch (e) {
      setDetailError(messageOf(e, t('logs.deliveries.detailFail', 'Could not load this delivery.')));
    }
    setDetailLoading(null);
  };

  const resend = async (row: WebhookDelivery) => {
    const when = new Date(row.created_at).toLocaleString();
    const ok = await confirm({
      title: t('logs.deliveries.resendTitle', 'Resend delivery #{{id}}?', { id: row.id }),
      // The stored text is two paragraphs split by a blank line; a <p> would run them together.
      message: t(
        'logs.deliveries.resendConfirm',
        'Resend delivery #{{id}} (originally sent {{when}})?\n\nThe stored request body is replayed as-is through the CRM settings currently in effect.',
        { id: row.id, when },
      ).split(/\n\s*\n/).map((para, i) => (
        <span key={i} className={i > 0 ? 'u-block u-mt-2' : 'u-block'}>{para}</span>
      )),
      confirmLabel: t('logs.deliveries.resend', 'Resend'),
      cancelLabel: t('common.cancel', 'Cancel'),
      tone: 'primary',
    });
    if (!ok) return;
    setResendingId(row.id);
    try {
      const res = await fetchWithAuth(`/api/logs/deliveries/${row.id}/resend`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setMessage({ type: 'success', text: t('logs.deliveries.resendOk', 'Resend queued — a new attempt will appear shortly.') });
        setTimeout(fetchPage, 1200);   // the new attempt is its own row
      } else {
        setMessage({ type: 'error', text: messageFrom(data, t('logs.deliveries.resendFail', 'Resend failed.')) });
      }
    } catch (e) {
      setMessage({ type: 'error', text: e instanceof Error ? e.message : String(e) });
    }
    setResendingId(null);
    setTimeout(() => setMessage(null), 5000);
  };

  // Retry in place: the same delivery (same idempotency key) is made due now and swept at
  // once, so the outcome is on screen when this returns.
  const retry = async (row: WebhookDelivery) => {
    setRetryingId(row.id);
    try {
      const res = await api<{ ok: boolean; delivery: WebhookDelivery | null }>(
        `/api/logs/deliveries/${row.id}/retry`, { method: 'POST' });
      const now = res.delivery;
      if (now) setRows(rs => rs.map(r => (r.id === now.id ? { ...r, ...now } : r)));
      setDetail(d => { const next = { ...d }; delete next[row.id]; return next; });
      const landed = now && deliveryStatus(now) === 'delivered';
      setMessage(landed
        ? { type: 'success', text: t('logs.deliveries.retryOk', 'Delivered on retry.') }
        : { type: 'error', text: t('logs.deliveries.retryStillFailing', 'Retried — the CRM still did not accept it.') });
    } catch (e) {
      setMessage({ type: 'error', text: messageOf(e, t('logs.deliveries.retryFail', 'Retry failed.')) });
    }
    setRetryingId(null);
    setTimeout(() => setMessage(null), 5000);
  };

  // The filters offer what occurs under the other filters, each with its count (facets);
  // without facets (an error, an older server) every value is offered.
  const statusOptions = DELIVERY_STATUSES.map(s => ({ value: s, label: statusLabel(s), dot: DELIVERY_STATUS_DOT[s] }));
  const shownStatuses = facets?.status ? presentOptions(statusOptions, facets.status, status) : statusOptions;
  const unresolved = (facets?.status?.pending ?? 0) + (facets?.status?.failed ?? 0) + (facets?.status?.abandoned ?? 0);
  const directionOptions = [
    { value: 'inbound', label: t('direction.inbound', 'Inbound'), dot: 'green' as const },
    { value: 'outbound', label: t('direction.outbound', 'Outbound'), dot: 'blue' as const },
    { value: 'internal', label: t('direction.internal', 'Internal'), dot: 'neutral' as const },
  ];
  const shownDirections = facets?.call_type ? presentOptions(directionOptions, facets.call_type, direction) : directionOptions;

  const columns: Column<WebhookDelivery>[] = [
    {
      key: 'time', header: t('logs.deliveries.time', 'Time'), primary: true,
      cell: (r) => <span className="u-text-sm u-nowrap">{new Date(r.created_at).toLocaleString()}</span>,
    },
    {
      key: 'direction', header: t('fields.direction', 'Direction'),
      cell: (r) => <DirectionBadge type={r.call_type} />,
    },
    {
      key: 'call', header: t('logs.deliveries.call', 'Call'),
      cell: (r) => (
        <span className="u-mono u-text-sm u-nowrap">
          {r.caller || '—'} <span className="u-fg-muted">→</span> {r.destination || '—'}
        </span>
      ),
    },
    {
      key: 'endpoint', header: t('logs.deliveries.endpoint', 'Endpoint'), hideOnMobile: true,
      cell: (r) => (
        <span className="u-row u-gap-1h u-min-w-0">
          <Badge tone="neutral">{r.method}</Badge>
          <span className="u-mono u-text-sm u-fg-secondary u-truncate" title={r.url}>{r.url}</span>
        </span>
      ),
    },
    {
      key: 'result', header: t('logs.deliveries.result', 'Result'),
      cell: (r) => {
        const st = deliveryStatus(r);
        return (
          <span className="u-col u-gap-1 u-min-w-0">
            <span className="u-row u-gap-1 u-wrap">
              <Badge tone={DELIVERY_STATUS_TONE[st]}>{statusLabel(st)}</Badge>
              <Badge tone="neutral" title={r.error || undefined}>
                {r.status_code ?? t('logs.deliveries.noResponse', 'no response')}
              </Badge>
            </span>
            {st === 'pending' && r.next_attempt_at && (
              <span className="u-text-sm u-fg-muted u-nowrap">
                {t('logs.deliveries.nextAttempt', 'Next try {{when}}', { when: new Date(r.next_attempt_at).toLocaleTimeString() })}
              </span>
            )}
            {!r.success && r.error && (
              <span className="u-text-sm u-fg-danger u-truncate" title={r.error}>{r.error}</span>
            )}
          </span>
        );
      },
    },
    {
      key: 'latency', header: t('common.latency', 'Latency'), align: 'end', hideOnMobile: true,
      cell: (r) => <span className="u-mono u-text-sm">{r.duration_ms != null ? `${r.duration_ms} ms` : '—'}</span>,
    },
    {
      key: 'attempt', header: t('logs.deliveries.attempt', 'Attempt'), align: 'center',
      cell: (r) => (
        <span className="u-text-sm u-nowrap">
          #{r.attempt}
          {r.max_attempts != null && r.max_attempts > 1 && (
            <span className="u-fg-muted u-ms-1">
              {t('logs.deliveries.tries', '{{count}}/{{max}} tries', { count: r.attempts ?? 0, max: r.max_attempts })}
            </span>
          )}
          {r.parent_id != null && (
            <span
              className="u-fg-muted u-ms-1"
              title={t('logs.deliveries.resentFrom', 'Resent from #{{id}}', { id: r.parent_id })}
            >
              <RotateCcw size={12} aria-hidden />
            </span>
          )}
        </span>
      ),
    },
    {
      key: 'actions', header: t('common.actions', 'Actions'), align: 'end', className: 'actions-cell',
      cell: (r) => (
        <div className="u-row-stretch u-gap-1 u-justify-end">
          <button
            type="button"
            className="btn btn-ghost btn-sm btn-icon"
            onClick={() => openDetail(r)}
            title={t('logs.deliveries.details', 'Request and response')}
            aria-label={t('logs.deliveries.detailsFor', { defaultValue: 'Details for delivery {{id}}', id: r.id })}
          >
            <Braces size={14} />
          </button>
          {canRetry(r) && (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => retry(r)}
              disabled={retryingId === r.id}
              title={t('logs.deliveries.retryHint', 'Send this delivery again now, with the same idempotency key.')}
            >
              {retryingId === r.id ? <Loader2 size={14} className="spinner" /> : <Repeat size={14} />}
              {t('logs.deliveries.retry', 'Retry now')}
            </button>
          )}
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => resend(r)}
            disabled={resendingId === r.id || r.truncated}
            title={r.truncated
              ? t('logs.deliveries.truncatedHint', 'Request body was truncated when logged — cannot be replayed.')
              : t('logs.deliveries.resend', 'Resend')}
          >
            {resendingId === r.id ? <Loader2 size={14} className="spinner" /> : <Send size={14} />}
            {t('logs.deliveries.resend', 'Resend')}
          </button>
        </div>
      ),
    },
  ];

  const d = openRow ? detail[openRow.id] : undefined;

  return (
    <Page
      icon={ScrollText}
      title={t('nav.logs', 'Logs')}
      // Only this tab is time-scoped; the System tab's Page has no `scope`, so
      // the header does not offer a range that would do nothing there.
      scope={<PageRange value={dateRange} onChange={setDateRange} />}
      tabs={tabStrip}
      toolbar={
        <Toolbar
          search={
            <SearchInput
              value={search}
              onChange={setSearch}
              label={t('logs.deliveries.search', 'Search deliveries')}
              placeholder={t('logs.deliveries.searchPlaceholder', 'caller, destination, call ID…')}
            />
          }
          filters={
            <>
              <div data-active={status || undefined}>
                <Dropdown
                  size="md"
                  value={status}
                  onChange={setStatus}
                  ariaLabel={t('logs.deliveries.result', 'Result')}
                  options={[
                    { value: '', label: t('logs.deliveries.allStatuses', 'All results') },
                    {
                      value: 'unresolved',
                      label: t('logs.deliveries.status.unresolved', 'Not delivered'),
                      dot: 'red',
                      ...(facets?.status ? { count: unresolved } : {}),
                    },
                    ...shownStatuses,
                  ]}
                />
              </div>
              <div data-active={direction || undefined}>
                <Dropdown
                  size="md"
                  value={direction}
                  onChange={setDirection}
                  ariaLabel={t('fields.direction', 'Direction')}
                  options={[
                    { value: '', label: t('direction.all', 'All directions') },
                    ...shownDirections,
                  ]}
                />
              </div>
            </>
          }
          actions={
            <button type="button" className="btn btn-ghost" onClick={() => fetchPage()} disabled={loading}>
              {loading ? <Loader2 size={14} className="spinner" /> : <RefreshCw size={14} />}
              {t('common.refresh', 'Refresh')}
            </button>
          }
        />
      }
    >
      <Alert
        tone={message?.type === 'success' ? 'success' : 'error'}
        onDismiss={() => setMessage(null)}
        className="u-mb-3"
      >
        {message?.text}
      </Alert>

      {/* The whole log at a glance: what landed, what is still being retried, what never will. */}
      {counts && (
        <div className="u-row u-gap-2 u-wrap u-mb-3" role="group" aria-label={t('logs.deliveries.totals', 'Deliveries by status')}>
          {DELIVERY_STATUSES.map(s => (
            <button
              key={s}
              type="button"
              className={`btn btn-ghost btn-sm${status === s ? ' is-selected' : ''}`}
              aria-pressed={status === s}
              onClick={() => setStatus(status === s ? '' : s)}
            >
              <Badge tone={DELIVERY_STATUS_TONE[s]}>{counts[s] ?? 0}</Badge>
              {statusLabel(s)}
            </button>
          ))}
        </div>
      )}

      {loading && !rows.length ? (
        <Loading />
      ) : error ? (
        <Alert
          action={<button type="button" className="btn btn-sm" onClick={fetchPage}>{t('common.retry', 'Retry')}</button>}
        >
          {error}
        </Alert>
      ) : (
        <Table
          columns={columns}
          rows={rows}
          rowKey={(r) => r.id}
          framed
          stickyHeader
          caption={t('logs.tabs.deliveries', 'CRM Deliveries')}
          empty={
            <EmptyState
              size="sm"
              icon={Inbox}
              title={t('logs.deliveries.empty', 'No CRM deliveries in this period.')}
            />
          }
        />
      )}

      {!error && rows.length > 0 && (
        <div className="u-mt-3">
          <Pagination
            mode="cursor"
            hasPrev={pageIndex > 0}
            hasNext={!!nextCursor}
            onPrev={() => setStack((s) => s.slice(0, -1))}
            onNext={() => setStack((s) => [...s, nextCursor])}
            info={t('logs.deliveries.showingCount', 'Showing {{count}}', { count: rows.length })}
          />
        </div>
      )}

      <Modal
        open={openRow !== null}
        onClose={() => setOpenRow(null)}
        width="xl"
        icon={<Braces size={18} />}
        title={openRow
          ? t('logs.deliveries.detailTitle', 'Delivery #{{id}}', { id: openRow.id })
          : ''}
        footer={openRow && (
          <>
            <button type="button" className="btn" onClick={() => setOpenRow(null)}>
              {t('common.close', 'Close')}
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => { const row = openRow; setOpenRow(null); void resend(row); }}
              disabled={resendingId === openRow.id || openRow.truncated}
              title={openRow.truncated
                ? t('logs.deliveries.truncatedHint', 'Request body was truncated when logged — cannot be replayed.')
                : undefined}
            >
              <Send size={14} />
              {t('logs.deliveries.resend', 'Resend')}
            </button>
          </>
        )}
      >
        {openRow && (detailLoading === openRow.id ? (
          <Loading size="sm" />
        ) : detailError ? (
          <Alert>{detailError}</Alert>
        ) : (
          <div className="u-col u-gap-3">
            <div className="crmx-meta u-mt-0">
              <div className="crmx-meta-cell">
                <span className="crmx-meta-k">{t('logs.deliveries.endpoint', 'Endpoint')}</span>
                <span className="crmx-meta-v mono" title={openRow.url}>{openRow.method} {openRow.url}</span>
              </div>
              <div className="crmx-meta-cell">
                <span className="crmx-meta-k">{t('logs.deliveries.result', 'Result')}</span>
                <span className="crmx-meta-v crmx-num">HTTP {d?.status_code ?? '—'}</span>
              </div>
              <div className="crmx-meta-cell">
                <span className="crmx-meta-k">{t('common.latency', 'Latency')}</span>
                <span className="crmx-meta-v crmx-num">{d?.duration_ms ?? '—'} ms</span>
              </div>
              <div className="crmx-meta-cell">
                <span className="crmx-meta-k">{t('logs.deliveries.attempt', 'Attempt')}</span>
                <span className="crmx-meta-v crmx-num">#{openRow.attempt}</span>
              </div>
              <div className="crmx-meta-cell">
                <span className="crmx-meta-k">{t('common.status', 'Status')}</span>
                <span className="crmx-meta-v">
                  {statusLabel(deliveryStatus(openRow))}
                  {openRow.max_attempts != null && (
                    <span className="u-fg-muted u-ms-1">
                      {t('logs.deliveries.tries', '{{count}}/{{max}} tries', { count: openRow.attempts ?? 0, max: openRow.max_attempts })}
                    </span>
                  )}
                </span>
              </div>
              {openRow.trigger_kind && (
                <div className="crmx-meta-cell">
                  <span className="crmx-meta-k">{t('logs.deliveries.trigger', 'Sent')}</span>
                  <span className="crmx-meta-v">
                    {t(`logs.deliveries.triggers.${openRow.trigger_kind}`, openRow.trigger_kind)}
                  </span>
                </div>
              )}
              {openRow.delivery_uuid && (
                <div className="crmx-meta-cell">
                  <span className="crmx-meta-k">{t('logs.deliveries.idempotencyKey', 'Idempotency key')}</span>
                  <span className="crmx-meta-v mono" dir="ltr">{openRow.delivery_uuid}</span>
                </div>
              )}
            </div>

            <div>
              <div className="u-row u-between u-gap-2 u-mb-1h">
                <span className="u-text-sm u-semibold u-fg-secondary">{t('logs.deliveries.request', 'Request')}</span>
                <CopyButton text={d?.request_body || ''} />
              </div>
              <pre className="crmx-json">{prettyOrRaw(d?.request_body)}</pre>
            </div>

            <div>
              <div className="u-row u-between u-gap-2 u-mb-1h">
                <span className="u-text-sm u-semibold u-fg-secondary">{t('logs.deliveries.response', 'Response')}</span>
                <CopyButton text={d?.response_body || d?.error || ''} />
              </div>
              <pre className="crmx-json">{prettyOrRaw(d?.response_body || d?.error)}</pre>
            </div>
          </div>
        ))}
      </Modal>

      {confirmDialog}
    </Page>
  );
}
