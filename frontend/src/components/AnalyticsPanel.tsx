import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BarChart3, LayoutDashboard, Users, ListFilter, Layers, CalendarRange } from 'lucide-react';
import '../styles/analytics.css';
import { AnalyticsOverview } from './AnalyticsOverview';
import { AnalyticsQueues } from './AnalyticsQueues';
import { AnalyticsAgents } from './AnalyticsAgents';
import { AnalyticsDrilldown } from './AnalyticsDrilldown';
import {
  type DateRange, type QuickSelect,
  todayStr, quickRanges, matchQuick,
} from './analyticsUtils';

export type { DateRange };
export type AnalyticsTab = 'overview' | 'queues' | 'agents' | 'drilldown';

interface PeriodPickerProps {
  value: DateRange;
  onChange: (r: DateRange) => void;
  layout?: 'row' | 'column';
}

export function PeriodPicker({ value, onChange, layout = 'column' }: PeriodPickerProps) {
  const { t } = useTranslation();
  const active = matchQuick(value);
  const ranges = quickRanges();

  const buttons: { key: QuickSelect; label: string }[] = [
    { key: 'today',     label: t('analytics.period.today') },
    { key: 'yesterday', label: t('analytics.period.yesterday') },
    { key: '7d',        label: t('analytics.period.last7') },
    { key: '30d',       label: t('analytics.period.last30') },
    { key: 'month',     label: t('analytics.period.thisMonth') },
  ];

  return (
    <div className={`an-period-picker${layout === 'row' ? ' row' : ''}`}>
      {/* Row 1 — individual pill chips */}
      <div className="an-period-quick">
        {buttons.map(b => (
          <button
            key={b.key}
            className={`an-period-btn${active === b.key ? ' active' : ''}`}
            onClick={() => onChange(ranges[b.key])}
          >
            {b.label}
          </button>
        ))}
      </div>

      {/* Row 2 — unified date-range bar */}
      <div className="an-period-custom">
        <CalendarRange size={14} className="an-period-cal-icon" />
        <input
          type="date"
          className="an-date-input"
          value={value.from}
          max={todayStr()}
          onChange={e => {
            const from = e.target.value;
            onChange({ from, to: from > value.to ? from : value.to });
          }}
        />
        <span className="an-period-sep">→</span>
        <input
          type="date"
          className="an-date-input"
          value={value.to}
          max={todayStr()}
          onChange={e => {
            const to = e.target.value;
            onChange({ from: to < value.from ? to : value.from, to });
          }}
        />
      </div>
    </div>
  );
}

interface AnalyticsPanelProps {
  dateRange: DateRange;
  onDateRangeChange: (r: DateRange) => void;
}

export function AnalyticsPanel({ dateRange, onDateRangeChange }: AnalyticsPanelProps) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<AnalyticsTab>('overview');

  const tabs: { key: AnalyticsTab; label: string; Icon: React.ElementType }[] = [
    { key: 'overview',  label: t('analytics.nav.overview'),  Icon: LayoutDashboard },
    { key: 'queues',    label: t('analytics.nav.queues'),    Icon: Layers },
    { key: 'agents',    label: t('analytics.nav.agents'),    Icon: Users },
    { key: 'drilldown', label: t('analytics.nav.drilldown'), Icon: ListFilter },
  ];

  return (
    <div className="an-panel">
      <div className="an-header">
        <div className="an-header-left">
          <BarChart3 size={17} style={{ color: 'var(--accent-primary)', flexShrink: 0 }} />
          <span className="an-header-title">{t('analytics.title')}</span>
        </div>
      </div>

      <PeriodPicker value={dateRange} onChange={onDateRangeChange} layout="row" />

      <div className="an-subtabs-wrap">
        <div className="an-subtabs">
          {tabs.map(({ key, label, Icon }) => (
            <button
              key={key}
              className={`an-subtab${tab === key ? ' active' : ''}`}
              onClick={() => setTab(key)}
            >
              <Icon size={13} />
              {label}
            </button>
          ))}
        </div>
      </div>

      {tab === 'overview'  && <AnalyticsOverview  dateRange={dateRange} />}
      {tab === 'queues'    && <AnalyticsQueues    dateRange={dateRange} />}
      {tab === 'agents'    && <AnalyticsAgents    dateRange={dateRange} />}
      {tab === 'drilldown' && <AnalyticsDrilldown dateRange={dateRange} />}
    </div>
  );
}
