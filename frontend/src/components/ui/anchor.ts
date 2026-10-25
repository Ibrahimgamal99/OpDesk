import { useCallback, useEffect, useLayoutEffect, useState } from 'react';
import type React from 'react';

/**
 * Anchored-layer positioning — the one implementation.
 *
 * This is `Dropdown`'s positioning, lifted out unchanged the moment a second
 * control needed it (`Popover`, which `RangePicker` opens on). It is measured
 * against the viewport rather than laid out by the anchor, because both layers
 * portal to <body>. Were they laid out in place, an ancestor with
 * `overflow: hidden` would clip them — and the softphone, the settings rail and
 * every table wrap have one.
 *
 * Keeping one copy matters more here than it looks. Flipping, RTL anchoring and
 * the two-pass measure below are each a bug that was found once; a second
 * hand-rolled positioner would not have them, and the difference only shows up
 * on a short viewport in Arabic — exactly the combination nobody re-tests per
 * control.
 */

/**
 * First-pass height guess, used only for the single frame before the layer is in
 * the DOM and can be measured.
 *
 * Deliberately NOT a ceiling. It used to be one, and a fixed ceiling is why the
 * same menu showed eight options on a laptop and eight on a 1440p monitor with
 * 900px of free space going spare. The real cap is the space actually available;
 * this number only decides which side to open on for one frame.
 */
const ESTIMATED_LAYER_HEIGHT = 260;
/** Breathing room kept between the layer and the viewport edge. */
const VIEWPORT_MARGIN = 8;
const ANCHOR_GAP = 5;
/** Never collapse a layer to nothing on a very short viewport. */
const MIN_LAYER_HEIGHT = 120;
/**
 * Ceiling on the layer's height, as a share of the viewport.
 *
 * A share and not a pixel count, which is the distinction the old fixed 260px
 * ceiling missed: this grows with the screen, so a 1440p monitor gets a taller
 * menu instead of the laptop's eight options with 900px going spare.
 *
 * There has to be SOME ceiling, though, and letting the layer take all the room
 * available is not it. A menu two thirds of the screen tall reads as a page
 * rather than a menu, and -- worse -- a layer that always wants everything never
 * "fits" below its anchor, so it flipped above the trigger for any anchor in the
 * lower half of the page. Capped, the common case fits below and the menu opens
 * downward like every other one the user has used.
 */
const MAX_LAYER_VIEWPORT_SHARE = 0.55;
/**
 * Space below the anchor from which opening downward stops being worth it, even
 * against a roomier top side. Without a floor like this the menu changes sides
 * over a handful of pixels of difference, which reads as the menu deciding to
 * move rather than to fit.
 */
const FLIP_FLOOR = 180;

/**
 * Which viewport edges the layer is pinned to. Only one of top/bottom and one of
 * left/right is ever set: the layer anchors to the edge NEAREST the anchor so it
 * grows away from it, which means it can size to its content without the
 * anchoring drifting. All four are physical, because they come from
 * getBoundingClientRect()/innerWidth, which are physical in every writing mode.
 */
export interface AnchorBox {
  top?: number;
  bottom?: number;
  left?: number;
  right?: number;
  /** A floor, not a fixed width — long labels widen the layer instead of clipping. */
  minWidth: number;
  maxHeight: number;
  /** Above the anchor, so the entry animation can follow. */
  flipped: boolean;
}

export interface UseAnchorBoxOptions {
  open: boolean;
  /** The element the layer is positioned against. */
  anchorRef: React.RefObject<HTMLElement | null>;
  /** The layer itself, read for its natural height on the second pass. */
  layerRef: React.RefObject<HTMLElement | null>;
  /** Widen the layer past its anchor (a narrow trigger with long options). */
  minWidth?: number;
  /**
   * Which of the anchor's inline edges the layer lines up with. `start` for a
   * layer under a full-width control; `end` for a narrow trigger in a trailing
   * slot, where lining up the leading edges throws the layer off the far side
   * of the screen. Either way the result is clamped into the viewport.
   */
  align?: 'start' | 'end';
  /**
   * Optional ceiling on top of the available-space cap. Left unset the layer
   * sizes to its content and to the room the viewport actually offers, which is
   * what the overlay contract asks for; set it only for a layer that would be
   * absurd at full height.
   */
  maxHeight?: number;
  /**
   * Locks the layer to exactly this tall, skipping both the content-based
   * sizing and the available-space clamp. For a caller that wants a stable,
   * predictable panel over one that adapts to screen space -- accepting that
   * on a very short viewport it can run past the viewport edge, since nothing
   * shrinks it to fit any more.
   */
  fixedHeight?: number;
  /**
   * Re-place when the layer's own content changes size — option counts, a
   * filter box appearing, or whatever else moves scrollHeight after the first
   * pass.
   */
  deps?: readonly unknown[];
}

/**
 * Field by field, so a re-place that measured the same geometry -- which is most
 * of them, since this runs on every scroll and resize event -- does not re-render
 * the layer and everything inside it.
 */
function sameBox(a: AnchorBox, b: AnchorBox): boolean {
  return a.top === b.top && a.bottom === b.bottom
    && a.left === b.left && a.right === b.right
    && a.minWidth === b.minWidth && a.maxHeight === b.maxHeight
    && a.flipped === b.flipped;
}

/**
 * Position an open layer against its anchor, and keep it there while the page
 * scrolls or resizes. Returns null while closed.
 */
export function useAnchorBox({
  open, anchorRef, layerRef, minWidth, align = 'start',
  maxHeight, fixedHeight, deps = [],
}: UseAnchorBoxOptions): AnchorBox | null {
  const [box, setBox] = useState<AnchorBox | null>(null);

  /**
   * The layer's own content height, or null while it is not in the DOM yet.
   *
   * The cap has to come off to read this. `.ui-dd-menu` caps itself with
   * `max-block-size: var(--layer-max-h)` and scrolls an inner region, so with the
   * cap on nothing overflows the layer and `scrollHeight` reports the height the
   * PREVIOUS pass imposed rather than the content's. Every pass then fed on its
   * own last answer and the height could only ratchet down: one pass taken while
   * the anchor sat near the viewport edge pinned the layer at MIN_LAYER_HEIGHT --
   * two option rows -- and it stayed there for the rest of that open however much
   * room opened up afterwards. It broke flipping the same way, since a layer that
   * now claims to be 120px tall always "fits" below.
   *
   * The cap is dropped and restored inside one synchronous block, so no frame
   * ever paints the uncapped layer.
   */
  const measureNatural = useCallback((): number | null => {
    const layer = layerRef.current;
    if (!layer) return null;
    const capped = layer.style.maxBlockSize;
    layer.style.maxBlockSize = 'none';
    const natural = layer.scrollHeight;
    layer.style.maxBlockSize = capped;
    return natural;
  }, [layerRef]);

  const place = useCallback(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;
    const r = anchor.getBoundingClientRect();
    const layer = layerRef.current;
    const natural = measureNatural();
    // Content height, capped by the viewport share and by any explicit caller
    // ceiling. The room actually available is applied further down, against the
    // side actually chosen -- doing it here would clamp before the flip decision
    // and make the choice of side depend on the space it was about to pick.
    const ceiling = Math.min(
      maxHeight ?? Infinity,
      Math.round(window.innerHeight * MAX_LAYER_VIEWPORT_SHARE),
    );
    const desired = Math.min(natural ?? ESTIMATED_LAYER_HEIGHT, ceiling);
    // What the flip decision and the final height both measure against --
    // the fixed height itself when one was given, the content-derived figure
    // otherwise.
    const target = fixedHeight ?? desired;

    const below = window.innerHeight - r.bottom - ANCHOR_GAP - VIEWPORT_MARGIN;
    const above = r.top - ANCHOR_GAP - VIEWPORT_MARGIN;
    // Downward is the default and stays the default while what fits below is
    // still a usable menu: a layer that scrolls does not need the roomier side,
    // it needs a predictable one, and a list long enough to want the whole
    // viewport would otherwise open upward from every anchor below the fold.
    // A layer locked to `fixedHeight` cannot shrink into what is left, so for
    // that one the rule stays fit-or-flip.
    const flipped = fixedHeight !== undefined
      ? target > below && above > below
      : target > below && below < FLIP_FLOOR && above > below;
    const room = flipped ? above : below;
    // On the pass before the layer exists, cap it at the room available rather
    // than at the estimate. The layer sizes itself to its content either way, so
    // this paints it at the height it is going to keep -- capping at the estimate
    // instead made every list longer than the guess open at 260px and jump to its
    // real height one frame later.
    const height = fixedHeight
      ?? Math.max(MIN_LAYER_HEIGHT, Math.min(natural === null ? ceiling : desired, room));
    const rtl = getComputedStyle(anchor).direction === 'rtl';

    // ── Inline axis ──
    // The layer's real width, measured on the second pass exactly like its
    // height. Needed because the far edge has to be checked against the
    // viewport, and neither the anchor's width nor `minWidth` is that width:
    // the layer sizes to `max-content` between a floor and a CSS cap.
    const width = Math.min(
      Math.max(minWidth ?? 0, r.width, layer?.offsetWidth ?? 0),
      window.innerWidth - VIEWPORT_MARGIN * 2,
    );

    // Which physical edge lines up with which, once `align` is resolved through
    // the writing mode. Worked out in physical left coordinates because that is
    // what getBoundingClientRect and innerWidth speak.
    const pinFarEdge = rtl ? align === 'start' : align === 'end';
    let left = pinFarEdge ? r.right - width : r.left;
    // Collision: keep the whole layer on screen. Without this a narrow trigger
    // in a trailing slot — the date range in a page header — opened a panel
    // wider than itself that ran straight off the side of the viewport.
    left = Math.min(left, window.innerWidth - width - VIEWPORT_MARGIN);
    left = Math.max(left, VIEWPORT_MARGIN);

    const next: AnchorBox = {
      // Pin the block edge nearest the anchor. When flipped, anchoring by
      // `bottom` means the layer grows upward on its own — computing
      // `top = r.top - height` instead made the position depend on the height
      // estimate being right, so a mis-measure moved the layer rather than just
      // resizing it.
      ...(flipped
        ? { bottom: window.innerHeight - r.top + ANCHOR_GAP }
        : { top: r.bottom + ANCHOR_GAP }),
      // Pin the inline edge that faces INTO the page, so a layer that grows
      // (a longer option, a wider date field) grows toward the free space
      // rather than back over the viewport edge it was just clamped away from.
      ...(rtl
        ? { right: window.innerWidth - (left + width) }
        : { left }),
      minWidth: Math.max(r.width, minWidth ?? 0),
      maxHeight: height,
      flipped,
    };
    setBox(prev => (prev && sameBox(prev, next) ? prev : next));
  }, [anchorRef, layerRef, measureNatural, minWidth, align, maxHeight, fixedHeight]);

  useLayoutEffect(() => {
    if (!open) { setBox(null); return; }
    place();
    // Two passes: the first positions with an estimated height, the second
    // re-measures once the layer is in the DOM and knows its real height.
    const raf = requestAnimationFrame(place);
    // Scroll events do not bubble, so capture is the only phase that sees a
    // scroll inside an ancestor -- which does move the anchor and must re-place.
    // A scroll inside the LAYER cannot have moved it, though, and re-placing on
    // one is how the panel came to resize itself under the cursor while the user
    // was only scrolling its own option list.
    const onScroll = (e: Event) => {
      if (e.target instanceof Node && layerRef.current?.contains(e.target)) return;
      place();
    };
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', place);
    // The anchor's own height is not fixed: a multi-select trigger gains a row
    // when its chips wrap, and picking an option while the menu is open does
    // exactly that. Without this the menu stays where the shorter trigger used to
    // end and covers the chip row that just appeared.
    const ro = new ResizeObserver(place);
    if (anchorRef.current) ro.observe(anchorRef.current);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', place);
      ro.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, place, ...deps]);

  return box;
}

/**
 * The measured geometry as custom properties. Geometry is the one thing that
 * cannot be a class — it is measured per open — so it travels as variables and
 * the visual rules stay in CSS. Only the two pinned edges are emitted; the CSS
 * falls back to `auto` for the other two.
 */
export function anchorVars(box: AnchorBox): React.CSSProperties {
  return {
    ...(box.top !== undefined ? { '--layer-top': `${box.top}px` } : null),
    ...(box.bottom !== undefined ? { '--layer-bottom': `${box.bottom}px` } : null),
    ...(box.left !== undefined ? { '--layer-left': `${box.left}px` } : null),
    ...(box.right !== undefined ? { '--layer-right': `${box.right}px` } : null),
    '--layer-min-width': `${box.minWidth}px`,
    '--layer-max-h': `${box.maxHeight}px`,
  } as React.CSSProperties;
}

/**
 * The `md` breakpoint, as a query. Below it an anchored panel is the wrong
 * presentation -- the on-screen keyboard claims half the viewport and an anchored
 * list ends up behind it -- so the overlays switch to a bottom sheet.
 *
 * A literal rather than a token because custom properties do not resolve inside
 * `matchMedia`, and the value has to agree with the `md` breakpoint the
 * stylesheets use.
 */
export const SHEET_BREAKPOINT = '(max-width: 767px)';
/** Touch input. Drives hit-target sizing and suppresses search autofocus. */
export const COARSE_POINTER = '(pointer: coarse)';

/**
 * Subscribe to a media query. Here rather than in either overlay because both
 * need the same two queries above, and two copies would drift the breakpoint.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(query).matches,
  );

  useEffect(() => {
    const mq = window.matchMedia(query);
    const onChange = () => setMatches(mq.matches);
    // Sync once on subscribe: the query can have changed between the initial
    // render and this effect (a rotate during hydration).
    onChange();
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [query]);

  return matches;
}

/**
 * Close an open layer on a pointer-down outside every element in `within`.
 * A list of refs rather than one container, because a portalled layer is not
 * inside its own trigger's DOM subtree.
 */
export function useDismissOnOutside(
  open: boolean,
  onDismiss: () => void,
  within: readonly React.RefObject<HTMLElement | null>[],
) {
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (within.some(ref => ref.current?.contains(target))) return;
      onDismiss();
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, onDismiss, ...within]);
}
