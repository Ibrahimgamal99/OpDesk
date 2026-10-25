/**
 * Live PBX state over REST (api/routes/live.controller.ts): the scope filtering, the response
 * shapes and the queue picker's reconcile. The AMI monitor is a plain fake; the handlers are
 * called directly with a fake request.
 */

jest.mock('../src/db/db-manager', () => ({
  getUserWebrtcCredentials: jest.fn(async () => ({ extension: '1001' })),
  getQueueNamesFromDb: jest.fn(async () => ({ '800': 'Sales' })),
  getQueuesList: jest.fn(async () => [{ extension: '800', queue_name: 'Sales' }]),
  syncQueuesFromList: jest.fn(async () => undefined),
}));
jest.mock('../src/core/security', () => ({ principalOf: (req: { principal?: unknown }) => req.principal ?? null }));

import * as dbm from '../src/db/db-manager';
import { HttpError } from '../src/api/http-error';
import { runtime } from '../src/core/runtime';
import { LiveController } from '../src/api/routes/live.controller';

const ctl = new LiveController();
const transferCall = jest.fn(async () => true);
const syncActiveCalls = jest.fn(async () => undefined);

const ADMIN = { id: 1, role: 'admin', extension: '100', live_agent_extensions: null, live_queue_names: null };
let who: Record<string, unknown> = ADMIN;
const req = (body: unknown = {}) => ({ principal: who, body, params: {}, query: {} }) as never;

function fakeMonitor() {
  return {
    connected: true,
    monitored: new Set(['1001', '1002', '1003']),
    extensions: new Map([['1001', { Status: '1' }], ['1002', { Status: '0' }]]),
    activeCalls: new Map<string, Record<string, unknown>>([
      ['1001', { linkedid: 'L1', state: 'Up' }],
      ['1002', { linkedid: 'L2', ended: true }],
    ]),
    queues: new Map([['800', { calls_waiting: 1 }], ['default', { calls_waiting: 0 }], ['900', { calls_waiting: 0 }]]),
    queueMembers: new Map([
      ['800:PJSIP/1001', { queue: '800', interface: 'PJSIP/1001', status: '1' }],
      ['900:Local/1003@from-queue/n', { queue: '900', interface: 'Local/1003@from-queue/n', status: '' }],
      ['default:PJSIP/1009', { queue: 'default', interface: 'PJSIP/1009', status: '1' }],
    ]),
    queueEntries: new Map([['1700.1', { queue: '800', position: 1 }]]),
    syncActiveCalls,
    transferCall,
    memberStatus: (m: Record<string, unknown>) => (m.status ? String(m.status) : '2'),
  };
}

async function status(p: Promise<unknown>): Promise<[number, string]> {
  try {
    await p;
  } catch (e) {
    if (e instanceof HttpError) return [e.status, e.message];
    return [422, String(e)];
  }
  return [200, ''];
}

beforeEach(() => {
  jest.clearAllMocks();
  runtime.monitor = fakeMonitor() as unknown as typeof runtime.monitor;
  runtime.bridge = null;
  who = ADMIN;
});

afterAll(() => {
  runtime.monitor = null;
});

test('no monitor is a 503', async () => {
  runtime.monitor = null;
  for (const call of [() => ctl.getExtensions(req()), () => ctl.getActiveCalls(req()), () => ctl.getQueues(req())]) {
    expect(await status(call())).toEqual([503, 'AMI not connected']);
  }
  expect(await ctl.getStatus()).toMatchObject({ connected: false, extensions_count: 0, active_calls: 0 });
});

test('extensions: status, in_call and call_info', async () => {
  const { extensions } = await ctl.getExtensions(req());
  expect(extensions).toEqual([
    { extension: '1001', status: '1', in_call: true, call_info: { linkedid: 'L1', state: 'Up' } },
    // Its entry only waits for the call's final hangup: the extension is free.
    { extension: '1002', status: '0', in_call: false, call_info: null },
    { extension: '1003', status: '-1', in_call: false, call_info: null },
  ]);
});

test('extensions are filtered to the live agents', async () => {
  who = { id: 2, role: 'supervisor', extension: '200', live_agent_extensions: ['1003'], live_queue_names: [] };
  const { extensions } = await ctl.getExtensions(req());
  expect(extensions.map((e) => e.extension)).toEqual(['1003']);
});

test('calls sync first, leave out ended entries and filter by the live agents', async () => {
  expect(Object.keys((await ctl.getActiveCalls(req())).calls)).toEqual(['1001']);
  expect(syncActiveCalls).toHaveBeenCalled();
  who = { id: 2, role: 'supervisor', extension: '200', live_agent_extensions: ['1001'], live_queue_names: [] };
  expect((await ctl.getActiveCalls(req())).calls).toEqual({ '1001': { linkedid: 'L1', state: 'Up' } });
  who = { id: 2, role: 'supervisor', extension: '200', live_agent_extensions: ['1003'], live_queue_names: [] };
  expect((await ctl.getActiveCalls(req())).calls).toEqual({});
});

test('queues hide the default queue and report effective member status', async () => {
  const data = await ctl.getQueues(req());
  expect(Object.keys(data.queues)).toEqual(['800', '900']);
  expect(Object.keys(data.members)).toEqual(['800:PJSIP/1001', '900:Local/1003@from-queue/n']);
  expect((data.members['900:Local/1003@from-queue/n'] as Record<string, unknown>).status).toBe('2');
  expect(Object.keys(data.entries)).toEqual(['1700.1']);
});

test('queues are filtered to the live queues', async () => {
  who = { id: 2, role: 'supervisor', extension: '200', live_agent_extensions: [], live_queue_names: ['900'] };
  const data = await ctl.getQueues(req());
  expect(Object.keys(data.queues)).toEqual(['900']);
  expect(Object.keys(data.members)).toEqual(['900:Local/1003@from-queue/n']);
  expect(data.entries).toEqual({});
});

test('the queue picker adds the live queues but never prunes the table', async () => {
  who = { id: 7, role: 'agent', extension: '1001', live_agent_extensions: ['1001'], live_queue_names: [] };
  const { queues } = await ctl.listQueues();
  expect(queues).toEqual([{ extension: '800', queue_name: 'Sales' }]);
  const calls = (dbm.syncQueuesFromList as jest.Mock).mock.calls;
  expect(calls).toEqual([[['800', 'default', '900'], { '800': 'Sales' }]]);
});

test('transfer uses the users own extension', async () => {
  who = { id: 7, role: 'agent', extension: '1009', live_agent_extensions: [], live_queue_names: [] };
  expect(await ctl.transferCall(req({ destination: ' 2002 ' }))).toEqual({ ok: true, source: '1001', destination: '2002' });
  expect(transferCall).toHaveBeenCalledWith('1001', '2002');
});

test('transfer errors', async () => {
  expect(await status(ctl.transferCall(req({ destination: '  ' })))).toEqual([400, 'Destination is required']);
  transferCall.mockResolvedValueOnce(false);
  expect((await status(ctl.transferCall(req({ destination: '2002' }))))[0]).toBe(500);
  expect((await status(ctl.transferCall(req({}))))[0]).not.toBe(200);
});

test('status', async () => {
  expect(await ctl.getStatus()).toEqual({ connected: true, extensions_count: 3, active_calls: 2, websocket_clients: 0 });
});
