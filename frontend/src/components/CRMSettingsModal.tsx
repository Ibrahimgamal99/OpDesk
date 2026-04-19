import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import {
  X, Save, Loader2, CheckCircle2, AlertCircle, Database, Signal, Power, PowerOff, Settings,
  ChevronDown, ChevronRight, Plug, Server, BarChart3, KeyRound,
} from 'lucide-react';
import { FilterSelect } from './FilterSelect';
import { useTranslation } from 'react-i18next';
import { getAuthHeaders } from '../auth';
import { AnalyticsSettingsPanel } from './AnalyticsSettingsPanel';

export type SettingsTab = 'integrations' | 'qos' | 'webrtc' | 'analytics';

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
  const [webrtcPbxServer, setWebrtcPbxServer] = useState('');
  const [webrtcLoading, setWebrtcLoading] = useState(false);
  const [webrtcSaving, setWebrtcSaving] = useState(false);
  const [webrtcMessage, setWebrtcMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  useEffect(() => {
    if (isOpen) {
      setActiveTab('integrations');
      setAdvancedOpen(false);
      loadConfig();
    }
  }, [isOpen]);

  useEffect(() => {
    if (isOpen && activeTab === 'webrtc') {
      loadWebrtcSettings();
    }
  }, [isOpen, activeTab]);

  const loadWebrtcSettings = async () => {
    setWebrtcLoading(true);
    setWebrtcMessage(null);
    try {
      const response = await fetch('/api/settings', { headers: getAuthHeaders() });
      if (response.ok) {
        const data = await response.json();
        setWebrtcPbxServer(data.settings?.WEBRTC_PBX_SERVER ?? '');
      }
    } catch (error) {
      console.error('Failed to load WebRTC settings:', error);
      setWebrtcMessage({ type: 'error', text: t('settings.webrtcSettings.loadError') });
    } finally {
      setWebrtcLoading(false);
    }
  };

  const saveWebrtcSettings = async () => {
    setWebrtcSaving(true);
    setWebrtcMessage(null);
    try {
      const response = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
        body: JSON.stringify({ WEBRTC_PBX_SERVER: webrtcPbxServer.trim() }),
      });
      const data = await response.json();
      if (response.ok && data.success) {
        setWebrtcMessage({ type: 'success', text: t('settings.webrtcSettings.savedSuccess') });
      } else {
        setWebrtcMessage({ type: 'error', text: data.detail || t('settings.webrtcSettings.saveError') });
      }
    } catch (error) {
      console.error('Failed to save WebRTC settings:', error);
      setWebrtcMessage({ type: 'error', text: t('settings.webrtcSettings.saveError') });
    } finally {
      setWebrtcSaving(false);
    }
  };

  const loadConfig = async () => {
    setLoading(true);
    setMessage(null);
    try {
      const response = await fetch('/api/crm/config', { headers: getAuthHeaders() });
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
      const response = await fetch('/api/crm/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
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
      const response = await fetch('/api/qos/enable', { method: 'POST', headers: getAuthHeaders() });
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
      const response = await fetch('/api/qos/disable', { method: 'POST', headers: getAuthHeaders() });
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
            className={`settings-tab ${activeTab === 'webrtc' ? 'active' : ''}`}
            onClick={() => setActiveTab('webrtc')}
          >
            <Server size={16} />
            {t('settings.webrtc')}
          </button>
          <button
            type="button"
            className={`settings-tab ${activeTab === 'analytics' ? 'active' : ''}`}
            onClick={() => setActiveTab('analytics')}
          >
            <BarChart3 size={16} />
            {t('analytics.settings.title')}
          </button>
        </div>

        {activeTab === 'webrtc' && (
          <div className="settings-body">
            {webrtcLoading ? (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 48 }}>
                <Loader2 size={28} className="spinner" />
                <p style={{ marginTop: 16, color: 'var(--text-secondary)', fontSize: 14 }}>{t('settings.webrtcSettings.loading')}</p>
              </div>
            ) : (
              <div className="settings-section">
                <div className="settings-section-header">
                  <div className="settings-section-icon">
                    <Server size={20} />
                  </div>
                  <div>
                    <div className="settings-section-title">{t('settings.webrtcSettings.title')}</div>
                    <div className="settings-section-desc">{t('settings.webrtcSettings.description')}</div>
                  </div>
                </div>
                {webrtcPbxServer.trim().startsWith('wss://') && (() => {
                  const s = webrtcPbxServer.trim().replace(/^wss:\/\//, '').split('/')[0];
                  const httpsUrl = s ? `https://${s}` : '';
                  return httpsUrl ? (
                    <p className="settings-hint" style={{ marginBottom: 12, fontSize: 13, color: 'var(--text-secondary)' }}>
                      Using self-signed cert? In <strong>Firefox</strong>, open{' '}
                      <a href={httpsUrl} target="_blank" rel="noopener noreferrer" style={{ textDecoration: 'underline' }}>
                        {httpsUrl}
                      </a>{' '}
                      in a new tab and accept the certificate, then try the softphone again.
                    </p>
                  ) : null;
                })()}
                <div className="form-group">
                  <label className="form-label">{t('settings.webrtcSettings.websocketUrl')}</label>
                  <input
                    type="text"
                    className="form-input"
                    placeholder={t('settings.webrtcSettings.placeholder')}
                    value={webrtcPbxServer}
                    onChange={(e) => setWebrtcPbxServer(e.target.value)}
                  />
                </div>
                {webrtcMessage && (
                  <div className={`settings-alert ${webrtcMessage.type === 'success' ? 'success' : 'error'}`}>
                    {webrtcMessage.type === 'success' ? <CheckCircle2 size={18} /> : <AlertCircle size={18} />}
                    <span>{webrtcMessage.text}</span>
                  </div>
                )}
                <div className="settings-actions-row">
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={saveWebrtcSettings}
                    disabled={webrtcSaving}
                    style={{ display: 'flex', alignItems: 'center', gap: 8 }}
                  >
                    {webrtcSaving ? <Loader2 size={14} className="spinner" /> : <Save size={14} />}
                    {webrtcSaving ? t('settings.webrtcSettings.saving') : t('settings.webrtcSettings.save')}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

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
        {activeTab === 'analytics' && (
          <div className="settings-body">
            <AnalyticsSettingsPanel />
          </div>
        )}
      </motion.div>
    </div>
  );
}
