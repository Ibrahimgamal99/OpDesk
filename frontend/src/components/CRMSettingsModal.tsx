import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import {
  X, Save, Loader2, CheckCircle2, AlertCircle, Database, Signal, Power, PowerOff, Settings,
  ChevronDown, ChevronRight, Plug, BarChart3, KeyRound, ShieldCheck, Smartphone,
} from 'lucide-react';
import { FilterSelect } from './FilterSelect';
import { useTranslation } from 'react-i18next';
import { fetchWithAuth } from '../auth';
import { AnalyticsSettingsPanel } from './AnalyticsSettingsPanel';

export type SettingsTab = 'integrations' | 'qos' | 'analytics' | 'sip-tls' | 'mobile-wake';

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

interface CRMSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function CRMSettingsModal({ isOpen, onClose }: CRMSettingsModalProps) {
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

  useEffect(() => {
    if (isOpen) {
      setActiveTab('integrations');
      setAdvancedOpen(false);
      loadConfig();
      loadSipTlsStatus();
      loadMobileWakeStatus();
    }
  }, [isOpen]);

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
        setTimeout(() => { onClose(); }, 1500);
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

  if (!isOpen) return null;

  return (
    <div className="modal-overlay settings-modal" onClick={onClose}>
      <motion.div
        initial={{ opacity: 0, scale: 0.95, y: 20 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.95, y: 20 }}
        transition={{ duration: 0.2 }}
        className="modal"
        style={{ maxHeight: '90vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h3 className="modal-title" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <Settings size={20} style={{ color: 'var(--accent-primary)' }} />
            {t('settings.title')}
          </h3>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close">
            <X size={20} />
          </button>
        </div>

        <div className="settings-tabs">
          <button
            type="button"
            className={`settings-tab ${activeTab === 'integrations' ? 'active' : ''}`}
            onClick={() => setActiveTab('integrations')}
          >
            <Plug size={16} />
            {t('settings.integrations')}
          </button>
          <button
            type="button"
            className={`settings-tab ${activeTab === 'qos' ? 'active' : ''}`}
            onClick={() => setActiveTab('qos')}
          >
            <Signal size={16} />
            {t('settings.qualityOfService')}
          </button>
          <button
            type="button"
            className={`settings-tab ${activeTab === 'analytics' ? 'active' : ''}`}
            onClick={() => setActiveTab('analytics')}
          >
            <BarChart3 size={16} />
            {t('analytics.settings.title')}
          </button>
          <button
            type="button"
            className={`settings-tab ${activeTab === 'sip-tls' ? 'active' : ''}`}
            onClick={() => setActiveTab('sip-tls')}
          >
            <ShieldCheck size={16} />
            {t('settings.sipTls.tab')}
          </button>
          <button
            type="button"
            className={`settings-tab ${activeTab === 'mobile-wake' ? 'active' : ''}`}
            onClick={() => setActiveTab('mobile-wake')}
          >
            <Smartphone size={16} />
            Mobile Wake
          </button>
        </div>

        {activeTab === 'qos' && (
          <div className="settings-body">
            <div className="settings-section">
              <div className="settings-section-header">
                <div className="settings-section-icon">
                  <Signal size={20} />
                </div>
                <div>
                  <div className="settings-section-title">{t('settings.qos.title')}</div>
                  <div className="settings-section-desc">{t('settings.qos.description')}</div>
                </div>
              </div>
              <div className="settings-actions-row">
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={handleQosEnable}
                  disabled={qosLoading}
                  style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, opacity: qosLoading ? 0.6 : 1 }}
                >
                  {qosLoading ? <Loader2 size={14} className="spinner" /> : <Power size={14} />}
                  {qosLoading ? t('settings.qos.processing') : t('settings.qos.enable')}
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={handleQosDisable}
                  disabled={qosLoading}
                  style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, opacity: qosLoading ? 0.6 : 1 }}
                >
                  {qosLoading ? <Loader2 size={14} className="spinner" /> : <PowerOff size={14} />}
                  {qosLoading ? t('settings.qos.processing') : t('settings.qos.disable')}
                </button>
              </div>
              {qosMessage && (
                <div className={`settings-alert ${qosMessage.type === 'success' ? 'success' : 'error'}`}>
                  {qosMessage.type === 'success' ? <CheckCircle2 size={18} /> : <AlertCircle size={18} />}
                  <span>{qosMessage.text}</span>
                </div>
              )}
            </div>
          </div>
        )}

        {activeTab === 'integrations' && (
          loading ? (
            <div className="settings-body" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 48 }}>
              <Loader2 size={28} className="spinner" />
              <p style={{ marginTop: 16, color: 'var(--text-secondary)', fontSize: 14 }}>{t('settings.loading')}</p>
            </div>
          ) : (
            <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
              <div className="settings-body">
                <div className="settings-section">
                  <div className="settings-section-header">
                    <div className="settings-section-icon">
                      <Database size={20} />
                    </div>
                    <div>
                      <div className="settings-section-title">{t('settings.crm.title')}</div>
                      <div className="settings-section-desc">{t('settings.crm.description')}</div>
                    </div>
                  </div>

                  <div className="form-group">
                    <label className="form-label" style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}>
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
                      <div className="form-group">
                        <label className="form-label">{t('settings.crm.serverUrl')}</label>
                        <input
                          type="text"
                          className="form-input"
                          placeholder="https://crm.example.com or http://192.168.1.100:8080"
                          value={config.server_url}
                          onChange={(e) => updateConfig({ server_url: e.target.value })}
                          required
                        />
                      </div>

                      <div className="form-group">
                        <label className="form-label">{t('settings.crm.authType')}</label>
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
                          <div className="form-group">
                            <label className="form-label">{t('settings.crm.apiKey')}</label>
                            <input
                              type="password"
                              className="form-input"
                              placeholder="Your API key"
                              value={config.api_key || ''}
                              onChange={(e) => updateConfig({ api_key: e.target.value })}
                              required
                            />
                          </div>
                          <div className="form-group">
                            <label className="form-label">{t('settings.crm.apiKeyHeader')}</label>
                            <input
                              type="text"
                              className="form-input"
                              placeholder="X-API-Key"
                              value={config.api_key_header || ''}
                              onChange={(e) => updateConfig({ api_key_header: e.target.value })}
                            />
                            <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>{t('settings.crm.defaultApiKeyHeader')}</p>
                          </div>
                        </>
                      )}

                      {config.auth_type === 'basic_auth' && (
                        <>
                          <div className="form-group">
                            <label className="form-label">{t('settings.crm.username')}</label>
                            <input
                              type="text"
                              className="form-input"
                              placeholder="Username"
                              value={config.username || ''}
                              onChange={(e) => updateConfig({ username: e.target.value })}
                              required
                            />
                          </div>
                          <div className="form-group">
                            <label className="form-label">{t('settings.crm.password')}</label>
                            <input
                              type="password"
                              className="form-input"
                              placeholder="Password"
                              value={config.password || ''}
                              onChange={(e) => updateConfig({ password: e.target.value })}
                              required
                            />
                          </div>
                        </>
                      )}

                      {config.auth_type === 'bearer_token' && (
                        <div className="form-group">
                          <label className="form-label">{t('settings.crm.bearerToken')}</label>
                          <input
                            type="password"
                            className="form-input"
                            placeholder="Your bearer token"
                            value={config.bearer_token || ''}
                            onChange={(e) => updateConfig({ bearer_token: e.target.value })}
                            required
                          />
                        </div>
                      )}

                      {config.auth_type === 'oauth2' && (
                        <>
                          <div className="form-group">
                            <label className="form-label">{t('settings.crm.clientId')}</label>
                            <input
                              type="text"
                              className="form-input"
                              placeholder="OAuth2 Client ID"
                              value={config.oauth2_client_id || ''}
                              onChange={(e) => updateConfig({ oauth2_client_id: e.target.value })}
                              required
                            />
                          </div>
                          <div className="form-group">
                            <label className="form-label">{t('settings.crm.clientSecret')}</label>
                            <input
                              type="password"
                              className="form-input"
                              placeholder="OAuth2 Client Secret"
                              value={config.oauth2_client_secret || ''}
                              onChange={(e) => updateConfig({ oauth2_client_secret: e.target.value })}
                              required
                            />
                          </div>
                          <div className="form-group">
                            <label className="form-label">{t('settings.crm.tokenUrl')}</label>
                            <input
                              type="text"
                              className="form-input"
                              placeholder="https://crm.example.com/oauth/token"
                              value={config.oauth2_token_url || ''}
                              onChange={(e) => updateConfig({ oauth2_token_url: e.target.value })}
                            />
                          </div>
                          <div className="form-group">
                            <label className="form-label">{t('settings.crm.scope')}</label>
                            <input
                              type="text"
                              className="form-input"
                              placeholder="read write"
                              value={config.oauth2_scope || ''}
                              onChange={(e) => updateConfig({ oauth2_scope: e.target.value })}
                            />
                          </div>
                        </>
                      )}

                      <button
                        type="button"
                        className="settings-advanced-toggle"
                        onClick={() => setAdvancedOpen((o) => !o)}
                      >
                        {advancedOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                        {t('settings.crm.advancedOptions')}
                      </button>
                      {advancedOpen && (
                        <div className="settings-advanced-body">
                          <div className="form-group">
                            <label className="form-label">{t('settings.crm.endpointPath')}</label>
                            <input
                              type="text"
                              className="form-input"
                              placeholder="/api/calls"
                              value={config.endpoint_path || ''}
                              onChange={(e) => updateConfig({ endpoint_path: e.target.value })}
                            />
                          </div>
                          <div className="form-group">
                            <label className="form-label">{t('settings.crm.timeout')}</label>
                            <input
                              type="number"
                              className="form-input"
                              placeholder="30"
                              value={config.timeout || 30}
                              onChange={(e) => updateConfig({ timeout: parseInt(e.target.value) || 30 })}
                              min={1}
                              max={300}
                            />
                          </div>
                          <div className="form-group">
                            <label className="form-label" style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}>
                              <input
                                type="checkbox"
                                checked={config.verify_ssl !== false}
                                onChange={(e) => updateConfig({ verify_ssl: e.target.checked })}
                                style={{ width: 18, height: 18 }}
                              />
                              {t('settings.crm.verifySSL')}
                            </label>
                          </div>
                        </div>
                      )}

                      {message && (
                        <div className={`settings-alert ${message.type === 'success' ? 'success' : 'error'}`}>
                          {message.type === 'success' ? <CheckCircle2 size={18} /> : <AlertCircle size={18} />}
                          <span>{message.text}</span>
                        </div>
                      )}
                    </>
                  )}
                </div>
              </div>

              <div className="modal-footer">
                <button type="button" className="btn" onClick={onClose} disabled={saving}>
                  {t('settings.cancel')}
                </button>
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
          )
        )}
        {activeTab === 'sip-tls' && (
          <div className="settings-body">
            <div className="settings-section">
              <div className="settings-section-header">
                <div className="settings-section-icon">
                  <ShieldCheck size={20} />
                </div>
                <div>
                  <div className="settings-section-title">{t('settings.sipTls.title')}</div>
                  <div className="settings-section-desc">{t('settings.sipTls.description')}</div>
                </div>
              </div>
              {sipTlsDomain && (
                <div style={{ marginBottom: 12, padding: '8px 12px', background: 'var(--bg-secondary)', borderRadius: 8, fontSize: 13, color: 'var(--text-secondary)' }}>
                  {t('settings.sipTls.domain')}: <strong style={{ color: 'var(--text-primary)' }}>{sipTlsDomain}</strong>
                  {' · '}{t('settings.sipTls.port')}: <strong style={{ color: 'var(--text-primary)' }}>5061</strong>
                  {' · '}{t('settings.sipTls.status')}: <strong style={{ color: sipTlsEnabled ? 'var(--success)' : 'var(--text-secondary)' }}>
                    {sipTlsEnabled ? t('settings.sipTls.statusEnabled') : t('settings.sipTls.statusDisabled')}
                  </strong>
                </div>
              )}
              <div className="settings-actions-row">
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={handleSipTlsEnable}
                  disabled={sipTlsLoading || sipTlsEnabled}
                  style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, opacity: (sipTlsLoading || sipTlsEnabled) ? 0.6 : 1 }}
                >
                  {sipTlsLoading ? <Loader2 size={14} className="spinner" /> : <Power size={14} />}
                  {sipTlsLoading ? t('settings.qos.processing') : t('settings.sipTls.enable')}
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={handleSipTlsDisable}
                  disabled={sipTlsLoading || !sipTlsEnabled}
                  style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, opacity: (sipTlsLoading || !sipTlsEnabled) ? 0.6 : 1 }}
                >
                  {sipTlsLoading ? <Loader2 size={14} className="spinner" /> : <PowerOff size={14} />}
                  {sipTlsLoading ? t('settings.qos.processing') : t('settings.sipTls.disable')}
                </button>
              </div>
              {sipTlsMessage && (
                <div className={`settings-alert ${sipTlsMessage.type === 'success' ? 'success' : 'error'}`}>
                  {sipTlsMessage.type === 'success' ? <CheckCircle2 size={18} /> : <AlertCircle size={18} />}
                  <span>{sipTlsMessage.text}</span>
                </div>
              )}
            </div>
          </div>
        )}
        {activeTab === 'mobile-wake' && (
          <div className="settings-body">
            <div className="settings-section">
              <div className="settings-section-header">
                <div className="settings-section-icon">
                  <Smartphone size={20} />
                </div>
                <div>
                  <div className="settings-section-title">Mobile Wake</div>
                  <div className="settings-section-desc">
                    Send a push notification before dialing so a killed app can re-register with Asterisk before the call rings.
                  </div>
                </div>
              </div>
              <div style={{ marginBottom: 12 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
                  <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>Status:</span>
                  <strong style={{ fontSize: 13, color: mobileWakeEnabled ? 'var(--success)' : 'var(--text-secondary)' }}>
                    {mobileWakeEnabled ? 'Enabled' : 'Disabled'}
                  </strong>
                </div>
              </div>
              <div className="form-group" style={{ marginBottom: 16 }}>
                <label className="form-label">Wake wait time (seconds)</label>
                <input
                  type="number"
                  className="form-input"
                  value={mobileWakeWait}
                  onChange={e => setMobileWakeWait(Math.max(1, Math.min(30, parseInt(e.target.value) || 4)))}
                  min={1}
                  max={30}
                  style={{ width: 100 }}
                />
                <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
                  How long Asterisk waits after sending the push before dialing. Recommended: 3–5s.
                </p>
              </div>
              <div className="settings-actions-row">
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={handleMobileWakeEnable}
                  disabled={mobileWakeLoading}
                  style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, opacity: mobileWakeLoading ? 0.6 : 1 }}
                >
                  {mobileWakeLoading ? <Loader2 size={14} className="spinner" /> : <Power size={14} />}
                  {mobileWakeLoading ? 'Processing...' : mobileWakeEnabled ? 'Update wait time' : 'Enable'}
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={handleMobileWakeDisable}
                  disabled={mobileWakeLoading || !mobileWakeEnabled}
                  style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, opacity: (mobileWakeLoading || !mobileWakeEnabled) ? 0.6 : 1 }}
                >
                  {mobileWakeLoading ? <Loader2 size={14} className="spinner" /> : <PowerOff size={14} />}
                  {mobileWakeLoading ? 'Processing...' : 'Disable'}
                </button>
              </div>
              {mobileWakeMessage && (
                <div className={`settings-alert ${mobileWakeMessage.type === 'success' ? 'success' : 'error'}`}>
                  {mobileWakeMessage.type === 'success' ? <CheckCircle2 size={18} /> : <AlertCircle size={18} />}
                  <span>{mobileWakeMessage.text}</span>
                </div>
              )}
            </div>
          </div>
        )}
        {activeTab === 'analytics' && (
          <div className="settings-body">
            <AnalyticsSettingsPanel />
          </div>
        )}
      </motion.div>
    </div>
  );
}
