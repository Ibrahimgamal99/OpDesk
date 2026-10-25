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
    { key: 'overview',  label: t('analytics.nav.overview'),  icon: <LayoutDashboard size={14} /> },
    { key: 'queues',    label: t('analytics.nav.queues'),    icon: <Layers size={14} /> },
    { key: 'agents',    label: t('analytics.nav.agents'),    icon: <Users size={14} /> },
    { key: 'adherence', label: t('analytics.nav.adherence'), icon: <UserCheck size={14} /> },
    { key: 'drilldown', label: t('analytics.nav.drilldown'), icon: <ListFilter size={14} /> },
  ];

  return (
    <Page
      icon={BarChart3}
      title={t('nav.analytics')}
      className="an-panel"
      bodyClassName="an-tab-content"
      // The range is scope, not a filter: it is the question this page answers,
      // so it sits with the page's identity in the header.
      scope={<PageRange value={dateRange} onChange={onDateRangeChange} />}
      tabs={<Tabs tabs={tabs} active={tab} onChange={(k) => setTab(k as AnalyticsTab)} ariaLabel={t('nav.analytics')} />}
    >
      {tab === 'overview'  && <AnalyticsOverview  dateRange={dateRange} />}
      {tab === 'queues'    && <AnalyticsQueues    dateRange={dateRange} />}
      {tab === 'agents'    && <AnalyticsAgents    dateRange={dateRange} />}
      {tab === 'adherence' && <AnalyticsAdherence dateRange={dateRange} />}
      {tab === 'drilldown' && <AnalyticsDrilldown dateRange={dateRange} />}
    </Page>
  );
}
