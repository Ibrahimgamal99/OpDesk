import React, { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface AdvancedSectionProps {
  children: React.ReactNode;
  defaultOpen?: boolean;
  label?: string;
}

export function AdvancedSection({ children, defaultOpen = false, label }: AdvancedSectionProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(defaultOpen);
  const displayLabel = label ?? t('common.advanced', 'Advanced');

  return (
    <div className="ui-advanced">
      <button
        type="button"
        className="ui-advanced-toggle"
        onClick={() => setOpen(v => !v)}
        aria-expanded={open}
      >
        <span className="ui-advanced-chevron">
          {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </span>
        {displayLabel}
      </button>
      {open && <div className="ui-advanced-body">{children}</div>}
    </div>
  );
}
