import React, { useState } from 'react';
import { SlidersHorizontal } from 'lucide-react';
import { Sheet } from './Sheet';

/**
 * The filter row. One fixed slot order, product-wide:
 *
 *   [ search ] [ filters... ]                        [ actions ]
 *
 * A control type has one home. This row's job is narrowing a result set, so it
 * holds only things that narrow one. The date range is NOT one of those — it
 * scopes the whole page and now lives in Page's `scope` slot; see the note
 * there. Toolbar deliberately has no `range` prop, so it cannot come back here
 * on one screen only.
 *
 * Toolbar makes four decisions once, so no page can make them differently:
 *   - the container: none. Page's toolbar slot is already a distinct band —
 *     secondary background, its own bottom border — so a bordered card in it
 *     drew a second outline 12px inside the first. One band, one border;
 *   - the row height: every slotted control is forced to --control-h;
 *   - the radius: every slotted control is forced to --control-radius, so a
 *     pill search cannot sit beside a rounded-rect select;
 *   - the narrow layout: filters collapse into one button opening a Sheet, with
 *     an active count. Search stays visible; it never becomes an icon here.
 */
export interface ToolbarFilter {
  /** Stable identity — also the React key. */
  key: string;
  /**
   * Shown as the field label inside the collapsed Sheet, where a bare vertical
   * stack of selects would be unreadable. The inline row stays label-free
   * product-wide, so the all-or-nothing rule still holds for the row itself.
   */
  label: string;
  control: React.ReactNode;
  /**
   * True when this filter is narrowing results. Drives the count badge when
   * collapsed, and an accent outline on the control when inline — four
   * identically grey selects give no clue which of them is hiding rows.
   */
  active?: boolean;
}

export interface ToolbarProps {
  /** A <SearchInput/>. Leading, and the widest slot. */
  search?: React.ReactNode;
  filters?: ToolbarFilter[];
  /** Row actions (export, clear, sort). Trailing. */
  actions?: React.ReactNode[];
  /** Caller-supplied so the label is translated at the call site. */
  filtersLabel?: string;
  className?: string;
}

export function Toolbar({
  search, filters, actions, filtersLabel = 'Filters', className,
}: ToolbarProps) {
  const [sheetOpen, setSheetOpen] = useState(false);
  const activeCount = filters?.filter(f => f.active).length ?? 0;

  return (
    <div className={`ui-toolbar${className ? ` ${className}` : ''}`}>
      <div className="ui-toolbar-lead">
        {search && <div className="ui-toolbar-search">{search}</div>}

        {/* The inline row and the sheet render the same controls. They never
            disagree because the caller owns each filter's value — these are
            controlled components, so two instances read one source of truth.
            Only one is ever exposed: the row is display:none below the collapse
            width, and Radix unmounts the sheet's contents while it is closed. */}
        {filters?.map(f => (
          <div className="ui-toolbar-filter" data-active={f.active || undefined} key={f.key}>
            {f.control}
          </div>
        ))}

        {Boolean(filters?.length) && (
          <button
            type="button"
            className="ui-toolbar-filters-btn"
            onClick={() => setSheetOpen(true)}
            aria-expanded={sheetOpen}
          >
            <SlidersHorizontal size={15} />
            {filtersLabel}
            {activeCount > 0 && <span className="ui-toolbar-filters-count">{activeCount}</span>}
          </button>
        )}
      </div>

      {Boolean(actions?.length) && (
        <div className="ui-toolbar-trail">
          {actions?.map((a, i) => (
            <div className="ui-toolbar-action" key={i}>{a}</div>
          ))}
        </div>
      )}

      <Sheet open={sheetOpen} onOpenChange={setSheetOpen} title={filtersLabel}>
        {/* role=group + aria-label associates the label with the control without
            a <label for>: the filters are custom button triggers, not form
            elements a <label> can legally point at. */}
        {filters?.map(f => (
          <div className="ui-sheet-field" role="group" aria-label={f.label} key={f.key}>
            <span className="ui-sheet-field-label">{f.label}</span>
            {f.control}
          </div>
        ))}
      </Sheet>
    </div>
  );
}
