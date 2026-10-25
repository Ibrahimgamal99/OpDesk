import { useTranslation } from 'react-i18next';
import { Badge } from './ui';
import { callStatusLabel, callStatusMeta, callStatusTip } from './callStatus';

/**
 * A call status, drawn the one way: the shared Badge in that status's colour from
 * callStatus.ts, with what the status means as its tooltip. Call history, the journey
 * timeline, the bell and the drill-down all render statuses through this instead of
 * styling a span inline. No leading dot: a finished call is not a live state, and the
 * dot means "live".
 */
export function CallStatusBadge({ status, title }: { status: string | null | undefined; title?: string }) {
  const { t } = useTranslation();
  return (
    <Badge color={callStatusMeta(status)?.color ?? 'var(--text-muted)'} title={title ?? callStatusTip(t, status ?? '')}>
      {callStatusLabel(t, status ?? '')}
    </Badge>
  );
}
