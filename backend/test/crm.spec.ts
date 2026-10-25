/**
 * integrations/crm + crm-lookup + crm-delivery and the CRM / contacts routes: payload assembly
 * (field selection, duration units, status remap, key renames), the SSRF guard (paths, token
 * URL, send-time re-check, redirects), the retry policy, the delivery queue and its worker,
 * the "after wrap-up" trigger, the lookup helpers, the connector over a mocked fetch, the
 * contact resolver, and the route contract (bare vs {data}, error texts, the atomic save,
 * the contacts API with its scopes).
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
  agentState: null as unknown,
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
    setSettings: jest.fn(async (values: Record<string, string | null>) => {
      for (const [k, v] of Object.entries(values)) settings[k] = v ?? '';
      return true;
    }),
    insertWebhookDelivery: jest.fn(async () => 1),
    enqueueWebhookDelivery: jest.fn(async () => ({ id: 41, delivery_uuid: 'uuid-41' })),
    markWebhookDeliveryAttempt: jest.fn(async () => true),
    claimWebhookDeliveries: jest.fn(async () => []),
    contactsPage: jest.fn(async () => ({ items: [], next_cursor: null })),
    getContact: jest.fn(async () => null),
    contactUpsert: jest.fn(async () => ({ id: 8, action: 'created', error: null })),
    addCrmContactIfNew: jest.fn(async () => true),
    getContactsForResolver: jest.fn(async () => [['201001234567', 'Alice']]),
    listContacts: jest.fn(async () => [{ id: 1, name: 'Alice', phone: '+20 100 123 4567' }]),
    createContact: jest.fn(async () => 5),
    updateContact: jest.fn(async () => true),
    deleteContact: jest.fn(async () => true),
  }));
jest.mock('../src/core/runtime', () => ({ runtime: runtimeMock }));
jest.mock('../src/services/call-log', () => ({ crmIdentityFromCdr: jest.fn(async () => ({})) }));
jest.mock('../src/core/security', () => ({ principalOf: (req: { principal?: unknown }) => req.principal ?? null }));

import * as dbm from '../src/db/db-manager';
import {
  AuthType,
  buildCrmPayload,
  CRMConnector,
  CRMLookupConfig,
  CRMSyncConfig,
  createCrmConnector,
  crmUnavailableReason,
  CrmValueError,
  defaultOutboundKeys,
  extractJsonPath,
  formatLookupNumber,
  initCrmConnector,
  isRetryableFailure,
  loadCrmSyncConfig,
  lookupCacheKey,
  MAX_RETRY_DELAY,
  migrateCrmSyncFields,
  modernizeStatusMap,
  parseKeyMap,
  parseRetryAfter,
  parseRetryDelays,
  parseStatusMap,
  parseSyncFields,
  redactUrl,
  renderLookupUrl,
  renderNameTemplate,
  retryDelayFor,
  setCrmFetch,
  setCrmResolver,
  validateCrmPath,
  validateCrmUrl,
} from '../src/integrations/crm';
import { ContactResolver, runLookupTest } from '../src/integrations/crm-lookup';
import {
  attemptDelivery,
  flushWrapups,
  parkedCalls,
  parkForWrapup,
  sendCrmDataAsync,
  sweepCrmDeliveries,
  WRAPUP_SETTLE_SECONDS,
} from '../src/integrations/crm-delivery';
import { CrmController } from '../src/api/routes/crm.controller';
import { HttpError } from '../src/api/http-error';
import { AppError } from '../src/api/errors';
import { AUTH_POLICY } from '../src/api/routing';

const mocked = (fn: unknown) => fn as jest.Mock;

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

/** A fetch that records each request and answers from `reply`. */
function fakeFetch(reply: (c: Call) => { status?: number; body?: string; headers?: Record<string, string> } | Error) {
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
    const status = r.status ?? 200;
    const nullBody = init.method === 'HEAD' || [204, 304].includes(status);
    return new Response(nullBody ? null : (r.body ?? ''), { status, headers: r.headers });
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
  runtimeMock.agentState = null;
  parkedCalls.clear();
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

  test('a path appended to the server URL must stay a path', () => {
    // 'https://crm.example.com' + '@169.254.169.254/x' parses with the metadata IP as host.
    expect(new URL('https://crm.example.com' + '@169.254.169.254/x').hostname).toBe('169.254.169.254');
    for (const bad of ['@169.254.169.254/x', '/a@169.254.169.254', 'api/calls', 'http://evil/x', '/x?u=http://evil', '/a b', '/a\\b']) {
      expect(() => validateCrmPath(bad, 'endpoint_path')).toThrow(CrmValueError);
    }
    expect(() => validateCrmPath('@x', 'sync_endpoint')).toThrow(/^sync_endpoint must be a path/);
    for (const ok of ['', '  ', '/api/calls', '/c?phone=[Number]&x=1', '//crm-path']) {
      expect(() => validateCrmPath(ok, 'endpoint_path')).not.toThrow();
    }
  });

  test('the connector refuses a path that moves the request off the CRM server', async () => {
    const calls = fakeFetch(() => ({ status: 200 }));
    const crm = new CRMConnector('https://crm.example.com', AuthType.API_KEY, { apiKey: 'k', endpointPath: '@169.254.169.254/x' });
    await expect(crm.sendCallData({}, { requireFields: false })).rejects.toThrow('CRM endpoint path must stay on the CRM server');
    await expect(crm.getJson('@127.0.0.1/c')).rejects.toThrow(CrmValueError);
    expect(calls).toHaveLength(0);
    expect(crm.targetUrl('/ok')).toBe('https://crm.example.com/ok');
  });

  test('the resolved address is checked again at send time, not only at save', async () => {
    const calls = fakeFetch(() => ({ status: 200 }));
    const crm = createCrmConnector({ server_url: 'https://crm.example.com', auth_type: 'api_key', api_key: 'k' });
    setCrmResolver(async () => ['93.184.216.34']);
    expect((await crm.sendCallData({}, { requireFields: false })).success).toBe(true);
    // The DNS answer changed after the settings were saved (rebinding).
    setCrmResolver(async () => ['127.0.0.1']);
    await expect(crm.sendCallData({}, { requireFields: false })).rejects.toThrow('blocked address (127.0.0.1)');
    await expect(crm.getJson('/c')).rejects.toThrow('blocked address (127.0.0.1)');
    expect(calls).toHaveLength(1);
    // block_private reaches the send-time check too.
    setCrmResolver(async () => ['10.0.0.5']);
    const strict = createCrmConnector({ server_url: 'https://crm.example.com', auth_type: 'api_key', api_key: 'k', block_private: true });
    await expect(strict.sendCallData({}, { requireFields: false })).rejects.toThrow('(10.0.0.5)');
  });

  test('the OAuth2 token URL is vetted before the token request', async () => {
    const calls = fakeFetch(() => ({ body: '{"access_token": "abc"}' }));
    const crm = createCrmConnector({
      server_url: 'https://crm.example.com',
      auth_type: 'oauth2',
      oauth2_client_id: 'id',
      oauth2_client_secret: 'sec',
      oauth2_token_url: 'http://169.254.169.254/token',
    });
    await expect(crm.sendCallData({}, { requireFields: false })).rejects.toThrow('(169.254.169.254)');
    expect(calls).toHaveLength(0);
  });

  test('the connection test does not follow a redirect into a blocked range', async () => {
    const calls = fakeFetch((c) =>
      c.url.startsWith('https://crm.example.com') ? { status: 302, headers: { Location: 'http://169.254.169.254/latest/meta-data' } } : { status: 200 },
    );
    const crm = new CRMConnector('https://crm.example.com', AuthType.API_KEY, { apiKey: 'k' });
    expect(await crm.testConnection('/sync')).toEqual({
      success: false,
      status_code: null,
      message: 'Connection test failed: CRM URL host resolves to a blocked address (169.254.169.254)',
      method: 'HEAD',
    });
    expect(calls.map((c) => c.url)).toEqual(['https://crm.example.com/sync']);
  });

  test('a redirect to an allowed host is vetted and followed; a loop is cut off', async () => {
    const calls = fakeFetch((c) => (c.url.startsWith('https://crm.example.com') ? { status: 301, headers: { Location: 'https://crm2.example.com/x' } } : { status: 204 }));
    const crm = new CRMConnector('https://crm.example.com', AuthType.API_KEY, { apiKey: 'k' });
    expect(await crm.testConnection('/sync')).toMatchObject({ success: true, status_code: 204, method: 'HEAD' });
    expect(calls.map((c) => c.url)).toEqual(['https://crm.example.com/sync', 'https://crm2.example.com/x']);
    const loop = fakeFetch(() => ({ status: 302, headers: { Location: '/again' } }));
    expect(await crm.testConnection('/sync')).toMatchObject({ success: false, method: 'POST' });
    // HEAD: the first request plus MAX_REDIRECTS hops; the POST fallback never follows.
    expect(loop.filter((c) => c.method === 'HEAD')).toHaveLength(6);
    expect(loop.filter((c) => c.method === 'POST')).toHaveLength(1);
  });

  test('a push is never redirected', async () => {
    const calls = fakeFetch(() => ({ status: 307, headers: { Location: 'http://169.254.169.254/' } }));
    const crm = new CRMConnector('https://crm.example.com', AuthType.API_KEY, { apiKey: 'k' });
    expect(await crm.sendCallData({}, { requireFields: false })).toMatchObject({ success: false, status_code: 307 });
    expect(calls).toHaveLength(1);
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
    expect(await crm.sendCallData({}, { requireFields: false })).toEqual({
      success: false,
      status_code: 500,
      error: 'boom',
      data: null,
      retry_after: null,
    });
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

  test('testConnection: when HEAD cannot be sent, the POST fallback really posts and reports its own error', async () => {
    const calls = fakeFetch((c) =>
      c.method === 'HEAD' ? Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }) : { status: 500, body: 'boom' },
    );
    const crm = new CRMConnector('https://crm', AuthType.API_KEY, { apiKey: 'k' });
    const res = await crm.testConnection(null);
    expect(res).toMatchObject({ success: false, status_code: 500, message: 'Connection test failed', method: 'POST' });
    expect(res.details).toMatchObject({ error: 'boom' });
    expect(JSON.parse(String(calls[1].body))).toMatchObject({ test: true });
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

describe('sendCrmDataAsync (the delivery queue)', () => {
  test('queues before the first attempt, sends the idempotency key, records the outcome', async () => {
    const calls = fakeFetch(() => ({ status: 200, body: '{"ok": true}' }));
    const crm = new CRMConnector('https://user:pw@crm.example.com', AuthType.API_KEY, { apiKey: 'k', endpointPath: '/calls' });
    const r = await sendCrmDataAsync(crm, { callId: 'L1', status: 'ANSWERED' }, {
      method: 'PUT',
      endpointPath: '/sync?key=secret',
      meta: { call_id: 'L1', caller: '100', destination: '200', call_status: 'ANSWERED', attempt: 2, parent_id: 4, resent_by: 1 },
      syncCfg: new CRMSyncConfig({ retryMaxAttempts: 3 }),
    });
    expect(r.success).toBe(true);
    expect(mocked(dbm.enqueueWebhookDelivery).mock.calls[0][0]).toMatchObject({
      callId: 'L1',
      caller: '100',
      destination: '200',
      callStatus: 'ANSWERED',
      method: 'PUT',
      url: 'https://crm.example.com/sync',
      requestBody: '{"callId": "L1", "status": "ANSWERED"}',
      attempt: 2,
      parentId: 4,
      resentBy: 1,
      endpointPath: '/sync?key=secret',
      triggerKind: 'hangup',
      maxAttempts: 3,
    });
    expect(calls[0].headers['Idempotency-Key']).toBe('uuid-41');
    expect(calls[0].headers['X-OpDesk-Delivery-Id']).toBe('uuid-41');
    expect(mocked(dbm.markWebhookDeliveryAttempt).mock.calls[0]).toEqual([
      41,
      expect.objectContaining({ delivered: true, statusCode: 200, responseBody: '{"ok": true}', countAttempt: true, retryIn: null }),
    ]);
    expect(dbm.insertWebhookDelivery).not.toHaveBeenCalled();
  });

  test('a 503 with Retry-After waits what the CRM asked when that is longer than the ladder', async () => {
    fakeFetch(() => ({ status: 503, body: 'busy', headers: { 'Retry-After': '900' } }));
    const crm = new CRMConnector('https://crm', AuthType.API_KEY, { apiKey: 'k' });
    await sendCrmDataAsync(crm, { caller: '1' }, { syncCfg: new CRMSyncConfig() });
    expect(mocked(dbm.markWebhookDeliveryAttempt).mock.calls[0][1]).toMatchObject({
      delivered: false,
      statusCode: 503,
      retryIn: 900,
      retryable: true,
    });
  });

  test('a 4xx rejection is failed at once; a transient failure past its budget is abandoned', async () => {
    fakeFetch(() => ({ status: 422, body: 'bad field' }));
    const crm = new CRMConnector('https://crm', AuthType.API_KEY, { apiKey: 'k' });
    await sendCrmDataAsync(crm, { caller: '1' }, { syncCfg: new CRMSyncConfig() });
    expect(mocked(dbm.markWebhookDeliveryAttempt).mock.calls[0][1]).toMatchObject({ retryIn: null, retryable: false, error: 'bad field' });
    fakeFetch(() => ({ status: 502 }));
    await attemptDelivery(crm, { caller: '1' }, {
      method: 'POST',
      endpointPath: null,
      syncCfg: new CRMSyncConfig({ retryMaxAttempts: 3 }),
      delivery: { id: 5, delivery_uuid: 'u5' },
      attemptsMade: 3,
    });
    expect(mocked(dbm.markWebhookDeliveryAttempt).mock.calls[1]).toEqual([
      5,
      expect.objectContaining({ retryIn: null, retryable: true, countAttempt: false }),
    ]);
  });

  test('retries off: one attempt, recorded with a budget of one', async () => {
    fakeFetch(() => ({ status: 500 }));
    const crm = new CRMConnector('https://crm', AuthType.API_KEY, { apiKey: 'k' });
    await sendCrmDataAsync(crm, { caller: '1' }, { syncCfg: new CRMSyncConfig({ retryEnabled: false, retryMaxAttempts: 9 }) });
    expect(mocked(dbm.enqueueWebhookDelivery).mock.calls[0][0]).toMatchObject({ maxAttempts: 1 });
    expect(mocked(dbm.markWebhookDeliveryAttempt).mock.calls[0][1]).toMatchObject({ retryIn: null });
  });

  test('queue unavailable: the push still goes out and is logged untracked', async () => {
    mocked(dbm.enqueueWebhookDelivery).mockResolvedValueOnce(null);
    const calls = fakeFetch(() => ({ status: 200 }));
    const crm = new CRMConnector('https://crm', AuthType.API_KEY, { apiKey: 'k' });
    expect((await sendCrmDataAsync(crm, { caller: '1' })).success).toBe(true);
    expect(calls[0].headers['Idempotency-Key']).toBeUndefined();
    expect(dbm.markWebhookDeliveryAttempt).not.toHaveBeenCalled();
    expect(mocked(dbm.insertWebhookDelivery).mock.calls[0][0]).toMatchObject({ success: true, statusCode: 200 });
  });

  test('no connector is recorded as a failure, not skipped', async () => {
    const r = await sendCrmDataAsync(null, { caller: '1' });
    expect(r).toEqual({ success: false, status_code: null, data: null, error: 'CRM connector not configured' });
    expect(mocked(dbm.insertWebhookDelivery).mock.calls[0][0]).toMatchObject({ success: false, url: '', attempt: 1 });
    expect(dbm.enqueueWebhookDelivery).not.toHaveBeenCalled();
  });

  test('an enabled CRM without credentials says why its pushes fail', async () => {
    Object.assign(settings, { CRM_ENABLED: 'true', CRM_SERVER_URL: 'https://crm.example.com', CRM_AUTH_TYPE: 'api_key' });
    expect(await initCrmConnector()).toBeNull();
    expect(crmUnavailableReason()).toBe('CRM API key is not set');
    await sendCrmDataAsync(null, { caller: '1' });
    expect(mocked(dbm.insertWebhookDelivery).mock.calls[0][0]).toMatchObject({ success: false, error: 'CRM API key is not set' });
    settings.CRM_ENABLED = 'false';
    expect(await initCrmConnector()).toBeNull();
    expect(crmUnavailableReason()).toBeNull();
  });

  test('a target refused by the SSRF guard at send time is failed, not retried', async () => {
    const calls = fakeFetch(() => ({ status: 200 }));
    setCrmResolver(async () => ['169.254.169.254']);
    const crm = new CRMConnector('https://crm.example.com', AuthType.API_KEY, { apiKey: 'k' });
    const r = await sendCrmDataAsync(crm, { caller: '1' }, { syncCfg: new CRMSyncConfig() });
    expect(r.error).toBe('ValueError: CRM URL host resolves to a blocked address (169.254.169.254)');
    expect(calls).toHaveLength(0);
    expect(mocked(dbm.markWebhookDeliveryAttempt).mock.calls[0][1]).toMatchObject({ retryable: false, retryIn: null });
  });
});

describe('retry worker', () => {
  const row = {
    id: 12,
    delivery_uuid: 'uuid-12',
    method: 'PUT',
    endpoint_path: '/sync',
    request_body: '{"caller": "100"}',
    attempts: 2,
    caller: '100',
    destination: '200',
  };

  test('claims nothing while there is no connector (the budget is kept)', async () => {
    expect(await sweepCrmDeliveries()).toBe(0);
    expect(dbm.claimWebhookDeliveries).not.toHaveBeenCalled();
  });

  test('re-sends a claimed row with its stored body and the same idempotency key', async () => {
    const calls = fakeFetch(() => ({ status: 200 }));
    runtimeMock.crmConnector = new CRMConnector('https://crm', AuthType.API_KEY, { apiKey: 'k' });
    mocked(dbm.claimWebhookDeliveries).mockResolvedValueOnce([{ ...row }, { ...row, id: 13, request_body: '[1]' }]);
    expect(await sweepCrmDeliveries()).toBe(2);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url: 'https://crm/sync', method: 'PUT', body: '{"caller":"100"}' });
    expect(calls[0].headers['Idempotency-Key']).toBe('uuid-12');
    const marks = mocked(dbm.markWebhookDeliveryAttempt).mock.calls;
    expect(marks).toContainEqual([12, expect.objectContaining({ delivered: true, countAttempt: false })]);
    expect(marks).toContainEqual([13, expect.objectContaining({ delivered: false, retryable: false })]);
  });

  test('a still-failing row moves down the ladder by its attempt count', async () => {
    fakeFetch(() => ({ status: 500 }));
    runtimeMock.crmConnector = new CRMConnector('https://crm', AuthType.API_KEY, { apiKey: 'k' });
    settings.CRM_SYNC_RETRY_DELAYS = '10,20,40';
    mocked(dbm.claimWebhookDeliveries).mockResolvedValueOnce([{ ...row }]);
    await sweepCrmDeliveries();
    expect(mocked(dbm.markWebhookDeliveryAttempt).mock.calls[0][1]).toMatchObject({ retryIn: 20 });
  });
});

describe('"after wrap-up" trigger', () => {
  const fields = {
    caller: '01001234567',
    destination: '201',
    call_status: 'ANSWERED',
    call_type: 'inbound',
    call_id: 'L9',
    uniqueid: 'U9',
    agent: '201',
  };
  const meta = { call_id: 'L9', uniqueid: 'U9', caller: '01001234567', destination: '201' };

  beforeEach(() => {
    Object.assign(settings, { CRM_SYNC_TRIGGER: 'wrapup', CRM_SYNC_WRAPUP_TIMEOUT: '600', CRM_SYNC_FIELDS: 'caller,call_status' });
    runtimeMock.crmConnector = new CRMConnector('https://crm', AuthType.API_KEY, { apiKey: 'k' });
  });

  test('waits while the agent is in wrap-up, then pushes once wrap-up is over', async () => {
    const calls = fakeFetch(() => ({ status: 200 }));
    let state = 'wrap_up';
    runtimeMock.agentState = { stateOf: (ext: string) => (ext === '201' ? state : 'logged_out') };
    parkForWrapup(fields, meta);
    parkedCalls.get('L9:U9')!.parkedAt -= WRAPUP_SETTLE_SECONDS + 1;
    expect(await flushWrapups()).toBe(0);
    state = 'ready';
    expect(await flushWrapups()).toBe(1);
    expect(parkedCalls.size).toBe(0);
    expect(JSON.parse(String(calls[0].body))).toEqual({ caller: '01001234567', status: 'ANSWERED' });
    expect(mocked(dbm.enqueueWebhookDelivery).mock.calls[0][0]).toMatchObject({ triggerKind: 'wrapup', callId: 'L9' });
  });

  test('an unanswered call goes at once; an answered one goes after the fallback window', async () => {
    fakeFetch(() => ({ status: 200 }));
    runtimeMock.agentState = { stateOf: () => 'wrap_up' };
    parkForWrapup({ ...fields, call_status: 'BUSY', uniqueid: 'U1' }, { ...meta, uniqueid: 'U1' });
    parkForWrapup(fields, meta);
    expect(await flushWrapups()).toBe(1);
    expect([...parkedCalls.keys()]).toEqual(['L9:U9']);
    parkedCalls.get('L9:U9')!.parkedAt -= 601;
    expect(await flushWrapups()).toBe(1);
  });

  test('switching back to the hangup trigger releases parked calls', async () => {
    fakeFetch(() => ({ status: 200 }));
    runtimeMock.agentState = { stateOf: () => 'wrap_up' };
    parkForWrapup(fields, meta);
    settings.CRM_SYNC_TRIGGER = 'hangup';
    expect(await flushWrapups()).toBe(1);
  });
});

describe('retry policy', () => {
  test('which failures are worth another attempt', () => {
    expect(isRetryableFailure(null)).toBe(true);
    expect([500, 502, 503, 408, 429].every((c) => isRetryableFailure(c))).toBe(true);
    expect([400, 401, 403, 404, 422].some((c) => isRetryableFailure(c))).toBe(false);
  });

  test('Retry-After: seconds, an HTTP date, clamped, junk ignored', () => {
    expect(parseRetryAfter('120')).toBe(120);
    expect(parseRetryAfter(' 0 ')).toBe(0);
    expect(parseRetryAfter('99999999')).toBe(MAX_RETRY_DELAY);
    const inFiveMin = new Date(Date.now() + 300_000).toUTCString();
    expect(parseRetryAfter(inFiveMin)).toBeGreaterThanOrEqual(298);
    expect(parseRetryAfter('Wed, 21 Oct 2015 07:28:00 GMT')).toBe(0);
    expect(parseRetryAfter('soon')).toBeNull();
    expect(parseRetryAfter('2026')).toBe(2026);
    expect(parseRetryAfter(null)).toBeNull();
  });

  test('the backoff ladder: last value repeats, bad input falls back, Retry-After only lengthens', () => {
    expect(parseRetryDelays('10, x, -5, 20')).toEqual([10, 20]);
    expect(parseRetryDelays('')).toEqual([30, 120, 600, 1800]);
    expect(parseRetryDelays([5, '7'])).toEqual([5, 7]);
    expect(retryDelayFor(1, { delays: '10,20' })).toBe(10);
    expect(retryDelayFor(2, { delays: '10,20' })).toBe(20);
    expect(retryDelayFor(7, { delays: '10,20' })).toBe(20);
    expect(retryDelayFor(1, { delays: '10,20', retryAfter: 60 })).toBe(60);
    expect(retryDelayFor(1, { delays: '10,20', retryAfter: 0 })).toBe(10);
  });

  test('loadCrmSyncConfig reads the trigger and the retry policy; retries off means one attempt', async () => {
    Object.assign(settings, {
      CRM_SYNC_TRIGGER: 'WRAPUP',
      CRM_SYNC_WRAPUP_TIMEOUT: '2',
      CRM_SYNC_RETRY_MAX_ATTEMPTS: '99',
      CRM_SYNC_RETRY_DELAYS: '15,45',
    });
    let cfg = await loadCrmSyncConfig();
    expect(cfg).toMatchObject({ trigger: 'wrapup', wrapupTimeout: 5, retryEnabled: true, retryMaxAttempts: 20, retryDelays: [15, 45] });
    Object.assign(settings, { CRM_SYNC_TRIGGER: 'never', CRM_SYNC_RETRY_ENABLED: 'false' });
    cfg = await loadCrmSyncConfig();
    expect(cfg).toMatchObject({ trigger: 'hangup', retryEnabled: false, retryMaxAttempts: 1 });
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
  const AGENT = { id: 2, username: 'agent', role: 'agent', extension: '201' };
  const KEY = { id: null, username: 'apikey:sync', role: 'admin', extension: null, api_key: true, scopes: ['contacts:write'] };
  const req = (over: Record<string, unknown> = {}) => ({ params: {}, query: {}, body: {}, principal: ADMIN, ...over }) as never;
  const auditOf = (r: unknown) => (r as { auditDetail?: unknown }).auditDetail;

  test('GET /api/crm/config masks secrets and serves the catalog, the 10 call statuses and the retry policy', async () => {
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
      sync_trigger: 'hangup',
      sync_wrapup_timeout: 600,
      sync_retry_enabled: true,
      sync_retry_max_attempts: 5,
      sync_retry_delays: [30, 120, 600, 1800],
      lookup_number_format: 'digits',
      lookup_ttl_hours: 24,
      active: false,
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
    expect(dbm.setSettings).not.toHaveBeenCalled();
  });

  test.each([
    [{ endpoint_path: '@169.254.169.254/latest' }, 'endpoint_path must be a path'],
    [{ sync_endpoint: '@169.254.169.254/latest' }, 'sync_endpoint must be a path'],
    [{ sync_endpoint: 'https://evil.example/x' }, 'sync_endpoint must be a path'],
    [{ auth_type: 'oauth2', oauth2_token_url: 'http://169.254.169.254/token' }, 'Invalid OAuth2 token URL: CRM URL host resolves to a blocked address'],
    [{ lookup_url: '@127.0.0.1/c' }, "lookup_url must be a path starting with '/'"],
    [{ lookup_enabled: true, lookup_name_template: '' }, 'lookup_name_template is required when the contact lookup is enabled'],
    [{ lookup_match_digits: 40 }, 'lookup_match_digits must be an integer between 0 and 32'],
    [{ sync_trigger: 'never' }, 'sync_trigger must be one of: hangup, wrapup'],
    [{ timeout: 'soon' }, 'timeout must be an integer >= 1'],
    [{ auth_type: 'magic' }, 'auth_type must be one of'],
  ])('POST /api/crm/config %j is a 400 and writes nothing', async (body, message) => {
    settings.CRM_ENABLED = 'false';
    await expect(ctl.saveCrmConfig(req({ body: { enabled: false, server_url: 'https://crm.example.com', ...body } }))).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining(message),
    });
    expect(dbm.setSettings).not.toHaveBeenCalled();
    expect(dbm.setSetting).not.toHaveBeenCalled();
    expect(settings.CRM_ENABLED).toBe('false');
  });

  test('POST /api/crm/config saves in one write, keeps masked secrets, warns, reloads live, records the audit detail', async () => {
    settings.CRM_API_KEY = 'stored';
    const r = req({
      body: {
        enabled: false,
        server_url: 'https://crm.example.com',
        auth_type: 'api_key',
        api_key: '***',
        sync_fields: ['queue'],
        sync_status_map: { no_answer: 'X', BOGUS: 'Y' },
        sync_key_map: { agentExt: 'agentId', nope: 'x' },
        sync_trigger: 'wrapup',
        sync_wrapup_timeout: 90000,
        sync_retry_max_attempts: 7,
        sync_retry_delays: '5, x, 60',
      },
    });
    const res = await ctl.saveCrmConfig(r);
    expect(res).toEqual({
      success: true,
      reload_ok: true,
      active: false,
      warnings: [
        'Neither Caller nor Destination is selected — the CRM will receive calls it cannot identify.',
        'Ignored key rename(s) for unknown outbound key(s): nope',
        'Outcome remap source(s) not produced by OpDesk (will never match): BOGUS',
      ],
      message: 'CRM configuration saved and applied.',
    });
    expect(dbm.setSettings).toHaveBeenCalledTimes(1);
    expect(settings.CRM_API_KEY).toBe('stored');
    expect(settings.CRM_SYNC_FIELDS).toBe('queue');
    expect(settings.CRM_SYNC_STATUS_MAP).toBe('{"BOGUS": "Y", "UNANSWERED": "X"}');
    expect(settings.CRM_SYNC_KEY_MAP).toBe('{"agentExt": "agentId"}');
    expect(settings).toMatchObject({
      CRM_SYNC_TRIGGER: 'wrapup',
      CRM_SYNC_WRAPUP_TIMEOUT: '86400',
      CRM_SYNC_RETRY_MAX_ATTEMPTS: '7',
      CRM_SYNC_RETRY_DELAYS: '5,60',
    });
    expect(auditOf(r)).toMatchObject({ server_url: 'https://crm.example.com', api_key: '********', sync_trigger: 'wrapup' });
  });

  test('POST /api/crm/config: plain fields can be cleared; secrets cannot be cleared by a blank', async () => {
    Object.assign(settings, {
      CRM_API_KEY_HEADER: 'X-Old',
      CRM_OAUTH2_CLIENT_ID: 'id',
      CRM_OAUTH2_TOKEN_URL: 'https://crm.example.com/token',
      CRM_OAUTH2_SCOPE: 'calls',
      CRM_OAUTH2_CLIENT_SECRET: 'sec',
      CRM_USERNAME: 'u',
    });
    await ctl.saveCrmConfig(req({ body: { enabled: false, auth_type: 'api_key', api_key: '', api_key_header: '' } }));
    expect(settings.CRM_API_KEY_HEADER).toBe('');
    await ctl.saveCrmConfig(
      req({ body: { enabled: false, auth_type: 'oauth2', oauth2_client_id: '', oauth2_token_url: '', oauth2_scope: '', oauth2_client_secret: '' } }),
    );
    expect(settings).toMatchObject({ CRM_OAUTH2_CLIENT_ID: '', CRM_OAUTH2_TOKEN_URL: '', CRM_OAUTH2_SCOPE: '', CRM_OAUTH2_CLIENT_SECRET: 'sec' });
    await ctl.saveCrmConfig(req({ body: { enabled: false, auth_type: 'basic_auth', username: '' } }));
    expect(settings.CRM_USERNAME).toBe('');
  });

  test('POST /api/crm/config: enabling a CRM that cannot be built is a 400 naming what is missing', async () => {
    await expect(
      ctl.saveCrmConfig(req({ body: { enabled: true, server_url: 'https://crm.example.com', auth_type: 'bearer_token', bearer_token: '' } })),
    ).rejects.toMatchObject({ status: 400, message: 'Bearer token is required for BEARER_TOKEN authentication' });
    await expect(ctl.saveCrmConfig(req({ body: { enabled: true, server_url: '' } }))).rejects.toMatchObject({
      status: 400,
      message: 'CRM server URL is required',
    });
    expect(dbm.setSettings).not.toHaveBeenCalled();
  });

  test('POST /api/crm/config: saved but not live says so instead of "saved and applied"', async () => {
    // The stored username lets the pre-check build a connector; the save clears it.
    Object.assign(settings, { CRM_USERNAME: 'u', CRM_PASSWORD: 'p' });
    const res = await ctl.saveCrmConfig(
      req({ body: { enabled: true, server_url: 'https://crm.example.com', auth_type: 'basic_auth', username: '', password: '***' } }),
    );
    expect(res).toMatchObject({
      success: true,
      active: false,
      message: 'CRM configuration saved, but the CRM is not active.',
      warnings: ['CRM is enabled but not active: CRM username or password is not set.'],
    });
    settings.CRM_USERNAME = 'u';
    const ok = await ctl.saveCrmConfig(req({ body: { enabled: true, server_url: 'https://crm.example.com', auth_type: 'basic_auth', password: '***' } }));
    expect(ok).toMatchObject({ active: true, message: 'CRM configuration saved and applied.', warnings: [] });
    expect(runtimeMock.crmConnector).toBeInstanceOf(CRMConnector);
  });

  test('a DB failure saving the config is a 500 with nothing applied', async () => {
    mocked(dbm.setSettings).mockResolvedValueOnce(false);
    await expect(ctl.saveCrmConfig(req({ body: { enabled: false } }))).rejects.toMatchObject({
      status: 500,
      message: 'Failed to save CRM configuration: see server logs',
    });
  });

  test('POST /api/crm/test is enveloped; a blocked URL or path is a 400', async () => {
    fakeFetch(() => ({ status: 204 }));
    const res = await ctl.testCrmConnection(req({ body: { server_url: 'https://crm.example.com', auth_type: 'bearer_token', bearer_token: 't' } }));
    expect(res).toEqual({ data: { success: true, status_code: 204, message: 'Connection test successful', method: 'HEAD' } });
    await expect(ctl.testCrmConnection(req({ body: { server_url: 'http://169.254.169.254' } }))).rejects.toBeInstanceOf(HttpError);
    await expect(ctl.testCrmConnection(req({ body: {} }))).rejects.toMatchObject({ message: 'CRM server URL is required' });
    await expect(
      ctl.testCrmConnection(
        req({ body: { server_url: 'https://crm.example.com', auth_type: 'bearer_token', bearer_token: 't', sync_endpoint: '@169.254.169.254/' } }),
      ),
    ).rejects.toMatchObject({ status: 400, message: expect.stringContaining('sync_endpoint must be a path') });
    await expect(
      ctl.testCrmConnection(
        req({
          body: {
            server_url: 'https://crm.example.com',
            auth_type: 'oauth2',
            oauth2_client_id: 'i',
            oauth2_client_secret: 's',
            oauth2_token_url: 'http://127.0.0.1/token',
          },
        }),
      ),
    ).rejects.toMatchObject({ status: 400, message: expect.stringContaining('Invalid OAuth2 token URL') });
    expect(AppError).toBeDefined();
  });

  test('GET /api/crm/contact: `enabled` is whether a live lookup can run', async () => {
    expect(await ctl.getCrmContact(req({ query: { phone: ' 0100 ' } }))).toEqual({ phone: '0100', name: null, enabled: false });
    const r = new ContactResolver();
    r.setContacts([['01001234567', 'Alice']]);
    runtimeMock.contactResolver = r;
    // A phonebook hit, but no lookup config: names resolve, the CRM lookup is off.
    expect(await ctl.getCrmContact(req({ query: { phone: '01001234567' } }))).toEqual({ phone: '01001234567', name: 'Alice', enabled: false });
    r.setConfig(
      new CRMLookupConfig({ enabled: true, urlTemplate: '/c', nameTemplate: '[0.name]' }),
      new CRMConnector('https://crm', AuthType.API_KEY, { apiKey: 'k' }),
    );
    expect(await ctl.getCrmContact(req({ query: { phone: '01001234567' } }))).toMatchObject({ enabled: true });
  });

  test('POST /api/crm/lookup-test validates before any request', async () => {
    await expect(ctl.testCrmLookup(req({ body: {} }))).rejects.toMatchObject({ status: 400, message: 'phone is required' });
    await expect(ctl.testCrmLookup(req({ body: { phone: '1', lookup_url: 'x' } }))).rejects.toMatchObject({ status: 400 });
    await expect(ctl.testCrmLookup(req({ body: { phone: '1', lookup_url: '@127.0.0.1/c' } }))).rejects.toMatchObject({ status: 400 });
    await expect(ctl.testCrmLookup(req({ body: { phone: '1', lookup_url: '/x' } }))).rejects.toMatchObject({
      message: 'lookup_name_template is required',
    });
  });

  test('contacts (admin UI): bare responses, the Python error texts, resolver reload', async () => {
    const resolver = new ContactResolver();
    runtimeMock.contactResolver = resolver;
    expect(await ctl.createContact(req({ body: { name: ' Bob ', phone: '+1 (555) 1' } }))).toEqual({ id: 5, action: 'created', reason: null });
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
    mocked(dbm.getContact).mockResolvedValueOnce({ id: 3, name: 'Bob', phone: '1', source: 'manual' });
    const del = req({ params: { contact_id: '3' } });
    expect(await ctl.deleteContact(del)).toEqual({ status: 'ok' });
    expect(auditOf(del)).toEqual({ name: 'Bob', phone: '1', source: 'manual' });
  });

  test('the phonebook key honours the configured match digits, so a prefix variant is the same contact', async () => {
    settings.CRM_LOOKUP_MATCH_DIGITS = '10';
    await ctl.createContact(req({ body: { name: 'Alice', phone: '+20 100 123 4567' } }));
    await ctl.updateContact(req({ params: { contact_id: '1' }, body: { name: 'Alice', phone: '0100 123 4567' } }));
    expect(mocked(dbm.createContact).mock.calls[0][2]).toBe('1001234567');
    expect(mocked(dbm.updateContact).mock.calls[0][3]).toBe('1001234567');
  });

  test('GET /api/contacts pages with search and maps rows to the API shape', async () => {
    mocked(dbm.contactsPage).mockResolvedValueOnce({
      items: [{ id: 1, name: 'Alice', phone: '0100', phone_key: '100', source: 'api', external_id: 'c-1', source_system: 'hub', secret_col: 'x' }],
      next_cursor: 'abc',
    });
    const res = await ctl.listContacts(req({ query: { search: 'ali', limit: '1', cursor: 'xyz' } }));
    expect(dbm.contactsPage).toHaveBeenCalledWith({ search: 'ali', limit: 1, cursor: 'xyz' });
    expect(res).toEqual({
      contacts: [
        {
          id: 1,
          name: 'Alice',
          phone: '0100',
          phone_key: '100',
          company: null,
          notes: null,
          source: 'api',
          external_id: 'c-1',
          source_system: 'hub',
          created_at: null,
          updated_at: null,
        },
      ],
      next_cursor: 'abc',
    });
    await expect(ctl.getContact(req({ params: { contact_id: '9' } }))).rejects.toMatchObject({ status: 404 });
    mocked(dbm.getContact).mockResolvedValueOnce({ id: 9, name: 'Z', phone: '1', phone_key: '1', source: 'manual' });
    expect(await ctl.getContact(req({ params: { contact_id: '9' } }))).toMatchObject({ id: 9, name: 'Z', source: 'manual' });
  });

  test('POST /api/contacts from an API key upserts as source api; a manual row is skipped, not failed', async () => {
    const r = req({ principal: KEY, body: { name: 'Bob', phone: '555 0100', external_id: 'c-9', source_system: 'hub' } });
    expect(await ctl.createContact(r)).toEqual({ id: 8, action: 'created', reason: null });
    expect(dbm.contactUpsert).toHaveBeenCalledWith('Bob', '555 0100', '5550100', {
      company: null,
      notes: null,
      source: 'api',
      externalId: 'c-9',
      sourceSystem: 'hub',
    });
    expect(dbm.createContact).not.toHaveBeenCalled();
    mocked(dbm.contactUpsert).mockResolvedValueOnce({ id: 3, action: 'skipped', error: "existing contact is source 'manual'" });
    expect(await ctl.createContact(req({ principal: KEY, body: { name: 'Bob', phone: '1' } }))).toEqual({
      id: 3,
      action: 'skipped',
      reason: "existing contact is source 'manual'",
    });
  });

  test('a signed-in non-admin cannot write contacts even though the scope route lets a JWT through', async () => {
    await expect(ctl.createContact(req({ principal: AGENT, body: { name: 'Bob', phone: '1' } }))).rejects.toMatchObject({ status: 403 });
    await expect(ctl.bulkContacts(req({ principal: AGENT, body: { contacts: [{ name: 'Bob', phone: '1' }] } }))).rejects.toMatchObject({
      status: 403,
    });
  });

  test('POST /api/contacts/bulk: per-item results and counts, the cap, the match-digit key', async () => {
    settings.CRM_LOOKUP_MATCH_DIGITS = '7';
    mocked(dbm.contactUpsert)
      .mockResolvedValueOnce({ id: 1, action: 'created', error: null })
      .mockResolvedValueOnce({ id: 2, action: 'skipped', error: "existing contact is source 'manual'" });
    const r = req({
      principal: KEY,
      body: {
        contacts: [
          { name: 'A', phone: '+20 100 555 1234' },
          { name: ' ', phone: '1' },
          { name: 'C', phone: 'none' },
          { name: 'D', phone: '0100 555 9999', external_id: 'd', source_system: 'hub' },
        ],
      },
    });
    expect(await ctl.bulkContacts(r)).toEqual({
      results: [
        { index: 0, id: 1, action: 'created', reason: null },
        { index: 1, id: null, action: 'skipped', reason: 'Name is required' },
        { index: 2, id: null, action: 'skipped', reason: 'Phone must contain digits' },
        { index: 3, id: 2, action: 'skipped', reason: "existing contact is source 'manual'" },
      ],
      counts: { created: 1, updated: 0, skipped: 3 },
    });
    expect(mocked(dbm.contactUpsert).mock.calls[0][2]).toBe('5551234');
    expect(mocked(dbm.contactUpsert).mock.calls[1][3]).toMatchObject({ source: 'api', externalId: 'd', sourceSystem: 'hub' });
    expect(auditOf(r)).toMatchObject({ counts: { created: 1, updated: 0, skipped: 3 } });
    await expect(ctl.bulkContacts(req({ body: { contacts: [] } }))).rejects.toMatchObject({ status: 400, message: 'No contacts supplied' });
    const tooMany = Array.from({ length: 501 }, (_, i) => ({ name: `N${i}`, phone: String(1000 + i) }));
    await expect(ctl.bulkContacts(req({ body: { contacts: tooMany } }))).rejects.toMatchObject({
      status: 400,
      message: 'Too many contacts in one request (max 500)',
    });
  });

  test('scopes: reads take contacts:read, pushes contacts:write, edit and delete stay admin', () => {
    const policy = (name: string) => Reflect.getMetadata(AUTH_POLICY, (CrmController.prototype as unknown as Record<string, object>)[name]);
    expect(policy('listContacts')).toEqual({ scope: 'contacts:read' });
    expect(policy('getContact')).toEqual({ scope: 'contacts:read' });
    expect(policy('createContact')).toEqual({ scope: 'contacts:write' });
    expect(policy('bulkContacts')).toEqual({ scope: 'contacts:write' });
    expect(policy('updateContact')).toBe('admin');
    expect(policy('deleteContact')).toBe('admin');
  });
});
