import { useMemo } from 'react';
import { PhoneCall, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { CallInfo, Extension } from '../types';
import { ActiveCallsTable } from './ActiveCallsTable';
import { Page } from './ui';

interface ActiveCallsPanelProps {
  calls: Record<string, CallInfo>;
  extensions?: Record<string, Extension>;
  onSupervisorAction: (mode: 'listen' | 'whisper' | 'barge', target: string) => void;
  onHangup?: (target: string) => void;
  onTransfer?: (source: string, destination: string, ext: string) => void;
  onTakeOver?: (source: string, ext: string) => void;
  onSync?: () => void;
}

export function ActiveCallsPanel({ calls, extensions = {}, onSupervisorAction, onHangup, onTransfer, onTakeOver, onSync }: ActiveCallsPanelProps) {
  const { t } = useTranslation();
  const extensionNames = useMemo(() => {
    const names: Record<string, string> = {};
    for (const ext of Object.values(extensions)) if (ext.name) names[ext.extension] = ext.name;
    return names;
  }, [extensions]);
  const callList = Object.values(calls).sort((a, b) =>
    a.extension.localeCompare(b.extension, undefined, { numeric: true })
  );

  return (
    <Page
      icon={PhoneCall}
      title={t('nav.activeCalls')}
      count={callList.length}
      flush
      actions={onSync && (
        <button type="button" className="btn btn-ghost" onClick={onSync} title={t('common.syncAll')}>
          <RefreshCw size={14} />
          {t('common.sync')}
        </button>
      )}
    >
      <ActiveCallsTable
        calls={callList}
        extensionNames={extensionNames}
        onSupervisorAction={onSupervisorAction}
        onHangup={onHangup}
        onTransfer={onTransfer}
        onTakeOver={onTakeOver}
      />
    </Page>
  );
}
