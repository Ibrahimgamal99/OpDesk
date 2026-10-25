import React from 'react';
import { ArrowDown, ArrowUp, ChevronsUpDown } from 'lucide-react';

/**
 * The one table.
 *
 * Five shells existed before this — .data-table, .cl-table, .an-table,
 * .calls-table and .settings-users-table — agreeing on the look (full width,
 * uppercase muted header, hairline row rules) and disagreeing on every number:
 * three font sizes, three cell paddings, `collapse` vs `separate`, and a sticky
 * header on exactly one of them. None collapsed to cards on a phone; they all
 * side-scrolled instead, which hides the right-hand columns behind a gesture
 * with no affordance.
 *
 * Columns are declared rather than written as JSX because the stacked-card view
 * needs each cell's label at render time. `data-label` is emitted from the
 * column's `label`, so the mobile layout is a stylesheet concern handled once
 * instead of a second markup tree per screen.
 */

export interface Column<T> {
  key: string;
  header: React.ReactNode;
  cell: (row: T, index: number) => React.ReactNode;
  /** Label for the stacked-card view. Defaults to `header` when it is a string. */
  label?: string;
  align?: 'start' | 'end' | 'center';
  /** Marks the header as a sort control. Pair with `sort` and `onSort`. */
  sortable?: boolean;
  /** Dropped below `md` — for columns that are noise on a phone. */
  hideOnMobile?: boolean;
  /** The cell that titles each stacked card. One per table. */
  primary?: boolean;
  width?: string;
  className?: string;
}

export interface TableProps<T> {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T, index: number) => string | number;
  /** `compact` is the 10px/12px cell; `default` is 12px/16px. */
  density?: 'compact' | 'default';
  stickyHeader?: boolean;
  /** Wraps the table in a bordered, rounded, clipped frame. */
  framed?: boolean;
  sort?: { key: string; dir: 'asc' | 'desc' } | null;
  onSort?: (key: string) => void;
  rowClassName?: (row: T, index: number) => string | undefined;
  onRowClick?: (row: T, index: number) => void;
  /** Rendered in place of the rows when `rows` is empty. */
  empty?: React.ReactNode;
  /** Accessible name for the table. */
  caption?: string;
  className?: string;
}

const ALIGN_CLASS = {
  start: '',
  end: 'ui-td--end',
  center: 'ui-td--center',
} as const;

export function Table<T>({
  columns, rows, rowKey, density = 'compact', stickyHeader = false, framed = false,
  sort, onSort, rowClassName, onRowClick, empty, caption, className,
}: TableProps<T>) {
  const labelFor = (c: Column<T>) =>
    c.label ?? (typeof c.header === 'string' ? c.header : undefined);

  const table = (
    <table
      className={[
        'ui-table',
        `ui-table--${density}`,
        stickyHeader && 'ui-table--sticky',
        onRowClick && 'ui-table--clickable',
        className,
      ].filter(Boolean).join(' ')}
    >
      {caption && <caption className="ui-visually-hidden">{caption}</caption>}
      <thead>
        <tr>
          {columns.map(c => {
            const active = sort?.key === c.key;
            const cls = [
              ALIGN_CLASS[c.align ?? 'start'],
              c.hideOnMobile && 'ui-td--desktop',
              c.className,
            ].filter(Boolean).join(' ') || undefined;
            if (!c.sortable || !onSort) {
              return <th key={c.key} className={cls} style={c.width ? { width: c.width } : undefined}>{c.header}</th>;
            }
            return (
              <th
                key={c.key}
                className={cls}
                style={c.width ? { width: c.width } : undefined}
                /* The sort state is announced, not just drawn as an arrow. */
                aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
              >
                {/* A button, not an onClick on the <th> — a sortable header is a
                    control and needs to be reachable and activatable by keyboard. */}
                <button type="button" className="ui-th-sort" onClick={() => onSort(c.key)}>
                  {c.header}
                  {active
                    ? (sort.dir === 'asc' ? <ArrowUp size={12} /> : <ArrowDown size={12} />)
                    : <ChevronsUpDown size={12} className="ui-th-sort-idle" />}
                </button>
              </th>
            );
          })}
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 && empty ? (
          <tr className="ui-table-empty-row">
            <td colSpan={columns.length}>{empty}</td>
          </tr>
        ) : (
          rows.map((row, i) => (
            <tr
              key={rowKey(row, i)}
              className={rowClassName?.(row, i)}
              onClick={onRowClick ? () => onRowClick(row, i) : undefined}
            >
              {columns.map(c => (
                <td
                  key={c.key}
                  data-label={labelFor(c)}
                  className={[
                    ALIGN_CLASS[c.align ?? 'start'],
                    c.hideOnMobile && 'ui-td--desktop',
                    c.primary && 'ui-td--primary',
                    c.className,
                  ].filter(Boolean).join(' ') || undefined}
                >
                  {c.cell(row, i)}
                </td>
              ))}
            </tr>
          ))
        )}
      </tbody>
    </table>
  );

  /* The scroll container is always present: below `md` the rows become cards and
     never scroll sideways, but between `md` and a genuinely narrow desktop a wide
     table still needs somewhere to go that is not the page's own x-axis. */
  return <div className={framed ? 'ui-table-wrap ui-table-wrap--framed' : 'ui-table-wrap'}>{table}</div>;
}
