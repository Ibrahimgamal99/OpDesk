import React from 'react';

/**
 * The page shell. Owns every piece of page chrome: header, title, icon slot,
 * trailing actions, the tab strip container, and the toolbar container.
 *
 * Pages pass content into slots and never lay out chrome themselves — no
 * page-level padding, max-width, background, or header markup. A page that
 * needs different spacing is a bug in Page, not a licence to override.
 *
 * There is deliberately no `subtitle` prop. The standard requires a subtitle to
 * be required or forbidden product-wide, because mixing them gives two header
 * heights; before this component, Call History had one and the other screens
 * did not. Forbidden is the cheaper half of that choice — the one subtitle in
 * the product read "View and manage", which no user needed. Reversing it means
 * adding the prop here once and filling it in on every page, not sprinkling.
 */
export interface PageProps {
  /**
   * Leading icon. One family product-wide (lucide) at the size Page fixes —
   * pass the element, not a size. Emoji and glyphs are not icons.
   */
  icon?: React.ReactNode;
  title: string;
  /**
   * State that belongs to the surface itself (Live / Paused / Off). Sits with
   * the title, because it names what you are looking at. Not an action.
   */
  status?: React.ReactNode;
  /**
   * The window of data the whole page is showing — in practice a
   * <RangePicker/>, and its one home product-wide.
   *
   * It used to live in the Toolbar's `range` slot. That was wrong twice over: a
   * date range is not a filter over the rows, it is the question the page is
   * answering, and Analytics has nothing to filter — so its toolbar existed
   * only to hold the range, rendering a full-width bordered box with one
   * control pinned to its far edge and ~1200px of nothing beside it. Scope
   * belongs with the page's identity; the toolbar narrows what scope returned.
   *
   * Consequence: a page whose only toolbar content was the range now has no
   * toolbar at all, which is the intended outcome.
   */
  scope?: React.ReactNode;
  /** Header trailing slot. Exactly one primary action per page. */
  actions?: React.ReactNode;
  /** A <Tabs/>. Page owns the slot and the container, so pages cannot restyle it. */
  tabs?: React.ReactNode;
  /** A <Toolbar/>. Always directly below the tabs, never in the header. */
  toolbar?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}

export function Page({
  icon, title, status, scope, actions, tabs, toolbar, children, className,
}: PageProps) {
  return (
    <section className={`ui-page${className ? ` ${className}` : ''}`}>
      <header className="ui-page-head">
        <h2 className="ui-page-title">
          {icon && <span className="ui-page-title-icon">{icon}</span>}
          {title}
          {status && <span className="ui-page-status">{status}</span>}
        </h2>
        {(scope || actions) && (
          <div className="ui-page-trail">
            {/* Scope before actions, always: it reads as part of the sentence the
                title starts ("Call History — Today"), and an action that jumped
                position between pages would be the more expensive drift. */}
            {scope && <div className="ui-page-scope">{scope}</div>}
            {actions && <div className="ui-page-actions">{actions}</div>}
          </div>
        )}
      </header>

      {tabs && <div className="ui-page-tabs">{tabs}</div>}
      {toolbar && <div className="ui-page-toolbar">{toolbar}</div>}

      <div className="ui-page-body">{children}</div>
    </section>
  );
}
