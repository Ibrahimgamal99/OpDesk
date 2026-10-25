import { useId, useState } from 'react';
import { Ear, MicVocal, UserPlus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { getUser } from '../auth';
import { FormField, Modal } from './ui';

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

/* Mode accents live in the stylesheet as `--sup-accent`, keyed off
   .sup-modal--<mode>. See the supervision dialog block in index.css. */

export function SupervisorModal({ mode, target, onClose, onSubmit }: SupervisorModalProps) {
  const { t } = useTranslation();
  // The spy leg rings the user's own extension; the server refuses any other, except that
  // an admin may ring another extension of the PBX. So the field starts on it and only an
  // admin can change it.
  const user = getUser();
  const ownExt = user?.extension ? String(user.extension) : '';
  const canChoose = user?.role === 'admin' || !ownExt;
  const [supervisor, setSupervisor] = useState(ownExt);
  const formId = useId();
  const Icon = MODE_ICONS[mode];

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (supervisor.trim()) {
      onSubmit(supervisor.trim());
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={t(`supervisor.${mode}.title`)}
      icon={<Icon size={16} />}
      width="sm"
      /* Mode accent drives the icon and the target readout. One custom property,
         set once, rather than inline colours. The submit stays the standard
         primary button, like every other dialog. */
      className={`sup-modal sup-modal--${mode}`}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {t('supervisor.cancel')}
          </button>
          {/* The form wraps only the body, so the submit button reaches it by id
              rather than by nesting. Keeps Modal's shell markup unchanged. */}
          <button
            type="submit"
            form={formId}
            className="btn btn-primary"
            disabled={!supervisor.trim()}
          >
            <Icon size={14} />
            {t(`supervisor.${mode}.buttonText`)}
          </button>
        </>
      }
    >
      <form id={formId} onSubmit={handleSubmit}>
        <p className="sup-description">{t(`supervisor.${mode}.description`)}</p>

        <div className="sup-target">
          <div className="sup-target-label">{t('supervisor.targetExtension')}</div>
          <div className="sup-target-value">{target}</div>
        </div>

        <FormField label={t('supervisor.yourExtension')} htmlFor={`${formId}-ext`}>
          <input
            id={`${formId}-ext`}
            type="text"
            inputMode="numeric"
            autoComplete="off"
            className="form-input"
            placeholder={t('supervisor.extensionPlaceholder')}
            value={supervisor}
            onChange={(e) => setSupervisor(e.target.value)}
            readOnly={!canChoose}
            {...(canChoose ? { 'data-autofocus': true } : {})}
          />
        </FormField>
      </form>
    </Modal>
  );
}
