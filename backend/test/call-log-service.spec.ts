/**
 * services/call-log, the Call History row itself: who the customer is (cnam only on inbound
 * calls, else the phonebook), the agent's name, the route, the status of a multi-leg call
 * (the leg a party answered, not the last one), queue abandons, the journey of a blind
 * transfer, and the server-side filtered page. The database is mocked.
 */

jest.mock('../src/db/db-manager', () => ({
  getCallLogFromDb: jest.fn(async () => []),
  getCallLogCountFromDb: jest.fn(async () => 0),
  celHangupsByLinkedid: jest.fn(async () => ({})),
  celIvrStepsByLinkedid: jest.fn(async () => []),
  getIvrNamesFromDb: jest.fn(async () => ({})),
  getSupervisionBySpyKeys: jest.fn(async () => ({})),
  getSupervisionTargets: jest.fn(async () => ({})),
  getCdrByLinkedid: jest.fn(async () => []),
  getAgentNameByExtension: jest.fn(async () => null),
  getExtensionNamesFromDb: jest.fn(async () => ({ '100': 'Hema', '1001': 'Omar', '1002': 'Sara' })),
}));
jest.mock('../src/services/recording', () => ({
  getRecordingPath: jest.fn(async (f: string) => `/var/spool/asterisk/monitor/2026/10/17/${f}`),
  invalidateRecordingIndex: jest.fn(),
  recordingRoot: jest.fn(async () => '/var/spool/asterisk/monitor'),
}));

import { isoformat } from '../src/core/py';
import * as dbm from '../src/db/db-manager';
import * as cl from '../src/services/call-log';

const mocked = (fn: unknown) => fn as jest.Mock;
const D = (h: number, mi: number, s: number) => new Date(2026, 9, 20, h, mi, s);

afterEach(() => {
  cl.setContactNameResolver(null);
  jest.clearAllMocks();
});

/** A getCallLogFromDb row: one call, its first leg joined with its outcome leg. */
const row = (over: Record<string, unknown> = {}) => ({
  calldate: D(10, 0, 0), src: '01001234567', dst: '100', dcontext: 'from-did-direct', answered_by: '100',
  last_channel: 'PJSIP/trunk1-00000001', dstchannel: 'PJSIP/100-00000002', lastapp: 'Dial', first_lastapp: 'Dial',
  duration: 30, billsec: 20, disposition: 'ANSWERED', channel: 'PJSIP/trunk1-00000001', recordingfile: null,
  cnam: '', uniqueid: '1.1', linkedid: '1.1', userfield: '', call_journey_count: 1, party_answered: 1, queue_legs: 0,
  call_app: 'direct', ...over,
});

describe('resolveCustomerName', () => {
  it('a real cnam wins; noise or the number again falls back to the phonebook', () => {
    cl.setContactNameResolver((n) => (n === '01001234567' ? 'Book Name' : null));
    expect(cl.resolveCustomerName('Acme Corp', '01001234567')).toBe('Acme Corp');
    expect(cl.resolveCustomerName('01001234567', '01001234567')).toBe('Book Name');
    expect(cl.resolveCustomerName('+20 100 123-4567', '201001234567')).toBeNull(); // the number, formatted
    for (const noise of ['', 'Unknown', '<unknown>', 'anonymous', 'RESTRICTED', 'private', null]) {
      expect(cl.resolveCustomerName(noise, '01001234567')).toBe('Book Name');
    }
    expect(cl.resolveCustomerName(null, '01009999999')).toBeNull();
  });

  it('keeps a digit-free name against a withheld number, and survives a failing resolver', () => {
    expect(cl.resolveCustomerName('Anonymous Caller', '')).toBe('Anonymous Caller');
    expect(cl.resolveCustomerName('Restricted', '')).toBeNull();
    cl.setContactNameResolver(() => {
      throw new Error('boom');
    });
    expect(cl.resolveCustomerName('', '01001234567')).toBeNull();
  });
});

describe('callLog rows: customer, agent, route', () => {
  beforeEach(() => cl.setContactNameResolver((n) => ({ '01001234567': 'Book Name', '01155555555': 'Customer B' })[n] ?? null));

  it("an outbound or internal row never reads the agent's own cnam as the customer", async () => {
    mocked(dbm.getCallLogFromDb).mockResolvedValue([
      // The *43 test call of agent 100 "hema": cnam is the caller -- our agent.
      row({ src: '100', dst: '*43', dcontext: 'from-internal', cnam: 'hema', channel: 'PJSIP/100-00000002',
        last_channel: 'PJSIP/100-00000002', dstchannel: '', lastapp: 'BackGround', first_lastapp: 'BackGround',
        billsec: 3, duration: 3, party_answered: 0, linkedid: '2.1', uniqueid: '2.1' }),
      // 100 calls a customer: cnam is 100's name again; the phonebook names the customer.
      row({ src: '100', dst: '01155555555', dcontext: 'from-internal', cnam: 'hema', channel: 'PJSIP/100-00000003',
        last_channel: 'PJSIP/100-00000003', dstchannel: 'PJSIP/trunk1-00000004', linkedid: '3.1', uniqueid: '3.1' }),
      // 100 calls 101.
      row({ src: '100', dst: '101', dcontext: 'ext-local', cnam: 'hema', channel: 'PJSIP/100-00000005',
        dstchannel: 'PJSIP/101-00000006', linkedid: '4.1', uniqueid: '4.1' }),
    ]);
    const [star43, out, internal] = await cl.callLog({});
    expect(star43).toMatchObject({ call_type: 'INTERNAL', route: 'internal_feature', customer_name: null, extension: null });
    expect(out).toMatchObject({ call_type: 'OUT', route: 'outbound_direct', phone_number: '01155555555',
      customer_name: 'Customer B', extension: '100', agent_name: 'Hema' });
    expect(internal).toMatchObject({ call_type: 'INTERNAL', route: 'internal_extension', customer_name: null });
  });

  it('an inbound row keeps a real cnam, replaces one that is only the number', async () => {
    mocked(dbm.getCallLogFromDb).mockResolvedValue([row({ cnam: 'Acme Corp' }), row({ cnam: '01001234567', linkedid: '5.1' })]);
    const [real, numberOnly] = await cl.callLog({});
    expect(real).toMatchObject({ call_type: 'IN', customer_name: 'Acme Corp', route: 'inbound_direct' });
    expect(numberOnly.customer_name).toBe('Book Name');
  });

  it('agent_name, canonical_status, route: present and consistent', async () => {
    mocked(dbm.getCallLogFromDb).mockResolvedValue([
      row({ dst: '400', dcontext: 'ext-queues', dstchannel: 'Local/1001@from-queue-00000001;1', lastapp: 'Queue',
        first_lastapp: 'Queue', queue_legs: 2, call_app: 'queue' }),
    ]);
    const [r] = await cl.callLog({});
    expect(r).toMatchObject({ status: 'ANSWERED', canonical_status: 'ANSWERED', extension: '1001', agent_name: 'Omar',
      route: 'inbound_queue' });
  });

  it('enrich=false names the customer but skips the agent-name lookup (analytics scan, CSV)', async () => {
    mocked(dbm.getCallLogFromDb).mockResolvedValue([row({ cnam: '' })]);
    const [r] = await cl.callLog({ enrich: false });
    expect(r.customer_name).toBe('Book Name');
    expect(r.agent_name).toBeNull();
    expect(dbm.getExtensionNamesFromDb).not.toHaveBeenCalled();
  });

  it('callRoute', () => {
    expect(cl.callRoute({ call_type: 'INTERNAL', first_lastapp: 'ChanSpy', dst: 's' })).toBe('internal_supervision');
    expect(cl.callRoute({ call_type: 'INTERNAL', linkedid: 'spy-300-100-1', dst: 's' })).toBe('internal_supervision');
    expect(cl.callRoute({ call_type: 'OUT', dst: '*97', dcontext: 'from-internal' })).toBe('internal_feature');
    expect(cl.callRoute({ call_type: 'IN', dst: '5446', dcontext: 'app-announcement-1' })).toBe('inbound_direct');
    expect(cl.callRoute({ call_type: 'IN', dst: '400', dcontext: 'ivr-2', queue_legs: 1 })).toBe('inbound_queue');
    expect(cl.callRoute({ call_type: 'IN', dst: 's', dcontext: 'ivr-2' })).toBe('inbound_ivr');
    expect(cl.routeSide('inbound_queue')).toBe('inbound');
  });
});

describe('a multi-leg call is read from the leg a party answered', () => {
  // 1001 answered and talked 60 s, then blind-transferred to 1002, who never picked up.
  const LEGS = [
    { sequence: 1, calldate: D(10, 0, 0), billsec: 60, duration: 65, disposition: 'ANSWERED', src: '01001234567', dst: '1001',
      dcontext: 'from-did-direct', channel: 'PJSIP/trunk1-00000001', dstchannel: 'PJSIP/1001-00000002', lastapp: 'Dial',
      uniqueid: '7.1', linkedid: '7.1' },
    { sequence: 2, calldate: D(10, 1, 5), billsec: 0, duration: 20, disposition: 'NO ANSWER', src: '01001234567', dst: '1002',
      dcontext: 'from-internal-xfer', channel: 'PJSIP/trunk1-00000001', dstchannel: 'PJSIP/1002-00000003', lastapp: 'Dial',
      uniqueid: '7.2', linkedid: '7.1' },
  ];

  it('outcomeLeg and callSpanSeconds', () => {
    expect(cl.outcomeLeg(LEGS)).toBe(LEGS[0]);
    expect(cl.outcomeLeg([LEGS[1]])).toBe(LEGS[1]);
    expect(cl.outcomeLeg([{ ...LEGS[0], dstchannel: '' }, LEGS[1]])).toBe(LEGS[1]); // an app answering is not a party
    expect(cl.callSpanSeconds(LEGS)).toBe(85);
    expect(cl.callSpanSeconds([])).toBeNull();
  });

  it('the CRM identity says ANSWERED by 1001 with 60 s of talk, not MISSED by 1002', async () => {
    mocked(dbm.getCdrByLinkedid).mockResolvedValue([...LEGS].reverse());
    mocked(dbm.getAgentNameByExtension).mockResolvedValue('Omar');
    expect(await cl.crmIdentityFromCdr('7.1')).toMatchObject({
      call_status: 'ANSWERED', agent: '1001', agent_name: 'Omar', talk_time: '00:01:00', duration: '00:01:25',
    });
  });

  it('the Call History row (the SQL picks the same leg) reads the same', async () => {
    mocked(dbm.getCallLogFromDb).mockResolvedValue([
      row({ dst: '1001', last_channel: LEGS[0].channel, dstchannel: LEGS[0].dstchannel, billsec: 60, duration: 85,
        call_journey_count: 2, linkedid: '7.1' }),
    ]);
    const [r] = await cl.callLog({});
    expect(r).toMatchObject({ status: 'ANSWERED', talk: 60, duration: 85, extension: '1001', agent_name: 'Omar' });
  });

  it('the journey agrees: ANSWER by 1001, TRANSFER to 1002, UNANSWERED by 1002', async () => {
    const j = await cl.buildCallJourneyFromCdr(LEGS, null, { cel: {}, ivrSteps: [] });
    expect(j.map((e) => [e.event, e.time, e.agent ?? null])).toEqual([
      ['INBOUND', '2026-10-20T10:00:00', null],
      ['ANSWER', '2026-10-20T10:00:05', '1001'],
      ['TRANSFER', '2026-10-20T10:01:05', '1002'],
      ['UNANSWERED', '2026-10-20T10:01:25', '1002'],
      ['HANGUP', '2026-10-20T10:01:25', null],
    ]);
  });

  it('a transfer that was answered shows its ANSWER', async () => {
    const legs = [LEGS[0], { ...LEGS[1], billsec: 15, disposition: 'ANSWERED' }];
    const j = await cl.buildCallJourneyFromCdr(legs, null, { cel: {}, ivrSteps: [] });
    expect(j.filter((e) => e.event === 'ANSWER').map((e) => [e.agent, e.time])).toEqual([
      ['1001', '2026-10-20T10:00:05'],
      ['1002', '2026-10-20T10:01:10'],
    ]);
  });
});

describe('queue abandons', () => {
  // The caller waited in queue 400 (answered for music on hold, so the leg has billsec),
  // 1001 rang and never answered, and the caller hung up.
  const QUEUED = row({
    dst: '400', dcontext: 'ext-queues', dstchannel: 'Local/1001@from-queue-00000001;1', last_channel: 'PJSIP/trunk1-00000001',
    lastapp: 'Queue', first_lastapp: 'Queue', disposition: 'ANSWERED', billsec: 25, duration: 25, party_answered: 0,
    queue_legs: 1, call_app: 'queue', linkedid: '8.1',
  });
  const callerHungUp = { 'PJSIP/trunk1-00000001': { cause: '16', source: 'PJSIP/trunk1-00000001', dialstatus: '', seq: 3 } };

  it('the caller hanging up while queued is ABANDONED', () => {
    expect(cl.queueAbandoned(QUEUED, callerHungUp)).toBe(true);
    expect(cl.outcomeFromCel(QUEUED, callerHungUp)).toBe('ABANDONED');
  });

  it('not when the queue or the dialplan ended it, an agent answered, or the call moved on', () => {
    const dialplan = { 'PJSIP/trunk1-00000001': { cause: '16', source: 'dialplan/builtin', dialstatus: '', seq: 3 } };
    expect(cl.queueAbandoned(QUEUED, dialplan)).toBe(false);
    expect(cl.queueAbandoned({ ...QUEUED, party_answered: 1 }, callerHungUp)).toBe(false);
    expect(cl.queueAbandoned({ ...QUEUED, lastapp: 'VoiceMail' }, callerHungUp)).toBe(false); // queue failover
    expect(cl.queueAbandoned({ ...QUEUED, lastapp: 'Dial' }, callerHungUp)).toBe(false);
  });

  it('without CEL a call that ended inside Queue() with nobody answering is an abandon', () => {
    expect(cl.queueAbandoned(QUEUED, {})).toBe(true);
    // A row without the SQL flags (the CRM path) decides from its own leg.
    const { party_answered: _p, ...bare } = QUEUED;
    expect(cl.queueAbandoned({ ...bare, billsec: 0 }, null)).toBe(true);
    expect(cl.queueAbandoned({ ...bare, billsec: 30, dstchannel: 'Local/1001@from-queue-1;1' }, null)).toBe(false);
  });

  it('reaches the row, and the journey still ends with the customer hanging up', async () => {
    mocked(dbm.getCallLogFromDb).mockResolvedValue([QUEUED]);
    mocked(dbm.celHangupsByLinkedid).mockResolvedValue({ '8.1': callerHungUp });
    const [r] = await cl.callLog({});
    expect(r).toMatchObject({ status: 'ABANDONED', route: 'inbound_queue', ended_by: 'customer' });
  });
});

describe('callLogPage', () => {
  const rows = [
    row({ linkedid: 'a', calldate: D(10, 4, 0), disposition: 'NO ANSWER', billsec: 0, party_answered: 0, dstchannel: 'PJSIP/100-1' }),
    row({ linkedid: 'b', calldate: D(10, 3, 0) }),
    row({ linkedid: 'c', calldate: D(10, 2, 0), dst: '400', dcontext: 'ext-queues', first_lastapp: 'Queue', lastapp: 'Queue',
      queue_legs: 1, call_app: 'queue' }),
    row({ linkedid: 'd', calldate: D(10, 1, 0), src: '100', dst: '01155555555', dcontext: 'from-internal', channel: 'PJSIP/100-9',
      dstchannel: 'PJSIP/trunk1-9' }),
  ];
  const cursorOf = (calldate: Date, linkedid: string) =>
    Buffer.from(JSON.stringify([isoformat(calldate), linkedid]), 'utf8').toString('base64url');

  it('no table filter: one keyset page (one row over says there is more) and its COUNT', async () => {
    mocked(dbm.getCallLogFromDb).mockResolvedValue(rows.slice(0, 3));
    mocked(dbm.getCallLogCountFromDb).mockResolvedValue(57);
    const page = await cl.callLogPage({ limit: 2, allowedExtensions: ['100'], search: 'x', excludeSupervision: true });
    expect(page.total).toBe(57);
    expect(page.calls.map((c) => c.linkedid)).toEqual(['a', 'b']);
    expect(page.next_cursor).toBe(cursorOf(D(10, 3, 0), 'b'));
    expect(mocked(dbm.getCallLogFromDb).mock.calls[0][0]).toMatchObject({ limit: 3, after: null, order: 'desc',
      allowedExtensions: ['100'], search: 'x', excludeSupervision: true });
    expect(mocked(dbm.getCallLogCountFromDb).mock.calls[0][0]).toEqual({ date: null, dateFrom: null, dateTo: null,
      allowedExtensions: ['100'], search: 'x', excludeSupervision: true });

    // The next page starts after that call; the last page has no cursor.
    mocked(dbm.getCallLogFromDb).mockResolvedValue(rows.slice(2, 4));
    const next = await cl.callLogPage({ limit: 2, cursor: page.next_cursor, order: 'asc' });
    expect(mocked(dbm.getCallLogFromDb).mock.calls[1][0]).toMatchObject({ after: [isoformat(D(10, 3, 0)), 'b'], order: 'asc' });
    expect(next.next_cursor).toBeNull();
    // A cursor that does not decode is the first page, not an error.
    await cl.callLogPage({ limit: 2, cursor: 'garbage' });
    expect(mocked(dbm.getCallLogFromDb).mock.calls[2][0].after).toBeNull();
  });

  it('with filters: scans the window with CEL, filters, pages after the cursor, enriches only the page', async () => {
    mocked(dbm.getCallLogFromDb).mockResolvedValue(rows);
    const page = await cl.callLogPage({ limit: 1, filters: { route: new Set(['inbound']) } });
    expect(mocked(dbm.getCallLogFromDb).mock.calls[0][0]).toMatchObject({ limit: cl.CALL_LOG_SCAN_MAX, after: null });
    expect(dbm.celHangupsByLinkedid).toHaveBeenCalled();
    expect(dbm.getCallLogCountFromDb).not.toHaveBeenCalled();
    expect(page.total).toBe(3); // a, b, c are inbound; d is outbound
    expect(page.calls.map((c) => c.linkedid)).toEqual(['a']);
    expect(page.calls[0].agent_name).toBe('Hema');
    expect(page.capped).toBeUndefined();

    mocked(dbm.getCallLogFromDb).mockResolvedValue(rows);
    const second = await cl.callLogPage({ limit: 1, cursor: page.next_cursor, filters: { route: new Set(['inbound']) } });
    expect(second.calls.map((c) => c.linkedid)).toEqual(['b']);
    mocked(dbm.getCallLogFromDb).mockResolvedValue(rows);
    const last = await cl.callLogPage({ limit: 5, cursor: second.next_cursor, filters: { route: new Set(['inbound']) } });
    expect(last.calls.map((c) => c.linkedid)).toEqual(['c']);
    expect(last.next_cursor).toBeNull();

    mocked(dbm.getCallLogFromDb).mockResolvedValue(rows);
    const answered = await cl.callLogPage({ limit: 10, filters: { status: new Set(['ANSWERED']), route: new Set(['inbound_queue']) } });
    expect(answered.calls.map((c) => c.linkedid)).toEqual(['c']);
  });

  it('matchesCallLogFilters', () => {
    const r = { status: 'BUSY', call_type: 'OUT', app: 'direct', route: 'outbound_direct' };
    expect(cl.matchesCallLogFilters(r, null)).toBe(true);
    expect(cl.matchesCallLogFilters(r, { status: new Set(['BUSY']), callType: new Set(['OUT']) })).toBe(true);
    expect(cl.matchesCallLogFilters(r, { status: new Set(['MISSED']) })).toBe(false);
    expect(cl.matchesCallLogFilters(r, { route: new Set(['outbound']) })).toBe(true);
    expect(cl.matchesCallLogFilters(r, { route: new Set(['outbound_direct', 'internal']) })).toBe(true);
    expect(cl.matchesCallLogFilters(r, { route: new Set(['inbound']) })).toBe(false);
    expect(cl.matchesCallLogFilters(r, { app: new Set(['queue']) })).toBe(false);
    expect(cl.hasCallLogFilters({ status: new Set() })).toBe(false);
  });
});
