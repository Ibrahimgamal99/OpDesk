import { useState } from 'react';
import { motion } from 'framer-motion';
import { X, Ear, MicVocal, UserPlus } from 'lucide-react';

interface SupervisorModalProps {
  mode: 'listen' | 'whisper' | 'barge';
  target: string;
  onClose: () => void;
  onSubmit: (supervisor: string) => void;
}

const modeConfig = {
  listen: {
    icon: Ear,
    title: 'Listen to Call',
    description: 'Listen silently to the call. Neither party will hear you.',
    color: 'var(--status-idle)',
    buttonText: 'Start Listening',
  },
  whisper: {
    icon: MicVocal,
    title: 'Whisper to Agent',
    description: 'Speak privately to the agent. The caller will not hear you.',
    color: 'var(--accent-amber)',
    buttonText: 'Start Whispering',
  },
  barge: {
    icon: UserPlus,
    title: 'Barge into Call',
    description: 'Join the call as a third party. Both parties will hear you.',
    color: 'var(--accent-pink)',
    buttonText: 'Barge In',
  },
};

export function SupervisorModal({ mode, target, onClose, onSubmit }: SupervisorModalProps) {
  const [supervisor, setSupervisor] = useState('');
  const config = modeConfig[mode];
  const Icon = config.icon;

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
            <Icon size={20} style={{ color: config.color }} />
            {config.title}
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
              {config.description}
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
                Target Extension
              </div>
              <div style={{
                fontSize: 24,
                fontWeight: 700,
                color: config.color,
                fontFamily: 'JetBrains Mono, monospace'
              }}>
                {target}
              </div>
            </div>

            <div className="form-group">
              <label className="form-label">Your Extension (Supervisor)</label>
              <input
                type="text"
                className="form-input"
                placeholder="Enter your extension (e.g., 200)"
                value={supervisor}
                onChange={(e) => setSupervisor(e.target.value)}
                autoFocus
              />
            </div>
          </div>

          <div className="modal-footer">
            <button type="button" className="btn" onClick={onClose}>
              Cancel
            </button>
            <button 
              type="submit" 
              className="btn btn-primary"
              disabled={!supervisor.trim()}
              style={{ 
                background: config.color,
                borderColor: config.color,
                opacity: !supervisor.trim() ? 0.5 : 1
              }}
            >
              <Icon size={14} />
              {config.buttonText}
            </button>
          </div>
        </form>
      </motion.div>
    </div>
  );
}

