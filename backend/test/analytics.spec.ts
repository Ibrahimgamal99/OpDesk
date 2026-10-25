/**
 * services/analytics: the KPI math (pinned to values the Python analytics.py produced for
 * the same rows), the call-history-backed reports, the drilldown's status filter and
 * facets, and the adherence session model (sessions, break, DND, shift boundary).
 * The database, the call-log scan and the shift setting are mocked.
 */

jest.mock('../src/db/pool', () => ({
  query: jest.fn(),
  queryOne: jest.fn(),
  execute: jest.fn(),
  withTransaction: jest.fn(async (fn: (c: unknown) => unknown) => fn('conn')),
  placeholders: (n: number) => new Array(n).fill('?').join(', '),
}));
jest.mock('../src/db/db-manager', () => ({
  getSetting: jest.fn(async (_k: string, d: unknown) => d),
  setSetting: jest.fn(),
  pruneStaleDeviceTokens: jest.fn(async () => 0),
  pruneWebhookDeliveries: jest.fn(async () => 0),
}));
jest.mock('../src/services/call-log', () => ({
  callLog: jest.fn(),
  classifyCdrDirection: jest.fn(() => 'IN'),
  mapCallOutcome: jest.fn(() => 'FAILURE'),
}));
jest.mock('../src/services/agent-state', () => ({ shiftResetMinutes: jest.fn(async () => 0) }));

import * as pool from '../src/db/pool';
import * as dbm from '../src/db/db-manager';
import { callLog } from '../src/services/call-log';
import { shiftResetMinutes } from '../src/services/agent-state';
import * as A from '../src/services/analytics';

const mocked = (fn: unknown) => fn as jest.Mock;
const dt = (s: string) => {
  const [d, t = '00:00:00'] = s.split(' ');
  const [y, mo, da] = d.split('-').map(Number);
  const [h, mi, se] = t.split(':').map(Number);
  return new Date(y, mo - 1, da, h, mi, se);
};

/** Settings reads: no per-queue thresholds, the stored FCR row, SLA default 20. */
function settings(thresholds: Record<string, number> = {}) {
  mocked(pool.query).mockImplementation(async (sql: string) => {
    if (sql.includes('analytics_sla_settings')) return Object.entries(thresholds).map(([q, s]) => ({ queue_extension: q, threshold_secs: s }));
    if (sql.includes('FROM agents')) return [{ extension: '201', name: 'Mona' }];
    if (sql.includes('FROM queues')) return [{ extension: '800', queue_name: 'Sales' }];
    return [];
  });
  mocked(pool.queryOne).mockResolvedValue({ window_days: 0, short_abandon_secs: 5 });
}

beforeEach(() => {
  jest.clearAllMocks();
  mocked(dbm.getSetting).mockImplementation(async (_k: string, d: unknown) => d);
});

describe('number keys and people rates', () => {
  test('outside numbers compare on their last nine digits; short ones are extensions', () => {
    expect(A.numberKey('01012345678')).toBe('012345678');
    expect(A.numberKey('+201012345678')).toBe('012345678');
    expect(A.numberKey('101')).toBe('');
    expect(A.numberKey(null)).toBe('');
    expect(A.numberKey('555-1234')).toBe('5551234');
  });

  // Rows and expected figures are the Python _compute_directional_kpis on the same input.
  const ROWS = [
    ['IN', '012345678', 'ANSWERED', 'ANSWERED', '800', 10, 125],
    ['IN', '012345678', 'NO ANSWER', 'UNANSWERED', '800', 4, 0],
    ['IN', '109999999', 'NO ANSWER', 'UNANSWERED', '801', 40, 0],
    ['IN', '109999999', 'ANSWERED', 'ANSWERED', '801', 31, 60],
    ['IN', '5551234', 'ANSWERED', 'ANSWERED', '', 0, 33],
    ['OUT', '122222222', 'BUSY', 'BUSY', '', 0, 0],
    ['OUT', '122222222', 'ANSWERED', 'ANSWERED', '', 0, 91],
    ['OUT', '133333333', 'FAILED', 'FAILURE', '', 0, 0],
    ['OUT', '144444444', 'NO ANSWER', 'UNANSWERED', '', 0, 0],
    ['INTERNAL', '', 'ANSWERED', 'ANSWERED', '', 0, 12],
  ].map(([direction, counterparty, disposition, status, queue_ext, wait_secs, billsec]) => ({
    direction, counterparty, disposition, status, queue_ext, wait_secs, billsec, total_dur: 0,
  }));

  test('directional KPIs match the Python figures', () => {
    expect(A.computeDirectionalKpis(ROWS, { '800': 15, '801': 30 }, 20, 5)).toEqual({
      abandoned_calls: 2, abandonment_rate: 40.0, aht_secs: 73, answer_rate: 100.0, answered_calls: 3,
      avg_wait_secs: 17.0, contact_rate: 60.0, customers: 3, customers_answered: 3,
      short_abandon_rate: 20.0, short_abandoned: 1, sla_met_calls: 2, sla_pct: 66.7, sum_billsec: 218,
      sum_wait_secs: 85, total_calls: 5,
      combined: {
        aht_secs: 64, answer_rate: 66.7, answered_calls: 5, contact_rate: 50.0, customers: 6,
        customers_answered: 4, internal_calls: 1, total_calls: 10,
      },
      outbound: {
        aht_secs: 91, answer_rate: 33.3, answered_calls: 1, busy_calls: 1, contact_rate: 25.0, customers: 3,
        customers_answered: 1, failed_calls: 1, no_answer_calls: 1, sum_billsec: 91, total_calls: 4,
      },
    });
  });

  test('rates round half to even, as Python round() does', () => {
    const k = A.deriveRates({
      total_calls: 8, answered_calls: 8, abandoned_calls: 0, short_abandoned: 0,
      sla_met_calls: 0, sum_wait_secs: 0, sum_billsec: 20,
    });
    expect(k.aht_secs).toBe(2); // 2.5 -> 2
  });
});

describe('dates', () => {
  test('the default range is the last 30 days ending today', () => {
    const [from, to] = A.defaultDates(null, '');
    expect(to).toBe(A.addDaysYmd(from, 30));
  });

  test('the previous period has the same length and ends the day before', () => {
    expect(A.previousPeriod('2026-10-01', '2026-10-07')).toEqual(['2026-09-24', '2026-09-30']);
    expect(A.previousPeriod('2026-03-01', '2026-03-01')).toEqual(['2026-02-28', '2026-02-28']);
  });

  test('a malformed date raises (the route answers 500)', () => {
    expect(() => A.previousPeriod('2026-02-30', '2026-03-01')).toThrow(A.ValueError);
  });
});

const call = (over: Record<string, unknown>) => ({
  calldate: dt('2026-10-05 10:00:00'), src: '01011111111', dst: '800', duration: 60, talk: 40,
  disposition: 'ANSWERED', status: 'ANSWERED', extension: '201', call_type: 'IN', linkedid: 'L1', ...over,
});

describe('executive KPIs', () => {
  test('current and previous period come from the call-history scan, queue scope applied', async () => {
    settings();
    mocked(callLog).mockImplementation(async (o: { dateFrom: string }) =>
      o.dateFrom === '2026-10-01'
        ? [call({}), call({ dst: '900', linkedid: 'L2' }), call({ call_type: 'OUT', dst: '0122222222', src: '201' })]
        : [call({ disposition: 'NO ANSWER', status: 'UNANSWERED', talk: 0 })],
    );
    const r = await A.computeExecutiveKpis('2026-10-01', '2026-10-07', { allowedQueues: ['800'], allowedAgents: ['201'] });
    expect(r.period).toEqual({ from: '2026-10-01', to: '2026-10-07' });
    expect(mocked(callLog).mock.calls.map((c) => [c[0].dateFrom, c[0].dateTo, c[0].allowedExtensions, c[0].enrich])).toEqual([
      ['2026-10-01', '2026-10-07', ['201'], false],
      ['2026-09-24', '2026-09-30', ['201'], false],
    ]);
    // queue 900 is outside the supervisor's queues
    expect(r.current.total_calls).toBe(1);
    expect(r.current.wait_secs).toBeUndefined();
    expect(r.current.avg_wait_secs).toBe(20.0);
    expect(r.current.outbound.total_calls).toBe(1);
    expect(r.current.combined.total_calls).toBe(2);
    expect(r.current.fcr_pct).toBeNull(); // window_days 0 = off
    expect(r.prev_period.abandoned_calls).toBe(1);
    expect(r.prev_period.answer_rate).toBe(0.0);
  });
});

describe('agent performance', () => {
  test('per-agent totals, SLA contribution, 7-day trend and rank', async () => {
    settings({ '800': 15 });
    mocked(callLog).mockResolvedValue([
      call({ calldate: dt('2026-10-07 09:00:00') }), // wait 20 > 15
      call({ calldate: dt('2026-10-07 09:30:00'), duration: 50 }), // wait 10
      call({ extension: '202', calldate: dt('2026-10-06 09:00:00') }),
      call({ extension: '202', call_type: 'OUT', dst: '0100', calldate: dt('2026-10-01 09:00:00') }),
      call({ extension: '202', disposition: 'NO ANSWER', talk: 0 }),
      call({ extension: 'Local/x' }), // not an extension: skipped
    ]);
    const rows = await A.computeAgentPerformance('2026-10-01', '2026-10-07', { allowedAgents: null });
    // Ties on answered keep first-seen order (Python's stable sort).
    expect(rows.map((r) => [r.agent_extension, r.rank, r.answered_calls, r.total_calls])).toEqual([
      ['201', 1, 2, 2],
      ['202', 2, 2, 3],
    ]);
    expect(rows[0].agent_name).toBe('Mona');
    expect(rows[0].sla_contribution_pct).toBe(50.0);
    expect(rows[0].daily_trend).toEqual([0, 0, 0, 0, 0, 0, 2]);
    expect(rows[1].agent_name).toBe('202');
    expect(rows[1].daily_trend).toEqual([1, 0, 0, 0, 0, 1, 0]);
    expect(rows[1].outbound_calls).toBe(1);
    expect(rows[1].sla_contribution_pct).toBe(0.0); // wait 20 > 15
    // compare-chart extras: one outside caller (rang twice, reached once; '0100' is too short
    // to be an outside number), talk of the answered calls, the inbound call missed
    expect(rows[1]).toMatchObject({ answer_rate: 100.0, talk_secs: 80, missed_calls: 1 });
    expect(rows[0]).toMatchObject({ answer_rate: 100.0, talk_secs: 80, missed_calls: 0 });
  });
});

describe('volume trend', () => {
  test('one row per day, no gaps; inbound unanswered counts as abandoned', async () => {
    settings();
    mocked(callLog).mockResolvedValue([
      call({}),
      call({ disposition: 'BUSY', status: 'BUSY', talk: 0 }),
      call({ call_type: 'OUT', calldate: dt('2026-10-06 23:59:59') }),
      call({ call_type: 'INTERNAL' }),
    ]);
    expect(await A.computeVolumeTrend('2026-10-04', '2026-10-06')).toEqual([
      { date: '2026-10-04', total_calls: 0, answered_calls: 0, abandoned_calls: 0, outbound_total: 0, outbound_answered: 0 },
      { date: '2026-10-05', total_calls: 2, answered_calls: 1, abandoned_calls: 1, outbound_total: 0, outbound_answered: 0 },
      { date: '2026-10-06', total_calls: 0, answered_calls: 0, abandoned_calls: 0, outbound_total: 1, outbound_answered: 1 },
    ]);
  });
});

describe('queue performance and heatmap (CDR SQL)', () => {
  test('per-queue rows sorted by volume with the peak hour', async () => {
    settings();
    const cdr = [
      { calldate: dt('2026-10-05 09:10:00'), src: '01011111111', queue_ext: '800', disposition: 'ANSWERED', wait_secs: 5, billsec: 100 },
      { calldate: dt('2026-10-05 10:10:00'), src: '+201011111111', queue_ext: '800', disposition: 'ANSWERED', wait_secs: 25, billsec: 50 },
      { calldate: dt('2026-10-05 10:20:00'), src: '01022222222', queue_ext: '800', disposition: 'NO ANSWER', wait_secs: 3, billsec: 0 },
      { calldate: dt('2026-10-05 11:00:00'), src: '101', queue_ext: '801', disposition: 'NO ANSWER', wait_secs: 30, billsec: 0 },
    ];
    const base = mocked(pool.query).getMockImplementation()!;
    mocked(pool.query).mockImplementation(async (sql: string, params: unknown[], target?: string) =>
      target === 'cdr' ? cdr : base(sql, params, target),
    );
    expect(await A.computeQueuePerformance('2026-10-05', '2026-10-05', { allowedQueues: ['800', '801'] })).toEqual([
      { queue_extension: '800', queue_name: 'Sales', total_calls: 3, answered_calls: 2, abandoned_calls: 1,
        sla_pct: 50.0, aht_secs: 75, avg_wait_secs: 11.0, peak_hour: 10,
        answer_rate: 50.0, talk_secs: 150, missed_calls: 1 },
      { queue_extension: '801', queue_name: '801', total_calls: 1, answered_calls: 0, abandoned_calls: 1,
        sla_pct: null, aht_secs: null, avg_wait_secs: 30.0, peak_hour: 11,
        answer_rate: null, talk_secs: 0, missed_calls: 1 },
    ]);
    const cdrCall = mocked(pool.query).mock.calls.find((c) => c[2] === 'cdr')!;
    expect(cdrCall[0]).toContain('AND first_leg.dst IN (?, ?)');
    expect(cdrCall[1]).toEqual(['2026-10-05', '2026-10-05', '2026-10-05', '2026-10-05', '2026-10-05', '2026-10-05', '800', '801']);
  });

  test('a supervisor with no queues reads nothing', async () => {
    mocked(pool.query).mockResolvedValue([]);
    await A.computeHourlyHeatmap('2026-10-05', '2026-10-05', []);
    expect(mocked(pool.query).mock.calls[0][0]).toContain('AND 1=0');
  });

  test('heatmap: MySQL DAYOFWEEK (1=Sun) becomes 0=Mon', async () => {
    mocked(pool.query).mockResolvedValue([
      { dow: 2, hr: 9, cnt: 5, answered_cnt: 4 },
      { dow: 1, hr: 23, cnt: 2, answered_cnt: 0 },
    ]);
    const h = await A.computeHourlyHeatmap('2026-10-05', '2026-10-11');
    expect(h.matrix[0][9]).toBe(5);
    expect(h.abandoned_matrix[0][9]).toBe(1);
    expect(h.matrix[6][23]).toBe(2);
    expect(h.labels.days[0]).toBe('Mon');
    expect(h.labels.hours[23]).toBe('23:00');
  });

  test('a CDR failure propagates (a 500, not an empty heatmap)', async () => {
    mocked(pool.query).mockRejectedValue(new Error('gone'));
    await expect(A.computeHourlyHeatmap('2026-10-05', '2026-10-05')).rejects.toThrow('gone');
  });
});

describe('drilldown', () => {
  beforeEach(() => {
    settings({ '800': 15 });
    mocked(callLog).mockResolvedValue([
      call({ linkedid: 'a', calldate: dt('2026-10-05 08:00:00') }),
      call({ linkedid: 'b', calldate: dt('2026-10-05 09:00:00'), disposition: 'NO ANSWER', status: 'MISSED', talk: 0 }),
      call({ linkedid: 'c', calldate: dt('2026-10-05 10:00:00'), disposition: 'NO ANSWER', status: 'UNANSWERED', talk: 0 }),
      call({ linkedid: 'd', calldate: dt('2026-10-05 11:00:00'), call_type: 'OUT', dst: '0122', status: 'BUSY', disposition: 'BUSY', talk: 0 }),
      call({ linkedid: 'e', calldate: dt('2026-10-05 12:00:00'), dst: '900' }),
    ]);
  });

  test('reads CEL outcomes and returns the status beside the raw disposition, newest first', async () => {
    const r = await A.computeDrilldown('2026-10-05', '2026-10-05', { allowedQueues: ['800'] });
    expect(mocked(callLog).mock.calls[0][0]).toMatchObject({ enrich: false, outcomes: true });
    expect(r.total).toBe(4); // queue 900 out of scope
    expect(r.calls.map((c: { linkedid: string }) => c.linkedid)).toEqual(['d', 'c', 'b', 'a']);
    expect(r.calls[3]).toEqual({
      calldate: '2026-10-05T08:00:00', src: '01011111111', dst: '800', queue_extension: '800', agent_extension: '201',
      duration: 60, talk: 40, disposition: 'ANSWERED', status: 'ANSWERED', wait_secs: 20, sla_met: false,
      linkedid: 'a', direction: 'IN',
    });
    expect(r.facets).toBeUndefined();
  });

  test('`disposition` filters on the call status; raw CDR spellings are accepted', async () => {
    const byStatus = await A.computeDrilldown('2026-10-05', '2026-10-05', { dispositionFilter: 'missed' });
    expect(byStatus.calls.map((c: { linkedid: string }) => c.linkedid)).toEqual(['b']);
    const raw = await A.computeDrilldown('2026-10-05', '2026-10-05', { dispositionFilter: 'NO ANSWER' });
    expect(raw.calls.map((c: { linkedid: string }) => c.linkedid)).toEqual(['c']);
    const unknown = await A.computeDrilldown('2026-10-05', '2026-10-05', { dispositionFilter: 'bogus' });
    expect(unknown.total).toBe(0);
  });

  test('filter values: statuses, retired spellings and raw CDR dispositions', () => {
    expect(A.drilldownStatusFilter('no answer')).toBe('UNANSWERED');
    expect(A.drilldownStatusFilter('NO_ANSWER')).toBe('UNANSWERED');
    expect(A.drilldownStatusFilter('FAILED')).toBe('FAILURE');
    expect(A.drilldownStatusFilter('CONGESTION')).toBe('NETWORK_ERROR');
    expect(A.drilldownStatusFilter('canceled')).toBe('MISSED');
    expect(A.drilldownStatusFilter('busy')).toBe('BUSY');
  });

  test('facets count each value under the other filters', async () => {
    const r = await A.computeDrilldown('2026-10-05', '2026-10-05', { direction: 'in', facets: true, pageSize: 1, page: 2 });
    expect(r.facets).toEqual({ direction: { IN: 4, OUT: 1 }, status: { ANSWERED: 2, MISSED: 1, UNANSWERED: 1 } });
    expect(r.total).toBe(4);
    expect(r.calls.map((c: { linkedid: string }) => c.linkedid)).toEqual(['c']);
    expect(r).toMatchObject({ page: 2, page_size: 1 });
  });
});

describe('adherence sessions', () => {
  let nextId = 1;
  const seg = (state: string, start: string, end: string | null, reason: string | null = null): A.Segment => ({
    id: nextId++, agent_ext: '201', state, reason_code: reason, queue: null, linkedid: null, source: 'ui',
    started_at: dt(start), ended_at: end ? dt(end) : null,
  });
  const W0 = dt('2026-10-05 00:00:00');
  const W1 = dt('2026-10-05 23:59:59');
  const NOW = dt('2026-10-06 12:00:00');

  test('a gap is a logout: two logins are two sessions', () => {
    const s = A.splitSessions([
      seg('ready', '2026-10-05 08:00:00', '2026-10-05 10:00:00'),
      seg('ready', '2026-10-05 13:00:00', '2026-10-05 17:00:00'),
    ], W0, W1, NOW, 0);
    expect(s.map((x) => [x.login.getHours(), x.logout!.getHours(), x.duration_secs])).toEqual([[8, 10, 7200], [13, 17, 14400]]);
  });

  test('a DND the agent never returns from ends the shift; one they return from stays in it', () => {
    const s = A.splitSessions([
      seg('ready', '2026-10-05 08:00:00', '2026-10-05 09:00:00'),
      seg('dnd', '2026-10-05 09:00:00', '2026-10-05 09:10:00'),
      seg('ready', '2026-10-05 09:10:00', '2026-10-05 17:00:00'),
      seg('dnd', '2026-10-05 17:00:00', null),
    ], W0, W1, NOW, 0);
    expect(s).toHaveLength(1);
    expect(s[0].closed_by).toBe('dnd');
    expect(s[0].logout!.getHours()).toBe(17);
    expect(s[0].segments.map((x) => x.state)).toEqual(['ready', 'dnd', 'ready']);
  });

  test('a DND before any login is not a shift', () => {
    expect(A.splitSessions([seg('dnd', '2026-10-05 07:00:00', '2026-10-05 08:00:00')], W0, W1, NOW, 0)).toEqual([]);
  });

  test('the shift boundary cuts a session that never logged out', () => {
    const cut = A.splitAtShiftBoundary([seg('ready', '2026-10-04 20:00:00', null)], 6 * 60, NOW);
    expect(cut.map((x) => [x.started_at.getDate(), x.started_at.getHours(), x.ended_at?.getHours() ?? null])).toEqual([
      [4, 20, 6], [5, 6, 6], [6, 6, null],
    ]);
  });

  test('summary: sessions, break vs productive, DND inside logged-in, open session, cut at the window', async () => {
    mocked(shiftResetMinutes).mockResolvedValue(0);
    nextId = 1;
    const rows = [
      seg('ready', '2026-10-04 22:00:00', '2026-10-05 08:00:00'), // crosses midnight: from 00:00 only
      seg('on_call', '2026-10-05 08:00:00', '2026-10-05 08:30:00'),
      seg('wrap_up', '2026-10-05 08:30:00', '2026-10-05 08:35:00'),
      seg('not_ready', '2026-10-05 08:35:00', '2026-10-05 09:05:00', 'lunch'),
      seg('not_ready', '2026-10-05 09:05:00', '2026-10-05 09:35:00', 'meeting'),
      seg('dnd', '2026-10-05 09:35:00', '2026-10-05 09:45:00'),
      seg('ready', '2026-10-05 09:45:00', '2026-10-05 10:00:00'),
      { ...seg('ready', '2026-10-05 12:00:00', null), agent_ext: '202' },
    ];
    mocked(pool.query).mockImplementation(async (sql: string) => {
      if (sql.includes('FROM agent_activity')) return rows.map((r) => ({ ...r }));
      if (sql.includes('FROM pause_reasons')) {
        return [
          { code: 'lunch', label: 'Lunch', productive: 0, color: null, is_system: 0 },
          { code: 'meeting', label: 'Meeting', productive: 1, color: null, is_system: 0 },
        ];
      }
      if (sql.includes('FROM agents')) return [{ extension: '201', name: 'Mona' }];
      return [];
    });
    const r = await A.computeAgentAdherence('2026-10-05', '2026-10-05', ['201', '202']);
    const mona = r.agents.find((a: { agent: string }) => a.agent === '201');
    expect(mona).toMatchObject({
      name: 'Mona', login: '2026-10-05T00:00:00', logout: '2026-10-05T10:00:00', logged_in: false, sessions: 1,
      ready_secs: 8 * 3600 + 900, on_call_secs: 1800, wrap_secs: 300, not_ready_secs: 3600, break_secs: 1800,
      productive_not_ready_secs: 1800, dnd_secs: 600, logged_in_secs: 10 * 3600,
    });
    expect(mona.occupancy_pct).toBe(pyPct(2100, 2100 + 8 * 3600 + 900));
    expect(mona.not_ready_breakdown.map((b: { code: string; label: string }) => [b.code, b.label])).toEqual([['lunch', 'Lunch'], ['meeting', 'Meeting']]);
    const other = r.agents.find((a: { agent: string }) => a.agent === '202');
    // Still open in the database, but the day rolled over since: the shift boundary ended
    // that day's session, so it reads as logged out at the end of the window.
    expect(other).toMatchObject({ logged_in: false, logout: '2026-10-05T23:59:59', name: '', sessions: 1 });
    expect(r.reasons).toHaveLength(2);
    expect(mocked(pool.query).mock.calls.find((c) => String(c[0]).includes('agent_activity'))![1]).toEqual([
      '2026-10-05 23:59:59', '2026-10-05 00:00:00', '201', '202',
    ]);
  });

  test('timeline: newest session first, merged runs, reason labels', async () => {
    mocked(shiftResetMinutes).mockResolvedValue(null);
    nextId = 1;
    const rows = [
      seg('ready', '2026-10-05 08:00:00', '2026-10-05 09:00:00'),
      seg('ready', '2026-10-05 09:00:00', '2026-10-05 10:00:00'), // restart re-open: merged
      seg('not_ready', '2026-10-05 10:00:00', '2026-10-05 10:30:00', 'lunch'),
      seg('ready', '2026-10-05 14:00:00', '2026-10-05 15:00:00'),
    ];
    mocked(pool.query).mockImplementation(async (sql: string) => {
      if (sql.includes('FROM agent_activity')) return rows.map((r) => ({ ...r }));
      if (sql.includes('FROM pause_reasons')) return [{ code: 'lunch', label: 'Lunch', productive: 0, color: null }];
      return [];
    });
    const t = await A.computeAgentTimeline(' 201 ', '2026-10-05', '2026-10-05');
    expect(t.agent).toBe('201');
    expect(t.sessions.map((s: { login: string }) => s.login)).toEqual(['2026-10-05T14:00:00', '2026-10-05T08:00:00']);
    expect(t.sessions[1].entries.map((e: { state: string; reason_label: string | null; duration_secs: number }) =>
      [e.state, e.reason_label, e.duration_secs])).toEqual([['ready', null, 7200], ['not_ready', 'Lunch', 1800]]);
  });
});

describe('aggregation', () => {
  test('one cycle upserts hourly + daily buckets and prunes once a day', async () => {
    settings();
    const base = mocked(pool.query).getMockImplementation()!;
    mocked(pool.query).mockImplementation(async (sql: string, params: unknown[], target?: string) =>
      target === 'cdr' ? [{ queue_ext: '800', src: '0101', disposition: 'ANSWERED', wait_secs: 3, billsec: 9 }] : base(sql, params, target),
    );
    const now = dt('2026-10-05 10:20:00');
    await A.aggregationCycle(now);
    const sqls = mocked(pool.execute).mock.calls.map((c) => [String(c[0]).includes('analytics_hourly') ? 'h' : 'd', c[1][0]]);
    expect(sqls).toEqual([['h', '2026-10-05 10:00:00'], ['h', '2026-10-05 09:00:00'], ['d', '2026-10-05'], ['d', '2026-10-04']]);
    expect(dbm.pruneStaleDeviceTokens).toHaveBeenCalledTimes(1);
    expect(dbm.pruneWebhookDeliveries).toHaveBeenCalledWith(30);
    await A.aggregationCycle(now);
    expect(dbm.pruneStaleDeviceTokens).toHaveBeenCalledTimes(1);
  });
});

function pyPct(part: number, whole: number): number {
  return Math.round((part / whole) * 1000) / 10;
}

describe('adherence: an agent still logged in', () => {
  test('the open session has no logout and counts up to now', async () => {
    mocked(shiftResetMinutes).mockResolvedValue(null);
    const today = A.defaultDates(null, null)[1];
    const start = new Date(Date.now() - 3600 * 1000);
    mocked(pool.query).mockImplementation(async (sql: string) =>
      sql.includes('FROM agent_activity')
        ? [{ id: 1, agent_ext: '201', state: 'ready', reason_code: null, queue: null, linkedid: null, source: 'ui', started_at: start, ended_at: null }]
        : [],
    );
    const r = await A.computeAgentAdherence(today, today);
    if (start.getDate() !== new Date().getDate()) return; // the hour straddles midnight: window cuts it
    expect(r.agents[0]).toMatchObject({ logged_in: true, logout: null, sessions: 1 });
    expect(r.agents[0].ready_secs).toBeGreaterThanOrEqual(3599);
  });
});
