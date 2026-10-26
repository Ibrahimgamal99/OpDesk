import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FileAudio, History, RefreshCw, Trash2 } from 'lucide-react';
import {
  Alert, EmptyState, Loading, Page, Pagination, SearchInput, Table, Toolbar, useConfirm, type Column,
} from './ui';
import { api, messageOf } from '../lib/api';
import { fmtBytes, fmtTimer } from '../lib/format';
import { PageRange } from './PageRange';
import { AudioPlayer } from './CallLogPanel';
import type { DateRange } from './analyticsUtils';
import '../styles/work.css';

/** One recorded CDR leg, as GET /api/recordings lists it. */
interface RecordingRow {
  calldate: string;
  src: string;
  dst: string;
  duration: number | null;
  billsec: number | null;
  disposition: string | null;
  recordingfile: string;
  uniqueid: string;
  linkedid: string | null;
  /** Where the file is on disk; null when it is gone (deleted, or retention removed it). */
  recording_path: string | null;
  size_bytes: number | null;
}

interface RecordingsPage {
  recordings: RecordingRow[];
  total: number;
  next_cursor: string | null;
}

const PAGE_SIZE = 25;

interface RecordingsPanelProps {
  dateRange: DateRange;
  onDateRangeChange: (r: DateRange) => void;
  /** Call History's Calls/Recordings tab bar, from App. */
  tabs?: React.ReactNode;
}

/**
 * The admin Recordings tab of Call History: every recorded call, newest first, with its player, a
 * download and a delete. Filters (number or Call ID, date range) are applied by the
 * server, which pages with a cursor: `stack` keeps the cursor of each visited page so
 * Previous can go back.
 */
export function RecordingsPanel({ dateRange, onDateRangeChange, tabs }: RecordingsPanelProps) {
  const { t } = useTranslation();
  const [rows, setRows] = useState<RecordingRow[]>([]);
  const [total, setTotal] = useState(0);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // `search` is already the settled term — ui/SearchInput owns the debounce.
  const [search, setSearch] = useState('');
  // A cursor encodes a position within ONE result set, so the stack of visited pages
  // belongs to one set of filters: any change lands on the first page at once (paging on
  // would silently skip or repeat rows).
  const filterKey = JSON.stringify([search.trim(), dateRange]);
  const [pagesAt, setPagesAt] = useState<{ key: string; stack: (string | null)[] }>({ key: filterKey, stack: [null] });
  const stack = pagesAt.key === filterKey ? pagesAt.stack : [null];
  const cursor = stack[stack.length - 1];
  const setStack = (next: (string | null)[]) => setPagesAt({ key: filterKey, stack: next });
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [confirm, confirmDialog] = useConfirm();
  const pageIndex = stack.length - 1;

  const fetchPage = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
      if (cursor) params.set('cursor', cursor);
      if (search.trim()) params.set('search', search.trim());
      params.set('date_from', dateRange.from);
      params.set('date_to', dateRange.to);
      const page = await api<RecordingsPage>(`/api/recordings?${params}`);
      setRows(page.recordings || []);
      setTotal(page.total ?? 0);
      setNextCursor(page.next_cursor ?? null);
      setError(null);
    } catch (e) {
      setError(messageOf(e, t('recordings.loadFailed', 'Could not load the recordings.')));
    } finally {
      setLoading(false);
    }
  }, [cursor, search, dateRange, t]);

  useEffect(() => { fetchPage(); }, [fetchPage]);

  const remove = async (row: RecordingRow) => {
    const ok = await confirm({
      title: t('recordings.deleteTitle', 'Delete this recording?'),
      message: t('recordings.deleteMessage', {
        defaultValue: 'The recording of the call from {{from}} to {{to}} on {{when}} is deleted from the server. The call stays in Call History. This cannot be undone.',
        from: row.src || '—',
        to: row.dst || '—',
        when: new Date(row.calldate).toLocaleString(),
      }),
      confirmLabel: t('common.delete', 'Delete'),
      cancelLabel: t('common.cancel', 'Cancel'),
    });
    if (!ok) return;
    setDeletingId(row.uniqueid);
    setMessage(null);
    try {
      await api(`/api/recordings/${encodeURIComponent(row.uniqueid)}`, { method: 'DELETE' });
      setMessage({ type: 'success', text: t('recordings.deleted', 'Recording deleted.') });
      fetchPage();
    } catch (e) {
      setMessage({ type: 'error', text: messageOf(e, t('common.deleteFailed', 'Delete failed')) });
    } finally {
      setDeletingId(null);
    }
  };

  const columns: Column<RecordingRow>[] = [
    {
      key: 'dateTime', header: t('callLog.table.dateTime'), primary: true,
      cell: row => <span className="u-nowrap">{new Date(row.calldate).toLocaleString()}</span>,
    },
    { key: 'src', header: t('callLog.table.src'), cell: row => <span className="cl-phone">{row.src || '—'}</span> },
    { key: 'dst', header: t('callLog.table.dest'), cell: row => <span className="cl-phone">{row.dst || '—'}</span> },
    {
      // Duration with talk time as its secondary line, as in Call History.
      key: 'duration', header: t('fields.duration'),
      cell: row => (
        <div className="cl-party">
          <span className="u-mono">{fmtTimer(row.duration ?? 0)}</span>
          <span className="cl-secondary">{t('callLog.journey.talkDuration', { duration: fmtTimer(row.billsec ?? 0) })}</span>
        </div>
      ),
    },
    { key: 'size', header: t('recordings.size', 'Size'), cell: row => <span className="u-mono">{fmtBytes(row.size_bytes)}</span> },
    {
      key: 'recording', header: t('callLog.table.recording'),
      cell: row => <AudioPlayer key={row.recording_path ?? row.uniqueid} recordingPath={row.recording_path} recordingFile={row.recordingfile} />,
    },
    {
      key: 'actions', header: t('common.actions'),
      cell: row => (
        <button
          type="button"
          className="btn btn-ghost btn-sm btn-icon"
          onClick={() => remove(row)}
          disabled={deletingId !== null || !row.recording_path}
          aria-busy={deletingId === row.uniqueid}
          title={t('recordings.delete', 'Delete recording')}
          aria-label={t('recordings.delete', 'Delete recording')}
        >
          <Trash2 size={14} />
        </button>
      ),
    },
  ];

  return (
    <Page
      icon={History}
      title={t('nav.callHistory')}
      count={total}
      scope={<PageRange value={dateRange} onChange={onDateRangeChange} />}
      tabs={tabs}
      flush
      toolbar={
        <Toolbar
          search={
            <SearchInput
              value={search}
              onChange={setSearch}
              label={t('recordings.search', 'Search recordings')}
              placeholder={t('recordings.searchPlaceholder', 'Number or Call ID…')}
              loading={loading && Boolean(search)}
            />
          }
        />
      }
    >
      {message && (
        <div className="u-p-3">
          <Alert tone={message.type === 'success' ? 'success' : 'error'} onDismiss={() => setMessage(null)}>{message.text}</Alert>
        </div>
      )}
      {loading ? (
        <Loading label={t('recordings.loading', 'Loading recordings…')} />
      ) : error ? (
        <div className="u-p-3">
          <Alert action={<button type="button" className="btn" onClick={fetchPage}><RefreshCw size={14} />{t('common.retry')}</button>}>
            {error}
          </Alert>
        </div>
      ) : (
        <Table
          columns={columns}
          rows={rows}
          rowKey={row => row.uniqueid}
          caption={t('nav.recordings', 'Recordings')}
          className="cl-log-table"
          empty={
            <EmptyState
              icon={FileAudio}
              title={t('recordings.empty', 'No recordings in this period.')}
              description={search ? t('callLog.emptyFiltered') : t('callLog.emptyRange')}
            />
          }
        />
      )}

      {!loading && !error && rows.length > 0 && (
        <Pagination
          mode="cursor"
          hasPrev={pageIndex > 0}
          hasNext={!!nextCursor}
          onPrev={() => setStack(stack.slice(0, -1))}
          onNext={() => setStack([...stack, nextCursor])}
          info={t('recordings.showing', {
            defaultValue: '{{start}}–{{end}} of {{total}}',
            start: pageIndex * PAGE_SIZE + 1,
            end: pageIndex * PAGE_SIZE + rows.length,
            total,
          })}
        />
      )}
      {confirmDialog}
    </Page>
  );
}
