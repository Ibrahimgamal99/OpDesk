import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Download, Loader2 } from 'lucide-react';
import type { DateRange } from './analyticsUtils';
import { buildDateParams } from './analyticsUtils';
import { downloadWithAuth } from '../lib/download';
import { messageOf } from '../lib/api';

/** The reports `GET /api/analytics/export/{report}` can write, one per thing a tab shows. */
export type AnalyticsReport = 'overview' | 'queues' | 'agents' | 'heatmap' | 'trend';

interface Props {
  report: AnalyticsReport;
  dateRange: DateRange;
  /** Any filters the tab sends to its JSON route besides the date range. */
  params?: Record<string, string>;
  /** The button's text; "Download CSV" by default. */
  label?: string;
  /** Names what the file holds when one tab offers more than one (the tooltip). */
  title?: string;
}

/**
 * "Download CSV" for one analytics report: the same rows the tab shows, for the same range
 * and filters, as a file. The export route sits behind the Authorization header, so the file
 * is fetched with it and saved from a blob (lib/download.ts) rather than linked to. The
 * server's filename wins; `<report>_<from>_<to>.csv` is only the fallback.
 */
export function AnalyticsExportButton({ report, dateRange, params, label, title }: Props) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const qs = buildDateParams(dateRange.from, dateRange.to);
      for (const [k, v] of Object.entries(params ?? {})) if (v) qs.set(k, v);
      await downloadWithAuth(`/api/analytics/export/${report}?${qs}`,
        `${report}_${dateRange.from}_${dateRange.to}.csv`);
    } catch (e) {
      setError(messageOf(e, t('analytics.export.failed', 'The download failed. Please try again.')));
    } finally {
      setBusy(false);
    }
  };

  const text = label ?? t('analytics.export.csv', 'Download CSV');
  return (
    <span className="an-export">
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        onClick={run}
        disabled={busy}
        aria-busy={busy}
        title={title ?? text}
      >
        {busy ? <Loader2 size={14} className="spinner" /> : <Download size={14} />}
        {busy ? t('common.exporting') : text}
      </button>
      {error && <span role="alert" className="an-export-error">{error}</span>}
    </span>
  );
}
