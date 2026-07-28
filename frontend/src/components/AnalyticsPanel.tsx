import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BarChart3, LayoutDashboard, Users, ListFilter, Layers, UserCheck } from 'lucide-react';
import { Page, Tabs } from './ui';
import '../styles/analytics.css';
import { AnalyticsOverview } from './AnalyticsOverview';
import { AnalyticsQueues } from './AnalyticsQueues';
import { AnalyticsAgents } from './AnalyticsAgents';
import { AnalyticsAdherence } from './AnalyticsAdherence';
import { AnalyticsDrilldown } from './AnalyticsDrilldown';
import { PageRange } from './PageRange';
import { type DateRange } from './analyticsUtils';

export type { DateRange };
export type AnalyticsTab = 'overview' | 'queues' | 'agents' | 'adherence' | 'drilldown';

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
    <Page
      icon={<BarChart3 size={18} />}
      title={t('analytics.title')}
      tabs={<Tabs tabs={tabs} active={tab} onChange={(k) => setTab(k as AnalyticsTab)} />}
      // No toolbar: the range is the only control this page has, and a range is
      // scope, not a filter. The page is header + tabs + charts.
      scope={<PageRange value={dateRange} onChange={onDateRangeChange} />}
    >
      <div className="an-tab-content">
        {tab === 'overview'  && <AnalyticsOverview  dateRange={dateRange} />}
        {tab === 'queues'    && <AnalyticsQueues    dateRange={dateRange} />}
        {tab === 'agents'    && <AnalyticsAgents    dateRange={dateRange} />}
        {tab === 'adherence' && <AnalyticsAdherence dateRange={dateRange} />}
        {tab === 'drilldown' && <AnalyticsDrilldown dateRange={dateRange} />}
      </div>
    </Page>
  );
}
