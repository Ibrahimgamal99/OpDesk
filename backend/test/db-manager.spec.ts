/**
 * Unit tests for the db-manager sections (pbx, users, groups, platform, ops) with the
 * MySQL pool mocked: each test routes SQL text to canned rows and asserts on the
 * statements issued. The behaviours covered are the ones where OpDesk deliberately
 * differs from a naive port: null-vs-[] on a PBX read failure, opt-in pruning, the
 * '\n' binding hash, opd_ keys, system pause reasons, UPDATE-only PBX names.
 */

jest.mock('../src/db/pool', () => {
  const actual = jest.requireActual('../src/db/pool');
  return {
    ...actual,
    query: jest.fn(),
    queryOne: jest.fn(),
    execute: jest.fn(),
    withConnection: jest.fn(),
    withTransaction: jest.fn(),
  };
});

import * as pool from '../src/db/pool';
import { setLogLevel } from '../src/core/logger';
import * as pbx from '../src/db/manager/pbx';
import * as users from '../src/db/manager/users';
import * as groups from '../src/db/manager/groups';
import * as platform from '../src/db/manager/platform';
import * as ops from '../src/db/manager/ops';

const q = pool.query as jest.Mock;
const q1 = pool.queryOne as jest.Mock;
const ex = pool.execute as jest.Mock;
const withConn = pool.withConnection as jest.Mock;
const withTx = pool.withTransaction as jest.Mock;

const CONN = { beginTransaction: jest.fn(), commit: jest.fn(), rollback: jest.fn(async () => undefined) };

type Handler = (params: unknown[]) => unknown;

/** Route every statement by regex; an unmatched statement fails the test loudly. */
function route(handlers: [RegExp, Handler][]): void {
  const pick = (sql: string, params: unknown[]) => {
    for (const [re, fn] of handlers) if (re.test(sql)) return fn(params);
    throw new Error(`unexpected SQL: ${sql}`);
  };
  q.mockImplementation(async (sql: string, params: unknown[] = []) => pick(sql, params));
  q1.mockImplementation(async (sql: string, params: unknown[] = []) => pick(sql, params));
  ex.mockImplementation(async (sql: string, params: unknown[] = []) => pick(sql, params) ?? { affectedRows: 1, insertId: 1 });
}

function dbError(errno: number, message = 'db error'): Error {
  return Object.assign(new Error(message), { errno, sqlState: 'HY000', code: 'ER_X' });
}

const executed = () => ex.mock.calls.map((c) => String(c[0]));

beforeAll(() => setLogLevel('CRITICAL'));

beforeEach(() => {
  jest.resetAllMocks();
  withConn.mockImplementation(async (fn: (c: unknown) => unknown) => fn(CONN));
  withTx.mockImplementation(async (fn: (c: unknown) => unknown) => fn(CONN));
});

// ---------------------------------------------------------------------------
// pbx
// ---------------------------------------------------------------------------

describe('getExtensionsFromDb', () => {
  it('returns null when both the users and ps_endpoints reads fail', async () => {
    route([[/FROM users|FROM ps_endpoints/, () => { throw dbError(1146); }]]);
    expect(await pbx.getExtensionsFromDb()).toBeNull();
  });

  it('returns [] (a read that worked) when users is empty and ps_endpoints is missing', async () => {
    route([
      [/FROM users/, () => []],
      [/FROM ps_endpoints/, () => { throw dbError(1146); }],
    ]);
    expect(await pbx.getExtensionsFromDb()).toEqual([]);
  });

  it('returns null when the connection itself fails', async () => {
    withConn.mockRejectedValue(dbError(2003, 'connect ECONNREFUSED'));
    expect(await pbx.getExtensionsFromDb()).toBeNull();
  });

  it('falls back to numeric ps_endpoints ids when users has none', async () => {
    route([
      [/FROM users/, () => { throw dbError(1146); }],
      [/FROM ps_endpoints/, () => [{ id: '1001' }, { id: 1002 }]],
    ]);
    expect(await pbx.getExtensionsFromDb()).toEqual(['1001', '1002']);
  });
});

describe('getExtensionNamesFromDb', () => {
  it('tops users.name up from ps_endpoints per extension', async () => {
    route([
      [/FROM users/, () => [{ extension: '1001', name: 'Alice' }, { extension: '1002', name: '' }]],
      [/FROM ps_endpoints/, () => [{ id: '1001', description: 'Other' }, { id: '1002', description: 'Bob' }]],
    ]);
    expect(await pbx.getExtensionNamesFromDb()).toEqual({ '1001': 'Alice', '1002': 'Bob' });
  });
});

describe('setExtensionNameInPbx', () => {
  it('only ever UPDATEs asterisk.users (never inserts a bare row)', async () => {
    route([[/^UPDATE users SET name/, () => ({ affectedRows: 0 })]]);
    expect(await pbx.setExtensionNameInPbx('1001', 'Alice')).toBe(true);
    expect(executed()).toEqual(['UPDATE users SET name = ? WHERE extension = ?']);
    expect(ex.mock.calls[0][2]).toBe('pbx');
  });
});

describe('setExtensionWebrtc', () => {
  afterEach(() => pbx.setSipReloader(undefined as unknown as null));

  it('returns false when no OpDesk user has the extension', async () => {
    route([[/SELECT 1 AS found FROM users/, () => null]]);
    expect(await pbx.setExtensionWebrtc('1001', true, 'FreePBX')).toBe(false);
    expect(ex).not.toHaveBeenCalled();
  });

  it('FreePBX: updates the four keywords, maps certman and reloads when something changed', async () => {
    const reload = jest.fn();
    pbx.setSipReloader(reload);
    route([
      [/SELECT 1 AS found FROM users/, () => ({ found: 1 })],
      [/^UPDATE users SET webrtc/, () => ({ affectedRows: 0 })],
      [/^UPDATE sip SET data/, () => ({ affectedRows: 1 })],
      [/^REPLACE INTO certman_mapping/, () => ({ affectedRows: 1 })],
    ]);
    expect(await pbx.setExtensionWebrtc('1001', true, 'FreePBX')).toBe(true);
    const keywords = ex.mock.calls.filter((c) => /^UPDATE sip/.test(c[0])).map((c) => c[1][2]);
    expect(keywords).toEqual(['rtcp_mux', 'avpf', 'icesupport', 'media_encryption']);
    expect(reload).toHaveBeenCalledWith('FreePBX');
  });

  it('FreePBX without certman_mapping still succeeds', async () => {
    pbx.setSipReloader(null);
    route([
      [/SELECT 1 AS found FROM users/, () => ({ found: 1 })],
      [/^UPDATE users SET webrtc/, () => ({ affectedRows: 1 })],
      [/^UPDATE sip SET data/, () => ({ affectedRows: 1 })],
      [/certman_mapping/, () => { throw dbError(1146); }],
    ]);
    expect(await pbx.setExtensionWebrtc('1001', false, 'FreePBX')).toBe(true);
  });

  it('Issabel: inserts missing keyword rows with its own spellings and codec order', async () => {
    pbx.setSipReloader(null);
    route([
      [/SELECT 1 AS found FROM users/, () => ({ found: 1 })],
      [/^UPDATE users SET webrtc/, () => ({ affectedRows: 1 })],
      [/SELECT 1 AS found FROM sip/, () => null],
      [/^INSERT INTO sip/, () => ({ affectedRows: 1 })],
    ]);
    expect(await pbx.setExtensionWebrtc('1001', true, 'Issabel')).toBe(true);
    const inserted = Object.fromEntries(ex.mock.calls.filter((c) => /^INSERT INTO sip/.test(c[0])).map((c) => [c[1][1], c[1][2]]));
    expect(inserted.allow).toBe('ulaw,alaw,g722,gsm,vp9,vp8,h264,opus');
    expect(inserted.ice_support).toBe('yes');
    expect(inserted.use_avpf).toBe('yes');
    expect(inserted.transport).toBe('transport-wss');
    expect(executed().some((s) => /certman/.test(s))).toBe(false);
  });
});

describe('getPbxDefaultCodecs', () => {
  it('reads FreePBX priorities in order', async () => {
    route([[/kvstore_Sipsettings/, () => ({ val: '{"alaw": 2, "opus": 1, "ulaw": 3}' })]]);
    expect(await pbx.getPbxDefaultCodecs()).toEqual(['opus', 'alaw', 'ulaw']);
  });

  it('is [] on Issabel (no kvstore table) and null on a real outage', async () => {
    route([[/kvstore_Sipsettings/, () => { throw dbError(1146); }]]);
    expect(await pbx.getPbxDefaultCodecs()).toEqual([]);
    route([[/kvstore_Sipsettings/, () => { throw dbError(2013); }]]);
    expect(await pbx.getPbxDefaultCodecs()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// users
// ---------------------------------------------------------------------------

describe('authenticateUser', () => {
  const row = (over: Record<string, unknown> = {}) => ({
    id: 7,
    username: 'alice',
    extension: '1001',
    name: 'Alice A',
    role: 'agent',
    is_active: 1,
    password_hash: '',
    ...over,
  });

  it('accepts a Python $2b$ hash, falls back to the extension, returns name and stamps the login', async () => {
    const hash = await users.hashUserPassword('s3cret');
    route([
      [/WHERE username = \?/, () => null],
      [/WHERE extension = \?/, () => row({ password_hash: hash.replace(/^\$2a\$/, '$2b$') })],
      [/^UPDATE users SET last_login_at/, () => ({ affectedRows: 1 })],
    ]);
    expect(await users.authenticateUser(' 1001 ', 's3cret')).toEqual({
      id: 7,
      username: 'alice',
      extension: '1001',
      name: 'Alice A',
      role: 'agent',
    });
    expect(executed()).toContain('UPDATE users SET last_login_at = NOW() WHERE id = ?');
  });

  it('refuses inactive accounts and wrong passwords', async () => {
    const hash = await users.hashUserPassword('s3cret');
    route([[/WHERE username = \?/, () => row({ password_hash: hash, is_active: 0 })]]);
    expect(await users.authenticateUser('alice', 's3cret')).toBeNull();
    route([[/WHERE username = \?/, () => row({ password_hash: hash })]]);
    expect(await users.authenticateUser('alice', 'nope')).toBeNull();
  });
});

describe('getUserLiveScope', () => {
  it('unions user_groups and group_agents membership and puts the own extension first', async () => {
    route([
      [/SELECT extension FROM users WHERE id/, () => ({ extension: '1001' })],
      [/FROM user_groups WHERE user_id = \? UNION SELECT group_id FROM group_agents/, (p) => {
        expect(p).toEqual([5, '1001']);
        return [{ group_id: 1 }, { group_id: 2 }];
      }],
      [/SELECT DISTINCT agent_ext FROM group_agents/, () => [{ agent_ext: '1002' }, { agent_ext: '1001' }, { agent_ext: '1003' }]],
      [/SELECT DISTINCT q.extension FROM group_queues/, () => [{ extension: '600' }, { extension: 601 }]],
    ]);
    expect(await users.getUserLiveScope(5)).toEqual({
      agent_extensions: ['1001', '1002', '1003'],
      queue_names: ['600', '601'],
      group_ids: [1, 2],
    });
  });

  it('narrows to the own extension on a DB error', async () => {
    route([
      [/SELECT extension FROM users WHERE id/, () => ({ extension: '1001' })],
      [/UNION/, () => { throw dbError(2013); }],
    ]);
    expect(await users.getUserLiveScope(5)).toEqual({ agent_extensions: ['1001'], queue_names: [], group_ids: [] });
  });
});

describe('createUser', () => {
  it('refuses a duplicate username without inserting', async () => {
    route([[/WHERE username = \?/, () => ({ id: 1 })]]);
    expect(await users.createUser('alice', 'pw')).toBeNull();
    expect(ex).not.toHaveBeenCalled();
  });

  it('stores a bcrypt hash, defaults the role, and sets the monitor modes', async () => {
    route([
      [/WHERE (username|extension) = \?/, () => null],
      [/^INSERT INTO users/, () => ({ insertId: 42, affectedRows: 1 })],
      [/user_monitor_modes/, () => ({ affectedRows: 1 })],
    ]);
    expect(await users.createUser(' bob ', 'pw', { role: 'nonsense', extension: ' 1005 ' })).toBe(42);
    const ins = ex.mock.calls.find((c) => /^INSERT INTO users/.test(c[0]));
    expect(ins[1][0]).toBe('bob');
    expect(ins[1][1]).toBe('1005');
    expect(String(ins[1][2])).toMatch(/^\$2[aby]\$12\$/);
    expect(ins[1][4]).toBe('supervisor');
    const modes = ex.mock.calls.filter((c) => /^INSERT INTO user_monitor_modes/.test(c[0])).map((c) => c[1][1]);
    expect(modes).toEqual(['listen']);
  });
});

// ---------------------------------------------------------------------------
// groups
// ---------------------------------------------------------------------------

describe('getGroupsList', () => {
  it('returns OpDesk membership (user_groups only) for every visible group', async () => {
    route([
      [/SELECT id, name FROM groups WHERE name NOT LIKE 'user\\_%'/, () => [{ id: 1, name: 'A' }, { id: 2, name: 'B' }]],
      [/FROM group_agents WHERE group_id IN/, () => [{ group_id: 1, agent_ext: '1001' }]],
      [/FROM group_queues gq JOIN queues/, () => [{ group_id: 2, extension: '600', queue_name: 'Sales' }]],
      [/FROM user_groups WHERE group_id IN/, () => [{ group_id: 1, user_id: 9 }]],
    ]);
    expect(await groups.getGroupsList()).toEqual([
      { id: 1, name: 'A', agent_extensions: ['1001'], queues: [], user_ids: [9] },
      { id: 2, name: 'B', agent_extensions: [], queues: [{ extension: '600', queue_name: 'Sales' }], user_ids: [] },
    ]);
  });
});

describe('setGroupQueues', () => {
  it('skips the default queue and creates queue rows inside one transaction', async () => {
    route([[/./, () => ({ affectedRows: 1 })]]);
    expect(await groups.setGroupQueues(3, ['600', 'default', ' ', 601])).toBe(true);
    expect(withTx).toHaveBeenCalledTimes(1);
    const linked = ex.mock.calls.filter((c) => /^INSERT INTO group_queues/.test(c[0])).map((c) => c[1][1]);
    expect(linked).toEqual(['600', '601']);
  });

  it('rolls back (returns false) when a row fails', async () => {
    route([
      [/^DELETE FROM group_queues/, () => ({ affectedRows: 0 })],
      [/^INSERT INTO queues/, () => ({ affectedRows: 1 })],
      [/^INSERT INTO group_queues/, () => { throw dbError(1452); }],
    ]);
    expect(await groups.setGroupQueues(3, ['600'])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// platform
// ---------------------------------------------------------------------------

describe('sipPushBindingHash', () => {
  it("joins with '\\n' exactly as the stored hashes were computed", () => {
    // hashlib.sha256('\n'.join((ext, provider, prid, param or ''))) from Python.
    expect(platform.sipPushBindingHash('1001', 'fcm', 'tok123', null)).toBe(
      '43fc86277ff654b2db885605e4d816a2ce2c67b713a7d24455b19bfddb776430',
    );
    expect(platform.sipPushBindingHash('1001', 'apns', 'tok123', 'com.app.voip')).toBe(
      '3bf52006699f061a3d8085367426b56549a1d2362a4aafd955d9420480d8faee',
    );
  });
});

describe('listSipPushBindings', () => {
  it('accepts the positional extension and adds no LIMIT', async () => {
    route([[/FROM sip_push_bindings/, () => []]]);
    await platform.listSipPushBindings('1001');
    expect(q.mock.calls[0][0]).toMatch(/WHERE extension = \? ORDER BY last_seen_at DESC$/);
    expect(q.mock.calls[0][1]).toEqual(['1001']);
    await platform.listSipPushBindings({ limit: 10 });
    expect(q.mock.calls[1][0]).toMatch(/LIMIT \?$/);
  });
});

describe('API keys', () => {
  it('creates opd_ keys with a 12-char prefix, a SHA-256 hash and Python-formatted scopes', async () => {
    let inserted: unknown[] = [];
    route([
      [/^INSERT INTO api_keys/, (p) => {
        inserted = p;
        return { insertId: 3, affectedRows: 1 };
      }],
      [/FROM api_keys WHERE id = \?/, () => ({
        id: 3, name: 'n', key_prefix: inserted[1], key_hash: inserted[2], scopes: inserted[3], enabled: 1,
        created_by: 1, last_used_at: null, expires_at: new Date(2027, 0, 2, 0, 0, 0), created_at: new Date(2026, 9, 25, 12, 0, 0),
      })],
    ]);
    const key = await platform.createApiKey('n', ['cdr:read', 'calls:write'], { createdBy: 1, expiresAt: '2027-01-02' });
    expect(key?.key).toMatch(/^opd_[0-9a-f]{40}$/);
    expect(inserted[1]).toBe(String(key?.key).slice(0, 12));
    expect(inserted[2]).toBe(platform.hashApiKey(String(key?.key)));
    expect(inserted[3]).toBe('["cdr:read", "calls:write"]');
    expect(inserted[5]).toBe('2027-01-02 00:00:00');
    expect(key).toMatchObject({ enabled: true, scopes: ['cdr:read', 'calls:write'], expires_at: '2027-01-02T00:00:00' });
    expect(key).not.toHaveProperty('key_hash');
  });

  it('lookupApiKey ignores keys without the opd_ prefix', async () => {
    expect(await platform.lookupApiKey('xyz_abc')).toBeNull();
    expect(q1).not.toHaveBeenCalled();
    expect(platform.hashApiKey('opd_abc')).toBe('e8fbcfc9302f56dc7a8ce34de28dded9e69024d6618eac1aa8491129ecce08e7');
  });

  it('normalizeExpiry handles dates, ISO datetimes and blanks', () => {
    expect(platform.normalizeExpiry('2027-01-02T10:11:12.345Z')).toBe('2027-01-02 10:11:12');
    expect(platform.normalizeExpiry('2027-01-02')).toBe('2027-01-02 00:00:00');
    expect(platform.normalizeExpiry('  ')).toBeNull();
  });
});

describe('webhook deliveries', () => {
  it('lists newest first with a lookahead row for has_more and a clamped limit', async () => {
    route([[/FROM webhook_deliveries/, (p) => {
      expect(p[p.length - 1]).toBe(201); // limit clamped to 200, +1 lookahead
      return Array.from({ length: 201 }, (_, i) => ({ id: 300 - i, success: 1, truncated: 0, created_at: new Date(2026, 0, 1) }));
    }]]);
    const [rows, more] = await platform.listWebhookDeliveries({ limit: 999, afterId: 301, dateTo: '2026-01-31' });
    expect(rows).toHaveLength(200);
    expect(more).toBe(true);
    expect(rows[0]).toMatchObject({ success: true, truncated: false, created_at: '2026-01-01T00:00:00' });
    expect(q.mock.calls[0][0]).toMatch(/created_at < DATE_ADD\(\?, INTERVAL 1 DAY\) AND id < \?/);
  });

  it('clips oversized bodies and flags a clipped request body', async () => {
    route([[/^INSERT INTO webhook_deliveries/, () => ({ insertId: 9, affectedRows: 1 })]]);
    const big = 'x'.repeat(platform.DELIVERY_BODY_MAX + 5);
    expect(await platform.insertWebhookDelivery({ url: 'https://crm/x', request_body: big, call_id: 'L1' })).toBe(9);
    const p = ex.mock.calls[0][1];
    expect(p[0]).toBe('L1');
    expect(String(p[8]).endsWith('…[truncated]')).toBe(true);
    expect(p[17]).toBe(1);
  });
});

describe('getSetting', () => {
  it('returns the fallback for a missing or empty value', async () => {
    route([[/FROM OpDesk_settings/, () => ({ setting_value: '' })]]);
    expect(await platform.getSetting('X', 'dflt')).toBe('dflt');
    route([[/FROM OpDesk_settings/, () => null]]);
    expect(await platform.getSetting('X')).toBeNull();
  });
});

describe('pruneStaleDeviceTokens', () => {
  it('prunes device tokens and RFC 8599 bindings together', async () => {
    route([
      [/^DELETE FROM device_tokens/, () => ({ affectedRows: 2 })],
      [/^DELETE FROM sip_push_bindings/, () => ({ affectedRows: 3 })],
    ]);
    expect(await platform.pruneStaleDeviceTokens(90)).toBe(5);
  });
});

describe('updateContact', () => {
  it('tells "no such id" from "nothing changed" and a duplicate number', async () => {
    route([
      [/^UPDATE contacts/, () => ({ affectedRows: 0 })],
      [/SELECT 1 AS found FROM contacts/, () => ({ found: 1 })],
    ]);
    expect(await platform.updateContact(1, 'A', '1', '1')).toBe(true);
    route([
      [/^UPDATE contacts/, () => ({ affectedRows: 0 })],
      [/SELECT 1 AS found FROM contacts/, () => null],
    ]);
    expect(await platform.updateContact(1, 'A', '1', '1')).toBe(false);
    route([[/^UPDATE contacts/, () => { throw dbError(1062); }]]);
    expect(await platform.updateContact(1, 'A', '1', '1')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// ops
// ---------------------------------------------------------------------------

describe('syncAgentsFromExtensions', () => {
  beforeEach(() => route([[/./, () => ({ affectedRows: 1 })]]));

  it('never prunes unless asked', async () => {
    await ops.syncAgentsFromExtensions(['1001', ' 1002 '], { '1001': 'Alice' });
    expect(executed().filter((s) => /DELETE/.test(s))).toEqual([]);
    expect(ex.mock.calls.map((c) => c[1])).toEqual([['1001', 'Alice'], ['1002', '1002']]);
  });

  it('prunes what is not in the list when prune is set (positional true = Python prune=True)', async () => {
    await ops.syncAgentsFromExtensions(['1001'], {}, true);
    expect(executed()).toContain('DELETE FROM agents WHERE extension NOT IN (?)');
  });

  it('an empty list does nothing unless pruneAllWhenEmpty', async () => {
    await ops.syncAgentsFromExtensions([], {}, { prune: true });
    expect(ex).not.toHaveBeenCalled();
    await ops.syncAgentsFromExtensions([], {}, { prune: true, pruneAllWhenEmpty: true });
    expect(executed()).toEqual(['DELETE FROM agents']);
  });
});

describe('syncQueuesFromList', () => {
  it("skips 'default' and never prunes it", async () => {
    route([[/./, () => ({ affectedRows: 1 })]]);
    await ops.syncQueuesFromList(['600', 'Default'], null, { prune: true });
    expect(ex.mock.calls[0][1]).toEqual(['600', '600']);
    expect(executed()[1]).toBe("DELETE FROM queues WHERE extension NOT IN (?) AND LOWER(extension) <> 'default'");
  });
});

describe('pause reasons', () => {
  const reason = (over: Record<string, unknown>) => ({ id: 1, code: 'lunch', label: 'Lunch', is_active: 1, is_system: 0, ...over });

  it('pauseReasonForNotReady accepts only active, non-system, existing codes', async () => {
    route([[/FROM pause_reasons WHERE code = \?/, (p) => ({
      lunch: reason({}),
      old: reason({ code: 'old', is_active: 0 }),
      __WRAPUP: reason({ code: '__WRAPUP', is_system: 1 }),
    } as Record<string, unknown>)[String(p[0])] ?? null]]);
    expect(await ops.pauseReasonForNotReady('lunch')).toMatchObject({ code: 'lunch' });
    expect(await ops.isValidNotReadyReason(' lunch ')).toBe(true);
    expect(await ops.isValidNotReadyReason('old')).toBe(false);
    expect(await ops.isValidNotReadyReason('__WRAPUP')).toBe(false);
    expect(await ops.isValidNotReadyReason('nope')).toBe(false);
    expect(await ops.isValidNotReadyReason('')).toBe(false);
  });

  it('pauseReasonList honours activeOnly / includeSystem', async () => {
    route([[/FROM pause_reasons/, () => []]]);
    await ops.pauseReasonList();
    await ops.pauseReasonList({ activeOnly: true, includeSystem: false });
    expect(q.mock.calls[0][0]).not.toMatch(/WHERE/);
    expect(q.mock.calls[1][0]).toMatch(/WHERE is_active = 1 AND is_system = 0 ORDER BY sort_order, label/);
  });

  it('pauseReasonUpdate refuses system rows, missing rows and empty updates', async () => {
    expect(await ops.pauseReasonUpdate(1, { code: 'x', is_system: 0 })).toBe(false);
    route([[/SELECT is_system FROM pause_reasons/, () => ({ is_system: 1 })]]);
    expect(await ops.pauseReasonUpdate(1, { label: 'X' })).toBe(false);
    route([[/SELECT is_system FROM pause_reasons/, () => null]]);
    expect(await ops.pauseReasonUpdate(1, { label: 'X' })).toBe(false);
    route([
      [/SELECT is_system FROM pause_reasons/, () => ({ is_system: 0 })],
      [/^UPDATE pause_reasons/, () => ({ affectedRows: 0 })],
    ]);
    expect(await ops.pauseReasonUpdate(1, { label: 'X', productive: 'yes', sort_order: '' })).toBe(true);
    const upd = ex.mock.calls.find((c) => /^UPDATE pause_reasons/.test(c[0]));
    expect(upd[0]).toBe('UPDATE pause_reasons SET label = ?, productive = ?, sort_order = ? WHERE id = ? AND is_system = 0');
    expect(upd[1]).toEqual(['X', 1, 100, 1]);
  });

  it('pauseReasonCreate takes Python positional args or a fields object, always non-system', async () => {
    route([[/^INSERT INTO pause_reasons/, () => ({ insertId: 8, affectedRows: 1 })]]);
    expect(await ops.pauseReasonCreate(' coffee ', 'Coffee', true, '#fff', '15', false)).toBe(8);
    expect(ex.mock.calls[0][1]).toEqual(['coffee', 'Coffee', 1, '#fff', 15, 0]);
    expect(await ops.pauseReasonCreate({ code: 'tea', label: 'Tea' })).toBe(8);
    expect(ex.mock.calls[1][1]).toEqual(['tea', 'Tea', 0, null, 100, 1]);
    expect(ex.mock.calls[1][0]).toMatch(/VALUES \(\?, \?, \?, \?, \?, \?, 0\)$/);
    expect(await ops.pauseReasonCreate('', 'x')).toBeNull();
  });
});

describe('agentActivityTransition', () => {
  it('closes the open segment and opens the next one in one transaction', async () => {
    route([
      [/^UPDATE agent_activity/, () => ({ affectedRows: 1 })],
      [/^INSERT INTO agent_activity/, () => ({ insertId: 77, affectedRows: 1 })],
    ]);
    expect(await ops.agentActivityTransition(' 1001 ', 'not_ready', { reasonCode: 'lunch' })).toBe(77);
    expect(withTx).toHaveBeenCalledTimes(1);
    expect(ex.mock.calls[1][1]).toEqual(['1001', 'not_ready', 'lunch', null, null, 'ui']);
  });

  it('logout (null state) only closes', async () => {
    route([[/^UPDATE agent_activity/, () => ({ affectedRows: 1 })]]);
    expect(await ops.agentActivityTransition('1001', null)).toBeNull();
    expect(ex).toHaveBeenCalledTimes(1);
  });
});

describe('supervision', () => {
  it('getSupervisionForTarget reads one monitored call oldest first', async () => {
    route([[/FROM call_supervision\s+WHERE target_linkedid = \?/, (p) => {
      expect(p).toEqual(['1700000000.1']);
      return [{ spy_linkedid: 's1', mode: 'listen' }];
    }]]);
    expect(await ops.getSupervisionForTarget('1700000000.1')).toEqual([{ spy_linkedid: 's1', mode: 'listen' }]);
    expect(await ops.getSupervisionForTarget('')).toEqual([]);
  });

  it('getSupervisionBySpyKeys keys rows by both spy ids', async () => {
    route([[/FROM call_supervision/, () => [{ spy_linkedid: 'L', spy_uniqueid: 'U', mode: 'barge' }]]]);
    const out = await ops.getSupervisionBySpyKeys(['L', null, 'U']);
    expect(Object.keys(out).sort()).toEqual(['L', 'U']);
  });

  it('recordSupervision coerces an unknown mode to listen', async () => {
    route([[/^INSERT INTO call_supervision/, () => ({ affectedRows: 1 })]]);
    expect(await ops.recordSupervision('S1', { mode: 'spy', targetLinkedid: 'T1' })).toBe(true);
    expect(ex.mock.calls[0][1]).toEqual(['S1', null, 'T1', null, null, 'listen']);
  });
});
