import { useState, useEffect } from 'react';
import {
  Save, Loader2, CheckCircle2, AlertCircle, Database, Signal, Power, PowerOff,
  ChevronDown, ChevronRight, Plug, BarChart3, KeyRound, ShieldCheck, Smartphone, Disc,
} from 'lucide-react';
import { FilterSelect } from './FilterSelect';
import { useTranslation } from 'react-i18next';
import { fetchWithAuth } from '../auth';
import { AnalyticsSettingsPanel } from './AnalyticsSettingsPanel';

export type SettingsTab = 'integrations' | 'qos' | 'analytics' | 'sip-tls' | 'mobile-wake' | 'recording';

export interface CRMConfig {
  enabled: boolean;
  server_url: string;
  auth_type: 'api_key' | 'basic_auth' | 'bearer_token' | 'oauth2';
  api_key?: string;
  api_key_header?: string;
  username?: string;
  password?: string;
  bearer_token?: string;
  oauth2_client_id?: string;
  oauth2_client_secret?: string;
  oauth2_token_url?: string;
  oauth2_scope?: string;
  endpoint_path?: string;
  timeout?: number;
  verify_ssl?: boolean;
}

export function SettingsPanel() {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState<SettingsTab>('integrations');
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [config, setConfig] = useState<CRMConfig>({
    enabled: false,
    server_url: '',
    auth_type: 'api_key',
    endpoint_path: '/api/calls',
    timeout: 30,
    verify_ssl: true,
  });
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [qosLoading, setQosLoading] = useState(false);
  const [qosMessage, setQosMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [sipTlsEnabled, setSipTlsEnabled] = useState(false);
  const [sipTlsDomain, setSipTlsDomain] = useState('');
  const [sipTlsLoading, setSipTlsLoading] = useState(false);
  const [sipTlsMessage, setSipTlsMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [mobileWakeEnabled, setMobileWakeEnabled] = useState(false);
  const [mobileWakeWait, setMobileWakeWait] = useState(3);
  const [mobileWakeLoading, setMobileWakeLoading] = useState(false);
  const [mobileWakeMessage, setMobileWakeMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [recordingEnabled, setRecordingEnabled] = useState(false);
  const [recordingFormat, setRecordingFormat] = useState('wav');
  const [recordingLoading, setRecordingLoading] = useState(false);
  const [recordingMessage, setRecordingMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  useEffect(() => {
    loadConfig();
    loadSipTlsStatus();
    loadMobileWakeStatus();
    loadRecordingStatus();
  }, []);

  const loadConfig = async () => {
    setLoading(true);
    setMessage(null);
    try {
      const response = await fetchWithAuth('/api/crm/config');
      if (response.ok) {
        const data = await response.json();
        setConfig(data);
      } else {
        setConfig({
          enabled: false,
          server_url: '',
          auth_type: 'api_key',
          endpoint_path: '/api/calls',
          timeout: 30,
          verify_ssl: true,
        });
      }
    } catch (error) {
      console.error('Failed to load CRM config:', error);
      setMessage({ type: 'error', text: t('settings.crm.loadError') });
    } finally {
      setLoading(false);
    }
  };

  const saveConfig = async () => {
    setSaving(true);
    setMessage(null);
    try {
      const response = await fetchWithAuth('/api/crm/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      });
      if (response.ok) {
        setMessage({ type: 'success', text: t('settings.crm.savedSuccess') });
        setTimeout(() => setMessage(null), 3000);
      } else {
        const error = await response.json();
        setMessage({ type: 'error', text: error.detail || t('settings.crm.saveError') });
      }
    } catch (error) {
      console.error('Failed to save CRM config:', error);
      setMessage({ type: 'error', text: t('settings.crm.saveError') });
    } finally {
      setSaving(false);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    saveConfig();
  };

  const updateConfig = (updates: Partial<CRMConfig>) => {
    setConfig(prev => ({ ...prev, ...updates }));
  };

  const handleQosEnable = async () => {
    setQosLoading(true);
    setQosMessage(null);
    try {
      const response = await fetchWithAuth('/api/qos/enable', { method: 'POST' });
      if (response.ok) {
        const data = await response.json();
        setQosMessage({ type: 'success', text: data.message || t('settings.qos.enable') });
      } else {
        const error = await response.json();
        setQosMessage({ type: 'error', text: error.detail || t('settings.qos.enableError') });
      }
    } catch (error) {
      console.error('Failed to enable QoS:', error);
      setQosMessage({ type: 'error', text: t('settings.qos.enableConfigError') });
    } finally {
      setQosLoading(false);
    }
  };

  const handleQosDisable = async () => {
    setQosLoading(true);
    setQosMessage(null);
    try {
      const response = await fetchWithAuth('/api/qos/disable', { method: 'POST' });
      if (response.ok) {
        const data = await response.json();
        setQosMessage({ type: 'success', text: data.message || t('settings.qos.disable') });
      } else {
        const error = await response.json();
        setQosMessage({ type: 'error', text: error.detail || t('settings.qos.disableError') });
      }
    } catch (error) {
      console.error('Failed to disable QoS:', error);
      setQosMessage({ type: 'error', text: t('settings.qos.disableConfigError') });
    } finally {
      setQosLoading(false);
    }
  };

  const loadSipTlsStatus = async () => {
    try {
      const res = await fetchWithAuth('/api/sip-tls/status');
      if (res.ok) {
        const data = await res.json();
        setSipTlsEnabled(data.enabled);
        setSipTlsDomain(data.domain || '');
      }
    } catch {}
  };

  const handleSipTlsEnable = async () => {
    setSipTlsLoading(true);
    setSipTlsMessage(null);
    try {
      const res = await fetchWithAuth('/api/sip-tls/enable', { method: 'POST' });
      if (res.ok) {
        const data = await res.json();
        setSipTlsEnabled(true);
        setSipTlsMessage({ type: 'success', text: data.message });
      } else {
        const err = await res.json();
        setSipTlsMessage({ type: 'error', text: err.detail || t('settings.sipTls.enableError') });
      }
    } catch {
      setSipTlsMessage({ type: 'error', text: t('settings.sipTls.enableError') });
    } finally {
      setSipTlsLoading(false);
    }
  };

  const handleSipTlsDisable = async () => {
    setSipTlsLoading(true);
    setSipTlsMessage(null);
    try {
      const res = await fetchWithAuth('/api/sip-tls/disable', { method: 'POST' });
      if (res.ok) {
        const data = await res.json();
        setSipTlsEnabled(false);
        setSipTlsMessage({ type: 'success', text: data.message });
      } else {
        const err = await res.json();
        setSipTlsMessage({ type: 'error', text: err.detail || t('settings.sipTls.disableError') });
      }
    } catch {
      setSipTlsMessage({ type: 'error', text: t('settings.sipTls.disableError') });
    } finally {
      setSipTlsLoading(false);
    }
  };

  const loadMobileWakeStatus = async () => {
    try {
      const res = await fetchWithAuth('/api/mobile-wake/status');
      if (res.ok) {
        const data = await res.json();
        setMobileWakeEnabled(data.enabled);
        setMobileWakeWait(data.wait_seconds ?? 4);
      }
    } catch {}
  };

  const handleMobileWakeEnable = async () => {
    setMobileWakeLoading(true);
    setMobileWakeMessage(null);
    try {
      const res = await fetchWithAuth('/api/mobile-wake/enable', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wait_seconds: mobileWakeWait }),
      });
      if (res.ok) {
        const data = await res.json();
        setMobileWakeEnabled(true);
        setMobileWakeMessage({ type: 'success', text: data.message });
      } else {
        const err = await res.json();
        setMobileWakeMessage({ type: 'error', text: err.detail || 'Failed to enable mobile wake' });
      }
    } catch {
      setMobileWakeMessage({ type: 'error', text: 'Failed to enable mobile wake' });
    } finally {
      setMobileWakeLoading(false);
    }
  };

  const handleMobileWakeDisable = async () => {
    setMobileWakeLoading(true);
    setMobileWakeMessage(null);
    try {
      const res = await fetchWithAuth('/api/mobile-wake/disable', { method: 'POST' });
      if (res.ok) {
        const data = await res.json();
        setMobileWakeEnabled(false);
        setMobileWakeMessage({ type: 'success', text: data.message });
      } else {
        const err = await res.json();
        setMobileWakeMessage({ type: 'error', text: err.detail || 'Failed to disable mobile wake' });
      }
    } catch {
      setMobileWakeMessage({ type: 'error', text: 'Failed to disable mobile wake' });
    } finally {
      setMobileWakeLoading(false);
    }
  };

  const loadRecordingStatus = async () => {
    try {
      const res = await fetchWithAuth('/api/recording/status');
      if (res.ok) {
        const data = await res.json();
        setRecordingEnabled(data.enabled);
        setRecordingFormat(data.format || 'wav');
      }
    } catch {}
  };

  const handleRecordingEnable = async () => {
    setRecordingLoading(true);
    setRecordingMessage(null);
    try {
      const res = await fetchWithAuth('/api/recording/enable', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ format: recordingFormat }),
      });
      if (res.ok) {
        const data = await res.json();
        setRecordingEnabled(true);
        setRecordingMessage({ type: 'success', text: data.message });
      } else {
        const err = await res.json();
        setRecordingMessage({ type: 'error', text: err.detail || 'Failed to enable call recording' });
      }
    } catch {
      setRecordingMessage({ type: 'error', text: 'Failed to enable call recording' });
    } finally {
      setRecordingLoading(false);
    }
  };

  const handleRecordingDisable = async () => {
    setRecordingLoading(true);
    setRecordingMessage(null);
    try {
      const res = await fetchWithAuth('/api/recording/disable', { method: 'POST' });
      if (res.ok) {
        const data = await res.json();
        setRecordingEnabled(false);
        setRecordingMessage({ type: 'success', text: data.message });
      } else {
        const err = await res.json();
        setRecordingMessage({ type: 'error', text: err.detail || 'Failed to disable call recording' });
      }
    } catch {
      setRecordingMessage({ type: 'error', text: 'Failed to disable call recording' });
    } finally {
      setRecordingLoading(false);
    }
  };

  return (
    <div className="panel">
      <div className="panel-content up-root">

        <div className="up-tabs">
          <button type="button" className={`up-tab ${activeTab === 'integrations' ? 'active' : ''}`} onClick={() => setActiveTab('integrations')}>
            <Plug size={18} />
            {t('settings.integrations')}
          </button>
          <button type="button" className={`up-tab ${activeTab === 'qos' ? 'active' : ''}`} onClick={() => setActiveTab('qos')}>
            <Signal size={18} />
            {t('settings.qualityOfService')}
          </button>
          <button type="button" className={`up-tab ${activeTab === 'analytics' ? 'active' : ''}`} onClick={() => setActiveTab('analytics')}>
            <BarChart3 size={18} />
            {t('analytics.settings.title')}
          </button>
          <button type="button" className={`up-tab ${activeTab === 'sip-tls' ? 'active' : ''}`} onClick={() => setActiveTab('sip-tls')}>
            <ShieldCheck size={18} />
            {t('settings.sipTls.tab')}
          </button>
          <button type="button" className={`up-tab ${activeTab === 'mobile-wake' ? 'active' : ''}`} onClick={() => setActiveTab('mobile-wake')}>
            <Smartphone size={18} />
            Mobile Wake
          </button>
          <button type="button" className={`up-tab ${activeTab === 'recording' ? 'active' : ''}`} onClick={() => setActiveTab('recording')}>
            <Disc size={18} />
            Recording
          </button>
        </div>

        {/* ── Integrations Tab ── */}
        {activeTab === 'integrations' && (
          loading ? (
            <div className="up-add-card" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 64 }}>
              <Loader2 size={32} className="spinner" />
              <p style={{ marginTop: 20, color: 'var(--text-secondary)', fontSize: 14 }}>{t('settings.loading')}</p>
            </div>
          ) : (
            <div className="up-add-card">
              <div className="up-add-header">
                <div className="up-add-icon"><Database size={24} /></div>
                <div>
                  <h2 className="up-add-title">{t('settings.crm.title')}</h2>
                  <p className="up-add-desc">{t('settings.crm.description')}</p>
                </div>
              </div>
              <form onSubmit={handleSubmit} className="up-add-body">
                {message && (
                  <div className={`up-alert ${message.type === 'success' ? 'success' : 'error'}`}>
                    {message.type === 'success' ? <CheckCircle2 size={20} /> : <AlertCircle size={20} />}
                    <span>{message.text}</span>
                  </div>
                )}
                <div className="up-form-group">
                  <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={config.enabled}
                      onChange={(e) => updateConfig({ enabled: e.target.checked })}
                      style={{ width: 18, height: 18 }}
                    />
                    {t('settings.crm.enable')}
                  </label>
                  <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4, marginInlineStart: 28 }}>
                    {t('settings.crm.enableDesc')}
                  </p>
                </div>

                {config.enabled && (
                  <>
                    <div className="up-form-group">
                      <label>{t('settings.crm.serverUrl')}</label>
                      <input
                        type="text"
                        className="form-input"
                        placeholder="https://crm.example.com or http://192.168.1.100:8080"
                        value={config.server_url}
                        onChange={(e) => updateConfig({ server_url: e.target.value })}
                        required
                      />
                    </div>

                    <div className="up-form-group">
                      <label>{t('settings.crm.authType')}</label>
                      <FilterSelect
                        size="md"
                        value={config.auth_type}
                        onChange={v => updateConfig({ auth_type: v as CRMConfig['auth_type'] })}
                        icon={KeyRound}
                        options={[
                          { value: 'api_key',       label: 'API Key',       dot: 'blue'    },
                          { value: 'basic_auth',    label: 'Basic Auth',    dot: 'neutral' },
                          { value: 'bearer_token',  label: 'Bearer Token',  dot: 'green'   },
                          { value: 'oauth2',        label: 'OAuth2',        dot: 'orange'  },
                        ]}
                      />
                    </div>

                    {config.auth_type === 'api_key' && (
                      <>
                        <div className="up-form-group">
                          <label>{t('settings.crm.apiKey')}</label>
                          <input type="password" className="form-input" placeholder="Your API key" value={config.api_key || ''} onChange={(e) => updateConfig({ api_key: e.target.value })} required />
                        </div>
                        <div className="up-form-group">
                          <label>{t('settings.crm.apiKeyHeader')}</label>
                          <input type="text" className="form-input" placeholder="X-API-Key" value={config.api_key_header || ''} onChange={(e) => updateConfig({ api_key_header: e.target.value })} />
                          <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>{t('settings.crm.defaultApiKeyHeader')}</p>
                        </div>
                      </>
                    )}

                    {config.auth_type === 'basic_auth' && (
                      <>
                        <div className="up-form-group">
                          <label>{t('settings.crm.username')}</label>
                          <input type="text" className="form-input" placeholder="Username" value={config.username || ''} onChange={(e) => updateConfig({ username: e.target.value })} required />
                        </div>
                        <div className="up-form-group">
                          <label>{t('settings.crm.password')}</label>
                          <input type="password" className="form-input" placeholder="Password" value={config.password || ''} onChange={(e) => updateConfig({ password: e.target.value })} required />
                        </div>
                      </>
                    )}

                    {config.auth_type === 'bearer_token' && (
                      <div className="up-form-group">
                        <label>{t('settings.crm.bearerToken')}</label>
                        <input type="password" className="form-input" placeholder="Your bearer token" value={config.bearer_token || ''} onChange={(e) => updateConfig({ bearer_token: e.target.value })} required />
                      </div>
                    )}

                    {config.auth_type === 'oauth2' && (
                      <>
                        <div className="up-form-group">
                          <label>{t('settings.crm.clientId')}</label>
                          <input type="text" className="form-input" placeholder="OAuth2 Client ID" value={config.oauth2_client_id || ''} onChange={(e) => updateConfig({ oauth2_client_id: e.target.value })} required />
                        </div>
                        <div className="up-form-group">
                          <label>{t('settings.crm.clientSecret')}</label>
                          <input type="password" className="form-input" placeholder="OAuth2 Client Secret" value={config.oauth2_client_secret || ''} onChange={(e) => updateConfig({ oauth2_client_secret: e.target.value })} required />
                        </div>
                        <div className="up-form-group">
                          <label>{t('settings.crm.tokenUrl')}</label>
                          <input type="text" className="form-input" placeholder="https://crm.example.com/oauth/token" value={config.oauth2_token_url || ''} onChange={(e) => updateConfig({ oauth2_token_url: e.target.value })} />
                        </div>
                        <div className="up-form-group">
                          <label>{t('settings.crm.scope')}</label>
                          <input type="text" className="form-input" placeholder="read write" value={config.oauth2_scope || ''} onChange={(e) => updateConfig({ oauth2_scope: e.target.value })} />
                        </div>
                      </>
                    )}

                    <button type="button" className="settings-advanced-toggle" onClick={() => setAdvancedOpen((o) => !o)}>
                      {advancedOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                      {t('settings.crm.advancedOptions')}
                    </button>
                    {advancedOpen && (
                      <div className="settings-advanced-body">
                        <div className="up-form-group">
                          <label>{t('settings.crm.endpointPath')}</label>
                          <input type="text" className="form-input" placeholder="/api/calls" value={config.endpoint_path || ''} onChange={(e) => updateConfig({ endpoint_path: e.target.value })} />
                        </div>
                        <div className="up-form-group">
                          <label>{t('settings.crm.timeout')}</label>
                          <input type="number" className="form-input" placeholder="30" value={config.timeout || 30} onChange={(e) => updateConfig({ timeout: parseInt(e.target.value) || 30 })} min={1} max={300} />
                        </div>
                        <div className="up-form-group">
                          <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}>
                            <input type="checkbox" checked={config.verify_ssl !== false} onChange={(e) => updateConfig({ verify_ssl: e.target.checked })} style={{ width: 18, height: 18 }} />
                            {t('settings.crm.verifySSL')}
                          </label>
                        </div>
                      </div>
                    )}
                  </>
                )}

                <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 24 }}>
                  <button
                    type="submit"
                    className="btn btn-primary"
                    disabled={saving || (config.enabled && !config.server_url)}
                    style={{ opacity: (saving || (config.enabled && !config.server_url)) ? 0.5 : 1, display: 'flex', alignItems: 'center', gap: 8 }}
                  >
                    {saving ? <Loader2 size={14} className="spinner" /> : <Save size={14} />}
                    {saving ? t('settings.saving') : t('settings.save')}
                  </button>
                </div>
              </form>
            </div>
          )
        )}

        {/* ── QoS Tab ── */}
        {activeTab === 'qos' && (
          <div className="up-add-card">
            <div className="up-add-header">
              <div className="up-add-icon"><Signal size={24} /></div>
              <div>
                <h2 className="up-add-title">{t('settings.qos.title')}</h2>
                <p className="up-add-desc">{t('settings.qos.description')}</p>
              </div>
            </div>
            <div className="up-add-body">
              <div style={{ display: 'flex', gap: 12 }}>
                <button type="button" className="btn btn-primary" onClick={handleQosEnable} disabled={qosLoading} style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, opacity: qosLoading ? 0.6 : 1 }}>
                  {qosLoading ? <Loader2 size={14} className="spinner" /> : <Power size={14} />}
                  {qosLoading ? t('settings.qos.processing') : t('settings.qos.enable')}
                </button>
                <button type="button" className="btn" onClick={handleQosDisable} disabled={qosLoading} style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, opacity: qosLoading ? 0.6 : 1 }}>
                  {qosLoading ? <Loader2 size={14} className="spinner" /> : <PowerOff size={14} />}
                  {qosLoading ? t('settings.qos.processing') : t('settings.qos.disable')}
                </button>
              </div>
              {qosMessage && (
                <div className={`up-alert ${qosMessage.type === 'success' ? 'success' : 'error'}`} style={{ marginTop: 16 }}>
                  {qosMessage.type === 'success' ? <CheckCircle2 size={20} /> : <AlertCircle size={20} />}
                  <span>{qosMessage.text}</span>
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── SIP TLS Tab ── */}
        {activeTab === 'sip-tls' && (
          <div className="up-add-card">
            <div className="up-add-header">
              <div className="up-add-icon"><ShieldCheck size={24} /></div>
              <div>
                <h2 className="up-add-title">{t('settings.sipTls.title')}</h2>
                <p className="up-add-desc">{t('settings.sipTls.description')}</p>
              </div>
            </div>
            <div className="up-add-body">
              {sipTlsDomain && (
                <div style={{ marginBottom: 16, padding: '8px 12px', background: 'var(--bg-secondary)', borderRadius: 8, fontSize: 13, color: 'var(--text-secondary)' }}>
                  {t('settings.sipTls.domain')}: <strong style={{ color: 'var(--text-primary)' }}>{sipTlsDomain}</strong>
                  {' · '}{t('settings.sipTls.port')}: <strong style={{ color: 'var(--text-primary)' }}>5061</strong>
                  {' · '}{t('settings.sipTls.status')}: <strong style={{ color: sipTlsEnabled ? 'var(--success)' : 'var(--text-secondary)' }}>
                    {sipTlsEnabled ? t('settings.sipTls.statusEnabled') : t('settings.sipTls.statusDisabled')}
                  </strong>
                </div>
              )}
              <div style={{ display: 'flex', gap: 12 }}>
                <button type="button" className="btn btn-primary" onClick={handleSipTlsEnable} disabled={sipTlsLoading || sipTlsEnabled} style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, opacity: (sipTlsLoading || sipTlsEnabled) ? 0.6 : 1 }}>
                  {sipTlsLoading ? <Loader2 size={14} className="spinner" /> : <Power size={14} />}
                  {sipTlsLoading ? t('settings.qos.processing') : t('settings.sipTls.enable')}
                </button>
                <button type="button" className="btn" onClick={handleSipTlsDisable} disabled={sipTlsLoading || !sipTlsEnabled} style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, opacity: (sipTlsLoading || !sipTlsEnabled) ? 0.6 : 1 }}>
                  {sipTlsLoading ? <Loader2 size={14} className="spinner" /> : <PowerOff size={14} />}
                  {sipTlsLoading ? t('settings.qos.processing') : t('settings.sipTls.disable')}
                </button>
              </div>
              {sipTlsMessage && (
                <div className={`up-alert ${sipTlsMessage.type === 'success' ? 'success' : 'error'}`} style={{ marginTop: 16 }}>
                  {sipTlsMessage.type === 'success' ? <CheckCircle2 size={20} /> : <AlertCircle size={20} />}
                  <span>{sipTlsMessage.text}</span>
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── Mobile Wake Tab ── */}
        {activeTab === 'mobile-wake' && (
          <div className="up-add-card">
            <div className="up-add-header">
              <div className="up-add-icon"><Smartphone size={24} /></div>
              <div>
                <h2 className="up-add-title">Mobile Wake</h2>
                <p className="up-add-desc">Send a push notification before dialing so a killed app can re-register with Asterisk before the call rings.</p>
              </div>
            </div>
            <div className="up-add-body">
              <div style={{ marginBottom: 16, display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>Status:</span>
                <strong style={{ fontSize: 13, color: mobileWakeEnabled ? 'var(--success)' : 'var(--text-secondary)' }}>
                  {mobileWakeEnabled ? 'Enabled' : 'Disabled'}
                </strong>
              </div>
              <div className="up-form-group" style={{ marginBottom: 16 }}>
                <label>Wake wait time (seconds)</label>
                <input
                  type="number"
                  className="form-input"
                  value={mobileWakeWait}
                  onChange={e => setMobileWakeWait(Math.max(1, Math.min(30, parseInt(e.target.value) || 4)))}
                  min={1}
                  max={30}
                  style={{ width: 120 }}
                />
                <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
                  How long Asterisk waits after sending the push before dialing. Recommended: 3–5s.
                </p>
              </div>
              <div style={{ display: 'flex', gap: 12 }}>
                <button type="button" className="btn btn-primary" onClick={handleMobileWakeEnable} disabled={mobileWakeLoading} style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, opacity: mobileWakeLoading ? 0.6 : 1 }}>
                  {mobileWakeLoading ? <Loader2 size={14} className="spinner" /> : <Power size={14} />}
                  {mobileWakeLoading ? 'Processing...' : mobileWakeEnabled ? 'Update wait time' : 'Enable'}
                </button>
                <button type="button" className="btn" onClick={handleMobileWakeDisable} disabled={mobileWakeLoading || !mobileWakeEnabled} style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, opacity: (mobileWakeLoading || !mobileWakeEnabled) ? 0.6 : 1 }}>
                  {mobileWakeLoading ? <Loader2 size={14} className="spinner" /> : <PowerOff size={14} />}
                  {mobileWakeLoading ? 'Processing...' : 'Disable'}
                </button>
              </div>
              {mobileWakeMessage && (
                <div className={`up-alert ${mobileWakeMessage.type === 'success' ? 'success' : 'error'}`} style={{ marginTop: 16 }}>
                  {mobileWakeMessage.type === 'success' ? <CheckCircle2 size={20} /> : <AlertCircle size={20} />}
                  <span>{mobileWakeMessage.text}</span>
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── Recording Tab ── */}
        {activeTab === 'recording' && (
          <div className="up-add-card">
            <div className="up-add-header">
              <div className="up-add-icon"><Disc size={24} /></div>
              <div>
                <h2 className="up-add-title">Call Recording</h2>
                <p className="up-add-desc">Record every real call (internal, inbound and outbound trunk) with MixMonitor. The mixed file is saved to the default monitor folder and linked to the CDR.</p>
              </div>
            </div>
            <div className="up-add-body">
              <div style={{ marginBottom: 16, display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>Status:</span>
                <strong style={{ fontSize: 13, color: recordingEnabled ? 'var(--success)' : 'var(--text-secondary)' }}>
                  {recordingEnabled ? 'Enabled' : 'Disabled'}
                </strong>
              </div>
              <div className="up-form-group" style={{ marginBottom: 16 }}>
                <label>Recording format</label>
                <select className="form-input" value={recordingFormat} onChange={e => setRecordingFormat(e.target.value)} style={{ width: 200 }}>
                  <option value="wav">wav (uncompressed)</option>
                  <option value="wav49">wav49 (GSM in WAV)</option>
                  <option value="gsm">gsm</option>
                  <option value="g722">g722 (HD)</option>
                  <option value="ulaw">ulaw</option>
                  <option value="alaw">alaw</option>
                  <option value="sln">sln</option>
                </select>
                <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
                  Applies to the mixed file and both single legs. wav is highest quality; wav49/gsm save disk space.
                </p>
              </div>
              <div style={{ display: 'flex', gap: 12 }}>
                <button type="button" className="btn btn-primary" onClick={handleRecordingEnable} disabled={recordingLoading} style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, opacity: recordingLoading ? 0.6 : 1 }}>
                  {recordingLoading ? <Loader2 size={14} className="spinner" /> : <Power size={14} />}
                  {recordingLoading ? 'Processing...' : recordingEnabled ? 'Update format' : 'Enable'}
                </button>
                <button type="button" className="btn" onClick={handleRecordingDisable} disabled={recordingLoading || !recordingEnabled} style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, opacity: (recordingLoading || !recordingEnabled) ? 0.6 : 1 }}>
                  {recordingLoading ? <Loader2 size={14} className="spinner" /> : <PowerOff size={14} />}
                  {recordingLoading ? 'Processing...' : 'Disable'}
                </button>
              </div>
              {recordingMessage && (
                <div className={`up-alert ${recordingMessage.type === 'success' ? 'success' : 'error'}`} style={{ marginTop: 16 }}>
                  {recordingMessage.type === 'success' ? <CheckCircle2 size={20} /> : <AlertCircle size={20} />}
                  <span>{recordingMessage.text}</span>
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── Analytics Tab ── */}
        {activeTab === 'analytics' && (
          <div className="up-add-card">
            <div className="up-add-header">
              <div className="up-add-icon"><BarChart3 size={24} /></div>
              <div>
                <h2 className="up-add-title">{t('analytics.settings.title')}</h2>
                <p className="up-add-desc">{t('analytics.settings.description', 'Configure analytics data sources and retention.')}</p>
              </div>
            </div>
            <div className="up-add-body">
              <AnalyticsSettingsPanel />
            </div>
          </div>
        )}

      </div>
    </div>
  );
}

export { SettingsPanel as CRMSettingsModal };
