/**
 * The PBX settings routes over HTTP: GET/PUT /api/codecs (FreePBX only, 404 on Issabel), the
 * SIP TLS status with udp_tcp_public, the admin SIP-secret endpoint, and the per-extension
 * multi-device (max_contacts) switch, plus their audit details.
 *
 * Nothing runs on the host: the db layer and services/dialplan (every reload / restart) are
 * mocked, and test/setup/no-host-commands.ts would fail a stray command loudly anyway.
 */

let mockPrincipal: Record<string, unknown> | null = { id: 1, role: 'admin', extension: '100', allowed_agent_extensions: null };
const CURRENT = ['opus', 'ulaw', 'alaw'];
const state = {
  codecs: [...CURRENT],
  pbxDefault: true,
  writes: [] as string[][],
  maxContacts: 1 as number | null,
  secrets: {} as Record<string, string>,
  exists: true as boolean | null,
};
const settings: Record<string, string> = {};

jest.mock('../src/core/security', () => {
  const { HttpError } = jest.requireActual('../src/api/http-error');
  type R = { principal?: unknown };
  const login = (req: R) => {
    if (!mockPrincipal) throw new HttpError(401, 'Not authenticated');
    req.principal = mockPrincipal;
    return mockPrincipal;
  };
  return {
    principalOf: (req: R) => req.principal ?? null,
    getCurrentUser: jest.fn(async (req: R) => login(req)),
    requireAdmin: jest.fn(async (req: R) => {
      const p = login(req);
      if (p.role !== 'admin') throw new HttpError(403, 'Admin only');
      return p;
    }),
    requireSupervisor: jest.fn(),
    requireScope: jest.fn(),
    requireApiKey: jest.fn(),
  };
});
jest.mock('../src/db/db-manager', () => ({
  STANDARD_AUDIO_CODECS: ['opus', 'ulaw', 'alaw', 'g722', 'gsm', 'g726', 'ilbc'],
  SINGLE_DEVICE_MAX_CONTACTS: 1,
  MULTI_DEVICE_MAX_CONTACTS: 2,
  getPbxDefaultCodecs: jest.fn(async () => (state.pbxDefault ? [...state.codecs] : null)),
  setPbxDefaultCodecs: jest.fn(async (codecs: string[]) => {
    state.writes.push(codecs);
    state.codecs = [...codecs];
    return true;
  }),
  getSetting: jest.fn(async (key: string, fallback: string | null = null) => settings[key] || fallback),
  setSetting: jest.fn(async (key: string, value: string) => {
    settings[key] = value;
    return true;
  }),
  extensionExistsInPbx: jest.fn(async () => state.exists),
  setExtensionSecretInPbx: jest.fn(async (ext: string, secret: string) => {
    state.secrets[ext] = secret;
    return true;
  }),
  getExtensionSecretFromDb: jest.fn(async (ext: string) => state.secrets[ext] ?? null),
  getExtensionNamesFromDb: jest.fn(async () => ({ '100': 'Ann' })),
  getExtensionsWithWebrtcFromUsers: jest.fn(async () => [{ extension: '100', name: 'Ann', webrtc: 'yes' }]),
  getExtensionMaxContacts: jest.fn(async () => state.maxContacts),
  setExtensionMaxContacts: jest.fn(async (_ext: string, n: number) => {
    state.maxContacts = n;
    return true;
  }),
}));
jest.mock('../src/services/dialplan', () => ({
  reloadAsteriskSip: jest.fn(async () => true),
  pbxKind: (pbx: string | null) => ((pbx || '').trim().toLowerCase() === 'issabel' ? 'issabel' : 'freepbx'),
  pbxApplyCommand: (pbx: string | null) => ((pbx || '').trim().toLowerCase() === 'issabel' ? 'amportal a r' : 'fwconsole reload'),
  settingOn: (x: unknown) => ['true', '1', 'yes'].includes(String(x ?? '').toLowerCase()),
  TLS_PORT: 5061,
  enableQos: jest.fn(async () => true),
  disableQos: jest.fn(async () => true),
  enableSipTls: jest.fn(async () => true),
  disableSipTls: jest.fn(async () => true),
}));
jest.mock('../src/services/sip-push', () => ({ publicHost: jest.fn(async () => '') }));

import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PbxController } from '../src/api/routes/pbx.controller';
import { generateSipSecret, SoftphoneController } from '../src/api/routes/softphone.controller';
import { SIP_SECRET_RULE } from '../src/api/shared';
import * as dbm from '../src/db/db-manager';
import { reloadAsteriskSip } from '../src/services/dialplan';
import { nestApp } from './helpers/nest-app';

const mocked = (fn: unknown) => fn as jest.Mock;
let app: INestApplication;

beforeAll(async () => {
  app = await nestApp([PbxController, SoftphoneController]);
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  jest.clearAllMocks();
  Object.assign(state, { codecs: [...CURRENT], pbxDefault: true, writes: [], maxContacts: 1, secrets: { '100': 'old-secret' }, exists: true });
  for (const k of Object.keys(settings)) delete settings[k];
  mockPrincipal = { id: 1, role: 'admin', extension: '100', allowed_agent_extensions: null };
});

const http = () => request(app.getHttpServer());
const putCodecs = (codecs: unknown, extra: object = {}) => http().put('/api/codecs').send({ codecs, ...extra });

describe('codecs', () => {
  test('GET lists the current codecs, then the rest', async () => {
    const r = await http().get('/api/codecs');
    expect(r.status).toBe(200);
    expect(r.body.data.codecs).toEqual(CURRENT);
    expect(r.body.data.available.slice(0, 3)).toEqual(CURRENT);
    expect(new Set(r.body.data.available)).toEqual(new Set(['opus', 'ulaw', 'alaw', 'g722', 'gsm', 'g726', 'ilbc']));
  });

  test('GET is a 503 when the PBX database is unreachable', async () => {
    state.pbxDefault = false;
    const r = await http().get('/api/codecs');
    expect(r.status).toBe(503);
    expect(r.body.error.message).toBe('Cannot reach the PBX database');
  });

  test('PUT writes the order (lowercased) and reloads once', async () => {
    const r = await putCodecs(['ULAW', 'opus', 'g722']);
    expect(r.status).toBe(200);
    expect(r.body.data.codecs).toEqual(['ulaw', 'opus', 'g722']);
    expect(r.body.data.available.slice(0, 3)).toEqual(['ulaw', 'opus', 'g722']);
    expect(state.writes).toEqual([['ulaw', 'opus', 'g722']]);
    expect(reloadAsteriskSip).toHaveBeenCalledTimes(1);
  });

  test('PUT with an unchanged list skips the write and the reload', async () => {
    expect((await putCodecs([...CURRENT])).status).toBe(200);
    expect(state.writes).toEqual([]);
    expect(reloadAsteriskSip).not.toHaveBeenCalled();
  });

  test.each([
    [[], 'Keep at least one codec'],
    [['opus', 'opus'], 'Each codec may appear only once'],
    [['opus', 'g729'], 'Unknown codec: g729'],
  ])('PUT rejects a bad list (%j)', async (codecs, message) => {
    const r = await putCodecs(codecs);
    expect(r.status).toBe(400);
    expect(r.body.error.message).toBe(message);
    expect(state.writes).toEqual([]);
  });

  test('PUT reports a failed reload with the command for this PBX', async () => {
    mocked(reloadAsteriskSip).mockResolvedValueOnce(false);
    const r = await putCodecs(['opus']);
    expect(r.status).toBe(502);
    expect(r.body.error.message).toBe("Codecs saved, but the PBX reload failed. Run 'fwconsole reload'.");
  });

  test('Issabel keeps codecs per peer: both routes are 404', async () => {
    settings.PBX = 'Issabel';
    expect((await http().get('/api/codecs')).status).toBe(404);
    expect((await putCodecs(['opus'])).status).toBe(404);
    expect(dbm.getPbxDefaultCodecs).not.toHaveBeenCalled();
  });

  test('the body rejects unknown fields', async () => {
    const r = await putCodecs(['opus'], { extension: '100' });
    expect(r.status).toBe(400);
    expect(r.body.error.fields).toEqual([{ path: 'extension', code: 'value.extra_forbidden', message: 'Extra inputs are not permitted', params: {} }]);
    expect(state.writes).toEqual([]);
  });

  test('the codec routes are admin only', async () => {
    mockPrincipal = { id: 2, role: 'supervisor', extension: '200', allowed_agent_extensions: [] };
    expect((await http().get('/api/codecs')).status).toBe(403);
    expect((await putCodecs(['opus'])).status).toBe(403);
  });
});

describe('SIP TLS status', () => {
  test('carries udp_tcp_public from SIP_UDP_TCP_PUBLIC (off by default)', async () => {
    settings.OPDESK_DOMAIN = 'pbx.example.com';
    let r = await http().get('/api/sip-tls/status');
    expect(r.body).toEqual({ enabled: false, domain: 'pbx.example.com', port: 5061, udp_tcp_public: false });
    settings.SIP_UDP_TCP_PUBLIC = 'true';
    r = await http().get('/api/sip-tls/status');
    expect(r.body.udp_tcp_public).toBe(true);
  });
});

describe('SIP secret', () => {
  test('an exact secret passing the SIP secret rule is set, the PBX config applied, and the GET shape returned', async () => {
    const r = await http().put('/api/settings/extensions/100/credentials').send({ password: '  s3cret-pass  ' });
    expect(r.status).toBe(200);
    expect(dbm.setExtensionSecretInPbx).toHaveBeenCalledWith('100', 's3cret-pass');
    expect(reloadAsteriskSip).toHaveBeenCalledTimes(1);
    expect(r.body).toEqual({ username: '100', password: 's3cret-pass', name: 'Ann', webrtc: 'yes', max_contacts: 1 });
  });

  test('regenerate makes a random 16-character secret', async () => {
    const r = await http().put('/api/settings/extensions/100/credentials').send({ regenerate: true });
    expect(r.status).toBe(200);
    expect(r.body.password).toMatch(/^[A-Za-z0-9]{16}$/);
    expect(r.body.password).not.toBe('old-secret');
    expect(generateSipSecret()).not.toBe(generateSipSecret());
  });

  test.each([
    [{ password: 'short' }, 400, SIP_SECRET_RULE],
    [{}, 400, SIP_SECRET_RULE],
    [{ password: 'no digits here' }, 400, SIP_SECRET_RULE],
    [{ password: 'quote"d12345' }, 400, SIP_SECRET_RULE],
  ])('%j -> %s', async (body, status, message) => {
    const r = await http().put('/api/settings/extensions/100/credentials').send(body);
    expect(r.status).toBe(status);
    expect(r.body.error.message).toBe(message);
    expect(dbm.setExtensionSecretInPbx).not.toHaveBeenCalled();
  });

  test('an unknown extension is a 404; an unreadable PBX a 503; a failed write a 502', async () => {
    state.exists = false;
    expect((await http().put('/api/settings/extensions/999/credentials').send({ regenerate: true })).status).toBe(404);
    state.exists = null;
    expect((await http().put('/api/settings/extensions/999/credentials').send({ regenerate: true })).status).toBe(503);
    state.exists = true;
    mocked(dbm.setExtensionSecretInPbx).mockResolvedValueOnce(false);
    expect((await http().put('/api/settings/extensions/100/credentials').send({ regenerate: true })).status).toBe(502);
    expect(reloadAsteriskSip).not.toHaveBeenCalled();
  });

  test('is admin only', async () => {
    mockPrincipal = { id: 3, role: 'agent', extension: '100', allowed_agent_extensions: null };
    expect((await http().put('/api/settings/extensions/100/credentials').send({ regenerate: true })).status).toBe(403);
  });
});

describe('multi-device (max_contacts)', () => {
  const put = (ext: string, enabled: unknown) => http().put(`/api/settings/extensions/${ext}/max-contacts`).send({ enabled });

  test('enable writes 2, disable writes 1, with the PBX flavour for the reload', async () => {
    settings.PBX = 'Issabel';
    let r = await put('100', true);
    expect(r.body).toEqual({ ok: true, extension: '100', max_contacts: 2 });
    expect(dbm.setExtensionMaxContacts).toHaveBeenCalledWith('100', 2, { pbx: 'Issabel' });
    r = await put('100', false);
    expect(r.body).toEqual({ ok: true, extension: '100', max_contacts: 1 });
  });

  test('an unchanged value, or a hand-set value above 2, is left alone', async () => {
    state.maxContacts = 3;
    expect((await put('100', true)).body).toEqual({ ok: true, extension: '100', max_contacts: 3 });
    state.maxContacts = 1;
    expect((await put('100', false)).body).toEqual({ ok: true, extension: '100', max_contacts: 1 });
    expect(dbm.setExtensionMaxContacts).not.toHaveBeenCalled();
  });

  test('an unreadable PBX is a 503 and a failed write a 502', async () => {
    state.maxContacts = null;
    expect((await put('100', true)).status).toBe(503);
    state.maxContacts = 1;
    mocked(dbm.setExtensionMaxContacts).mockResolvedValueOnce(false);
    expect((await put('100', true)).status).toBe(502);
  });

  test('agents change only their own extension', async () => {
    mockPrincipal = { id: 4, role: 'agent', extension: '100', allowed_agent_extensions: null };
    expect((await put('100', true)).status).toBe(200);
    const r = await put('200', true);
    expect(r.status).toBe(403);
    expect(r.body.error.message).toBe('Not allowed to change devices for this extension');
  });

  test('the credentials GET carries max_contacts (null when unreadable)', async () => {
    state.maxContacts = null;
    const r = await http().get('/api/settings/extensions/100/credentials');
    expect(r.body.max_contacts).toBeNull();
  });
});
