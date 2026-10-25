import React from 'react';
import type { LucideIcon } from 'lucide-react';

/**
 * The one page shell. Every routed panel renders exactly one of these and puts
 * nothing above or around it, so every page has the same slot map:
 *
 *   [icon] Title (count)                    [ scope ] [ actions ]
 *   ──────────────────────────────────────────────────────────────
 *   [ tabs ]
 *   ──────────────────────────────────────────────────────────────
 *   [ toolbar: search · filters ·                     · exports ]
 *   ──────────────────────────────────────────────────────────────
 *   body
 *
 * Before this, each panel wrote its own `.panel-header`: icons at 16px on some
 * pages and 18px on others, hand-rolled `up-tab` buttons in the header on Users
 * and Groups, tabs in an inline-padded div on the Dialer, and a total-count chip
 * on Call History that no other page had. Pages now pass content; the shell owns
 * the icon size, the padding, the bands and their borders.
 *
 * `scope` is the question the page answers (the date range) and sits before the
 * actions. It is not a filter, so it never goes in the toolbar.
 */
export interface PageProps {
  icon: LucideIcon;
  title: React.ReactNode;
  /** A total shown beside the title, e.g. the number of live calls. */
  count?: number;
  /** The date range or other "what is this page about" control. */
  scope?: React.ReactNode;
  /** Header trailing slot. At most one solid (primary) button. */
  actions?: React.ReactNode;
  /** A <Tabs> element. One level only. */
  tabs?: React.ReactNode;
  /** A <Toolbar> element. */
  toolbar?: React.ReactNode;
  /** Drops the body padding, for a table or stream that runs edge to edge. */
  flush?: boolean;
  className?: string;
  bodyClassName?: string;
  children: React.ReactNode;
}

export function Page({
  icon: Icon, title, count, scope, actions, tabs, toolbar, flush, className, bodyClassName, children,
}: PageProps) {
  return (
    <section className={`panel ui-page${className ? ` ${className}` : ''}`}>
      <div className="panel-header ui-page-header">
        <h2 className="panel-title">
          <Icon size={16} className="panel-title-icon" aria-hidden />
          {title}
          {count !== undefined && <span className="ui-page-count">{count.toLocaleString()}</span>}
        </h2>
        {(scope || actions) && (
          <div className="panel-header-actions">
            {scope}
            {actions}
          </div>
        )}
      </div>
      {tabs && <div className="ui-page-tabs">{tabs}</div>}
      {toolbar && <div className="ui-page-toolbar">{toolbar}</div>}
      <div className={['panel-content', 'ui-page-body', flush && 'ui-page-body--flush', bodyClassName].filter(Boolean).join(' ')}>
        {children}
      </div>
    </section>
  );
}
