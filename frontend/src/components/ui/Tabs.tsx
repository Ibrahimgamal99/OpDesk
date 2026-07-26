import React from 'react';

export interface TabItem {
  key: string;
  label: string;
  icon?: React.ReactNode;
  count?: number;
}

interface TabsProps {
  tabs: TabItem[];
  active: string;
  onChange: (key: string) => void;
  className?: string;
}

export function Tabs({ tabs, active, onChange, className }: TabsProps) {
  return (
    <div className={`ui-tabs${className ? ` ${className}` : ''}`}>
      {tabs.map(t => (
        <button
          key={t.key}
          className={`ui-tab${active === t.key ? ' active' : ''}`}
          onClick={() => onChange(t.key)}
        >
          {t.icon}
          {t.label}
          {t.count !== undefined && (
            <span className="ui-tab-count">{t.count}</span>
          )}
        </button>
      ))}
    </div>
  );
}
