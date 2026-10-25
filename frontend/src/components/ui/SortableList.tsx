import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { useTranslation } from 'react-i18next';

/**
 * A list the user puts in order with ↑/↓ buttons: first = top priority.
 *
 * Buttons rather than drag and drop, so it works the same with a keyboard, a
 * screen reader and a finger. After a move, focus stays on the moved item's
 * button — the one just pressed, or the other one when the item reached the
 * end — so pressing ↑ again keeps moving the same item. The new position is
 * announced, because the reorder is otherwise invisible to a screen reader.
 */
export interface SortableListProps<T> {
  /** In their current order. */
  items: T[];
  getKey: (item: T) => string;
  /** Short name used in the move buttons' labels and the announcement. */
  getLabel: (item: T) => string;
  /** The whole list in its new order. */
  onChange: (items: T[]) => void;
  /** The row's content, between the position number and the move buttons. */
  renderItem: (item: T, index: number) => ReactNode;
  /** Accessible name of the list. */
  label: string;
  disabled?: boolean;
  className?: string;
}

type Direction = 'up' | 'down';

export function SortableList<T>({
  items, getKey, getLabel, onChange, renderItem, label, disabled, className,
}: SortableListProps<T>) {
  const { t } = useTranslation();
  const buttons = useRef(new Map<string, HTMLButtonElement | null>());
  const [focusAfterMove, setFocusAfterMove] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');

  // After the render that shows the new order, so the button is in its new row.
  useEffect(() => {
    if (!focusAfterMove) return;
    buttons.current.get(focusAfterMove)?.focus();
    setFocusAfterMove(null);
  }, [focusAfterMove]);

  const move = (from: number, dir: Direction) => {
    const to = dir === 'up' ? from - 1 : from + 1;
    if (to < 0 || to >= items.length) return;
    const next = [...items];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    onChange(next);
    const atEnd = dir === 'up' ? to === 0 : to === items.length - 1;
    const keep: Direction = atEnd ? (dir === 'up' ? 'down' : 'up') : dir;
    setFocusAfterMove(`${getKey(item)}:${keep}`);
    setAnnouncement(t('common.movedToPosition', {
      name: getLabel(item), position: to + 1, total: items.length,
    }));
  };

  const moveButton = (item: T, index: number, dir: Direction) => {
    const key = getKey(item);
    const name = getLabel(item);
    const atEnd = dir === 'up' ? index === 0 : index === items.length - 1;
    const text = dir === 'up' ? t('common.moveUp', { name }) : t('common.moveDown', { name });
    return (
      <button
        type="button"
        className="btn btn-icon ui-sortable-move"
        ref={el => { buttons.current.set(`${key}:${dir}`, el); }}
        disabled={disabled || atEnd}
        onClick={() => move(index, dir)}
        aria-label={text}
        title={text}
      >
        {dir === 'up' ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
      </button>
    );
  };

  return (
    <>
      {/* role="list" restated: Safari drops list semantics from a list-style:none list,
          and the position number is aria-hidden, so VoiceOver would lose "3 of 7". */}
      <ol
        role="list"
        className={`ui-sortable${disabled ? ' is-disabled' : ''}${className ? ` ${className}` : ''}`}
        aria-label={label}
      >
        {items.map((item, i) => (
          <li key={getKey(item)} className="ui-sortable-item">
            <span className="ui-sortable-pos" aria-hidden="true">{i + 1}</span>
            <div className="ui-sortable-body">{renderItem(item, i)}</div>
            <div className="ui-sortable-moves">
              {moveButton(item, i, 'up')}
              {moveButton(item, i, 'down')}
            </div>
          </li>
        ))}
      </ol>
      <span className="ui-visually-hidden" aria-live="polite">{announcement}</span>
    </>
  );
}
