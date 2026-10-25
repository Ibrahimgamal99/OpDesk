import { useState } from 'react';
import { Phone, PhoneOff, ArrowRightLeft, User, PhoneIncoming, PhoneOutgoing, ArrowLeftRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { CallInfo, ExtensionStatus } from '../types';
import { StatusBadge, DEVICE_STATUS_META } from './statusBadge';
import { getUser } from '../auth';
import { SuperviseActions, type SuperviseMode } from './SuperviseActions';
import { ROUTE_TONE, routeGroup, routeLabel, type RouteGroup } from './liveRoute';
import { Badge, Dropdown, EmptyState, Table } from './ui';
import type { Column } from './ui';
import '../styles/live.css';

/**
 * `ext` is the row's extension: the server authorises a transfer / take-over against it, and
 * checks that `source` is that extension or the party its call is talking to.
 */
export interface ActiveCallsTableProps {
  calls: CallInfo[];
  onSupervisorAction: (mode: SuperviseMode, target: string) => void;
  onHangup?: (target: string) => void;
  onTransfer?: (source: string, destination: string, ext: string) => void;
  onTakeOver?: (source: string, ext: string) => void;
}

const ROUTE_ICON: Record<RouteGroup, typeof PhoneIncoming> = {
  inbound: PhoneIncoming, outbound: PhoneOutgoing, internal: ArrowLeftRight,
};

/** Asterisk channel state as the device status Extensions shows for the same call, so a
 *  ringing or connected call wears the same translated pill on both pages. States with no
 *  device equivalent (Down, Busy …) are shown as Asterisk names them, without a colour claim. */
function channelStatus(state: string): ExtensionStatus | null {
  const s = state.toLowerCase();
  if (s === 'up') return 'in_call';
  if (s === 'ring' || s === 'ringing') return 'ringing';
  if (s === 'dialing' || s === 'dial') return 'dialing';
  if (s === 'hold' || s === 'on hold' || s === 'on_hold') return 'on_hold';
  return null;
}

/**
 * The calls in progress, one row per extension, with the supervisor controls the caller
 * passes: supervision always, hangup / transfer / take-over when given.
 */
export function ActiveCallsTable({
  calls, onSupervisorAction, onHangup, onTransfer, onTakeOver,
}: ActiveCallsTableProps) {
  const { t } = useTranslation();
  const columns: Column<CallInfo>[] = [
    {
      key: 'extension', header: t('fields.extension'), primary: true,
      cell: call => <span className="u-mono u-semibold">{call.extension}</span>,
    },
    {
      key: 'state', header: t('activeCalls.table.state'),
      cell: call => {
        const status = channelStatus(call.state);
        if (!status) return <Badge tone="neutral">{call.state || '—'}</Badge>;
        const meta = DEVICE_STATUS_META[status];
        return <StatusBadge meta={meta} label={t(meta.key, meta.fallback)} />;
      },
    },
    {
      key: 'route', header: t('activeCalls.table.direction'),
      cell: call => {
        if (!call.route) return <span className="u-fg-muted">—</span>;
        const Icon = ROUTE_ICON[routeGroup(call.route)];
        return <Badge tone={ROUTE_TONE[routeGroup(call.route)]} icon={<Icon size={14} />}>{routeLabel(t, call.route)}</Badge>;
      },
    },
    {
      key: 'talkingTo', header: t('activeCalls.table.talkingTo'),
      // Phonebook name when we have one, resolved server-side so every viewer
      // agrees. The number stays visible — it is what you dial back.
      cell: call => call.contact_name
        ? <>{call.contact_name} <span className="u-fg-muted u-mono">({call.talking_to})</span></>
        : (call.talking_to || '—'),
    },
    {
      key: 'duration', header: t('fields.duration'),
      cell: call => <span className="u-mono">{call.duration || '—'}</span>,
    },
    {
      key: 'talkTime', header: t('activeCalls.table.talkTime'),
      cell: call => <span className="u-mono">{call.talk_time || '—'}</span>,
    },
    ...(getUser()?.role !== 'agent' ? [{
      key: 'actions', header: t('common.actions'), label: '',
      cell: (call: CallInfo) => (
        <CallActions
          call={call}
          onSupervisorAction={onSupervisorAction}
          onHangup={onHangup}
          onTransfer={onTransfer}
          onTakeOver={onTakeOver}
        />
      ),
    }] : []),
  ];

  return (
    <Table
      columns={columns}
      rows={calls}
      rowKey={call => call.extension}
      empty={<EmptyState icon={Phone} title={t('activeCalls.noActiveCalls')} />}
    />
  );
}

interface CallActionsProps {
  call: CallInfo;
  onSupervisorAction: (mode: SuperviseMode, target: string) => void;
  onHangup?: (target: string) => void;
  onTransfer?: (source: string, destination: string, ext: string) => void;
  onTakeOver?: (source: string, ext: string) => void;
}

/** The supervisor controls for one call, with its own transfer form. A component rather
 *  than inline cell markup so each row keeps its own open/closed transfer state. */
function CallActions({ call, onSupervisorAction, onHangup, onTransfer, onTakeOver }: CallActionsProps) {
  const { t } = useTranslation();
  const [showTransfer, setShowTransfer] = useState(false);
  const [transferSource, setTransferSource] = useState('');
  const [transferDest, setTransferDest] = useState('');

  const callLegs = [
    { value: call.extension, label: t('activeCalls.transfer.legExtension', { ext: call.extension }) },
    ...(call.talking_to?.trim()
      ? [{ value: call.talking_to.trim(), label: t('activeCalls.transfer.legTalkingTo', { ext: call.talking_to.trim() }) }]
      : []),
  ];

  const openTransfer = () => {
    setShowTransfer(true);
    setTransferSource(call.extension);
    setTransferDest('');
  };

  const closeTransfer = () => {
    setShowTransfer(false);
    setTransferSource('');
    setTransferDest('');
  };

  return (
    <div className="u-col u-gap-1h">
      <div className="u-row u-gap-1">
        <SuperviseActions target={call.extension} onAction={onSupervisorAction} />
        {onTransfer && (
          <button
            type="button"
            className="btn btn-ghost btn-sm btn-icon"
            onClick={() => (showTransfer ? closeTransfer() : openTransfer())}
            title={t('activeCalls.actions.transfer')}
            aria-label={t('activeCalls.actions.transfer')}
            aria-expanded={showTransfer}
          >
            <ArrowRightLeft size={14} />
          </button>
        )}
        {onHangup && (
          <button
            type="button"
            className="btn btn-ghost btn-danger btn-sm btn-icon"
            onClick={() => onHangup(call.extension)}
            title={t('common.endCall')}
            aria-label={t('common.endCall')}
          >
            <PhoneOff size={14} />
          </button>
        )}
      </div>
      {onTransfer && showTransfer && (
        <div className="call-transfer u-col u-gap-2">
          <div className="u-row u-gap-1">
            <label className="u-text-xs u-fg-muted u-nowrap">
              {t('activeCalls.transfer.source')}
            </label>
            <Dropdown
              value={transferSource}
              onChange={setTransferSource}
              options={callLegs.map(leg => ({ value: leg.value, label: leg.label }))}
              minWidth={120}
            />
          </div>
          <div className="u-wrap u-row u-gap-2">
            <span className="u-text-xs u-fg-muted">{t('activeCalls.transfer.option1')}</span>
            <span className="u-text-xs">{t('activeCalls.transfer.transferTo')}</span>
            <input
              type="text"
              value={transferDest}
              onChange={(e) => setTransferDest(e.target.value)}
              placeholder={t('activeCalls.transfer.extOrNumber')}
              aria-label={t('activeCalls.transfer.transferTo')}
              className="form-input call-transfer-input"
            />
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={!transferDest.trim()}
              onClick={() => {
                const dest = transferDest.trim();
                if (!dest) return;
                onTransfer(transferSource, dest, call.extension);
                closeTransfer();
              }}>
              {t('common.transfer')}
            </button>
          </div>
          {onTakeOver && getUser()?.extension && call.talking_to?.trim() && (
            <div className="u-wrap u-row u-gap-2">
              <span className="u-text-xs u-fg-muted">{t('activeCalls.transfer.option2')}</span>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => {
                  onTakeOver(call.talking_to!.trim(), call.extension);
                  closeTransfer();
                }}
                title={t('activeCalls.transfer.takeOverTitle', 'Transfer caller ({{caller}}) to your extension ({{ext}})', { caller: call.talking_to?.trim(), ext: getUser()?.extension })}>
                <User size={14} />
                {t('activeCalls.transfer.takeOver')}
              </button>
            </div>
          )}
          <button type="button" className="btn btn-ghost btn-sm" onClick={closeTransfer}>
            {t('common.cancel')}
          </button>
        </div>
      )}
    </div>
  );
}
