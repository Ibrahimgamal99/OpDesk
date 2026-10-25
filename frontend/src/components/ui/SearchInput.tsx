import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Loader2, Search, X } from 'lucide-react';
import type React from 'react';

/**
 * The only search field. Same icon at the inline-start, same clear button at the
 * inline-end, same Esc behaviour, same spinner slot, same height and radius as
 * every other control on a filter row, same debounce, same `?q=` sync.
 *
 * Before this, Call History had an unlabelled bare pill that swapped its
 * background on focus, and Teams had no search at all. The label is now always
 * present for assistive tech and never painted, which keeps a filter row one
 * control tall without leaving the input unlabelled.
 *
 * ## Who owns the debounce
 *
 * This component does. `value` is the *committed* term and `onChange` fires only
 * after the field goes quiet; the keystroke-by-keystroke text is internal, so
 * typing stays responsive without the parent re-fetching per character.
 *
 * Callers must therefore NOT debounce again. Call History kept its own 400ms
 * timer before this landed and it was removed with it — stacking a caller timer
 * on top of this one silently doubles that screen's latency, which is exactly
 * the failure this centralises away. A caller filtering a list already in
 * memory passes `debounceMs={0}` instead of dropping the component.
 *
 * Requires a Router ancestor because of `?q=`. Pass `urlSync={false}` outside
 * one, and on any screen that is not the route's primary list.
 */
export interface SearchInputProps {
  /** The committed term. */
  value: string;
  /** Fired once the field has been quiet for `debounceMs`. */
  onChange: (v: string) => void;
  /** Required, never a placeholder standing in for one. Visually hidden. */
  label: string;
  placeholder?: string;
  loading?: boolean;
  /**
   * Mirror the committed term to `?q=`, and adopt `?q=` on mount so a pasted
   * link lands on the same results. At most one SearchInput per route may own
   * it; the app mounts one panel at a time, so that holds.
   */
  urlSync?: boolean;
  debounceMs?: number;
  className?: string;
}

export function SearchInput({
  value, onChange, label, placeholder, loading,
  urlSync = true, debounceMs = 250, className,
}: SearchInputProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState(value);

  // What we last handed the parent. Distinguishes "the parent is handing our value back"
  // from "the parent changed the term itself", which is what makes adopting
  // external changes safe without clobbering in-flight typing.
  const committed = useRef(value);

  // onChange is usually an inline arrow, so its identity changes every parent
  // render. Held in a ref so the debounce effect does not restart its timer on
  // unrelated re-renders — that would push the commit out indefinitely.
  const onChangeRef = useRef(onChange);
  useEffect(() => { onChangeRef.current = onChange; }, [onChange]);

  const commit = useCallback((next: string) => {
    committed.current = next;
    setDraft(next);
    onChangeRef.current(next);
  }, []);

  const [params, setParams] = useSearchParams();

  // Seed from ?q= once, for deep links and reloads.
  const seeded = useRef(false);
  useEffect(() => {
    if (!urlSync || seeded.current) return;
    seeded.current = true;
    const q = params.get('q') ?? '';
    if (q && q !== committed.current) commit(q);
  }, [urlSync, params, commit]);

  // Adopt a term the parent changed on its own (reset button, route change).
  useEffect(() => {
    if (value !== committed.current) {
      committed.current = value;
      setDraft(value);
    }
  }, [value]);

  // draft -> committed, debounced.
  useEffect(() => {
    if (draft === committed.current) return;
    const id = window.setTimeout(() => {
      committed.current = draft;
      onChangeRef.current(draft);
    }, debounceMs);
    return () => window.clearTimeout(id);
  }, [draft, debounceMs]);

  // committed -> ?q=. The updater form preserves sibling params such as ?tab=.
  useEffect(() => {
    if (!urlSync) return;
    setParams(prev => {
      const next = new URLSearchParams(prev);
      if (next.get('q') === (value || null)) return next;
      if (value) next.set('q', value);
      else next.delete('q');
      return next;
    }, { replace: true });
  }, [value, urlSync, setParams]);

  const clear = () => {
    // Immediate, not debounced: waiting for the timer to empty a field the user
    // just emptied reads as lag.
    commit('');
    inputRef.current?.focus();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Escape') return;
    // Clear first; blur only once there is nothing left to clear, so Esc is
    // never a single keystroke that both empties the field and loses the caret.
    if (draft) {
      e.stopPropagation();
      commit('');
    } else {
      inputRef.current?.blur();
    }
  };

  const id = `search-${label.replace(/\s+/g, '-').toLowerCase()}`;

  return (
    <div className={`ui-search${className ? ` ${className}` : ''}`}>
      <label className="ui-visually-hidden" htmlFor={id}>{label}</label>
      <Search size={15} className="ui-search-icon" aria-hidden="true" />
      <input
        id={id}
        ref={inputRef}
        className="ui-search-input"
        type="search"
        value={draft}
        placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={handleKeyDown}
      />
      {loading && <Loader2 size={14} className="ui-search-spinner spinner" aria-hidden="true" />}
      {!loading && draft && (
        <button type="button" className="ui-search-clear" onClick={clear} aria-label={`Clear ${label}`}>
          <X size={14} />
        </button>
      )}
    </div>
  );
}
