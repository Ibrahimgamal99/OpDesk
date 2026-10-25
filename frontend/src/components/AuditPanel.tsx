import { useCallback, useEffect, useRef, useState } from 'react';
import type React from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, RefreshCw, ScrollText, Tag, Boxes, ChevronDown } from 'lucide-react';
import { fetchWithAuth } from '../auth';
import { messageOf, raiseFor } from '../lib/api';
import type { AuditLogEntry } from '../types';
import { presentOptions, showFilter } from '../lib/filters';
import { PageRange } from './PageRange';
import { quickRanges, type DateRange } from './analyticsUtils';
import {
  Alert, Badge, Dropdown, EmptyState, Loading, Page, SearchInput, Table, Toolbar, type BadgeTone, type Column,
} from './ui';
import '../styles/settings-extra.css';

/* The audit log: every change made through the API (create, update, delete, apply), who made it,
 * from where, and when. The Audit log tab of Logs (admin only, like the rest of Logs).
 *
 * GET /api/audit-log takes action / entity_type / actor / from / to filters, pages with a cursor
 * (`next_cursor`), and with ?facets=1 counts each action and entity type under the other
 * filters, so the dropdowns offer only what occurs. Both the bare `{entries, facets,
 * next_cursor}` shape and the `{data, page: {next_cursor}}` envelope are read. */

const PAGE_SIZE = 50;

/** The actions the backend records today; the facets can add others. */
const ACTIONS = ['create', 'update', 'delete', 'apply', 'login', 'logout'];

type Facets = { action?: Record<string, number>; entity_type?: Record<string, number> };

interface AuditResponse {
  entries?: AuditLogEntry[];
  data?: AuditLogEntry[];
  facets?: Facets | null;
  next_cursor?: string | null;
  page?: { next_cursor?: string | null };
}

/** An audit detail as readable text: pretty JSON, or the stored text as it is. */
function detailText(detail: unknown): string {
  if (typeof detail === 'string') return detail;
  try {
    return JSON.stringify(detail, null, 2);
  } catch {
    return String(detail);
  }
}

function fmtTime(s?: string | null): string {
  if (!s) return '—';
  const d = new Date(s);
  return isNaN(d.getTime()) ? s : d.toLocaleString();
}

export function AuditPanel({ tabStrip }: { tabStrip: React.ReactNode }) {
  const { t } = useTranslation();
  const [rows, setRows] = useState<AuditLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [facets, setFacets] = useState<Facets | null>(null);

  const [action, setAction] = useState('');
  const [entityType, setEntityType] = useState('');
  const [actor, setActor] = useState('');
  const [range, setRange] = useState<DateRange>(() => quickRanges()['30d']);

  // Only the newest request may paint: a slow, older filter must not replace the current one.
  const seqRef = useRef(0);

  const actionLabel = useCallback(
    (a: string) => t(`audit.actions.${a}`, { defaultValue: a }),
    [t]);

  const fetchPage = useCallback(async (cursor: string | null): Promise<AuditResponse> => {
    const params = new URLSearchParams({ limit: String(PAGE_SIZE), facets: '1' });
    if (action) params.set('action', action);
    if (entityType) params.set('entity_type', entityType);
    if (actor.trim()) params.set('actor', actor.trim());
    if (range.from) params.set('from', range.from);
    if (range.to) params.set('to', range.to);
    if (cursor) params.set('cursor', cursor);
    const res = await fetchWithAuth(`/api/audit-log?${params.toString()}`);
    if (!res.ok) await raiseFor(res);
    return res.json();
  }, [action, entityType, actor, range]);

  const load = useCallback(async () => {
    const seq = ++seqRef.current;
    setLoading(true);
    setError(null);
    try {
      const data = await fetchPage(null);
      if (seq !== seqRef.current) return;
      setRows(data.entries ?? data.data ?? []);
      setNextCursor(data.next_cursor ?? data.page?.next_cursor ?? null);
      setFacets(data.facets ?? null);
    } catch (e) {
      if (seq !== seqRef.current) return;
      setRows([]);
      setNextCursor(null);
      setFacets(null);
      setError(messageOf(e, t('audit.loadError', 'Could not load the audit log.')));
    } finally {
      if (seq === seqRef.current) setLoading(false);
    }
  }, [fetchPage, t]);

  useEffect(() => { load(); }, [load]);

  const loadMore = async () => {
    if (!nextCursor) return;
    const seq = seqRef.current;
    setLoadingMore(true);
    try {
      const data = await fetchPage(nextCursor);
      if (seq !== seqRef.current) return;
      setRows(prev => [...prev, ...(data.entries ?? data.data ?? [])]);
      setNextCursor(data.next_cursor ?? data.page?.next_cursor ?? null);
    } catch (e) {
      setError(messageOf(e, t('audit.loadError', 'Could not load the audit log.')));
    } finally {
      setLoadingMore(false);
    }
  };

  // The dropdowns offer what occurs under the other filters, each with its count, and keep the
  // picked value. Without facets (an error, an older server) every known action is offered.
  const allActions = [...new Set([...ACTIONS, ...Object.keys(facets?.action ?? {})])]
    .map(a => ({ value: a, label: actionLabel(a) }));
  const actionOptions = facets?.action ? presentOptions(allActions, facets.action, action) : allActions;
  const entityValues = [...new Set([...Object.keys(facets?.entity_type ?? {}), ...(entityType ? [entityType] : [])])].sort();
  const entityOptions = facets?.entity_type
    ? presentOptions(entityValues.map(e => ({ value: e, label: e })), facets.entity_type, entityType)
    : entityValues.map(e => ({ value: e, label: e }));

  const actionBadge = (a: string) => {
    // An action is a category, so it reads as info; only the two with a clear verdict
    // (something added, something removed) take a semantic tone.
    const tone: BadgeTone = a === 'delete' ? 'danger' : a === 'create' ? 'success' : 'info';
    return <Badge tone={tone}>{actionLabel(a)}</Badge>;
  };

  const columns: Column<AuditLogEntry>[] = [
    {
      key: 'time', header: t('audit.time', 'Time'), className: 'u-nowrap u-mono u-text-xs',
      cell: r => fmtTime(r.created_at),
    },
    {
      key: 'actor', header: t('audit.actor', 'Who'), primary: true, className: 'u-text-sm',
      cell: r => {
        const who = r.actor || (r.actor_user_id != null ? `#${r.actor_user_id}` : '');
        if (!who && !r.actor_ext) return <span className="u-fg-muted">—</span>;
        return (
          <span className="audit-actor">
            <span>{who || r.actor_ext}</span>
            {who && r.actor_ext && <span className="u-fg-muted u-mono"> · {r.actor_ext}</span>}
          </span>
        );
      },
    },
    { key: 'action', header: t('audit.action', 'Action'), cell: r => actionBadge(r.action) },
    {
      key: 'entity', header: t('audit.entity', 'What'), className: 'u-text-sm u-mono',
      cell: r => (
        <bdi>
          {r.entity_type}
          {r.entity_id ? <span className="u-fg-muted"> #{r.entity_id}</span> : null}
        </bdi>
      ),
    },
    {
      key: 'summary', header: t('audit.summary', 'Details'), className: 'u-text-xs u-fg-muted u-mono audit-summary',
      cell: r => (
        <>
          <bdi>{r.summary || '—'}</bdi>
          {r.detail !== null && r.detail !== undefined && (
            <details className="audit-detail">
              <summary>{t('audit.showDetail', 'What changed')}</summary>
              <pre dir="ltr">{detailText(r.detail)}</pre>
            </details>
          )}
        </>
      ),
    },
    {
      key: 'ip', header: t('audit.ip', 'IP'), hideOnMobile: true, className: 'u-text-xs u-fg-muted u-mono',
      cell: r => <bdi>{r.ip || '—'}</bdi>,
    },
  ];

  const anyFilter = Boolean(action || entityType || actor.trim());

  return (
    <Page
      icon={ScrollText}
      title={t('nav.logs', 'Logs')}
      scope={<PageRange value={range} onChange={setRange} />}
      tabs={tabStrip}
      flush
      toolbar={
        <Toolbar
          search={
            <SearchInput
              value={actor}
              onChange={setActor}
              label={t('audit.actorSearch', 'Search by user')}
              placeholder={t('audit.actorPlaceholder', 'User name or extension…')}
              urlSync={false}
            />
          }
          filters={
            <>
              {showFilter(actionOptions, action) && (
                <div data-active={action || undefined}>
                  <Dropdown
                    size="md"
                    value={action}
                    onChange={setAction}
                    ariaLabel={t('audit.action', 'Action')}
                    icon={Tag}
                    options={[{ value: '', label: t('audit.allActions', 'All actions') }, ...actionOptions]}
                  />
                </div>
              )}
              {entityOptions.length > 0 && (
                <div data-active={entityType || undefined}>
                  <Dropdown
                    size="md"
                    value={entityType}
                    onChange={setEntityType}
                    ariaLabel={t('audit.entityType', 'Entity type')}
                    icon={Boxes}
                    options={[{ value: '', label: t('audit.allEntities', 'Everything') }, ...entityOptions]}
                  />
                </div>
              )}
            </>
          }
          actions={
            <button type="button" className="btn btn-ghost" onClick={load} disabled={loading}>
              {loading ? <Loader2 size={14} className="spinner" /> : <RefreshCw size={14} />}
              {t('common.refresh', 'Refresh')}
            </button>
          }
        />
      }
    >
      {error && <div className="u-p-3"><Alert>{error}</Alert></div>}

      {loading ? (
        <Loading label={t('audit.loading', 'Loading the audit log…')} />
      ) : (
        <Table
          columns={columns}
          rows={rows}
          rowKey={r => r.id}
          caption={t('audit.caption', 'Audit log')}
          empty={
            <EmptyState
              icon={ScrollText}
              title={t('audit.emptyTitle', 'No audit entries')}
              description={anyFilter
                ? t('audit.emptyDesc', 'Nothing matches the current filters.')
                : t('audit.emptyRange', 'Nothing was changed in this period.')}
            />
          }
        />
      )}

      {!loading && nextCursor && (
        <div className="audit-more">
          <button type="button" className="btn" onClick={loadMore} disabled={loadingMore}>
            {loadingMore ? <Loader2 size={14} className="spinner" /> : <ChevronDown size={14} />}
            {t('audit.loadMore', 'Load more')}
          </button>
        </div>
      )}
    </Page>
  );
}
