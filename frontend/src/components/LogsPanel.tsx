import { useState, useEffect, useRef, useCallback, Fragment } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  Terminal, Send, Play, Pause, Download, Trash2, Tag, Network,
  ChevronRight, ChevronDown, RefreshCw, Copy, Check, ArrowDown, AlertCircle,
} from 'lucide-react';
import { fetchWithAuth } from '../auth';
import { FilterSelect } from './FilterSelect';
import { PageRange } from './PageRange';
import { quickRanges } from './analyticsUtils';
import type { DateRange } from './analyticsUtils';
import { Page, SearchInput, Tabs, Toolbar } from './ui';
import type { AmiEvent, WebhookDelivery, WebhookDeliveryDetail } from '../types';
import { apiList, messageFrom, toApiError } from '../lib/api';

type LogsTab = 'system' | 'deliveries';

// ===========================================================================
// Shell
// ===========================================================================
export function LogsPanel() {
  const { t } = useTranslation();
  // Sub-tab lives in the URL so /logs?tab=deliveries is deep-linkable and survives a
  // refresh, matching how Settings handles its sub-tabs.
  const [searchParams, setSearchParams] = useSearchParams();
  const tab: LogsTab = searchParams.get('tab') === 'deliveries' ? 'deliveries' : 'system';

  // Capture state lives here rather than in the tab so the header can show the stream's
  // status badge, and so pausing survives a trip through the Deliveries tab.
  const [amiEnabled, setAmiEnabled] = useState(false);
  const [amiBusy, setAmiBusy] = useState(false);
  const [paused, setPaused] = useState(false);

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
    try {
      const res = await fetchWithAuth('/api/logs/ami', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !amiEnabled }),
      });
      if (res.ok) setAmiEnabled(!!(await res.json()).enabled);
    } catch { /* toggle stays as-is */ }
    setAmiBusy(false);
  };

  // Both tabs own their own toolbar, so each renders its own <Page> and receives
  // the shared tab strip to slot in. Only one is mounted at a time, so the
  // header and tab strip are still rendered exactly once — and neither tab has
  // to hand-roll chrome to get a toolbar of its own.
  const tabStrip = (
    <Tabs
      tabs={[
        { key: 'system', label: t('logs.tabs.system', 'System'), icon: <Terminal size={14} /> },
        { key: 'deliveries', label: t('logs.tabs.deliveries', 'CRM Deliveries'), icon: <Send size={14} /> },
      ]}
      active={tab}
      onChange={(k) => setSearchParams({ tab: k }, { replace: true })}
    />
  );

  return tab === 'system'
    ? (
      <SystemLogsTab
        tabStrip={tabStrip}
        amiEnabled={amiEnabled}
        amiBusy={amiBusy}
        onToggleAmi={toggleAmi}
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
  paused: boolean;
  setPaused: (fn: (p: boolean) => boolean) => void;
}

function SystemLogsTab({ tabStrip, amiEnabled, amiBusy, onToggleAmi, paused, setPaused }: SystemLogsTabProps) {
  const { t } = useTranslation();
  const [events, setEvents] = useState<AmiEvent[]>([]);
  const [eventNames, setEventNames] = useState<string[]>([]);
  const [eventFilter, setEventFilter] = useState('');
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

  return (
    <Page
      icon={<Terminal size={18} />}
      title={t('logs.system.title', 'AMI Event Stream')}
      status={
        <span className={`lg-badge ${amiEnabled && !paused ? 'lg-badge-live' : 'lg-badge-off'}`}>
          {!amiEnabled
            ? t('logs.system.off', 'Off')
            : paused
              ? t('logs.system.paused', 'Paused')
              : t('logs.system.live', 'Live')}
        </span>
      }
      tabs={tabStrip}
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
          filtersLabel={t('common.filters', 'Filters')}
          filters={[
            {
              key: 'event',
              label: t('logs.system.eventType', 'Event type'),
              active: Boolean(eventFilter),
              control: (
                <FilterSelect
                  size="md"
                  value={eventFilter}
                  onChange={setEventFilter}
                  icon={Tag}
                  options={[
                    { value: '', label: t('logs.system.allEvents', 'All events') },
                    ...eventNames.map((n) => ({ value: n, label: n })),
                  ]}
                />
              ),
            },
          ]}
          actions={[
            <button
              className={`btn ${amiEnabled ? 'btn-primary' : 'btn-ghost'}`}
              onClick={onToggleAmi}
              disabled={amiBusy}
              title={t('logs.system.amiHint', 'Enable or disable AMI event recording')}
            >
              {amiBusy ? <RefreshCw size={13} className="spinner" /> : <Terminal size={13} />}
              {t('logs.system.ami', 'AMI')} {amiEnabled ? t('logs.system.on', 'On') : t('logs.system.off', 'Off')}
            </button>,
            <button
              className={`btn ${sipEnabled ? 'btn-primary' : 'btn-ghost'}`}
              onClick={toggleSip}
              disabled={sipBusy}
              title={t('logs.system.sipHint', 'Interleave raw SIP messages into the stream')}
            >
              {sipBusy ? <RefreshCw size={13} className="spinner" /> : <Network size={13} />}
              {t('logs.system.sip', 'SIP')} {sipEnabled ? t('logs.system.on', 'On') : t('logs.system.off', 'Off')}
            </button>,
            <button className="btn btn-ghost" onClick={() => setPaused((p) => !p)}>
              {paused ? <Play size={13} /> : <Pause size={13} />}
              {paused ? t('logs.system.resume', 'Resume') : t('logs.system.pause', 'Pause')}
            </button>,
            <button className="btn btn-ghost" onClick={exportTxt} disabled={!events.length}>
              <Download size={13} />{t('logs.system.export', 'Export')}
            </button>,
            <button className="btn btn-ghost" onClick={() => { setEvents([]); setExpanded(null); }} disabled={!events.length}>
              <Trash2 size={13} />{t('logs.system.clear', 'Clear')}
            </button>,
          ]}
        />
      }
    >
      {(sipError || error) && (
        <div className="lg-error">
          <AlertCircle size={14} /><span>{sipError || error}</span>
        </div>
      )}

      <div className="lg-viewer-card">
        <div className="lg-viewer" ref={scrollRef} onScroll={onScroll}>
          {!events.length ? (
            <div className="lg-empty">
              {!amiEnabled && !sipEnabled
                ? t('logs.system.offHint', 'Recording is off — turn AMI on to stream live events.')
                : paused
                  ? t('logs.system.pausedHint', 'Stream paused — resume to receive AMI events.')
                  : t('logs.system.waiting', 'Waiting for AMI activity…')}
            </div>
          ) : (
            events.map((e) => {
              const open = expanded === e.seq;
              return (
                <div key={e.seq} className={`lg-line${open ? ' is-open' : ''}`}>
                  <button
                    className="lg-line-main"
                    onClick={() => setExpanded(open ? null : e.seq)}
                    aria-expanded={open}
                  >
                    {/* One chevron that rotates — swapping glyphs makes the row twitch. */}
                    <ChevronRight size={11} className="lg-line-chevron" />
                    <span className="lg-line-ts">
                      {new Date(e.ts * 1000).toLocaleTimeString(undefined, { hour12: false })}
                    </span>
                    <span className="lg-line-level" style={{ color: eventColor(e.event) }}>{e.event}</span>
                    <span className="lg-line-text">{e.summary}</span>
                  </button>
                  {open && (
                    <div className="lg-line-fields">
                      {Object.entries(e.fields).map(([k, v]) => (
                        <Fragment key={k}>
                          <span className="lg-line-field-key">{k}</span>
                          <span className="lg-line-field-val">{String(v)}</span>
                        </Fragment>
                      ))}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
        <div className="lg-viewer-footer">
          <span>
            {t('logs.system.eventCount', '{{count}} events', { count: events.length })}
          </span>
          {!autoscroll && (
            <button
              className="btn btn-ghost lg-jump"
              onClick={() => {
                setAutoscroll(true);
                if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
              }}
            >
              {t('logs.system.jumpToLatest', 'Jump to latest')}<ArrowDown size={13} />
            </button>
          )}
        </div>
      </div>
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
      className="btn lg-btn lg-copy"
      onClick={() => {
        navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }}
    >
      {copied ? <Check size={13} /> : <Copy size={13} />}
      {copied ? t('logs.deliveries.copied', 'Copied') : t('logs.deliveries.copy', 'Copy')}
    </button>
  );
}

function DeliveriesTab({ tabStrip }: { tabStrip: React.ReactNode }) {
  const { t } = useTranslation();
  const [rows, setRows] = useState<WebhookDelivery[]>([]);
  // Cursor pagination (Rule 5.1). `stack` holds the cursor for each visited page
  // so Previous can go back -- a forward-only cursor has no way to address the
  // page before it. stack[0] is always null (the first page).
  const [stack, setStack] = useState<(string | null)[]>([null]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState('');       // '' | 'success' | 'failed'
  const [direction, setDirection] = useState(''); // '' | inbound | outbound | internal
  // `search` is already the settled term — ui/SearchInput owns the debounce, so
  // the 400ms timer that used to sit here would only stack on top of it.
  const [search, setSearch] = useState('');
  const [dateRange, setDateRange] = useState<DateRange>(() => quickRanges()['7d']);
  const pageIndex = stack.length - 1;
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [detail, setDetail] = useState<Record<number, WebhookDeliveryDetail>>({});
  const [detailLoading, setDetailLoading] = useState<number | null>(null);
  const [resendingId, setResendingId] = useState<number | null>(null);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const fetchPage = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
      const cur = stack[stack.length - 1];
      if (cur) params.set('cursor', cur);
      if (status) params.set('success', status === 'success' ? 'true' : 'false');
      if (direction) params.set('call_type', direction);
      if (search) params.set('search', search);
      if (dateRange?.from) params.set('date_from', dateRange.from);
      if (dateRange?.to) params.set('date_to', dateRange.to);
      const { items, page } = await apiList<WebhookDelivery>(`/api/logs/deliveries?${params}`);
      setRows(items);
      setNextCursor(page.next_cursor);
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

  const toggleRow = async (id: number) => {
    if (expandedId === id) { setExpandedId(null); return; }
    setExpandedId(id);
    if (detail[id]) return;
    setDetailLoading(id);
    try {
      const res = await fetchWithAuth(`/api/logs/deliveries/${id}`);
      if (res.ok) {
        const row: WebhookDeliveryDetail = await res.json();
        setDetail((d) => ({ ...d, [id]: row }));
      }
    } catch { /* the row stays collapsed-empty */ }
    setDetailLoading(null);
  };

  const resend = async (row: WebhookDelivery) => {
    const when = new Date(row.created_at).toLocaleString();
    if (!window.confirm(t(
      'logs.deliveries.resendConfirm',
      'Resend delivery #{{id}} (originally sent {{when}})?\n\nThe stored request body is replayed as-is through the CRM settings currently in effect.',
      { id: row.id, when },
    ))) return;
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


  return (
    <Page
      icon={<Send size={18} />}
      title={t('logs.tabs.deliveries', 'CRM Deliveries')}
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
          filtersLabel={t('common.filters', 'Filters')}
          filters={[
            {
              key: 'status',
              label: t('logs.deliveries.result', 'Result'),
              active: Boolean(status),
              control: (
                <FilterSelect
                  size="md"
                  value={status}
                  onChange={setStatus}
                  options={[
                    { value: '', label: t('logs.deliveries.allStatuses', 'All results') },
                    { value: 'success', label: t('logs.deliveries.status.success', 'Delivered'), dot: 'green' },
                    { value: 'failed', label: t('logs.deliveries.status.failed', 'Failed'), dot: 'red' },
                  ]}
                />
              ),
            },
            {
              key: 'direction',
              label: t('callLog.table.direction', 'Direction'),
              active: Boolean(direction),
              control: (
                <FilterSelect
                  size="md"
                  value={direction}
                  onChange={setDirection}
                  options={[
                    { value: '', label: t('logs.deliveries.allDirections', 'All directions') },
                    { value: 'inbound', label: t('callLog.type.inbound', 'Inbound'), dot: 'green' },
                    { value: 'outbound', label: t('callLog.type.outbound', 'Outbound'), dot: 'blue' },
                    { value: 'internal', label: t('callLog.type.internal', 'Internal'), dot: 'neutral' },
                  ]}
                />
              ),
            },
          ]}
        />
      }
    >
      {message && (
        <div className={`up-alert ${message.type} lg-alert`}>
          {message.type === 'error' ? <AlertCircle size={16} /> : <Check size={16} />}
          <span>{message.text}</span>
        </div>
      )}

      <div className="cl-table-wrap">
        {loading ? (
          <div className="cl-loading"><RefreshCw size={18} className="spinner" /></div>
        ) : error ? (
          <div className="cl-error">
            <AlertCircle size={18} /><span>{error}</span>
            <button className="btn" onClick={fetchPage}>{t('common.retry', 'Retry')}</button>
          </div>
        ) : !rows.length ? (
          <div className="cl-empty">
            {t('logs.deliveries.empty', 'No CRM deliveries in this period.')}
          </div>
        ) : (
          <table className="cl-table lg-table">
            <thead>
              <tr>
                <th>{t('logs.deliveries.time', 'Time')}</th>
                <th>{t('logs.deliveries.direction', 'Direction')}</th>
                <th>{t('logs.deliveries.call', 'Call')}</th>
                <th>{t('logs.deliveries.endpoint', 'Endpoint')}</th>
                <th>{t('logs.deliveries.result', 'Result')}</th>
                <th>{t('logs.deliveries.latency', 'Latency')}</th>
                <th>{t('logs.deliveries.attempt', 'Attempt')}</th>
                <th aria-label="actions" />
              </tr>
            </thead>
            <tbody>
              {rows.map((r, idx) => {
                const open = expandedId === r.id;
                const d = detail[r.id];
                return [
                  <tr key={r.id} className={idx % 2 === 0 ? 'cl-row-even' : 'cl-row-odd'}>
                    <td data-label={t('logs.deliveries.time', 'Time')}>
                      <span className="lg-mono">{new Date(r.created_at).toLocaleString()}</span>
                    </td>
                    <td data-label={t('logs.deliveries.direction', 'Direction')}>
                      {r.call_type
                        ? <span className={`cl-direction cl-direction-${r.call_type}`}>{r.call_type}</span>
                        : '—'}
                    </td>
                    <td data-label={t('logs.deliveries.call', 'Call')}>
                      <span className="cl-phone">{r.caller || '—'}</span>
                      <span className="lg-arrow"> → </span>
                      <span className="cl-phone">{r.destination || '—'}</span>
                    </td>
                    <td data-label={t('logs.deliveries.endpoint', 'Endpoint')}>
                      <span className="lg-method">{r.method}</span>
                      <span className="lg-url" title={r.url}>{r.url}</span>
                    </td>
                    <td data-label={t('logs.deliveries.result', 'Result')}>
                      <span className={`lg-badge ${r.success ? 'lg-badge-ok' : 'lg-badge-fail'}`}>
                        {r.status_code ?? t('logs.deliveries.noResponse', 'no response')}
                      </span>
                      {!r.success && r.error && <div className="lg-err" title={r.error}>{r.error}</div>}
                    </td>
                    <td data-label={t('logs.deliveries.latency', 'Latency')}>
                      <span className="lg-mono">{r.duration_ms != null ? `${r.duration_ms} ms` : '—'}</span>
                    </td>
                    <td data-label={t('logs.deliveries.attempt', 'Attempt')}>
                      #{r.attempt}
                      {r.parent_id != null && (
                        <span className="lg-resent" title={t('logs.deliveries.resentFrom', 'Resent from #{{id}}', { id: r.parent_id })}>↺</span>
                      )}
                    </td>
                    <td data-label="">
                      <div className="lg-row-actions">
                        <button
                          className="btn lg-btn"
                          onClick={() => resend(r)}
                          disabled={resendingId === r.id || r.truncated}
                          title={r.truncated
                            ? t('logs.deliveries.truncatedHint', 'Request body was truncated when logged — cannot be replayed.')
                            : t('logs.deliveries.resend', 'Resend')}
                        >
                          {resendingId === r.id ? <RefreshCw size={13} className="spinner" /> : <Send size={13} />}
                          {t('logs.deliveries.resend', 'Resend')}
                        </button>
                        <button className="btn btn-icon" onClick={() => toggleRow(r.id)} aria-label="Details">
                          {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                        </button>
                      </div>
                    </td>
                  </tr>,
                  open ? (
                    <tr key={`${r.id}-d`} className="lg-detail-row">
                      <td colSpan={8} data-label="">
                        {detailLoading === r.id ? (
                          <div className="cl-loading"><RefreshCw size={16} className="spinner" /></div>
                        ) : (
                          <div className="lg-detail">
                            <div className="lg-detail-col">
                              <h4>
                                {t('logs.deliveries.request', 'Request')}
                                <CopyButton text={d?.request_body || ''} />
                              </h4>
                              <pre className="lg-json">{prettyOrRaw(d?.request_body)}</pre>
                            </div>
                            <div className="lg-detail-col">
                              <h4>
                                {t('logs.deliveries.response', 'Response')}
                                <CopyButton text={d?.response_body || d?.error || ''} />
                              </h4>
                              <div className="lg-kv">
                                HTTP {d?.status_code ?? '—'} · {d?.duration_ms ?? '—'} ms
                              </div>
                              <pre className="lg-json">{prettyOrRaw(d?.response_body || d?.error)}</pre>
                            </div>
                          </div>
                        )}
                      </td>
                    </tr>
                  ) : null,
                ];
              })}
            </tbody>
          </table>
        )}
      </div>

      {!loading && !error && rows.length > 0 && (
        <div className="cl-pagination">
          <span className="cl-pagination-info">
            {t('logs.deliveries.showingCount', 'Showing {{count}}', { count: rows.length })}
          </span>
          <button
            className="cl-page-btn"
            disabled={pageIndex === 0}
            onClick={() => setStack((s) => s.slice(0, -1))}
          >
            {t('common.prev', 'Previous')}
          </button>
          <span className="cl-page-current">{pageIndex + 1}</span>
          <button
            className="cl-page-btn"
            disabled={!nextCursor}
            onClick={() => setStack((s) => [...s, nextCursor])}
          >
            {t('common.next', 'Next')}
          </button>
        </div>
      )}
    </Page>
  );
}
