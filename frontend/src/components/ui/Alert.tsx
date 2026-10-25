import React from 'react';
import { AlertTriangle, CheckCircle2, Info, X, XCircle, type LucideIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';

export type AlertTone = 'error' | 'warning' | 'success' | 'info';

/* Six banner implementations existed before this: .up-alert, .login-error,
   .logs-error, .softphone-alert.error, .crm-keymap-warn and .crmx-inline-warn.
   They disagreed on padding, radius, whether an icon appeared, and — the part
   that matters — whether a screen reader was told anything at all. None of them
   carried a live region, so a failed save was announced to nobody. */

const TONE_ICONS: Record<AlertTone, LucideIcon> = {
  error: XCircle,
  warning: AlertTriangle,
  success: CheckCircle2,
  info: Info,
};

export interface AlertProps {
  tone?: AlertTone;
  /** The message. Rendering nothing when falsy keeps call sites to one line. */
  children?: React.ReactNode;
  /** `banner` is the tinted box; `inline` is icon + text with no fill, for
   *  hints that sit under a field. */
  variant?: 'banner' | 'inline';
  icon?: React.ReactNode | false;
  /** Renders a dismiss button that calls this. */
  onDismiss?: () => void;
  /** A trailing control — typically Retry. */
  action?: React.ReactNode;
  className?: string;
}

export function Alert({
  tone = 'error', children, variant = 'banner', icon, onDismiss, action, className,
}: AlertProps) {
  const { t } = useTranslation();
  if (!children) return null;

  const ToneIcon = TONE_ICONS[tone];
  const classes = [`ui-alert`, `ui-alert--${tone}`, `ui-alert--${variant}`, className]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      className={classes}
      /* An error is assertive: it is the direct result of something the user just
         did, so it interrupts. Everything else waits for a pause. */
      role={tone === 'error' ? 'alert' : 'status'}
      aria-live={tone === 'error' ? 'assertive' : 'polite'}
    >
      {icon !== false && (
        <span className="ui-alert-icon" aria-hidden>
          {icon ?? <ToneIcon size={16} />}
        </span>
      )}
      <div className="ui-alert-text">{children}</div>
      {action}
      {onDismiss && (
        <button
          type="button"
          className="btn-ghost btn-icon ui-alert-dismiss"
          onClick={onDismiss}
          aria-label={t('common.dismiss', 'Dismiss')}
        >
          <X size={14} />
        </button>
      )}
    </div>
  );
}
