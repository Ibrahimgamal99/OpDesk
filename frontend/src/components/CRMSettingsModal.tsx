import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { X, Save, Loader2, CheckCircle2, AlertCircle, Database } from 'lucide-react';

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

  useEffect(() => {
    if (isOpen) {
      loadConfig();
    }
  }, [isOpen]);

  const loadConfig = async () => {
    setLoading(true);
    setMessage(null);
    try {
      const response = await fetch('/api/crm/config');
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
        headers: { 'Content-Type': 'application/json' },
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

  if (!isOpen) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <motion.div
        initial={{ opacity: 0, scale: 0.95, y: 20 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.95, y: 20 }}
        transition={{ duration: 0.2 }}
        className="modal"
        style={{ maxWidth: 700, maxHeight: '90vh', overflowY: 'auto' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h3 className="modal-title" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <Database size={20} style={{ color: 'var(--accent-primary)' }} />
            CRM Configuration
          </h3>
          <button className="modal-close" onClick={onClose}>
            <X size={20} />
          </button>
        </div>

        {loading ? (
          <div style={{ padding: 40, textAlign: 'center' }}>
            <Loader2 size={24} className="spinner" />
            <p style={{ marginTop: 16, color: 'var(--text-secondary)' }}>Loading configuration...</p>
          </div>
        ) : (
          <form onSubmit={handleSubmit}>
            <div className="modal-body">
              {/* Enable/Disable Toggle */}
              <div className="form-group">
                <label className="form-label" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <input
                    type="checkbox"
                    checked={config.enabled}
                    onChange={(e) => updateConfig({ enabled: e.target.checked })}
                    style={{ width: 18, height: 18 }}
                  />
                  Enable CRM Integration
                </label>
                <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
                  When enabled, call data will be sent to your CRM system after each call ends.
                </p>
              </div>

              {config.enabled && (
                <>
                  {/* Server URL */}
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

                  {/* Auth Type */}
                  <div className="form-group">
                    <label className="form-label">Authentication Type *</label>
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

                  {/* API Key Auth Fields */}
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
                        <label className="form-label">API Key Header (optional)</label>
                        <input
                          type="text"
                          className="form-input"
                          placeholder="X-API-Key"
                          value={config.api_key_header || ''}
                          onChange={(e) => updateConfig({ api_key_header: e.target.value })}
                        />
                        <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
                          Default: X-API-Key
                        </p>
                      </div>
                    </>
                  )}

                  {/* Basic Auth Fields */}
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

                  {/* Bearer Token Auth Fields */}
                  {config.auth_type === 'bearer_token' && (
                    <div className="form-group">
                      <label className="form-label">Bearer Token *</label>
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

                  {/* OAuth2 Auth Fields */}
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
                        <label className="form-label">Client Secret *</label>
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

                  {/* Optional Settings */}
                  <div style={{ 
                    marginTop: 24, 
                    paddingTop: 24, 
                    borderTop: '1px solid var(--border-primary)' 
                  }}>
                    <h4 style={{ 
                      fontSize: 14, 
                      fontWeight: 600, 
                      marginBottom: 16,
                      color: 'var(--text-secondary)'
                    }}>
                      Optional Settings
                    </h4>

                    <div className="form-group">
                      <label className="form-label">Endpoint Path</label>
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
                        min="1"
                        max="300"
                      />
                    </div>

                    <div className="form-group">
                      <label className="form-label" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <input
                          type="checkbox"
                          checked={config.verify_ssl !== false}
                          onChange={(e) => updateConfig({ verify_ssl: e.target.checked })}
                          style={{ width: 18, height: 18 }}
                        />
                        Verify SSL Certificates
                      </label>
                    </div>
                  </div>

                  {/* Message Display */}
                  {message && (
                    <div style={{
                      padding: 12,
                      borderRadius: 'var(--radius-md)',
                      background: message.type === 'success' 
                        ? 'rgba(63, 185, 80, 0.15)' 
                        : 'rgba(248, 81, 73, 0.15)',
                      border: `1px solid ${message.type === 'success' 
                        ? 'rgba(63, 185, 80, 0.3)' 
                        : 'rgba(248, 81, 73, 0.3)'}`,
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      marginTop: 16,
                    }}>
                      {message.type === 'success' ? (
                        <CheckCircle2 size={16} style={{ color: 'var(--accent-success)' }} />
                      ) : (
                        <AlertCircle size={16} style={{ color: 'var(--accent-danger)' }} />
                      )}
                      <span style={{ 
                        fontSize: 13,
                        color: message.type === 'success' 
                          ? 'var(--accent-success)' 
                          : 'var(--accent-danger)'
                      }}>
                        {message.text}
                      </span>
                    </div>
                  )}
                </>
              )}
            </div>

            <div className="modal-footer">
              <button type="button" className="btn" onClick={onClose} disabled={saving}>
                Cancel
              </button>
              <button 
                type="submit" 
                className="btn btn-primary"
                disabled={saving || (config.enabled && !config.server_url)}
                style={{ 
                  opacity: (saving || (config.enabled && !config.server_url)) ? 0.5 : 1,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                }}
              >
                {saving ? (
                  <>
                    <Loader2 size={14} className="spinner" />
                    Saving...
                  </>
                ) : (
                  <>
                    <Save size={14} />
                    Save Configuration
                  </>
                )}
              </button>
            </div>
          </form>
        )}
      </motion.div>
    </div>
  );
}

