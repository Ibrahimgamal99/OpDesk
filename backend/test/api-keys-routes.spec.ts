/** /api/api-keys: validation, status codes and error texts (the texts pick the error codes). */

jest.mock(
  '../src/db/db-manager',
  () => ({ listApiKeys: jest.fn(), createApiKey: jest.fn(), getApiKey: jest.fn(), updateApiKey: jest.fn(), deleteApiKey: jest.fn() }));
jest.mock('../src/core/security', () => ({
  ALL_PERMISSIONS: ['calls:read', 'calls:write', 'cdr:read', 'analytics:read', 'extension-config:read'],
  principalOf: (req: { principal?: unknown }) => req.principal ?? null,
}));
jest.mock(
  '../src/api/respond',
  () => ({
    RawResponse: class {
      constructor(
        readonly body: string,
        readonly init: { status?: number } = {},
      ) {}
    },
  }));

import { HTTP_CODE_METADATA } from '@nestjs/common/constants';
import * as dbm from '../src/db/db-manager';
import { AUTH_POLICY } from '../src/api/routing';
import { ApiKeysController } from '../src/api/routes/api-keys.controller';

const ctl = new ApiKeysController();
const ADMIN = { id: 1, username: 'admin', role: 'admin' };
const req = (over: Record<string, unknown> = {}) => ({ params: {}, query: {}, body: {}, principal: ADMIN, ...over }) as never;
const mocked = (fn: unknown) => fn as jest.Mock;

beforeEach(() => jest.clearAllMocks());

test('permissions lists every scope, extension-config:read included', async () => {
  expect((await ctl.apiListPermissions()).permissions).toContain('extension-config:read');
});

test('list is wrapped in api_keys', async () => {
  mocked(dbm.listApiKeys).mockResolvedValue([{ id: 1 }]);
  expect(await ctl.apiListApiKeys()).toEqual({ api_keys: [{ id: 1 }] });
});

describe('create', () => {
  test('passes creator and expiry, answers 201 with the key', async () => {
    mocked(dbm.createApiKey).mockResolvedValue({ id: 3, key: 'opd_x' });
    const out = await ctl.apiCreateApiKey(req({ body: { name: ' crm ', scopes: ['cdr:read'], expires_at: '2027-01-01' } }));
    expect(out).toEqual({ id: 3, key: 'opd_x' });
    expect(dbm.createApiKey).toHaveBeenCalledWith('crm', ['cdr:read'], { createdBy: 1, expiresAt: '2027-01-01' });
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, ApiKeysController.prototype.apiCreateApiKey)).toBe(201);
  });

  test.each([
    [{ name: ' ', scopes: ['cdr:read'] }, 'Name required'],
    [{ name: 'a', scopes: ['cdr:read', 'root', 7] }, 'Unknown scope(s): root, 7'],
    [{ name: 'a', scopes: [] }, 'At least one scope is required'],
  ])('%j -> 400 %s', async (body, message) => {
    await expect(ctl.apiCreateApiKey(req({ body }))).rejects.toMatchObject({ status: 400, message });
  });

  test('a store failure is a 500', async () => {
    mocked(dbm.createApiKey).mockResolvedValue(null);
    await expect(ctl.apiCreateApiKey(req({ body: { name: 'a', scopes: ['cdr:read'] } }))).rejects.toMatchObject({ status: 500 });
  });
});

describe('update', () => {
  test('404 for an unknown key', async () => {
    mocked(dbm.getApiKey).mockResolvedValue(null);
    await expect(ctl.apiUpdateApiKey(req({ params: { key_id: '9' }, body: {} }))).rejects.toMatchObject({ status: 404, message: 'API key not found' });
  });

  test('partial update: absent fields are null', async () => {
    mocked(dbm.getApiKey).mockResolvedValue({ id: 9 });
    mocked(dbm.updateApiKey).mockResolvedValue({ id: 9, enabled: false });
    expect(await ctl.apiUpdateApiKey(req({ params: { key_id: '9' }, body: { enabled: false } }))).toEqual({ id: 9, enabled: false });
    expect(dbm.updateApiKey).toHaveBeenCalledWith(9, { name: null, scopes: null, enabled: false, expiresAt: null });
  });

  test('a non-integer id is a validation error', async () => {
    await expect(ctl.apiUpdateApiKey(req({ params: { key_id: 'x' } }))).rejects.toMatchObject({ name: 'RequestValidationError' });
  });
});

describe('delete', () => {
  test('204 empty', async () => {
    mocked(dbm.deleteApiKey).mockResolvedValue(true);
    const out = (await ctl.apiDeleteApiKey(req({ params: { key_id: '4' } }))) as unknown as { body: string; init: { status: number } };
    expect(out.body).toBe('');
    expect(out.init.status).toBe(204);
  });

  test('404 when nothing was deleted', async () => {
    mocked(dbm.deleteApiKey).mockResolvedValue(false);
    await expect(ctl.apiDeleteApiKey(req({ params: { key_id: '4' } }))).rejects.toMatchObject({ status: 404 });
  });
});

test('every route is admin (JWT) only', () => {
  const proto = ApiKeysController.prototype as unknown as Record<string, object>;
  for (const name of ['apiListPermissions', 'apiListApiKeys', 'apiCreateApiKey', 'apiUpdateApiKey', 'apiDeleteApiKey']) {
    expect(Reflect.getMetadata(AUTH_POLICY, proto[name])).toBe('admin');
  }
});
