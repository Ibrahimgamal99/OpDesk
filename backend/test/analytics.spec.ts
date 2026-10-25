/**
 * services/analytics: the KPI math (pinned to values the Python analytics.py produced for
 * the same rows), queue quality from the queue CDR run and volume from the call-history
 * scan, FCR and abandoned-caller recovery, the reports' scope rules, the drilldown's
 * filters and facets, one agent's calls, and the adherence session model (sessions, break,
 * DND, shift boundary). The database, the call-log scan and the shift setting are mocked.
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
  // The CDR-only path of the real rule: talk time or an ANSWERED disposition is answered.
  mapCallOutcome: jest.fn(({ disposition, answered }: { disposition?: string; answered?: boolean }) =>
    answered || disposition === 'ANSWERED' ? 'ANSWERED' : disposition === 'NO ANSWER' ? 'UNANSWERED' : 'FAILURE'),
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

/** Settings reads: per-queue thresholds, the stored FCR row (FCR off), SLA default 20. */
function settings(thresholds: Record<string, number> = {}, fcr: Record<string, number> = {}) {
  mocked(pool.query).mockImplementation(async (sql: string) => {
    if (sql.includes('analytics_sla_settings')) return Object.entries(thresholds).map(([q, s]) => ({ queue_extension: q, threshold_secs: s }));
    if (sql.includes('FROM agents')) return [{ extension: '201', name: 'Mona' }];
    if (sql.includes('FROM queues')) return [{ extension: '800', queue_name: 'Sales' }];
    return [];
  });
  mocked(pool.queryOne).mockResolvedValue({ window_days: 0, short_abandon_secs: 5, callback_window_hours: 0, ...fcr });
}

type QueueRows = unknown[] | ((params: unknown[]) => unknown[]);

/** The CDR reads, routed by statement: the queue run, FCR's scan, our outbound callbacks. */
function cdr(data: { queue?: QueueRows; fcr?: unknown[]; callbacks?: unknown[] }) {
  const base = mocked(pool.query).getMockImplementation()!;
  mocked(pool.query).mockImplementation(async (sql: string, params: unknown[], target?: string) => {
    if (target !== 'cdr') return base(sql, params, target);
    if (sql.includes("dcontext = 'from-internal'")) return data.callbacks ?? [];
    if (sql.includes('AS answered')) return data.fcr ?? [];
    if (sql.includes('AS queue_ext')) return typeof data.queue === 'function' ? data.queue(params) : data.queue ?? [];
    return [{ 1: 1 }];
  });
}

const cdrCalls = () => mocked(pool.query).mock.calls.filter((c) => c[2] === 'cdr');

beforeEach(() => {
  jest.clearAllMocks();
  mocked(dbm.getSetting).mockImplementation(async (_k: string, d: unknown) => d);
  A.clearAgentCallsCache();
});

describe('number keys and people rates', () => {
  test('outside numbers compare on their last nine digits; short ones are extensions', () => {
    expect(A.numberKey('01012345678')).toBe('012345678');
    expect(A.numberKey('+201012345678')).toBe('012345678');
    expect(A.numberKey('101')).toBe('');
    expect(A.numberKey(null)).toBe('');
    expect(A.numberKey('anonymous')).toBe('');
    expect(A.numberKey('555-1234')).toBe('5551234');
  });

  const vol = (call_type: string, src: string, dst: string, status: string, talk: number, app = 'direct') =>
    ({ call_type, src, dst, status, talk, app });
  const ROWS = [
    vol('IN', '01012345678', '800', 'ANSWERED', 100, 'queue'),
    vol('IN', '+201012345678', '800', 'MISSED', 0, 'queue'),
    vol('IN', '01099999999', '201', 'ANSWERED', 50),
    vol('OUT', '201', '0122222222', 'BUSY', 0),
    vol('OUT', '201', '0122222222', 'ANSWERED', 90),
    vol('OUT', '201', '0133333333', 'FAILURE', 0),
    vol('OUT', '201', '0144444444', 'UNANSWERED', 0),
    vol('INTERNAL', '201', '202', 'ANSWERED', 12),
  ];

  test('volume blocks: inbound, direct inbound, outbound, internal and combined', () => {
    expect(A.computeVolumeKpis(ROWS)).toEqual({
      inbound: {
        total_calls: 3, answered_calls: 2, missed_calls: 1, aht_secs: 75, sum_billsec: 150,
        customers: 2, customers_answered: 2, answer_rate: 100.0, contact_rate: 66.7,
      },
      inbound_direct: {
        total_calls: 1, answered_calls: 1, missed_calls: 0, aht_secs: 50, sum_billsec: 50,
        customers: 1, customers_answered: 1, answer_rate: 100.0, contact_rate: 100.0,
      },
      outbound: {
        total_calls: 4, answered_calls: 1, missed_calls: 3, aht_secs: 90, sum_billsec: 90,
        customers: 3, customers_answered: 1, answer_rate: 33.3, contact_rate: 25.0,
        failed_calls: 1, no_answer_calls: 1, busy_calls: 1,
      },
      internal: {
        total_calls: 1, answered_calls: 1, missed_calls: 0, aht_secs: 12, sum_billsec: 12,
        customers: 0, customers_answered: 0, answer_rate: null, contact_rate: 100.0,
      },
      combined: {
        total_calls: 8, answered_calls: 4, missed_calls: 4, aht_secs: 63, sum_billsec: 252,
        customers: 5, customers_answered: 3, answer_rate: 60.0, contact_rate: 50.0, internal_calls: 1,
      },
    });
  });

  test('a call reads as answered by its derived status, not the raw disposition', () => {
    const block = A.volumeBlock([{ ...ROWS[0], disposition: 'NO ANSWER' }, { ...ROWS[1], disposition: 'ANSWERED' }]);
    expect(block).toMatchObject({ total_calls: 2, answered_calls: 1 });
  });

  test('people rates count each outside party once', () => {
    expect(A.peopleRates([
      { answered: false, counterparty: '012345678' },
      { answered: true, counterparty: '012345678' },
      { answered: false, counterparty: '' },
    ])).toEqual({ customers: 1, customers_answered: 1, answer_rate: 100.0, contact_rate: 33.3 });
  });
});

describe('queue KPI formulas', () => {
  test('negative waits are clamped; talk time or an ANSWERED disposition is answered', () => {
    const rows = [
      { queue_ext: '800', disposition: 'ANSWERED', billsec: 60, wait_secs: -5 },
      { queue_ext: '800', disposition: 'NO ANSWER', billsec: 30, wait_secs: 25 },
      { queue_ext: '800', disposition: 'NO ANSWER', billsec: 0, wait_secs: 3 },
      { queue_ext: '800', disposition: 'BUSY', billsec: 0, wait_secs: 40 },
    ];
    const k = A.computeKpisFromRows(rows, {}, 20, 5);
    expect(k).toEqual({
      total_calls: 4, answered_calls: 2, abandoned_calls: 2, short_abandoned: 1, sla_met_calls: 1,
      sum_wait_secs: 68, sum_billsec: 90,
    });
    expect(A.deriveRates(k)).toMatchObject({
      sla_pct: 50.0, abandonment_rate: 50.0, short_abandon_rate: 25.0, aht_secs: 45, avg_wait_secs: 17.0,
    });
  });

  test('rates round half to even, as Python round() does', () => {
    const k = A.deriveRates({
      total_calls: 8, answered_calls: 8, abandoned_calls: 0, short_abandoned: 0,
      sla_met_calls: 0, sum_wait_secs: 0, sum_billsec: 20,
    });
    expect(k.aht_secs).toBe(2); // 2.5 -> 2
  });

  test('the queue run keeps to real queue legs and never reports a negative wait', () => {
    const sql = A.queueCdrSql();
    expect(sql).toContain("AND first_leg.dst REGEXP '^[0-9]+$'");
    expect(sql).toMatch(/GREATEST\(CASE[\s\S]*END, 0\)\s+AS wait_secs/);
    expect(A.realQueueCond('cdr')).toBe("AND cdr.dst REGEXP '^[0-9]+$'");
  });
});

describe('what a queue call is', () => {
  const rows = [
    { call_type: 'IN', app: 'queue', dst: '800' },
    { call_type: 'IN', app: 'queue', dst: '900' },
    { call_type: 'IN', app: 'direct', dst: '301' }, // a direct dial: all digits, not a queue
    { call_type: 'OUT', app: 'direct', dst: '0122222222' },
    { call_type: 'INTERNAL', app: 'direct', dst: '202' },
  ];

  test('only an inbound call that entered a queue is one', () => {
    expect(rows.map(A.isQueueCall)).toEqual([true, true, false, false, false]);
  });

  test("the queue scope drops other queues' calls, never direct inbound calls", () => {
    expect(A.queueScopeFilter(rows, ['800']).map((r) => r.dst)).toEqual(['800', '301', '0122222222', '202']);
    expect(A.queueScopeFilter(rows, null)).toHaveLength(5);
    expect(A.queueScopeFilter(rows, []).map((r) => r.dst)).toEqual(['301', '0122222222', '202']);
  });
});

describe('dates', () => {
  test('the default range is the UI\'s "Last 30 days": 30 days, today included', () => {
    const [from, to] = A.defaultDates(null, '');
    expect(to).toBe(A.addDaysYmd(from, 29));
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
  disposition: 'ANSWERED', status: 'ANSWERED', extension: '201', call_type: 'IN', app: 'queue', linkedid: 'L1', ...over,
});

describe('executive KPIs', () => {
  const FCR_ON = { window_days: 7, short_abandon_secs: 5, callback_window_hours: 24 };

  function overviewData() {
    mocked(callLog).mockImplementation(async (o: { dateFrom: string }) =>
      o.dateFrom === '2026-10-01'
        ? [
          call({}),
          call({ dst: '900', linkedid: 'L2' }), // a queue outside the supervisor's
          // A direct dial nobody answered: inbound volume, never a queue abandon.
          call({ app: 'direct', dst: '201', linkedid: 'L3', status: 'MISSED', disposition: 'NO ANSWER', talk: 0 }),
          call({ call_type: 'OUT', app: 'direct', dst: '0122222222', src: '201', linkedid: 'L4' }),
        ]
        : [call({ status: 'UNANSWERED', disposition: 'NO ANSWER', talk: 0 })],
    );
    cdr({
      queue: (params) => (params[0] === '2026-10-01'
        ? [
          { calldate: dt('2026-10-02 10:00:00'), src: '01011111111', queue_ext: '800', disposition: 'ANSWERED', billsec: 40, wait_secs: 10 },
          { calldate: dt('2026-10-05 09:00:00'), src: '01077777777', queue_ext: '800', disposition: 'NO ANSWER', billsec: 0, wait_secs: 30 },
        ]
        : [{ calldate: dt('2026-09-25 09:00:00'), src: '01088888888', queue_ext: '800', disposition: 'NO ANSWER', billsec: 0, wait_secs: 2 }]),
      fcr: [
        { src: '01011111111', calldate: dt('2026-10-02 10:00:00'), answered: 1 },
        { src: '+201011111111', calldate: dt('2026-10-03 10:00:00'), answered: 0 }, // rang again and gave up: a repeat
        { src: '01022222222', calldate: dt('2026-10-04 10:00:00'), answered: 1 }, // resolved
        { src: '01055555555', calldate: dt('2026-10-05 11:00:00'), answered: 1 }, // we rang them back: a repeat
        { src: 'anonymous', calldate: dt('2026-10-05 11:00:00'), answered: 1 }, // no number: no caller
        { src: '101', calldate: dt('2026-10-05 11:00:00'), answered: 1 }, // an extension: no caller
      ],
      callbacks: [
        { dst: '01077777777', calldate: dt('2026-10-05 10:00:00') },
        { dst: '+201055555555', calldate: dt('2026-10-05 12:00:00') },
      ],
    });
  }

  test('queue quality from the queue CDR run, volume from the call log, scope applied', async () => {
    settings({}, FCR_ON);
    overviewData();
    const r = await A.computeExecutiveKpis('2026-10-01', '2026-10-07', { allowedQueues: ['800'], allowedAgents: ['201'] });
    expect(r.period).toEqual({ from: '2026-10-01', to: '2026-10-07' });
    expect(mocked(callLog).mock.calls.map((c) => [c[0].dateFrom, c[0].dateTo, c[0].allowedExtensions, c[0].enrich])).toEqual([
      ['2026-10-01', '2026-10-07', ['201'], false],
      ['2026-09-24', '2026-09-30', ['201'], false],
    ]);
    const queueRun = cdrCalls().find((c) => String(c[0]).includes('AS queue_ext'))!;
    expect(queueRun[0]).toContain('AND first_leg.dst IN (?)');
    expect(queueRun[0]).toContain("REGEXP '^[0-9]+$'");
    expect(queueRun[1].slice(-1)).toEqual(['800']);

    // The queue's own figures: two offered, one answered in 10 s, one abandoned after 30 s.
    expect(r.current).toMatchObject({
      total_calls: 2, answered_calls: 1, abandoned_calls: 1, sla_pct: 100.0, abandonment_rate: 50.0,
      short_abandon_rate: 0.0, avg_wait_secs: 20.0, aht_secs: 40, answer_rate: 50.0, contact_rate: 50.0,
    });
    // Volume: the in-scope queue call and the direct dial; queue 900 is someone else's.
    expect(r.current.inbound).toMatchObject({ total_calls: 2, answered_calls: 1 });
    expect(r.current.inbound_direct).toMatchObject({ total_calls: 1, answered_calls: 0 });
    expect(r.current.outbound.total_calls).toBe(1);
    expect(r.current.combined).toMatchObject({ total_calls: 3, internal_calls: 0 });
    // The abandoned caller was rung back within the day.
    expect(r.current).toMatchObject({
      abandoned_callers: 1, recovered_callers: 1, recovery_rate: 100.0, net_abandonment_rate: 0.0,
    });
    // FCR: three callers answered in the period, two of them a repeat (one rang again,
    // one we called back); the anonymous and internal callers are nobody.
    expect(r.current).toMatchObject({ fcr_pct: 33.3, fcr_callers: 3, fcr_repeat_callers: 2, fcr_provisional: false });
    const fcrScan = cdrCalls().find((c) => String(c[0]).includes('AS answered'))!;
    expect(fcrScan[0]).toContain("AND cdr.dst REGEXP '^[0-9]+$'");
    expect(fcrScan[0]).toContain('AND dst IN (?)');
    expect(fcrScan[1]).toEqual(['2026-10-01', '2026-10-15', '800']);
    const callbackScan = cdrCalls().find((c) => String(c[0]).includes('from-internal'))!;
    expect(callbackScan[1]).toEqual(['2026-10-01', '2026-10-09 00:00:00', '2026-10-01', '2026-10-09 00:00:00']);

    expect(r.prev_period).toMatchObject({
      total_calls: 1, abandoned_calls: 1, short_abandoned: 1, recovered_callers: 0, recovery_rate: 0.0,
      net_abandonment_rate: 100.0, fcr_pct: null, fcr_callers: 0,
    });
    expect(r.settings).toEqual({ sla_default_secs: 20, fcr_window_days: 7, short_abandon_secs: 5, callback_window_hours: 24 });
  });

  test('FCR and recovery are off at a zero window, and read no CDR for it', async () => {
    settings();
    overviewData();
    const r = await A.computeExecutiveKpis('2026-10-01', '2026-10-07', {});
    expect(r.current).toMatchObject({ fcr_pct: null, fcr_callers: 0, recovery_rate: null, abandoned_callers: 1, net_abandonment_rate: 50.0 });
    expect(cdrCalls().some((c) => String(c[0]).includes('from-internal') || String(c[0]).includes('AS answered'))).toBe(false);
  });

  test('past 31 days there is no previous period', async () => {
    settings();
    overviewData();
    const r = await A.computeExecutiveKpis('2026-08-01', '2026-10-01', {});
    expect(r.prev_period).toBeNull();
    expect(callLog).toHaveBeenCalledTimes(1);
    const r31 = await A.computeExecutiveKpis('2026-09-01', '2026-10-01', {});
    expect(r31.prev_period).not.toBeNull();
  });

  test('FCR is provisional while the window is still open on the newest callers', async () => {
    settings();
    const today = A.defaultDates(null, null)[1];
    cdr({ fcr: [{ src: '01011111111', calldate: new Date(), answered: 1 }] });
    expect(await A.computeFcr(today, today, 7)).toEqual({ fcr_pct: 100.0, base: 1, repeat: 0, provisional: true });
    mocked(pool.query).mockClear();
    expect(await A.computeFcr(today, today, 0)).toEqual({ fcr_pct: null, base: 0, repeat: 0, provisional: false });
    expect(pool.query).not.toHaveBeenCalled();
  });

  test('a callback counts only inside its window, and only after the call', () => {
    const cb = new Map([['012345678', [dt('2026-10-05 12:00:00')]]]);
    expect(A.calledBackWithin(cb, '012345678', dt('2026-10-05 11:00:00'), 1)).toBe(true);
    expect(A.calledBackWithin(cb, '012345678', dt('2026-10-05 10:59:59'), 1)).toBe(false);
    expect(A.calledBackWithin(cb, '012345678', dt('2026-10-05 12:00:00'), 24)).toBe(false);
    expect(A.calledBackWithin(cb, '012345678', dt('2026-10-05 11:00:00'), 0)).toBe(false);
  });

  test('a CDR failure in the FCR scan is a 500, not a missing figure', async () => {
    settings({}, FCR_ON);
    overviewData();
    const base = mocked(pool.query).getMockImplementation()!;
    mocked(pool.query).mockImplementation(async (sql: string, params: unknown[], target?: string) => {
      if (String(sql).includes('AS answered')) throw new Error('gone');
      return base(sql, params, target);
    });
    await expect(A.computeExecutiveKpis('2026-10-01', '2026-10-07', {})).rejects.toThrow('gone');
  });
});

describe('agent performance', () => {
  test('in-scope agents only; internal calls counted apart; SLA from queue calls only', async () => {
    settings({ '800': 15 });
    mocked(callLog).mockResolvedValue([
      call({ calldate: dt('2026-10-07 09:00:00') }), // wait 20 > 15
      call({ calldate: dt('2026-10-07 09:30:00'), duration: 50 }), // wait 10
      call({ extension: '202', calldate: dt('2026-10-06 09:00:00') }),
      call({ extension: '202', call_type: 'OUT', app: 'direct', dst: '0100', calldate: dt('2026-10-01 09:00:00') }),
      call({ extension: '202', disposition: 'NO ANSWER', status: 'MISSED', talk: 0 }),
      // A direct dial the agent took: answered, but no queue threshold to meet.
      call({ extension: '202', app: 'direct', dst: '202', duration: 300 }),
      call({ extension: '202', call_type: 'INTERNAL', app: 'direct', src: '201', dst: '202' }),
      call({ extension: '203', call_type: 'INTERNAL', app: 'direct', src: '203', dst: '201' }),
      call({ extension: '301' }), // touched an in-scope extension, credited to someone else
      call({ extension: 'Local/x' }), // not an extension: skipped
    ]);
    const rows = await A.computeAgentPerformance('2026-10-01', '2026-10-07', { allowedAgents: ['201', '202', '203'] });
    expect(mocked(callLog).mock.calls[0][0].allowedExtensions).toEqual(['201', '202', '203']);
    expect(rows.map((r) => [r.agent_extension, r.rank, r.answered_calls, r.total_calls, r.internal_calls])).toEqual([
      ['202', 1, 3, 4, 1],
      ['201', 2, 2, 2, 0],
      ['203', 3, 0, 0, 1],
    ]);
    const [b, a, c] = rows;
    expect(a).toMatchObject({ agent_name: 'Mona', sla_contribution_pct: 50.0, daily_trend: [0, 0, 0, 0, 0, 0, 2] });
    expect(b).toMatchObject({
      agent_name: '202', inbound_calls: 3, outbound_calls: 1, sla_contribution_pct: 0.0,
      daily_trend: [1, 0, 0, 0, 1, 1, 0], answer_rate: 100.0, talk_secs: 120, missed_calls: 1,
    });
    expect(c).toMatchObject({ aht_secs: null, sla_contribution_pct: null, daily_trend: [0, 0, 0, 0, 0, 0, 0] });
  });

  test('unscoped, every credited extension is listed', async () => {
    settings();
    mocked(callLog).mockResolvedValue([call({}), call({ extension: '301' })]);
    const rows = await A.computeAgentPerformance('2026-10-01', '2026-10-07', { allowedAgents: null });
    expect(rows.map((r) => r.agent_extension)).toEqual(['201', '301']);
  });
});

describe('volume series', () => {
  test('one row per day, no gaps; internal and per-person counts; the hourly series sums to it', async () => {
    settings();
    mocked(callLog).mockResolvedValue([
      call({}),
      call({ disposition: 'BUSY', status: 'BUSY', talk: 0 }),
      call({ call_type: 'OUT', calldate: dt('2026-10-06 23:59:59') }),
      call({ call_type: 'INTERNAL' }),
      // The raw disposition says ANSWERED, the derived status does not: not answered.
      call({ src: '01022222222', status: 'VOICEMAIL', calldate: dt('2026-10-04 08:15:00') }),
    ]);
    const { trend, hourly } = await A.computeVolumeSeries('2026-10-04', '2026-10-06');
    expect(trend).toEqual([
      { date: '2026-10-04', total_calls: 1, answered_calls: 0, abandoned_calls: 1, outbound_total: 0, outbound_answered: 0,
        internal_total: 0, customers: 1, customers_answered: 0 },
      { date: '2026-10-05', total_calls: 2, answered_calls: 1, abandoned_calls: 1, outbound_total: 0, outbound_answered: 0,
        internal_total: 1, customers: 1, customers_answered: 1 },
      { date: '2026-10-06', total_calls: 0, answered_calls: 0, abandoned_calls: 0, outbound_total: 1, outbound_answered: 1,
        internal_total: 0, customers: 0, customers_answered: 0 },
    ]);
    expect(hourly).toHaveLength(24);
    expect(hourly[10]).toEqual({ hour: 10, inbound: 2, outbound: 0, internal: 1 });
    expect(hourly[8]).toEqual({ hour: 8, inbound: 1, outbound: 0, internal: 0 });
    expect(hourly[23]).toEqual({ hour: 23, inbound: 0, outbound: 1, internal: 0 });
    const sum = (xs: number[]) => xs.reduce((n, x) => n + x, 0);
    expect(sum(hourly.map((h) => h.inbound))).toBe(sum(trend.map((d) => d.total_calls)));
    expect(sum(hourly.map((h) => h.outbound))).toBe(sum(trend.map((d) => d.outbound_total)));
    expect(sum(hourly.map((h) => h.internal))).toBe(sum(trend.map((d) => d.internal_total)));
    expect(await A.computeVolumeTrend('2026-10-04', '2026-10-06')).toEqual(trend);
  });

  test('an empty scan is checked against the CDR: a dead database is a 500, not "no calls"', async () => {
    settings();
    mocked(callLog).mockResolvedValue([]);
    mocked(pool.query).mockResolvedValue([{ 1: 1 }]);
    expect((await A.computeVolumeTrend('2026-10-05', '2026-10-05'))[0].total_calls).toBe(0);
    expect(mocked(pool.query).mock.calls[0]).toEqual(['SELECT 1 FROM cdr LIMIT 1', [], 'cdr']);
    mocked(pool.query).mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(A.computeVolumeTrend('2026-10-05', '2026-10-05')).rejects.toThrow('ECONNREFUSED');
  });
});

describe('queue performance and heatmap (CDR SQL)', () => {
  const CDR = [
    { calldate: dt('2026-10-05 09:10:00'), src: '01011111111', queue_ext: '800', disposition: 'ANSWERED', wait_secs: 5, billsec: 100 },
    { calldate: dt('2026-10-05 10:10:00'), src: '+201011111111', queue_ext: '800', disposition: 'ANSWERED', wait_secs: 25, billsec: 50 },
    { calldate: dt('2026-10-05 10:20:00'), src: '01022222222', queue_ext: '800', disposition: 'NO ANSWER', wait_secs: 3, billsec: 0 },
    { calldate: dt('2026-10-05 11:00:00'), src: '101', queue_ext: '801', disposition: 'NO ANSWER', wait_secs: 30, billsec: 0 },
  ];

  test('per-queue rows sorted by volume, with peak hour, rates, per-day series and wait buckets', async () => {
    settings();
    cdr({ queue: CDR });
    const rows = await A.computeQueuePerformance('2026-10-04', '2026-10-05', { allowedQueues: ['800', '801'] });
    expect(rows.map((q) => q.queue_extension)).toEqual(['800', '801']);
    expect(rows[0]).toMatchObject({
      queue_name: 'Sales', total_calls: 3, answered_calls: 2, abandoned_calls: 1,
      sla_pct: 50.0, aht_secs: 75, avg_wait_secs: 11.0, peak_hour: 10,
      answer_rate: 50.0, talk_secs: 150, missed_calls: 1, abandonment_rate: 33.3, short_abandon_rate: 33.3,
      daily: [
        { date: '2026-10-04', offered: 0, answered: 0, abandoned: 0 },
        { date: '2026-10-05', offered: 3, answered: 2, abandoned: 1 },
      ],
    });
    expect(rows[1]).toMatchObject({
      queue_name: '801', sla_pct: null, aht_secs: null, avg_wait_secs: 30.0, peak_hour: 11,
      answer_rate: null, abandonment_rate: 100.0, short_abandon_rate: 0.0,
    });
    for (const q of rows) {
      const b = q.wait_distribution as { from_secs: number; to_secs: number | null; answered: number; abandoned: number }[];
      expect(b.map((x) => x.from_secs)).toEqual([...A.WAIT_BUCKET_EDGES]);
      expect(b[b.length - 1].to_secs).toBeNull();
      expect(b.reduce((n, x) => n + x.answered + x.abandoned, 0)).toBe(q.total_calls);
      expect(b.reduce((n, x) => n + x.answered, 0)).toBe(q.answered_calls);
    }
    expect(rows[0].wait_distribution[0]).toEqual({ from_secs: 0, to_secs: 10, answered: 1, abandoned: 1 });
    expect(rows[0].wait_distribution[2]).toEqual({ from_secs: 20, to_secs: 30, answered: 1, abandoned: 0 });
    const run = cdrCalls()[0];
    expect(run[0]).toContain('AND first_leg.dst IN (?, ?)');
    expect(run[1]).toEqual(['2026-10-04', '2026-10-05', '2026-10-04', '2026-10-05', '2026-10-04', '2026-10-05', '800', '801']);
  });

  test('a supervisor with no queues reads nothing', async () => {
    mocked(pool.query).mockResolvedValue([]);
    await A.computeHourlyHeatmap('2026-10-05', '2026-10-05', []);
    expect(mocked(pool.query).mock.calls[0][0]).toContain('AND 1=0');
  });

  test('heatmap: real queue legs, the KPI answered rule, MySQL DAYOFWEEK (1=Sun) becomes 0=Mon', async () => {
    mocked(pool.query).mockResolvedValue([
      { dow: 2, hr: 9, cnt: 5, answered_cnt: 4 },
      { dow: 1, hr: 23, cnt: 2, answered_cnt: 0 },
    ]);
    const h = await A.computeHourlyHeatmap('2026-10-05', '2026-10-11', ['800']);
    const sql = String(mocked(pool.query).mock.calls[0][0]);
    expect(sql).toContain("AND first_leg.dst REGEXP '^[0-9]+$'");
    expect(sql).toContain(A.ANSWERED_SQL);
    expect(sql).toContain('AND first_leg.dst IN (?)');
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

describe('settings', () => {
  test('an unreadable SLA table is an error, never the default for every queue', async () => {
    mocked(pool.query).mockRejectedValue(new Error('gone'));
    await expect(A.getSlaThresholds()).rejects.toThrow('gone');
  });

  test('a null threshold removes that queue\'s override', async () => {
    mocked(pool.execute).mockResolvedValue({});
    expect(await A.saveSlaThresholds({ '800': null, '801': '30' })).toBe(true);
    expect(mocked(pool.execute).mock.calls.map((c) => [String(c[0]).trim().split(/\s+/)[0], c[1]])).toEqual([
      ['DELETE', ['800']],
      ['INSERT', ['801', 30, 30]],
    ]);
  });

  test('the FCR row keeps a stored callback window the caller did not send', async () => {
    mocked(pool.queryOne).mockResolvedValue({ window_days: 7, short_abandon_secs: 5, callback_window_hours: 48 });
    mocked(pool.execute).mockResolvedValue({});
    expect(await A.saveFcrSettings(0, 5)).toBe(true);
    expect(mocked(pool.execute).mock.calls[0][1]).toEqual([0, 5, 48, 0, 5, 48]);
    mocked(pool.execute).mockRejectedValue(new Error('read only'));
    expect(await A.saveFcrSettings(3, 5, 12)).toBe(false);
  });

  test('a database without the callback column reads the defaults', async () => {
    mocked(pool.queryOne).mockRejectedValue(new Error("Unknown column 'callback_window_hours'"));
    expect(await A.getFcrSettings()).toEqual({ window_days: 7, short_abandon_secs: 5, callback_window_hours: 24 });
  });
});

describe('drilldown', () => {
  beforeEach(() => {
    settings({ '800': 15 });
    mocked(callLog).mockResolvedValue([
      call({ linkedid: 'a', calldate: dt('2026-10-05 08:00:00') }),
      call({ linkedid: 'b', calldate: dt('2026-10-05 09:00:00'), disposition: 'NO ANSWER', status: 'MISSED', talk: 0 }),
      call({ linkedid: 'c', calldate: dt('2026-10-05 10:00:00'), disposition: 'NO ANSWER', status: 'UNANSWERED', talk: 0 }),
      call({ linkedid: 'd', calldate: dt('2026-10-05 11:00:00'), call_type: 'OUT', app: 'direct', dst: '0122', status: 'BUSY', disposition: 'BUSY', talk: 0 }),
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

  test('a direct dial is no queue call: kept under a queue scope, no wait, no SLA', async () => {
    mocked(callLog).mockResolvedValue([call({ linkedid: 'x', app: 'direct', dst: '301', duration: 5 })]);
    const r = await A.computeDrilldown('2026-10-05', '2026-10-05', { allowedQueues: ['800'] });
    expect(r.calls[0]).toMatchObject({ queue_extension: '', wait_secs: 0, sla_met: false });
  });

  test('the queue and agent filters match exactly', async () => {
    mocked(callLog).mockResolvedValue([
      call({ linkedid: 'q', dst: '800' }),
      call({ linkedid: 'x', app: 'direct', dst: '800', extension: '800' }), // a direct dial to extension 800
      call({ linkedid: 'y', dst: '8001', extension: '2011' }),
    ]);
    const ids = async (o: A.DrilldownOptions) =>
      (await A.computeDrilldown('2026-10-05', '2026-10-05', o)).calls.map((c: { linkedid: string }) => c.linkedid);
    expect(await ids({ queueExt: '800' })).toEqual(['q']);
    expect(await ids({ queueExt: '80' })).toEqual([]);
    expect(await ids({ agentExt: '201' })).toEqual(['q']);
    expect(await ids({ agentExt: ' 2011 ' })).toEqual(['y']);
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
    expect(r.facets).toEqual({
      direction: { IN: 4, OUT: 1 },
      status: { ANSWERED: 2, MISSED: 1, UNANSWERED: 1 },
      queue: { 800: 3, 900: 1 },
      agent: { 201: 4 },
    });
    expect(r.total).toBe(4);
    expect(r.calls.map((c: { linkedid: string }) => c.linkedid)).toEqual(['c']);
    expect(r).toMatchObject({ page: 2, page_size: 1 });
  });

  test('a facet ignores its own filter but honours its siblings', async () => {
    const r = await A.computeDrilldown('2026-10-05', '2026-10-05', { queueExt: '900', facets: true });
    expect(r.total).toBe(1);
    expect(r.facets.queue).toEqual({ 800: 3, 900: 1 });
    expect(r.facets.status).toEqual({ ANSWERED: 1 });
  });
});

describe('one agent\'s calls', () => {
  const row = (o: Record<string, unknown>) => ({ calldate: dt('2026-10-19 10:00:00'), src: '', talk: 0, ...o });

  test('paging and filtering one agent reuse the scan', async () => {
    settings();
    mocked(callLog).mockResolvedValueOnce([row({ call_type: 'OUT', extension: '1012', status: 'ANSWERED' })]);
    await A.computeAgentCalls('1012', '2026-10-01', '2026-10-21');
    const second = await A.computeAgentCalls('1012', '2026-10-01', '2026-10-21', { status: 'answered', page: 2 });
    expect(callLog).toHaveBeenCalledTimes(1);
    expect(second).toMatchObject({ total: 1, page: 1 }); // page 2 of 1 is clamped to the last page
  });

  test('splits by direction, and a call that only rang this agent reads as missed', async () => {
    settings();
    mocked(callLog).mockResolvedValueOnce([
      row({ calldate: dt('2026-10-19 10:04:00'), call_type: 'OUT', extension: '1012', status: 'ANSWERED', talk: 60 }),
      row({ calldate: dt('2026-10-19 10:03:00'), call_type: 'OUT', extension: '1012', status: 'UNANSWERED' }),
      // A queue call that rang 1012 while a colleague answered.
      row({ calldate: dt('2026-10-19 10:02:00'), call_type: 'IN', app: 'queue', dst: '800', extension: '1015', status: 'ANSWERED', talk: 40 }),
      // An internal call 1012 placed.
      row({ calldate: dt('2026-10-19 10:01:00'), call_type: 'INTERNAL', extension: '1004', src: '1012', status: 'ANSWERED', talk: 5 }),
    ]);
    const out = await A.computeAgentCalls('1012', '2026-10-01', '2026-10-21');
    expect(callLog).toHaveBeenLastCalledWith(expect.objectContaining({ allowedExtensions: ['1012'], outcomes: true, enrich: false }));
    const byDir = Object.fromEntries((out.directions as A.AgentDirectionSummary[]).map((d) => [d.direction, d]));
    expect(Object.keys(byDir)).toEqual(['IN', 'OUT', 'INTERNAL']);
    expect(byDir.OUT).toMatchObject({ calls: 2, answered: 1, missed: 0, not_connected: 1, talk_secs: 60 });
    expect(byDir.IN).toMatchObject({ calls: 1, answered: 0, missed: 1, talk_secs: 0 });
    expect(byDir.INTERNAL).toMatchObject({ calls: 1, answered: 1, talk_secs: 5 });
    expect(out.calls.map((c: { direction: string; is_handled: boolean; agent_status: string; queue_extension: string }) =>
      [c.direction, c.is_handled, c.agent_status, c.queue_extension])).toEqual([
      ['OUT', true, 'ANSWERED', ''],
      ['OUT', true, 'UNANSWERED', ''],
      ['IN', false, 'MISSED', '800'],
      ['INTERNAL', true, 'ANSWERED', ''],
    ]);
    expect(out.status_counts).toEqual({ ANSWERED: 2, UNANSWERED: 1, MISSED: 1 });
    expect(out.calls[0].calldate).toBe('2026-10-19T10:04:00');
  });

  test('direction and status filter the list, never the summary', async () => {
    settings();
    mocked(callLog).mockResolvedValueOnce([
      row({ call_type: 'OUT', extension: '1012', status: 'ANSWERED' }),
      row({ call_type: 'OUT', extension: '1012', status: 'BUSY' }),
      row({ call_type: 'IN', extension: '1012', status: 'MISSED' }),
    ]);
    const out = await A.computeAgentCalls('1012', '2026-10-01', '2026-10-21', { direction: 'out', status: 'busy' });
    expect(out.total).toBe(1);
    expect(out.calls[0].status).toBe('BUSY');
    // Statuses are counted under the direction filter, ignoring their own.
    expect(out.status_counts).toEqual({ ANSWERED: 1, BUSY: 1 });
    expect((out.directions as A.AgentDirectionSummary[]).reduce((n, d) => n + d.calls, 0)).toBe(3);
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
