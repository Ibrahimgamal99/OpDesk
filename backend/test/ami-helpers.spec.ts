/**
 * Pure helpers of services/ami, checked against the Python originals.
 *
 * fixtures/ami-helpers.json holds [input, expected] pairs produced by running the Python
 * helpers (_meaningful, ext_from_interface, _ext_from_channel, _format_duration, _parse,
 * _queue_member_status, and the monitor's _get_channel_type / _display_number /
 * _status_desc / _missed_call_party). Where OpDesk deliberately differs, the case is pinned
 * below instead.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  AMIExtensionsMonitor,
  extFromChannel,
  extFromInterface,
  formatDuration,
  meaningful,
  normalizeInterface,
  parse,
  queueMemberStatus,
  sameNumber,
} from '../src/services/ami';

type Pairs = Array<[unknown, unknown]>;
const F = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'ami-helpers.json'), 'utf8')) as Record<string, unknown[]>;
const pairs = (k: string) => F[k] as Pairs;

const monitor = new AMIExtensionsMonitor({ host: '127.0.0.1', port: 9, username: 't', secret: 't' });

test.each(pairs('meaningful'))('meaningful(%j) -> %j', (input, expected) => {
  expect(meaningful(input)).toBe(expected);
});

// A channel name (PJSIP/1001-0000ab) reads as its extension here: the Python kept the suffix.
const EXT_FROM_INTERFACE_DIFFERS: Record<string, string> = { 'PJSIP/1001-0000ab': '1001' };
test.each(pairs('ext_from_interface'))('extFromInterface(%j) -> %j', (input, expected) => {
  expect(extFromInterface(input as string)).toBe(EXT_FROM_INTERFACE_DIFFERS[input as string] ?? expected);
});

test.each(pairs('ext_from_channel'))('extFromChannel(%j) -> %j', (input, expected) => {
  expect(extFromChannel(input as string)).toBe(expected);
});

test.each(pairs('format_duration'))('formatDuration(%j s) -> %j', (input, expected) => {
  expect(formatDuration(input as number)).toBe(expected);
});

test.each(pairs('parse'))('parse(%j)', (input, expected) => {
  expect({ ...parse(input as string) }).toEqual(expected);
});

test.each(pairs('queue_member_status'))('queueMemberStatus(%j) -> %j', (input, expected) => {
  expect(queueMemberStatus(input)).toBe(expected);
});

test.each(pairs('channel_type'))('getChannelType(%j) -> %j', (input, expected) => {
  expect(monitor.getChannelType(input as string)).toBe(expected);
});

test.each(F['display_number'] as Array<[Record<string, string>, string, string]>)(
  'displayNumber(%j, %j) -> %j',
  (info, ext, expected) => {
    expect(monitor.displayNumber(info, ext)).toBe(expected);
  },
);

test.each(pairs('status_desc'))('statusDesc(%j) -> %j', (code, expected) => {
  expect(monitor.statusDesc(code)).toBe(expected);
});

test.each(F['missed_call_party'] as Array<[string, Record<string, string> | null, string, [boolean, string | null]]>)(
  'missedCallParty(%j, %j, %j) -> %j',
  (notifyExt, info, known, expected) => {
    expect(monitor.missedCallParty(notifyExt, info, known)).toEqual(expected);
  },
);

test('missedCallParty: an extension dialling its own number is not a missed call', () => {
  const selfDial = { callerid: '1003', exten: '1003' };
  // 1003's own channel started the call and dialled 1003, then gave up.
  expect(monitor.missedCallParty('1003', selfDial, '', true)).toEqual([false, null]);
  // A rung callee leg with no caller marker (withheld CallerID) still notifies.
  expect(monitor.missedCallParty('1003', selfDial, '', false)).toEqual([true, null]);
  // Starting the call does not hide a known inbound caller.
  expect(monitor.missedCallParty('1003', { caller: '100', exten: '1003' }, '', true)).toEqual([true, '100']);
});

test('where OpDesk deliberately differs from the Python', () => {
  // Only ASCII digits are a phone number (Python's isdigit() also took Arabic-Indic ones).
  expect(meaningful('٣٤٥')).toBe(false);
  // A negative duration (clock skew) reads as zero, not as a wrapped 59:59.
  expect(formatDuration(-1)).toBe('00:00');
  // A repeated header keeps its FIRST value (parseAll reads them all); a line without a key
  // is skipped.
  expect({ ...parse('Output: line one\r\nOutput: /DND/1001 : YES\r\n') }).toEqual({ Output: 'line one' });
  expect({ ...parse('Key:Value\r\n : nokey\r\n:empty\r\nA: b: c\r\n') }).toEqual({ Key: 'Value', A: 'b: c' });
});

test('normalizeInterface: a bare extension gets the device driver, anything else passes through', () => {
  expect(normalizeInterface('100')).toBe('PJSIP/100');
  expect(normalizeInterface(' 100 ', 'SIP')).toBe('SIP/100');
  expect(normalizeInterface('Local/100@from-queue/n')).toBe('Local/100@from-queue/n');
  expect(normalizeInterface('SIP/100')).toBe('SIP/100');
  expect(normalizeInterface('')).toBe('');
});

test('statusDesc: an ended call entry no longer describes the extension', () => {
  const m = new AMIExtensionsMonitor({ host: '127.0.0.1', port: 9 });
  m.activeCalls.set('1001', { channel: 'PJSIP/1001-01', state: 'Up', caller: '1002' });
  expect(m.statusDesc('1', '1001')).toBe('In call with 1002');
  m.activeCalls.get('1001')!.ended = true;
  expect(m.statusDesc('0', '1001')).toBe('Idle');
});

test('sameNumber allows for a national leading zero on one side', () => {
  expect(sameNumber('0791234567', '791234567')).toBe(true);
  expect(sameNumber('0791234567', '0791234567')).toBe(true);
  expect(sameNumber('0791234567', '0791234568')).toBe(false);
  expect(sameNumber('', '0')).toBe(false);
});

test('eventPauseReason: PausedReason first, then the legacy Reason; undefined when neither', () => {
  expect(AMIExtensionsMonitor.eventPauseReason({ PausedReason: ' lunch ', Reason: 'x' })).toBe('lunch');
  expect(AMIExtensionsMonitor.eventPauseReason({ Reason: 'break' })).toBe('break');
  expect(AMIExtensionsMonitor.eventPauseReason({ PausedReason: '' })).toBe('');
  expect(AMIExtensionsMonitor.eventPauseReason({})).toBeUndefined();
});
