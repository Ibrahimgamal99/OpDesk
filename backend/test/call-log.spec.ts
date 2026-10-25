/**
 * services/call-log: channel -> agent, direction, Call History rows (status from CEL,
 * ended_by, supervision) and the call journey -- on this PBX's real CDR rows and on the
 * synthetic FreePBX queue call from the area-2 analysis (scratchpad sim/r.py): trunk to
 * queue 400, member 101 rings out, 102 answers, transfer to 103, across midnight.
 * The database is mocked.
 */

jest.mock('../src/db/db-manager', () => ({
  getCallLogFromDb: jest.fn(),
  celHangupsByLinkedid: jest.fn(async () => ({})),
  celIvrStepsByLinkedid: jest.fn(async () => []),
  getIvrNamesFromDb: jest.fn(async () => ({})),
  getSupervisionBySpyKeys: jest.fn(async () => ({})),
  getSupervisionTargets: jest.fn(async () => ({})),
  getCdrByLinkedid: jest.fn(),
  getAgentNameByExtension: jest.fn(async () => null),
}));
jest.mock('../src/services/recording', () => ({
  getRecordingPath: jest.fn(async (f: string) => `/var/spool/asterisk/monitor/2026/10/17/${f}`),
  invalidateRecordingIndex: jest.fn(),
  recordingRoot: jest.fn(async () => '/var/spool/asterisk/monitor'),
}));

import * as dbm from '../src/db/db-manager';
import {
  buildCallJourneyFromCdr,
  callLog,
  classifyCdrDirection,
  convertChannelToExtension,
  crmIdentityFromCdr,
} from '../src/services/call-log';

const mocked = (fn: unknown) => fn as jest.Mock;
const D = (y: number, mo: number, d: number, h: number, mi: number, s: number) => new Date(y, mo - 1, d, h, mi, s);

// asteriskcdrdb.cdr on this box (read-only), 2026-10-17.
const LIVE_BUSY = {
  sequence: 1, calldate: D(2026, 10, 17, 17, 31, 55), billsec: 0, duration: 4, disposition: 'BUSY', src: '199', dst: '100',
  dcontext: 'ext-local', channel: 'Local/100@from-internal-00000000;2', dstchannel: 'PJSIP/100-00000000', lastapp: 'Dial',
  uniqueid: '1792247515.1', linkedid: '1792247515.0',
};
const LIVE_STAR43 = {
  sequence: 10, calldate: D(2026, 10, 17, 18, 46, 20), billsec: 3, duration: 3, disposition: 'ANSWERED', src: '100', dst: '*43',
  dcontext: 'from-internal', channel: 'PJSIP/100-00000002', dstchannel: '', lastapp: 'BackGround',
  uniqueid: '1792251980.10', linkedid: '1792251980.10',
};
const BUSY_CEL = {
  'PJSIP/100-00000000': { cause: '17', source: 'PJSIP/100-00000000', dialstatus: '', seq: 4 },
  'Local/100@from-internal-00000000;1': { cause: '0', source: '', dialstatus: '', seq: 6 },
  'Local/100@from-internal-00000000;2': { cause: '17', source: '', dialstatus: 'BUSY', seq: 8 },
};
const QUEUE_CALL = [
  { sequence: 1, calldate: D(2026, 10, 17, 23, 59, 50), billsec: 0, duration: 15, disposition: 'NO ANSWER', src: '01001234567', dst: '400',
    dcontext: 'ext-queues', channel: 'PJSIP/trunk1-00000010', dstchannel: 'Local/101@from-queue-00000005;1', lastapp: 'Queue', uniqueid: '1.1', linkedid: '1.1' },
  { sequence: 2, calldate: D(2026, 10, 17, 23, 59, 58), billsec: 40, duration: 45, disposition: 'ANSWERED', src: '01001234567', dst: '400',
    dcontext: 'ext-queues', channel: 'PJSIP/trunk1-00000010', dstchannel: 'Local/102@from-queue-00000006;1', lastapp: 'Queue', uniqueid: '1.1', linkedid: '1.1' },
  { sequence: 3, calldate: D(2026, 10, 18, 0, 0, 40), billsec: 20, duration: 22, disposition: 'ANSWERED', src: '01001234567', dst: '103',
    dcontext: 'from-internal-xfer', channel: 'PJSIP/trunk1-00000010', dstchannel: 'PJSIP/103-00000012', lastapp: 'Dial', uniqueid: '1.2', linkedid: '1.1' },
];

beforeEach(() => jest.clearAllMocks());

describe('convertChannelToExtension', () => {
  it.each([
    ['PJSIP/100-00000000', 'Local/100@from-internal-00000000;2', '100'],
    ['Local/101@from-queue-00000005;1', 'PJSIP/trunk1-00000010', '101'], // was 'trunk1'
    ['SIP/2001-0000abcd', '', '2001'],
    ['PJSIP/trunk1-00000001', 'PJSIP/100-00000003', '100'], // outbound: the agent who dialled
    ['PJSIP/trunk1-00000001', 'PJSIP/trunk2-00000003', null], // trunk to trunk: no agent
    ['', 'PJSIP/100-00000002', null], // *43 feature code: reached nobody, so no answering agent
    [null, 'PJSIP/100-00000002', null],
    ['garbage', 'PJSIP/100-00000002', null],
  ])('(%p, %p) -> %p', (dst, ch, expected) => {
    expect(convertChannelToExtension(dst, ch)).toBe(expected);
  });
});

describe('classifyCdrDirection', () => {
  it('reads the live and synthetic calls as before', () => {
    expect(classifyCdrDirection(LIVE_BUSY)).toBe('INTERNAL');
    expect(classifyCdrDirection(LIVE_STAR43)).toBe('INTERNAL'); // feature code stays internal
    expect(classifyCdrDirection(QUEUE_CALL[0])).toBe('IN');
    expect(classifyCdrDirection({ src: '100', dst: '01001234567', dcontext: 'from-internal', dstchannel: 'PJSIP/trunk1-1' })).toBe('OUT');
  });
});

describe('callLog rows', () => {
  const row = (over: Record<string, unknown> = {}) => ({
    calldate: LIVE_BUSY.calldate, src: '199', dst: '100', dcontext: 'ext-local', answered_by: '100',
    last_channel: 'Local/100@from-internal-00000000;2', dstchannel: 'PJSIP/100-00000000', lastapp: 'Dial',
    first_lastapp: 'Dial', duration: 4, billsec: 0, disposition: 'BUSY', channel: 'Local/100@from-internal-00000000;2',
    recordingfile: null, cnam: '', uniqueid: '1792247515.1', linkedid: '1792247515.0', userfield: '',
    call_journey_count: 1, call_app: 'direct', ...over,
  });

  it('status, ended_by and agent from CEL; disposition stays raw', async () => {
    mocked(dbm.getCallLogFromDb).mockResolvedValue([row()]);
    mocked(dbm.celHangupsByLinkedid).mockResolvedValue({ '1792247515.0': BUSY_CEL });
    const [r] = await callLog({ dateFrom: '2026-10-17' });
    expect(r).toMatchObject({
      status: 'BUSY', disposition: 'BUSY', extension: '100', call_type: 'INTERNAL', ended_by: 'agent', ended_by_agent: '100',
      is_supervision: false, supervision: null, recording_path: null, recording_file: null, customer_name: null,
    });
    expect(dbm.celHangupsByLinkedid).toHaveBeenCalledWith(['1792247515.0']);
  });

  it('a supervised call carries supervision_count and a journey button; the spy leg is flagged', async () => {
    mocked(dbm.getCallLogFromDb).mockResolvedValue([
      row(),
      row({ linkedid: 'spy-101-100-1', uniqueid: 'spy-101-100-1', src: '100', dst: 's', recordingfile: 'x.wav' }),
    ]);
    mocked(dbm.getSupervisionTargets).mockResolvedValue({ '1792247515.0': [{ mode: 'listen' }, { mode: 'barge' }] });
    mocked(dbm.getSupervisionBySpyKeys).mockResolvedValue({
      'spy-101-100-1': { mode: 'listen', supervisor_extension: '101', target_extension: '100', target_linkedid: '1792247515.0' },
    });
    const [target, spy] = await callLog({});
    expect(target).toMatchObject({ supervision_count: 2, call_journey_count: 2 });
    expect(spy).toMatchObject({
      is_supervision: true,
      supervision: { mode: 'listen', supervisor_extension: '101', target_extension: '100', target_linkedid: '1792247515.0' },
      recording_path: '/var/spool/asterisk/monitor/2026/10/17/x.wav',
    });
  });

  it('enrich=false skips CEL, supervision and recording paths (analytics scan)', async () => {
    mocked(dbm.getCallLogFromDb).mockResolvedValue([row({ recordingfile: 'x.wav' })]);
    const [r] = await callLog({ enrich: false });
    expect(dbm.celHangupsByLinkedid).not.toHaveBeenCalled();
    expect(dbm.getSupervisionTargets).not.toHaveBeenCalled();
    expect(r.recording_path).toBeNull();
    expect(r.recording_file).toBe('x.wav');
    expect(r.status).toBe('BUSY'); // from the disposition
    expect(r.ended_by).toBeNull();
  });

  it('enrich=false, outcomes=true reads CEL only', async () => {
    mocked(dbm.getCallLogFromDb).mockResolvedValue([row({ disposition: 'NO ANSWER' })]);
    mocked(dbm.celHangupsByLinkedid).mockResolvedValue({ '1792247515.0': BUSY_CEL });
    const [r] = await callLog({ enrich: false, outcomes: true });
    expect(r.status).toBe('BUSY');
    expect(dbm.getSupervisionTargets).not.toHaveBeenCalled();
  });
});

describe('buildCallJourneyFromCdr', () => {
  it('live BUSY Dial: OUTBOUND first, no ANSWER, UNANSWERED, ended by agent 100', async () => {
    const j = await buildCallJourneyFromCdr([LIVE_BUSY], null, { cel: BUSY_CEL, ivrSteps: [] });
    expect(j).toEqual([
      { event: 'OUTBOUND', time: '2026-10-17T17:31:55', to_number: '100', duration: 4 },
      { event: 'UNANSWERED', time: '2026-10-17T17:31:59', agent: '100' },
      { event: 'HANGUP', time: '2026-10-17T17:31:59', reason: 'BUSY', ended_by: 'agent', ended_by_agent: '100' },
    ]);
    expect(j.some((e) => e.event === 'ANSWER')).toBe(false);
  });

  it('a rang-out Dial shows RING then UNANSWERED', async () => {
    const leg = { ...LIVE_BUSY, disposition: 'NO ANSWER', duration: 20 };
    const j = await buildCallJourneyFromCdr([leg], null, { cel: {}, ivrSteps: [] });
    expect(j.map((e) => e.event)).toEqual(['OUTBOUND', 'RING', 'UNANSWERED', 'HANGUP']);
    expect(j[1]).toMatchObject({ agent: '100', duration: 20 });
  });

  it('an answered Dial keeps ANSWER at the answer time', async () => {
    const leg = { ...LIVE_BUSY, disposition: 'ANSWERED', duration: 30, billsec: 22 };
    const j = await buildCallJourneyFromCdr([leg], null, { cel: {}, ivrSteps: [] });
    expect(j.map((e) => [e.event, e.time])).toEqual([
      ['OUTBOUND', '2026-10-17T17:31:55'],
      ['ANSWER', '2026-10-17T17:32:03'],
      ['HANGUP', '2026-10-17T17:32:25'],
    ]);
  });

  it('the *43 call (neither Queue nor Dial) still gets its HANGUP', async () => {
    const cel = { 'PJSIP/100-00000002': { cause: '16', source: 'PJSIP/100-00000002', dialstatus: '', seq: 32 } };
    const j = await buildCallJourneyFromCdr([LIVE_STAR43], null, { cel, ivrSteps: [] });
    expect(j).toEqual([
      { event: 'OUTBOUND', time: '2026-10-17T18:46:20', to_number: '*43', duration: 3 },
      { event: 'HANGUP', time: '2026-10-17T18:46:23', reason: 'ANSWERED', ended_by: 'agent', ended_by_agent: '100' },
    ]);
  });

  it('queue call across midnight: real agents, chronological, no negative durations', async () => {
    const j = await buildCallJourneyFromCdr([...QUEUE_CALL].reverse(), null, { cel: {}, ivrSteps: [] });
    expect(j.map((e) => [e.event, e.time, e.agent ?? null])).toEqual([
      ['INBOUND', '2026-10-17T23:59:50', null],
      ['QUEUE_ENTER', '2026-10-17T23:59:50', null],
      ['RING', '2026-10-17T23:59:50', '101'],
      ['TRANSFER', '2026-10-17T23:59:58', '102'],
      ['RING', '2026-10-17T23:59:58', '102'],
      ['ANSWER', '2026-10-18T00:00:03', '102'],
      ['UNANSWERED', '2026-10-18T00:00:05', '101'],
      ['TRANSFER', '2026-10-18T00:00:40', '103'],
      ['RING', '2026-10-18T00:00:40', '103'],
      ['ANSWER', '2026-10-18T00:00:42', '103'],
      ['HANGUP', '2026-10-18T00:01:02', null],
    ]);
    for (const e of j) if (e.duration !== undefined) expect(e.duration).toBeGreaterThan(0);
    expect(j[0]).toMatchObject({ from_number: '01001234567' });
    expect(j.find((e) => e.event === 'QUEUE_ENTER')).toMatchObject({ queue: '400' });
  });

  it('supervision events are slotted in by time', async () => {
    const leg = { ...LIVE_BUSY, disposition: 'ANSWERED', duration: 60, billsec: 55 };
    const sup = [{ mode: 'whisper', created_at: D(2026, 10, 17, 17, 32, 30), supervisor_extension: '101', target_extension: '100' }];
    const j = await buildCallJourneyFromCdr([leg], sup, { cel: {}, ivrSteps: [] });
    expect(j.map((e) => e.event)).toEqual(['OUTBOUND', 'ANSWER', 'WHISPER', 'HANGUP']);
    expect(j[2]).toMatchObject({ time: '2026-10-17T17:32:30', supervisor: '101', target: '100' });
  });

  it('IVR menus from CEL, named, with the key pressed, before the queue', async () => {
    const leg = { ...QUEUE_CALL[1], calldate: D(2026, 10, 17, 10, 0, 0), billsec: 30, dcontext: 'ext-queues' };
    const ivrSteps = [
      { context: 'ivr-2', eventtime: D(2026, 10, 17, 10, 0, 1), selection: '1' },
      { context: 'ivr-5', eventtime: D(2026, 10, 17, 10, 0, 9), selection: null },
    ];
    const j = await buildCallJourneyFromCdr([leg], null, { cel: {}, ivrSteps, ivrNames: { '2': 'Main menu' } });
    expect(j).toEqual([
      { event: 'INBOUND', time: '2026-10-17T10:00:00', from_number: '01001234567', duration: 1 },
      { event: 'IVR', time: '2026-10-17T10:00:01', ivr: 'Main menu', selection: '1', duration: 8 },
      { event: 'IVR', time: '2026-10-17T10:00:09', ivr: 'ivr-5' },
      { event: 'QUEUE_ENTER', time: '2026-10-17T10:00:09', queue: '400' },
      { event: 'RING', time: '2026-10-17T10:00:09', agent: '102', duration: 6 },
      { event: 'ANSWER', time: '2026-10-17T10:00:15', agent: '102', duration: 30 },
      { event: 'HANGUP', time: '2026-10-17T10:00:45', reason: 'ANSWERED' },
    ]);
  });

  it('IVR steps fall back to CDR legs whose dcontext is ivr-* (no CEL)', async () => {
    const legs = [
      { ...LIVE_STAR43, src: '01001234567', dst: 's', dcontext: 'ivr-3', lastapp: 'BackGround', dstchannel: '', channel: 'PJSIP/trunk1-1', billsec: 5, duration: 5 },
    ];
    const j = await buildCallJourneyFromCdr(legs, null, { cel: {}, ivrSteps: [], ivrNames: {} });
    expect(j.map((e) => e.event)).toEqual(['INBOUND', 'IVR', 'HANGUP']);
    expect(j[1]).toMatchObject({ ivr: 'ivr-3' });
  });

  it('looks up CEL, IVR steps and names when not given', async () => {
    mocked(dbm.celHangupsByLinkedid).mockResolvedValue({ '1792247515.0': BUSY_CEL });
    const j = await buildCallJourneyFromCdr([LIVE_BUSY]);
    expect(dbm.celHangupsByLinkedid).toHaveBeenCalledWith(['1792247515.0']);
    expect(dbm.celIvrStepsByLinkedid).toHaveBeenCalledWith('1792247515.0');
    expect(j[j.length - 1]).toMatchObject({ ended_by: 'agent', ended_by_agent: '100' });
  });

  it('no rows: empty journey', async () => {
    expect(await buildCallJourneyFromCdr([])).toEqual([]);
  });
});

describe('crmIdentityFromCdr', () => {
  it('collapses legs by sequence and maps the coarse outcome', async () => {
    mocked(dbm.getCdrByLinkedid).mockResolvedValue([LIVE_BUSY]);
    mocked(dbm.getAgentNameByExtension).mockResolvedValue('Ibrahim');
    expect(await crmIdentityFromCdr('1792247515.0')).toEqual({
      caller: '199', destination: '100', call_type: 'internal', call_status: 'BUSY', disposition: 'BUSY',
      duration: '00:00:04', talk_time: '00:00:00', datetime: '2026-10-17T17:31:55', agent: '100',
      answered_extension: '100', agent_name: 'Ibrahim', call_id: '1792247515.0',
    });
  });

  it('{} without CDR', async () => {
    mocked(dbm.getCdrByLinkedid).mockResolvedValue([]);
    expect(await crmIdentityFromCdr('x')).toEqual({});
  });
});
