/**
 * integrations/crm + crm-lookup and the CRM / contacts routes: payload assembly (field
 * selection, duration units, status remap, key renames), the SSRF guard, the lookup helpers,
 * the connector over a mocked fetch, the delivery log write, the contact resolver, and the
 * route contract (bare vs {data}, error texts, the non-atomic save).
 *
 * No database and no network: the db layer is mocked and every HTTP request goes to an
 * injected fetch, so nothing here can reach a real CRM.
 */

const settings: Record<string, string> = {};
const runtimeMock = {
  contactResolver: null as unknown,
  crmConnector: null as unknown,
  crmLookupConnector: null as unknown,
  monitor: null as unknown,
  preWoken: new Map<string, number>(),
};

jest.mock(
  '../src/db/db-manager',
  () => ({
    getSetting: jest.fn(async (key: string, fallback: string | null = null) => (settings[key] ? settings[key] : fallback)),
    setSetting: jest.fn(async (key: string, value: string | null) => {
      settings[key] = value ?? '';
      return true;
    }),
    insertWebhookDelivery: jest.fn(async () => 1),
    addCrmContactIfNew: jest.fn(async () => true),
    getContactsForResolver: jest.fn(async () => [['201001234567', 'Alice']]),
    listContacts: jest.fn(async () => [{ id: 1, name: 'Alice', phone: '+20 100 123 4567' }]),
    createContact: jest.fn(async () => 5),
    updateContact: jest.fn(async () => true),
    deleteContact: jest.fn(async () => true),
  }));
jest.mock('../src/core/runtime', () => ({ runtime: runtimeMock }));
jest.mock('../src/core/security', () => ({ principalOf: (req: { principal?: unknown }) => req.principal ?? null }));

import * as dbm from '../src/db/db-manager';
import {
  AuthType,
  buildCrmPayload,
  CRMConnector,
  CRMLookupConfig,
  createCrmConnector,
  CrmValueError,
  defaultOutboundKeys,
  extractJsonPath,
  formatLookupNumber,
  loadCrmSyncConfig,
  lookupCacheKey,
  migrateCrmSyncFields,
  modernizeStatusMap,
  parseKeyMap,
  parseStatusMap,
  parseSyncFields,
  redactUrl,
  renderLookupUrl,
  renderNameTemplate,
  sendCrmDataAsync,
  setCrmFetch,
  setCrmResolver,
  validateCrmUrl,
} from '../src/integrations/crm';
import { ContactResolver, runLookupTest } from '../src/integrations/crm-lookup';
import { CrmController } from '../src/api/routes/crm.controller';
import { HttpError } from '../src/api/http-error';
import { AppError } from '../src/api/errors';

const mocked = (fn: unknown) => fn as jest.Mock;

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

/** A fetch that records each request and answers from `reply`. */
function fakeFetch(reply: (c: Call) => { status?: number; body?: string } | Error) {
  const calls: Call[] = [];
  const impl = async (url: string, init: RequestInit) => {
    const c: Call = {
      url,
      method: String(init.method),
      headers: (init.headers as Record<string, string>) ?? {},
      body: init.body as string | undefined,
    };
    calls.push(c);
    const r = reply(c);
    if (r instanceof Error) throw r;
    return new Response(init.method === 'HEAD' ? null : (r.body ?? ''), { status: r.status ?? 200 });
  };
  setCrmFetch(impl);
  return calls;
}

beforeEach(() => {
  jest.clearAllMocks();
  for (const k of Object.keys(settings)) delete settings[k];
  setCrmFetch(null);
  setCrmResolver(async () => {
    throw new Error('no DNS in tests');
  });
  runtimeMock.contactResolver = null;
  runtimeMock.crmConnector = null;
  runtimeMock.monitor = null;
});

afterAll(() => setCrmFetch(null));

describe('buildCrmPayload', () => {
  const all = {
    caller: '01001234567',
    destination: '201',
    duration: 323,
    talk_time: '00:04:50',
    datetime: '2026-10-25T10:00:00',
    call_status: 'UNANSWERED',
    disposition: 'UNANSWERED',
    call_type: 'inbound',
    queue: '',
    agent: '305',
    call_id: '1700000000.1',
  };

  test('keeps the selected, present fields under their outbound names', () => {
    const out = buildCrmPayload(all, ['caller', 'duration', 'talk_time', 'datetime', 'call_status', 'queue', 'agent', 'nope']);
    expect(out).toEqual({
      caller: '01001234567',
      duration: '00:05:23',
      talkTime: '00:04:50',
      startTime: '2026-10-25T10:00:00',
      status: 'UNANSWERED',
      agentExt: 305,
    });
    expect(Object.keys(out)).toEqual(['caller', 'duration', 'talkTime', 'startTime', 'status', 'agentExt']);
  });

  test('seconds mode converts both forms and renames the keys', () => {
    expect(buildCrmPayload(all, ['duration', 'talk_time'], { durationFormat: 'seconds' })).toEqual({
      durationInSeconds: 323,
      talkTimeInSeconds: 290,
    });
  });

  test('status map rewrites call_status and disposition case-insensitively', () => {
    const out = buildCrmPayload({ ...all, disposition: 'unanswered' }, ['call_status', 'disposition'], {
      statusMap: { UNANSWERED: 'NO_ANSWER' },
    });
    expect(out).toEqual({ status: 'NO_ANSWER', disposition: 'NO_ANSWER' });
  });

  test('key renames apply last and never clobber another field', () => {
    const out = buildCrmPayload(all, ['caller', 'destination', 'agent'], {
      keyMap: { agentExt: 'agentId', destination: 'caller' },
    });
    expect(out).toEqual({ caller: '01001234567', destination: '201', agentId: 305 });
  });

  test('a seconds-mode rename keyed on the HH:MM:SS name still matches', () => {
    expect(buildCrmPayload(all, ['duration'], { durationFormat: 'seconds', keyMap: { duration: 'secs' } })).toEqual({ secs: 323 });
  });

  test('numeric 0 is present, an unparseable agent stays as it is', () => {
    expect(buildCrmPayload({ duration: 0, agent: 'PJSIP/305' }, ['duration', 'agent'])).toEqual({
      duration: '00:00:00',
      agentExt: 'PJSIP/305',
    });
  });
});

describe('maps and field lists', () => {
  test('parseKeyMap keeps renames of known outbound keys only', () => {
    expect(parseKeyMap('{"agentExt": " agentId ", "bogus": "x", "status": "status", "durationInSeconds": "d"}')).toEqual({
      agentExt: 'agentId',
      durationInSeconds: 'd',
    });
    expect(parseKeyMap('not json')).toEqual({});
    expect(parseKeyMap(['a'])).toEqual({});
  });

  test('parseStatusMap upper-cases and drops blanks; retired spellings are modernized', () => {
    const parsed = parseStatusMap({ busy: 'no_answer', NO_ANSWER: 'MISSED_CALL', '': 'x', MISSED: '' });
    expect(parsed).toEqual({ BUSY: 'NO_ANSWER', NO_ANSWER: 'MISSED_CALL' });
    expect(modernizeStatusMap(parsed)).toEqual({ BUSY: 'NO_ANSWER', UNANSWERED: 'MISSED_CALL' });
    expect(modernizeStatusMap({ NO_ANSWER: 'old', UNANSWERED: 'new' })).toEqual({ UNANSWERED: 'new' });
  });

  test('parseSyncFields: CSV or list, catalog-only, de-duplicated, ordered', () => {
    expect(parseSyncFields('caller, linkedid,queue,caller,')).toEqual(['caller', 'queue']);
    expect(parseSyncFields(['call_id', 'agent'])).toEqual(['call_id', 'agent']);
  });

  test('defaultOutboundKeys shows the HH:MM:SS duration names', () => {
    const keys = defaultOutboundKeys();
    expect(keys.duration).toBe('duration');
    expect(keys.talk_time).toBe('talkTime');
    expect(keys.call_status).toBe('status');
  });

  test('migrateCrmSyncFields rewrites retired names once', async () => {
    settings.CRM_SYNC_FIELDS = 'caller,linkedid,call_id';
    await migrateCrmSyncFields();
    expect(settings.CRM_SYNC_FIELDS).toBe('caller,call_id');
    mocked(dbm.setSetting).mockClear();
    await migrateCrmSyncFields();
    expect(dbm.setSetting).not.toHaveBeenCalled();
  });

  test('loadCrmSyncConfig defaults to the legacy push and falls back to the connection path', async () => {
    settings.CRM_ENDPOINT_PATH = '/legacy';
    settings.CRM_SYNC_METHOD = 'patch';
    settings.CRM_SYNC_STATUS_MAP = '{"OUT_OF_REACH": "OFF"}';
    const cfg = await loadCrmSyncConfig();
    expect(cfg.enabled).toBe(true);
    expect(cfg.endpoint).toBe('/legacy');
    expect(cfg.method).toBe('POST');
    expect(cfg.fields).toEqual(['caller', 'destination', 'duration', 'talk_time', 'datetime', 'call_status', 'call_type', 'queue']);
    expect(cfg.statusMap).toEqual({ UNREACHABLE: 'OFF' });
    expect(cfg.directionAllowed('outbound')).toBe(true);
    expect(cfg.directionAllowed('')).toBe(true);
  });
});

describe('SSRF guard', () => {
  test.each([
    ['http://127.0.0.1:8080/x', 'CRM URL host resolves to a blocked address (127.0.0.1)'],
    ['http://169.254.169.254/latest', 'CRM URL host resolves to a blocked address (169.254.169.254)'],
    ['http://0.0.0.0/', 'CRM URL host resolves to a blocked address (0.0.0.0)'],
    ['http://[::1]/', 'CRM URL host resolves to a blocked address (::1)'],
    ['http://224.0.0.1/', 'CRM URL host resolves to a blocked address (224.0.0.1)'],
    ['http://2130706433/', 'CRM URL host resolves to a blocked address (127.0.0.1)'],
    ['ftp://crm.example.com', 'CRM URL scheme must be http or https'],
    ['crm.example.com', 'CRM URL scheme must be http or https'],
  ])('%s is refused', async (url, message) => {
    await expect(validateCrmUrl(url)).rejects.toThrow(new CrmValueError(message));
  });

  test('a LAN CRM is allowed unless block_private is on', async () => {
    await expect(validateCrmUrl('http://192.168.1.100:8080')).resolves.toBeUndefined();
    await expect(validateCrmUrl('http://192.168.1.100:8080', { blockPrivate: true })).rejects.toThrow(
      'CRM URL host resolves to a blocked address (192.168.1.100)',
    );
  });

  test('hostnames are checked by what they resolve to; unresolvable is allowed', async () => {
    setCrmResolver(async () => ['10.1.2.3', '127.0.0.2']);
    await expect(validateCrmUrl('https://crm.internal')).rejects.toThrow('(127.0.0.2)');
    setCrmResolver(async () => {
      throw new Error('ENOTFOUND');
    });
    await expect(validateCrmUrl('https://later.example.com')).resolves.toBeUndefined();
    await expect(validateCrmUrl('   ')).resolves.toBeUndefined();
  });

  test('redactUrl drops credentials and the query string', () => {
    expect(redactUrl('https://user:pw@crm.example.com/api/calls?token=x')).toBe('https://crm.example.com/api/calls');
    expect(redactUrl('nope')).toBe('(crm endpoint)');
  });
});

describe('lookup helpers', () => {
  test('number formats', () => {
    expect(formatLookupNumber(' +20 100 123 ', 'digits')).toBe('20100123');
    expect(formatLookupNumber('+20 100', 'as_is')).toBe('+20 100');
    expect(formatLookupNumber('0020100', 'plus')).toBe('+20100');
    expect(formatLookupNumber('+20100', 'plus')).toBe('+20100');
    expect(formatLookupNumber('+20100', 'zeros')).toBe('0020100');
    expect(formatLookupNumber('20100', 'zeros')).toBe('20100');
  });

  test('cache keys reduce to the last N digits', () => {
    expect(lookupCacheKey('+20 100 123 4567', 10)).toBe('1001234567');
    expect(lookupCacheKey('0100-123-4567')).toBe('01001234567');
    expect(lookupCacheKey('x')).toBe('');
  });

  test('JSON paths and name templates', () => {
    const data = { data: [{ first_name: 'Alice', last_name: ' Smith ', id: 7, ok: true }] };
    expect(extractJsonPath(data, 'data.0.first_name')).toBe('Alice');
    expect(extractJsonPath(data, 'data.-1.id')).toBe('7');
    expect(extractJsonPath(data, 'data.0.ok')).toBeNull();
    expect(extractJsonPath(data, 'data.1.first_name')).toBeNull();
    expect(renderNameTemplate(data, '[data.0.first_name]  [data.0.last_name]')).toBe('Alice Smith');
    expect(renderNameTemplate(data, 'Mr [data.0.nope]')).toBeNull();
    expect(renderNameTemplate(data, 'data.0.first_name')).toBe('Alice');
  });

  test('lookup URLs get the encoded number', () => {
    expect(renderLookupUrl('/contacts?phone=[Number]', '+20 (100)', 'as_is')).toBe('/contacts?phone=%2B20%20%28100%29');
    expect(renderLookupUrl('/contacts', '0100', 'digits')).toBe('/contacts?phone=0100');
    expect(renderLookupUrl('/c?x=1', '0100')).toBe('/c?x=1&phone=0100');
  });
});

describe('CRMConnector', () => {
  test('API key header, JSON body, success result', async () => {
    const calls = fakeFetch(() => ({ status: 201, body: '{"id": 9}' }));
    const crm = createCrmConnector({ server_url: 'https://crm.example.com/', auth_type: 'api_key', api_key: 'k', api_key_header: '' });
    const r = await crm.sendCallData({ caller: '1', destination: '2' });
    expect(r).toEqual({ success: true, status_code: 201, data: { id: 9 }, error: null });
    expect(calls[0].url).toBe('https://crm.example.com/api/calls');
    expect(calls[0].headers['X-API-Key']).toBe('k');
    expect(calls[0].headers['User-Agent']).toBe('OpDesk-CRM-Connector/1.0');
    expect(JSON.parse(String(calls[0].body))).toEqual({ caller: '1', destination: '2' });
  });

  test('an HTTP error and a refused connection come back as failures', async () => {
    fakeFetch(() => ({ status: 500, body: 'boom' }));
    const crm = new CRMConnector('https://crm', AuthType.BEARER_TOKEN, { bearerToken: 't' });
    expect(await crm.sendCallData({}, { requireFields: false })).toEqual({ success: false, status_code: 500, error: 'boom', data: null });
    fakeFetch(() => Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }));
    expect(await crm.sendCallData({}, { requireFields: false })).toEqual({
      success: false,
      status_code: null,
      error: '[Errno 111] Connection refused',
      data: null,
    });
    await expect(crm.sendCallData({ caller: '1' })).rejects.toThrow("Missing required fields: ['destination']");
  });

  test('non-JSON success bodies are wrapped', async () => {
    fakeFetch(() => ({ status: 200, body: 'OK' }));
    const crm = new CRMConnector('https://crm', AuthType.BASIC_AUTH, { username: 'u', password: 'p' });
    expect((await crm.getJson('/c?phone=1')).data).toEqual({ message: 'OK', status_code: 200 });
  });

  test('basic auth header; GET drops Content-Type', async () => {
    const calls = fakeFetch(() => ({ body: '{}' }));
    const crm = new CRMConnector('https://crm', AuthType.BASIC_AUTH, { username: 'u', password: 'p' });
    await crm.getJson('/x');
    expect(calls[0].headers.Authorization).toBe(`Basic ${Buffer.from('u:p').toString('base64')}`);
    expect(calls[0].headers['Content-Type']).toBeUndefined();
  });

  test('OAuth2: one token fetch, cached across pushes', async () => {
    const calls = fakeFetch((c) =>
      c.url.endsWith('/token') ? { body: '{"access_token": "abc", "expires_in": 3600}' } : { body: '{}' },
    );
    const crm = createCrmConnector({
      server_url: 'https://crm',
      auth_type: 'oauth2',
      oauth2_client_id: 'id',
      oauth2_client_secret: 'sec',
      oauth2_token_url: 'https://crm/token',
      oauth2_scope: 'calls',
    });
    await crm.sendCallData({ a: 1 }, { requireFields: false });
    await crm.sendCallData({ a: 2 }, { requireFields: false });
    const tokenCalls = calls.filter((c) => c.url.endsWith('/token'));
    expect(tokenCalls).toHaveLength(1);
    expect(tokenCalls[0].body).toBe('grant_type=client_credentials&client_id=id&client_secret=sec&scope=calls');
    expect(calls.filter((c) => c.url.endsWith('/api/calls')).every((c) => c.headers.Authorization === 'Bearer abc')).toBe(true);
  });

  test('config errors are ValueErrors with the Python texts', () => {
    expect(() => createCrmConnector({ server_url: 'https://crm', auth_type: 'magic' })).toThrow(
      "Invalid auth_type: magic. Must be one of: ['api_key', 'basic_auth', 'bearer_token', 'oauth2']",
    );
    expect(() => createCrmConnector({ server_url: 'https://crm', auth_type: 'api_key' })).toThrow(
      'API key is required for API_KEY authentication',
    );
  });

  test('testConnection: HEAD status decides', async () => {
    const calls = fakeFetch(() => ({ status: 405 }));
    const crm = new CRMConnector('https://crm', AuthType.API_KEY, { apiKey: 'k' });
    expect(await crm.testConnection('/sync')).toEqual({
      success: false,
      status_code: 405,
      message: 'Connection test failed',
      method: 'HEAD',
    });
    expect(calls[0]).toMatchObject({ url: 'https://crm/sync', method: 'HEAD' });
  });

  test('durations', () => {
    expect(CRMConnector.normalizeDuration(3725)).toBe('01:02:05');
    expect(CRMConnector.normalizeDuration('90')).toBe('00:01:30');
    expect(CRMConnector.normalizeDuration('1:30')).toBe('1:30');
    expect(CRMConnector.durationToSeconds('01:02:05')).toBe(3725);
    expect(CRMConnector.durationToSeconds('x')).toBeNull();
    expect(CRMConnector.durationToSeconds(true)).toBeNull();
  });
});

describe('sendCrmDataAsync', () => {
  test('pushes and records the delivery with the internal identity', async () => {
    fakeFetch(() => ({ status: 200, body: '{"ok": true}' }));
    const crm = new CRMConnector('https://user:pw@crm.example.com', AuthType.API_KEY, { apiKey: 'k', endpointPath: '/calls' });
    const r = await sendCrmDataAsync(crm, { callId: 'L1', status: 'ANSWERED' }, {
      method: 'PUT',
      endpointPath: '/sync?key=secret',
      meta: { call_id: 'L1', caller: '100', destination: '200', call_status: 'ANSWERED', attempt: 2, parent_id: 4, resent_by: 1 },
    });
    expect(r.success).toBe(true);
    const row = mocked(dbm.insertWebhookDelivery).mock.calls[0][0];
    expect(row).toMatchObject({
      callId: 'L1',
      caller: '100',
      destination: '200',
      callStatus: 'ANSWERED',
      method: 'PUT',
      url: 'https://crm.example.com/sync',
      requestBody: '{"callId": "L1", "status": "ANSWERED"}',
      statusCode: 200,
      success: true,
      responseBody: '{"ok": true}',
      error: null,
      attempt: 2,
      parentId: 4,
      resentBy: 1,
    });
  });

  test('no connector is recorded as a failure, not skipped', async () => {
    const r = await sendCrmDataAsync(null, { caller: '1' });
    expect(r).toEqual({ success: false, status_code: null, data: null, error: 'CRM connector not configured' });
    expect(mocked(dbm.insertWebhookDelivery).mock.calls[0][0]).toMatchObject({ success: false, url: '', attempt: 1 });
  });
});

describe('ContactResolver', () => {
  const cfg = () =>
    new CRMLookupConfig({ enabled: true, urlTemplate: '/c?phone=[Number]', nameTemplate: '[0.name]', matchDigits: 10 });

  test('phonebook hits never touch the CRM; short numbers are skipped', async () => {
    const calls = fakeFetch(() => ({ body: '[]' }));
    const r = new ContactResolver();
    r.setConfig(cfg(), new CRMConnector('https://crm', AuthType.API_KEY, { apiKey: 'k' }));
    r.setContacts([['201001234567', 'Alice']]);
    expect(r.resolveCached('+20 100 123 4567')).toBe('Alice');
    expect(await r.resolve('01001234567')).toBe('Alice');
    expect(await r.resolve('201')).toBeNull();
    expect(calls).toHaveLength(0);
  });

  test('a CRM hit becomes a crm contact; a 404 is remembered as a miss', async () => {
    const calls = fakeFetch((c) => (c.url.includes('1112223334') ? { body: '[{"name": "Bob"}]' } : { status: 404 }));
    const r = new ContactResolver();
    r.setConfig(cfg(), new CRMConnector('https://crm', AuthType.API_KEY, { apiKey: 'k' }));
    expect(await r.resolve('+1 111 222 3334')).toBe('Bob');
    expect(dbm.addCrmContactIfNew).toHaveBeenCalledWith('+1 111 222 3334', '1112223334', 'Bob');
    expect(r.resolveCached('11112223334')).toBe('Bob');
    expect(await r.resolve('9998887777')).toBeNull();
    expect(await r.resolve('9998887777')).toBeNull();
    expect(calls.filter((c) => c.url.includes('9998887777'))).toHaveLength(1);
  });

  test('verification rejects a record for another number', async () => {
    fakeFetch(() => ({ body: '[{"name": "Eve", "phone": "5550000000"}]' }));
    const r = new ContactResolver();
    r.setConfig(
      new CRMLookupConfig({ ...cfg(), verifyPath: '0.phone' }),
      new CRMConnector('https://crm', AuthType.API_KEY, { apiKey: 'k' }),
    );
    expect(await r.resolve('5551112222')).toBeNull();
    expect(dbm.addCrmContactIfNew).not.toHaveBeenCalled();
  });

  test('runLookupTest reports name, match and an excerpt', async () => {
    fakeFetch(() => ({ body: '[{"name": "Bob", "phone": "+1 555 111 2222"}]' }));
    const crm = new CRMConnector('https://crm', AuthType.API_KEY, { apiKey: 'k' });
    const res = await runLookupTest(crm, new CRMLookupConfig({ ...cfg(), verifyPath: '0.phone' }), '5551112222');
    expect(res).toEqual({
      success: true,
      status_code: 200,
      name: 'Bob',
      matched: true,
      verify_detail: '',
      raw_excerpt: '[{"name": "Bob", "phone": "+1 555 111 2222"}]',
      error: null,
    });
    fakeFetch(() => ({ status: 401, body: 'denied' }));
    expect(await runLookupTest(crm, cfg(), '5551112222')).toMatchObject({ success: false, status_code: 401, error: 'denied' });
  });
});

describe('CRM routes', () => {
  const ctl = new CrmController();
  const ADMIN = { id: 1, username: 'admin', role: 'admin', extension: null };
  const req = (over: Record<string, unknown> = {}) => ({ params: {}, query: {}, body: {}, principal: ADMIN, ...over }) as never;

  test('GET /api/crm/config masks secrets and serves the catalog and the 10 call statuses', async () => {
    Object.assign(settings, { CRM_ENABLED: 'true', CRM_AUTH_TYPE: 'basic_auth', CRM_USERNAME: 'u', CRM_PASSWORD: 'p' });
    const cfg = (await ctl.getCrmConfig()) as Record<string, unknown>;
    expect(cfg).toMatchObject({
      enabled: true,
      auth_type: 'basic_auth',
      username: 'u',
      password: '***',
      timeout: 30,
      verify_ssl: true,
      sync_enabled: true,
      sync_method: 'POST',
      lookup_number_format: 'digits',
      lookup_ttl_hours: 24,
    });
    expect(cfg.call_outcomes).toEqual([
      'ANSWERED', 'UNANSWERED', 'BUSY', 'MISSED', 'VOICEMAIL', 'UNREACHABLE', 'FAILURE', 'NETWORK_ERROR', 'ABANDONED', 'DROPPED',
    ]);
    expect((cfg.field_catalog as string[]).length).toBe(17);
  });

  test('POST /api/crm/config: SSRF-unsafe URL is a 400 before anything is saved', async () => {
    await expect(ctl.saveCrmConfig(req({ body: { enabled: true, server_url: 'http://127.0.0.1:3306' } }))).rejects.toMatchObject({
      status: 400,
      message: 'Invalid CRM server URL: CRM URL host resolves to a blocked address (127.0.0.1)',
    });
    expect(dbm.setSetting).not.toHaveBeenCalled();
  });

  test('POST /api/crm/config saves, keeps masked secrets, warns, and reloads live', async () => {
    settings.CRM_API_KEY = 'stored';
    const res = await ctl.saveCrmConfig(
      req({
        body: {
          enabled: false,
          server_url: 'https://crm.example.com',
          auth_type: 'api_key',
          api_key: '***',
          sync_fields: ['queue'],
          sync_status_map: { no_answer: 'X', BOGUS: 'Y' },
          sync_key_map: { agentExt: 'agentId', nope: 'x' },
        },
      }),
    );
    expect(res).toEqual({
      success: true,
      reload_ok: true,
      warnings: [
        'Neither Caller nor Destination is selected — the CRM will receive calls it cannot identify.',
        'Ignored key rename(s) for unknown outbound key(s): nope',
        'Outcome remap source(s) not produced by OpDesk (will never match): BOGUS',
      ],
      message: 'CRM configuration saved and applied.',
    });
    expect(settings.CRM_API_KEY).toBe('stored');
    expect(settings.CRM_SYNC_FIELDS).toBe('queue');
    expect(settings.CRM_SYNC_STATUS_MAP).toBe('{"BOGUS": "Y", "UNANSWERED": "X"}');
    expect(settings.CRM_SYNC_KEY_MAP).toBe('{"agentExt": "agentId"}');
  });

  test('POST /api/crm/config: a bad lookup_url is a 400 after the earlier settings were saved (PY-quirk)', async () => {
    await expect(ctl.saveCrmConfig(req({ body: { enabled: false, lookup_url: 'https://evil/' } }))).rejects.toMatchObject({
      status: 400,
      message: "lookup_url must be a path starting with '/' (it is appended to the CRM server URL)",
    });
    expect(settings.CRM_ENABLED).toBe('false');
  });

  test('POST /api/crm/test is enveloped; a blocked URL is a 400', async () => {
    fakeFetch(() => ({ status: 204 }));
    const res = await ctl.testCrmConnection(req({ body: { server_url: 'https://crm.example.com', auth_type: 'bearer_token', bearer_token: 't' } }));
    expect(res).toEqual({ data: { success: true, status_code: 204, message: 'Connection test successful', method: 'HEAD' } });
    await expect(ctl.testCrmConnection(req({ body: { server_url: 'http://169.254.169.254' } }))).rejects.toBeInstanceOf(HttpError);
    await expect(ctl.testCrmConnection(req({ body: {} }))).rejects.toMatchObject({ message: 'CRM server URL is required' });
    expect(AppError).toBeDefined();
  });

  test('GET /api/crm/contact: no resolver -> enabled false; resolver -> name', async () => {
    expect(await ctl.getCrmContact(req({ query: { phone: ' 0100 ' } }))).toEqual({ phone: '0100', name: null, enabled: false });
    const r = new ContactResolver();
    r.setContacts([['01001234567', 'Alice']]);
    runtimeMock.contactResolver = r;
    expect(await ctl.getCrmContact(req({ query: { phone: '01001234567' } }))).toEqual({ phone: '01001234567', name: 'Alice', enabled: true });
  });

  test('POST /api/crm/lookup-test validates before any request', async () => {
    await expect(ctl.testCrmLookup(req({ body: {} }))).rejects.toMatchObject({ status: 400, message: 'phone is required' });
    await expect(ctl.testCrmLookup(req({ body: { phone: '1', lookup_url: 'x' } }))).rejects.toMatchObject({ status: 400 });
    await expect(ctl.testCrmLookup(req({ body: { phone: '1', lookup_url: '/x' } }))).rejects.toMatchObject({
      message: 'lookup_name_template is required',
    });
  });

  test('contacts: bare responses, the Python error texts, resolver reload', async () => {
    const resolver = new ContactResolver();
    runtimeMock.contactResolver = resolver;
    expect(await ctl.listContacts()).toEqual({ contacts: [{ id: 1, name: 'Alice', phone: '+20 100 123 4567' }] });
    expect(await ctl.createContact(req({ body: { name: ' Bob ', phone: '+1 (555) 1' } }))).toEqual({ id: 5 });
    expect(dbm.createContact).toHaveBeenCalledWith('Bob', '+1 (555) 1', '15551', null, null);
    expect(dbm.getContactsForResolver).toHaveBeenCalled();
    await expect(ctl.createContact(req({ body: { name: 'x', phone: 'abc' } }))).rejects.toMatchObject({
      status: 400,
      message: 'Phone must contain digits',
    });
    mocked(dbm.createContact).mockResolvedValueOnce(null);
    await expect(ctl.createContact(req({ body: { name: 'x', phone: '1' } }))).rejects.toMatchObject({
      status: 400,
      message: 'A contact with this phone number already exists',
    });
    expect(await ctl.updateContact(req({ params: { contact_id: '3' }, body: { name: 'x', phone: '1' } }))).toEqual({ status: 'ok' });
    mocked(dbm.updateContact).mockResolvedValueOnce(false);
    await expect(ctl.updateContact(req({ params: { contact_id: '3' }, body: { name: 'x', phone: '1' } }))).rejects.toMatchObject({
      status: 404,
      message: 'Contact not found',
    });
    expect(await ctl.deleteContact(req({ params: { contact_id: '3' } }))).toEqual({ status: 'ok' });
  });
});
