import { useTranslation } from 'react-i18next';
import { RangePicker } from './ui';
import { type DateRange, rangePresets, todayStr } from './analyticsUtils';

/**
 * ui/RangePicker bound to this app: its preset list, its translations, its
 * "no future dates" rule, its locale.
 *
 * This is not a second implementation of the control and must never grow into
 * one — it renders no markup and no styles of its own, and every visual decision
 * stays in ui/RangePicker. It exists because ui/ carries no i18n dependency, so
 * without it each of the three screens would repeat the same five props and be
 * free to repeat them differently. Anything visual belongs upstream in
 * ui/RangePicker as a prop.
 */
export interface PageRangeProps {
  value: DateRange;
  onChange: (r: DateRange) => void;
}

export function PageRange({ value, onChange }: PageRangeProps) {
  const { t, i18n } = useTranslation();

  return (
    <RangePicker
      value={value}
      onChange={onChange}
      presets={rangePresets(t)}
      label={t('analytics.period.label', 'Date range')}
      customLabel={t('analytics.period.custom')}
      // Calls cannot happen in the future, so an end date past today would only
      // ever return the same rows as today.
      max={todayStr()}
      locale={i18n.language}
    />
  );
}
