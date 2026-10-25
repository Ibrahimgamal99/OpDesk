import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, RefreshCw, Save } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { api, messageOf } from '../lib/api';
import { Alert, Card, Loading, SortableList } from './ui';
import type { SectionCard } from './SettingsPanel';

/** GET/PUT /api/codecs. */
interface CodecsResponse {
  /** The PBX-wide list every extension uses, first = preferred. */
  codecs: string[];
  /** Every codec the list may hold: the current ones in order, then the rest. */
  available: string[];
}

interface CodecRow {
  name: string;
  enabled: boolean;
}

const rowsFrom = (d: CodecsResponse): CodecRow[] =>
  d.available.map(name => ({ name, enabled: d.codecs.includes(name) }));

const enabledOf = (rows: CodecRow[]) => rows.filter(r => r.enabled).map(r => r.name);

export interface CodecSettingsProps {
  /** The section's Card header, from Settings. */
  card: SectionCard;
  /** The saved list after every load and save — for the Settings card's status line. */
  onLoaded?: (codecs: string[]) => void;
}

/**
 * Settings → Audio Codecs: the one codec list every extension uses, in order of
 * preference. The same list FreePBX's Asterisk SIP Settings page edits; Save
 * reloads the PBX, so it is an explicit button rather than applied per click.
 */
export function CodecSettings({ card, onLoaded }: CodecSettingsProps) {
  const { t } = useTranslation();
  const [rows, setRows] = useState<CodecRow[] | null>(null);
  const [saved, setSaved] = useState<string[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  // A ref, so a parent passing an inline callback does not re-run the load every render.
  const onLoadedRef = useRef(onLoaded);
  useEffect(() => { onLoadedRef.current = onLoaded; });

  const apply = (d: CodecsResponse) => {
    setRows(rowsFrom(d));
    setSaved(d.codecs);
    onLoadedRef.current?.(d.codecs);
  };

  const load = useCallback(async () => {
    setLoadError(null);
    setRows(null);
    try {
      apply(await api<CodecsResponse>('/api/codecs'));
    } catch (e) {
      setLoadError(messageOf(e, t('settings.codecs.loadFailed', 'Could not load the codec list.')));
    }
  }, [t]);

  useEffect(() => { load(); }, [load]);

  const save = async () => {
    if (!rows) return;
    setSaving(true);
    setMessage(null);
    try {
      apply(await api<CodecsResponse>('/api/codecs', { method: 'PUT', body: { codecs: enabledOf(rows) } }));
      setMessage({ type: 'success', text: t('settings.codecs.saved', 'Codecs saved and the PBX reloaded.') });
    } catch (e) {
      setMessage({ type: 'error', text: messageOf(e, t('settings.codecs.saveFailed', 'Could not save the codecs.')) });
    } finally {
      setSaving(false);
    }
  };

  if (loadError) {
    return (
      <Card {...card}>
        <Alert tone="error"
          action={<button type="button" className="btn" onClick={load}><RefreshCw size={14} /> {t('common.retry', 'Retry')}</button>}>
          {loadError}
        </Alert>
      </Card>
    );
  }
  if (!rows) {
    return (
      <Card {...card}>
        <Loading size="sm" label={t('settings.codecs.loading', 'Loading codecs…')} />
      </Card>
    );
  }

  const enabled = enabledOf(rows);
  const dirty = enabled.join(',') !== saved.join(',');

  return (
    <Card
      {...card}
      footer={
        <button type="button" className="btn btn-primary" onClick={save} disabled={!dirty || saving}>
          {saving ? <Loader2 size={14} className="spinner" /> : <Save size={14} />}
          {saving ? t('common.saving', 'Saving…') : t('settings.codecs.save', 'Save codecs')}
        </button>
      }
    >
      <p className="u-text-sm u-fg-secondary u-mb-4">{t('settings.codecs.intro')}</p>
      <SortableList
        label={t('settings.codecs.listLabel', 'Codecs')}
        items={rows}
        getKey={r => r.name}
        getLabel={r => r.name}
        onChange={setRows}
        disabled={saving}
        renderItem={r => {
          // The last codec on cannot be unticked: with none, no extension can call.
          const isLast = r.enabled && enabled.length === 1;
          return (
            <label className="u-row u-gap-2 u-pointer">
              <input
                type="checkbox"
                checked={r.enabled}
                disabled={saving || isLast}
                onChange={e => setRows(rows.map(x => (x.name === r.name ? { ...x, enabled: e.target.checked } : x)))}
              />
              <span dir="ltr">{r.name}</span>
            </label>
          );
        }}
      />
      <p className="u-fg-muted u-text-sm u-mt-2">{t('settings.codecs.hint')}</p>
      <Alert tone={message?.type === 'success' ? 'success' : 'error'} className="u-mt-4">{message?.text}</Alert>
    </Card>
  );
}
