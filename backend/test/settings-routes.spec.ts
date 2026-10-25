/**
 * /api/settings: secret masking on read, keep-on-mask on write, and the 500s that no longer
 * carry exception text. The controller is called directly; db-manager is mocked.
 */

jest.mock('../src/db/db-manager', () => ({ getAllSettings: jest.fn(), getSetting: jest.fn(), setSetting: jest.fn() }));
jest.mock('../src/core/security', () => ({ principalOf: (req: { principal?: unknown }) => req.principal ?? null }));

import * as dbm from '../src/db/db-manager';
import { HttpError } from '../src/api/http-error';
import { AUTH_POLICY } from '../src/api/routing';
import { isSecretSetting, maskSetting, pyStrValue, SECRET_MASK, SettingsController } from '../src/api/routes/settings.controller';

const ctl = new SettingsController();
const req = (over: Record<string, unknown> = {}) => ({ params: {}, query: {}, body: {}, principal: { id: 1, role: 'admin' }, ...over }) as never;
const mocked = (fn: unknown) => fn as jest.Mock;

beforeEach(() => jest.clearAllMocks());

describe('secret detection', () => {
  test.each([
    'JWT_SECRET',
    'CRM_PASSWORD',
    'CRM_API_KEY',
    'CRM_BEARER_TOKEN',
    'CRM_OAUTH2_CLIENT_SECRET',
    'PUSH_VAPID_PRIVATE_KEY',
    'PUSH_APNS_AUTH_KEY',
    'PUSH_FCM_SERVICE_ACCOUNT',
    'some_private_key',
  ])('%s is a secret', (key) => expect(isSecretSetting(key)).toBe(true));

  test.each(['WEBRTC_PBX_SERVER', 'SIP_TLS_ENABLED', 'CRM_SERVER_URL', 'CRM_API_KEY_HEADER', 'QOS_ENABLED', 'PBX', 'CRM_BLOCK_PRIVATE'])('%s is not', (key) =>
    expect(isSecretSetting(key)).toBe(false),
  );

  test('only a stored value is masked; unset stays distinguishable', () => {
    expect(maskSetting('JWT_SECRET', 'abc')).toBe(SECRET_MASK);
    expect(maskSetting('JWT_SECRET', '')).toBe('');
    expect(maskSetting('JWT_SECRET', null)).toBeNull();
    expect(maskSetting('PBX', 'FreePBX')).toBe('FreePBX');
  });
});

describe('GET /api/settings', () => {
  test('masks secrets and keeps the success flag', async () => {
    mocked(dbm.getAllSettings).mockResolvedValue({ JWT_SECRET: 'x', CRM_PASSWORD: '', PBX: 'FreePBX' });
    expect(await ctl.getSettings()).toEqual({ success: true, settings: { JWT_SECRET: SECRET_MASK, CRM_PASSWORD: '', PBX: 'FreePBX' } });
  });

  test('by key: masked, and null when unset', async () => {
    mocked(dbm.getSetting).mockResolvedValueOnce('s3cret').mockResolvedValueOnce(null);
    expect(await ctl.getSettingByKey(req({ params: { key: 'CRM_API_KEY' } }))).toEqual({ success: true, key: 'CRM_API_KEY', value: SECRET_MASK });
    expect(await ctl.getSettingByKey(req({ params: { key: 'NOPE' } }))).toEqual({ success: true, key: 'NOPE', value: null });
  });

  test('a read failure is a 500 without the exception text', async () => {
    mocked(dbm.getAllSettings).mockRejectedValue(new Error('ECONNREFUSED 10.0.0.1'));
    await expect(ctl.getSettings()).rejects.toMatchObject({ status: 500, message: 'Failed to get settings' });
  });
});

describe('POST /api/settings', () => {
  test('a masked secret is kept, everything else is stored as str()', async () => {
    mocked(dbm.setSetting).mockImplementation(async (k: string) => k !== 'BROKEN');
    const out = await ctl.saveSettings(
      req({ body: { JWT_SECRET: SECRET_MASK, CRM_PASSWORD: '', FLAG: true, N: 5, NONE: null, BROKEN: 'x', PBX: SECRET_MASK } }),
    );
    expect(out).toEqual({
      success: false,
      saved: ['CRM_PASSWORD', 'FLAG', 'N', 'NONE', 'PBX'],
      failed: ['BROKEN'],
      kept: ['JWT_SECRET'],
      message: 'Saved 5 setting(s), 1 failed',
    });
    expect(dbm.setSetting).not.toHaveBeenCalledWith('JWT_SECRET', expect.anything());
    // A blank secret still clears it; the mask on a non-secret key is just a value.
    expect(dbm.setSetting).toHaveBeenCalledWith('CRM_PASSWORD', '');
    expect(dbm.setSetting).toHaveBeenCalledWith('FLAG', 'True');
    expect(dbm.setSetting).toHaveBeenCalledWith('N', '5');
    expect(dbm.setSetting).toHaveBeenCalledWith('NONE', '');
    expect(dbm.setSetting).toHaveBeenCalledWith('PBX', SECRET_MASK);
  });

  test.each([
    [{ JWT_SECRET: 'x' }, 'JWT_SECRET'],
    [{ PBX: 'FreePBX', VAPID_PRIVATE_KEY: 'k' }, 'VAPID_PRIVATE_KEY'],
    [{ 'bad key': '1' }, 'bad key'],
    [{ lower_case: '1' }, 'lower_case'],
  ])('%j is refused whole, nothing written', async (body, key) => {
    const err = await ctl.saveSettings(req({ body })).catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err).toMatchObject({ status: 400 });
    expect(err.message).toContain(key);
    expect(dbm.setSetting).not.toHaveBeenCalled();
  });

  test('a non-object body is a validation error', async () => {
    await expect(ctl.saveSettings(req({ body: [1, 2] }))).rejects.toMatchObject({ name: 'RequestValidationError' });
  });

  test('a write failure is a 500 without the exception text', async () => {
    mocked(dbm.setSetting).mockRejectedValue(new Error('Access denied for user'));
    const err = await ctl.saveSettings(req({ body: { A: '1' } })).catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err).toMatchObject({ status: 500, message: 'Failed to save settings' });
  });

  test('str() of containers is Python repr', () => {
    expect(pyStrValue({ a: [1, 'x', null, false] })).toBe("{'a': [1, 'x', None, False]}");
  });
});

test('every route is admin only', () => {
  const proto = SettingsController.prototype as unknown as Record<string, object>;
  for (const name of ['saveSettings', 'getSettings', 'getSettingByKey']) {
    expect(Reflect.getMetadata(AUTH_POLICY, proto[name])).toBe('admin');
  }
});
