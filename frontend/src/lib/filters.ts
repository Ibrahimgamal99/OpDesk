import type { DropdownOption } from '../components/ui';

/**
 * Options for a filter built from the page's own data: only the values that occur on
 * the page, each with how many items carry it, plus the one currently selected (even
 * at zero) so an active filter can always be seen and cleared.
 */
export function presentOptions(
  all: DropdownOption[],
  counts: Record<string, number>,
  selected: string,
): DropdownOption[] {
  return all
    .filter((o) => (counts[o.value] ?? 0) > 0 || o.value === selected)
    .map((o) => ({ ...o, count: counts[o.value] ?? 0 }));
}

/** A filter is worth showing when it can tell at least two things apart, or is in use. */
export function showFilter(options: DropdownOption[], selected: string): boolean {
  return options.length >= 2 || Boolean(selected);
}

export function countBy<T>(items: T[], key: (item: T) => string | string[] | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of items) {
    const k = key(item);
    for (const v of Array.isArray(k) ? k : k ? [k] : []) out[v] = (out[v] ?? 0) + 1;
  }
  return out;
}
