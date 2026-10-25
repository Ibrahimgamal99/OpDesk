/**
 * One horizontal bar split into proportional bands.
 *
 * It existed twice as `.dash-wf-bar` -- the Dashboard hero's workforce band and the same bar
 * at `sm` on every queue card -- and was about to exist a third time in the Auto Dialer's lead
 * list, where the bands are call outcomes rather than agent states. The three agree on every
 * decision worth making once (flex proportions, a 2px gap, a pill radius, a tertiary ground
 * showing through when there is nothing to draw) and differ only in what a band MEANS, so the
 * meaning is the prop and the bar is the component.
 *
 * Colour arrives one of two ways, because the two callers genuinely differ: the Dashboard
 * names its states in a stylesheet (`.dash-wf-seg.busy`) and passes `segmentClass`, while the
 * dialer's outcome colours already exist as values in `callStatus.ts` and come in as
 * `color`. Neither is made to imitate the other -- a stylesheet that had to be generated from
 * a colour value, or a colour map duplicated into CSS, is how the third copy would have
 * started.
 */

export interface BarSegment {
  key: string;
  /** This band's share of the bar. Zero or less draws nothing. */
  value: number;
  /** Names the band in its tooltip. Without one the band gets no `title`. */
  label?: string;
  /** The band's fill. Omit when `segmentClass` points at a stylesheet rule instead. */
  color?: string;
}

export interface SegmentedBarProps {
  segments: BarSegment[];
  /** The bar's accessible name. It is one image, not a row of divs. */
  label: string;
  /** `sm` is the 8px bar that fits inside a card; `md` is the 12px standalone one. */
  size?: 'sm' | 'md';
  /** An extra class per band, for a caller that colours its bands from a stylesheet. */
  segmentClass?: (segment: BarSegment) => string | undefined;
  /** Makes every band a button. The bar becomes a group of controls rather than an image. */
  onSelect?: (key: string) => void;
  /** The chosen band, when `onSelect` is set. */
  activeKey?: string;
  className?: string;
}

export function SegmentedBar({
  segments, label, size = 'md', segmentClass, onSelect, activeKey, className,
}: SegmentedBarProps) {
  const drawn = segments.filter(s => s.value > 0);

  const bar = [
    'ui-bar',
    size === 'sm' && 'ui-bar--sm',
    onSelect && 'ui-bar--selectable',
    className,
  ].filter(Boolean).join(' ');

  /* Nothing to draw is a reading, not a missing one: a queue with no members and a campaign
     that has dialled nobody both get the full-width empty band rather than a collapsed bar,
     so the row keeps its height and does not reflow the moment the first figure arrives. */
  if (drawn.length === 0) {
    return (
      <div className={bar} role="img" aria-label={label}>
        <div className="ui-bar-seg ui-bar-seg--empty" />
      </div>
    );
  }

  return (
    /* A group when the bands are controls: `role="img"` on a box full of buttons would hide
       them from the same assistive tech the label is there to serve. */
    <div className={bar} role={onSelect ? 'group' : 'img'} aria-label={label}>
      {drawn.map(s => {
        const cls = [
          'ui-bar-seg',
          activeKey === s.key && 'ui-bar-seg--active',
          segmentClass?.(s),
        ].filter(Boolean).join(' ');
        /* flex-grow carries the proportion, so no caller has to work out a percentage and
           the bands always fill the bar exactly however the figures round. */
        const style = { flexGrow: s.value, background: s.color };
        const title = s.label ? `${s.label}: ${s.value}` : undefined;

        if (!onSelect) return <div key={s.key} className={cls} style={style} title={title} />;
        return (
          <button
            key={s.key}
            type="button"
            className={cls}
            style={style}
            title={title}
            aria-pressed={activeKey === s.key}
            aria-label={s.label ?? s.key}
            onClick={() => onSelect(s.key)}
          />
        );
      })}
    </div>
  );
}
