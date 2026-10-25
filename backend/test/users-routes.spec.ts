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
    getExtensionNamesFromDb: jest.fn(async () => ({ '100': 'Ann' })),
    syncAgentsFromExtensions: jest.fn(),
    getAgentsList: jest.fn(),
    groupNameExists: jest.fn(),
  }));
jest.mock('../src/core/security', () => ({ principalOf: (req: { principal?: unknown }) => req.principal ?? null }));
jest.mock('../src/core/runtime', () => ({ runtime: { monitor: null } }));
jest.mock('../src/services/dialplan', () => ({ reloadAsteriskSip: jest.fn(async () => true) }));

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
  test('stores the user, its groups, and syncs the PBX extension', async () => {
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
    expect(dbm.setExtensionSecretInPbx).toHaveBeenCalledWith('100', 'pw123456');
    expect(dbm.setExtensionNameInPbx).toHaveBeenCalledWith('100', 'Ann');
    expect(reloadAsteriskSip).toHaveBeenCalledTimes(1);
    expect(out.monitor_mode).toBe('whisper');
  });

  test('an admin gets every monitor mode; the legacy single mode still works', async () => {
    mocked(dbm.createUser).mockResolvedValue(7);
    await ctl.apiCreateUser(req({ body: { username: 'a', password: 'p', role: 'admin', monitor_modes: [] } }));
    expect(mocked(dbm.createUser).mock.calls[0][2].monitorModes).toEqual(['listen', 'whisper', 'barge']);
    await ctl.apiCreateUser(req({ body: { username: 'b', password: 'p', monitor_mode: 'barge' } }));
    expect(mocked(dbm.createUser).mock.calls[1][2].monitorModes).toEqual(['barge']);
    // No extension: nothing to sync, no reload.
    expect(reloadAsteriskSip).not.toHaveBeenCalled();
  });

  test.each([
    [{ username: ' ', password: 'p' }, 'Username required'],
    [{ username: 'a', password: ' ' }, 'Password required'],
  ])('%j -> 400 %s', async (body, message) => {
    await expect(ctl.apiCreateUser(req({ body }))).rejects.toMatchObject({ status: 400, message });
  });

  test('a taken username or extension is a 409 (user.record.conflict)', async () => {
    mocked(dbm.createUser).mockResolvedValue(null);
    await expect(ctl.apiCreateUser(req({ body: { username: 'ann', password: 'p' } }))).rejects.toMatchObject({
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

  test('a password goes to the existing extension as its SIP secret', async () => {
    const r = req({ params: { user_id: '7' }, body: { password: 'newpass1' } });
    await ctl.apiUpdateUser(r);
    expect((r as { auditDetail?: unknown }).auditDetail).toEqual({
      before: { username: 'ann', extension: '100', role: 'supervisor' },
      changed: { password: '********' },
    });
    expect(dbm.setExtensionSecretInPbx).toHaveBeenCalledWith('100', 'newpass1');
    expect(reloadAsteriskSip).toHaveBeenCalledTimes(1);
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

  test('ok / 404 / 500', async () => {
    mocked(dbm.deleteUser).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const r = req({ params: { user_id: '7' } });
    expect(await ctl.apiDeleteUser(r)).toEqual({ ok: true });
    expect((r as { auditDetail?: unknown }).auditDetail).toEqual({ deleted: { id: 7, username: 'ann', extension: '100', role: 'supervisor' } });
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
