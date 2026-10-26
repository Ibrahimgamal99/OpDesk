/** /api/settings/users and /api/settings/agents: shapes, 409 conflicts, PBX sync, scoping. */

jest.mock(
  '../src/db/db-manager',
  () => ({
    getAllUsers: jest.fn(),
    getUserById: jest.fn(),
    getUserByUsername: jest.fn(),
    getUserByExtension: jest.fn(),
    getUserAgentsAndQueues: jest.fn(async () => [['100'], ['q1']]),
    getUserGroupIds: jest.fn(async () => [2]),
    createUser: jest.fn(),
    updateUser: jest.fn(),
    deleteUser: jest.fn(),
    setUserGroups: jest.fn(),
    setExtensionSecretInPbx: jest.fn(async () => true),
    setExtensionNameInPbx: jest.fn(async () => true),
    extensionExistsInPbx: jest.fn(async () => true),
    getSetting: jest.fn(async (_k: string, d: unknown) => d),
    getExtensionNamesFromDb: jest.fn(async () => ({ '100': 'Ann' })),
    syncAgentsFromExtensions: jest.fn(),
    getAgentsList: jest.fn(),
    groupNameExists: jest.fn(),
  }));
jest.mock('../src/core/security', () => ({ principalOf: (req: { principal?: unknown }) => req.principal ?? null }));
jest.mock('../src/core/runtime', () => ({ runtime: { monitor: null } }));
jest.mock('../src/services/dialplan', () => ({
  reloadAsteriskSip: jest.fn(async () => true),
  pbxApplyCommand: jest.fn(() => 'fwconsole reload'),
}));

import * as dbm from '../src/db/db-manager';
import { runtime } from '../src/core/runtime';
import { reloadAsteriskSip } from '../src/services/dialplan';
import { AUTH_POLICY } from '../src/api/routing';
import { UsersController } from '../src/api/routes/users.controller';

const ctl = new UsersController();
const ADMIN = { id: 1, username: 'admin', role: 'admin', extension: null, allowed_agent_extensions: null };
const req = (over: Record<string, unknown> = {}) => ({ params: {}, query: {}, body: {}, principal: ADMIN, ...over }) as never;
const mocked = (fn: unknown) => fn as jest.Mock;
const USER = { id: 7, username: 'ann', extension: '100', name: 'Ann', role: 'supervisor', is_active: 1, monitor_modes: ['whisper', 'listen'] };

beforeEach(() => {
  jest.clearAllMocks();
  mocked(dbm.getUserById).mockResolvedValue({ ...USER });
  mocked(dbm.getUserByUsername).mockResolvedValue(null);
  mocked(dbm.getUserByExtension).mockResolvedValue(null);
  mocked(dbm.updateUser).mockResolvedValue(true);
  mocked(dbm.extensionExistsInPbx).mockResolvedValue(true);
  mocked(dbm.setExtensionSecretInPbx).mockResolvedValue(true);
  mocked(dbm.setExtensionNameInPbx).mockResolvedValue(true);
  mocked(reloadAsteriskSip).mockResolvedValue(true);
  (runtime as { monitor: unknown }).monitor = null;
});

test('rows carry monitor_mode (first of monitor_modes) next to the access lists', async () => {
  mocked(dbm.getAllUsers).mockResolvedValue([{ ...USER }, { ...USER, id: 8, monitor_modes: [] }]);
  const { users } = await ctl.apiListUsers();
  expect(users[0]).toEqual({ ...USER, monitor_mode: 'whisper', agent_extensions: ['100'], queue_names: ['q1'], group_ids: [2] });
  expect(users[1].monitor_mode).toBe('listen');
});

test('get: 404 for an unknown id', async () => {
  mocked(dbm.getUserById).mockResolvedValue(null);
  await expect(ctl.apiGetUser(req({ params: { user_id: '3' } }))).rejects.toMatchObject({ status: 404, message: 'User not found' });
});

describe('create', () => {
  test('stores the user, its groups, and syncs the PBX display name', async () => {
    mocked(dbm.createUser).mockResolvedValue(7);
    const r = req({ body: { username: ' ann ', password: 'pw123456', name: 'Ann', extension: '100', monitor_modes: ['whisper'], group_ids: [2] } });
    const out = await ctl.apiCreateUser(r);
    // The audit detail names the user and says a password was set, never which.
    expect((r as { auditDetail?: unknown }).auditDetail).toEqual({
      id: 7,
      username: 'ann',
      name: 'Ann',
      extension: '100',
      role: 'supervisor',
      monitor_modes: ['whisper'],
      group_ids: [2],
      password: '********',
    });
    expect(dbm.createUser).toHaveBeenCalledWith('ann', 'pw123456', {
      name: 'Ann',
      extension: '100',
      role: 'supervisor',
      monitorMode: 'listen',
      monitorModes: ['whisper'],
    });
    expect(dbm.setUserGroups).toHaveBeenCalledWith(7, [2]);
    // The sign-in password is OpDesk's only: the extension keeps its SIP secret.
    expect(dbm.setExtensionSecretInPbx).not.toHaveBeenCalled();
    expect(dbm.setExtensionNameInPbx).toHaveBeenCalledWith('100', 'Ann');
    expect(reloadAsteriskSip).toHaveBeenCalledTimes(1);
    expect(out.monitor_mode).toBe('whisper');
  });

  test('an admin gets every monitor mode; the legacy single mode still works', async () => {
    mocked(dbm.createUser).mockResolvedValue(7);
    await ctl.apiCreateUser(req({ body: { username: 'a', password: 'pw123456', role: 'admin', monitor_modes: [] } }));
    expect(mocked(dbm.createUser).mock.calls[0][2].monitorModes).toEqual(['listen', 'whisper', 'barge']);
    await ctl.apiCreateUser(req({ body: { username: 'b', password: 'pw123456', monitor_mode: 'barge' } }));
    expect(mocked(dbm.createUser).mock.calls[1][2].monitorModes).toEqual(['barge']);
    // No extension: nothing to sync, no reload.
    expect(reloadAsteriskSip).not.toHaveBeenCalled();
  });

  test.each([
    [{ username: ' ', password: 'p' }, 'Username required'],
    [{ username: 'a', password: ' ' }, 'Password required'],
    [{ username: 'a', password: 'short1' }, 'The password needs at least 8 characters'],
  ])('%j -> 400 %s', async (body, message) => {
    await expect(ctl.apiCreateUser(req({ body }))).rejects.toMatchObject({ status: 400, message });
  });

  test('a taken username or extension is a 409 (user.record.conflict)', async () => {
    mocked(dbm.createUser).mockResolvedValue(null);
    await expect(ctl.apiCreateUser(req({ body: { username: 'ann', password: 'pw123456' } }))).rejects.toMatchObject({
      status: 409,
      message: 'Username or extension already in use',
    });
  });
});

describe('update', () => {
  test('an admin role forces every monitor mode; groups replaced only when sent', async () => {
    await ctl.apiUpdateUser(req({ params: { user_id: '7' }, body: { role: 'admin', monitor_modes: ['listen'] } }));
    expect(dbm.updateUser).toHaveBeenCalledWith(7, expect.objectContaining({ role: 'admin', monitorModes: ['listen', 'whisper', 'barge'] }));
    expect(dbm.setUserGroups).not.toHaveBeenCalled();
    await ctl.apiUpdateUser(req({ params: { user_id: '7' }, body: { group_ids: [] } }));
    expect(dbm.setUserGroups).toHaveBeenCalledWith(7, []);
  });

  test('a password changes the sign-in password only, never the SIP secret', async () => {
    const r = req({ params: { user_id: '7' }, body: { password: 'newpass1' } });
    await ctl.apiUpdateUser(r);
    expect((r as { auditDetail?: unknown }).auditDetail).toEqual({
      before: { username: 'ann', extension: '100', role: 'supervisor' },
      changed: { password: '********' },
    });
    expect(dbm.updateUser).toHaveBeenCalledWith(7, expect.objectContaining({ password: 'newpass1' }));
    expect(dbm.setExtensionSecretInPbx).not.toHaveBeenCalled();
    // Nothing reached the PBX, so nothing to reload.
    expect(reloadAsteriskSip).not.toHaveBeenCalled();
  });

  test('the SIP rules no longer apply to the sign-in password', async () => {
    // Spaces, quotes and no digits are fine for signing in; the SIP secret is set elsewhere.
    await ctl.apiUpdateUser(req({ params: { user_id: '7' }, body: { password: 'has "space' } }));
    expect(dbm.updateUser).toHaveBeenCalledWith(7, expect.objectContaining({ password: 'has "space' }));
  });

  test('a sign-in password under 8 characters is a 400 before anything is written', async () => {
    const err = await ctl.apiUpdateUser(req({ params: { user_id: '7' }, body: { password: '1234' } })).catch((e) => e);
    expect(err).toMatchObject({ status: 400, message: 'The password needs at least 8 characters' });
    expect(dbm.updateUser).not.toHaveBeenCalled();
  });

  test('unlinking the extension locks the person out of it: a fresh random SIP secret, no name', async () => {
    const r = req({ params: { user_id: '7' }, body: { extension: '', password: 'newpass1', name: 'Bob' } });
    await ctl.apiUpdateUser(r);
    expect(dbm.setExtensionNameInPbx).not.toHaveBeenCalled();
    expect(dbm.setExtensionSecretInPbx).toHaveBeenCalledTimes(1);
    const [ext, secret] = mocked(dbm.setExtensionSecretInPbx).mock.calls[0];
    expect(ext).toBe('100');
    expect(secret).toMatch(/^[A-Za-z0-9]{16}$/);
    expect(secret).not.toBe('newpass1');
    expect(reloadAsteriskSip).toHaveBeenCalledTimes(1);
    expect((r as { auditDetail?: { sip_locked_extensions?: unknown } }).auditDetail?.sip_locked_extensions).toEqual(['100']);
  });

  test('moving to another extension replaces the old one\'s secret and names the new one', async () => {
    await ctl.apiUpdateUser(req({ params: { user_id: '7' }, body: { extension: '101', name: 'Ann' } }));
    expect(mocked(dbm.setExtensionSecretInPbx).mock.calls.map((c) => c[0])).toEqual(['100']);
    expect(dbm.setExtensionNameInPbx).toHaveBeenCalledWith('101', 'Ann');
    expect(reloadAsteriskSip).toHaveBeenCalledTimes(1); // one reload for both
  });

  test('re-saving the same extension touches no secret', async () => {
    await ctl.apiUpdateUser(req({ params: { user_id: '7' }, body: { extension: '100', role: 'agent' } }));
    expect(dbm.setExtensionSecretInPbx).not.toHaveBeenCalled();
    expect(reloadAsteriskSip).not.toHaveBeenCalled();
  });

  test('deactivating replaces the secret of the extension they keep; reactivating does not', async () => {
    await ctl.apiUpdateUser(req({ params: { user_id: '7' }, body: { is_active: false } }));
    expect(mocked(dbm.setExtensionSecretInPbx).mock.calls.map((c) => c[0])).toEqual(['100']);
    jest.clearAllMocks();
    mocked(dbm.getUserById).mockResolvedValue({ ...USER, is_active: 0 });
    await ctl.apiUpdateUser(req({ params: { user_id: '7' }, body: { is_active: true } }));
    expect(dbm.setExtensionSecretInPbx).not.toHaveBeenCalled();
  });

  test('an extension already gone from the PBX is skipped, not an error', async () => {
    mocked(dbm.extensionExistsInPbx).mockResolvedValue(false);
    await ctl.apiUpdateUser(req({ params: { user_id: '7' }, body: { extension: '' } }));
    expect(dbm.setExtensionSecretInPbx).not.toHaveBeenCalled();
    expect(reloadAsteriskSip).not.toHaveBeenCalled();
  });

  test.each([
    ['the secret write fails', () => mocked(dbm.setExtensionSecretInPbx).mockResolvedValue(false), /SIP password of extension 100 could not be replaced/],
    ['the PBX database is unreachable', () => mocked(dbm.extensionExistsInPbx).mockResolvedValue(null), /SIP password of extension 100 could not be replaced/],
    ['the reload fails', () => mocked(reloadAsteriskSip).mockResolvedValue(false), /PBX reload failed \(run 'fwconsole reload'\)/],
  ])('a save that misses the PBX is a 502 that says so (%s)', async (_label, arrange, message) => {
    arrange();
    const err = await ctl.apiUpdateUser(req({ params: { user_id: '7' }, body: { extension: '' } })).catch((e) => e);
    expect(err).toMatchObject({ status: 502 });
    expect(err.message).toMatch(/^User saved, but /);
    expect(err.message).toMatch(message);
    expect(dbm.updateUser).toHaveBeenCalled(); // OpDesk's side did land
  });

  test('a display name the PBX refuses is a 502', async () => {
    mocked(dbm.setExtensionNameInPbx).mockResolvedValue(false);
    await expect(ctl.apiUpdateUser(req({ params: { user_id: '7' }, body: { name: 'Bob' } }))).rejects.toMatchObject({
      status: 502,
      message: 'User saved, but the display name of extension 100 was not updated in the PBX.',
    });
  });

  test('create refuses a sign-in password under 8 characters', async () => {
    const err = await ctl.apiCreateUser(req({ body: { username: 'bo', password: '1234', extension: '101' } })).catch((e) => e);
    expect(err).toMatchObject({ status: 400 });
    expect(dbm.createUser).not.toHaveBeenCalled();
  });

  test("another user's username or extension is a 409", async () => {
    mocked(dbm.getUserByUsername).mockResolvedValue({ id: 9 });
    await expect(ctl.apiUpdateUser(req({ params: { user_id: '7' }, body: { username: 'bob' } }))).rejects.toMatchObject({ status: 409 });
    mocked(dbm.getUserByUsername).mockResolvedValue(null);
    mocked(dbm.getUserByExtension).mockResolvedValue({ id: 9 });
    await expect(ctl.apiUpdateUser(req({ params: { user_id: '7' }, body: { extension: '101' } }))).rejects.toMatchObject({ status: 409 });
    expect(dbm.updateUser).not.toHaveBeenCalled();
  });

  test('keeping your own username/extension is fine', async () => {
    mocked(dbm.getUserByUsername).mockResolvedValue({ id: 7 });
    mocked(dbm.getUserByExtension).mockResolvedValue({ id: 7 });
    await ctl.apiUpdateUser(req({ params: { user_id: '7' }, body: { username: 'ann', extension: '100' } }));
    expect(dbm.updateUser).toHaveBeenCalled();
  });

  test('a blank username is refused, a failed write is a 500', async () => {
    await expect(ctl.apiUpdateUser(req({ params: { user_id: '7' }, body: { username: ' ' } }))).rejects.toMatchObject({ status: 400 });
    mocked(dbm.updateUser).mockResolvedValue(false);
    await expect(ctl.apiUpdateUser(req({ params: { user_id: '7' }, body: { name: 'x' } }))).rejects.toMatchObject({
      status: 500,
      detail: { code: 'user.record.update_failed' },
    });
  });
});

describe('delete', () => {
  test('not yourself', async () => {
    await expect(ctl.apiDeleteUser(req({ params: { user_id: '1' } }))).rejects.toMatchObject({ status: 400, message: 'Cannot delete yourself' });
  });

  test('a user without an extension: nothing to lock, no reload', async () => {
    mocked(dbm.getUserById).mockResolvedValue({ ...USER, extension: null });
    mocked(dbm.deleteUser).mockResolvedValueOnce(true);
    await ctl.apiDeleteUser(req({ params: { user_id: '7' } }));
    expect(dbm.setExtensionSecretInPbx).not.toHaveBeenCalled();
    expect(reloadAsteriskSip).not.toHaveBeenCalled();
  });

  test('ok / 404 / 500', async () => {
    mocked(dbm.deleteUser).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const r = req({ params: { user_id: '7' } });
    expect(await ctl.apiDeleteUser(r)).toEqual({ ok: true });
    expect((r as { auditDetail?: unknown }).auditDetail).toEqual({
      deleted: { id: 7, username: 'ann', extension: '100', role: 'supervisor' },
      sip_locked_extensions: ['100'],
    });
    // The deleted person's secret no longer works on their extension.
    expect(mocked(dbm.setExtensionSecretInPbx).mock.calls.map((c) => c[0])).toEqual(['100']);
    expect(reloadAsteriskSip).toHaveBeenCalledTimes(1);
    await expect(ctl.apiDeleteUser(req({ params: { user_id: '7' } }))).rejects.toMatchObject({ status: 500, message: 'Failed to delete user' });
    mocked(dbm.getUserById).mockResolvedValue(null);
    await expect(ctl.apiDeleteUser(req({ params: { user_id: '7' } }))).rejects.toMatchObject({ status: 404 });
  });
});

describe('agents', () => {
  const AGENTS = [
    { extension: '100', name: 'Ann' },
    { extension: '101', name: '101' },
    { extension: '102', name: 'Cy' },
  ];

  test('syncs (with prune) from the live monitored set first', async () => {
    (runtime as { monitor: unknown }).monitor = { monitored: new Set(['100', '101']) };
    mocked(dbm.getAgentsList).mockResolvedValue(AGENTS);
    expect(await ctl.apiListAgents(req())).toEqual({ agents: AGENTS });
    expect(dbm.syncAgentsFromExtensions).toHaveBeenCalledWith(['100', '101'], { '100': 'Ann' }, true);
  });

  test('no monitor: no sync', async () => {
    mocked(dbm.getAgentsList).mockResolvedValue(AGENTS);
    await ctl.apiListAgents(req());
    expect(dbm.syncAgentsFromExtensions).not.toHaveBeenCalled();
  });

  test('non-admins see their own and allowed extensions only', async () => {
    mocked(dbm.getAgentsList).mockResolvedValue(AGENTS);
    const sup = { id: 4, role: 'supervisor', extension: '101', allowed_agent_extensions: ['102'] };
    expect((await ctl.apiListAgents(req({ principal: sup }))).agents.map((a: { extension: string }) => a.extension)).toEqual(['101', '102']);
    const agent = { id: 5, role: 'agent', extension: '100', allowed_agent_extensions: ['100'] };
    expect((await ctl.apiListAgents(req({ principal: agent }))).agents).toEqual([AGENTS[0]]);
  });
});

test('auth policies', () => {
  const proto = UsersController.prototype as unknown as Record<string, object>;
  for (const name of ['apiListUsers', 'apiGetUser', 'apiCreateUser', 'apiUpdateUser', 'apiDeleteUser']) {
    expect(Reflect.getMetadata(AUTH_POLICY, proto[name])).toBe('admin');
  }
  expect(Reflect.getMetadata(AUTH_POLICY, proto.apiListAgents)).toBe('user');
});
