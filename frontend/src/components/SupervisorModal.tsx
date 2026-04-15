import { useState } from 'react';
import { motion } from 'framer-motion';
import { X, Ear, MicVocal, UserPlus } from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface SupervisorModalProps {
  mode: 'listen' | 'whisper' | 'barge';
  target: string;
  onClose: () => void;
  onSubmit: (supervisor: string) => void;
}

const MODE_ICONS = {
  listen: Ear,
  whisper: MicVocal,
  barge: UserPlus,
};

const MODE_COLORS = {
  listen: 'var(--status-idle)',
  whisper: 'var(--accent-amber)',
  barge: 'var(--accent-pink)',
};

export function SupervisorModal({ mode, target, onClose, onSubmit }: SupervisorModalProps) {
  const { t } = useTranslation();
  const [supervisor, setSupervisor] = useState('');
  const Icon = MODE_ICONS[mode];
  const color = MODE_COLORS[mode];

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (supervisor.trim()) {
      onSubmit(supervisor.trim());
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <motion.div
        initial={{ opacity: 0, scale: 0.95, y: 20 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.95, y: 20 }}
        transition={{ duration: 0.2 }}
        className="modal"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h3 className="modal-title" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <Icon size={20} style={{ color }} />
            {t(`supervisor.${mode}.title`)}
          </h3>
          <button className="modal-close" onClick={onClose}>
            <X size={20} />
          </button>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="modal-body">
            <p style={{
              color: 'var(--text-secondary)',
              fontSize: 14,
              marginBottom: 20,
              lineHeight: 1.6
            }}>
              {t(`supervisor.${mode}.description`)}
            </p>

            <div style={{
              background: 'var(--bg-secondary)',
              padding: 16,
              borderRadius: 'var(--radius-md)',
              marginBottom: 20,
              border: '1px solid var(--border-primary)'
            }}>
              <div style={{
                fontSize: 11,
                color: 'var(--text-muted)',
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
                marginBottom: 6
              }}>
                {t('supervisor.targetExtension')}
              </div>
              <div style={{
                fontSize: 24,
                fontWeight: 700,
                color,
                fontFamily: 'JetBrains Mono, monospace'
              }}>
                {target}
              </div>
            </div>

            <div className="form-group">
              <label className="form-label">{t('supervisor.yourExtension')}</label>
              <input
                type="text"
                className="form-input"
                placeholder={t('supervisor.extensionPlaceholder')}
                value={supervisor}
                onChange={(e) => setSupervisor(e.target.value)}
                autoFocus
              />
            </div>
          </div>

          <div className="modal-footer">
            <button type="button" className="btn" onClick={onClose}>
              {t('supervisor.cancel')}
            </button>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={!supervisor.trim()}
              style={{
                background: color,
                borderColor: color,
                opacity: !supervisor.trim() ? 0.5 : 1
              }}
            >
              <Icon size={14} />
              {t(`supervisor.${mode}.buttonText`)}
            </button>
          </div>
        </form>
      </motion.div>
    </div>
  );
}
