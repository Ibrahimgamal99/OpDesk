/**
 * liveRoute: which way a call in progress runs, from one extension's side. The Active Calls
 * direction badge and the Dashboard's live inbound/outbound split read it from every call row
 * of the state frame.
 */

jest.mock('../src/db/db-manager', () => ({ getQueuesList: jest.fn(async () => []) }));
jest.mock('../src/services/analytics', () => ({
  getSlaThresholds: jest.fn(async () => ({})),
  getSlaDefaultSecs: jest.fn(async () => 20),
  slaThresholdFor: (q: string, t: Record<string, number>, d: number) => t[q] ?? d,
}));

import { AMIEventBridge } from '../src/core/event-bridge';
import { AMIExtensionsMonitor, type CallInfo } from '../src/services/ami';

function monitor(): AMIExtensionsMonitor {
  return new AMIExtensionsMonitor({ host: '127.0.0.1', port: 9, username: 't', secret: 't' });
}

test('an outside caller through a queue is inbound_queue', () => {
  const info: CallInfo = { caller: '01012345678', queue: '900', linkedid: 'a' };
  expect(monitor().liveRoute(info, '1001')).toBe('inbound_queue');
  expect(monitor().liveRoute({ queue_caller: '01012345678' }, '1001')).toBe('inbound_queue');
});

test('an outside caller straight to the extension is inbound_direct', () => {
  const info: CallInfo = { caller: '01012345678', context: 'from-internal', linkedid: 'a' };
  expect(monitor().liveRoute(info, '1001')).toBe('inbound_direct');
});

test('an extension calling is internal, whichever side we are on', () => {
  const m = monitor();
  expect(m.liveRoute({ caller: '1002' }, '1001')).toBe('internal');
  expect(m.liveRoute({ original_destination: '1002', exten: '1002' }, '1001')).toBe('internal');
});

test('an agent dialling an outside number is outbound', () => {
  expect(monitor().liveRoute({ exten: '01012345678' }, '1001')).toBe('outbound');
});

test('a feature code is internal', () => {
  expect(monitor().liveRoute({ exten: '*43' }, '1001')).toBe('internal');
});

test('no marker at all is unknown, not a guess', () => {
  expect(monitor().liveRoute({ exten: '1001' }, '1001')).toBeNull();
  expect(monitor().liveRoute({}, '1001')).toBeNull();
});

test('every call row of the state frame carries its route; an ended entry is not a row', () => {
  const m = monitor();
  m.monitored = new Set(['1001', '1002', '1003']);
  m.activeCalls.set('1001', { channel: 'PJSIP/1001-01', state: 'Up', caller: '01012345678', queue: '800' });
  m.activeCalls.set('1003', { channel: 'PJSIP/1003-02', state: 'Up', exten: '01099999999' });
  m.activeCalls.set('1002', { channel: 'PJSIP/1002-03', state: 'Down', ended: true, caller: '01012345678' });
  const state = new AMIEventBridge(m).buildState(null, null) as {
    active_calls: Record<string, { route: string | null }>;
    extensions: Record<string, { call_info: unknown }>;
  };
  expect(Object.fromEntries(Object.entries(state.active_calls).map(([k, v]) => [k, v.route]))).toEqual({
    1001: 'inbound_queue',
    1003: 'outbound',
  });
  // The extension whose leg ended is left to its device hint.
  expect(state.extensions['1002'].call_info).toBeNull();
});
