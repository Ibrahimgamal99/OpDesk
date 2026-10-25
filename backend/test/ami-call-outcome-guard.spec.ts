/**
 * call_outcome must not reach an agent who is still talking on a different call.
 *
 * A ring-out of a second call (the agent was offered another caller while already answered
 * on the first) must not end the first call's after-call screen on the agent's client.
 */

jest.mock('../src/db/db-manager', () => ({
  insertCallNotification: jest.fn(async () => 1),
  getAgentNameByExtension: jest.fn(async () => null),
}));
jest.mock('../src/services/vad-runner', () => ({ schedule: jest.fn() }));

import { AMIExtensionsMonitor } from '../src/services/ami';

const LIVE_LEG = 'PJSIP/1011-000004d8';
const LIVE_CALL = '1791295329.6160';
const RING_LEG = 'PJSIP/1011-000004de';
const OTHER_CALL = '1791295333.6170';

function monitor(): [AMIExtensionsMonitor, Array<[string, string, string]>] {
  const m = new AMIExtensionsMonitor({ host: '127.0.0.1', port: 9, username: 't', secret: 't' });
  const sent: Array<[string, string, string]> = [];
  m.setCallOutcomeCallback((ext, status, linkedid) => {
    sent.push([ext, status, linkedid]);
  });
  return [m, sent];
}

function newLeg(m: AMIExtensionsMonitor, ch: string, linkedid: string, state: string): void {
  m.evNewchannel(
    { Channel: ch, Uniqueid: `${linkedid}.${ch}`, Linkedid: linkedid, CallerIDNum: '1011', Exten: '1011', Context: 'from-internal' },
    '00:00:00',
  );
  m.evNewstate({ Channel: ch, ChannelStateDesc: state }, '00:00:00');
}

function answer(m: AMIExtensionsMonitor, ch: string, linkedid: string): void {
  newLeg(m, ch, linkedid, 'Up');
}

test('outcome for another call is withheld while the agent talks', () => {
  const [m, sent] = monitor();
  answer(m, LIVE_LEG, LIVE_CALL);
  m.pushCallOutcome('1011', 'MISSED', OTHER_CALL);
  expect(sent).toEqual([]);
});

test('outcome for the call itself still goes out', () => {
  const [m, sent] = monitor();
  answer(m, LIVE_LEG, LIVE_CALL);
  m.pushCallOutcome('1011', 'ANSWERED', LIVE_CALL);
  expect(sent).toEqual([['1011', 'ANSWERED', LIVE_CALL]]);
});

test('other extensions are not affected', () => {
  const [m, sent] = monitor();
  answer(m, LIVE_LEG, LIVE_CALL);
  m.pushCallOutcome('1008', 'MISSED', OTHER_CALL);
  expect(sent).toEqual([['1008', 'MISSED', OTHER_CALL]]);
});

test('a ringing leg does not withhold', () => {
  const [m, sent] = monitor();
  newLeg(m, RING_LEG, LIVE_CALL, 'Ringing');
  m.pushCallOutcome('1011', 'MISSED', OTHER_CALL);
  expect(sent).toEqual([['1011', 'MISSED', OTHER_CALL]]);
});

test('the guard releases once the live leg hangs up', async () => {
  const [m, sent] = monitor();
  // The hangup's own CRM push is not under test.
  m.sendCrmData = async () => undefined;

  answer(m, LIVE_LEG, LIVE_CALL);
  m.evHangup({ Channel: LIVE_LEG, Uniqueid: '1791295329.6167', Cause: '16', Linkedid: LIVE_CALL }, '00:00:00');
  await new Promise((r) => setImmediate(r));

  m.pushCallOutcome('1011', 'MISSED', OTHER_CALL);
  expect(sent).toEqual([['1011', 'MISSED', OTHER_CALL]]);
});

test('no callback, no extension: nothing is sent and nothing throws', () => {
  const m = new AMIExtensionsMonitor({ host: '127.0.0.1', port: 9 });
  expect(() => m.pushCallOutcome('1011', 'ANSWERED', LIVE_CALL)).not.toThrow();
  const [m2, sent] = monitor();
  m2.pushCallOutcome('', 'ANSWERED', LIVE_CALL);
  expect(sent).toEqual([]);
});
