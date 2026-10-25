/**
 * integrations/push-service and the push / Mobile Wake routes: keys from Settings with .env
 * as fallback, key validation, the provider routing of call wakes / banners / RFC 8599
 * pushes (FCM, APNs, Web Push), dead-token pruning, and the route contract (bare device-token
 * and VAPID routes, enveloped push config, text/plain loopback hooks).
 *
 * No database and no network: the db layer, the dialplan and the RFC 8599 gateway are mocked,
 * and every FCM / Google OAuth / APNs / Web Push request goes to an injected transport.
 */

import * as crypto from 'crypto';

const settings: Record<string, string> = {};
const tokens: Record<string, Array<Record<string, string>>> = {};
const runtimeMock = { bridge: null as unknown, preWoken: new Map<string, number>(), contactResolver: null, monitor: null };

jest.mock(
  '../src/db/db-manager',
  () => ({
    getSetting: jest.fn(async (key: string, fallback: string | null = null) => (settings[key] ? settings[key] : fallback)),
    setSetting: jest.fn(async (key: string, value: string | null) => {
      settings[key] = value ?? '';
      return true;
    }),
    setSettings: jest.fn(async (values: Record<string, string>) => {
      Object.assign(settings, values);
      return true;
    }),
    getAllSettings: jest.fn(async () => ({ ...settings })),
    replaceVapidKeys: jest.fn(async (values: Record<string, string>) => {
      Object.assign(settings, values);
      return 3;
    }),
    getDeviceTokensForExtension: jest.fn(async (ext: string, type: string | null = null) =>
      (tokens[ext] ?? []).filter((t) => type === null || t.token_type === type),
    ),
    deleteDeviceToken: jest.fn(async () => true),
    deleteSipPushBindingsByPrid: jest.fn(async () => 1),
    registerDeviceToken: jest.fn(async () => true),
    deleteWebPushSubscriptions: jest.fn(async () => 3),
    listSipPushBindings: jest.fn(async () => [
      {
        id: 4,
        extension: '100',
        pn_provider: 'fcm',
        pn_prid: 'abcdefghijklmnopqrstuvwxyz',
        pn_param: 'proj',
        user_agent: 'Medut/1.2 (android)',
        created_at: new Date(2026, 9, 1, 8, 30, 0),
        last_seen_at: null,
      },
    ]),
    deleteSipPushBinding: jest.fn(async (id: number) => id === 4),
  }));
jest.mock('../src/core/runtime', () => ({ runtime: runtimeMock }));
jest.mock('../src/core/security', () => ({ principalOf: (req: { principal?: unknown }) => req.principal ?? null }));
jest.mock('../src/services/dialplan', () => ({
  enableMobileWake: jest.fn(async () => true),
  disableMobileWake: jest.fn(async () => true),
}));
jest.mock('../src/services/sip-push', () => ({
  DEFAULT_HOLD: 10,
  DEFAULT_SETTLE: 3,
  DEFAULT_MARKER: 'Medut',
  configure: jest.fn(),
  wake: jest.fn(async () => true),
  ready: jest.fn(async () => true),
  done: jest.fn(),
  cancel: jest.fn(async () => undefined),
  markPreWoken: jest.fn(),
  reloadBindings: jest.fn(async () => undefined),
}));

import * as dbm from '../src/db/db-manager';
import * as push from '../src/integrations/push-service';
import * as sipPush from '../src/services/sip-push';
import { enableMobileWake } from '../src/services/dialplan';
import { maskToken, PushController } from '../src/api/routes/push.controller';
import { RawResponse } from '../src/api/respond';

const mocked = (fn: unknown) => fn as jest.Mock;

const EC_PEM = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
const RSA_PEM = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
const SERVICE_ACCOUNT = JSON.stringify({
  type: 'service_account',
  project_id: 'proj',
  private_key: RSA_PEM,
  client_email: 'push@proj.iam.gserviceaccount.com',
});

interface Sent {
  kind: 'fcm' | 'oauth' | 'apns' | 'web';
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

let sent: Sent[] = [];
let fcmStatus = 200;
let fcmBody = '{}';
let apnsStatus = 200;
let apnsBody = '';
let webPushError: unknown = null;

function installTransport(withWebPush = true) {
  sent = [];
  push.setPushTransport({
    fetch: async (url: string, init: RequestInit) => {
      if (url.includes('oauth2.googleapis.com')) {
        sent.push({ kind: 'oauth', url, headers: init.headers as Record<string, string>, body: init.body });
        return new Response('{"access_token": "ya29.test", "expires_in": 3600}', { status: 200 });
      }
      sent.push({ kind: 'fcm', url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
      return new Response(fcmBody, { status: fcmStatus });
    },
    h2Post: async (url: string, headers: Record<string, string>, body: string) => {
      sent.push({ kind: 'apns', url, headers, body: JSON.parse(body) });
      return { status: apnsStatus, text: apnsBody };
    },
    webPush: () =>
      withWebPush
        ? {
            sendNotification: async (sub: unknown, payload: string, opts: unknown) => {
              sent.push({ kind: 'web', url: String((sub as { endpoint?: string }).endpoint), headers: {}, body: { payload: JSON.parse(payload), opts } });
              if (webPushError) throw webPushError;
              return {};
            },
          }
        : null,
  });
}

async function configure(extra: Record<string, string> = {}) {
  Object.assign(settings, {
    PUSH_FCM_SERVICE_ACCOUNT: SERVICE_ACCOUNT,
    PUSH_APNS_AUTH_KEY: EC_PEM,
    PUSH_APNS_KEY_ID: 'KEYID12345',
    PUSH_APNS_TEAM_ID: 'TEAMID1234',
    PUSH_APNS_BUNDLE_ID: 'com.example.app',
    PUSH_VAPID_PUBLIC_KEY: 'pub',
    PUSH_VAPID_PRIVATE_KEY: 'priv',
    ...extra,
  });
  await push.reloadConfig();
}

beforeEach(async () => {
  jest.clearAllMocks();
  for (const k of Object.keys(settings)) delete settings[k];
  for (const k of Object.keys(tokens)) delete tokens[k];
  for (const k of ['FCM_PROJECT_ID', 'FCM_SERVICE_ACCOUNT_FILE', 'APNS_AUTH_KEY_FILE', 'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY']) delete process.env[k];
  fcmStatus = 200;
  fcmBody = '{}';
  apnsStatus = 200;
  apnsBody = '';
  webPushError = null;
  installTransport();
  await push.reloadConfig();
});

afterAll(() => push.setPushTransport(null));

describe('configuration', () => {
  test('nothing configured: every provider is off and status says why', async () => {
    expect(push.fcmEnabled() || push.apnsEnabled() || push.webPushEnabled()).toBe(false);
    expect(push.configStatus()).toEqual({
      fcm: { project_id: '', has_service_account: false, service_account_email: '', service_account_project: '', source: null, ready: false },
      apns: { key_id: '', team_id: '', bundle_id: '', has_auth_key: false, source: null, sandbox: false, ready: false },
      web: { public_key: '', ready: false, library_installed: true },
    });
  });

  test('UI keys: project id comes from the service account', async () => {
    await configure();
    const s = push.configStatus();
    expect(s.fcm).toMatchObject({ project_id: 'proj', has_service_account: true, source: 'ui', ready: true });
    expect(s.apns).toMatchObject({ has_auth_key: true, source: 'ui', ready: true });
    expect(s.web).toEqual({ public_key: 'pub', ready: true, library_installed: true });
  });

  test('.env fallback, and no web-push library means Web Push stays off', async () => {
    process.env.VAPID_PUBLIC_KEY = 'envpub';
    process.env.VAPID_PRIVATE_KEY = 'envpriv';
    process.env.FCM_SERVICE_ACCOUNT_FILE = '/nonexistent/sa.json';
    installTransport(false);
    await push.reloadConfig();
    expect(push.vapidPublicKey()).toBe('envpub');
    expect(push.webPushEnabled()).toBe(false);
    expect(push.configStatus().web.library_installed).toBe(false);
    expect(push.fcmEnabled()).toBe(false);
  });

  test('key validation texts', () => {
    expect(() => push.parseServiceAccount('{')).toThrow('not valid JSON');
    expect(() => push.parseServiceAccount('{"type": "user"}')).toThrow('not a service-account key ("type" must be "service_account")');
    expect(() => push.parseServiceAccount('{"type": "service_account", "project_id": "p"}')).toThrow('missing private_key, client_email');
    expect(push.validateApnsKey(`  ${EC_PEM}  `)).toBe(EC_PEM.trim());
    expect(() => push.validateApnsKey('hello')).toThrow('not a .p8 key (no BEGIN PRIVATE KEY block)');
    expect(() => push.validateApnsKey(RSA_PEM)).toThrow('APNs keys are EC P-256; this is a different kind of key');
  });

  test('VAPID keys: 65-byte uncompressed point and 32-byte scalar, base64url', () => {
    const [pub, priv] = push.generateVapidKeys();
    expect(Buffer.from(pub, 'base64url')).toHaveLength(65);
    expect(Buffer.from(pub, 'base64url')[0]).toBe(4);
    expect(Buffer.from(priv, 'base64url')).toHaveLength(32);
    expect(pub).not.toMatch(/[+/=]/);
  });
});

describe('sends', () => {
  test('call wake: android FCM data, iOS VoIP APNs (voip tokens only), web push', async () => {
    await configure();
    tokens['100'] = [
      { token: 'a1', platform: 'android', token_type: 'alert' },
      { token: 'i-alert', platform: 'ios', token_type: 'alert' },
      { token: 'i-voip', platform: 'ios', token_type: 'voip' },
      { token: '{"endpoint": "https://push.example/x"}', platform: 'web', token_type: 'alert' },
      { token: 'a1', platform: 'android', token_type: 'alert' },
    ];
    await push.sendCallWake('100', '0100', 'L1', 'Alice');
    const data = { type: 'incoming_call', extension: '100', caller: '0100', call_id: 'L1', display_name: 'Alice' };
    const fcm = sent.filter((s) => s.kind === 'fcm');
    expect(fcm).toHaveLength(1);
    expect(fcm[0].url).toBe('https://fcm.googleapis.com/v1/projects/proj/messages:send');
    expect(fcm[0].headers.Authorization).toBe('Bearer ya29.test');
    expect(fcm[0].body).toEqual({ message: { token: 'a1', data, android: { priority: 'high', ttl: '0s' } } });
    const apns = sent.filter((s) => s.kind === 'apns');
    expect(apns).toHaveLength(1);
    expect(apns[0].url).toBe('https://api.push.apple.com/3/device/i-voip');
    expect(apns[0].headers).toMatchObject({
      'apns-topic': 'com.example.app.voip',
      'apns-push-type': 'voip',
      'apns-priority': '10',
      'apns-expiration': '0',
      'apns-collapse-id': 'L1',
    });
    const [h, p, sig] = apns[0].headers.authorization.replace('bearer ', '').split('.');
    expect(JSON.parse(Buffer.from(h, 'base64url').toString())).toEqual({ alg: 'ES256', kid: 'KEYID12345', typ: 'JWT' });
    expect(JSON.parse(Buffer.from(p, 'base64url').toString()).iss).toBe('TEAMID1234');
    expect(Buffer.from(sig, 'base64url')).toHaveLength(64);
    const web = sent.filter((s) => s.kind === 'web');
    expect(web).toHaveLength(1);
    expect(web[0].body).toEqual({ payload: data, opts: { vapidDetails: { subject: 'mailto:admin@opdesk.local', publicKey: 'pub', privateKey: 'priv' }, TTL: 30 } });
    // one OAuth exchange for the service account, signed RS256
    const oauth = sent.filter((s) => s.kind === 'oauth');
    expect(oauth).toHaveLength(1);
    expect(String(oauth[0].body)).toContain('grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer');
  });

  test('alert banners: string data, iOS alert push with a 24 h expiry, web banner', async () => {
    await configure();
    tokens['100'] = [
      { token: 'i-alert', platform: 'ios', token_type: 'alert' },
      { token: 'a1', platform: 'android', token_type: 'alert' },
      { token: 'i-voip', platform: 'ios', token_type: 'voip' },
    ];
    await push.sendAlert('100', 'Missed call', 'Missed call from 0100', { queue: null, n: 1 });
    const apns = sent.filter((s) => s.kind === 'apns');
    expect(apns).toHaveLength(1);
    expect(apns[0].body).toEqual({ aps: { alert: { title: 'Missed call', body: 'Missed call from 0100' }, sound: 'default' }, queue: 'None', n: '1' });
    expect(apns[0].headers['apns-priority']).toBe('5');
    expect(Number(apns[0].headers['apns-expiration'])).toBeGreaterThan(Date.now() / 1000 + 86000);
    expect(sent.filter((s) => s.kind === 'fcm')[0].body).toEqual({
      message: { token: 'a1', notification: { title: 'Missed call', body: 'Missed call from 0100' }, data: { queue: 'None', n: '1' } },
    });
  });

  test('dead tokens are pruned: FCM UNREGISTERED, APNs 410, Web Push 410', async () => {
    await configure();
    fcmStatus = 404;
    fcmBody = '{"error": {"status": "NOT_FOUND", "details": [{"errorCode": "UNREGISTERED"}]}}';
    apnsStatus = 400;
    apnsBody = '{"reason": "BadDeviceToken"}';
    webPushError = Object.assign(new Error('gone'), { statusCode: 410 });
    tokens['100'] = [
      { token: 'a1', platform: 'android', token_type: 'alert' },
      { token: 'i-voip', platform: 'ios', token_type: 'voip' },
      { token: '{"endpoint": "https://push.example/x"}', platform: 'web', token_type: 'alert' },
    ];
    await push.sendCallWake('100', '0100', 'L1');
    const pruned = mocked(dbm.deleteDeviceToken).mock.calls.map((c) => c[0]).sort();
    expect(pruned).toEqual(['a1', 'i-voip', '{"endpoint": "https://push.example/x"}']);
  });

  test('INVALID_ARGUMENT is not a dead token', async () => {
    await configure();
    fcmStatus = 400;
    fcmBody = '{"error": {"status": "INVALID_ARGUMENT"}}';
    tokens['100'] = [{ token: 'a1', platform: 'android', token_type: 'alert' }];
    await push.sendCallWake('100', '0100', 'L1');
    expect(dbm.deleteDeviceToken).not.toHaveBeenCalled();
  });

  test('pre-wake: background push on the iOS alert token, no web', async () => {
    await configure();
    tokens['100'] = [
      { token: 'i-alert', platform: 'ios', token_type: 'alert' },
      { token: 'w', platform: 'web', token_type: 'alert' },
    ];
    await push.sendPreWake('100', '0100');
    expect(sent.map((s) => s.kind)).toEqual(['apns']);
    expect(sent[0].body).toEqual({ aps: { 'content-available': 1 }, type: 'pre_wake', extension: '100', caller: '0100' });
    expect(sent[0].headers).toMatchObject({ 'apns-push-type': 'background', 'apns-topic': 'com.example.app', 'apns-priority': '5' });
  });
});

describe('RFC 8599', () => {
  const call = { type: 'call', caller_uri: 'sip:0100@pbx', caller_name: 'Alice', aor: 'sip:100@pbx', extra: null };

  test('FCM data push with the hold as TTL; APNs topic from pn-param; sandbox host', async () => {
    await configure();
    const n = await push.sendRfc8599(
      [
        { pn_provider: 'fcm', pn_prid: 'f1', pn_param: 'proj' },
        { pn_provider: 'FCM', pn_prid: 'f1', pn_param: 'proj' },
        { pn_provider: 'apns', pn_prid: 'v1', pn_param: 'TEAMID1234.com.other.voip' },
        { pn_provider: 'apns-sandbox', pn_prid: 'v2', pn_param: '' },
        { pn_provider: 'webpush', pn_prid: 'x', pn_param: '' },
      ],
      call,
      12,
      'uid-1',
    );
    expect(n).toBe(3);
    const fcm = sent.find((s) => s.kind === 'fcm') as Sent;
    expect(fcm.body).toEqual({
      message: { token: 'f1', data: { type: 'call', caller_uri: 'sip:0100@pbx', caller_name: 'Alice', aor: 'sip:100@pbx' }, android: { priority: 'high', ttl: '12s' } },
    });
    const apns = sent.filter((s) => s.kind === 'apns');
    expect(apns.map((a) => [a.url, a.headers['apns-topic'], a.headers['apns-collapse-id']])).toEqual([
      ['https://api.push.apple.com/3/device/v1', 'com.other.voip', 'uid-1'],
      ['https://api.sandbox.push.apple.com/3/device/v2', 'com.example.app.voip', 'uid-1'],
    ]);
  });

  test('cancel never goes over APNs; a foreign FCM project is skipped', async () => {
    await configure();
    const n = await push.sendRfc8599(
      [
        { pn_provider: 'apns', pn_prid: 'v1' },
        { pn_provider: 'fcm', pn_prid: 'f1', pn_param: 'other-project' },
        { pn_provider: 'fcm', pn_prid: 'f2', pn_param: '' },
      ],
      { type: 'cancel', aor: 'sip:100@pbx' },
    );
    expect(n).toBe(1);
    expect(sent.filter((s) => s.kind !== 'oauth').map((s) => s.kind)).toEqual(['fcm']);
  });

  test('a dead binding token drops the binding, not a device token', async () => {
    await configure();
    apnsStatus = 410;
    await push.sendRfc8599([{ pn_provider: 'apns', pn_prid: 'v1' }], call);
    expect(dbm.deleteSipPushBindingsByPrid).toHaveBeenCalledWith('apns', 'v1');
    expect(dbm.deleteDeviceToken).not.toHaveBeenCalled();
  });

  test('canWake and apnsTopic', async () => {
    expect(push.canWake([{ pn_provider: 'fcm', pn_prid: 'f' }], [{ platform: 'android', token_type: 'alert' }])).toBe(false);
    await configure({ PUSH_APNS_KEY_ID: '' });
    expect(push.canWake([{ pn_provider: 'apns', pn_prid: 'v' }], [])).toBe(false);
    expect(push.canWake([], [{ platform: 'ios', token_type: 'alert' }])).toBe(false);
    expect(push.canWake([], [{ platform: 'web', token_type: 'alert' }])).toBe(true);
    expect(push.canWake([{ pn_provider: 'fcm', pn_prid: 'f', pn_param: 'proj' }], [])).toBe(true);
    expect(push.apnsTopic('ABCDE12345.com.x.voip')).toBe('com.x.voip');
    expect(push.apnsTopic('com.x.voip')).toBe('com.x.voip');
    expect(push.apnsTopic('')).toBe('com.example.app.voip');
  });
});

describe('push routes', () => {
  const ctl = new PushController();
  const USER = { id: 7, username: 'ann', role: 'agent', extension: '100' };
  const req = (over: Record<string, unknown> = {}) => ({ params: {}, query: {}, body: {}, principal: USER, ...over }) as never;

  test('POST/DELETE /api/device-tokens are bare {status: ok}', async () => {
    expect(await ctl.registerDeviceToken(req({ body: { token: ' t ', platform: 'IOS', token_type: 'VoIP' } }))).toEqual({ status: 'ok' });
    expect(dbm.registerDeviceToken).toHaveBeenCalledWith(7, '100', 'ios', 'voip', 't', null);
    await expect(ctl.registerDeviceToken(req({ body: { token: 't', platform: 'blackberry' } }))).rejects.toMatchObject({
      status: 400,
      message: 'Invalid token, platform, or token_type',
    });
    mocked(dbm.registerDeviceToken).mockResolvedValueOnce(false);
    await expect(ctl.registerDeviceToken(req({ body: { token: 't', platform: 'android' } }))).rejects.toMatchObject({
      status: 500,
      message: 'Failed to register device token',
    });
    expect(await ctl.deleteDeviceToken(req({ body: { token: 'x' } }))).toEqual({ status: 'ok' });
    await expect(ctl.deleteDeviceToken(req({ body: { token: ' ' } }))).rejects.toMatchObject({ status: 400, message: 'token required' });
  });

  test('GET /api/push/vapid-public-key is bare and null when off', async () => {
    expect(await ctl.vapidPublicKey()).toEqual({ enabled: false, public_key: null });
    await configure();
    expect(await ctl.vapidPublicKey()).toEqual({ enabled: true, public_key: 'pub' });
  });

  test('POST /api/push/web-resubscribe stores json.dumps(subscription)', async () => {
    const sub = { endpoint: 'https://push.example/x', keys: { p256dh: 'k', auth: 'a' } };
    expect(await ctl.webResubscribe(req({ body: { subscription: sub } }))).toEqual({ status: 'ok' });
    expect(dbm.registerDeviceToken).toHaveBeenCalledWith(
      7,
      '100',
      'web',
      'alert',
      '{"endpoint": "https://push.example/x", "keys": {"p256dh": "k", "auth": "a"}}',
      null,
    );
    await expect(ctl.webResubscribe(req({ body: {} }))).rejects.toMatchObject({ status: 400, message: 'subscription required' });
  });

  test('internal wake hook: text/plain "1" and the pre-woken mark; display name from the bridge', async () => {
    runtimeMock.bridge = { extensionNames: new Map([['101', 'Bob']]) };
    const res = (await ctl.internalMobileWakeGet(req({ params: { extension: '100' }, query: { caller: '101', name: '101', uid: 'u1' } }))) as RawResponse;
    expect(res).toBeInstanceOf(RawResponse);
    expect(res.body).toBe('1');
    expect(res.init.contentType).toBe('text/plain; charset=utf-8');
    expect(sipPush.wake).toHaveBeenCalledWith('100', 'u1', '101', 'Bob', 10);
    expect(sipPush.markPreWoken).toHaveBeenCalledWith('100');
    mocked(sipPush.wake).mockResolvedValueOnce(false);
    expect(((await ctl.internalMobileWakePost(req({ params: { extension: '100' } }))) as RawResponse).body).toBe('');
    runtimeMock.bridge = null;
  });

  test('internal wake steps', async () => {
    expect(((await ctl.internalMobileWakeStepGet(req({ params: { extension: '100', op: 'ready' }, query: { uid: 'u' } }))) as RawResponse).body).toBe('1');
    expect(((await ctl.internalMobileWakeStepGet(req({ params: { extension: '100', op: 'done' }, query: { uid: 'u' } }))) as RawResponse).body).toBe('');
    expect(sipPush.done).toHaveBeenCalledWith('u');
    await ctl.internalMobileWakeStepPost(req({ params: { extension: '100', op: 'cancel' }, query: { uid: 'u' } }));
    expect(sipPush.cancel).toHaveBeenCalledWith('u');
    await expect(ctl.internalMobileWakeStepGet(req({ params: { extension: '100', op: 'boom' } }))).rejects.toMatchObject({
      status: 404,
      message: 'Unknown step',
    });
  });

  test('mobile-wake status (bare) and enable (enveloped, clamped)', async () => {
    settings.MOBILE_WAKE_WAIT = '45';
    expect(await ctl.mobileWakeStatus()).toEqual({
      enabled: false,
      hold_seconds: 30,
      settle_seconds: 3,
      client_marker: 'Medut',
      wait_seconds: 30,
    });
    expect(await ctl.enableMobileWake(req({ body: { wait_seconds: 5, settle_seconds: 20 } }))).toEqual({
      data: { message: 'Mobile wake enabled (hold=8s, settle=10s). Asterisk dialplan reloaded.' },
    });
    expect(enableMobileWake).toHaveBeenCalledWith(8, 10);
    expect(settings).toMatchObject({ MOBILE_WAKE_ENABLED: 'true', MOBILE_WAKE_WAIT: '8', MOBILE_WAKE_SETTLE: '10' });
    expect(sipPush.configure).toHaveBeenCalledWith({ enabled: true });
    mocked(enableMobileWake).mockResolvedValueOnce(false);
    await expect(ctl.enableMobileWake(req({ body: undefined }))).rejects.toMatchObject({
      status: 500,
      message: 'Failed to enable mobile wake. Check server logs.',
    });
  });

  test('GET /api/push/config: enveloped, bindings masked', async () => {
    const res = (await ctl.getPushConfig()) as { data: Record<string, unknown> };
    expect(Object.keys(res.data)).toEqual(['mobile_wake', 'fcm', 'apns', 'web', 'bindings']);
    expect(res.data.bindings).toEqual([
      {
        id: 4,
        extension: '100',
        provider: 'fcm',
        param: 'proj',
        token: 'abcdefgh…uvwxyz',
        user_agent: 'Medut/1.2 (android)',
        created_at: '2026-10-01T08:30:00',
        last_seen_at: null,
      },
    ]);
    expect(maskToken('short')).toBe('short');
  });

  test('PUT /api/push/config validates, stores, and applies the wake only when on (or was on)', async () => {
    await expect(ctl.putPushConfig(req({ body: { enabled: true, hold_seconds: 5 } }))).rejects.toMatchObject({
      status: 422,
      message: 'Hold time must be 8 to 30 seconds',
    });
    await expect(ctl.putPushConfig(req({ body: { enabled: true, apns_team_id: 'short' } }))).rejects.toMatchObject({
      message: 'APNs Team ID is 10 letters and digits',
    });
    await expect(ctl.putPushConfig(req({ body: { enabled: true, fcm_service_account: '{' } }))).rejects.toMatchObject({
      message: 'Service account JSON: not valid JSON',
    });
    await expect(ctl.putPushConfig(req({ body: { enabled: true, apns_auth_key: 'x' } }))).rejects.toMatchObject({
      message: 'APNs auth key: not a .p8 key (no BEGIN PRIVATE KEY block)',
    });
    const account = JSON.stringify({ ...JSON.parse(SERVICE_ACCOUNT), project_id: 'proj-push' });
    const res = (await ctl.putPushConfig(
      req({ body: { enabled: false, hold_seconds: 12, fcm_service_account: account, apns_key_id: 'abcde12345', client_marker: ' Medut ' } }),
    )) as { data: Record<string, unknown> };
    expect(settings.PUSH_FCM_PROJECT_ID).toBe('proj-push');
    expect(JSON.parse(settings.PUSH_FCM_SERVICE_ACCOUNT).client_email).toBe('push@proj.iam.gserviceaccount.com');
    expect(settings.PUSH_APNS_KEY_ID).toBe('ABCDE12345');
    expect(settings.MOBILE_CLIENT_MARKER).toBe('Medut');
    expect(settings.MOBILE_WAKE_WAIT).toBe('12');
    expect(enableMobileWake).not.toHaveBeenCalled();
    expect((res.data.fcm as Record<string, unknown>).ready).toBe(true);
  });

  test('VAPID rotate and binding delete are enveloped', async () => {
    const rot = (await ctl.rotateVapidKeys(req())) as { data: { public_key: string; removed_subscriptions: number } };
    expect(rot.data.removed_subscriptions).toBe(3);
    expect(settings.PUSH_VAPID_PUBLIC_KEY).toBe(rot.data.public_key);
    expect(await ctl.deletePushBinding(req({ params: { binding_id: '4' } }))).toEqual({ data: { deleted: 4 } });
    expect(sipPush.reloadBindings).toHaveBeenCalled();
    await expect(ctl.deletePushBinding(req({ params: { binding_id: '5' } }))).rejects.toMatchObject({
      status: 404,
      message: 'Binding not found',
    });
  });
});
