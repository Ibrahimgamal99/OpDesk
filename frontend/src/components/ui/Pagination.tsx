import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';

/**
 * The one pager. `.cl-pagination` and `.an-pagination` were the same control
 * with different chrome — one had labelled buttons and a range readout, the
 * other bare ‹ › glyphs and a "page x / y" — so the same interaction looked and
 * announced differently depending on the screen.
 *
 * Two modes, because the backend genuinely has two pagination models:
 * `page`   — a known total (client-side slicing, or a counted query)
 * `cursor` — an opaque next_cursor with no total, so no page numbers exist
 */

interface PageModeProps {
  mode?: 'page';
  page: number;
  totalPages: number;
  onPage: (page: number) => void;
  /** Optional "showing 1–50 of 320" readout. */
  info?: string;
}

interface CursorModeProps {
  mode: 'cursor';
  /** Both are independent: a cursor pager can have a next and no previous. */
  hasPrev: boolean;
  hasNext: boolean;
  onPrev: () => void;
  onNext: () => void;
  info?: string;
}

export type PaginationProps = PageModeProps | CursorModeProps;

export function Pagination(props: PaginationProps) {
  const { t } = useTranslation();

  const isCursor = props.mode === 'cursor';
  const prevDisabled = isCursor ? !props.hasPrev : props.page <= 1;
  const nextDisabled = isCursor ? !props.hasNext : props.page >= props.totalPages;
  const goPrev = () => (isCursor ? props.onPrev() : props.onPage(Math.max(1, props.page - 1)));
  const goNext = () =>
    isCursor ? props.onNext() : props.onPage(Math.min(props.totalPages, props.page + 1));

  return (
    <nav className="ui-pagination" aria-label={t('common.pagination', 'Pagination')}>
      {props.info && <span className="ui-pagination-info">{props.info}</span>}
      <div className="ui-pagination-controls">
        <button
          className="btn btn-sm"
          disabled={prevDisabled}
          onClick={goPrev}
          aria-label={t('common.previousPage', 'Previous page')}
        >
          <ChevronLeft size={16} />
          <span className="ui-pagination-label">{t('common.previous', 'Previous')}</span>
        </button>
        {!isCursor && (
          /* aria-current marks which page you are on; the bare number did not
             say it was a position rather than a count. */
          <span className="ui-pagination-current" aria-current="page">
            {props.page}
            <span className="ui-pagination-total"> / {props.totalPages}</span>
          </span>
        )}
        <button
          className="btn btn-sm"
          disabled={nextDisabled}
          onClick={goNext}
          aria-label={t('common.nextPage', 'Next page')}
        >
          <span className="ui-pagination-label">{t('common.next', 'Next')}</span>
          <ChevronRight size={16} />
        </button>
      </div>
    </nav>
  );
}
