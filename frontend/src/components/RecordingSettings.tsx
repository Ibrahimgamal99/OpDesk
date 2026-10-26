import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Disc, HardDrive, Loader2, Power, PowerOff, Save, Search, Trash2, Database } from 'lucide-react';
import { api, messageOf, toApiError } from '../lib/api';
import { fmtBytes } from '../lib/format';
import {
  Alert, Card, Dropdown, EmptyState, FormField, FormRow, FormSection, Loading, Pagination, SearchInput, Table, Tabs,
  Toggle, Toolbar, matches, prepareQuery,
} from './ui';
import { StatCard, StatRow } from './FigureCards';
import type { SectionCard } from './SettingsPanel';
import '../styles/settings-extra.css';

/* Call Recording settings: one Card, two inner tabs.
 *
 * - Policy: the master switch and format (everyone who reaches Settings sees them), then, for
 *   admins, the opt-out policy: record by direction and per extension. Recording is opt-out:
 *   every call records unless its direction or the extension is switched off.
 * - Local storage (admin): where Asterisk writes the files, how long they are kept, whether the
 *   per-speaker Voice Activity legs are deleted after analysis, what the disk holds, and a
 *   "Clean up now" that runs the same sweep the daily background job runs.
 *
 * The policy, retention and storage endpoints are admin-only on the backend, so a supervisor
 * sees only the master switch and format, from GET /api/recording/status. */

export const RECORDING_FORMATS = ['wav', 'wav49', 'gsm', 'g722', 'ulaw', 'alaw', 'sln'];

type RecDirection = 'inbound' | 'outbound' | 'internal';
interface ExtRecPolicy { extension: string; name: string; recording: boolean }
interface RecPolicy {
  engine?: string;
  enabled: boolean;
  format: string;
  mixed_dir?: string;
  directions: Record<RecDirection, boolean>;
  extensions: ExtRecPolicy[];
  /** Predial hooks another dialplan file keeps: OpDesk's recorder never runs while any is listed. */
  hook_conflicts?: { context: string; file: string | null }[] | null;
}

interface RetentionConfig {
  local_days: number | null;
  local_max_bytes: number | null;
  vad_delete_legs: boolean;
  root_dir: string;
}

interface StorageStats {
  total_recordings: number;
  local: {
    used_bytes: number;
    max_bytes: number | null;
    disk_free_bytes: number | null;
    disk_total_bytes: number | null;
    retention_days: number | null;
  };
}

const REC_DIRECTIONS: { key: RecDirection; labelKey: string; fallback: string }[] = [
  { key: 'inbound', labelKey: 'settings.recording.inbound', fallback: 'Inbound' },
  { key: 'outbound', labelKey: 'settings.recording.outbound', fallback: 'Outbound' },
  { key: 'internal', labelKey: 'settings.recording.internal', fallback: 'Internal' },
];

const REC_PAGE_SIZE = 20;
const GB = 1024 * 1024 * 1024;

type RecTabKey = 'policy' | 'local';
type Message = { type: 'success' | 'error'; text: string } | null;

export interface RecordingSettingsProps {
  card: SectionCard;
  isAdmin: boolean;
  /** Reports the master state and format, so the home card's status line follows. */
  onStatus?: (enabled: boolean, format: string) => void;
}

export function RecordingSettings({ card, isAdmin, onStatus }: RecordingSettingsProps) {
  const { t } = useTranslation();
  const [recTab, setRecTab] = useState<RecTabKey>('policy');

  // ── Master + policy ──
  const [policy, setPolicy] = useState<RecPolicy | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [format, setFormat] = useState('wav');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<Message>(null);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);

  // ── Local storage ──
  const [localDays, setLocalDays] = useState('');
  const [localMaxGb, setLocalMaxGb] = useState('');
  const [vadDeleteLegs, setVadDeleteLegs] = useState(true);
  // Where the recorder writes. Shown, not edited: the dialplan always records to the PBX's
  // monitor directory, so another directory would only hide every recording from
  // playback and point retention at a tree OpDesk does not write.
  const [recDir, setRecDir] = useState('');
  const [retentionSaving, setRetentionSaving] = useState(false);
  const [cleanupRunning, setCleanupRunning] = useState(false);
  const [stats, setStats] = useState<StorageStats | null>(null);
  const [storageMessage, setStorageMessage] = useState<Message>(null);

  const loadPolicy = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      if (isAdmin) {
        const data = await api<RecPolicy>('/api/recording/policy');
        setPolicy({
          ...data,
          directions: data.directions ?? { inbound: true, outbound: true, internal: true },
          extensions: data.extensions ?? [],
        });
        setFormat(data.format || 'wav');
        onStatus?.(data.enabled, data.format || 'wav');
      } else {
        const data = await api<{ enabled: boolean; format?: string }>('/api/recording/status');
        setPolicy({
          enabled: data.enabled,
          format: data.format || 'wav',
          directions: { inbound: true, outbound: true, internal: true },
          extensions: [],
        });
        setFormat(data.format || 'wav');
      }
    } catch (e) {
      setLoadError(messageOf(e, t('settings.recording.loadError', 'Could not load the recording policy.')));
    } finally {
      setLoading(false);
    }
  // onStatus is a parent callback; reading it fresh each call is fine.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin, t]);

  const loadRetention = useCallback(async () => {
    try {
      const data = await api<RetentionConfig>('/api/recording/retention');
      // 0 and null both mean "off": show a blank field, never a literal 0 that reads as an
      // (alarming) explicit zero-day retention.
      setLocalDays(data.local_days ? String(data.local_days) : '');
      setLocalMaxGb(data.local_max_bytes ? String(Math.round(data.local_max_bytes / GB)) : '');
      setVadDeleteLegs(data.vad_delete_legs !== false);
      setRecDir(data.root_dir || '');
    } catch (e) {
      setStorageMessage({ type: 'error', text: messageOf(e, t('settings.recording.retentionLoadFailed', 'Could not read the retention settings.')) });
    }
  }, [t]);

  const loadStats = useCallback(async () => {
    try {
      setStats(await api<StorageStats>('/api/recording/storage-stats'));
    } catch {
      // The figures are a bonus; the retention controls work without them.
    }
  }, []);

  useEffect(() => { loadPolicy(); }, [loadPolicy]);
  useEffect(() => {
    if (!isAdmin || recTab !== 'local') return;
    loadRetention();
    loadStats();
  }, [isAdmin, recTab, loadRetention, loadStats]);

  // ── Actions ──
  /** Enabling again is also how the format is changed. */
  const setMaster = async (enable: boolean) => {
    setSaving(true);
    setMessage(null);
    try {
      const data = enable
        ? await api<{ message?: string }>('/api/recording/enable', { method: 'POST', body: { format } })
        : await api<{ message?: string }>('/api/recording/disable', { method: 'POST' });
      setPolicy(p => p && ({ ...p, enabled: enable, format: enable ? format : p.format }));
      onStatus?.(enable, enable ? format : (policy?.format || format));
      setMessage({
        type: 'success',
        text: data?.message || (enable
          ? t('settings.recording.enabledMsg', 'Call recording enabled.')
          : t('settings.recording.disabledMsg', 'Call recording disabled.')),
      });
    } catch (e) {
      setMessage({ type: 'error', text: toApiError(e).message });
    } finally {
      setSaving(false);
    }
  };

  const setDirection = async (direction: RecDirection, enabled: boolean) => {
    setSaving(true);
    setMessage(null);
    const before = policy?.directions[direction];
    setPolicy(p => p && ({ ...p, directions: { ...p.directions, [direction]: enabled } }));
    try {
      await api(`/api/recording/direction/${direction}`, { method: 'POST', body: { enabled } });
    } catch (e) {
      setPolicy(p => p && ({ ...p, directions: { ...p.directions, [direction]: before ?? !enabled } }));
      setMessage({
        type: 'error',
        text: messageOf(e, t('settings.recording.directionUpdateFailed', {
          defaultValue: 'Failed to update {{direction}} recording',
          direction: t(`settings.recording.${direction}`, direction),
        })),
      });
    } finally {
      setSaving(false);
    }
  };

  const setExtRecording = async (ext: string, value: boolean) => {
    setMessage(null);
    setPolicy(p => p && ({ ...p, extensions: p.extensions.map(e => e.extension === ext ? { ...e, recording: value } : e) }));
    try {
      await api(`/api/recording/extension/${encodeURIComponent(ext)}`, { method: 'POST', body: { recording: value } });
    } catch (e) {
      setPolicy(p => p && ({ ...p, extensions: p.extensions.map(e => e.extension === ext ? { ...e, recording: !value } : e) }));
      setMessage({
        type: 'error',
        text: messageOf(e, t('settings.recording.extUpdateFailed', { defaultValue: 'Failed to update recording for {{ext}}', ext })),
      });
    }
  };

  /** All extensions when `targets` is omitted, else just those (a search's matches). */
  const bulkSetExtRecording = async (value: boolean, targets?: string[]) => {
    setSaving(true);
    setMessage(null);
    try {
      await api<{ updated?: string[] }>('/api/recording/extensions/bulk', {
        method: 'POST',
        body: { recording: value, ...(targets ? { extensions: targets } : {}) },
      });
      const set = targets ? new Set(targets) : null;
      setPolicy(p => p && ({ ...p, extensions: p.extensions.map(e => (!set || set.has(e.extension)) ? { ...e, recording: value } : e) }));
      const text = targets
        ? (value
          ? t('settings.recording.bulkEnabledCount', { defaultValue: 'Recording on for {{count}} extensions.', count: targets.length })
          : t('settings.recording.bulkDisabledCount', { defaultValue: 'Recording off for {{count}} extensions.', count: targets.length }))
        : (value
          ? t('settings.recording.bulkEnabledAll', 'Recording on for every extension.')
          : t('settings.recording.bulkDisabledAll', 'Recording off for every extension.'));
      setMessage({ type: 'success', text });
    } catch (e) {
      setMessage({ type: 'error', text: messageOf(e, t('settings.recording.bulkFailed', 'Bulk update failed')) });
    } finally {
      setSaving(false);
    }
  };

  const saveRetention = async () => {
    setRetentionSaving(true);
    setStorageMessage(null);
    try {
      await api('/api/recording/retention', {
        method: 'POST',
        body: {
          // Blank = keep forever / no size cap; the server stores 0 for "off".
          local_days: localDays.trim() ? parseInt(localDays, 10) : 0,
          local_max_bytes: localMaxGb.trim() ? Math.round(parseFloat(localMaxGb) * GB) : 0,
          vad_delete_legs: vadDeleteLegs,
        },
      });
      setStorageMessage({ type: 'success', text: t('settings.recording.retentionSaved', 'Retention settings saved.') });
      loadRetention();
      loadStats();
    } catch (e) {
      setStorageMessage({ type: 'error', text: messageOf(e, t('settings.recording.retentionSaveFailed', 'Could not save the retention settings.')) });
    } finally {
      setRetentionSaving(false);
    }
  };

  const runCleanupNow = async () => {
    setCleanupRunning(true);
    setStorageMessage(null);
    try {
      const data = await api<{ local_deleted: number }>('/api/recording/retention/run', { method: 'POST' });
      setStorageMessage({
        type: 'success',
        text: t('settings.recording.cleanupDone', { defaultValue: 'Cleanup done: {{n}} file(s) deleted.', n: data?.local_deleted ?? 0 }),
      });
      loadStats();
    } catch (e) {
      setStorageMessage({ type: 'error', text: messageOf(e, t('settings.recording.cleanupFailed', 'Cleanup failed.')) });
    } finally {
      setCleanupRunning(false);
    }
  };

  // ── Derived: the per-extension table, filtered by the search, then paged ──
  const exts = policy?.extensions ?? [];
  const query = prepareQuery(search);
  const filtered = query ? exts.filter(e => matches(query, e.extension, e.name)) : exts;
  const pageCount = Math.max(1, Math.ceil(filtered.length / REC_PAGE_SIZE));
  const pageClamped = Math.min(page, pageCount - 1);
  const paged = filtered.slice(pageClamped * REC_PAGE_SIZE, (pageClamped + 1) * REC_PAGE_SIZE);
  const onCount = exts.filter(e => e.recording).length;
  // With a search active, bulk applies to the matches only.
  const bulkTargets = query ? filtered.map(e => e.extension) : undefined;

  const showTabs = isAdmin && !!policy?.enabled;
  const onStorageTab = showTabs && recTab === 'local';

  const footer = onStorageTab ? (
    <>
      <button type="button" className="btn" disabled={cleanupRunning} onClick={runCleanupNow}>
        {cleanupRunning ? <Loader2 size={14} className="spinner" /> : <Trash2 size={14} />}
        {t('settings.recording.cleanup', 'Clean up now')}
      </button>
      <button type="button" className="btn btn-primary" disabled={retentionSaving} onClick={saveRetention}>
        {retentionSaving ? <Loader2 size={14} className="spinner" /> : <Save size={14} />}
        {retentionSaving ? t('settings.recording.saving', 'Saving…') : t('settings.recording.saveChanges', 'Save changes')}
      </button>
    </>
  ) : undefined;

  return (
    <Card {...card} footer={footer} bodyClassName="u-col u-gap-4">
      {loading && !policy ? (
        <Loading size="sm" label={t('settings.recording.loading', 'Loading the recording policy…')} />
      ) : !policy ? (
        <Alert tone="error">{loadError || t('settings.recording.loadError', 'Could not load the recording policy.')}</Alert>
      ) : (
        <>
          {showTabs && (
            <Tabs
              ariaLabel={t('settings.recording.sections', 'Call recording sections')}
              tabs={[
                { key: 'policy', label: t('settings.recording.tabPolicy', 'Policy'), icon: <Disc size={14} /> },
                { key: 'local', label: t('settings.recording.tabLocal', 'Local storage'), icon: <HardDrive size={14} /> },
              ]}
              active={recTab}
              onChange={(k) => setRecTab(k as RecTabKey)}
            />
          )}

          {(!onStorageTab) && (
            <div className="rec-tab-panel">
              <Toggle
                checked={policy.enabled}
                onChange={setMaster}
                disabled={saving || !isAdmin}
                label={t('settings.recording.master', 'Record calls')}
                description={t('settings.recording.masterDescMixMonitor', 'Record every real call (internal, inbound and outbound trunk) with MixMonitor. The mixed file is saved to the default monitor folder and linked to the CDR.')}
                icon={<Power size={14} />}
                iconOff={<PowerOff size={14} />}
              />
              {policy.enabled && !!policy.hook_conflicts?.length && (
                <Alert tone="error" className="u-mt-2">
                  {t('settings.recording.hookConflict', {
                    files: [...new Set(policy.hook_conflicts.map(c => c.file).filter(Boolean))].join(', ') || '?',
                    defaultValue: 'Recording is switched on, but OpDesk is not the one recording: {{files}} already defines the PBX predial hooks (another call recorder is installed). The direction and extension switches below have no effect until that recorder is turned off.',
                  })}
                </Alert>
              )}

              <FormSection title={t('settings.recording.format', 'Format')}>
                <FormRow single>
                  <div className="up-form-group">
                    <div className="u-row u-gap-2 u-wrap">
                      <Dropdown
                        size="md"
                        value={format}
                        onChange={setFormat}
                        minWidth={200}
                        ariaLabel={t('settings.recording.formatLabel', 'Recording format')}
                        options={RECORDING_FORMATS.map(f => ({
                          value: f,
                          label: f === 'wav' ? t('settings.recording.formatWav', 'wav (uncompressed)')
                            : f === 'wav49' ? t('settings.recording.formatWav49', 'wav49 (GSM in WAV)')
                            : f === 'g722' ? 'g722 (HD)' : f,
                        }))}
                      />
                      {policy.enabled && isAdmin && (
                        <button
                          type="button"
                          className="btn"
                          disabled={saving || format === policy.format}
                          onClick={() => setMaster(true)}
                        >
                          {saving ? <Loader2 size={14} className="spinner" /> : <Power size={14} />}
                          {t('settings.recording.applyFormat', 'Apply format')}
                        </button>
                      )}
                    </div>
                    <span className="up-hint">
                      {t('settings.recording.formatHint', 'Applies to the mixed file and both single legs. wav is highest quality; wav49/gsm save disk space.')}
                    </span>
                  </div>
                </FormRow>
              </FormSection>

              {isAdmin && policy.enabled && (
                <>
                  <FormSection title={t('settings.recording.byDirection', 'Record by direction')}>
                    <FormRow triple>
                      {REC_DIRECTIONS.map(({ key, labelKey, fallback }) => (
                        <Toggle
                          key={key}
                          checked={policy.directions[key] !== false}
                          onChange={(v) => setDirection(key, v)}
                          disabled={saving}
                          label={t(labelKey, fallback)}
                        />
                      ))}
                    </FormRow>
                  </FormSection>

                  <FormSection title={t('settings.recording.perExtension', { defaultValue: 'Per extension: {{on}} of {{total}} recording', on: onCount, total: exts.length })}>
                    <div className="u-col u-gap-3">
                      <Toolbar
                        search={
                          <SearchInput
                            value={search}
                            onChange={(v) => { setSearch(v); setPage(0); }}
                            label={t('settings.recording.searchExtensions', 'Search extensions')}
                            placeholder={t('settings.recording.searchExtensionsPlaceholder', 'Extension or name…')}
                            debounceMs={0}
                            urlSync={false}
                          />
                        }
                        actions={
                          <>
                            <span className="u-text-sm u-fg-muted">
                              {query
                                ? t('settings.recording.applyToMatches', { defaultValue: 'Apply to matches ({{n}}):', n: filtered.length })
                                : t('settings.recording.applyToAll', 'Apply to all:')}
                            </span>
                            <button type="button" className="btn" disabled={saving || filtered.length === 0} onClick={() => bulkSetExtRecording(true, bulkTargets)}>
                              {t('settings.recording.recordAll', 'Record all')}
                            </button>
                            <button type="button" className="btn" disabled={saving || filtered.length === 0} onClick={() => bulkSetExtRecording(false, bulkTargets)}>
                              {t('settings.recording.recordNone', 'Record none')}
                            </button>
                          </>
                        }
                      />
                      <Table
                        framed
                        caption={t('settings.recording.perExtensionCaption', 'Per-extension recording')}
                        rows={paged}
                        rowKey={e => e.extension}
                        empty={
                          <EmptyState
                            size="sm"
                            icon={exts.length === 0 ? Disc : Search}
                            title={exts.length === 0
                              ? t('settings.recording.noExtensions', 'No extensions')
                              : t('settings.recording.noExtensionMatches', 'No matching extensions')}
                          />
                        }
                        columns={[
                          {
                            key: 'extension', header: t('settings.recording.colExtension', 'Extension'), primary: true,
                            cell: e => (
                              <>
                                <span className="u-mono u-semibold">{e.extension}</span>
                                {e.name && <span className="u-fg-muted u-ms-2">{e.name}</span>}
                              </>
                            ),
                          },
                          {
                            key: 'recording', header: t('settings.recording.colRecording', 'Recording'), align: 'end',
                            cell: e => (
                              <Toggle
                                checked={e.recording}
                                onChange={(v) => setExtRecording(e.extension, v)}
                                disabled={saving}
                                label={e.recording ? t('settings.recording.on', 'On') : t('settings.recording.off', 'Off')}
                              />
                            ),
                          },
                        ]}
                      />
                      {filtered.length > REC_PAGE_SIZE && (
                        <Pagination
                          page={pageClamped + 1}
                          totalPages={pageCount}
                          onPage={(p) => setPage(p - 1)}
                          info={t('settings.recording.pageInfo', {
                            defaultValue: '{{from}}–{{to}} of {{total}}',
                            from: pageClamped * REC_PAGE_SIZE + 1,
                            to: Math.min((pageClamped + 1) * REC_PAGE_SIZE, filtered.length),
                            total: filtered.length,
                          })}
                        />
                      )}
                      <p className="u-text-sm u-fg-muted">
                        {t('settings.recording.perExtensionNote', 'Per extension applies to calls that extension makes (outbound and internal). Inbound external calls follow the Inbound switch above.')}
                      </p>
                    </div>
                  </FormSection>
                </>
              )}
              <Alert tone={message?.type === 'success' ? 'success' : 'error'}>{message?.text}</Alert>
            </div>
          )}

          {onStorageTab && (
            <div className="rec-tab-panel">
              <StatRow>
                <StatCard
                  label={t('settings.recording.storageUsed', 'Storage used')}
                  icon={<HardDrive size={14} />}
                  value={fmtBytes(stats?.local.used_bytes)}
                  desc={localMaxGb ? t('settings.recording.ofGb', { defaultValue: 'of {{n}} GB', n: localMaxGb }) : undefined}
                />
                <StatCard
                  label={t('settings.recording.diskFree', 'Disk free')}
                  icon={<HardDrive size={14} />}
                  iconTone="muted"
                  value={fmtBytes(stats?.local.disk_free_bytes)}
                  desc={stats?.local.disk_total_bytes
                    ? t('settings.recording.ofSize', { defaultValue: 'of {{size}}', size: fmtBytes(stats.local.disk_total_bytes) })
                    : undefined}
                />
                <StatCard
                  label={t('settings.recording.totalRecordings', 'Recorded calls')}
                  icon={<Database size={14} />}
                  iconTone="muted"
                  value={stats ? String(stats.total_recordings ?? 0) : '—'}
                />
              </StatRow>

              <FormSection title={t('settings.recording.location', 'Location')}>
                <FormRow single>
                  <FormField
                    label={t('settings.recording.directory', 'Recordings directory')}
                    htmlFor="rec-root"
                    hint={t('settings.recording.directoryFixedHint')}
                  >
                    <input
                      id="rec-root"
                      aria-label={t('settings.recording.directory', 'Recordings directory')}
                      className="form-input"
                      dir="ltr"
                      value={recDir}
                      readOnly
                    />
                  </FormField>
                </FormRow>
              </FormSection>

              <FormSection title={t('settings.recording.retention', 'Retention')}>
                <FormRow>
                  <FormField
                    label={t('settings.recording.localDays', 'Delete recordings after (days)')}
                    htmlFor="rec-days"
                    hint={t('settings.recording.keepForever', 'Blank = keep forever')}
                  >
                    <input
                      id="rec-days"
                      aria-label={t('settings.recording.localDays', 'Delete recordings after (days)')}
                      className="form-input"
                      type="number"
                      min={0}
                      value={localDays}
                      onChange={e => setLocalDays(e.target.value)}
                      placeholder={t('settings.recording.example', { defaultValue: 'e.g. {{value}}', value: '90' })}
                    />
                  </FormField>
                  <FormField
                    label={t('settings.recording.localMax', 'Max storage (GB)')}
                    htmlFor="rec-max"
                    hint={t('settings.recording.localMaxHint', 'The oldest recordings are deleted first once usage passes this. Blank = no cap.')}
                  >
                    <input
                      id="rec-max"
                      aria-label={t('settings.recording.localMax', 'Max storage (GB)')}
                      className="form-input"
                      type="number"
                      min={0}
                      value={localMaxGb}
                      onChange={e => setLocalMaxGb(e.target.value)}
                      placeholder={t('settings.recording.example', { defaultValue: 'e.g. {{value}}', value: '40' })}
                    />
                  </FormField>
                </FormRow>
              </FormSection>

              <FormSection title={t('settings.recording.vadFiles', 'Voice Activity files')}>
                <Toggle
                  checked={vadDeleteLegs}
                  onChange={setVadDeleteLegs}
                  label={t('settings.recording.vadDelete', 'Delete per-speaker files after analysis')}
                  description={t('settings.recording.vadDeleteDesc', 'The -sp1/-sp2 legs are only needed briefly to compute Voice Activity; on by default.')}
                />
              </FormSection>

              <Alert tone={storageMessage?.type === 'success' ? 'success' : 'error'}>{storageMessage?.text}</Alert>
            </div>
          )}
        </>
      )}
    </Card>
  );
}
