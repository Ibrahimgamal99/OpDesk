import React from 'react';
import type { LucideIcon } from 'lucide-react';

/**
 * What a list, table or panel shows when it has nothing to show. Names what
 * would be here and, when there is one, the action that adds the first item.
 */
export interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  description?: React.ReactNode;
  action?: React.ReactNode;
  /** `sm` for an empty table body or a side panel; `md` for a whole page. */
  size?: 'sm' | 'md';
  className?: string;
}

export function EmptyState({ icon: Icon, title, description, action, size = 'md', className }: EmptyStateProps) {
  return (
    <div className={`ui-empty ui-empty--${size}${className ? ` ${className}` : ''}`}>
      <span className="ui-empty-icon"><Icon size={size === 'sm' ? 18 : 22} aria-hidden /></span>
      <div className="ui-empty-title">{title}</div>
      {description && <div className="ui-empty-desc">{description}</div>}
      {action && <div className="ui-empty-action">{action}</div>}
    </div>
  );
}
