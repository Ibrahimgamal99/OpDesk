/**
 * services/sip-push: RFC 8599 Contact parsing, the gateway's own AMI client (against a fake
 * AMI server on 127.0.0.1 — never the box's Asterisk), binding learning, the pre-dial
 * wake / ready / done / cancel cycle, the ring-time fallback and its pre-woken dedup, and the
 * missed-call banner.
 *
 * No database and no pushes: the db layer and push-service are mocked.
 */

import * as net from 'net';

const bindingRows: Array<Record<string, unknown>> = [];
const tokens: Record<string, Array<Record<string, string>>> = {};
const runtimeMock = {
  preWoken: new Map<string, number>(),
  contactResolver: { resolveCached: jest.fn() } as unknown,
  monitor: { monitored: new Set(['100', '101']) } as unknown,
};

jest.mock(
  '../src/db/db-manager',
  () => ({
    getSetting: jest.fn(async (_k: string, fallback: string | null = null) => fallback),
    listSipPushBindings: jest.fn(async () => bindingRows.map((r) => ({ ...r }))),
    upsertSipPushBinding: jest.fn(async () => true),
    getDeviceTokensForExtension: jest.fn(async (ext: string) => tokens[ext] ?? []),
    getCallNotificationsFromDb: jest.fn(async () => [{ caller_from: '0100', queue: 'sales', reason: 'UNANSWERED', call_id: 'L9' }]),
    addCrmContactIfNew: jest.fn(),
    getContactsForResolver: jest.fn(async () => []),
  }));
jest.mock('../src/core/runtime', () => ({ runtime: runtimeMock }));
jest.mock('../src/integrations/push-service', () => ({
  canWake: jest.fn((b: unknown[], legacy: unknown[]) => b.length > 0 || legacy.length > 0),
  sendRfc8599: jest.fn(async () => 1),
  sendCallWake: jest.fn(async () => undefined),
  sendAlert: jest.fn(async () => undefined),
}));

import * as dbm from '../src/db/db-manager';
import * as pushService from '../src/integrations/push-service';
import * as sipPush from '../src/services/sip-push';

const mocked = (fn: unknown) => fn as jest.Mock;
const flush = () => new Promise((r) => setImmediate(r));

// ---------------------------------------------------------------------------
// A fake AMI server
// ---------------------------------------------------------------------------

interface FakeAmi {
  port: number;
  actions: Array<Record<string, string>>;
  /** extension -> ContactStatusDetail rows */
  contacts: Record<string, Array<Record<string, string>>>;
  registered: Array<Record<string, string>>;
  sockets: net.Socket[];
  server: net.Server;
  push(ev: Record<string, string>): void;
}

function block(fields: Record<string, string>): string {
  return Object.entries(fields)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\r\n') + '\r\n\r\n';
}

async function startFakeAmi(): Promise<FakeAmi> {
  const fake: FakeAmi = {
    port: 0,
    actions: [],
    contacts: {},
    registered: [],
    sockets: [],
    server: net.createServer(),
    push(ev) {
      for (const s of fake.sockets) s.write(block(ev));
    },
  };
  fake.server.on('connection', (sock) => {
    fake.sockets.push(sock);
    sock.write('Asterisk Call Manager/5.0.1\r\n');
    let buf = '';
    sock.on('data', (d) => {
      buf += d.toString();
      let end: number;
      while ((end = buf.indexOf('\r\n\r\n')) !== -1) {
        const msg: Record<string, string> = {};
        for (const line of buf.slice(0, end).split('\r\n')) {
          const i = line.indexOf(':');
          if (i > 0) msg[line.slice(0, i).trim()] = line.slice(i + 1).trim();
        }
        buf = buf.slice(end + 4);
        fake.actions.push(msg);
        const id = msg.ActionID;
        if (msg.Action === 'Login') {
          sock.write(block({ Response: msg.Secret === 'pw' ? 'Success' : 'Error', ActionID: id, Message: 'Authentication accepted' }));
        } else if (msg.Action === 'PJSIPShowContacts') {
          sock.write(block({ Response: 'Success', ActionID: id, EventList: 'start', Message: 'A listing of Contacts follows' }));
          for (const c of fake.registered) sock.write(block({ Event: 'ContactList', ActionID: id, ...c }));
          sock.write(block({ Event: 'ContactListComplete', ActionID: id, EventList: 'Complete' }));
        } else if (msg.Action === 'PJSIPShowEndpoint') {
          sock.write(block({ Response: 'Success', ActionID: id, EventList: 'start' }));
          sock.write(block({ Event: 'EndpointDetail', ActionID: id, ObjectName: msg.Endpoint }));
          for (const c of fake.contacts[msg.Endpoint] ?? []) sock.write(block({ Event: 'ContactStatusDetail', ActionID: id, ...c }));
          sock.write(block({ Event: 'EndpointDetailComplete', ActionID: id, EventList: 'Complete' }));
        }
      }
    });
  });
  await new Promise<void>((resolve) => fake.server.listen(0, '127.0.0.1', resolve));
  fake.port = (fake.server.address() as net.AddressInfo).port;
  return fake;
}

async function waitFor(pred: () => boolean, ms = 2000): Promise<void> {
  const until = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > until) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
}

const PN_URI = 'sip:100@10.0.0.9:5060;transport=tcp;pn-provider=fcm;pn-prid=tok%3A1;pn-param=proj';

// ---------------------------------------------------------------------------

describe('parsing', () => {
  test('parsePnParams', () => {
    expect(sipPush.parsePnParams(`<${PN_URI}>;expires=600`)).toEqual({ provider: 'fcm', prid: 'tok:1', param: 'proj' });
    expect(sipPush.parsePnParams('sip:100@h;PN-Provider=APNS;pn-prid=abc')).toEqual({ provider: 'apns', prid: 'abc', param: '' });
    expect(sipPush.parsePnParams('sip:100@h;pn-provider=fcm')).toBeNull();
    expect(sipPush.parsePnParams('sip:100@h?pn-provider=fcm;pn-prid=x')).toBeNull();
    expect(sipPush.parsePnParams('')).toBeNull();
  });

  test('parseAmiMessage collects Output lines and keeps the first of any other key', () => {
    expect(sipPush.parseAmiMessage('Response: Follows\r\nOutput: a\r\nOutput: b\r\nX: 1\r\nX: 2\r\nnoise')).toEqual({
      Response: 'Follows',
      Output: ['a', 'b'],
      X: '1',
    });
  });

  test('isMobile: pn-* params or the client marker in the User-Agent', () => {
    sipPush.configure({ marker: 'Medut' });
    expect(sipPush.isMobile(PN_URI, '')).toBe(true);
    expect(sipPush.isMobile('sip:100@h', 'medut/2.0 (ios)')).toBe(true);
    expect(sipPush.isMobile('sip:100@h', 'Zoiper')).toBe(false);
    sipPush.configure({ marker: '' });
    expect(sipPush.isMobile('sip:100@h', 'Medut')).toBe(false);
    sipPush.configure({ marker: 'Medut' });
  });

  test('callData', () => {
    expect(sipPush.callData('100', '0100', '', 'pbx.example.com')).toEqual({
      type: 'call',
      caller_uri: 'sip:0100@pbx.example.com',
      caller_name: '0100',
      aor: 'sip:100@pbx.example.com',
    });
    expect(sipPush.callData('100', '0100', 'Alice', '')).toEqual({ type: 'call', caller_uri: '0100', caller_name: 'Alice', aor: '100' });
  });
});

describe('gateway over a fake AMI', () => {
  let fake: FakeAmi;

  beforeAll(async () => {
    fake = await startFakeAmi();
    process.env.AMI_HOST = '127.0.0.1';
    process.env.AMI_PORT = String(fake.port);
    process.env.AMI_USERNAME = 'opdesk';
    process.env.AMI_SECRET = 'pw';
    process.env.OPDESK_DOMAIN = 'pbx.example.com';
    fake.registered.push({ Aor: '100', Uri: PN_URI, UserAgent: 'Medut/1.0 (android)' });
    bindingRows.push({ id: 1, extension: '100', pn_provider: 'fcm', pn_prid: 'tok:1', pn_param: 'proj' });
    await sipPush.start(true, 'Medut');
    await waitFor(() => fake.actions.some((a) => a.Action === 'PJSIPShowContacts'));
    await waitFor(() => mocked(dbm.upsertSipPushBinding).mock.calls.length > 0);
  });

  afterAll(async () => {
    await sipPush.stop();
    for (const s of fake.sockets) s.destroy();
    await new Promise((r) => fake.server.close(r));
    for (const k of ['AMI_HOST', 'AMI_PORT', 'AMI_USERNAME', 'AMI_SECRET', 'OPDESK_DOMAIN']) delete process.env[k];
  });

  test('login uses the system event mask; the startup sync learns registered bindings', () => {
    expect(fake.actions[0]).toMatchObject({ Action: 'Login', Username: 'opdesk', Secret: 'pw', Events: 'system' });
    expect(dbm.upsertSipPushBinding).toHaveBeenCalledWith('100', 'fcm', 'tok:1', 'proj', PN_URI, 'Medut/1.0 (android)');
    expect(sipPush.hasBindings('100')).toBe(true);
    expect(sipPush.bindingsFor('999')).toEqual([]);
  });

  test('wake pushes and holds; ready flips when the contact refreshes; cancel pushes once', async () => {
    fake.contacts['100'] = [{ ID: 'c1', URI: PN_URI, UserAgent: 'Medut/1.0', RegExpire: '1000' }];
    tokens['100'] = [];
    expect(await sipPush.wake('100', 'uid-1', '0100', 'Alice', 12)).toBe(true);
    await flush();
    expect(pushService.sendRfc8599).toHaveBeenCalledWith(
      [expect.objectContaining({ pn_prid: 'tok:1' })],
      { type: 'call', caller_uri: 'sip:0100@pbx.example.com', caller_name: 'Alice', aor: 'sip:100@pbx.example.com' },
      12,
      'uid-1',
    );
    expect(pushService.sendCallWake).not.toHaveBeenCalled();

    expect(await sipPush.ready('uid-1')).toBe(false);
    fake.contacts['100'] = [{ ID: 'c1', URI: PN_URI, UserAgent: 'Medut/1.0', RegExpire: '1500' }];
    expect(await sipPush.ready('uid-1')).toBe(true);
    expect(await sipPush.ready('unknown-uid')).toBe(true);

    mocked(pushService.sendRfc8599).mockClear();
    await sipPush.cancel('uid-1');
    expect(pushService.sendRfc8599).toHaveBeenCalledWith([expect.objectContaining({ pn_prid: 'tok:1' })], {
      type: 'cancel',
      aor: 'sip:100@pbx.example.com',
    });
    mocked(pushService.sendRfc8599).mockClear();
    await sipPush.cancel('uid-1');
    expect(pushService.sendRfc8599).not.toHaveBeenCalled();
  });

  test('a ContactStatus Created event for a mobile contact makes a pending wake ready', async () => {
    fake.contacts['100'] = [];
    expect(await sipPush.wake('100', 'uid-2', '0100', '', 10)).toBe(true);
    expect(await sipPush.ready('uid-2')).toBe(false);
    await new Promise((r) => setTimeout(r, 5));
    fake.push({ Event: 'ContactStatus', ContactStatus: 'Created', AOR: '100', URI: PN_URI, EndpointName: '100' });
    await waitFor(() => sipPush.registeredAt.has('100'));
    expect(await sipPush.ready('uid-2')).toBe(true);
    sipPush.done('uid-2');
    expect(sipPush.pending.has('uid-2')).toBe(false);
  });

  test('legacy-only extensions: any (re-)registration counts, and the app token is woken', async () => {
    tokens['200'] = [{ token: 'a1', platform: 'android', token_type: 'alert' }];
    fake.contacts['200'] = [];
    expect(await sipPush.wake('200', 'uid-3', '0100', 'Alice', 10)).toBe(true);
    await flush();
    expect(pushService.sendCallWake).toHaveBeenCalledWith('200', '0100', 'predial-200', 'Alice');
    fake.contacts['200'] = [{ ID: 'z', URI: 'sip:200@10.0.0.1', UserAgent: 'Zoiper', RegExpire: '60' }];
    expect(await sipPush.ready('uid-3')).toBe(true);
  });

  test('no binding and no token: no hold', async () => {
    expect(await sipPush.wake('300', 'uid-4', '0100', '', 10)).toBe(false);
  });
});

describe('call-time hooks', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    runtimeMock.preWoken.clear();
  });

  test('onIncomingCall warms the resolver and pushes, unless the pre-dial hook just did', async () => {
    sipPush.onIncomingCall('100', '0100123456', 'L1', 'Alice');
    await flush();
    expect((runtimeMock.contactResolver as { resolveCached: jest.Mock }).resolveCached).toHaveBeenCalledWith(
      '0100123456',
      new Set(['100', '101']),
    );
    expect(pushService.sendCallWake).toHaveBeenCalledWith('100', '0100123456', 'L1', 'Alice');

    mocked(pushService.sendCallWake).mockClear();
    sipPush.markPreWoken('100');
    sipPush.onIncomingCall('100', '0100123456', 'L2', '');
    await flush();
    expect(pushService.sendCallWake).not.toHaveBeenCalled();
    expect(runtimeMock.preWoken.has('100')).toBe(false);
    // the mark is single-use
    sipPush.onIncomingCall('100', '0100123456', 'L3', '');
    await flush();
    expect(pushService.sendCallWake).toHaveBeenCalledTimes(1);
  });

  test('dispatchMissedCallPush builds the banner from the latest notification', async () => {
    await sipPush.dispatchMissedCallPush('100');
    expect(dbm.getCallNotificationsFromDb).toHaveBeenCalledWith({ extension: '100', statusFlag: null, limit: 1 });
    expect(pushService.sendAlert).toHaveBeenCalledWith('100', 'Missed call', 'Missed call from 0100 (queue sales)', {
      type: 'call_notification_new',
      extension: '100',
      caller_from: '0100',
      queue: 'sales',
      reason: 'UNANSWERED',
      call_id: 'L9',
    });
  });
});
