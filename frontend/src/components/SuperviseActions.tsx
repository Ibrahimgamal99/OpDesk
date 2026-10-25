import { Ear, MicVocal, UserPlus } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { getAllowedMonitorModes } from '../auth';

export type SuperviseMode = 'listen' | 'whisper' | 'barge';

const MODES: { mode: SuperviseMode; Icon: LucideIcon; key: string }[] = [
  { mode: 'listen', Icon: Ear, key: 'activeCalls.actions.listen' },
  { mode: 'whisper', Icon: MicVocal, key: 'activeCalls.actions.whisper' },
  { mode: 'barge', Icon: UserPlus, key: 'activeCalls.actions.barge' },
];

/**
 * Listen / Whisper / Barge for one extension's live call, drawn the one way on
 * every page that offers them (Extensions tiles, Active calls rows): the same
 * icons, order, size and emphasis, filtered to the modes this user may use.
 * Callers decide *whether* the call is supervisable; this decides how it looks.
 */
export function SuperviseActions({ target, onAction }: {
  target: string;
  onAction: (mode: SuperviseMode, target: string) => void;
}) {
  const { t } = useTranslation();
  const allowed = getAllowedMonitorModes();
  return (
    <>
      {MODES.filter(m => allowed.includes(m.mode)).map(({ mode, Icon, key }) => (
        <button
          key={mode}
          type="button"
          className="btn btn-ghost btn-sm btn-icon"
          onClick={(e) => { e.stopPropagation(); onAction(mode, target); }}
          title={t(key)}
          aria-label={t(key)}
        >
          <Icon size={14} />
        </button>
      ))}
    </>
  );
}
