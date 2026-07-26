import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BarChart3, LayoutDashboard, Users, ListFilter, Layers, CalendarRange, UserCheck } from 'lucide-react';
import { Tabs } from './ui';
import '../styles/analytics.css';
import { AnalyticsOverview } from './AnalyticsOverview';
import { AnalyticsQueues } from './AnalyticsQueues';
import { AnalyticsAgents } from './AnalyticsAgents';
import { AnalyticsAdherence } from './AnalyticsAdherence';
import { AnalyticsDrilldown } from './AnalyticsDrilldown';
import {
  type DateRange, type QuickSelect,
  todayStr, quickRanges, matchQuick,
} from './analyticsUtils';

export type { DateRange };
export type AnalyticsTab = 'overview' | 'queues' | 'agents' | 'adherence' | 'drilldown';

interface PeriodPickerProps {
  value: DateRange;
  onChange: (r: DateRange) => void;
  layout?: 'row' | 'column';
}

export function PeriodPicker({ value, onChange, layout = 'column' }: PeriodPickerProps) {
  const { t } = useTranslation();
  const active = matchQuick(value);
  const ranges = quickRanges();

  // Custom mode: explicitly opened, or the current range matches no preset.
  const [customOpen, setCustomOpen] = useState(active === null);
  const isCustom = customOpen || active === null;

  const buttons: { key: QuickSelect; label: string }[] = [
    { key: 'today',     label: t('analytics.period.today') },
    { key: 'yesterday', label: t('analytics.period.yesterday') },
    { key: '7d',        label: t('analytics.period.last7') },
    { key: '30d',       label: t('analytics.period.last30') },
  ];

  return (
    <div className={`an-period-picker${layout === 'row' ? ' row' : ''}`}>
      {/* Row 1 — individual pill chips */}
      <div className="an-period-quick">
        {buttons.map(b => (
          <button
            key={b.key}
            className={`an-period-btn${!isCustom && active === b.key ? ' active' : ''}`}
            onClick={() => { setCustomOpen(false); onChange(ranges[b.key]); }}
          >
            {b.label}
          </button>
        ))}
        <button
          className={`an-period-btn${isCustom ? ' active' : ''}`}
          onClick={() => setCustomOpen(true)}
        >
          {t('analytics.period.custom')}
        </button>
      </div>

      {/* Row 2 — unified date-range bar (only in custom mode) */}
      {isCustom && (
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
      )}
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

  const tabs = [
    { key: 'overview',  label: t('analytics.nav.overview'),  icon: <LayoutDashboard size={13} /> },
    { key: 'queues',    label: t('analytics.nav.queues'),    icon: <Layers size={13} /> },
    { key: 'agents',    label: t('analytics.nav.agents'),    icon: <Users size={13} /> },
    { key: 'adherence', label: t('analytics.nav.adherence'), icon: <UserCheck size={13} /> },
    { key: 'drilldown', label: t('analytics.nav.drilldown'), icon: <ListFilter size={13} /> },
  ];

  return (
    <div className="panel an-panel">
      <div className="panel-header an-header">
        <h2 className="panel-title">
          <BarChart3 size={16} className="panel-title-icon" />
          {t('analytics.title')}
        </h2>
        <div className="panel-header-actions">
          <PeriodPicker value={dateRange} onChange={onDateRangeChange} />
        </div>
      </div>

      <div className="an-subtabs-wrap">
        <Tabs tabs={tabs} active={tab} onChange={(k) => setTab(k as AnalyticsTab)} />
      </div>

      <div className="an-tab-content">
        {tab === 'overview'  && <AnalyticsOverview  dateRange={dateRange} />}
        {tab === 'queues'    && <AnalyticsQueues    dateRange={dateRange} />}
        {tab === 'agents'    && <AnalyticsAgents    dateRange={dateRange} />}
        {tab === 'adherence' && <AnalyticsAdherence dateRange={dateRange} />}
        {tab === 'drilldown' && <AnalyticsDrilldown dateRange={dateRange} />}
      </div>
    </div>
  );
}
