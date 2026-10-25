import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  Loader2, Signal, Power, PowerOff, BarChart3, ShieldCheck, Smartphone, Disc, Settings, Pause,
  Search, ChevronRight, Plug, KeyRound, ArrowLeft,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { fetchWithAuth, getUser } from '../auth';
import { api, messageFrom, messageOf, toApiError } from '../lib/api';
import type { AnalyticsSettings, ApiKey } from '../types';
import { AnalyticsSettingsPanel } from './AnalyticsSettingsPanel';
import { ApiKeysPanel } from './ApiKeysPanel';
import { PauseReasonsPanel } from './PauseReasonsPanel';
import { MobileWakePanel, type PushConfig } from './MobileWakePanel';
import { CrmSettings, type CRMConfig } from './CrmConfigForm';
import {
  Alert, Badge, Card, Dropdown, EmptyState, FormRow, FormSection, Page, SearchInput, Toggle, Toolbar,
  matches, prepareQuery,
} from './ui';
import type { CardProps } from './ui';

/** The header of a section's Card (icon, title, one-line description, status
 *  Badge). Settings builds it, because it knows the live status; the section
 *  component renders the Card, because it owns the form and its Save button. */
export type SectionCard = Pick<CardProps, 'icon' | 'title' | 'description' | 'actions'>;

export type SettingsTab =
  | 'integrations' | 'api-keys' | 'qos' | 'analytics' | 'sip-tls' | 'mobile-wake' | 'recording' | 'not-ready-codes';

/* ── Settings Home ─────────────────────────────────────────────────────
   The panel opens on a searchable grid of every section rather than on one
   arbitrary section. `?tab=<id>` opens one section; no `tab` param (or an
   unknown one) is the home grid. The ids are the ones the old tab bar used,
   so existing `/settings?tab=` links keep working.                        */
const SETTINGS_TABS: SettingsTab[] = [
  'integrations', 'api-keys', 'qos', 'analytics', 'sip-tls', 'mobile-wake', 'recording', 'not-ready-codes',
];

type SettingsCategory = 'telephony' | 'recording' | 'access' | 'contact-center' | 'analytics';

const CATEGORIES: { key: SettingsCategory; labelKey: string; fallback: string }[] = [
  { key: 'telephony',      labelKey: 'settings.home.cat.telephony',     fallback: 'Telephony & Network' },
  { key: 'recording',      labelKey: 'settings.home.cat.recording',     fallback: 'Recording & Compliance' },
  { key: 'access',         labelKey: 'settings.home.cat.access',        fallback: 'Integrations & Access' },
  { key: 'contact-center', labelKey: 'settings.home.cat.contactCenter', fallback: 'Contact Center' },
  { key: 'analytics',      labelKey: 'nav.analytics',     fallback: 'Analytics' },
];

/** Static half of a card: its category, icon and copy. The live half (the
 *  status line) is computed at render from loaded state. */
const SECTION_META: {
  tab: SettingsTab;
  cat: SettingsCategory;
  Icon: typeof Signal;
  titleKey: string; titleFallback: string;
  descKey: string; descFallback: string;
  adminOnly?: boolean;
}[] = [
  { tab: 'sip-tls', cat: 'telephony', Icon: ShieldCheck,
    titleKey: 'settings.sipTls.tab', titleFallback: 'SIP TLS',
    descKey: 'settings.home.desc.sipTls', descFallback: 'Encrypted SIP on port 5061 for traditional softphones.' },
  { tab: 'qos', cat: 'telephony', Icon: Signal,
    titleKey: 'settings.qualityOfService', titleFallback: 'Quality of Service',
    descKey: 'settings.home.desc.qos', descFallback: 'Capture call quality metrics into CDR records.' },
  { tab: 'mobile-wake', cat: 'telephony', Icon: Smartphone, adminOnly: true,
    titleKey: 'settings.home.title.mobileWake', titleFallback: 'Mobile Wake',
    descKey: 'settings.home.desc.mobileWake', descFallback: 'Push a wake-up before dialing so mobile apps can re-register.' },
  { tab: 'recording', cat: 'recording', Icon: Disc,
    titleKey: 'settings.home.title.recording', titleFallback: 'Call Recording',
    descKey: 'settings.home.desc.recordingMixMonitor', descFallback: 'Record every call with MixMonitor, in the format you choose.' },
  { tab: 'integrations', cat: 'access', Icon: Plug,
    titleKey: 'settings.crm.title', titleFallback: 'CRM Integration',
    descKey: 'settings.home.desc.crm', descFallback: 'Push call data to your CRM after each call, and look callers up by number.' },
  { tab: 'api-keys', cat: 'access', Icon: KeyRound, adminOnly: true,
    titleKey: 'settings.home.title.apiKeys', titleFallback: 'API Keys',
    descKey: 'settings.home.desc.integrationApiKeys', descFallback: 'Machine-to-machine credentials for the integration API.' },
  { tab: 'not-ready-codes', cat: 'contact-center', Icon: Pause,
    titleKey: 'notReady.title', titleFallback: 'Not-Ready Codes',
    descKey: 'notReady.description', descFallback: 'Pause reasons agents select when going Not-Ready.' },
  { tab: 'analytics', cat: 'analytics', Icon: BarChart3,
    titleKey: 'nav.analytics', titleFallback: 'Analytics',
    descKey: 'settings.home.desc.analytics', descFallback: 'SLA target, FCR window and short-abandon threshold.' },
];

/** A card's live status: the dot tone plus the one-line summary beside it. */
type CardStatus = { tone: 'on' | 'off' | 'unknown'; text: string };

const RECORDING_FORMATS = ['wav', 'wav49', 'gsm', 'g722', 'ulaw', 'alaw', 'sln'];

type Message = { type: 'success' | 'error'; text: string } | null;

export function SettingsPanel() {
  const { t } = useTranslation();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const rawTab = searchParams.get('tab');
  const activeTab: SettingsTab | null =
    rawTab && (SETTINGS_TABS as string[]).includes(rawTab) ? rawTab as SettingsTab : null;
  // Admins and supervisors both reach Settings; the API-key and push-key
  // surfaces are admin-only on the backend, so they are gated here too.
  const isAdmin = getUser()?.role === 'admin';
  const [homeSearch, setHomeSearch] = useState('');

  // ── Home-grid summaries. Each section owns its full data; the home card only
  //    needs a summary, loaded separately. A failed load leaves the card with
  //    no status line rather than a wrong one. ──
  const [crmSummary, setCrmSummary] = useState<Pick<CRMConfig, 'enabled' | 'lookup_enabled' | 'sync_enabled'> | null>(null);
  const [apiKeyCount, setApiKeyCount] = useState<number | null>(null);
  const [pauseCodeCount, setPauseCodeCount] = useState<number | null>(null);
  const [slaDefaultSecs, setSlaDefaultSecs] = useState<number | null>(null);
  const [wakeSummary, setWakeSummary] = useState<PushConfig['mobile_wake'] | null>(null);

  // ── QoS ──
  const [qosEnabled, setQosEnabled] = useState<boolean | null>(null);
  const [qosLoading, setQosLoading] = useState(false);
  const [qosMessage, setQosMessage] = useState<Message>(null);
  // ── SIP TLS ──
  const [sipTlsEnabled, setSipTlsEnabled] = useState<boolean | null>(null);
  const [sipTlsDomain, setSipTlsDomain] = useState('');
  const [sipTlsLoading, setSipTlsLoading] = useState(false);
  const [sipTlsMessage, setSipTlsMessage] = useState<Message>(null);
  // ── Recording ──
  const [recordingEnabled, setRecordingEnabled] = useState<boolean | null>(null);
  const [recordingFormat, setRecordingFormat] = useState('wav');
  const [recordingSavedFormat, setRecordingSavedFormat] = useState('wav');
  const [recordingLoading, setRecordingLoading] = useState(false);
  const [recordingMessage, setRecordingMessage] = useState<Message>(null);

  const loadHomeSummaries = useCallback(() => {
    api<CRMConfig>('/api/crm/config')
      .then(d => setCrmSummary({ enabled: d.enabled, lookup_enabled: d.lookup_enabled, sync_enabled: d.sync_enabled }))
      .catch(() => {});
    if (isAdmin) {
      api<{ api_keys: ApiKey[] }>('/api/api-keys')
        .then(d => setApiKeyCount((d.api_keys || []).filter(k => k.enabled === true || k.enabled === 1).length))
        .catch(() => {});
      api<PushConfig>('/api/push/config').then(d => setWakeSummary(d.mobile_wake)).catch(() => {});
    }
    api<{ reasons: { is_active: number | boolean }[] }>('/api/pause-reasons')
      .then(d => setPauseCodeCount((d.reasons || []).filter(r => r.is_active === true || r.is_active === 1).length))
      .catch(() => {});
    api<AnalyticsSettings>('/api/analytics/settings')
      .then(d => setSlaDefaultSecs(d.sla_default_secs ?? null))
      .catch(() => {});
  }, [isAdmin]);

  const loadQosStatus = useCallback(() => {
    api<{ enabled: boolean }>('/api/qos/status')
      .then(d => setQosEnabled(d.enabled))
      .catch(e => setQosMessage({ type: 'error', text: messageOf(e, t('settings.qos.statusError', 'Could not read QoS status.')) }));
  }, [t]);

  const loadSipTlsStatus = useCallback(() => {
    api<{ enabled: boolean; domain?: string }>('/api/sip-tls/status')
      .then(d => { setSipTlsEnabled(d.enabled); setSipTlsDomain(d.domain || ''); })
      .catch(e => setSipTlsMessage({ type: 'error', text: messageOf(e, t('settings.sipTls.statusError', 'Could not read SIP TLS status.')) }));
  }, [t]);

  const loadRecordingStatus = useCallback(() => {
    api<{ enabled: boolean; format?: string }>('/api/recording/status')
      .then(d => {
        setRecordingEnabled(d.enabled);
        setRecordingFormat(d.format || 'wav');
        setRecordingSavedFormat(d.format || 'wav');
      })
      .catch(e => setRecordingMessage({ type: 'error', text: messageOf(e, t('settings.recording.loadError', 'Could not load the recording policy.')) }));
  }, [t]);

  useEffect(() => {
    loadQosStatus();
    loadSipTlsStatus();
    loadRecordingStatus();
  }, [loadQosStatus, loadSipTlsStatus, loadRecordingStatus]);

  // Read the summaries on mount (a deep link needs them for its Card header)
  // and again each time the home grid comes back into view, so a change made
  // inside a section is reflected on its card.
  const atHome = activeTab === null;
  useEffect(() => {
    loadHomeSummaries();
  }, [atHome, loadHomeSummaries]);

  // ── QoS ──
  const setQos = async (enable: boolean) => {
    setQosLoading(true);
    setQosMessage(null);
    try {
      const response = await fetchWithAuth(enable ? '/api/qos/enable' : '/api/qos/disable', { method: 'POST' });
      const data = await response.json().catch(() => ({}));
      if (response.ok) {
        setQosEnabled(enable);
        setQosMessage({
          type: 'success',
          text: (data as { message?: string }).message || (enable ? t('settings.qos.enable') : t('settings.qos.disable')),
        });
      } else {
        setQosMessage({
          type: 'error',
          text: messageFrom(data, enable ? t('settings.qos.enableError') : t('settings.qos.disableError')),
        });
      }
    } catch (error) {
      console.error('Failed to update QoS:', error);
      setQosMessage({
        type: 'error',
        text: enable ? t('settings.qos.enableConfigError') : t('settings.qos.disableConfigError'),
      });
    } finally {
      setQosLoading(false);
    }
  };

  // ── SIP TLS ──
  const setSipTls = async (enable: boolean) => {
    setSipTlsLoading(true);
    setSipTlsMessage(null);
    try {
      const data = await api<{ message: string }>(enable ? '/api/sip-tls/enable' : '/api/sip-tls/disable', { method: 'POST' });
      setSipTlsEnabled(enable);
      setSipTlsMessage({ type: 'success', text: data.message });
    } catch (e) {
      setSipTlsMessage({ type: 'error', text: toApiError(e).message });
    } finally {
      setSipTlsLoading(false);
    }
  };

  // ── Recording ── enabling (again) is also how the format is changed.
  const setRecording = async (enable: boolean) => {
    setRecordingLoading(true);
    setRecordingMessage(null);
    try {
      const data = enable
        ? await api<{ message: string }>('/api/recording/enable', { method: 'POST', body: { format: recordingFormat } })
        : await api<{ message: string }>('/api/recording/disable', { method: 'POST' });
      setRecordingEnabled(enable);
      if (enable) setRecordingSavedFormat(recordingFormat);
      setRecordingMessage({ type: 'success', text: data.message });
    } catch (e) {
      setRecordingMessage({ type: 'error', text: toApiError(e).message });
    } finally {
      setRecordingLoading(false);
    }
  };

  /* ── Home-grid status lines ────────────────────────────────────────── */
  const on = (text: string): CardStatus => ({ tone: 'on', text });
  const off = (text: string): CardStatus => ({ tone: 'off', text });
  const unknown: CardStatus = { tone: 'unknown', text: '' };
  const enabledLabel = t('common.enabled', 'Enabled');
  const disabledLabel = t('common.disabled', 'Disabled');

  const statusFor = (tab: SettingsTab): CardStatus => {
    switch (tab) {
      case 'sip-tls':
        if (sipTlsEnabled === null) return unknown;
        return sipTlsEnabled
          ? on(sipTlsDomain ? `${enabledLabel} · ${sipTlsDomain}:5061` : `${enabledLabel} · 5061`)
          : off(disabledLabel);
      case 'qos':
        if (qosEnabled === null) return unknown;
        return qosEnabled ? on(enabledLabel) : off(disabledLabel);
      case 'mobile-wake':
        if (!wakeSummary) return unknown;
        return wakeSummary.enabled
          ? on(t('settings.home.status.wakeHold', { defaultValue: '{{n}}s hold', n: wakeSummary.hold_seconds }))
          : off(disabledLabel);
      case 'recording':
        if (recordingEnabled === null) return unknown;
        return recordingEnabled ? on(`${enabledLabel} · ${recordingSavedFormat}`) : off(disabledLabel);
      case 'integrations': {
        if (!crmSummary) return unknown;
        if (!crmSummary.enabled) return off(disabledLabel);
        const parts = [
          crmSummary.sync_enabled !== false ? t('settings.home.status.crmPush', 'Call-data push') : null,
          crmSummary.lookup_enabled ? t('settings.crm.lookupTitle', 'Contact lookup') : null,
        ].filter((p): p is string => !!p);
        return on(parts.length ? parts.join(' · ') : enabledLabel);
      }
      case 'api-keys':
        if (apiKeyCount === null) return unknown;
        return apiKeyCount > 0
          ? on(t('settings.home.status.keys', { defaultValue: 'Active keys: {{n}}', n: apiKeyCount }))
          : off(t('settings.home.status.noKeys', 'No active keys'));
      case 'not-ready-codes':
        if (pauseCodeCount === null) return unknown;
        return pauseCodeCount > 0
          ? on(t('settings.home.status.activeCodes', { defaultValue: 'Active codes: {{n}}', n: pauseCodeCount }))
          : off(t('settings.home.status.noActiveCodes', 'No active codes'));
      case 'analytics':
        return slaDefaultSecs === null
          ? unknown
          : on(t('settings.home.status.sla', { defaultValue: 'SLA target {{n}}s', n: slaDefaultSecs }));
    }
  };

  const homeQuery = prepareQuery(homeSearch);
  // Search spans the title AND the description, so "lookup" finds the CRM
  // card and "5061" finds SIP TLS.
  const visibleSections = SECTION_META
    .filter(s => !s.adminOnly || isAdmin)
    .map(s => ({ ...s, title: t(s.titleKey, s.titleFallback), desc: t(s.descKey, s.descFallback) }))
    .filter(s => !homeQuery || matches(homeQuery, s.title, s.desc));

  const openTab = (tab: SettingsTab) => navigate(`/settings?tab=${tab}`);
  const goHome = () => navigate('/settings');

  const activeMeta = activeTab ? SECTION_META.find(s => s.tab === activeTab) : undefined;

  /* The header every section's Card opens with: icon, title, description and
     the same live status the home card shows. */
  const sectionCard: SectionCard | null = activeMeta ? (() => {
    const status = statusFor(activeMeta.tab);
    return {
      icon: activeMeta.Icon,
      title: t(activeMeta.titleKey, activeMeta.titleFallback),
      description: t(activeMeta.descKey, activeMeta.descFallback),
      actions: status.tone !== 'unknown' && status.text
        ? <Badge tone={status.tone === 'on' ? 'success' : 'neutral'}>{status.text}</Badge>
        : undefined,
    };
  })() : null;

  const adminOnlyCard = sectionCard && (
    <Card {...sectionCard}>
      <Alert tone="error">{t('settings.adminOnly', 'Administrator access required.')}</Alert>
    </Card>
  );

  const busyLine = (
    <div className="rec-inline-status">
      <Loader2 size={14} className="spinner" /> {t('settings.qos.processing')}
    </div>
  );

  return (
    <Page
      icon={Settings}
      className="settings-panel-full"
      // The page stays "Settings"; the open section names itself in its Card
      // header. The way back is the "All settings" button in actions.
      title={t('header.settings', 'Settings')}
      toolbar={!activeTab && (
        <Toolbar
          search={
            <SearchInput
              value={homeSearch}
              onChange={setHomeSearch}
              label={t('settings.home.searchPlaceholder', 'Search settings…')}
              placeholder={t('settings.home.searchPlaceholder', 'Search settings…')}
              // Filters cards already on screen: nothing to debounce, and ?q=
              // would collide with the section's own ?tab= deep link.
              debounceMs={0}
              urlSync={false}
            />
          }
        />
      )}
      actions={activeTab && (
        <button type="button" className="btn btn-ghost" onClick={goHome}>
          <ArrowLeft size={14} className="sh-back-icon" />
          {t('settings.home.allSettings', 'All settings')}
        </button>
      )}
    >
      {/* ── Home: searchable grid of every section, grouped by category ── */}
      {!activeTab && (
        <div className="sh-home">
          {visibleSections.length === 0 ? (
            <EmptyState icon={Search} title={t('settings.home.noMatches', 'No settings match your search.')} />
          ) : CATEGORIES.map(cat => {
            const inCat = visibleSections.filter(s => s.cat === cat.key);
            if (inCat.length === 0) return null;
            return (
              <section key={cat.key} className="sh-cat">
                <h3 className="sh-cat-label">{t(cat.labelKey, cat.fallback)}</h3>
                <div className="sh-grid">
                  {inCat.map(({ tab, Icon, title, desc }) => {
                    const status = statusFor(tab);
                    return (
                      <button key={tab} type="button" className="sh-card" onClick={() => openTab(tab)}>
                        <span className="sh-card-icon"><Icon size={16} /></span>
                        <span className="sh-card-body">
                          <span className="sh-card-title">{title}</span>
                          <span className="sh-card-desc">{desc}</span>
                          {status.tone !== 'unknown' && status.text && (
                            <span className="sh-card-status">
                              <Badge tone={status.tone === 'on' ? 'success' : 'neutral'}>{status.text}</Badge>
                            </span>
                          )}
                        </span>
                        <ChevronRight size={15} className="sh-card-chevron" aria-hidden />
                      </button>
                    );
                  })}
                </div>
              </section>
            );
          })}
        </div>
      )}

      {/* ── Integrations: CRM push + contact lookup ── */}
      {sectionCard && activeTab === 'integrations' && (
        <CrmSettings
          card={sectionCard}
          onLoaded={c => setCrmSummary({ enabled: c.enabled, lookup_enabled: c.lookup_enabled, sync_enabled: c.sync_enabled })}
        />
      )}

      {/* ── API Keys (admin only) ── */}
      {sectionCard && activeTab === 'api-keys' && (
        isAdmin ? <ApiKeysPanel card={sectionCard} onCountChange={setApiKeyCount} /> : adminOnlyCard
      )}

      {/* ── QoS ── applies on toggle */}
      {sectionCard && activeTab === 'qos' && (
        <Card {...sectionCard} bodyClassName="u-col u-gap-3">
          <Toggle
            checked={qosEnabled === true}
            onChange={setQos}
            disabled={qosLoading || qosEnabled === null}
            label={t('settings.qos.title')}
            description={t('settings.qos.description')}
            icon={<Power size={14} />}
            iconOff={<PowerOff size={14} />}
          />
          {qosLoading && busyLine}
          <Alert tone={qosMessage?.type === 'success' ? 'success' : 'error'}>{qosMessage?.text}</Alert>
        </Card>
      )}

      {/* ── SIP TLS ── */}
      {sectionCard && activeTab === 'sip-tls' && (
        <Card {...sectionCard}>
          <FormSection title={t('settings.sipTls.title')} first>
            <Toggle
              checked={sipTlsEnabled === true}
              onChange={setSipTls}
              disabled={sipTlsLoading || sipTlsEnabled === null}
              label={t('settings.sipTls.tab', 'SIP TLS')}
              description={t('settings.sipTls.description')}
              icon={<Power size={14} />}
              iconOff={<PowerOff size={14} />}
            />
            {sipTlsLoading && <div className="u-mt-3">{busyLine}</div>}
            {sipTlsDomain && (
              <p className="u-text-sm u-fg-secondary u-mt-3">
                {t('settings.sipTls.domain')}: <strong className="u-fg u-mono">{sipTlsDomain}</strong>
                {' · '}{t('settings.sipTls.port')}: <strong className="u-fg u-mono">5061</strong>
              </p>
            )}
          </FormSection>
          <Alert tone={sipTlsMessage?.type === 'success' ? 'success' : 'error'} className="u-mt-4">{sipTlsMessage?.text}</Alert>
        </Card>
      )}

      {/* ── Mobile Wake (admin only) ── */}
      {sectionCard && activeTab === 'mobile-wake' && (
        isAdmin ? <MobileWakePanel card={sectionCard} onLoaded={c => setWakeSummary(c.mobile_wake)} /> : adminOnlyCard
      )}

      {/* ── Recording ── the switch installs/removes the recorder; with it on,
           "Apply format" re-applies it with the chosen format. */}
      {sectionCard && activeTab === 'recording' && (
        <Card {...sectionCard} bodyClassName="u-col u-gap-4">
          <Toggle
            checked={recordingEnabled === true}
            onChange={setRecording}
            disabled={recordingLoading || recordingEnabled === null}
            label={t('settings.recording.master', 'Record calls')}
            description={t('settings.recording.masterDescMixMonitor', 'Record every real call (internal, inbound and outbound trunk) with MixMonitor. The mixed file is saved to the default monitor folder and linked to the CDR.')}
            icon={<Power size={14} />}
            iconOff={<PowerOff size={14} />}
          />
          <div>
            <FormSection title={t('settings.recording.format', 'Format')} first>
              <FormRow single>
                <div className="up-form-group">
                  <div className="u-row u-gap-2 u-wrap">
                    <Dropdown
                      size="md"
                      value={recordingFormat}
                      onChange={setRecordingFormat}
                      minWidth={200}
                      ariaLabel={t('settings.recording.formatLabel', 'Recording format')}
                      options={RECORDING_FORMATS.map(f => ({
                        value: f,
                        label: f === 'wav' ? t('settings.recording.formatWav', 'wav (uncompressed)')
                          : f === 'wav49' ? t('settings.recording.formatWav49', 'wav49 (GSM in WAV)')
                          : f === 'g722' ? 'g722 (HD)' : f,
                      }))}
                    />
                    {recordingEnabled && (
                      <button
                        type="button"
                        className="btn"
                        disabled={recordingLoading || recordingFormat === recordingSavedFormat}
                        onClick={() => setRecording(true)}
                      >
                        {recordingLoading ? <Loader2 size={14} className="spinner" /> : <Power size={14} />}
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
          </div>
          {recordingLoading && busyLine}
          <Alert tone={recordingMessage?.type === 'success' ? 'success' : 'error'}>{recordingMessage?.text}</Alert>
        </Card>
      )}

      {/* ── Analytics ── */}
      {sectionCard && activeTab === 'analytics' && (
        <AnalyticsSettingsPanel card={sectionCard} onSaved={s => setSlaDefaultSecs(s.sla_default_secs)} />
      )}

      {/* ── Not-Ready Codes ── */}
      {sectionCard && activeTab === 'not-ready-codes' && (
        <PauseReasonsPanel card={sectionCard} onCountChange={setPauseCodeCount} />
      )}
    </Page>
  );
}
