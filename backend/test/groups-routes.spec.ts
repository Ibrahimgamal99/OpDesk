/** /api/settings/groups: membership updates, 409 on a taken name, 404s, live scope refresh. */

jest.mock(
  '../src/db/db-manager',
  () => ({
    getGroupsList: jest.fn(),
    getGroup: jest.fn(),
    groupNameExists: jest.fn(),
    createGroup: jest.fn(),
    updateGroup: jest.fn(),
    setGroupAgents: jest.fn(),
    setGroupQueues: jest.fn(),
    setGroupUsers: jest.fn(),
    deleteGroup: jest.fn(),
  }));
// pushScopeRefresh behind a getter, so one test can take it away.
const mockScope: { push: jest.Mock | undefined } = { push: jest.fn(async () => undefined) };
jest.mock('../src/core/security', () => ({
  principalOf: (req: { principal?: unknown }) => req.principal ?? null,
  get pushScopeRefresh() {
    return mockScope.push;
  },
  principalFromUserId: jest.fn(async (id: number) => ({ id, username: 'u', role: 'agent', extension: '100', monitor_modes: [] })),
}));
jest.mock('../src/core/runtime', () => ({ runtime: { manager: null, bridge: null } }));

import * as dbm from '../src/db/db-manager';
import { AUTH_POLICY } from '../src/api/routing';
import { runtime } from '../src/core/runtime';
import { GroupsController, refreshLiveScopes } from '../src/api/routes/groups.controller';

const ctl = new GroupsController();
const req = (over: Record<string, unknown> = {}) => ({ params: {}, query: {}, body: {}, principal: { id: 1, role: 'admin' }, ...over }) as never;
const mocked = (fn: unknown) => fn as jest.Mock;
const refresh = () => mockScope.push as jest.Mock;
const GROUP = { id: 5, name: 'Sales', agent_extensions: ['100'], queues: [], user_ids: [] };

beforeEach(() => {
  jest.clearAllMocks();
  mocked(dbm.groupNameExists).mockResolvedValue(false);
  mocked(dbm.getGroup).mockResolvedValue(GROUP);
});

test('list and get', async () => {
  mocked(dbm.getGroupsList).mockResolvedValue([GROUP]);
  expect(await ctl.apiListGroups()).toEqual({ groups: [GROUP] });
  expect(await ctl.apiGetGroup(req({ params: { group_id: '5' } }))).toEqual(GROUP);
  mocked(dbm.getGroup).mockResolvedValue(null);
  await expect(ctl.apiGetGroup(req({ params: { group_id: '6' } }))).rejects.toMatchObject({ status: 404, message: 'Group not found' });
});

describe('create', () => {
  test('sets the non-empty memberships and refreshes live scopes', async () => {
    mocked(dbm.createGroup).mockResolvedValue(5);
    const out = await ctl.apiCreateGroup(req({ body: { name: ' Sales ', agent_extensions: ['100'], queue_extensions: [], user_ids: [] } }));
    expect(out).toEqual(GROUP);
    expect(dbm.createGroup).toHaveBeenCalledWith('Sales');
    expect(dbm.setGroupAgents).toHaveBeenCalledWith(5, ['100']);
    // An empty queue list is skipped on create (FastAPI tested truthiness); user_ids [] is applied.
    expect(dbm.setGroupQueues).not.toHaveBeenCalled();
    expect(dbm.setGroupUsers).toHaveBeenCalledWith(5, []);
    expect(refresh()).toHaveBeenCalled();
  });

  test('blank name 400', async () => {
    await expect(ctl.apiCreateGroup(req({ body: { name: '  ' } }))).rejects.toMatchObject({ status: 400, message: 'Group name required' });
  });

  test('a taken name is a 409 (group.record.conflict)', async () => {
    mocked(dbm.groupNameExists).mockResolvedValue(true);
    await expect(ctl.apiCreateGroup(req({ body: { name: 'Sales' } }))).rejects.toMatchObject({ status: 409, message: 'Group name may already exist' });
    expect(dbm.createGroup).not.toHaveBeenCalled();
  });

  test('an insert that fails anyway is a 409 too', async () => {
    mocked(dbm.createGroup).mockResolvedValue(null);
    await expect(ctl.apiCreateGroup(req({ body: { name: 'Sales' } }))).rejects.toMatchObject({ status: 409 });
  });
});

describe('update', () => {
  test('lists sent replace membership, absent ones stay', async () => {
    await ctl.apiUpdateGroup(req({ params: { group_id: '5' }, body: { queue_extensions: [], user_ids: [3] } }));
    expect(dbm.setGroupAgents).not.toHaveBeenCalled();
    expect(dbm.setGroupQueues).toHaveBeenCalledWith(5, []);
    expect(dbm.setGroupUsers).toHaveBeenCalledWith(5, [3]);
    expect(dbm.updateGroup).not.toHaveBeenCalled();
  });

  test('renaming onto another group is a 409', async () => {
    mocked(dbm.groupNameExists).mockResolvedValue(true);
    await expect(ctl.apiUpdateGroup(req({ params: { group_id: '5' }, body: { name: 'Support' } }))).rejects.toMatchObject({ status: 409 });
    expect(dbm.groupNameExists).toHaveBeenCalledWith('Support', 5);
    expect(dbm.updateGroup).not.toHaveBeenCalled();
  });

  test('a blank name is ignored', async () => {
    await ctl.apiUpdateGroup(req({ params: { group_id: '5' }, body: { name: ' ' } }));
    expect(dbm.updateGroup).not.toHaveBeenCalled();
  });

  test('404 for an unknown group', async () => {
    mocked(dbm.getGroup).mockResolvedValue(null);
    await expect(ctl.apiUpdateGroup(req({ params: { group_id: '9' }, body: {} }))).rejects.toMatchObject({ status: 404 });
  });
});

test('delete: ok, or 404 for an unknown or auto group', async () => {
  mocked(dbm.deleteGroup).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  mocked(dbm.getGroup).mockResolvedValueOnce({ id: 5, name: 'Sales' });
  const r = req({ params: { group_id: '5' } });
  expect(await ctl.apiDeleteGroup(r)).toEqual({ ok: true });
  // What the delete took away, for the audit row.
  expect((r as { auditDetail?: unknown }).auditDetail).toEqual({ deleted: { id: 5, name: 'Sales' } });
  await expect(ctl.apiDeleteGroup(req({ params: { group_id: '5' } }))).rejects.toMatchObject({
    status: 404,
    message: 'Group not found or cannot delete',
  });
});

test('without pushScopeRefresh: connection scopes are re-resolved and state re-broadcast', async () => {
  const saved = mockScope.push;
  mockScope.push = undefined;
  try {
    const refreshScopes = jest.fn(async (resolve: (uid: number) => Promise<unknown>) => [[{}, await resolve(42)]]);
    const broadcastStateNow = jest.fn(async () => undefined);
    Object.assign(runtime as object, { manager: { refreshScopes }, bridge: { broadcastStateNow } });
    await refreshLiveScopes();
    expect(refreshScopes).toHaveBeenCalled();
    expect((await refreshScopes.mock.results[0].value)[0][1]).toMatchObject({ user_id: 42, extension: '100' });
    expect(broadcastStateNow).toHaveBeenCalled();
    // A failing refresh never fails the caller.
    refreshScopes.mockRejectedValueOnce(new Error('boom'));
    await expect(refreshLiveScopes()).resolves.toBeUndefined();
  } finally {
    mockScope.push = saved;
    Object.assign(runtime as object, { manager: null, bridge: null });
  }
});

test('every route is admin only', () => {
  const proto = GroupsController.prototype as unknown as Record<string, object>;
  for (const name of ['apiListGroups', 'apiGetGroup', 'apiCreateGroup', 'apiUpdateGroup', 'apiDeleteGroup']) {
    expect(Reflect.getMetadata(AUTH_POLICY, proto[name])).toBe('admin');
  }
});
