/**
 * core/audit.ts: the audit middleware and its detail column. A route records WHAT a mutation
 * carried with setRedactedAuditDetail; the middleware writes it as JSON once the response
 * finished 2xx. Secrets never reach the row: redactAuditDetail masks every secret-named key
 * (api/shared's isSecretKey, which now also covers whole-word *_PASS keys).
 *
 * No database: insertAuditLog and the settings store are mocked; the auth guards are mocked
 * so the actor comes from the test.
 */

const settingsStore: Record<string, string | null> = {};
let mockPrincipal: Record<string, unknown> | null = { id: 1, username: 'admin', role: 'admin', extension: '100' };

jest.mock('../src/db/manager/audit', () => ({ insertAuditLog: jest.fn() }));
jest.mock('../src/db/db-manager', () => ({
  setSetting: jest.fn(async (key: string, value: string) => {
    settingsStore[key] = value;
    return true;
  }),
  getAllSettings: jest.fn(async () => ({ ...settingsStore })),
  getSetting: jest.fn(async (key: string, fallback: string | null = null) => settingsStore[key] ?? fallback),
}));
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
    requireAdmin: jest.fn(async (req: R) => login(req)),
    requireSupervisor: jest.fn(),
    requireScope: jest.fn(),
    requireApiKey: jest.fn(),
  };
});

import express from 'express';
import { Controller, INestApplication, Module, Req, Type } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, NestFactory } from '@nestjs/core';
import type { Request } from 'express';
import request from 'supertest';
import { HttpError } from '../src/api/http-error';
import { EnvelopeExceptionFilter, jsonBodyErrors, OpDeskExpressAdapter, traceMiddleware } from '../src/api/respond';
import { Auth, AuthGuard, Delete, Get, Post } from '../src/api/routing';
import { SettingsController } from '../src/api/routes/settings.controller';
import { isSecretKey, SECRET_MASK } from '../src/api/shared';
import {
  AUDIT_DETAIL_MAX, auditDetailText, auditEntity, auditMutations, auditSkip, redactAuditDetail, setRedactedAuditDetail,
} from '../src/core/audit';
import { insertAuditLog } from '../src/db/manager/audit';

const insert = insertAuditLog as jest.Mock;

@Controller()
class AuditTestController {
  @Post('/api/settings/plain')
  @Auth('user')
  plain() {
    return { ok: true };
  }

  @Post('/api/integration/thing')
  @Auth('user')
  thing(@Req() req: Request) {
    setRedactedAuditDetail(req, {
      number: '+201221555831',
      api_key: 'opd_live_secret',
      nested: { password: 'hunter22', WEBRTC_TURN_PASS: 'turnpw', SIP_PASSTHROUGH: 'yes' },
      list: [{ bearer_token: 'tok' }],
    });
    return { ok: true };
  }

  @Post('/api/settings/huge')
  @Auth('user')
  huge(@Req() req: Request) {
    setRedactedAuditDetail(req, { blob: 'x'.repeat(AUDIT_DETAIL_MAX + 10) });
    return { ok: true };
  }

  @Post('/api/settings/emoji')
  @Auth('user')
  emoji(@Req() req: Request) {
    // 40000 code points: under the cap, which counts code points, not UTF-16 units.
    setRedactedAuditDetail(req, { blob: '😀'.repeat(40000) });
    return { ok: true };
  }

  @Delete('/api/settings/things/:id')
  @Auth('user')
  del() {
    throw new HttpError(404, 'Thing not found');
  }

  @Get('/api/settings/read')
  @Auth('user')
  read() {
    return { ok: true };
  }

  @Post('/api/auth/logout')
  @Auth('public')
  logout() {
    return { ok: true };
  }
}

/** test/helpers/nest-app's wiring plus the audit middleware, as main.ts mounts it. */
async function auditApp(controllers: Type<unknown>[]): Promise<INestApplication> {
  @Module({
    controllers,
    providers: [
      { provide: APP_GUARD, useClass: AuthGuard },
      { provide: APP_FILTER, useClass: EnvelopeExceptionFilter },
    ],
  })
  class AuditTestModule {}

  const nest = await NestFactory.create(AuditTestModule, new OpDeskExpressAdapter(), { logger: false, bodyParser: false });
  nest.use(traceMiddleware);
  nest.use(express.json({ strict: false }));
  nest.use(jsonBodyErrors);
  nest.use(auditMutations);
  await nest.init();
  return nest;
}

/** Let the response's 'finish' handler run. */
const flush = () => new Promise((r) => setImmediate(r));

let app: INestApplication;

beforeAll(async () => {
  app = await auditApp([AuditTestController, SettingsController]);
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  insert.mockReset().mockResolvedValue(1);
  for (const k of Object.keys(settingsStore)) delete settingsStore[k];
  mockPrincipal = { id: 1, username: 'admin', role: 'admin', extension: '100' };
});

const http = () => request(app.getHttpServer());

function detail(): string | null {
  expect(insert).toHaveBeenCalledTimes(1);
  return (insert.mock.calls[0][2] as { detail: string | null }).detail;
}

describe('the middleware', () => {
  test('a route-set detail lands in the row with every secret masked', async () => {
    expect((await http().post('/api/integration/thing')).status).toBe(200);
    await flush();
    expect(JSON.parse(detail() as string)).toEqual({
      number: '+201221555831',
      api_key: SECRET_MASK,
      nested: { password: SECRET_MASK, WEBRTC_TURN_PASS: SECRET_MASK, SIP_PASSTHROUGH: 'yes' },
      list: [{ bearer_token: SECRET_MASK }],
    });
    const [action, entityType, kw] = insert.mock.calls[0];
    expect([action, entityType]).toEqual(['create', 'integration']);
    expect(kw).toMatchObject({ actorExt: '100', actorUserId: 1, summary: 'POST /api/integration/thing' });
    expect(insert.mock.calls[0][2].detail).not.toContain('opd_live_secret');
  });

  test('no detail is null', async () => {
    expect((await http().post('/api/settings/plain')).status).toBe(200);
    await flush();
    expect(detail()).toBeNull();
  });

  test('a failed mutation (404) is not audited', async () => {
    expect((await http().delete('/api/settings/things/3')).status).toBe(404);
    await flush();
    expect(insert).not.toHaveBeenCalled();
  });

  test('reads and skipped paths are not audited', async () => {
    await http().get('/api/settings/read');
    await http().post('/api/auth/logout');
    await flush();
    expect(insert).not.toHaveBeenCalled();
  });

  test('an oversize detail is capped and stays JSON', async () => {
    expect((await http().post('/api/settings/huge')).status).toBe(200);
    await flush();
    const d = JSON.parse(detail() as string);
    expect(d.truncated).toBe(true);
    expect([...d.head]).toHaveLength(AUDIT_DETAIL_MAX);
    expect(d.chars).toBeGreaterThan(AUDIT_DETAIL_MAX);
  });

  test('the cap counts code points, not UTF-16 units', async () => {
    expect((await http().post('/api/settings/emoji')).status).toBe(200);
    await flush();
    const d = JSON.parse(detail() as string);
    expect(d.truncated).toBeUndefined();
    expect([...d.blob]).toHaveLength(40000);
  });
});

describe('POST /api/settings records what it saved, secrets masked', () => {
  test('a *_PASS key is masked in the row; a *_PASSTHROUGH flag is not; a posted mask is kept', async () => {
    settingsStore.CRM_API_KEY = 'stored';
    const r = await http().post('/api/settings').send({
      WEBRTC_TURN_PASS: 'turn-secret',
      SIP_PASSTHROUGH: 'true',
      WEBRTC_TURN_USER: 'turnuser',
      CRM_API_KEY: SECRET_MASK,
    });
    expect(r.status).toBe(200);
    expect(r.body.kept).toEqual(['CRM_API_KEY']);
    await flush();
    const d = JSON.parse(detail() as string);
    expect(d).toEqual({
      saved: { WEBRTC_TURN_PASS: SECRET_MASK, SIP_PASSTHROUGH: 'true', WEBRTC_TURN_USER: 'turnuser' },
      kept: ['CRM_API_KEY'],
      failed: [],
    });
    expect(JSON.stringify(insert.mock.calls)).not.toContain('turn-secret');
    expect(settingsStore.WEBRTC_TURN_PASS).toBe('turn-secret');
    expect(settingsStore.CRM_API_KEY).toBe('stored');
  });

  test('GET /api/settings masks WEBRTC_TURN_PASS but shows SIP_PASSTHROUGH', async () => {
    Object.assign(settingsStore, { WEBRTC_TURN_PASS: 'turn-secret', SIP_PASSTHROUGH: 'true', WEBRTC_TURN_PASS_ENABLED: 'true' });
    const r = await http().get('/api/settings');
    expect(r.body.settings).toMatchObject({ WEBRTC_TURN_PASS: SECRET_MASK, SIP_PASSTHROUGH: 'true', WEBRTC_TURN_PASS_ENABLED: 'true' });
    expect(r.text).not.toContain('turn-secret');
  });
});

describe('helpers', () => {
  test('isSecretKey: *_PASS and PASSWD are secrets; *_PASSTHROUGH, PASSIVE and plain flags are not', () => {
    for (const k of ['WEBRTC_TURN_PASS', 'SMTP_PASS', 'PASS', 'pass', 'DB_PASSWD', 'CRM_PASSWORD', 'JWT_SECRET', 'api_key', 'oauth2_client_secret']) {
      expect([k, isSecretKey(k)]).toEqual([k, true]);
    }
    for (const k of [
      'SIP_PASSTHROUGH', 'PASSTHROUGH', 'RTP_PASSIVE', 'BYPASS_CACHE', 'COMPASS', 'WEBRTC_TURN_USER', 'CRM_OAUTH2_TOKEN_URL',
      'CRM_API_KEY_HEADER', 'WEBRTC_TURN_PASS_ENABLED', 'CRM_BLOCK_PRIVATE',
    ]) {
      expect([k, isSecretKey(k)]).toEqual([k, false]);
    }
  });

  test('redactAuditDetail masks at any depth and leaves empty secrets and non-objects alone', () => {
    expect(redactAuditDetail({ password: '', api_key: null, token: undefined, name: 'x' })).toEqual({
      password: '',
      api_key: null,
      token: undefined,
      name: 'x',
    });
    expect(redactAuditDetail([{ a: { b: [{ SMTP_PASS: 'p' }] } }])).toEqual([{ a: { b: [{ SMTP_PASS: SECRET_MASK }] } }]);
    expect(redactAuditDetail('password')).toBe('password');
    expect(redactAuditDetail(7)).toBe(7);
    const at = new Date(2026, 9, 18);
    expect(redactAuditDetail({ at })).toEqual({ at });
    // The input is not changed in place.
    const input = { secret: 's' };
    redactAuditDetail(input);
    expect(input.secret).toBe('s');
  });

  test('auditDetailText: Python json.dumps separators and values', () => {
    expect(auditDetailText(undefined)).toBeNull();
    expect(auditDetailText(null)).toBeNull();
    expect(auditDetailText({ a: [1, 'é'], b: null, c: true })).toBe('{"a": [1, "é"], "b": null, "c": true}');
  });

  test('auditEntity and auditSkip', () => {
    expect(auditEntity('/api/settings/users/5')).toEqual(['settings', '5']);
    expect(auditEntity('/api/codecs')).toEqual(['codecs', null]);
    expect(auditEntity('/api/settings/extensions/100/credentials')).toEqual(['settings', null]);
    for (const p of ['/api/auth/login', '/api/client-log', '/api/internal/mobile-wake/100', '/api/push/web-resubscribe', '/api/device-tokens']) {
      expect(auditSkip(p)).toBe(true);
    }
    for (const p of ['/api/codecs', '/api/settings/extensions/100/credentials', '/api/push/config', '/api/settings']) {
      expect(auditSkip(p)).toBe(false);
    }
  });
});
