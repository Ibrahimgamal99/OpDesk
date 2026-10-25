import React, { useEffect, useRef } from 'react';

export interface TabItem {
  key: string;
  label: string;
  icon?: React.ReactNode;
  count?: number;
}

interface TabsProps {
  tabs: TabItem[];
  active: string;
  onChange: (key: string) => void;
  /** Names the tab set for assistive tech. Required when a page has more than one. */
  ariaLabel?: string;
  className?: string;
}

/**
 * The only tab bar. Pages pass `tabs` and nothing else about how they look.
 *
 * ## Manual activation
 *
 * Arrow keys move focus; Enter or Space activates. Automatic activation — where
 * focus alone switches tab — fires a fetch on every arrow press, so holding Right
 * across five tabs would kick off five requests and paint the results in whatever
 * order they land. Home/End jump to the ends.
 *
 * ## Overflow
 *
 * Scrolls horizontally rather than wrapping. A wrapped second row changes the
 * page's height depending on which page you are on and how wide the window is,
 * which moves everything below it. The active tab is scrolled into view on mount
 * and on change, so a tab selected from a URL is never off-screen.
 *
 * Not built on Radix or React Aria, which the standard asks for, because this app
 * has no headless-primitive dependency and `direct-lib-import` bans reaching for
 * one outside `ui/`. The roles, keyboard model and focus management below are the
 * substance of that requirement, implemented directly.
 */
export function Tabs({ tabs, active, onChange, ariaLabel, className }: TabsProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef<HTMLButtonElement>(null);

  // Keep the selected tab visible: a tab restored from ?tab= can start outside the
  // scroll window, and a tab that cannot be seen reads as no tab being selected.
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [active]);

  const move = (from: number, delta: number) => {
    const buttons = listRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    if (!buttons?.length) return;
    const next = (from + delta + buttons.length) % buttons.length;
    buttons[next].focus();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    switch (e.key) {
      case 'ArrowRight': e.preventDefault(); move(index, 1); break;
      case 'ArrowLeft': e.preventDefault(); move(index, -1); break;
      case 'Home': e.preventDefault(); move(0, 0); break;
      case 'End': e.preventDefault(); move(tabs.length - 1, 0); break;
      default: break;
    }
  };

  return (
    <div
      ref={listRef}
      role="tablist"
      aria-label={ariaLabel}
      aria-orientation="horizontal"
      className={`ui-tabs${className ? ` ${className}` : ''}`}
    >
      {tabs.map((t, i) => {
        const selected = active === t.key;
        return (
          <button
            key={t.key}
            ref={selected ? activeRef : undefined}
            type="button"
            role="tab"
            id={`tab-${t.key}`}
            aria-selected={selected}
            aria-controls={`tabpanel-${t.key}`}
            // Only the selected tab is in the tab order; arrows move within the set.
            // Otherwise Tab has to be pressed once per tab to get past the bar.
            tabIndex={selected ? 0 : -1}
            className={`ui-tab${selected ? ' active' : ''}`}
            onClick={() => onChange(t.key)}
            onKeyDown={(e) => onKeyDown(e, i)}
          >
            {t.icon}
            {t.label}
            {t.count !== undefined && (
              <span className="ui-tab-count">{t.count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
