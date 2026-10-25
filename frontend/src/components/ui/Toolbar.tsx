import React from 'react';

/**
 * The filter row of a page, passed to <Page toolbar>. Search first, then the
 * controls that narrow the result set, then exports and other row actions at the
 * far end.
 *
 * It draws no border, background or padding: Page's toolbar slot is already a
 * band, and a card inside it would draw a second outline just inside the first.
 * Every control on the row gets the same height from `.ui-toolbar`.
 */
export interface ToolbarProps {
  /** A <SearchInput>. */
  search?: React.ReactNode;
  /** Dropdowns, segmented controls, toggles. */
  filters?: React.ReactNode;
  /** Export, refresh, live-tail. */
  actions?: React.ReactNode;
  className?: string;
}

export function Toolbar({ search, filters, actions, className }: ToolbarProps) {
  return (
    <div className={`ui-toolbar${className ? ` ${className}` : ''}`}>
      {search && <div className="ui-toolbar-search">{search}</div>}
      {filters && <div className="ui-toolbar-filters">{filters}</div>}
      {actions && <div className="ui-toolbar-actions">{actions}</div>}
    </div>
  );
}
