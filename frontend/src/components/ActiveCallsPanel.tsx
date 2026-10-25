import { PhoneCall, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { CallInfo } from '../types';
import { ActiveCallsTable } from './ActiveCallsTable';
import { Page } from './ui';

interface ActiveCallsPanelProps {
  calls: Record<string, CallInfo>;
  onSupervisorAction: (mode: 'listen' | 'whisper' | 'barge', target: string) => void;
  onHangup?: (target: string) => void;
  onTransfer?: (source: string, destination: string) => void;
  onTakeOver?: (source: string) => void;
  onSync?: () => void;
}

export function ActiveCallsPanel({ calls, onSupervisorAction, onHangup, onTransfer, onTakeOver, onSync }: ActiveCallsPanelProps) {
  const { t } = useTranslation();
  const callList = Object.values(calls).sort((a, b) =>
    a.extension.localeCompare(b.extension, undefined, { numeric: true })
  );

  return (
    <Page
      icon={PhoneCall}
      title={t('activeCalls.title')}
      count={callList.length}
      flush
      actions={onSync && (
        <button type="button" className="btn btn-ghost" onClick={onSync} title={t('activeCalls.syncAll')}>
          <RefreshCw size={14} />
          {t('activeCalls.sync')}
        </button>
      )}
    >
      <ActiveCallsTable
        calls={callList}
        onSupervisorAction={onSupervisorAction}
        onHangup={onHangup}
        onTransfer={onTransfer}
        onTakeOver={onTakeOver}
      />
    </Page>
  );
}
