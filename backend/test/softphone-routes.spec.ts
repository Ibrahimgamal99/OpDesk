/**
 * Softphone routes: /api/webrtc/config URL building, /api/me/sip-password, the Medut setup
 * data, the WebRTC switch, and extension-config (own + API-key lookup).
 */

const settings: Record<string, string> = {};
const PROFILE: Record<string, string> = {
  username: '100', secret: 's3cret', media_encryption: 'dtls', icesupport: 'yes', avpf: 'yes', rtcp_mux: 'yes', allow: 'opus,ulaw', transport: '',
};

jest.mock(
  '../src/db/db-manager',
  () => ({
    getSetting: jest.fn(async (key: string, fallback: string | null = null) => (key in settings ? settings[key] : fallback)),
    getUserById: jest.fn(),
    getUserByUsername: jest.fn(),
    getUserByExtension: jest.fn(),
    verifyUserPassword: jest.fn(async (hash: string, pw: string) => hash === `hash:${pw}`),
    getUserWebrtcCredentials: jest.fn(),
    getExtensionSecretFromDb: jest.fn(async () => 's3cret'),
    getExtensionNamesFromDb: jest.fn(async () => ({ '100': 'PBX Ann' })),
    getExtensionMaxContacts: jest.fn(async () => 2),
    setExtensionSecretInPbx: jest.fn(async () => true),
    getExtensionSipProfile: jest.fn(),
    parseCodecList: (value: string | null | undefined) => [
      ...new Set((value || '').split(/[,&]/).map((c) => c.trim().toLowerCase()).filter(Boolean)),
    ],
    getPbxDefaultCodecs: jest.fn(async () => ['alaw', 'ulaw']),
    getExtensionsWithWebrtcFromUsers: jest.fn(async () => [
      { extension: '100', name: 'Ann', webrtc: 'yes' },
      { extension: '101', name: 'Bob', webrtc: 'no' },
    ]),
    setExtensionWebrtc: jest.fn(async () => true),
  }));
jest.mock('../src/core/security', () => ({ principalOf: (req: { principal?: unknown }) => req.principal ?? null }));
jest.mock('../src/services/dialplan', () => ({ reloadAsteriskSip: jest.fn(async () => true) }));
jest.mock('../src/services/sip-push', () => ({ publicHost: jest.fn(async () => '') }));
jest.mock('../src/api/respond', () => ({ respond: (data: unknown) => ({ data }) }));

import * as dbm from '../src/db/db-manager';
import { publicHost } from '../src/services/sip-push';
import { reloadAsteriskSip } from '../src/services/dialplan';
import { AUTH_POLICY } from '../src/api/routing';
import { DEFAULT_STUN_SERVERS, pjsipTransportType, SoftphoneController } from '../src/api/routes/softphone.controller';

const ctl = new SoftphoneController();
const mocked = (fn: unknown) => fn as jest.Mock;
const AGENT = { id: 7, username: 'ann', role: 'agent', extension: '100', allowed_agent_extensions: ['100'] };
const USER_ROW = { id: 7, username: 'ann', extension: '100', name: 'Ann', role: 'agent', is_active: 1, password_hash: 'hash:pw' };

function req(over: Record<string, unknown> = {}, headers: Record<string, string> = { host: '10.0.0.5' }) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { params: {}, query: {}, body: {}, principal: AGENT, header: (n: string) => lower[n.toLowerCase()], ...over } as never;
}

const ENV_KEYS = ['OPDESK_DOMAIN', 'NGINX_HTTPS_PORT', 'WEBRTC_PBX_SERVER'];
beforeEach(() => {
  jest.clearAllMocks();
  for (const k of Object.keys(settings)) delete settings[k];
  for (const k of ENV_KEYS) delete process.env[k];
  mocked(dbm.getUserById).mockResolvedValue({ ...USER_ROW });
  mocked(dbm.getUserByUsername).mockResolvedValue({ ...USER_ROW });
  mocked(dbm.getUserByExtension).mockResolvedValue({ ...USER_ROW });
  mocked(dbm.getExtensionSipProfile).mockResolvedValue({ ...PROFILE });
  mocked(publicHost).mockResolvedValue('');
});

describe('/api/webrtc/config', () => {
  test('host from the request, plus the Nginx port when the Host header has none', async () => {
    process.env.NGINX_HTTPS_PORT = '8443';
    mocked(dbm.getUserWebrtcCredentials).mockResolvedValue({ extension: '100' });
    expect(await ctl.webrtcConfig(req())).toEqual({ server: 'wss://10.0.0.5:8443/sip-ws', extension: '100', extension_secret: 's3cret' });
  });

  test('a bare IP becomes the configured domain; the legacy :8089 setting is ignored', async () => {
    process.env.OPDESK_DOMAIN = 'pbx.example.com';
    settings.WEBRTC_PBX_SERVER = 'wss://10.0.0.5:8089/ws';
    mocked(dbm.getUserWebrtcCredentials).mockResolvedValue(null);
    const r = req({}, { 'x-forwarded-host': '10.0.0.5:8443, proxy', host: 'ignored' });
    expect(await ctl.webrtcConfig(r)).toEqual({ server: 'wss://pbx.example.com:8443/sip-ws', extension: null, extension_secret: null });
  });

  test('a stored URL wins', async () => {
    settings.WEBRTC_PBX_SERVER = 'wss://sip.example.com/custom';
    mocked(dbm.getUserWebrtcCredentials).mockResolvedValue({ extension: null });
    expect((await ctl.webrtcConfig(req())).server).toBe('wss://sip.example.com/custom');
  });
});

describe('/api/me/sip-password', () => {
  const call = (body: unknown, principal: unknown = AGENT) => ctl.changeMySipPassword(req({ body, principal }));

  test('changes the secret and reloads SIP', async () => {
    expect(await call({ current_password: 'pw', new_password: 'abc12345' })).toEqual({
      data: { message: 'SIP password changed. Sign your phones in again.' },
    });
    expect(dbm.setExtensionSecretInPbx).toHaveBeenCalledWith('100', 'abc12345');
    expect(reloadAsteriskSip).toHaveBeenCalled();
  });

  test.each([
    [{ current_password: 'wrong', new_password: 'abc12345' }, AGENT, 'Current password is incorrect'],
    [{ current_password: 'pw', new_password: 'abc12345' }, { ...AGENT, extension: null }, 'You have no extension'],
    [{ current_password: 'pw', new_password: 'abcdefgh' }, AGENT, /^The SIP password needs/],
    [{ current_password: 'pw', new_password: 'abc 12345' }, AGENT, /^The SIP password needs/],
    [{ current_password: 'pw', new_password: 'a1' }, AGENT, /^The SIP password needs/],
  ])('%j -> 400', async (body, principal, message) => {
    const err = await call(body, principal).catch((e) => e);
    expect(err.status).toBe(400);
    expect(err.message).toMatch(message);
    expect(dbm.setExtensionSecretInPbx).not.toHaveBeenCalled();
  });
});

describe('mobile setup', () => {
  test('own: enveloped; a DTLS extension gets the full WebRTC account', async () => {
    mocked(publicHost).mockResolvedValue('pbx.example.com');
    process.env.OPDESK_DOMAIN = 'pbx.example.com';
    expect(await ctl.myMobileSetup(req())).toEqual({
      data: {
        extension: '100',
        display_name: 'Ann',
        password: 's3cret',
        host: 'pbx.example.com',
        verify_tls: true,
        account: {
          name: 'OpDesk 100',
          uri: '100@pbx.example.com',
          password: 's3cret',
          display_name: 'Ann',
          auth_user: '100',
          transport: 'wss',
          server_url: 'wss://pbx.example.com/sip-ws',
          media_enc: 'dtls_srtp',
          ice_enabled: true,
          stun_server: 'stun:stun.l.google.com:19302',
          verify_tls: true,
        },
      },
    });
  });

  test('no domain: WSS on the request host and port, self-signed so verify_tls false', async () => {
    process.env.NGINX_HTTPS_PORT = '8443';
    mocked(dbm.getUserById).mockResolvedValue({ ...USER_ROW, name: null });
    const out = (await ctl.userMobileSetup(req({ params: { user_id: '7' } }))) as { data: Record<string, unknown> };
    expect(out.data).toMatchObject({ host: '10.0.0.5', display_name: 'PBX Ann', verify_tls: false });
    expect(out.data.account).toMatchObject({
      uri: '100@10.0.0.5',
      display_name: 'PBX Ann',
      transport: 'wss',
      server_url: 'wss://10.0.0.5:8443/sip-ws',
      verify_tls: false,
    });
  });

  test('an SDES extension gets TLS on 5061 with SRTP, ICE off and no STUN', async () => {
    settings.OPDESK_DOMAIN = 'pbx.example.com';
    settings.SIP_TLS_ENABLED = 'true';
    mocked(dbm.getExtensionSipProfile).mockResolvedValue({ ...PROFILE, media_encryption: 'sdes', icesupport: 'no' });
    const out = (await ctl.myMobileSetup(req())) as { data: { account: Record<string, unknown> } };
    expect(out.data.account).toEqual({
      name: 'OpDesk 100',
      uri: '100@pbx.example.com:5061',
      password: 's3cret',
      display_name: 'Ann',
      auth_user: '100',
      transport: 'tls',
      media_enc: 'sdes',
      ice_enabled: false,
      verify_tls: true,
    });
  });

  test('a plain extension with no public SIP transport falls back to UDP, unencrypted', async () => {
    mocked(dbm.getExtensionSipProfile).mockResolvedValue({ ...PROFILE, media_encryption: 'no', icesupport: 'no' });
    const out = (await ctl.myMobileSetup(req())) as { data: { account: Record<string, unknown> } };
    expect(out.data.account).toMatchObject({ uri: '100@10.0.0.5', transport: 'udp', media_enc: 'none', ice_enabled: false });
    expect(out.data.account).not.toHaveProperty('server_url');
  });

  test('a configured TURN server and a separate auth user are carried', async () => {
    settings.WEBRTC_TURN_URL = 'turn:turn.example.com:3478';
    settings.WEBRTC_TURN_USER = 'medut';
    settings.WEBRTC_TURN_PASS = 'tp';
    mocked(dbm.getExtensionSipProfile).mockResolvedValue({ ...PROFILE, username: 'auth-100' });
    const out = (await ctl.myMobileSetup(req())) as { data: { account: Record<string, unknown> } };
    expect(out.data.account).toMatchObject({
      auth_user: 'auth-100',
      turn_server: 'turn:turn.example.com:3478',
      turn_user: 'medut',
      turn_pass: 'tp',
    });
    expect(out.data.account).not.toHaveProperty('stun_server'); // only TURN configured
  });

  test('404s', async () => {
    mocked(dbm.getUserById).mockResolvedValueOnce({ ...USER_ROW, extension: '' });
    await expect(ctl.myMobileSetup(req())).rejects.toMatchObject({ status: 404, message: 'This user has no extension' });
    mocked(dbm.getUserById).mockResolvedValueOnce(null);
    await expect(ctl.userMobileSetup(req({ params: { user_id: '3' } }))).rejects.toMatchObject({ status: 404, message: 'User not found' });
  });
});

describe('/api/extension-config', () => {
  test('a DTLS extension gets the WSS transport through /sip-ws', async () => {
    process.env.NGINX_HTTPS_PORT = '8443';
    const out = await ctl.extensionConfig(req());
    expect(out).toEqual({
      extension: '100',
      auth_username: '100',
      secret: 's3cret',
      display_name: 'Ann',
      domain: '10.0.0.5',
      transports: [{ type: 'wss', uri: 'wss://10.0.0.5:8443/sip-ws', host: '10.0.0.5', port: 8443, path: '/sip-ws' }],
      media: { encryption: 'dtls', ice: true, avpf: true, rtcp_mux: true, codecs: ['opus', 'ulaw'] },
      ice_servers: DEFAULT_STUN_SERVERS,
    });
  });

  test('domain from settings; transports=all lists TLS and (when public) TCP/UDP', async () => {
    settings.OPDESK_DOMAIN = 'pbx.example.com';
    settings.SIP_TLS_ENABLED = 'true';
    settings.SIP_UDP_TCP_PUBLIC = 'yes';
    const all = await ctl.extensionConfig(req({ query: { transports: 'all' } }));
    expect(all.domain).toBe('pbx.example.com');
    expect(all.transports.map((t) => t.type)).toEqual(['wss', 'tls', 'tcp', 'udp']);
    expect(all.transports[1]).toEqual({ type: 'tls', uri: 'sip:pbx.example.com:5061;transport=tls', host: 'pbx.example.com', port: 5061, path: null });
    // A plain (non-DTLS) extension with no explicit transport gets the SIP transports only.
    mocked(dbm.getExtensionSipProfile).mockResolvedValue({ ...PROFILE, media_encryption: 'no', allow: '' });
    const active = await ctl.extensionConfig(req());
    expect(active.transports.map((t) => t.type)).toEqual(['tls', 'tcp', 'udp']);
    expect(active.media?.codecs).toEqual(['alaw', 'ulaw']);
  });

  test('an explicit PJSIP transport wins', async () => {
    settings.SIP_TLS_ENABLED = 'true';
    mocked(dbm.getExtensionSipProfile).mockResolvedValue({ ...PROFILE, transport: '0.0.0.0-tls' });
    expect((await ctl.extensionConfig(req())).transports.map((t) => t.type)).toEqual(['tls']);
    expect(pjsipTransportType('transport-ws')).toBe('wss');
    expect(pjsipTransportType('weird')).toBeNull();
  });

  test('configured STUN/TURN replace the default', async () => {
    settings.WEBRTC_STUN_URL = 'stun:stun.example.com';
    settings.WEBRTC_TURN_URL = 'turn:turn.example.com';
    settings.WEBRTC_TURN_USER = 'u';
    expect((await ctl.extensionConfig(req())).ice_servers).toEqual([
      { urls: 'stun:stun.example.com', username: null, credential: null },
      { urls: 'turn:turn.example.com', username: 'u', credential: null },
    ]);
  });

  test('no extension: 200 with null credentials', async () => {
    mocked(dbm.getUserById).mockResolvedValue({ ...USER_ROW, extension: null });
    const out = await ctl.extensionConfig(req());
    expect(out).toMatchObject({ extension: null, auth_username: null, secret: null, transports: [], media: null, display_name: 'Ann' });
  });

  test.each([
    ['the PBX has no account', {}],
    ['the account has no secret', { username: '100' }],
    ['the PBX could not be read', null],
  ])('503 extension_config.unavailable when %s', async (_why, profile) => {
    mocked(dbm.getExtensionSipProfile).mockResolvedValue(profile);
    await expect(ctl.extensionConfig(req())).rejects.toMatchObject({ status: 503, detail: { code: 'extension_config.unavailable' } });
  });

  test('503 when the user row cannot be read', async () => {
    mocked(dbm.getUserById).mockResolvedValue(null);
    await expect(ctl.extensionConfig(req())).rejects.toMatchObject({ status: 503, detail: { code: 'extension_config.unavailable' } });
  });

  test('an unknown transports value is a validation error', async () => {
    await expect(ctl.extensionConfig(req({ query: { transports: 'some' } }))).rejects.toMatchObject({
      name: 'RequestValidationError',
      fields: [expect.objectContaining({ path: 'query.transports', code: 'literal_error' })],
    });
  });
});

describe('/api/extension-config/lookup', () => {
  const KEY = { id: null, username: 'apikey:crm', role: 'admin', api_key: true };
  const lookup = (body: unknown, query: Record<string, string> = {}) => ctl.extensionConfigLookup(req({ body, query, principal: KEY }));

  test('by username or by extension: the same answer as the own route', async () => {
    const own = await ctl.extensionConfig(req());
    expect(await lookup({ username: ' ann ' })).toEqual(own);
    expect(dbm.getUserByUsername).toHaveBeenCalledWith('ann');
    expect(await lookup({ extension: '100' })).toEqual(own);
    expect(dbm.getUserByExtension).toHaveBeenCalledWith('100');
  });

  test.each([[{}], [{ username: 'ann', extension: '100' }], [{ username: ' ' }], [{ username: 'ann', email: 'x' }]])(
    '%j is a validation error',
    async (body) => {
      await expect(lookup(body)).rejects.toMatchObject({ name: 'RequestValidationError' });
      expect(dbm.getUserByUsername).not.toHaveBeenCalled();
    },
  );

  test('unknown or inactive user: 404 extension_config.user_not_found', async () => {
    mocked(dbm.getUserByUsername).mockResolvedValueOnce(null).mockResolvedValueOnce({ ...USER_ROW, is_active: 0 });
    for (let i = 0; i < 2; i++) {
      await expect(lookup({ username: 'ann' })).rejects.toMatchObject({ status: 404, detail: { code: 'extension_config.user_not_found' } });
    }
  });

  test('a lookup that throws is a 503', async () => {
    mocked(dbm.getUserByExtension).mockRejectedValue(new Error('down'));
    await expect(lookup({ extension: '100' })).rejects.toMatchObject({ status: 503, detail: { code: 'extension_config.unavailable' } });
  });

  test('API key only, scope extension-config:read', () => {
    const proto = SoftphoneController.prototype as unknown as Record<string, object>;
    expect(Reflect.getMetadata(AUTH_POLICY, proto.extensionConfigLookup)).toEqual({ apiKey: 'extension-config:read' });
    expect(Reflect.getMetadata(AUTH_POLICY, proto.extensionConfig)).toBe('user');
  });
});

describe('extensions and WebRTC', () => {
  test('list: admin sees all, others their own and allowed', async () => {
    expect((await ctl.listExtensionsWebrtc(req({ principal: { role: 'admin' } }))).extensions).toHaveLength(2);
    expect((await ctl.listExtensionsWebrtc(req())).extensions.map((e) => e.extension)).toEqual(['100']);
  });

  test('credentials', async () => {
    expect(await ctl.extensionCredentials(req({ params: { extension: '100' } }))).toEqual({
      username: '100',
      password: 's3cret',
      name: 'PBX Ann',
      webrtc: 'yes',
      max_contacts: 2,
    });
    mocked(dbm.getExtensionSecretFromDb).mockResolvedValueOnce(null);
    mocked(dbm.getExtensionMaxContacts).mockResolvedValueOnce(null);
    expect(await ctl.extensionCredentials(req({ params: { extension: '555' } }))).toEqual({
      username: '555',
      password: '',
      name: '',
      webrtc: 'no',
      max_contacts: null,
    });
  });

  test('switch: own allowed, others 403, unknown 404', async () => {
    expect(await ctl.setExtensionWebrtc(req({ params: { extension: '100' }, body: { enabled: true } }))).toEqual({ ok: true, extension: '100' });
    await expect(ctl.setExtensionWebrtc(req({ params: { extension: '101' }, body: { enabled: true } }))).rejects.toMatchObject({
      status: 403,
      message: 'Not allowed to change WebRTC for this extension',
    });
    const sup = { role: 'supervisor', extension: '200', allowed_agent_extensions: ['101'] };
    mocked(dbm.setExtensionWebrtc).mockResolvedValueOnce(false);
    await expect(ctl.setExtensionWebrtc(req({ params: { extension: '101' }, body: { enabled: false }, principal: sup }))).rejects.toMatchObject({
      status: 404,
      message: 'Extension not found in users',
    });
  });
});
