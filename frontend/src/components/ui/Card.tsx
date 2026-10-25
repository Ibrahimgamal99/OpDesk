import React from 'react';
import type { LucideIcon } from 'lucide-react';

/**
 * The one content block inside a page body: a settings section, an add/edit
 * form, a list with its own heading. Header (icon tile, title, one-line
 * description, status/actions), body, and an optional footer that holds the
 * block's Save button at the inline end.
 *
 * Replaces the ad-hoc shells that grew per feature (.up-add-card,
 * .settings-section, bare bordered divs): same radius, same padding, same
 * title size and the Save button in the same corner on every block.
 */
export interface CardProps {
  icon?: LucideIcon;
  title?: React.ReactNode;
  description?: React.ReactNode;
  /** Header trailing slot: a status Badge, a Toggle, secondary buttons. */
  actions?: React.ReactNode;
  /** Footer, aligned to the inline end. One solid primary button at most. */
  footer?: React.ReactNode;
  /** Drops body padding, for a framed table or list that runs edge to edge. */
  flush?: boolean;
  className?: string;
  bodyClassName?: string;
  children?: React.ReactNode;
}

export function Card({
  icon: Icon, title, description, actions, footer, flush, className, bodyClassName, children,
}: CardProps) {
  const hasHeader = Icon || title || description || actions;
  return (
    <div className={`ui-card${className ? ` ${className}` : ''}`}>
      {hasHeader && (
        <div className="ui-card-header">
          {Icon && <span className="ui-card-icon"><Icon size={16} aria-hidden /></span>}
          <div className="ui-card-heading">
            {title && <div className="ui-card-title">{title}</div>}
            {description && <div className="ui-card-desc">{description}</div>}
          </div>
          {actions && <div className="ui-card-actions">{actions}</div>}
        </div>
      )}
      {children !== undefined && children !== null && children !== false && (
        <div className={['ui-card-body', flush && 'ui-card-body--flush', bodyClassName].filter(Boolean).join(' ')}>
          {children}
        </div>
      )}
      {footer && <div className="ui-card-footer">{footer}</div>}
    </div>
  );
}
