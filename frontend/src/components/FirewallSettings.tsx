import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Loader2, Save, RefreshCw, Globe, ShieldBan, Pencil, Ban, Undo2, Plus, Download,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { api, toApiError } from '../lib/api';
import {
  Alert, Badge, Card, Dropdown, EmptyState, FormField, FormRow, FormSection, Loading, Modal, Table, Tabs, Toggle, useConfirm,
} from './ui';
import type { Column } from './ui';
import type { SectionCard } from './SettingsPanel';

export interface GeoipStatus {
  enabled: boolean;
  countries: string[];
  trusted: string[];
  tools: { ipset: boolean; iptables: boolean; ip6tables: boolean };
  data: { updated_at: string | null; countries: string[] };
  applied: boolean;
  dropped_packets: number;
  conflicts: string[];
  last_error: string | null;
  client: { ip: string | null; country: string | null; allowed: boolean };
}

interface Jail {
  name: string;
  running: boolean;
  managed: boolean;
  maxretry: number | null;
  findtime: number | null;
  bantime: number | null;
  banned: number;
}

interface BanRow {
  ip: string;
  jail: string;
  banned_at: string | null;
  expires_at: string | null;
  country: string | null;
}

interface Fail2banStatus {
  available: boolean;
  jails: Jail[];
  bans: BanRow[];
}

type FirewallTab = 'geoip' | 'fail2ban';
type Message = { type: 'success' | 'error'; text: string } | null;

/** 🇪🇬 from "EG" (regional indicator symbols). */
function flag(cc: string): string {
  return /^[A-Z]{2}$/.test(cc) ? String.fromCodePoint(...[...cc].map(c => 0x1f1e6 + c.charCodeAt(0) - 65)) : '';
}

/** 600 -> "10m", 3600 -> "1h", 604800 -> "7d"; -1 -> "permanent". */
function duration(secs: number | null, permanent: string): string {
  if (secs === null) return '—';
  if (secs < 0) return permanent;
  for (const [unit, size] of [['d', 86400], ['h', 3600], ['m', 60]] as const) {
    if (secs >= size && secs % size === 0) return `${secs / size}${unit}`;
  }
  return `${secs}s`;
}

export interface FirewallSettingsProps {
  card: SectionCard;
  /** The GeoIP status after every load and save — for the Settings card's status line. */
  onStatus?: (s: GeoipStatus) => void;
}

/**
 * Settings → Firewall: a GeoIP allow-list (every inbound port; LAN and trusted addresses
 * always pass) and fail2ban (bans, manual ban/unban, per-jail thresholds).
 */
export function FirewallSettings({ card, onStatus }: FirewallSettingsProps) {
  const { t, i18n } = useTranslation();
  const [confirm, confirmDialog] = useConfirm();
  const [tab, setTab] = useState<FirewallTab>('geoip');
  const [message, setMessage] = useState<Message>(null);

  const regionNames = useMemo(() => {
    try { return new Intl.DisplayNames([i18n.language, 'en'], { type: 'region' }); } catch { return null; }
  }, [i18n.language]);
  const countryName = useCallback((cc: string | null) => {
    if (!cc) return t('firewall.unknownCountry', 'Unknown');
    let name = cc;
    try { name = regionNames?.of(cc) || cc; } catch { /* not a region code */ }
    return `${flag(cc)} ${name}`.trim();
  }, [regionNames, t]);

  // ── GeoIP ──
  const [geo, setGeo] = useState<GeoipStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [countries, setCountries] = useState<string[]>([]);
  const [trustedText, setTrustedText] = useState('');
  const [saving, setSaving] = useState(false);
  const [updating, setUpdating] = useState(false);

  const onStatusRef = useRef(onStatus);
  useEffect(() => { onStatusRef.current = onStatus; });

  const applyGeo = useCallback((s: GeoipStatus) => {
    setGeo(s);
    setEnabled(s.enabled);
    setCountries(s.countries);
    setTrustedText(s.trusted.join('\n'));
    onStatusRef.current?.(s);
  }, []);

  const loadGeo = useCallback(() => {
    setLoadError(null);
    api<GeoipStatus>('/api/firewall/geoip').then(applyGeo).catch(e => setLoadError(toApiError(e).message));
  }, [applyGeo]);

  useEffect(() => { loadGeo(); }, [loadGeo]);

  const trustedList = trustedText.split(/[\s,;]+/).map(s => s.trim()).filter(Boolean);

  const saveGeo = async () => {
    if (enabled && !geo?.enabled) {
      const ok = await confirm({
        title: t('firewall.geoip.confirmTitle', 'Turn on GeoIP filtering?'),
        message: t('firewall.geoip.confirmBody', {
          defaultValue: 'New connections from outside {{list}} will be dropped on every port, including SIP trunks and phones abroad that are not in the trusted list.',
          list: countries.join(', '),
        }),
        confirmLabel: t('firewall.geoip.turnOn', 'Turn on'),
        cancelLabel: t('common.cancel', 'Cancel'),
      });
      if (!ok) return;
    }
    setSaving(true);
    setMessage(null);
    try {
      applyGeo(await api<GeoipStatus>('/api/firewall/geoip', { method: 'PUT', body: { enabled, countries, trusted: trustedList } }));
      setMessage({ type: 'success', text: t('firewall.saved', 'Saved and applied.') });
    } catch (e) {
      setMessage({ type: 'error', text: toApiError(e).message });
    } finally {
      setSaving(false);
    }
  };

  const updateData = async () => {
    setUpdating(true);
    setMessage(null);
    try {
      const s = await api<GeoipStatus>('/api/firewall/geoip/update', { method: 'POST' });
      // Keep unsaved edits: only the status half is refreshed.
      setGeo(s);
      onStatusRef.current?.(s);
      setMessage({ type: 'success', text: t('firewall.geoip.updated', 'Country data updated.') });
    } catch (e) {
      setMessage({ type: 'error', text: toApiError(e).message });
    } finally {
      setUpdating(false);
    }
  };

  // ── fail2ban ──
  const [f2b, setF2b] = useState<Fail2banStatus | null>(null);
  const [f2bError, setF2bError] = useState<string | null>(null);
  const [f2bBusy, setF2bBusy] = useState(false);
  const [banIp, setBanIp] = useState('');
  const [banJail, setBanJail] = useState('');
  const [editing, setEditing] = useState<Jail | null>(null);
  const [edit, setEdit] = useState({ maxretry: '', findtime: '', bantime: '' });

  const loadF2b = useCallback(() => {
    setF2bError(null);
    setF2bBusy(true);
    api<Fail2banStatus>('/api/firewall/fail2ban')
      .then(setF2b)
      .catch(e => setF2bError(toApiError(e).message))
      .finally(() => setF2bBusy(false));
  }, []);

  useEffect(() => { if (tab === 'fail2ban' && !f2b) loadF2b(); }, [tab, f2b, loadF2b]);

  const runningJails = (f2b?.jails || []).filter(j => j.running);
  const defaultJail = runningJails.some(j => j.name === 'opdesk') ? 'opdesk' : (runningJails[0]?.name ?? '');
  const jailForBan = banJail && runningJails.some(j => j.name === banJail) ? banJail : defaultJail;

  const f2bAction = async (path: string, body: unknown, method: 'POST' | 'PUT' = 'POST', ok?: string) => {
    setF2bBusy(true);
    setMessage(null);
    try {
      setF2b(await api<Fail2banStatus>(path, { method, body }));
      if (ok) setMessage({ type: 'success', text: ok });
      return true;
    } catch (e) {
      setMessage({ type: 'error', text: toApiError(e).message });
      return false;
    } finally {
      setF2bBusy(false);
    }
  };

  const doBan = async () => {
    const ip = banIp.trim();
    if (!ip || !jailForBan) return;
    if (await f2bAction('/api/firewall/fail2ban/ban', { ip, jail: jailForBan }, 'POST',
      t('firewall.f2b.bannedMsg', { defaultValue: '{{ip}} banned in {{jail}}.', ip, jail: jailForBan }))) setBanIp('');
  };

  const doUnban = (b: BanRow) => f2bAction('/api/firewall/fail2ban/unban', { ip: b.ip, jail: b.jail }, 'POST',
    t('firewall.f2b.unbannedMsg', { defaultValue: '{{ip}} unbanned.', ip: b.ip }));

  const toggleJail = async (j: Jail, on: boolean) => {
    if (!on) {
      const ok = await confirm({
        title: t('firewall.f2b.disableTitle', 'Disable this jail?'),
        message: t('firewall.f2b.disableBody', { defaultValue: '{{jail}} stops watching its log and its bans are lifted.', jail: j.name }),
        confirmLabel: t('firewall.f2b.disable', 'Disable'),
        cancelLabel: t('common.cancel', 'Cancel'),
        tone: 'danger',
      });
      if (!ok) return;
    }
    await f2bAction(`/api/firewall/fail2ban/jails/${encodeURIComponent(j.name)}`, { enabled: on }, 'PUT');
  };

  const openEdit = (j: Jail) => {
    setEditing(j);
    setEdit({ maxretry: String(j.maxretry ?? ''), findtime: String(j.findtime ?? ''), bantime: String(j.bantime ?? '') });
  };

  const saveEdit = async () => {
    if (!editing) return;
    const num = (s: string) => (s.trim() === '' ? undefined : Number(s));
    const ok = await f2bAction(`/api/firewall/fail2ban/jails/${encodeURIComponent(editing.name)}`, {
      maxretry: num(edit.maxretry), findtime: num(edit.findtime), bantime: num(edit.bantime),
    }, 'PUT', t('firewall.f2b.jailSaved', { defaultValue: '{{jail}} updated.', jail: editing.name }));
    if (ok) setEditing(null);
  };

  if (loadError) {
    return (
      <Card {...card}>
        <Alert tone="error" action={
          <button type="button" className="btn" onClick={loadGeo}>
            <RefreshCw size={14} /> {t('common.retry', 'Retry')}
          </button>
        }>{loadError}</Alert>
      </Card>
    );
  }
  if (!geo) {
    return (
      <Card {...card}>
        <Loading size="sm" label={t('settings.loading', 'Loading…')} />
      </Card>
    );
  }

  const permanent = t('firewall.f2b.permanent', 'permanent');
  const countryOptions = (geo.data.countries.length ? geo.data.countries : countries)
    .map(cc => ({ value: cc, label: `${countryName(cc)} (${cc})` }))
    .sort((a, b) => a.label.replace(/^\S+ /, '').localeCompare(b.label.replace(/^\S+ /, '')));
  const missingTool = !geo.tools.ipset ? 'ipset' : !geo.tools.iptables ? 'iptables' : null;
  // Would the admin's own address get through the form as it stands now?
  const clientTrusted = !!geo.client.ip && trustedList.includes(geo.client.ip);
  const clientCountryAllowed = !!geo.client.country && countries.includes(geo.client.country);
  const clientPrivate = geo.client.allowed && !geo.client.country;

  const banColumns: Column<BanRow>[] = [
    { key: 'ip', header: t('firewall.f2b.ip', 'IP address'), primary: true, cell: b => <code className="u-mono">{b.ip}</code> },
    { key: 'country', header: t('firewall.country', 'Country'), cell: b => countryName(b.country) },
    { key: 'jail', header: t('firewall.f2b.jail', 'Jail'), cell: b => <Badge>{b.jail}</Badge> },
    { key: 'at', header: t('firewall.f2b.bannedAt', 'Banned'), hideOnMobile: true, cell: b => b.banned_at || '—' },
    { key: 'until', header: t('firewall.f2b.until', 'Until'), cell: b => (b.banned_at ? b.expires_at || permanent : '—') },
    {
      key: 'unban', header: '', label: t('firewall.f2b.unban', 'Unban'), align: 'end',
      cell: b => (
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => doUnban(b)} disabled={f2bBusy}>
          <Undo2 size={14} /> {t('firewall.f2b.unban', 'Unban')}
        </button>
      ),
    },
  ];

  const jailColumns: Column<Jail>[] = [
    {
      key: 'name', header: t('firewall.f2b.jail', 'Jail'), primary: true,
      cell: j => (
        <span className="u-inline-row u-gap-2">
          <code className="u-mono">{j.name}</code>
          {j.name === 'opdesk' && <Badge tone="info">{t('firewall.f2b.opdeskLogins', 'OpDesk logins')}</Badge>}
        </span>
      ),
    },
    { key: 'maxretry', header: t('firewall.f2b.maxretry', 'Max retries'), cell: j => j.maxretry ?? '—' },
    { key: 'findtime', header: t('firewall.f2b.findtime', 'Window'), cell: j => duration(j.findtime, permanent) },
    { key: 'bantime', header: t('firewall.f2b.bantime', 'Ban time'), cell: j => duration(j.bantime, permanent) },
    { key: 'banned', header: t('firewall.f2b.bannedCount', 'Banned'), cell: j => j.banned },
    {
      key: 'enabled', header: t('common.enabled', 'Enabled'),
      cell: j => (
        <Toggle checked={j.running} onChange={on => toggleJail(j, on)} disabled={f2bBusy}
          label={j.running ? t('firewall.f2b.on', 'On') : t('firewall.f2b.off', 'Off')} />
      ),
    },
    {
      key: 'edit', header: '', label: t('firewall.f2b.edit', 'Edit thresholds'), align: 'end',
      cell: j => (
        <button type="button" className="btn btn-ghost btn-sm btn-icon" onClick={() => openEdit(j)} disabled={f2bBusy}
          aria-label={t('firewall.f2b.edit', 'Edit thresholds')} title={t('firewall.f2b.edit', 'Edit thresholds')}>
          <Pencil size={14} />
        </button>
      ),
    },
  ];

  const footer = tab === 'geoip' ? (
    <button type="button" className="btn btn-primary" onClick={saveGeo} disabled={saving || !!missingTool}>
      {saving ? <Loader2 size={14} className="spinner" /> : <Save size={14} />}
      {saving ? t('common.saving', 'Saving…') : t('common.save', 'Save')}
    </button>
  ) : undefined;

  const actions = (
    <>
      {card.actions}
      {tab === 'geoip' ? (
        <button type="button" className="btn btn-ghost" onClick={updateData} disabled={updating}
          title={t('firewall.geoip.updateHint', 'Download the latest country lists now (they refresh weekly on their own)')}>
          {updating ? <Loader2 size={14} className="spinner" /> : <Download size={14} />} {t('firewall.geoip.update', 'Update data')}
        </button>
      ) : (
        <button type="button" className="btn btn-ghost" onClick={loadF2b} disabled={f2bBusy}>
          {f2bBusy ? <Loader2 size={14} className="spinner" /> : <RefreshCw size={14} />} {t('common.refresh', 'Refresh')}
        </button>
      )}
    </>
  );

  return (
    <Card {...card} actions={actions} footer={footer}>
      {confirmDialog}
      <Tabs
        ariaLabel={t('firewall.sections', 'Firewall sections')}
        tabs={[
          { key: 'geoip', label: t('firewall.geoip.tab', 'GeoIP'), icon: <Globe size={14} /> },
          { key: 'fail2ban', label: t('firewall.f2b.tab', 'Fail2ban'), icon: <ShieldBan size={14} />, count: f2b?.bans.length },
        ]}
        active={tab}
        onChange={k => { setTab(k as FirewallTab); setMessage(null); }}
      />

      {tab === 'geoip' && (
        <div id="tabpanel-geoip" role="tabpanel" aria-labelledby="tab-geoip">
          <div className="u-row u-gap-2 u-wrap u-mb-4" role="status" aria-label={t('firewall.geoip.statusLabel', 'GeoIP status')}>
            {geo.enabled
              ? <Badge tone={geo.applied ? 'success' : 'warning'}>
                  {geo.applied ? t('firewall.geoip.active', 'Filtering') : t('firewall.geoip.notApplied', 'On, not applied')}
                </Badge>
              : <Badge>{t('common.disabled', 'Disabled')}</Badge>}
            {geo.enabled && (
              <Badge tone="neutral">
                {t('firewall.geoip.dropped', { defaultValue: 'Dropped packets: {{n}}', n: geo.dropped_packets.toLocaleString() })}
              </Badge>
            )}
            <Badge tone={geo.data.updated_at ? 'neutral' : 'warning'}>
              {geo.data.updated_at
                ? t('firewall.geoip.dataDate', { defaultValue: 'Data: {{date}}', date: new Date(geo.data.updated_at).toLocaleDateString() })
                : t('firewall.geoip.noData', 'No country data yet (downloaded on first save)')}
            </Badge>
            {geo.client.ip && (
              <Badge tone={geo.client.allowed ? 'success' : 'danger'}>
                {t('firewall.geoip.you', { defaultValue: 'You: {{ip}}', ip: geo.client.ip })}
                {geo.client.country ? ` · ${countryName(geo.client.country)}` : ''}
              </Badge>
            )}
          </div>

          {missingTool && (
            <Alert tone="error" className="u-mb-3">
              {t('firewall.geoip.missingTool', { defaultValue: '{{tool}} is not installed on this server; GeoIP filtering cannot be applied.', tool: missingTool })}
            </Alert>
          )}
          {geo.last_error && <Alert tone="error" className="u-mb-3">{geo.last_error}</Alert>}
          {geo.conflicts.length > 0 && (
            <Alert tone="warning" className="u-mb-3">
              {t('firewall.geoip.conflicts', {
                defaultValue: 'Also running: {{list}}. It may reset the rules; OpDesk re-checks them every 5 minutes.',
                list: geo.conflicts.join(', '),
              })}
            </Alert>
          )}

          <FormSection title={t('firewall.geoip.title', 'Country allow-list')} first>
            <p className="u-text-sm u-fg-secondary u-mb-3">
              {t('firewall.geoip.description', 'Only the countries below can open new connections to this server, on every port (SIP, RTP, web, SSH). Replies to connections the server makes, LAN addresses and the trusted list always get through.')}
            </p>
            <Toggle checked={enabled} onChange={setEnabled} disabled={!!missingTool}
              label={t('firewall.geoip.enable', 'Filter by country')} />
            <FormRow single>
              <FormField label={t('firewall.geoip.countries', 'Allowed countries')} htmlFor="fw-countries"
                hint={t('firewall.geoip.countriesHint', 'Everything else is dropped while filtering is on.')}>
                <Dropdown
                  multiple
                  searchable
                  size="md"
                  value={countries}
                  onChange={setCountries}
                  options={countryOptions}
                  placeholder={t('firewall.geoip.pickCountries', 'Pick countries…')}
                  searchPlaceholder={t('firewall.geoip.searchCountries', 'Search countries…')}
                  ariaLabel={t('firewall.geoip.countries', 'Allowed countries')}
                />
              </FormField>
            </FormRow>
            {countries.length > 0 && (
              <div className="u-row u-gap-2 u-wrap u-mt-2">
                {countries.map(cc => <Badge key={cc} tone="info">{countryName(cc)}</Badge>)}
              </div>
            )}
          </FormSection>

          <FormSection title={t('firewall.trusted.title', 'Trusted addresses')}>
            <FormRow single>
              <FormField label={t('firewall.trusted.label', 'IP addresses and networks')} htmlFor="fw-trusted"
                hint={t('firewall.trusted.hint', 'One per line, e.g. 203.0.113.10 or 198.51.100.0/24. Always allowed through GeoIP and never banned by fail2ban. Add SIP trunk providers and remote offices here.')}>
                <textarea id="fw-trusted" className="form-input u-mono" dir="ltr" rows={5} spellCheck={false}
                  value={trustedText} onChange={e => setTrustedText(e.target.value)} />
              </FormField>
            </FormRow>
            {geo.client.ip && !clientPrivate && !clientTrusted && (
              <div className="u-row u-gap-2 u-wrap u-mt-2">
                <button type="button" className="btn btn-sm"
                  onClick={() => setTrustedText(s => (s.trim() ? `${s.trim()}\n${geo.client.ip}` : geo.client.ip!))}>
                  <Plus size={14} /> {t('firewall.trusted.addMine', { defaultValue: 'Add my address ({{ip}})', ip: geo.client.ip })}
                </button>
                {enabled && !clientCountryAllowed && (
                  <span className="u-text-sm u-fg-danger">
                    {t('firewall.trusted.wouldBlock', 'Your own address is not allowed by these settings; saving will be refused.')}
                  </span>
                )}
              </div>
            )}
          </FormSection>
        </div>
      )}

      {tab === 'fail2ban' && (
        <div id="tabpanel-fail2ban" role="tabpanel" aria-labelledby="tab-fail2ban">
          {f2bError && <Alert tone="error" className="u-mb-3">{f2bError}</Alert>}
          {!f2b && !f2bError && <Loading size="sm" label={t('settings.loading', 'Loading…')} />}
          {f2b && !f2b.available && (
            <EmptyState icon={ShieldBan} title={t('firewall.f2b.notRunning', 'fail2ban is not running on this server.')} />
          )}
          {f2b?.available && (
            <>
              <FormSection title={t('firewall.f2b.bans', 'Banned addresses')} first>
                <Table
                  columns={banColumns}
                  rows={f2b.bans}
                  rowKey={b => `${b.jail}:${b.ip}`}
                  density="compact"
                  framed
                  empty={<span className="u-fg-muted u-text-sm">{t('firewall.f2b.noBans', 'Nobody is banned.')}</span>}
                />
                <div className="u-row u-gap-2 u-wrap u-mt-3 u-align-bottom">
                  <FormField label={t('firewall.f2b.banIp', 'Ban an address')} htmlFor="fw-ban-ip">
                    <input id="fw-ban-ip" className="form-input u-mono" dir="ltr" placeholder="203.0.113.7" value={banIp}
                      onChange={e => setBanIp(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') doBan(); }} spellCheck={false} />
                  </FormField>
                  <FormField label={t('firewall.f2b.jail', 'Jail')}>
                    <Dropdown size="md" value={jailForBan} onChange={setBanJail}
                      options={runningJails.map(j => ({ value: j.name, label: j.name }))}
                      ariaLabel={t('firewall.f2b.jail', 'Jail')} />
                  </FormField>
                  <button type="button" className="btn btn-danger" onClick={doBan} disabled={f2bBusy || !banIp.trim() || !jailForBan}>
                    <Ban size={14} /> {t('firewall.f2b.ban', 'Ban')}
                  </button>
                </div>
              </FormSection>

              <FormSection title={t('firewall.f2b.jails', 'Jails')}>
                <p className="u-text-sm u-fg-secondary u-mb-3">
                  {t('firewall.f2b.jailsHint', 'An address that fails "Max retries" times within "Window" is banned on every port for "Ban time". The opdesk jail watches failed OpDesk sign-ins and rejected API keys.')}
                </p>
                <Table columns={jailColumns} rows={f2b.jails} rowKey={j => j.name} density="compact" framed />
              </FormSection>
            </>
          )}
        </div>
      )}

      <Alert tone={message?.type === 'success' ? 'success' : 'error'} className="u-mt-4">{message?.text}</Alert>

      <Modal
        open={!!editing}
        onClose={() => setEditing(null)}
        title={t('firewall.f2b.editTitle', { defaultValue: 'Jail: {{jail}}', jail: editing?.name ?? '' })}
        width="sm"
        footer={
          <>
            <button type="button" className="btn" onClick={() => setEditing(null)}>{t('common.cancel', 'Cancel')}</button>
            <button type="button" className="btn btn-primary" onClick={saveEdit} disabled={f2bBusy}>
              {f2bBusy ? <Loader2 size={14} className="spinner" /> : <Save size={14} />} {t('common.save', 'Save')}
            </button>
          </>
        }
      >
        <FormField label={t('firewall.f2b.maxretry', 'Max retries')} htmlFor="fw-maxretry"
          hint={t('firewall.f2b.maxretryHint', 'Failures before a ban. 1 to 1000.')}>
          <input id="fw-maxretry" type="number" className="form-input" dir="ltr" min={1} max={1000}
            value={edit.maxretry} onChange={e => setEdit(s => ({ ...s, maxretry: e.target.value }))} />
        </FormField>
        <FormField label={t('firewall.f2b.findtimeSecs', 'Window (seconds)')} htmlFor="fw-findtime"
          hint={t('firewall.f2b.findtimeHint', 'Failures are counted over this long. 60 to 2592000 (30 days).')}>
          <input id="fw-findtime" type="number" className="form-input" dir="ltr" min={60}
            value={edit.findtime} onChange={e => setEdit(s => ({ ...s, findtime: e.target.value }))} />
        </FormField>
        <FormField label={t('firewall.f2b.bantimeSecs', 'Ban time (seconds)')} htmlFor="fw-bantime"
          hint={t('firewall.f2b.bantimeHint', '60 to 31536000 (a year), or -1 to ban for good.')}>
          <input id="fw-bantime" type="number" className="form-input" dir="ltr" min={-1}
            value={edit.bantime} onChange={e => setEdit(s => ({ ...s, bantime: e.target.value }))} />
        </FormField>
      </Modal>
    </Card>
  );
}
