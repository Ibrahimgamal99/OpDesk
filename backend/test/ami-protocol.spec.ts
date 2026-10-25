/**
 * AMI wire protocol (services/ami-protocol) and the monitor's protocol-level helpers:
 * framing, parsing, header-injection safety, ActionID correlation with interleaved events,
 * list actions, both CLI reply shapes, and the monitor's interface / pause-reason handling
 * across Asterisk versions (11 `QueueMemberPaused`+`Reason`, 13+ `QueueMemberPause` +
 * `PausedReason`, chan_sip `SIP/x`, FreePBX `Local/x@from-queue/n` members).
 *
 * The AmiClient tests run against an in-process fake AMI server on 127.0.0.1 — no
 * connection to the real PBX is ever opened.
 */

jest.mock('../src/db/db-manager', () => ({
  insertCallNotification: jest.fn(async () => 1),
  getAgentNameByExtension: jest.fn(async () => null),
  insertWebhookDelivery: jest.fn(async () => 1),
  recordSupervision: jest.fn(async () => true),
}));
jest.mock('../src/services/vad-runner', () => ({ schedule: jest.fn() }));

import * as net from 'net';
import { AmiClient, AmiFramer, commandOutputLines, parse, parseAll, renderAction } from '../src/services/ami-protocol';
import {
  AMIExtensionsMonitor,
  extFromInterface,
  formatDuration,
  interfaceMatchesExtension,
  meaningful,
  normalizeDialNumber,
  normalizeInterface,
} from '../src/services/ami';

const raw = (h: Record<string, string>) => Object.entries(h).map(([k, v]) => `${k}: ${v}\r\n`).join('') + '\r\n';

describe('parse / framing', () => {
  it('parses Key: value lines, splitting on the first colon', () => {
    const p = parse('Event: Newchannel\r\nChannel: PJSIP/100-0000000a\r\nCallerIDName: Dr: Who\r\n\r\n');
    expect(p).toEqual({ Event: 'Newchannel', Channel: 'PJSIP/100-0000000a', CallerIDName: 'Dr: Who' });
  });

  it('keeps the first of a repeated header, parseAll returns all', () => {
    const text = 'Response: Success\r\nOutput: a\r\nOutput: b\r\n';
    expect(parse(text).Output).toBe('a');
    expect(parseAll(text, 'Output')).toEqual(['a', 'b']);
  });

  it('frames across arbitrary chunking and strips the banner', () => {
    const f = new AmiFramer();
    const stream = 'Asterisk Call Manager/7.0.3\r\nResponse: Success\r\nActionID: x\r\n\r\nEvent: A\r\nK: 1\r\n\r\nEvent: B\r\n';
    const out: string[] = [];
    for (const ch of stream) out.push(...f.feed(ch));
    expect(f.banner).toBe('Asterisk Call Manager/7.0.3');
    expect(out).toEqual(['Response: Success\r\nActionID: x', 'Event: A\r\nK: 1']);
    expect(f.pending()).toBe('Event: B\r\n');
  });

  it('frames a legacy (Asterisk <= 13) Command reply containing blank lines as one message', () => {
    const f = new AmiFramer(false);
    const msgs = f.feed('Response: Follows\r\nPrivilege: Command\r\nActionID: 1\r\n/DND/101 : YES\r\n\r\n/DND/102 : YES\r\n--END COMMAND--\r\n\r\nEvent: X\r\n\r\n');
    expect(msgs).toHaveLength(2);
    expect(commandOutputLines(msgs[0])).toEqual(['/DND/101 : YES', '/DND/102 : YES']);
    expect(parse(msgs[1]).Event).toBe('X');
  });

  it('reads the Asterisk 14+ Output: form of a Command reply', () => {
    const text = 'Response: Success\r\nMessage: Command output follows\r\nOutput: /DND/101                    : YES\r\nOutput: 1 results found.';
    expect(commandOutputLines(text)).toEqual(['/DND/101                    : YES', '1 results found.']);
  });

  it('renders actions with CR/LF stripped from values (no header injection)', () => {
    const text = renderAction('Originate', 'id-1', { Exten: '100\r\nAction: Hangup', Skip: null });
    expect(text).toBe('Action: Originate\r\nActionID: id-1\r\nExten: 100 Action: Hangup\r\n\r\n');
  });
});

describe('helpers', () => {
  it('extFromInterface understands every member form', () => {
    expect(extFromInterface('PJSIP/1001')).toBe('1001');
    expect(extFromInterface('SIP/1001')).toBe('1001');
    expect(extFromInterface('Local/1001@from-queue/n')).toBe('1001');
    expect(extFromInterface('Local/1001@from-internal')).toBe('1001');
    expect(extFromInterface('PJSIP/1001-0000001a')).toBe('1001');
    expect(extFromInterface('1001')).toBe('1001');
    expect(interfaceMatchesExtension('PJSIP/100', '10')).toBe(false);
  });

  it('normalizeInterface prefixes a bare extension with the device driver, never the Local form', () => {
    expect(normalizeInterface('100')).toBe('PJSIP/100');
    expect(normalizeInterface('100', 'SIP')).toBe('SIP/100');
    expect(normalizeInterface('Local/100@from-queue/n')).toBe('Local/100@from-queue/n');
  });

  it('normalizeDialNumber strips formatting and refuses anything else', () => {
    expect(normalizeDialNumber('+1 (555) 123-45.67')).toBe('+15551234567');
    expect(normalizeDialNumber('*43')).toBe('*43');
    expect(normalizeDialNumber('1')).toBeNull();
    expect(normalizeDialNumber('100\r\nAction: Hangup')).toBeNull();
  });

  it('meaningful / formatDuration', () => {
    expect(meaningful('*43')).toBe(true);
    expect(meaningful('+201001234567')).toBe(true);
    expect(meaningful('s')).toBe(false);
    expect(meaningful('12')).toBe(false);
    expect(formatDuration(65)).toBe('01:05');
    expect(formatDuration(3725)).toBe('01:02:05');
  });
});

describe('queue member pause reasons (Area 4)', () => {
  const m = new AMIExtensionsMonitor({ host: '127.0.0.1', port: 1 });
  m.monitored = new Set(['100', '101']);
  const member = () => m.queueMembers.get('800:SIP/100')!;

  it('QueueMemberAdded learns the driver (chan_sip) and stores a paused reason', async () => {
    await m.dispatchAsync(raw({ Event: 'QueueMemberAdded', Queue: '800', Interface: 'SIP/100', MemberName: '100', Status: '1', Paused: '1', PausedReason: 'lunch' }));
    expect(member()).toMatchObject({ paused: true, pause_reason: 'lunch', dynamic: true, status: 'Not in use' });
    expect(m.deviceTech('100')).toBe('SIP');
    expect(m.deviceInterface('100')).toBe('SIP/100');
  });

  it('a device-state change keeps the reason', async () => {
    await m.dispatchAsync(raw({ Event: 'QueueMemberStatus', Queue: '800', Interface: 'SIP/100', MemberName: '100', Status: '2', Paused: '1' }));
    expect(member()).toMatchObject({ paused: true, pause_reason: 'lunch', status: 'In use' });
  });

  it('QueueMemberPause (Asterisk 12+) with PausedReason updates the reason', async () => {
    await m.dispatchAsync(raw({ Event: 'QueueMemberPause', Queue: '800', Interface: 'SIP/100', Paused: '1', PausedReason: 'break' }));
    expect(member().pause_reason).toBe('break');
  });

  it('the legacy Reason header is read when PausedReason is absent', async () => {
    await m.dispatchAsync(raw({ Event: 'QueueMemberPaused', Queue: '800', Interface: 'SIP/100', Paused: '1', Reason: 'meeting' }));
    expect(member().pause_reason).toBe('meeting');
  });

  it('unpause clears the reason', async () => {
    await m.dispatchAsync(raw({ Event: 'QueueMemberPause', Queue: '800', Interface: 'SIP/100', Paused: '0', PausedReason: '' }));
    expect(member().paused).toBe(false);
    expect(member().pause_reason).toBeUndefined();
  });

  it('matches members by extension in any form', async () => {
    await m.dispatchAsync(raw({ Event: 'QueueMemberAdded', Queue: '801', Interface: 'Local/100@from-queue/n', MemberName: '100', Status: '1', Paused: '0' }));
    expect(m.memberInterfacesFor('100').map((x) => x.interface).sort()).toEqual(['Local/100@from-queue/n', 'SIP/100']);
    expect(m.liveQueuesFor('100')).toEqual(['800', '801']);
    expect(m.memberInterfacesFor('10')).toEqual([]);
  });

  it('a Local member takes its status from the extension hint', async () => {
    await m.dispatchAsync(raw({ Event: 'ExtensionStatus', Exten: '100', Status: '4' }));
    expect(m.memberStatus(m.queueMembers.get('801:Local/100@from-queue/n')!)).toBe('Unavailable');
  });

  it('QueueStatus items carry PausedReason across a restart', () => {
    const item = AMIExtensionsMonitor.queueMemberItem({
      Event: 'QueueMember', Queue: '800', Name: '101', Location: 'PJSIP/101', Membership: 'dynamic', Status: '1', Paused: '1', PausedReason: '__WRAPUP',
    });
    m.queues.set('800', { members: {}, calls_waiting: 0 });
    m.addQueueMember(item);
    expect(m.queueMembers.get('800:PJSIP/101')).toMatchObject({ paused: true, pause_reason: '__WRAPUP', dynamic: true });
  });
});

// ---------------------------------------------------------------------------
// AmiClient against a fake AMI server
// ---------------------------------------------------------------------------
type Handler = (action: Record<string, string>, sock: net.Socket) => void;

async function fakeAmi(handler: Handler): Promise<{ port: number; close: () => Promise<void>; sockets: net.Socket[] }> {
  const sockets: net.Socket[] = [];
  const server = net.createServer((sock) => {
    sockets.push(sock);
    sock.write('Asterisk Call Manager/5.0.1\r\n');
    const framer = new AmiFramer(false);
    sock.on('data', (d) => {
      for (const msg of framer.feed(d.toString('utf8'))) handler(parse(msg), sock);
    });
    sock.on('error', () => undefined);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as net.AddressInfo).port;
  return {
    port,
    sockets,
    close: () =>
      new Promise<void>((r) => {
        for (const s of sockets) s.destroy();
        server.close(() => r());
      }),
  };
}

describe('AmiClient', () => {
  it('logs in, correlates replies by ActionID and routes interleaved events to the feed', async () => {
    const srv = await fakeAmi((a, sock) => {
      const id = a.ActionID;
      if (a.Action === 'Login') {
        sock.write(raw({ Response: a.Secret === 'ok' ? 'Success' : 'Error', ActionID: id, Message: 'x' }));
      } else if (a.Action === 'Ping') {
        // An unsolicited event and a stale reply arrive before our answer.
        sock.write(raw({ Event: 'Newchannel', Channel: 'PJSIP/100-1' }));
        sock.write(raw({ Response: 'Success', ActionID: 'someone-else', Ping: 'Pong' }));
        sock.write(raw({ Response: 'Success', ActionID: id, Ping: 'Pong' }));
      } else if (a.Action === 'QueueStatus') {
        sock.write(raw({ Response: 'Success', ActionID: id, EventList: 'start', Message: 'Queue status will follow' }));
        sock.write(raw({ Event: 'QueueParams', Queue: '800', ActionID: id }));
        sock.write(raw({ Event: 'Hangup', Channel: 'PJSIP/100-1' })); // live event mid-list
        sock.write(raw({ Event: 'QueueMember', Queue: '800', Location: 'PJSIP/100', ActionID: id }));
        sock.write(raw({ Event: 'QueueStatusComplete', ActionID: id, EventList: 'Complete', ListItems: '2' }));
      } else if (a.Action === 'Command') {
        sock.write(raw({ Response: 'Success', ActionID: id, Message: 'Command output follows', Output: '/DND/101 : YES' }).replace('\r\n\r\n', '\r\nOutput: /DND/102 : YES\r\n\r\n'));
      }
    });
    const events: string[] = [];
    const client = new AmiClient({ onEvent: (r) => events.push(parse(r).Event) });
    await client.connect('127.0.0.1', srv.port);
    expect(client.banner).toBe('Asterisk Call Manager/5.0.1');
    expect((await client.login('u', 'bad')).ok).toBe(false);
    expect((await client.login('u', 'ok')).ok).toBe(true);

    const pong = await client.send('Ping');
    expect(parse(pong!).Ping).toBe('Pong');
    expect(parse(pong!).ActionID).not.toBe('someone-else');

    const list = await client.sendList('QueueStatus', null, 'QueueStatusComplete');
    expect(list!.map((m) => parse(m).Event || parse(m).Response)).toEqual(['Success', 'QueueParams', 'QueueMember', 'QueueStatusComplete']);

    const cmd = await client.send('Command', { Command: 'database show DND' });
    expect(commandOutputLines(cmd!)).toEqual(['/DND/101 : YES', '/DND/102 : YES']);

    expect(events).toEqual(['Newchannel', 'Hangup']);
    await client.close();
    await srv.close();
  });

  it('answers null on timeout and when the connection drops', async () => {
    let lastSock: net.Socket | null = null;
    const srv = await fakeAmi((a, sock) => {
      lastSock = sock;
      if (a.Action === 'Login') sock.write(raw({ Response: 'Success', ActionID: a.ActionID }));
    });
    let closed = false;
    const client = new AmiClient({ onClose: () => (closed = true) });
    await client.connect('127.0.0.1', srv.port);
    await client.login('u', 'p');
    expect(await client.send('Ping', null, 0.2)).toBeNull();
    const pending = client.send('Ping', null, 5);
    lastSock!.destroy();
    expect(await pending).toBeNull();
    await new Promise((r) => setTimeout(r, 20));
    expect(closed).toBe(true);
    expect(client.connected).toBe(false);
    expect(await client.send('Ping')).toBeNull();
    await srv.close();
  });

  it('the monitor logs in, syncs queues and hydrates DND from the Output: form', async () => {
    const srv = await fakeAmi((a, sock) => {
      const id = a.ActionID;
      if (a.Action === 'Login') sock.write(raw({ Response: 'Success', ActionID: id }));
      else if (a.Action === 'QueueSummary') {
        sock.write(raw({ Response: 'Success', ActionID: id, EventList: 'start' }));
        sock.write(raw({ Event: 'QueueSummary', ActionID: id, Queue: '800', LoggedIn: '1', Available: '1', Callers: '0', HoldTime: '0', TalkTime: '0' }));
        sock.write(raw({ Event: 'QueueSummaryComplete', ActionID: id, EventList: 'Complete' }));
      } else if (a.Action === 'QueueStatus') {
        sock.write(raw({ Response: 'Success', ActionID: id, EventList: 'start' }));
        sock.write(raw({ Event: 'QueueMember', ActionID: id, Queue: '800', Name: '100', Location: 'PJSIP/100', Membership: 'dynamic', Status: '1', Paused: '1', PausedReason: 'lunch' }));
        sock.write(raw({ Event: 'QueueEntry', ActionID: id, Queue: '800', Position: '1', Uniqueid: '9.1', CallerIDNum: '0791', Wait: '12', Channel: 'PJSIP/trunk-1' }));
        sock.write(raw({ Event: 'QueueStatusComplete', ActionID: id, EventList: 'Complete' }));
      } else if (a.Action === 'Command') {
        sock.write(`Response: Success\r\nActionID: ${id}\r\nMessage: Command output follows\r\nOutput: /DND/101                  : YES\r\nOutput: 1 results found.\r\n\r\n`);
      } else {
        sock.write(raw({ Response: 'Success', ActionID: id }));
      }
    });
    const mon = new AMIExtensionsMonitor({ host: '127.0.0.1', port: srv.port, username: 'u', secret: 'p' });
    expect(await mon.connect()).toBe(true);
    expect(mon.queueMembers.get('800:PJSIP/100')).toMatchObject({ paused: true, pause_reason: 'lunch', dynamic: true });
    expect(mon.queueEntries.get('9.1')).toMatchObject({ queue: '800', callerid: '0791', position: 1 });
    expect(mon.queues.get('800')!.calls_waiting).toBe(1);
    await mon.syncDndState();
    expect([...mon.dnd]).toEqual(['101']);
    await mon.disconnect();
    await srv.close();
  });
});
