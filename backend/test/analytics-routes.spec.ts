/**
 * /api/analytics/*: the auth policy of every route, the role scope (agents refused,
 * supervisors limited to their groups, API keys unscoped), the timeline's and agent calls'
 * scope checks, the heatmap's queue filter, the drilldown parameters, the file exports
 * (byte layout, status and direction, the row cap, formula-safe cells, the adherence
 * columns, and GET /api/analytics/export/{report}) and the settings guard and validation.
 * The controller is called directly; the analytics service and db-manager are mocked.
 */

jest.mock('../src/core/security', () => ({ principalOf: (req: { principal?: unknown }) => req.principal ?? null }));
jest.mock('../src/db/db-manager', () => ({ setSetting: jest.fn() }));
jest.mock('../src/services/call-log', () => ({}));
jest.mock('../src/services/agent-state', () => ({}));
jest.mock('../src/services/analytics', () => {
  const actual = jest.requireActual('../src/services/analytics');
  return {
    ...actual,
    getSlaThresholds: jest.fn(async () => ({ '800': 20 })),
    getSlaDefaultSecs: jest.fn(async () => 20),
    getFcrSettings: jest.fn(async () => ({ window_days: 7, short_abandon_secs: 5, callback_window_hours: 24 })),
    saveSlaThresholds: jest.fn(async () => true),
    saveFcrSettings: jest.fn(async () => true),
    computeExecutiveKpis: jest.fn(),
    computeQueuePerformance: jest.fn(),
    computeAgentPerformance: jest.fn(),
    computeAgentAdherence: jest.fn(),
    computeAgentTimeline: jest.fn(),
    computeHourlyHeatmap: jest.fn(),
    computeVolumeSeries: jest.fn(),
    computeDrilldown: jest.fn(),
    computeAgentCalls: jest.fn(),
  };
});

import type { Readable } from 'stream';
import ExcelJS from 'exceljs';
import * as dbm from '../src/db/db-manager';
import * as analytics from '../src/services/analytics';
import { AUTH_POLICY } from '../src/api/routing';
import { RawResponse, StreamResponse } from '../src/api/respond';
import { AnalyticsController, fmtHms, reportTable } from '../src/api/routes/analytics.controller';

const ctl = new AnalyticsController();
const a = (name: keyof typeof analytics) => analytics[name] as unknown as jest.Mock;

const ADMIN = { id: 1, role: 'admin', allowed_agent_extensions: null, allowed_queue_names: null };
const API_KEY = { id: null, role: 'admin', api_key: true, allowed_agent_extensions: null, allowed_queue_names: null };
const SUP = { id: 2, role: 'supervisor', allowed_agent_extensions: ['201', '202'], allowed_queue_names: ['800'] };
const SUP_NO_GROUPS = { id: 4, role: 'supervisor', allowed_agent_extensions: [], allowed_queue_names: [] };
const AGENT = { id: 3, role: 'agent', extension: '201', allowed_agent_extensions: ['201'], allowed_queue_names: [] };

const req = (principal: unknown, query: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) =>
  ({ params: {}, query, body: {}, principal, ...extra }) as never;

async function bodyOf(r: unknown): Promise<Buffer> {
  if (r instanceof RawResponse) return Buffer.isBuffer(r.body) ? r.body : Buffer.from(r.body);
  const chunks: Buffer[] = [];
  for await (const c of (r as StreamResponse).stream as Readable) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks);
}

const headersOf = (r: unknown) => ((r as RawResponse | StreamResponse).init.headers ?? {}) as Record<string, string>;

beforeEach(() => jest.clearAllMocks());

describe('auth policies', () => {
  const policy = (name: keyof AnalyticsController) => Reflect.getMetadata(AUTH_POLICY, AnalyticsController.prototype[name]);

  test.each([
    'analyticsOverview', 'analyticsQueuePerformance', 'analyticsAgentPerformance', 'analyticsAgentCalls', 'analyticsAgentAdherence',
    'analyticsAgentTimeline', 'analyticsAgentAdherenceExport', 'analyticsHeatmap', 'analyticsTrend',
    'analyticsDrilldown', 'analyticsExport', 'analyticsReportExport',
  ] as const)('%s needs analytics:read', (name) => expect(policy(name)).toEqual({ scope: 'analytics:read' }));

  test('settings need a signed-in user (the handler checks admin)', () => {
    expect(policy('getAnalyticsSettings')).toBe('user');
    expect(policy('saveAnalyticsSettings')).toBe('user');
  });
});

describe('scope', () => {
  test('agents have no analytics at all, not even their own timeline', async () => {
    for (const call of [
      () => ctl.analyticsOverview(req(AGENT)),
      () => ctl.analyticsDrilldown(req(AGENT)),
      () => ctl.analyticsAgentTimeline(req(AGENT, { agent: '201' })),
      () => ctl.analyticsReportExport(req(AGENT, {}, { params: { report: 'trend' } })),
    ]) {
      await expect(call()).rejects.toMatchObject({ status: 403, message: 'Agents do not have access to analytics' });
    }
    expect(a('computeExecutiveKpis')).not.toHaveBeenCalled();
    expect(a('computeAgentTimeline')).not.toHaveBeenCalled();
  });

  test("a supervisor's reports are limited to their queues and agents", async () => {
    a('computeExecutiveKpis').mockResolvedValue({ current: {} });
    expect(await ctl.analyticsOverview(req(SUP, { date_from: '2026-10-01' }))).toEqual({ current: {} });
    expect(a('computeExecutiveKpis')).toHaveBeenCalledWith('2026-10-01', null, {
      allowedQueues: ['800'], allowedAgents: ['201', '202'],
      slaThresholds: { '800': 20 }, fcrCfg: { window_days: 7, short_abandon_secs: 5, callback_window_hours: 24 },
    });
    a('computeVolumeSeries').mockResolvedValue({ trend: [], hourly: [] });
    expect(await ctl.analyticsTrend(req(SUP))).toEqual({ trend: [], hourly: [] });
    expect(a('computeVolumeSeries')).toHaveBeenCalledWith(null, null, ['800'], ['201', '202']);
  });

  test("the heatmap's queue filter narrows within scope and never past it", async () => {
    a('computeHourlyHeatmap').mockResolvedValue({ matrix: [] });
    await ctl.analyticsHeatmap(req(SUP, { queue: '800' }));
    expect(a('computeHourlyHeatmap')).toHaveBeenLastCalledWith(null, null, ['800']);
    await ctl.analyticsHeatmap(req(SUP, { queue: '900' }));
    expect(a('computeHourlyHeatmap')).toHaveBeenLastCalledWith(null, null, []);
    await ctl.analyticsHeatmap(req(ADMIN, { queue: ' 900 ' }));
    expect(a('computeHourlyHeatmap')).toHaveBeenLastCalledWith(null, null, ['900']);
    await ctl.analyticsHeatmap(req(ADMIN, { queue: '' }));
    expect(a('computeHourlyHeatmap')).toHaveBeenLastCalledWith(null, null, null);
  });

  test("agent calls: a supervisor cannot open another group's agent", async () => {
    await expect(ctl.analyticsAgentCalls(req(SUP, { agent: '301' }))).rejects.toMatchObject({
      status: 403, message: 'Agent is outside your scope',
    });
    await expect(ctl.analyticsAgentCalls(req(ADMIN, { agent: 'Local/201' }))).rejects.toMatchObject({ status: 400 });
    await expect(ctl.analyticsAgentCalls(req(ADMIN, { agent: '201', direction: 'sideways' }))).rejects.toMatchObject({ status: 400 });
    expect(a('computeAgentCalls')).not.toHaveBeenCalled();
  });

  test('agent calls pass the filters and clamp the page', async () => {
    a('computeAgentCalls').mockResolvedValue({ calls: [], total: 0 });
    await ctl.analyticsAgentCalls(req(SUP, {
      agent: ' 202 ', direction: 'in', status: 'missed', page: '-3', page_size: '1000', date_from: '2026-10-01',
    }));
    expect(a('computeAgentCalls')).toHaveBeenCalledWith('202', '2026-10-01', null, {
      direction: 'in', status: 'missed', page: 1, pageSize: 200,
    });
  });

  test('a supervisor without groups sees nothing, never everything', async () => {
    a('computeHourlyHeatmap').mockResolvedValue({ matrix: [] });
    await ctl.analyticsHeatmap(req(SUP_NO_GROUPS));
    expect(a('computeHourlyHeatmap')).toHaveBeenCalledWith(null, null, []);
  });

  test('an API key reads unscoped', async () => {
    a('computeQueuePerformance').mockResolvedValue([{ queue_extension: '800' }]);
    expect(await ctl.analyticsQueuePerformance(req(API_KEY))).toEqual({ queues: [{ queue_extension: '800' }], short_abandon_secs: 5 });
    expect(a('computeQueuePerformance')).toHaveBeenCalledWith(null, null, expect.objectContaining({ allowedQueues: null }));
  });

  test("the timeline: a supervisor cannot open another group's agent", async () => {
    await expect(ctl.analyticsAgentTimeline(req(SUP, { agent: '301' }))).rejects.toMatchObject({
      status: 403, message: 'Agent is outside your scope',
    });
    a('computeAgentTimeline').mockResolvedValue({ agent: '201', sessions: [] });
    expect(await ctl.analyticsAgentTimeline(req(SUP, { agent: ' 201 ', date_from: '2026-10-05' }))).toEqual({ agent: '201', sessions: [] });
    expect(a('computeAgentTimeline')).toHaveBeenCalledWith('201', '2026-10-05', null);
  });

  test('the timeline requires an agent', async () => {
    await expect(ctl.analyticsAgentTimeline(req(ADMIN))).rejects.toMatchObject({ name: 'RequestValidationError' });
    await expect(ctl.analyticsAgentTimeline(req(ADMIN, { agent: '  ' }))).rejects.toMatchObject({ status: 400 });
  });

  test('an unexpected failure is a bare 500', async () => {
    a('computeAgentAdherence').mockRejectedValue(new Error('ECONNREFUSED 10.0.0.9'));
    await expect(ctl.analyticsAgentAdherence(req(ADMIN))).rejects.toMatchObject({ status: 500, message: 'Internal server error' });
  });
});

describe('drilldown', () => {
  test('page / page_size are clamped, facets and the status filter pass through', async () => {
    a('computeDrilldown').mockResolvedValue({ calls: [], total: 0, page: 1, page_size: 200 });
    await ctl.analyticsDrilldown(req(SUP, { page: '0', page_size: '500', disposition: 'NO ANSWER', facets: '1', direction: 'in' }));
    expect(a('computeDrilldown')).toHaveBeenCalledWith(null, null, {
      queueExt: null, agentExt: null, direction: 'in', dispositionFilter: 'NO ANSWER',
      page: 1, pageSize: 200, allowedQueues: ['800'], allowedAgents: ['201', '202'],
      slaThresholds: { '800': 20 }, facets: true,
    });
  });

  test('a non-integer page is a 400 validation error', async () => {
    await expect(ctl.analyticsDrilldown(req(ADMIN, { page: 'x' }))).rejects.toMatchObject({ name: 'RequestValidationError' });
  });
});

describe('exports', () => {
  const DRILL_CALLS = [
    { calldate: '2026-10-05T08:00:00', src: '+201011111111', queue_extension: '800', agent_extension: '201',
      duration: 60, talk: 40, wait_secs: 20, disposition: 'ANSWERED', status: 'ANSWERED', sla_met: true, direction: 'IN' },
    // A direct dial that rang out: the status the table shows, and no SLA verdict.
    { calldate: '2026-10-05T09:00:00', src: '=HYPERLINK("x")', queue_extension: '', agent_extension: '202',
      duration: 20, talk: 0, wait_secs: 0, disposition: 'NO ANSWER', status: 'MISSED', sla_met: false, direction: 'IN' },
  ];

  test('drilldown CSV: the status and direction the table shows, formula-safe cells', async () => {
    a('computeDrilldown').mockResolvedValue({ calls: DRILL_CALLS, total: 2 });
    const r = await ctl.analyticsExport(req(ADMIN, { date_from: '2026-10-05' }));
    expect(headersOf(r)['Content-Disposition']).toBe('attachment; filename="analytics_2026-10-05_all.csv"');
    expect(headersOf(r)['X-Export-Truncated']).toBeUndefined();
    expect((await bodyOf(r)).toString('utf8')).toBe(
      '﻿Date,Direction,Src,Queue,Agent,Duration(s),Talk(s),Wait(s),Status,SLA Met\r\n'
      + '"2026-10-05T08:00:00","Inbound","+201011111111","800","201","60","40","20","ANSWERED","Yes"\r\n'
      + '"2026-10-05T09:00:00","Inbound","\'=HYPERLINK(""x"")","","202","20","0","0","MISSED",""\r\n',
    );
    expect(a('computeDrilldown').mock.calls[0][2]).toMatchObject({ page: 1, pageSize: 100000 });
  });

  test('drilldown export past the row cap says so, in the file and a header', async () => {
    a('computeDrilldown').mockResolvedValue({ calls: [DRILL_CALLS[0]], total: 250000 });
    const r = await ctl.analyticsExport(req(ADMIN));
    expect(headersOf(r)['X-Export-Truncated']).toBe('250000');
    const lines = (await bodyOf(r)).toString('utf8').split('\r\n');
    expect(lines.slice(-3)).toEqual(['', '"Truncated: the first 1 of 250000 calls (narrow the range or filters for the rest)"', '']);

    const x = await ctl.analyticsExport(req(ADMIN, { format: 'xlsx' }));
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await bodyOf(x) as never);
    const ws = wb.getWorksheet('Analytics Export')!;
    expect(String(ws.getRow(4).getCell(1).value)).toMatch(/^Truncated: the first 1 of 250000/);
  });

  test('drilldown XLSX: a formula-looking value is text, numbers stay numbers', async () => {
    a('computeDrilldown').mockResolvedValue({ calls: DRILL_CALLS, total: 2 });
    const r = await ctl.analyticsExport(req(ADMIN, { format: 'xlsx' }));
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await bodyOf(r) as never);
    const ws = wb.getWorksheet('Analytics Export')!;
    expect(ws.getRow(1).getCell(9).value).toBe('Status');
    expect(ws.getRow(2).getCell(3).value).toBe('+201011111111');
    expect(ws.getRow(3).getCell(3).value).toBe('\'=HYPERLINK("x")');
    expect(ws.getRow(3).getCell(6).value).toBe(20);
  });

  const ADHERENCE = {
    agents: [{
      agent: '201', name: 'Mona', login: '2026-10-05T08:00:00', logout: '2026-10-05T17:00:00', logged_in: false,
      sessions: 2, logged_in_secs: 32400, ready_secs: 3600, on_call_secs: 7200, wrap_secs: 600, break_secs: 1800,
      not_ready_secs: 2700, dnd_secs: 300, occupancy_pct: 85.0,
      not_ready_breakdown: [{ code: 'lunch', label: 'Lunch', secs: 1800 }, { code: 'meeting', label: 'Meet "A"', secs: 900 }],
    }],
    reasons: [],
  };

  test('adherence CSV gains Sessions, Break and DND', async () => {
    a('computeAgentAdherence').mockResolvedValue(ADHERENCE);
    const r = await ctl.analyticsAgentAdherenceExport(req(SUP, { date_from: '2026-10-05', date_to: '2026-10-05' }));
    expect(a('computeAgentAdherence')).toHaveBeenCalledWith('2026-10-05', '2026-10-05', ['201', '202']);
    expect(headersOf(r)['Content-Disposition']).toMatch(/^attachment; filename="agent_adherence_2026-10-05_2026-10-05_\d{8}-\d{6}\.csv"$/);
    const lines = (await bodyOf(r)).toString('utf8').split('\r\n');
    expect(lines[0]).toMatch(/^﻿"Generated at: \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}"$/);
    expect(lines.slice(1, 6)).toEqual([
      '"Period: 2026-10-05 to 2026-10-05"',
      '',
      '"Agent","Name","Login","Logout","Still Logged In","Sessions","Logged In","Ready","On Call","Wrap-up","Break","Not Ready","DND","Occupancy %","Not Ready Breakdown"',
      '"201","Mona","2026-10-05T08:00:00","2026-10-05T17:00:00","No","2","09:00:00","01:00:00","02:00:00","00:10:00","00:30:00","00:45:00","00:05:00","85.0","Lunch: 00:30:00; Meet ""A"": 00:15:00"',
      '',
    ]);
  });

  test('adherence XLSX keeps the preamble and the numbers', async () => {
    a('computeAgentAdherence').mockResolvedValue(ADHERENCE);
    const r = await ctl.analyticsAgentAdherenceExport(req(ADMIN, { format: 'XLSX' }));
    expect(headersOf(r)['Content-Disposition']).toMatch(/agent_adherence_all_all_\d{8}-\d{6}\.xlsx"$/);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await bodyOf(r) as never);
    const ws = wb.getWorksheet('Agent Adherence')!;
    expect(String(ws.getRow(2).getCell(1).value)).toBe('Period: all to all');
    expect(ws.getRow(4).getCell(6).value).toBe('Sessions');
    expect(ws.getRow(5).getCell(14).value).toBe(85);
  });

  test('HH:MM:SS zero-padded like the report, blank on garbage', () => {
    expect(fmtHms(3725)).toBe('01:02:05');
    expect(fmtHms(null)).toBe('00:00:00');
    expect(fmtHms(-5)).toBe('00:00:00');
    expect(fmtHms('abc')).toBe('');
    expect(fmtHms(90061)).toBe('25:01:01');
    expect(fmtHms(360000)).toBe('100:00:00');
  });
});

describe('GET /api/analytics/export/{report}', () => {
  test('an unknown report is a 404', async () => {
    await expect(ctl.analyticsReportExport(req(ADMIN, {}, { params: { report: 'nope' } }))).rejects.toMatchObject({ status: 404 });
  });

  test('queues: the JSON rows under the JSON keys, scope applied', async () => {
    a('computeQueuePerformance').mockResolvedValue([
      { queue_extension: '800', queue_name: 'Sales', total_calls: 3, answered_calls: 2, abandoned_calls: 1,
        sla_pct: 50.0, aht_secs: 75, avg_wait_secs: 11.5, peak_hour: null, answer_rate: 66.7, talk_secs: 150, missed_calls: 1 },
    ]);
    const r = await ctl.analyticsReportExport(req(SUP, { date_from: '2026-10-01', date_to: '2026-10-07' }, { params: { report: 'queues' } }));
    expect(a('computeQueuePerformance')).toHaveBeenCalledWith('2026-10-01', '2026-10-07', expect.objectContaining({ allowedQueues: ['800'] }));
    expect(headersOf(r)['Content-Disposition']).toBe('attachment; filename="queues_2026-10-01_2026-10-07.csv"');
    expect((await bodyOf(r)).toString('utf8')).toBe(
      '﻿"queue_extension","queue_name","total_calls","answered_calls","abandoned_calls","sla_pct","aht_secs","avg_wait_secs","peak_hour","answer_rate","talk_secs","missed_calls","abandonment_rate","short_abandon_rate"\r\n'
      + '"800","Sales","3","2","1","50","75","11.5","","66.7","150","1","",""\r\n',
    );
  });

  test('overview: one row per KPI, nested blocks dotted, previous period beside', () => {
    const t = reportTable('overview', {
      period: { from: '2026-10-01', to: '2026-10-07' },
      current: { total_calls: 5, sla_pct: null, outbound: { total_calls: 2 }, combined: { answer_rate: 50.0 }, fcr_pct: 90.0 },
      prev_period: { total_calls: 4, sla_pct: 80.0, outbound: { total_calls: 1 }, combined: { answer_rate: 40.0 }, fcr_pct: null },
    });
    expect(t).toEqual([
      ['metric', 'current', 'prev_period'],
      ['period.from', '2026-10-01', '2026-09-24'],
      ['period.to', '2026-10-07', '2026-09-30'],
      ['total_calls', 5, 4],
      ['sla_pct', null, 80.0],
      ['outbound.total_calls', 2, 1],
      ['combined.answer_rate', 50.0, 40.0],
      ['fcr_pct', 90.0, null],
    ]);
  });

  test('overview past the comparable range: no previous period, blank bounds', () => {
    const t = reportTable('overview', {
      period: { from: '2026-08-01', to: '2026-10-01' }, current: { total_calls: 5 }, prev_period: null,
    });
    expect(t.slice(1)).toEqual([['period.from', '2026-08-01', null], ['period.to', '2026-10-01', null], ['total_calls', 5, null]]);
  });

  test('agents: daily_trend spreads over the last 7 days of the period', () => {
    const t = reportTable('agents', {
      agents: [{ rank: 1, agent_extension: '201', agent_name: 'Mona', total_calls: 3, answered_calls: 2, inbound_calls: 2,
        outbound_calls: 1, internal_calls: 4, aht_secs: 60, sla_contribution_pct: null, answer_rate: 50.0, talk_secs: 120,
        missed_calls: 1, daily_trend: [0, 1, 0, 0, 0, 0, 1] }],
    }, '2026-10-07');
    expect(t[0].slice(-7)).toEqual(['01', '02', '03', '04', '05', '06', '07'].map((d) => `daily_trend 2026-10-${d}`));
    expect(t[1]).toEqual([1, '201', 'Mona', 3, 2, 2, 1, 4, 60, null, 50.0, 120, 1, 0, 1, 0, 0, 0, 0, 1]);
  });

  test('heatmap: both matrices, one row per weekday', async () => {
    const matrix = Array.from({ length: 7 }, (_, d) => Array.from({ length: 24 }, (_, h) => d * 100 + h));
    a('computeHourlyHeatmap').mockResolvedValue({
      matrix, abandoned_matrix: matrix.map((r) => r.map(() => 0)), labels: { days: analytics.HEATMAP_DAYS, hours: analytics.HEATMAP_HOURS },
    });
    const r = await ctl.analyticsReportExport(req(ADMIN, { format: 'xlsx' }, { params: { report: 'heatmap' } }));
    expect(headersOf(r)['Content-Disposition']).toBe('attachment; filename="heatmap_all_all.xlsx"');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await bodyOf(r) as never);
    const ws = wb.getWorksheet('Heatmap')!;
    expect(ws.getRow(1).getCell(3).value).toBe('00:00');
    expect([ws.getRow(2).getCell(1).value, ws.getRow(2).getCell(2).value, ws.getRow(2).getCell(12).value]).toEqual(['matrix', 'Mon', 9]);
    expect([ws.getRow(15).getCell(1).value, ws.getRow(15).getCell(2).value]).toEqual(['abandoned_matrix', 'Sun']);
  });

  test('trend: one row per day', async () => {
    a('computeVolumeSeries').mockResolvedValue({
      trend: [{ date: '2026-10-05', total_calls: 2, answered_calls: 1, abandoned_calls: 1, outbound_total: 0, outbound_answered: 0,
        internal_total: 3, customers: 2, customers_answered: 1 }],
      hourly: [],
    });
    const text = (await bodyOf(await ctl.analyticsReportExport(req(ADMIN, {}, { params: { report: 'trend' } })))).toString('utf8');
    expect(text.split('\r\n')[1]).toBe('"2026-10-05","2","1","1","0","0","3","2","1"');
  });

  test('heatmap export follows the queue filter', async () => {
    a('computeHourlyHeatmap').mockResolvedValue({ matrix: [], abandoned_matrix: [] });
    await ctl.analyticsReportExport(req(SUP, { queue: '900' }, { params: { report: 'heatmap' } }));
    expect(a('computeHourlyHeatmap')).toHaveBeenCalledWith(null, null, []);
  });
});

describe('settings', () => {
  test('admin only', async () => {
    await expect(ctl.getAnalyticsSettings(req(SUP))).rejects.toMatchObject({ status: 403, message: 'Admin only' });
    await expect(ctl.saveAnalyticsSettings(req(SUP, {}, { body: {} }))).rejects.toMatchObject({ status: 403 });
  });

  test('read', async () => {
    expect(await ctl.getAnalyticsSettings(req(ADMIN))).toEqual({
      sla_thresholds: { '800': 20 }, sla_default_secs: 20, fcr_window_days: 7, short_abandon_secs: 5, callback_window_hours: 24,
    });
  });

  test('save: thresholds, default and the FCR row (missing fields keep their value)', async () => {
    (dbm.setSetting as jest.Mock).mockResolvedValue(true);
    expect(await ctl.saveAnalyticsSettings(req(ADMIN, {}, {
      body: { sla_thresholds: { '800': 30, '801': null }, sla_default_secs: '25', short_abandon_secs: 8 },
    }))).toEqual({ ok: true });
    expect(a('saveSlaThresholds')).toHaveBeenCalledWith({ '800': 30, '801': null });
    expect(dbm.setSetting).toHaveBeenCalledWith('SLA_DEFAULT_SECS', '25');
    expect(a('saveFcrSettings')).toHaveBeenCalledWith(7, 8, 24);
  });

  test('an FCR window of 0 (off) and the callback window are saved', async () => {
    expect(await ctl.saveAnalyticsSettings(req(ADMIN, {}, { body: { fcr_window_days: 0, callback_window_hours: 48 } }))).toEqual({ ok: true });
    expect(a('saveFcrSettings')).toHaveBeenCalledWith(0, 5, 48);
  });

  test.each([
    [{ sla_default_secs: 'abc' }, /sla_default_secs/],
    [{ sla_default_secs: 0 }, /sla_default_secs must be a whole number from 1 to 600/],
    [{ sla_default_secs: 2.5 }, /sla_default_secs/],
    [{ fcr_window_days: -1 }, /fcr_window_days must be a whole number from 0 to 90/],
    [{ short_abandon_secs: 121 }, /short_abandon_secs/],
    [{ callback_window_hours: 169 }, /callback_window_hours must be a whole number from 0 to 168/],
    [{ callback_window_hours: true }, /callback_window_hours/],
    [{ sla_thresholds: { '800': -5 } }, /sla_thresholds.800/],
    [{ sla_thresholds: { 's': 20 } }, /not a queue extension/],
    [{ sla_thresholds: [20] }, /sla_thresholds must be an object/],
  ])('%j is a 400 and nothing is saved', async (body, message) => {
    await expect(ctl.saveAnalyticsSettings(req(ADMIN, {}, { body: { short_abandon_secs: 8, ...body } })))
      .rejects.toMatchObject({ status: 400, message: expect.stringMatching(message) });
    expect(a('saveSlaThresholds')).not.toHaveBeenCalled();
    expect(a('saveFcrSettings')).not.toHaveBeenCalled();
    expect(dbm.setSetting).not.toHaveBeenCalled();
  });

  test('a write the database refuses is a 500, never { ok: true }', async () => {
    a('saveSlaThresholds').mockResolvedValueOnce(false);
    await expect(ctl.saveAnalyticsSettings(req(ADMIN, {}, { body: { sla_thresholds: { '800': 30 } } })))
      .rejects.toMatchObject({ status: 500 });
    a('saveFcrSettings').mockResolvedValueOnce(false);
    await expect(ctl.saveAnalyticsSettings(req(ADMIN, {}, { body: { fcr_window_days: 3 } })))
      .rejects.toMatchObject({ status: 500 });
    (dbm.setSetting as jest.Mock).mockResolvedValueOnce(false);
    await expect(ctl.saveAnalyticsSettings(req(ADMIN, {}, { body: { sla_default_secs: 30 } })))
      .rejects.toMatchObject({ status: 500 });
  });

  test('a non-object body is a 400', async () => {
    await expect(ctl.saveAnalyticsSettings(req(ADMIN, {}, { body: [1] }))).rejects.toMatchObject({ name: 'RequestValidationError' });
  });
});
