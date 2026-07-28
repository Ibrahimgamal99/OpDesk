import { useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { CalendarRange, Check, ChevronDown } from 'lucide-react';

/**
 * The only date-range control. One trigger that reads the current range, opening
 * an anchored panel with the presets and a custom from/to pair.
 *
 * ## Why it is not a chip row any more
 *
 * The previous control painted every preset as a pill and filled the selected one
 * with --accent-primary. On Analytics that put an accent-filled "Today" pill
 * directly beneath the accent-filled "Overview" tab pill: two different
 * hierarchies — which slice of data, and which view — rendered identically. It
 * also spent five control widths on a control that is read far more often than it
 * is changed. One trigger says what the range IS at a glance, and costs one
 * width.
 *
 * ## Why a popover and not a Sheet on narrow screens
 *
 * ui/Sheet exists because an anchored panel is unusable once the on-screen
 * keyboard claims half the viewport. That does not apply here: the panel is a
 * short list of buttons, and its only inputs are `type=date`, which open the
 * platform's own date UI rather than the text keyboard. Nothing in this panel can
 * summon it. Radix keeps the panel on screen via collision detection.
 *
 * Presets are supplied by the caller — this file has no i18n dependency, the same
 * reason ui/Toolbar takes `filtersLabel`. Build them with `rangePresets(t)` from
 * analyticsUtils so all three screens offer the same list.
 */
export interface RangePreset {
  /** Stable identity — also the React key. */
  key: string;
  label: string;
  from: string;
  to: string;
}

export interface RangePickerProps {
  value: { from: string; to: string };
  onChange: (r: { from: string; to: string }) => void;
  presets: RangePreset[];
  /** Names the control for assistive tech. Translated at the call site. */
  label: string;
  /** Heading for the from/to section. Translated at the call site. */
  customLabel: string;
  /** Latest selectable day, ISO. Defaults to open-ended. */
  max?: string;
  /** BCP-47 tag for the trigger's date formatting. Defaults to the browser's. */
  locale?: string;
  className?: string;
}

/** "Jul 28" for a single day, "Jul 1 – Jul 28" for a span. */
function formatRange(from: string, to: string, locale?: string): string {
  // Midnight-local, not `new Date('2026-07-28')` — that parses as UTC and prints
  // as the previous day for anyone west of Greenwich.
  const fmt = new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' });
  const start = fmt.format(new Date(`${from}T00:00:00`));
  if (from === to) return start;
  return `${start} – ${fmt.format(new Date(`${to}T00:00:00`))}`;
}

export function RangePicker({
  value, onChange, presets, label, customLabel, max, locale, className,
}: RangePickerProps) {
  const [open, setOpen] = useState(false);

  const selected = presets.find(p => p.from === value.from && p.to === value.to);
  const current = selected ? selected.label : formatRange(value.from, value.to, locale);

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        className={`ui-range-trigger${className ? ` ${className}` : ''}`}
        aria-label={`${label}: ${current}`}
      >
        <CalendarRange size={15} className="ui-range-icon" aria-hidden="true" />
        <span className="ui-range-value">{current}</span>
        <ChevronDown size={14} className="ui-range-caret" aria-hidden="true" />
      </Popover.Trigger>

      <Popover.Portal>
        <Popover.Content
          className="ui-range-panel"
          align="end"
          sideOffset={6}
          collisionPadding={8}
          aria-label={label}
        >
          <div className="ui-range-presets">
            {presets.map(p => (
              <button
                type="button"
                key={p.key}
                className="ui-range-preset"
                aria-pressed={selected?.key === p.key}
                onClick={() => { onChange({ from: p.from, to: p.to }); setOpen(false); }}
              >
                <span>{p.label}</span>
                {/* Marks the selection instead of filling the row with accent:
                    a filled row here would read as the active tab treatment. */}
                {selected?.key === p.key && <Check size={14} aria-hidden="true" />}
              </button>
            ))}
          </div>

          {/* No "Custom" mode to enter — editing either date simply stops matching
              a preset, so the check mark clears itself. One less state to be in. */}
          <div className="ui-range-custom" role="group" aria-label={customLabel}>
            <span className="ui-range-custom-label">{customLabel}</span>
            <div className="ui-range-dates">
              <input
                type="date"
                className="ui-range-date"
                value={value.from}
                max={max}
                aria-label={`${customLabel} — ${value.from}`}
                onChange={e => {
                  const from = e.target.value;
                  if (!from) return;
                  // Keep the pair ordered: dragging `from` past `to` pushes `to`.
                  onChange({ from, to: from > value.to ? from : value.to });
                }}
              />
              {/* An en dash, not an arrow: an arrow has to be flipped for RTL,
                  and a range separator does not. */}
              <span className="ui-range-arrow" aria-hidden="true">–</span>
              <input
                type="date"
                className="ui-range-date"
                value={value.to}
                max={max}
                aria-label={`${customLabel} — ${value.to}`}
                onChange={e => {
                  const to = e.target.value;
                  if (!to) return;
                  onChange({ from: to < value.from ? to : value.from, to });
                }}
              />
            </div>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
