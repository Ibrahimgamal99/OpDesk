import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import {
  X, Save, Loader2, CheckCircle2, AlertCircle, Database, Signal, Power, PowerOff, Settings,
  ChevronDown, ChevronRight, Plug, Server,
} from 'lucide-react';
import { getAuthHeaders } from '../auth';

export type SettingsTab = 'integrations' | 'qos' | 'webrtc';

export interface CRMConfig {
  enabled: boolean;
  server_url: string;
  auth_type: 'api_key' | 'basic_auth' | 'bearer_token' | 'oauth2';
  // API Key auth
  api_key?: string;
  api_key_header?: string;
  // Basic Auth
  username?: string;
  password?: string;
  // Bearer Token
  bearer_token?: string;
  // OAuth2
  oauth2_client_id?: string;
  oauth2_client_secret?: string;
  oauth2_token_url?: string;
  oauth2_scope?: string;
  // Optional
  endpoint_path?: string;
  timeout?: number;
  verify_ssl?: boolean;
}

interface CRMSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function CRMSettingsModal({ isOpen, onClose }: CRMSettingsModalProps) {
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
      setWebrtcMessage({ type: 'error', text: 'Failed to load WebRTC settings' });
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
        setWebrtcMessage({ type: 'success', text: 'WebRTC settings saved successfully' });
      } else {
        setWebrtcMessage({ type: 'error', text: data.detail || 'Failed to save WebRTC settings' });
      }
    } catch (error) {
      console.error('Failed to save WebRTC settings:', error);
      setWebrtcMessage({ type: 'error', text: 'Failed to save WebRTC settings' });
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
        // If no config exists, use defaults
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
      setMessage({ type: 'error', text: 'Failed to load CRM configuration' });
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
        setMessage({ type: 'success', text: 'CRM configuration saved successfully' });
        setTimeout(() => {
          onClose();
        }, 1500);
      } else {
        const error = await response.json();
        setMessage({ type: 'error', text: error.detail || 'Failed to save CRM configuration' });
      }
    } catch (error) {
      console.error('Failed to save CRM config:', error);
      setMessage({ type: 'error', text: 'Failed to save CRM configuration' });
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
      const response = await fetch('/api/qos/enable', {
        method: 'POST',
        headers: getAuthHeaders(),
      });

      if (response.ok) {
        const data = await response.json();
        setQosMessage({ type: 'success', text: data.message || 'QoS enabled successfully' });
      } else {
        const error = await response.json();
        setQosMessage({ type: 'error', text: error.detail || 'Failed to enable QoS' });
      }
    } catch (error) {
      console.error('Failed to enable QoS:', error);
      setQosMessage({ type: 'error', text: 'Failed to enable QoS configuration' });
    } finally {
      setQosLoading(false);
    }
  };

  const handleQosDisable = async () => {
    setQosLoading(true);
    setQosMessage(null);
    try {
      const response = await fetch('/api/qos/disable', {
        method: 'POST',
        headers: getAuthHeaders(),
      });

      if (response.ok) {
        const data = await response.json();
        setQosMessage({ type: 'success', text: data.message || 'QoS disabled successfully' });
      } else {
        const error = await response.json();
        setQosMessage({ type: 'error', text: error.detail || 'Failed to disable QoS' });
      }
    } catch (error) {
      console.error('Failed to disable QoS:', error);
      setQosMessage({ type: 'error', text: 'Failed to disable QoS configuration' });
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
            Settings
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
            Integrations
          </button>
          <button
            type="button"
            className={`settings-tab ${activeTab === 'qos' ? 'active' : ''}`}
            onClick={() => setActiveTab('qos')}
          >
            <Signal size={16} />
            Quality of Service
          </button>
          <button
            type="button"
            className={`settings-tab ${activeTab === 'webrtc' ? 'active' : ''}`}
            onClick={() => setActiveTab('webrtc')}
          >
            <Server size={16} />
            WebRTC
          </button>
        </div>

        {activeTab === 'webrtc' && (
          <div className="settings-body">
            {webrtcLoading ? (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 48 }}>
                <Loader2 size={28} className="spinner" />
                <p style={{ marginTop: 16, color: 'var(--text-secondary)', fontSize: 14 }}>Loading WebRTC settings...</p>
              </div>
            ) : (
              <div className="settings-section">
                <div className="settings-section-header">
                  <div className="settings-section-icon">
                    <Server size={20} />
                  </div>
                  <div>
                    <div className="settings-section-title">WebRTC / PBX WebSocket</div>
                    <div className="settings-section-desc">
                      WebSocket URL of your PBX server for WebRTC. Use the form wss://server:port/ws or ws://server:port/ws.
                    </div>
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
                  <label className="form-label">WebSocket URL</label>
                  <input
                    type="text"
                    className="form-input"
                    placeholder="wss://server:port/ws"
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
                    {webrtcSaving ? 'Saving...' : 'Save WebRTC settings'}
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
                  <div className="settings-section-title">Quality of Service (QoS)</div>
                  <div className="settings-section-desc">
                    Capture call quality metrics and store them in CDR records for reporting and troubleshooting.
                  </div>
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
                  {qosLoading ? 'Processing...' : 'Enable QoS'}
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={handleQosDisable}
                  disabled={qosLoading}
                  style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, opacity: qosLoading ? 0.6 : 1 }}
                >
                  {qosLoading ? <Loader2 size={14} className="spinner" /> : <PowerOff size={14} />}
                  {qosLoading ? 'Processing...' : 'Disable QoS'}
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
              <p style={{ marginTop: 16, color: 'var(--text-secondary)', fontSize: 14 }}>Loading configuration...</p>
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
                      <div className="settings-section-title">CRM Integration</div>
                      <div className="settings-section-desc">
                        Send call data to your CRM after each call. Configure server URL and authentication.
                      </div>
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
                      Enable CRM integration
                    </label>
                    <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4, marginLeft: 28 }}>
                      When enabled, call data will be sent to your CRM system after each call ends.
                    </p>
                  </div>

                  {config.enabled && (
                    <>
                      <div className="form-group">
                        <label className="form-label">CRM Server URL *</label>
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
                        <label className="form-label">Authentication type</label>
                        <select
                          className="form-input"
                          value={config.auth_type}
                          onChange={(e) => updateConfig({ auth_type: e.target.value as CRMConfig['auth_type'] })}
                          required
                        >
                          <option value="api_key">API Key</option>
                          <option value="basic_auth">Basic Auth</option>
                          <option value="bearer_token">Bearer Token</option>
                          <option value="oauth2">OAuth2</option>
                        </select>
                      </div>

                      {config.auth_type === 'api_key' && (
                        <>
                          <div className="form-group">
                            <label className="form-label">API Key *</label>
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
                            <label className="form-label">API Key header (optional)</label>
                            <input
                              type="text"
                              className="form-input"
                              placeholder="X-API-Key"
                              value={config.api_key_header || ''}
                              onChange={(e) => updateConfig({ api_key_header: e.target.value })}
                            />
                            <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>Default: X-API-Key</p>
                          </div>
                        </>
                      )}

                      {config.auth_type === 'basic_auth' && (
                        <>
                          <div className="form-group">
                            <label className="form-label">Username *</label>
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
                            <label className="form-label">Password *</label>
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
                          <label className="form-label">Bearer token *</label>
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
                            <label className="form-label">Client ID *</label>
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
                            <label className="form-label">Client secret *</label>
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
                            <label className="form-label">Token URL (optional)</label>
                            <input
                              type="text"
                              className="form-input"
                              placeholder="https://crm.example.com/oauth/token"
                              value={config.oauth2_token_url || ''}
                              onChange={(e) => updateConfig({ oauth2_token_url: e.target.value })}
                            />
                          </div>
                          <div className="form-group">
                            <label className="form-label">Scope (optional)</label>
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
                        Advanced options
                      </button>
                      {advancedOpen && (
                        <div className="settings-advanced-body">
                          <div className="form-group">
                            <label className="form-label">Endpoint path</label>
                            <input
                              type="text"
                              className="form-input"
                              placeholder="/api/calls"
                              value={config.endpoint_path || ''}
                              onChange={(e) => updateConfig({ endpoint_path: e.target.value })}
                            />
                          </div>
                          <div className="form-group">
                            <label className="form-label">Timeout (seconds)</label>
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
                              Verify SSL certificates
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
                  Cancel
                </button>
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={saving || (config.enabled && !config.server_url)}
                  style={{ opacity: (saving || (config.enabled && !config.server_url)) ? 0.5 : 1, display: 'flex', alignItems: 'center', gap: 8 }}
                >
                  {saving ? <Loader2 size={14} className="spinner" /> : <Save size={14} />}
                  {saving ? 'Saving...' : 'Save configuration'}
                </button>
              </div>
            </form>
          )
        )}
      </motion.div>
    </div>
  );
}
