/**
 * /api/push/config and the VAPID rotation over HTTP: admin only, every bad field listed in
 * one 422, an omitted field keeps what is stored, one all-or-nothing settings write, the
 * cleared mobile client marker staying cleared, and the VAPID keys replaced in one
 * transaction with the browser subscriptions (nothing changed on failure).
 *
 * No database and no network: the db layer, the auth guards, the dialplan and the reload
 * hooks are mocked; key validation is the real integrations/push-service code.
 */

import { generateKeyPairSync } from 'crypto';

let mockPrincipal: Record<string, unknown> | null = { id: 1, role: 'admin' };
const stored: Record<string, string | null> = {};

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
  getSetting: jest.fn(async (key: string, fallback: string | null = null) => stored[key] || fallback),
  getAllSettings: jest.fn(async () => ({ ...stored })),
  setSettings: jest.fn(),
  listSipPushBindings: jest.fn(async () => []),
  deleteSipPushBinding: jest.fn(),
  replaceVapidKeys: jest.fn(),
}));
jest.mock('../src/core/runtime', () => ({ runtime: { bridge: null, preWoken: new Map() } }));
jest.mock('../src/services/sip-push', () => ({
  DEFAULT_HOLD: 10,
  DEFAULT_SETTLE: 3,
  DEFAULT_MARKER: 'Mobile',
  configure: jest.fn(),
  reloadBindings: jest.fn(),
}));
jest.mock('../src/services/dialplan', () => ({
  enableMobileWake: jest.fn(async () => true),
  disableMobileWake: jest.fn(async () => true),
}));
jest.mock('../src/integrations/push-service', () => ({
  ...jest.requireActual('../src/integrations/push-service'),
  reloadConfig: jest.fn(),
  configStatus: jest.fn(() => ({ fcm: {}, apns: {}, web: {} })),
}));

import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PushController } from '../src/api/routes/push.controller';
import { auditSkip } from '../src/core/audit';
import * as dbm from '../src/db/db-manager';
import * as pushService from '../src/integrations/push-service';
import * as sipPush from '../src/services/sip-push';
import { enableMobileWake } from '../src/services/dialplan';
import { nestApp } from './helpers/nest-app';

const mocked = (fn: unknown) => fn as jest.Mock;

const SERVICE_ACCOUNT = {
  type: 'service_account',
  project_id: 'opdesk-voip',
  private_key: '-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----\n',
  client_email: 'push@opdesk-voip.iam.gserviceaccount.com',
};

function p8(): string {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
}

let app: INestApplication;
let saved: Record<string, string>[];

beforeAll(async () => {
  app = await nestApp([PushController]);
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  jest.clearAllMocks();
  mockPrincipal = { id: 1, role: 'admin' };
  for (const k of Object.keys(stored)) delete stored[k];
  saved = [];
  mocked(dbm.setSettings).mockImplementation(async (values: Record<string, string>) => {
    saved.push(values);
    Object.assign(stored, values);
    return true;
  });
  mocked(dbm.replaceVapidKeys).mockImplementation(async (values: Record<string, string>) => {
    saved.push(values);
    return 4;
  });
});

const http = () => request(app.getHttpServer());

test('push config routes are admin only', async () => {
  mockPrincipal = { id: 2, role: 'agent' };
  expect((await http().get('/api/push/config')).status).toBe(403);
  expect((await http().put('/api/push/config').send({})).status).toBe(403);
  mockPrincipal = null;
  expect((await http().post('/api/push/vapid/rotate')).status).toBe(401);
});

test('PUT stores the keys in one write', async () => {
  const r = await http().put('/api/push/config').send({
    fcm_service_account: JSON.stringify(SERVICE_ACCOUNT),
    apns_key_id: 'abcde12345',
    apns_team_id: 'TEAM123456',
    apns_bundle_id: 'com.example.app',
    apns_auth_key: p8(),
    apns_sandbox: true,
  });
  expect(r.status).toBe(200);
  expect(saved).toHaveLength(1);
  const values = saved[0];
  expect(values.PUSH_FCM_PROJECT_ID).toBe('opdesk-voip'); // filled from the key
  expect(JSON.parse(values.PUSH_FCM_SERVICE_ACCOUNT).client_email).toBe(SERVICE_ACCOUNT.client_email);
  expect(values.PUSH_APNS_KEY_ID).toBe('ABCDE12345');
  expect(values.PUSH_APNS_SANDBOX).toBe('true');
  expect(values.PUSH_APNS_AUTH_KEY.startsWith('-----BEGIN PRIVATE KEY-----')).toBe(true);
  expect(r.text).not.toContain('BEGIN');
  expect(pushService.reloadConfig).toHaveBeenCalled();
});

test('PUT keeps every field it leaves out, and keeps or removes the key files', async () => {
  Object.assign(stored, {
    PUSH_APNS_KEY_ID: 'KEEPME1234',
    PUSH_APNS_BUNDLE_ID: 'com.kept.app',
    MOBILE_CLIENT_MARKER: 'Kept',
    MOBILE_WAKE_WAIT: '20',
  });
  await http().put('/api/push/config').send({ apns_team_id: 'TEAM123456' }).expect(200);
  expect(saved[0]).toEqual({ PUSH_APNS_TEAM_ID: 'TEAM123456' });
  expect(stored).toMatchObject({ PUSH_APNS_KEY_ID: 'KEEPME1234', PUSH_APNS_BUNDLE_ID: 'com.kept.app', MOBILE_CLIENT_MARKER: 'Kept', MOBILE_WAKE_WAIT: '20' });

  await http().put('/api/push/config').send({ fcm_service_account: null, apns_auth_key: null }).expect(200);
  expect(saved).toHaveLength(1); // nothing to write
  await http().put('/api/push/config').send({ fcm_service_account: '', apns_auth_key: '' }).expect(200);
  expect(saved[1]).toEqual({ PUSH_FCM_SERVICE_ACCOUNT: '', PUSH_APNS_AUTH_KEY: '' });
});

test('PUT lists every bad field in one 422 and writes nothing', async () => {
  const r = await http().put('/api/push/config').send({
    hold_seconds: 5,
    settle_seconds: 11,
    fcm_service_account: '{"type": "user"}',
    fcm_project_id: 'Bad_Project',
    apns_key_id: 'short',
    apns_team_id: 'x',
    apns_bundle_id: '-bad',
    apns_auth_key: 'nope',
  });
  expect(r.status).toBe(422);
  expect(r.body.error.code).toBe('push.config.invalid');
  expect((r.body.error.fields as { path: string }[]).map((f) => f.path)).toEqual([
    'hold_seconds',
    'settle_seconds',
    'fcm_service_account',
    'fcm_project_id',
    'apns_key_id',
    'apns_team_id',
    'apns_bundle_id',
    'apns_auth_key',
  ]);
  expect(r.body.error.message).toContain('Hold time must be 8 to 30 seconds; Settle window must be 0 to 10 seconds');
  expect(dbm.setSettings).not.toHaveBeenCalled();
  expect(enableMobileWake).not.toHaveBeenCalled();

  const long = await http().put('/api/push/config').send({ apns_key_id: 'x'.repeat(17) });
  expect(long.status).toBe(400); // the body's own shape check (maxLen), before the field rules
  expect(long.body.error.fields[0]).toMatchObject({ path: 'apns_key_id' });
});

test('a failed settings write is a 500 and applies nothing', async () => {
  mocked(dbm.setSettings).mockResolvedValue(false);
  const r = await http().put('/api/push/config').send({ enabled: true, client_marker: 'X' });
  expect(r.status).toBe(500);
  expect(r.body.error.message).toBe('Could not save the push settings. Nothing was changed.');
  expect(sipPush.configure).not.toHaveBeenCalled();
  expect(enableMobileWake).not.toHaveBeenCalled();
  expect(pushService.reloadConfig).not.toHaveBeenCalled();
});

test('a cleared mobile client marker stays cleared', async () => {
  let r = await http().get('/api/push/config').expect(200);
  expect(r.body.data.mobile_wake.client_marker).toBe('Mobile'); // no row yet: the default
  await http().put('/api/push/config').send({ client_marker: '  ' }).expect(200);
  expect(saved[0]).toEqual({ MOBILE_CLIENT_MARKER: '' });
  expect(sipPush.configure).toHaveBeenCalledWith({ marker: '' });
  r = await http().get('/api/push/config').expect(200);
  expect(r.body.data.mobile_wake.client_marker).toBe('');
});

test('turning the wake on rewrites the dialplan with the stored timings it was not sent', async () => {
  Object.assign(stored, { MOBILE_WAKE_WAIT: '20', MOBILE_WAKE_SETTLE: '5' });
  await http().put('/api/push/config').send({ enabled: true }).expect(200);
  expect(enableMobileWake).toHaveBeenCalledWith(20, 5);
  expect(stored).toMatchObject({ MOBILE_WAKE_ENABLED: 'true', MOBILE_WAKE_WAIT: '20', MOBILE_WAKE_SETTLE: '5' });
});

test('new VAPID keys and the dropped subscriptions are one write', async () => {
  const r = await http().post('/api/push/vapid/rotate');
  expect(r.status).toBe(200);
  expect(r.body.data.removed_subscriptions).toBe(4);
  const values = saved[0];
  expect(values.PUSH_VAPID_PUBLIC_KEY).toBe(r.body.data.public_key);
  expect(values.PUSH_VAPID_PRIVATE_KEY).toBeTruthy();
  expect(r.text).not.toContain(values.PUSH_VAPID_PRIVATE_KEY);
  expect(pushService.reloadConfig).toHaveBeenCalled();
});

test('a failed VAPID replacement changes nothing', async () => {
  mocked(dbm.replaceVapidKeys).mockResolvedValue(null);
  const r = await http().post('/api/push/vapid/rotate');
  expect(r.status).toBe(500);
  expect(r.body.error.message).toBe('Could not save the new web push keys. Nothing was changed.');
  expect(pushService.reloadConfig).not.toHaveBeenCalled();
});

test('admin push changes are audited', () => {
  expect(auditSkip('/api/push/config')).toBe(false);
  expect(auditSkip('/api/push/vapid/rotate')).toBe(false);
  expect(auditSkip('/api/push/bindings/3')).toBe(false);
  expect(auditSkip('/api/push/web-resubscribe')).toBe(true);
});
