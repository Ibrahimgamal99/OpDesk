import {
  useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState,
} from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, Search, X } from 'lucide-react';
import type React from 'react';
import {
  anchorVars, useAnchorBox, useDismissOnOutside, useMediaQuery,
  COARSE_POINTER, SHEET_BREAKPOINT,
} from './anchor';
import { byRelevance, foldPlain, matchPrepared, prepare, prepareQuery } from './match';
import type { Match, MatchRange } from './match';

/**
 * The one dropdown.
 *
 * This replaced six implementations: a portal Select that parsed <option>
 * children, a FilterSelect for the analytics bars, two byte-identical copies of a
 * MultiSelectDropdown (Users and Groups), and two inline comboboxes. Between them
 * exactly one did viewport flipping and none did keyboard navigation, so this is
 * not a merge of working behaviour -- flipping is measured here for the first
 * time and the keyboard support is new.
 *
 * Single and multi select are the same component with a `multiple` prop rather
 * than two components, so a fix to positioning or keyboard handling cannot land
 * in one and miss the other. The same applies to the two presentations: below the
 * `md` breakpoint this renders as a bottom sheet, and that is a branch on where
 * the panel is drawn, not a second component -- filtering, keyboard handling and
 * selection are literally the same nodes either way.
 *
 * No numeric icon `size` props anywhere in here: lucide renders width/height as
 * attributes, CSS beats attributes, and the sizes live with the rest of the
 * visual scale in variables.css.
 */

/** Options are searchable from this count up, unless `searchable` overrides. */
const DEFAULT_SEARCH_THRESHOLD = 10;
/** Typeahead buffer lifetime -- type "sa" quickly for Sales, pause to start over. */
const TYPEAHEAD_RESET_MS = 500;
/** Fallback page jump for PageUp/PageDown before the list can be measured. */
const FALLBACK_PAGE_STEP = 5;
/** Drag distance past which releasing the sheet dismisses it instead of snapping back. */
const SHEET_DISMISS_PX = 72;
/**
 * Option count from which the list windows instead of rendering every row.
 *
 * Below this, windowing costs more than it saves. Above it the cost is real: an
 * extension list on a busy PBX is several hundred rows, and mounting all of them
 * on every keystroke of the filter is what makes a dropdown feel heavy.
 */
const VIRTUALIZE_FROM = 100;
/** Rows kept mounted beyond each edge, so a fast scroll does not show gaps. */
const OVERSCAN_ROWS = 8;
/** Rows rendered on a long list's first paint, purely to measure one. */
const MEASURE_ROWS = 24;

export interface DropdownOption {
  value: string;
  label: string;
  /** Small leading status dot, used by the call-log and active-call filters. */
  dot?: 'green' | 'red' | 'blue' | 'orange' | 'purple' | 'neutral';
  /** A colour token for the dot, for a vocabulary whose colours already live elsewhere as
   *  values -- the call-status filters wear each status's own colour (callStatus.ts), which
   *  six palette names cannot express. Wins over `dot`. */
  dotColor?: string;
  /** How many items on the page carry this value, shown muted after the label.
   *  Filters built from the page's own data pass it so every option says what it holds. */
  count?: number;
  disabled?: boolean;
}

/** The label's own color, when `dot` carries one -- same palette as `.an-dot-*`,
 *  read here too because CSS can color a fixed class but not a per-option value. */
const DOT_TEXT_COLOR: Record<NonNullable<DropdownOption['dot']>, string> = {
  green: 'var(--accent-success)',
  red: 'var(--accent-danger)',
  blue: 'var(--accent-primary)',
  orange: 'var(--accent-warning)',
  purple: 'var(--accent-purple)',
  neutral: 'var(--text-muted)',
};

/** One option's leading dot and label colour, or null when it has no dot. */
function dotOf(o: Pick<DropdownOption, 'dot' | 'dotColor'>) {
  if (o.dotColor) return { className: 'an-dot', style: { background: o.dotColor }, color: o.dotColor };
  if (o.dot) return { className: `an-dot an-dot-${o.dot}`, style: undefined, color: DOT_TEXT_COLOR[o.dot] };
  return null;
}

interface DropdownBase {
  options: DropdownOption[];
  /** Leading icon on the trigger (a lucide component). */
  icon?: React.ElementType;
  /** sm = compact filter bar; md = matches .form-input height. */
  size?: 'sm' | 'md';
  placeholder?: string;
  emptyMessage?: string;
  disabled?: boolean;
  /** Force the filter box on or off, overriding `searchThreshold` either way. */
  searchable?: boolean;
  /**
   * Option count from which the filter box appears. A count, deliberately, and
   * never "does the list scroll": measuring overflow made the filter box depend
   * on viewport height and browser zoom, so the same list showed a filter box on
   * a laptop and none on a tall monitor. It is also circular, since the filter
   * box's own height changes whether the list overflows.
   */
  searchThreshold?: number;
  searchPlaceholder?: string;
  minWidth?: number;
  /**
   * Lock the open panel to exactly this tall instead of sizing it to content
   * and to whatever room the viewport has around the trigger. Only for a
   * caller that wants a stable, predictable panel over one that adapts --
   * accepting that on a very short viewport it can run past the edge, since
   * nothing shrinks it to fit any more.
   */
  fixedHeight?: number;
  className?: string;
  /** Accessible name, when no visible label is associated with the trigger. */
  ariaLabel?: string;
  /**
   * Controlled open state. The overlay contract asks for controlled-only, which
   * `Popover` is, but every one of this component's call sites is uncontrolled
   * and a select that cannot open itself is a poor default. Both are supported:
   * pass `open` to drive it, leave it off to let the component own the state.
   */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

type DropdownSingle = DropdownBase & {
  multiple?: false;
  value: string;
  onChange: (value: string) => void;
};

type DropdownMulti = DropdownBase & {
  multiple: true;
  value: string[];
  onChange: (value: string[]) => void;
};

export type DropdownProps = DropdownSingle | DropdownMulti;

/** An option as rendered: the caller's option plus wherever the query hit it. */
type VisibleOption = DropdownOption & { ranges?: MatchRange[] };

/**
 * Paint the matched runs inside a label.
 *
 * The ranges index the ORIGINAL label, never the folded form, which is what lets
 * a query of `محمد` highlight the right letters of `مُحَمَّد` with its diacritics
 * still attached.
 */
function highlight(text: string, ranges?: MatchRange[]): React.ReactNode {
  if (!ranges?.length) return text;

  const parts: React.ReactNode[] = [];
  let at = 0;
  ranges.forEach((r, i) => {
    if (r.start > at) parts.push(text.slice(at, r.start));
    parts.push(<mark key={i}>{text.slice(r.start, r.end)}</mark>);
    at = r.end;
  });
  if (at < text.length) parts.push(text.slice(at));
  return parts;
}

export function Dropdown(props: DropdownProps) {
  const {
    options, icon: Icon, size = 'sm', placeholder, emptyMessage = 'No options',
    disabled, searchable, searchThreshold = DEFAULT_SEARCH_THRESHOLD,
    searchPlaceholder = 'Search…', minWidth, fixedHeight, className, ariaLabel, multiple,
    open: openProp, onOpenChange,
  } = props;

  const [selfOpen, setSelfOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(-1);
  /** Live offset while the sheet is being dragged down; 0 when it is not. */
  const [dragY, setDragY] = useState(0);
  /**
   * The scroll region's geometry, re-read on scroll and whenever the list is
   * re-laid out. Drives both the windowing maths and the edge fades, so the two
   * can never disagree about where the list currently is.
   */
  const [scroll, setScroll] = useState({ top: 0, viewport: 0, content: 0 });
  /** Measured row height. Uniform: options are single-line by CSS. */
  const [rowHeight, setRowHeight] = useState(0);

  const rootRef = useRef<HTMLDivElement>(null);
  // Either a <button> (single) or a chip div (multiple); both only ever need
  // getBoundingClientRect and focus().
  const triggerRef = useRef<HTMLElement | null>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const dragFrom = useRef<number | null>(null);
  const typeahead = useRef({ buffer: '', at: 0 });
  const listId = useId();

  const controlled = openProp !== undefined;
  const open = controlled ? openProp : selfOpen;
  const setOpen = useCallback((next: boolean) => {
    if (!controlled) setSelfOpen(next);
    onOpenChange?.(next);
  }, [controlled, onOpenChange]);

  // Below `md` an anchored panel is the wrong shape: the on-screen keyboard takes
  // half the viewport and the list ends up behind it.
  const isSheet = useMediaQuery(SHEET_BREAKPOINT);
  const isCoarse = useMediaQuery(COARSE_POINTER);

  // `?? []` is load-bearing: several callers hold the multi value in an OPTIONAL
  // form field (`group_ids?: string[]`), so it is undefined on a fresh or
  // restored form. Without the guard `selected.includes` throws during render and
  // takes the whole subtree down, not just the dropdown.
  const selected: string[] = multiple
    ? (props.value ?? [])
    : (props.value ? [props.value] : []);

  // A single-select `placeholder` is a SELECTABLE empty option, not just trigger
  // text. That was the contract of the Select this replaced (`{placeholder &&
  // <option value="">}`), and it is what lets "All actions" / "All events" reset a
  // filter -- drop it and those filters become one-way. Callers that already list
  // their own '' option (the former FilterSelect sites do) are left alone.
  const resolvedOptions = useMemo(() => {
    if (multiple || !placeholder) return options;
    if (options.some(o => o.value === '')) return options;
    return [{ value: '', label: placeholder }, ...options];
  }, [options, placeholder, multiple]);

  // Multi-select always gets the filter box regardless of count: picking several
  // things means coming back to the list repeatedly.
  const showSearch = searchable ?? (!!multiple || resolvedOptions.length >= searchThreshold);

  // Folded for matching once per list, not once per keystroke. Gated on `open`
  // because the live panels re-render on every AMI event and DialerPanel alone
  // holds ten of these -- folding every closed dropdown's options on each of
  // those renders would cost more than the search saves.
  const prepared = useMemo(
    () => (open ? resolvedOptions.map(o => prepare(o.label, o.value)) : null),
    [open, resolvedOptions],
  );

  const parsedQuery = useMemo(() => prepareQuery(query), [query]);

  const visible = useMemo<VisibleOption[]>(() => {
    if (!parsedQuery || !prepared) return resolvedOptions;

    const hits: { option: DropdownOption; match: Match }[] = [];
    resolvedOptions.forEach((option, i) => {
      const match = matchPrepared(parsedQuery, prepared[i]);
      if (match) hits.push({ option, match });
    });
    // Relevance order, not declaration order. Array.sort is stable, so options
    // that tie on every axis keep the order the caller listed them in.
    hits.sort((a, b) => byRelevance(a.match, b.match));
    return hits.map(h => ({ ...h.option, ranges: h.match.ranges }));
  }, [resolvedOptions, prepared, parsedQuery]);

  /** Positions of the options the arrows may land on. Disabled ones stay in the
   *  accessibility tree, they are just skipped over. */
  const enabledIndices = useMemo(
    () => visible.map((o, i) => (o.disabled ? -1 : i)).filter(i => i >= 0),
    [visible],
  );

  // ── Scroll & windowing ─────────────────────────────────────────────────────
  // Windowing turns itself on by list length, not by a prop: whether a caller's
  // list is long is a property of the data, and no call site should have to know
  // the threshold. It also has to survive filtering -- a 400-option list narrowed
  // to 6 by the filter is a short list again and renders whole.
  const longList = visible.length > VIRTUALIZE_FROM;
  /** Windowing is live only once a row has been measured -- see `range`. */
  const windowed = longList && rowHeight > 0;

  const range = useMemo(() => {
    if (!longList) return { start: 0, end: visible.length };
    // First paint of a long list, before any row exists to measure. Render a
    // screenful rather than the whole list: mounting 400 rows for the one frame
    // it takes to learn the row height is most of the cost windowing exists to
    // avoid, and it lands on exactly the open that already feels slowest.
    if (!rowHeight) return { start: 0, end: Math.min(visible.length, MEASURE_ROWS) };

    const first = Math.floor(scroll.top / rowHeight) - OVERSCAN_ROWS;
    const span = Math.ceil(scroll.viewport / rowHeight) + OVERSCAN_ROWS * 2;
    const start = Math.max(0, first);
    return { start, end: Math.min(visible.length, start + span) };
  }, [longList, visible.length, rowHeight, scroll.top, scroll.viewport]);

  // Spacers standing in for the rows outside the window, so the scrollbar
  // reflects the whole list. Both fall out to 0 when the list renders whole, and
  // while rowHeight is still unknown -- no branch needed.
  const padStart = range.start * rowHeight;
  const padEnd = (visible.length - range.end) * rowHeight;

  // A scrolled list that ends flush with the panel border reads as complete.
  // These drive a fade at whichever edge still has content behind it.
  const fadeStart = scroll.top > 1;
  const fadeEnd = scroll.top + scroll.viewport < scroll.content - 1;

  /** Re-read the scroll geometry. Bails when nothing moved so it cannot loop
   *  through the effects that also call it. */
  const syncScroll = useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    setScroll(prev => (
      prev.top === el.scrollTop
        && prev.viewport === el.clientHeight
        && prev.content === el.scrollHeight
        ? prev
        : { top: el.scrollTop, viewport: el.clientHeight, content: el.scrollHeight }
    ));
  }, []);

  // No `?? options[0].label` fallback: showing the first option when nothing is
  // selected misreports the state as a selection the user never made.
  const singleLabel = !multiple
    ? (resolvedOptions.find(o => o.value === props.value)?.label ?? placeholder ?? '')
    : '';

  /** Chips for the multi trigger, in the order the options are declared. */
  const chips = multiple
    ? resolvedOptions.filter(o => selected.includes(o.value))
    : [];

  const removeChip = (value: string) => {
    if (!multiple) return;
    props.onChange((props.value ?? []).filter(v => v !== value));
  };

  // ── Positioning & dismissal ────────────────────────────────────────────────
  // Both come from ui/anchor, shared with Popover. Anchoring is skipped entirely
  // in sheet mode -- the sheet is pinned to the viewport, not to the trigger.
  const box = useAnchorBox({
    open: open && !isSheet,
    anchorRef: triggerRef,
    layerRef,
    minWidth,
    fixedHeight,
    deps: [visible.length, showSearch],
  });

  const dismiss = useCallback(() => setOpen(false), [setOpen]);
  useDismissOnOutside(open, dismiss, [rootRef, layerRef]);

  // Trap wheel scroll inside the panel. `useAnchorBox` re-places on every
  // scroll (so it tracks an ancestor that legitimately scrolls), but a list
  // too short to scroll itself has nothing to do with a wheel event over it --
  // left alone, the browser sends that scroll straight through to whatever
  // page content behind the panel IS scrollable (a modal body, most often).
  // That moves the trigger, which is what made the anchored panel appear to
  // shrink while the user was just trying to scroll its option list.
  useEffect(() => {
    if (!open) return;
    const layer = layerRef.current;
    if (!layer) return;
    const onWheel = (e: WheelEvent) => {
      const list = listRef.current;
      if (!list) { e.preventDefault(); return; }
      const atTop = list.scrollTop <= 0;
      const atBottom = list.scrollTop + list.clientHeight >= list.scrollHeight - 1;
      if ((e.deltaY < 0 && atTop) || (e.deltaY > 0 && atBottom)) e.preventDefault();
    };
    layer.addEventListener('wheel', onWheel, { passive: false });
    return () => layer.removeEventListener('wheel', onWheel);
  }, [open]);

  // On open, highlight the CURRENT selection rather than nothing, so Enter
  // straight after opening re-picks the current value instead of jumping to the
  // first option. On close, clear the query and any half-finished drag.
  useEffect(() => {
    if (!open) {
      setQuery('');
      setActiveIndex(-1);
      setDragY(0);
      dragFrom.current = null;
      return;
    }
    const idx = visible.findIndex(o => selected.includes(o.value));
    setActiveIndex(idx >= 0 ? idx : 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Keep the highlight inside the list as typing narrows it, so Enter can never
  // commit an option that has been filtered out from under it.
  useEffect(() => {
    setActiveIndex(a => (a < 0 ? a : Math.min(a, Math.max(0, visible.length - 1))));
  }, [visible.length]);

  // Focus the filter box once the layer is actually mounted; otherwise focus
  // stays on the trigger and the arrow keys drive the list through
  // aria-activedescendant. Never on touch: the keyboard would slide up and cover
  // the list the user is trying to read.
  //
  // Gated on `layerMounted`, NOT on `open`. The anchored layer renders only after
  // useAnchorBox has measured a box, so on the render where `open` flips true the
  // input does not exist yet and `searchRef.current` is null -- focusing there is
  // a silent no-op and the effect never re-runs. A boolean is used rather than
  // `box` itself so that scrolling, which re-places the box on every event, does
  // not yank focus back into the filter box while the user is elsewhere.
  const layerMounted = open && (isSheet || box !== null);
  useEffect(() => {
    if (layerMounted && showSearch && !isCoarse) searchRef.current?.focus();
  }, [layerMounted, showSearch, isCoarse]);

  // Measure a row and the viewport once the list is laid out. Re-runs when the
  // density, the panel geometry or the option count changes, since all three
  // move the numbers the windowing depends on.
  useLayoutEffect(() => {
    const el = listRef.current;
    if (!open || !el) return;
    const row = el.querySelector<HTMLElement>('.ui-dd-option');
    if (row?.offsetHeight) setRowHeight(row.offsetHeight);
    syncScroll();
  }, [open, box, isSheet, size, visible.length, showSearch, syncScroll]);

  // Keep the active option scrolled into view as the arrows move through it.
  // When windowed the row may not be mounted yet, so its position is computed
  // from the row height rather than looked up in the DOM -- scrollIntoView on a
  // node that does not exist is a silent no-op, which reads as the arrow keys
  // getting stuck at the edge of the window.
  useEffect(() => {
    const el = listRef.current;
    if (!open || activeIndex < 0 || !el) return;

    if (windowed) {
      const top = activeIndex * rowHeight;
      const bottom = top + rowHeight;
      if (top < el.scrollTop) el.scrollTop = top;
      else if (bottom > el.scrollTop + el.clientHeight) el.scrollTop = bottom - el.clientHeight;
      syncScroll();
      return;
    }

    el.querySelector(`[data-index="${activeIndex}"]`)?.scrollIntoView({ block: 'nearest' });
    syncScroll();
  }, [open, activeIndex, windowed, rowHeight, syncScroll]);

  // Filtering restarts the list, so it restarts the scroll too. Without this a
  // query that narrows 400 options to 3 leaves the viewport parked where the
  // scrollbar used to be and the panel looks empty.
  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = 0;
    syncScroll();
  }, [query, syncScroll]);

  // ── Selection ──────────────────────────────────────────────────────────────
  const commit = (option: DropdownOption) => {
    if (option.disabled) return;
    if (multiple) {
      const current = props.value ?? [];
      const next = current.includes(option.value)
        ? current.filter(v => v !== option.value)
        : [...current, option.value];
      props.onChange(next);
      return;                                   // stays open for the next pick
    }
    props.onChange(option.value);
    setOpen(false);
    triggerRef.current?.focus();
  };

  /** Move `delta` enabled options. Clamps at both ends -- arrows do not wrap, so
   *  holding one down settles at the end of the list instead of cycling. */
  const step = (delta: number) => {
    if (!enabledIndices.length) return;
    const at = enabledIndices.indexOf(activeIndex);
    if (at === -1) {
      setActiveIndex(delta > 0 ? enabledIndices[0] : enabledIndices[enabledIndices.length - 1]);
      return;
    }
    const next = Math.min(Math.max(at + delta, 0), enabledIndices.length - 1);
    setActiveIndex(enabledIndices[next]);
  };

  const stepToEdge = (end: boolean) => {
    if (!enabledIndices.length) return;
    setActiveIndex(end ? enabledIndices[enabledIndices.length - 1] : enabledIndices[0]);
  };

  /** How many options fit in the visible list, for PageUp/PageDown. Measured
   *  rather than assumed, because the two sizes have different row heights. */
  const pageStep = () => {
    const list = listRef.current;
    const row = list?.querySelector<HTMLElement>('.ui-dd-option');
    if (!list || !row?.offsetHeight) return FALLBACK_PAGE_STEP;
    return Math.max(1, Math.floor(list.clientHeight / row.offsetHeight));
  };

  /** Jump to the first option starting with what was typed. Only used where no
   *  filter box renders -- with one, the same keystrokes filter instead. */
  const runTypeahead = (char: string) => {
    const t = typeahead.current;
    const now = Date.now();
    t.buffer = now - t.at > TYPEAHEAD_RESET_MS ? char : t.buffer + char;
    t.at = now;
    // Folded, like the filter box: typing `احمد` has to jump to `أحمد` here too,
    // or the same keystrokes behave differently depending on whether the list was
    // long enough to earn a filter box. Folding per keystroke is fine because
    // typeahead only runs when there is no filter box, i.e. under `searchThreshold`
    // options.
    const q = foldPlain(t.buffer);
    const idx = visible.findIndex(o => !o.disabled && foldPlain(o.label).startsWith(q));
    if (idx >= 0) setActiveIndex(idx);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        if (!open) { setOpen(true); return; }
        step(1);
        return;
      case 'ArrowUp':
        e.preventDefault();
        if (!open) { setOpen(true); return; }
        step(-1);
        return;
      case 'PageDown':
        if (!open) return;
        e.preventDefault(); step(pageStep()); return;
      case 'PageUp':
        if (!open) return;
        e.preventDefault(); step(-pageStep()); return;
      case 'Home':
        if (!open) return;
        e.preventDefault(); stepToEdge(false); return;
      case 'End':
        if (!open) return;
        e.preventDefault(); stepToEdge(true); return;
      case 'Enter':
        if (!open) { e.preventDefault(); setOpen(true); return; }
        e.preventDefault();
        if (activeIndex >= 0 && visible[activeIndex]) commit(visible[activeIndex]);
        return;
      case ' ':
        // Space types into the filter box; only act as "select" without one.
        if (open && showSearch) return;
        e.preventDefault();
        if (!open) { setOpen(true); return; }
        if (activeIndex >= 0 && visible[activeIndex]) commit(visible[activeIndex]);
        return;
      case 'Escape':
        if (!open) return;
        e.preventDefault();
        setOpen(false);
        triggerRef.current?.focus();
        return;
      case 'Tab':
        // Closes AND commits what the user arrowed onto. Deliberately no
        // preventDefault and no commit() call: focus has to carry on to the next
        // control, and commit() pulls it back to the trigger.
        if (!open) return;
        if (!props.multiple && activeIndex >= 0) {
          const opt = visible[activeIndex];
          if (opt && !opt.disabled) props.onChange(opt.value);
        }
        setOpen(false);
        return;
      default:
        // Printable characters typeahead where there is no filter box to take
        // them. Modified keys are left alone so browser shortcuts still work.
        if (showSearch || e.key.length !== 1 || e.ctrlKey || e.metaKey || e.altKey) return;
        e.preventDefault();
        if (!open) setOpen(true);
        runTypeahead(e.key);
        return;
    }
  };

  // ── Sheet drag ─────────────────────────────────────────────────────────────
  const onDragStart = (e: React.PointerEvent<HTMLDivElement>) => {
    dragFrom.current = e.clientY;
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onDragMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (dragFrom.current === null) return;
    // Downward only: dragging up must not detach the sheet from the bottom edge.
    setDragY(Math.max(0, e.clientY - dragFrom.current));
  };

  const onDragEnd = () => {
    if (dragFrom.current === null) return;
    dragFrom.current = null;
    if (dragY > SHEET_DISMISS_PX) setOpen(false);
    setDragY(0);
  };

  const rootClass = [
    'ui-dd',
    size === 'md' && 'ui-dd--md',
    open && 'open',
    disabled && 'ui-dd--disabled',
    className,
  ].filter(Boolean).join(' ');

  // The layer carries its own size class rather than inheriting the trigger's. It
  // is a portal child of <body>, so `.ui-dd--md .ui-dd-menu` cannot reach it --
  // which is why the menu stayed at the compact scale under every md trigger.
  const layerClass = [
    // `ui-dd-panel` is everything the two presentations share -- surface, density,
    // option and filter styling. Only placement differs below it.
    'ui-dd-panel',
    size === 'md' && 'ui-dd-panel--md',
    isSheet ? 'ui-dd-sheet' : 'ui-dd-menu',
    !isSheet && box?.flipped && 'ui-dd-menu--flipped',
  ].filter(Boolean).join(' ');

  // Shared by both presentations. The list region is the only thing that
  // scrolls; the filter box is pinned outside it by the flex column.
  const panelBody = (
    <>
      {showSearch && (
        <div className="ui-dd-search">
          <Search className="ui-dd-search-icon" aria-hidden />
          <input
            ref={searchRef}
            className="ui-dd-search-input"
            value={query}
            placeholder={searchPlaceholder}
            aria-label={searchPlaceholder}
            aria-controls={listId}
            aria-activedescendant={activeIndex >= 0 ? `${listId}-opt-${activeIndex}` : undefined}
            onChange={e => { setQuery(e.target.value); setActiveIndex(0); }}
            onKeyDown={onKeyDown}
          />
          {query && (
            <button
              type="button"
              className="ui-dd-search-clear"
              aria-label="Clear search"
              onClick={() => { setQuery(''); searchRef.current?.focus(); }}
            >
              <X />
            </button>
          )}
        </div>
      )}

      {/* The scroll region is a wrapper, not the list itself, so the edge fades
          can sit over the content without scrolling away with it. */}
      <div
        className="ui-dd-scroll"
        data-fade-start={fadeStart || undefined}
        data-fade-end={fadeEnd || undefined}
      >
        {/* role="listbox" belongs on the option list, not on the panel around
            it: a listbox may only contain options, and the filter box and the
            sheet grip are neither. */}
        <div
          ref={listRef}
          id={listId}
          className="ui-dd-list"
          role="listbox"
          aria-multiselectable={multiple || undefined}
          aria-label={ariaLabel}
          onScroll={syncScroll}
        >
          {visible.length === 0 ? (
            <div className="ui-dd-empty">
              <span>{emptyMessage}</span>
              {/* Repeat the query: "No options" alone reads as an empty data set
                  rather than a filter that matched nothing. */}
              {query.trim() && <span className="ui-dd-empty-query">“{query.trim()}”</span>}
            </div>
          ) : (
            <>
              {padStart > 0 && (
                <div
                  className="ui-dd-pad"
                  role="presentation"
                  style={{ '--dd-pad': `${padStart}px` } as React.CSSProperties}
                />
              )}
              {visible.slice(range.start, range.end).map((opt, offset) => {
                // Index into the FULL filtered list, not into the window: it is
                // what activeIndex, the option ids and the keyboard maths all
                // speak, and using the slice offset here would silently break
                // every one of them the moment the list scrolled.
                const i = range.start + offset;
                const isSelected = selected.includes(opt.value);
                const optDot = dotOf(opt);
                return (
                  <div
                    key={opt.value}
                    id={`${listId}-opt-${i}`}
                    data-index={i}
                    className={[
                      'ui-dd-option',
                      isSelected && 'selected',
                      i === activeIndex && 'active',
                      opt.disabled && 'is-disabled',
                    ].filter(Boolean).join(' ')}
                    role="option"
                    aria-selected={isSelected}
                    aria-disabled={opt.disabled || undefined}
                    // Stated explicitly because when windowed the DOM holds a
                    // few dozen rows and a screen reader would otherwise
                    // announce the window size as the list size.
                    aria-setsize={visible.length}
                    aria-posinset={i + 1}
                    tabIndex={-1}
                    onMouseEnter={() => setActiveIndex(i)}
                    onClick={() => commit(opt)}
                  >
                    {optDot && <span className={optDot.className} style={optDot.style} aria-hidden />}
                    <span
                      className="ui-dd-option-label"
                      style={optDot ? { color: optDot.color } : undefined}
                    >
                      {highlight(opt.label, opt.ranges)}
                    </span>
                    {opt.count !== undefined && <span className="ui-dd-option-count">{opt.count}</span>}
                    {isSelected && <Check className="ui-dd-option-check" aria-hidden />}
                  </div>
                );
              })}
              {padEnd > 0 && (
                <div
                  className="ui-dd-pad"
                  role="presentation"
                  style={{ '--dd-pad': `${padEnd}px` } as React.CSSProperties}
                />
              )}
            </>
          )}
        </div>
        <span className="ui-dd-edge ui-dd-edge--start" aria-hidden />
        <span className="ui-dd-edge ui-dd-edge--end" aria-hidden />
      </div>
    </>
  );

  const layer = !open ? null : isSheet ? (
    <>
      <div className="ui-dd-sheet-backdrop" onClick={dismiss} aria-hidden />
      <div
        ref={layerRef}
        className={layerClass}
        style={{ '--sheet-drag': `${dragY}px` } as React.CSSProperties}
      >
        <div
          className="ui-dd-sheet-grip"
          onPointerDown={onDragStart}
          onPointerMove={onDragMove}
          onPointerUp={onDragEnd}
          onPointerCancel={onDragEnd}
        >
          <span className="ui-dd-sheet-grip-bar" aria-hidden />
        </div>
        {panelBody}
      </div>
    </>
  ) : box ? (
    <div
      ref={layerRef}
      className={layerClass}
      style={anchorVars(box)}
      // Keep focus where it is when the user clicks an option -- EXCEPT on the
      // filter box, which is the one thing in here that wants the focus. Eating
      // its mousedown made the field unclickable, so on touch (where autofocus is
      // deliberately suppressed) there was no way to type into it at all.
      onMouseDown={e => {
        if (!(e.target as HTMLElement).closest?.('.ui-dd-search')) e.preventDefault();
      }}
    >
      {panelBody}
    </div>
  ) : null;

  // combobox, not listbox: the trigger OWNS the popup, it is not the list.
  const triggerAria = {
    role: 'combobox' as const,
    'aria-expanded': open,
    'aria-haspopup': 'listbox' as const,
    'aria-controls': open ? listId : undefined,
    'aria-activedescendant':
      open && !showSearch && activeIndex >= 0 ? `${listId}-opt-${activeIndex}` : undefined,
    'aria-label': ariaLabel,
    onKeyDown,
  };

  return (
    <div ref={rootRef} className={rootClass}>
      {multiple ? (
        // A div, not a button, because the chips carry their own remove buttons and
        // a button cannot nest a button. role + tabIndex + onKeyDown give it the
        // same keyboard contract the <button> branch gets for free.
        <div
          ref={el => { triggerRef.current = el; }}
          className="ui-dd-trigger ui-dd-trigger--chips"
          tabIndex={disabled ? -1 : 0}
          aria-disabled={disabled || undefined}
          {...triggerAria}
          onClick={() => !disabled && setOpen(!open)}
        >
          {Icon && <Icon className="ui-dd-icon" aria-hidden />}
          {chips.length === 0 ? (
            <span className="ui-dd-label ui-dd-placeholder">{placeholder ?? 'Select…'}</span>
          ) : (
            <span className="ui-dd-chips">
              {chips.map(c => {
                const chipDot = dotOf(c);
                return (
                  <span key={c.value} className="ui-dd-chip">
                    {chipDot && <span className={chipDot.className} style={chipDot.style} aria-hidden />}
                    <span style={chipDot ? { color: chipDot.color } : undefined}>{c.label}</span>
                    <button
                      type="button"
                      className="ui-dd-chip-x"
                      aria-label={`Remove ${c.label}`}
                      onClick={e => { e.stopPropagation(); removeChip(c.value); }}
                    >
                      <X />
                    </button>
                  </span>
                );
              })}
            </span>
          )}
          <ChevronDown className="ui-dd-chevron" aria-hidden />
        </div>
      ) : (
        <button
          ref={el => { triggerRef.current = el; }}
          type="button"
          className="ui-dd-trigger"
          disabled={disabled}
          {...triggerAria}
          onClick={() => !disabled && setOpen(!open)}
        >
          {Icon && <Icon className="ui-dd-icon" aria-hidden />}
          <span className="ui-dd-label">{singleLabel}</span>
          <ChevronDown className="ui-dd-chevron" aria-hidden />
        </button>
      )}
      {layer && createPortal(layer, document.body)}
    </div>
  );
}
