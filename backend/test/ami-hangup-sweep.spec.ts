/**
 * The call's final hangup pushes it, whichever leg leaves last.
 *
 * When the agent hung up first, the trunk's hangup was the final one, but the agent's entry
 * had already been dropped by the leg's own (non-final) hangup: no `call_outcome` frame
 * reached the agent's client and no CRM push went out (or only the queue-keyed entry was
 * left, and that one is skipped as "the queue extension"). Each scenario below replays the
 * AMI stream of one such call and expects exactly one ANSWERED outcome per extension that
 * talked and exactly one CRM push.
 *
 * Also here: a ring-all leg the ACD cancelled stops reading as Ringing while the winner
 * talks on, and a resync keeps a caller waiting in a queue on a trunk channel.
 */

jest.mock('../src/db/db-manager', () => ({
  insertCallNotification: jest.fn(async () => 1),
  getAgentNameByExtension: jest.fn(async () => null),
  insertWebhookDelivery: jest.fn(async () => 1),
  recordSupervision: jest.fn(async () => true),
}));
jest.mock('../src/services/call-log', () => ({
  ...jest.requireActual('../src/services/call-log'),
  crmIdentityFromCdr: jest.fn(async () => ({})),
}));
jest.mock('../src/services/vad-runner', () => ({ schedule: jest.fn() }));

import { CRMSyncConfig } from '../src/integrations/crm';
import { AMIExtensionsMonitor, type AmiMessage } from '../src/services/ami';

const drain = async () => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
};

function setup() {
  const pushes: Record<string, unknown>[] = [];
  const outcomes: Array<[string, string, string]> = [];
  const m = new AMIExtensionsMonitor({
    host: '127.0.0.1',
    port: 1,
    crmConnector: {
      serverUrl: 'http://crm.test',
      endpointPath: '/api/calls',
      sendCallData: async (data: Record<string, unknown>) => {
        pushes.push({ ...data });
        return { success: true, status_code: 200, data: null };
      },
    } as never,
    crmSyncConfig: new CRMSyncConfig({ enabled: true, fields: [] }),
  });
  m.monitored = new Set(['1001', '1002', '1003', '800']);
  m.setCallOutcomeCallback((ext, status, linkedid) => {
    outcomes.push([ext, status, linkedid]);
  });
  const ev = async (fields: AmiMessage) => {
    await m.dispatchAsync(fields);
    await drain();
  };
  return { m, pushes, outcomes, ev };
}

test('outbound call, the agent hangs up first: the trunk leg pushes it', async () => {
  const { m, pushes, outcomes, ev } = setup();
  await ev({ Event: 'Newchannel', Channel: 'PJSIP/1003-0000000a', Uniqueid: '2000.1', Linkedid: '2000.1', ChannelState: '4', ChannelStateDesc: 'Ring', CallerIDNum: '1003', Exten: '0791112222', Context: 'from-internal' });
  await ev({ Event: 'Newchannel', Channel: 'PJSIP/trunk-0000000b', Uniqueid: '2000.2', Linkedid: '2000.1', ChannelState: '0', ChannelStateDesc: 'Down', CallerIDNum: '0791112222', Exten: 's', Context: 'from-trunk' });
  await ev({ Event: 'DialBegin', Channel: 'PJSIP/1003-0000000a', Uniqueid: '2000.1', Linkedid: '2000.1', CallerIDNum: '1003', DestChannel: 'PJSIP/trunk-0000000b', DestUniqueid: '2000.2', DestExten: '0791112222', DialString: 'trunk/0791112222' });
  await ev({ Event: 'Newstate', Channel: 'PJSIP/trunk-0000000b', Uniqueid: '2000.2', Linkedid: '2000.1', ChannelState: '6', ChannelStateDesc: 'Up' });
  await ev({ Event: 'DialEnd', Channel: 'PJSIP/1003-0000000a', Uniqueid: '2000.1', Linkedid: '2000.1', DestChannel: 'PJSIP/trunk-0000000b', DestUniqueid: '2000.2', DestExten: '0791112222', DialStatus: 'ANSWER' });
  await ev({ Event: 'Newstate', Channel: 'PJSIP/1003-0000000a', Uniqueid: '2000.1', Linkedid: '2000.1', ChannelState: '6', ChannelStateDesc: 'Up' });

  // The agent hangs up first: the call is not over yet, nothing is pushed, and the entry
  // stays (flagged ended, so the agent no longer shows as in a call).
  await ev({ Event: 'Hangup', Channel: 'PJSIP/1003-0000000a', Uniqueid: '2000.1', Linkedid: '2000.1', Cause: '16' });
  expect(pushes).toEqual([]);
  expect(outcomes).toEqual([]);
  expect(m.activeCalls.get('1003')).toMatchObject({ ended: true, linkedid: '2000.1' });
  expect(m.statusDesc('0', '1003')).toBe('Idle');

  await ev({ Event: 'Hangup', Channel: 'PJSIP/trunk-0000000b', Uniqueid: '2000.2', Linkedid: '2000.1', Cause: '16' });
  expect(outcomes).toEqual([['1003', 'ANSWERED', '2000.1']]);
  expect(pushes).toHaveLength(1);
  expect(pushes[0]).toMatchObject({ caller: '1003', destination: '0791112222', call_status: 'ANSWERED', call_type: 'outbound' });
  expect(m.activeCalls.size).toBe(0);
});

test('direct inbound call, the agent hangs up first: the trunk leg pushes it', async () => {
  const { m, pushes, outcomes, ev } = setup();
  // The trunk leg is keyed by the DID it came in on; the agent's caller is the outside number.
  await ev({ Event: 'Newchannel', Channel: 'PJSIP/trunk-00000010', Uniqueid: '2100.1', Linkedid: '2100.1', ChannelState: '4', ChannelStateDesc: 'Ring', CallerIDNum: '0791234567', Exten: '0225550100', Context: 'from-trunk' });
  await ev({ Event: 'Newchannel', Channel: 'PJSIP/1001-00000011', Uniqueid: '2100.2', Linkedid: '2100.1', ChannelState: '0', ChannelStateDesc: 'Down', CallerIDNum: '1001', ConnectedLineNum: '0791234567', Exten: 's', Context: 'from-internal' });
  await ev({ Event: 'DialBegin', Channel: 'PJSIP/trunk-00000010', Uniqueid: '2100.1', Linkedid: '2100.1', CallerIDNum: '0791234567', DestChannel: 'PJSIP/1001-00000011', DestUniqueid: '2100.2', DestExten: '1001', DialString: '1001' });
  await ev({ Event: 'Newstate', Channel: 'PJSIP/1001-00000011', Uniqueid: '2100.2', Linkedid: '2100.1', ChannelState: '5', ChannelStateDesc: 'Ringing' });
  await ev({ Event: 'Newstate', Channel: 'PJSIP/1001-00000011', Uniqueid: '2100.2', Linkedid: '2100.1', ChannelState: '6', ChannelStateDesc: 'Up' });
  await ev({ Event: 'DialEnd', Channel: 'PJSIP/trunk-00000010', Uniqueid: '2100.1', Linkedid: '2100.1', DestChannel: 'PJSIP/1001-00000011', DestUniqueid: '2100.2', DestExten: '1001', DialStatus: 'ANSWER' });

  await ev({ Event: 'Hangup', Channel: 'PJSIP/1001-00000011', Uniqueid: '2100.2', Linkedid: '2100.1', Cause: '16' });
  expect(pushes).toEqual([]);
  await ev({ Event: 'Hangup', Channel: 'PJSIP/trunk-00000010', Uniqueid: '2100.1', Linkedid: '2100.1', Cause: '16' });

  expect(outcomes).toEqual([['1001', 'ANSWERED', '2100.1']]);
  expect(pushes).toHaveLength(1);
  expect(pushes[0]).toMatchObject({ caller: '0791234567', destination: '1001', call_status: 'ANSWERED', call_type: 'inbound' });
  expect(m.activeCalls.size).toBe(0);
});

test('queue call answered by another member: the winner is pushed once, the cancelled leg is not', async () => {
  const { m, pushes, outcomes, ev } = setup();
  const L = '2200.1';
  await ev({ Event: 'QueueMemberAdded', Queue: '800', MemberName: '1001', Interface: 'PJSIP/1001', Membership: 'dynamic', Status: '1', Paused: '0' });
  await ev({ Event: 'QueueMemberAdded', Queue: '800', MemberName: '1002', Interface: 'PJSIP/1002', Membership: 'dynamic', Status: '1', Paused: '0' });
  await ev({ Event: 'Newchannel', Channel: 'PJSIP/trunk-00000020', Uniqueid: L, Linkedid: L, ChannelState: '4', ChannelStateDesc: 'Ring', CallerIDNum: '0791234567', Exten: '800', Context: 'from-trunk' });
  await ev({ Event: 'QueueCallerJoin', Channel: 'PJSIP/trunk-00000020', Uniqueid: L, Linkedid: L, CallerIDNum: '0791234567', Queue: '800', Position: '1', Count: '1' });
  // Ring-all: both members are offered the call.
  for (const [ext, n] of [['1001', '21'], ['1002', '22']]) {
    await ev({ Event: 'AgentCalled', Channel: 'PJSIP/trunk-00000020', Uniqueid: L, Linkedid: L, CallerIDNum: '0791234567', DestChannel: `PJSIP/${ext}-000000${n}`, Queue: '800', Interface: `PJSIP/${ext}`, MemberName: ext });
    await ev({ Event: 'Newchannel', Channel: `PJSIP/${ext}-000000${n}`, Uniqueid: `2200.${n}`, Linkedid: L, ChannelState: '0', ChannelStateDesc: 'Down', CallerIDNum: ext, ConnectedLineNum: '0791234567', Exten: 's', Context: 'from-internal' });
    await ev({ Event: 'Newstate', Channel: `PJSIP/${ext}-000000${n}`, Uniqueid: `2200.${n}`, Linkedid: L, ChannelState: '5', ChannelStateDesc: 'Ringing' });
  }
  // 1002 answers; the ACD cancels 1001's leg (cause 26: answered elsewhere).
  await ev({ Event: 'Newstate', Channel: 'PJSIP/1002-00000022', Uniqueid: '2200.22', Linkedid: L, ChannelState: '6', ChannelStateDesc: 'Up' });
  await ev({ Event: 'Hangup', Channel: 'PJSIP/1001-00000021', Uniqueid: '2200.21', Linkedid: L, Cause: '26' });
  // The cancelled leg no longer reads as Ringing while the winner talks.
  expect(m.activeCalls.get('1001')).toMatchObject({ ended: true, state: 'Down' });
  await ev({ Event: 'AgentConnect', Channel: 'PJSIP/trunk-00000020', Uniqueid: L, Linkedid: L, CallerIDNum: '0791234567', DestChannel: 'PJSIP/1002-00000022', Queue: '800', Interface: 'PJSIP/1002', MemberName: '1002', HoldTime: '5' });
  await ev({ Event: 'QueueCallerLeave', Channel: 'PJSIP/trunk-00000020', Uniqueid: L, Linkedid: L, CallerIDNum: '0791234567', Queue: '800', Position: '1', Count: '0' });

  // The agent hangs up first, then the caller's trunk leg.
  await ev({ Event: 'Hangup', Channel: 'PJSIP/1002-00000022', Uniqueid: '2200.22', Linkedid: L, Cause: '16' });
  expect(pushes).toEqual([]);
  await ev({ Event: 'Hangup', Channel: 'PJSIP/trunk-00000020', Uniqueid: L, Linkedid: L, Cause: '16' });

  expect(outcomes).toEqual([['1002', 'ANSWERED', L]]);
  expect(pushes).toHaveLength(1);
  expect(pushes[0]).toMatchObject({ caller: '0791234567', destination: '1002', call_status: 'ANSWERED', call_type: 'inbound', queue: '800' });
  expect(m.activeCalls.size).toBe(0);
});

test('an extension on a new call keeps the finished call parked until its final hangup', async () => {
  const { m, pushes, outcomes, ev } = setup();
  await ev({ Event: 'Newchannel', Channel: 'PJSIP/1003-00000030', Uniqueid: '2300.1', Linkedid: '2300.1', ChannelState: '4', ChannelStateDesc: 'Ring', CallerIDNum: '1003', Exten: '0791112222', Context: 'from-internal' });
  await ev({ Event: 'Newchannel', Channel: 'PJSIP/trunk-00000031', Uniqueid: '2300.2', Linkedid: '2300.1', ChannelState: '0', ChannelStateDesc: 'Down', CallerIDNum: '0791112222', Exten: 's', Context: 'from-trunk' });
  await ev({ Event: 'DialBegin', Channel: 'PJSIP/1003-00000030', Uniqueid: '2300.1', Linkedid: '2300.1', CallerIDNum: '1003', DestChannel: 'PJSIP/trunk-00000031', DestUniqueid: '2300.2', DestExten: '0791112222', DialString: 'trunk/0791112222' });
  await ev({ Event: 'Newstate', Channel: 'PJSIP/1003-00000030', Uniqueid: '2300.1', Linkedid: '2300.1', ChannelState: '6', ChannelStateDesc: 'Up' });
  await ev({ Event: 'Hangup', Channel: 'PJSIP/1003-00000030', Uniqueid: '2300.1', Linkedid: '2300.1', Cause: '16' });

  // 1003 starts another call before the trunk leg of the first one is gone.
  await ev({ Event: 'Newchannel', Channel: 'PJSIP/1003-00000032', Uniqueid: '2301.1', Linkedid: '2301.1', ChannelState: '4', ChannelStateDesc: 'Ring', CallerIDNum: '1003', Exten: '1002', Context: 'from-internal' });
  const fresh = m.activeCalls.get('1003')!;
  expect(fresh).toMatchObject({ channel: 'PJSIP/1003-00000032', linkedid: '2301.1', exten: '1002' });
  expect(fresh.ended).toBeUndefined();
  expect(m.endedCalls.get('2300.1')?.has('1003')).toBe(true);

  await ev({ Event: 'Hangup', Channel: 'PJSIP/trunk-00000031', Uniqueid: '2300.2', Linkedid: '2300.1', Cause: '16' });
  expect(outcomes).toEqual([['1003', 'ANSWERED', '2300.1']]);
  expect(pushes).toHaveLength(1);
  expect(pushes[0]).toMatchObject({ caller: '1003', destination: '0791112222' });
  // The new call is untouched.
  expect(m.activeCalls.get('1003')).toBe(fresh);
  expect(m.endedCalls.has('2300.1')).toBe(false);
});

describe('syncActiveCalls', () => {
  function statusReply(channels: Array<Record<string, string>>): AmiMessage[] {
    return [{ Response: 'Success' }, ...channels.map((c) => ({ Event: 'Status', ...c }))];
  }

  test('keeps a queue caller waiting on a trunk channel, drops one whose channel is gone', async () => {
    const { m, ev } = setup();
    await ev({ Event: 'Newchannel', Channel: 'PJSIP/trunk-00000040', Uniqueid: '2400.1', Linkedid: '2400.1', ChannelState: '4', ChannelStateDesc: 'Ring', CallerIDNum: '0791234567', Exten: '800', Context: 'from-trunk' });
    await ev({ Event: 'QueueCallerJoin', Channel: 'PJSIP/trunk-00000040', Uniqueid: '2400.1', Linkedid: '2400.1', CallerIDNum: '0791234567', Queue: '800', Position: '1', Count: '1' });
    await ev({ Event: 'Newchannel', Channel: 'PJSIP/trunk-00000041', Uniqueid: '2401.1', Linkedid: '2401.1', ChannelState: '4', ChannelStateDesc: 'Ring', CallerIDNum: '0797654321', Exten: '800', Context: 'from-trunk' });
    await ev({ Event: 'QueueCallerJoin', Channel: 'PJSIP/trunk-00000041', Uniqueid: '2401.1', Linkedid: '2401.1', CallerIDNum: '0797654321', Queue: '800', Position: '2', Count: '2' });
    expect(m.queues.get('800')!.calls_waiting).toBe(2);

    // Asterisk lists only the first caller's channel (and an agent's unrelated call).
    m.sendActionWithEvents = jest.fn(async () => statusReply([
      { Channel: 'PJSIP/trunk-00000040', ChannelState: '6', ChannelStateDesc: 'Up', CallerIDNum: '0791234567', Linkedid: '2400.1' },
      { Channel: 'PJSIP/1001-00000042', ChannelState: '6', ChannelStateDesc: 'Up', CallerIDNum: '1001', ConnectedLineNum: '1002', Linkedid: '2402.1' },
    ]));
    await m.syncActiveCalls();

    expect([...m.queueEntries.keys()]).toEqual(['2400.1']);
    expect(m.queues.get('800')!.calls_waiting).toBe(1);
    expect(m.ch2uniqueid.get('PJSIP/trunk-00000040')).toBe('2400.1');
    expect(m.activeCalls.get('1001')).toMatchObject({ channel: 'PJSIP/1001-00000042', linkedid: '2402.1' });
  });

  test('clears the ended flag of an extension Asterisk still lists as live', async () => {
    const { m } = setup();
    m.activeCalls.set('1001', { channel: 'PJSIP/1001-00000050', ended: true, state: 'Down', linkedid: '2500.1' });
    m.sendActionWithEvents = jest.fn(async () => statusReply([
      { Channel: 'PJSIP/1001-00000050', ChannelState: '6', ChannelStateDesc: 'Up', CallerIDNum: '1001', Linkedid: '2500.1' },
    ]));
    await m.syncActiveCalls();
    expect(m.activeCalls.get('1001')!.ended).toBeUndefined();
    expect(m.activeCalls.get('1001')!.state).toBe('Up');
  });
});

describe('NewConnectedLine', () => {
  test('the far end of a tracked call follows a transfer', async () => {
    const { m, ev } = setup();
    await ev({ Event: 'Newchannel', Channel: 'PJSIP/1001-00000060', Uniqueid: '2600.1', Linkedid: '2600.1', ChannelState: '4', ChannelStateDesc: 'Ring', CallerIDNum: '1001', Exten: '0791112222', Context: 'from-internal' });
    await ev({ Event: 'NewConnectedLine', Channel: 'PJSIP/1001-00000060', ConnectedLineNum: '0791112222' });
    expect(m.activeCalls.get('1001')).toMatchObject({ destination: '0791112222', original_destination: '0791112222' });
    await ev({ Event: 'NewConnectedLine', Channel: 'PJSIP/1001-00000060', ConnectedLineNum: '1002' });
    // The display field follows; the call's first destination (the CRM push reads it) stays.
    expect(m.activeCalls.get('1001')).toMatchObject({ destination: '1002', original_destination: '0791112222' });
  });

  test('ignores its own number, empty numbers and untracked channels', async () => {
    const { m, ev } = setup();
    m.activeCalls.set('1001', { channel: 'PJSIP/1001-00000061', destination: '1002' });
    m.ch2ext.set('PJSIP/1001-00000061', '1001');
    await ev({ Event: 'NewConnectedLine', Channel: 'PJSIP/1001-00000061', ConnectedLineNum: '1001' });
    await ev({ Event: 'NewConnectedLine', Channel: 'PJSIP/1001-00000061', ConnectedLineNum: '<unknown>' });
    await ev({ Event: 'NewConnectedLine', Channel: 'PJSIP/1003-00000062', ConnectedLineNum: '1002' });
    expect(m.activeCalls.get('1001')!.destination).toBe('1002');
    expect(m.activeCalls.has('1003')).toBe(false);
  });
});

describe('supervision targets the exact channel', () => {
  test('ChanSpy gets the full channel name, so 101 never spies on 1010', async () => {
    const { m } = setup();
    m.connected = true;
    m.activeCalls.set('101', { channel: 'PJSIP/101-0000002a', linkedid: 'L101' });
    m.syncActiveCalls = jest.fn(async () => m.activeCalls);
    const sent: Array<[string, Record<string, unknown> | null]> = [];
    m.sendAsync = jest.fn(async (action: string, params: Record<string, unknown> | null = null) => {
      sent.push([action, params]);
      return 'Response: Success\r\n';
    });
    expect(await m.listenToCall('200', '101')).toBe(true);
    expect(sent[0][0]).toBe('Originate');
    expect(sent[0][1]).toMatchObject({ Application: 'ChanSpy', Data: 'PJSIP/101-0000002a,qsE' });
  });
});
