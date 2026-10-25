/**
 * OpDesk users (the `users` table of the app database): sign-in lookups, password
 * hashing, admin user management, monitor modes, the WebRTC credential lookup, and the
 * agent/queue scope data the visibility rules are built from.
 *
 * Accounts sign in by username or extension with a bcrypt password (`$2b$` hashes
 * written by Python's bcrypt verify unchanged under bcryptjs).
 */

import * as bcrypt from 'bcryptjs';
import type { PoolConnection } from 'mysql2/promise';
import { getLogger, pyStr } from '../../core/logger';
import { truthy } from '../../core/py';
import { execute, isDbError, placeholders, query, queryOne, withConnection, withTransaction } from '../pool';
import type { Executor, Row, SqlValue } from '../pool';

const log = getLogger('db_manager');

/** bcrypt.gensalt() default work factor. */
export const BCRYPT_ROUNDS = 12;

export const VALID_ROLES = ['admin', 'supervisor', 'agent'] as const;
export type UserRole = (typeof VALID_ROLES)[number];

export const VALID_MONITOR_MODES = ['listen', 'whisper', 'barge'] as const;

function isValidMonitorMode(m: unknown): m is string {
  return (VALID_MONITOR_MODES as readonly unknown[]).includes(m);
}

/** A users row as the auth lookups return it (password_hash included). */
export interface AuthUserRow extends Row {
  id: number;
  username: string;
  extension: string | null;
  name: string | null;
  role: UserRole;
  password_hash: string | null;
  is_active: number;
}

/** A users row without the hash, plus the monitor modes. */
export interface UserWithModes extends Row {
  id: number;
  username: string;
  extension: string | null;
  name: string | null;
  role: UserRole;
  is_active: number;
  monitor_modes: string[];
}

const AUTH_COLS = 'id, username, extension, name, role, password_hash, is_active';
const PUBLIC_COLS = 'id, username, extension, name, role, is_active';

/** `(s or '').strip() or None` */
function strippedOrNull(v: unknown): string | null {
  const s = truthy(v) ? pyStr(v).trim() : '';
  return s || null;
}

/** bcrypt hash of a password, as Python's bcrypt.hashpw(pw, gensalt()). */
export async function hashUserPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

/** User by username, with password_hash and name. null when absent or on error. */
export async function getUserByUsername(username: string): Promise<AuthUserRow | null> {
  try {
    return await queryOne<AuthUserRow>(`SELECT ${AUTH_COLS} FROM users WHERE username = ?`, [username]);
  } catch (e) {
    log.warning('⚠️  Database error get_user_by_username: %s', e);
    return null;
  }
}

/** User by extension, with password_hash and name. null for a blank extension, absent row or error. */
export async function getUserByExtension(extension: string | null | undefined): Promise<AuthUserRow | null> {
  if (!extension || !String(extension).trim()) return null;
  try {
    return await queryOne<AuthUserRow>(`SELECT ${AUTH_COLS} FROM users WHERE extension = ?`, [String(extension).trim()]);
  } catch (e) {
    log.warning('⚠️  Database error get_user_by_extension: %s', e);
    return null;
  }
}

/** Plain password against a bcrypt hash. False for empty input or a malformed hash. */
export async function verifyUserPassword(passwordHash: string | null | undefined, password: string | null | undefined): Promise<boolean> {
  if (!passwordHash || !password) return false;
  try {
    return await bcrypt.compare(password, passwordHash);
  } catch (e) {
    log.debug('Password verify failed: %s', e);
    return false;
  }
}

/** Stamp last_login_at. Never raises. */
export async function updateLastLogin(userId: number): Promise<void> {
  try {
    await execute('UPDATE users SET last_login_at = NOW() WHERE id = ?', [userId]);
  } catch (e) {
    log.warning('⚠️  Database error update_last_login: %s', e);
  }
}

export interface AuthenticatedUser {
  id: number;
  username: string;
  extension: string | null;
  name: string | null;
  role: UserRole;
}

/**
 * Authenticate by username or extension and password. Returns
 * {id, username, extension, name, role} (never the hash) or null. Inactive accounts
 * fail. Stamps last_login_at on success.
 */
export async function authenticateUser(login: string | null | undefined, password: string | null | undefined): Promise<AuthenticatedUser | null> {
  if (!login || !password) return null;
  const who = String(login).trim();
  let user = await getUserByUsername(who);
  if (!user) user = await getUserByExtension(who);
  if (!user) return null;
  // user.get('is_active', 1): a NULL column reads as inactive, like Python's falsy None.
  if (!truthy(user.is_active)) return null;
  if (!(await verifyUserPassword(user.password_hash || '', password))) return null;
  await updateLastLogin(user.id);
  return {
    id: user.id,
    username: user.username,
    extension: user.extension ?? null,
    name: user.name ?? null,
    role: user.role,
  };
}

// ---------------------------------------------------------------------------
// User management (admin)
// ---------------------------------------------------------------------------

/** Monitor modes of many users in one query: user_id -> valid modes (default ['listen']). */
async function monitorModesFor(userIds: number[], target: Executor = 'app'): Promise<Map<number, string[]>> {
  const out = new Map<number, string[]>(userIds.map((id) => [id, []]));
  if (userIds.length) {
    try {
      const rows = await query(
        `SELECT user_id, mode FROM user_monitor_modes WHERE user_id IN (${placeholders(userIds.length)}) ORDER BY user_id, mode`,
        userIds,
        target,
      );
      for (const r of rows) {
        if (isValidMonitorMode(r.mode)) out.get(r.user_id)?.push(r.mode);
      }
    } catch (e) {
      log.warning('⚠️  Database error get_user_monitor_modes: %s', e);
    }
  }
  for (const [id, modes] of out) if (!modes.length) out.set(id, ['listen']);
  return out;
}

/** All users (no hash) ordered by username, each with monitor_modes. [] on error. */
export async function getAllUsers(): Promise<UserWithModes[]> {
  try {
    const rows = await query(`SELECT ${PUBLIC_COLS} FROM users ORDER BY username`);
    const modes = await monitorModesFor(rows.map((r) => r.id as number));
    return rows.map((r) => ({ ...r, monitor_modes: modes.get(r.id) ?? ['listen'] }) as UserWithModes);
  } catch (e) {
    log.warning('⚠️  Database error get_all_users: %s', e);
    return [];
  }
}

export interface CreateUserOptions {
  name?: string | null;
  extension?: string | null;
  role?: string | null;
  monitorMode?: string | null;
  monitorModes?: string[] | null;
}

/**
 * Create a user. Returns the new id, or null for a blank/duplicate username, a
 * duplicate extension, or a DB error. An unknown role becomes 'supervisor'. Monitor
 * modes: `monitorModes` when given, else [monitorMode || 'listen'].
 */
export async function createUser(username: string, password: string | null | undefined, opts: CreateUserOptions = {}): Promise<number | null> {
  if (!username || !username.trim()) return null;
  const uname = username.trim();
  if (await getUserByUsername(uname)) return null;
  const extension = opts.extension ?? null;
  if (extension !== null && String(extension).trim()) {
    if (await getUserByExtension(String(extension).trim())) return null;
  }
  let passwordHash: string;
  try {
    passwordHash = await hashUserPassword(password || '');
  } catch (e) {
    log.warning('Password hash failed: %s', e);
    return null;
  }
  const role = opts.role && (VALID_ROLES as readonly string[]).includes(opts.role) ? opts.role : 'supervisor';
  let userId: number;
  try {
    const res = await execute('INSERT INTO users (username, extension, password_hash, name, role) VALUES (?, ?, ?, ?, ?)', [
      uname,
      strippedOrNull(extension),
      passwordHash,
      strippedOrNull(opts.name),
      role,
    ]);
    userId = res.insertId;
  } catch (e) {
    log.warning('⚠️  Database error create_user: %s', e);
    return null;
  }
  if (opts.monitorModes !== null && opts.monitorModes !== undefined) await setUserMonitorModes(userId, opts.monitorModes);
  else await setUserMonitorModes(userId, [opts.monitorMode || 'listen']);
  return userId;
}

export interface UpdateUserOptions {
  username?: string | null;
  name?: string | null;
  extension?: string | null;
  role?: string | null;
  isActive?: boolean | null;
  monitorMode?: string | null;
  monitorModes?: string[] | null;
  password?: string | null;
}

/**
 * Update a user; only the given fields change. The row is chosen by `userId`, or by
 * `extension` when userId is null (Python's fallback). An unknown role is ignored, an
 * empty password leaves the hash alone. True on success (including "nothing to change").
 * Duplicate username/extension raise an integrity error inside, so this returns false.
 */
export async function updateUser(userId: number | null, opts: UpdateUserOptions = {}): Promise<boolean> {
  const updates: string[] = [];
  const params: SqlValue[] = [];
  if (opts.username !== null && opts.username !== undefined) {
    updates.push('username = ?');
    params.push(opts.username.trim());
  }
  if (opts.name !== null && opts.name !== undefined) {
    updates.push('name = ?');
    params.push(strippedOrNull(opts.name));
  }
  if (opts.extension !== null && opts.extension !== undefined) {
    updates.push('extension = ?');
    params.push(pyStr(opts.extension).trim() || null);
  }
  if (opts.role && (VALID_ROLES as readonly string[]).includes(opts.role)) {
    updates.push('role = ?');
    params.push(opts.role);
  }
  if (opts.isActive !== null && opts.isActive !== undefined) {
    updates.push('is_active = ?');
    params.push(opts.isActive ? 1 : 0);
  }
  if (opts.password) {
    try {
      const hash = await hashUserPassword(opts.password);
      updates.push('password_hash = ?');
      params.push(hash);
    } catch {
      /* Python: pass */
    }
  }
  try {
    if (updates.length) {
      let where: string | null = null;
      if (userId !== null && userId !== undefined) {
        where = 'id = ?';
        params.push(userId);
      } else if (opts.extension !== null && opts.extension !== undefined) {
        where = 'extension = ?';
        params.push(pyStr(opts.extension).trim() || null);
      }
      if (where) await execute(`UPDATE users SET ${updates.join(', ')} WHERE ${where}`, params);
    }
    if (opts.monitorModes !== null && opts.monitorModes !== undefined) {
      await setUserMonitorModes(userId, opts.monitorModes);
    }
    return true;
  } catch (e) {
    log.warning('⚠️  Database error update_user: %s', e);
    return false;
  }
}

/** Delete a user with their group assignments and monitor modes, in one transaction. */
export async function deleteUser(userId: number): Promise<boolean> {
  try {
    await withTransaction(async (conn) => {
      await execute('DELETE FROM user_groups WHERE user_id = ?', [userId], conn);
      try {
        await execute('DELETE FROM user_monitor_modes WHERE user_id = ?', [userId], conn);
      } catch {
        /* table may be missing on an old install */
      }
      await execute('DELETE FROM users WHERE id = ?', [userId], conn);
    });
    return true;
  } catch (e) {
    log.warning('⚠️  Database error delete_user: %s', e);
    return false;
  }
}

/** Monitor modes of one user. ['listen'] when none are set or on error. */
export async function getUserMonitorModes(userId: number): Promise<string[]> {
  return (await monitorModesFor([userId])).get(userId) ?? ['listen'];
}

/** Replace a user's monitor modes (invalid ones dropped; none valid -> ['listen']). */
export async function setUserMonitorModes(userId: number | null | undefined, modes: readonly unknown[] | null | undefined): Promise<boolean> {
  if (!truthy(userId)) return false;
  let valid = (modes || []).filter(isValidMonitorMode);
  if (!valid.length) valid = ['listen'];
  try {
    await withTransaction(async (conn) => {
      await execute('DELETE FROM user_monitor_modes WHERE user_id = ?', [userId as number], conn);
      for (const m of valid) {
        await execute('INSERT INTO user_monitor_modes (user_id, mode) VALUES (?, ?)', [userId as number, m], conn);
      }
    });
    return true;
  } catch (e) {
    log.warning('⚠️  Database error set_user_monitor_modes: %s', e);
    return false;
  }
}

/** {extension} of a user (WebRTC softphone), or null when the user does not exist. */
export async function getUserWebrtcCredentials(userId: number): Promise<{ extension: string | null } | null> {
  try {
    const row = await queryOne('SELECT extension FROM users WHERE id = ?', [userId]);
    if (!row) return null;
    return { extension: row.extension ?? null };
  } catch (e) {
    log.warning('⚠️  Database error get_user_webrtc_credentials: %s', e);
    return null;
  }
}

/** User by id (no hash; includes name and monitor_modes), or null. */
export async function getUserById(userId: number): Promise<UserWithModes | null> {
  try {
    const row = await queryOne(`SELECT ${PUBLIC_COLS} FROM users WHERE id = ?`, [userId]);
    if (!row) return null;
    return { ...row, monitor_modes: await getUserMonitorModes(userId) } as UserWithModes;
  } catch (e) {
    log.warning('⚠️  Database error get_user_by_id: %s', e);
    return null;
  }
}

/**
 * Display name for an extension from the OpDesk users table, or null. Feeds the CRM
 * payload's agent_name and the CDR identity overlay.
 */
export async function getAgentNameByExtension(extension: string | null | undefined): Promise<string | null> {
  if (!extension) return null;
  try {
    const row = await queryOne("SELECT name FROM users WHERE extension = ? AND name IS NOT NULL AND name != '' LIMIT 1", [
      String(extension),
    ]);
    return row ? row.name || null : null;
  } catch (e) {
    log.warning('get_agent_name_by_extension(%s): %s', extension, e);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Scope data: which agents and queues a user reaches through groups
// ---------------------------------------------------------------------------

/** Group ids the user belongs to (user_groups), excluding the hidden user_<id> groups. */
export async function getUserGroupIds(userId: number): Promise<number[]> {
  try {
    const rows = await query(
      "SELECT g.id FROM user_groups ug JOIN groups g ON ug.group_id = g.id WHERE ug.user_id = ? AND g.name NOT LIKE 'user\\_%' ORDER BY g.name",
      [userId],
    );
    return rows.map((r) => r.id);
  } catch (e) {
    log.warning('⚠️  Database error get_user_group_ids: %s', e);
    return [];
  }
}

/** Distinct agent extensions and queue extensions of a set of groups, on one connection. */
async function membersOfGroups(groupIds: SqlValue[], conn: Executor): Promise<[string[], string[]]> {
  if (!groupIds.length) return [[], []];
  const ph = placeholders(groupIds.length);
  const agents = (await query(`SELECT DISTINCT agent_ext FROM group_agents WHERE group_id IN (${ph})`, groupIds, conn))
    .filter((r) => truthy(r.agent_ext))
    .map((r) => pyStr(r.agent_ext));
  const queues = (
    await query(
      `SELECT DISTINCT q.extension FROM group_queues gq JOIN queues q ON gq.queue_extension = q.extension WHERE gq.group_id IN (${ph})`,
      groupIds,
      conn,
    )
  )
    .filter((r) => truthy(r.extension))
    .map((r) => pyStr(r.extension));
  return [agents, queues];
}

/**
 * [agent extensions, queue extensions] the user reaches through user_groups (the
 * supervisor scope). Queue values are queue *extensions*, the key the live queue state
 * uses. [[], []] on error or with no groups.
 */
export async function getUserAgentsAndQueues(userId: number): Promise<[string[], string[]]> {
  try {
    return await withConnection(async (conn) => {
      const groupIds = (await query('SELECT group_id FROM user_groups WHERE user_id = ?', [userId], conn)).map(
        (r) => r.group_id as SqlValue,
      );
      return membersOfGroups(groupIds, conn);
    });
  } catch (e) {
    log.warning('⚠️  Database error get_user_agents_and_queues: %s', e);
    return [[], []];
  }
}

/** Group ids whose agent list contains this extension (group_agents). */
export async function getGroupIdsForAgent(extension: unknown): Promise<number[]> {
  const ext = truthy(extension) ? pyStr(extension).trim() : '';
  if (!ext) return [];
  try {
    return (await query('SELECT group_id FROM group_agents WHERE agent_ext = ?', [ext])).map((r) => r.group_id);
  } catch (e) {
    log.warning('get_group_ids_for_agent(%s): %s', ext, e);
    return [];
  }
}

/**
 * [peer agent extensions, queue extensions] across every group whose agent list
 * contains this extension. The extension itself is always included. An agent in no
 * group sees only themselves. On error, what was resolved so far is returned.
 */
export async function getAgentGroupScope(extension: unknown): Promise<[string[], string[]]> {
  const ext = truthy(extension) ? pyStr(extension).trim() : '';
  if (!ext) return [[], []];
  try {
    return await withConnection(async (conn) => {
      const groupIds = (await query('SELECT group_id FROM group_agents WHERE agent_ext = ?', [ext], conn)).map(
        (r) => r.group_id as SqlValue,
      );
      if (!groupIds.length) return [[ext], []];
      const [agents, queues] = await membersOfGroups(groupIds, conn);
      if (!agents.includes(ext)) agents.push(ext);
      return [agents, queues];
    });
  } catch (e) {
    log.warning('get_agent_group_scope(%s): %s', ext, e);
    return [[ext], []];
  }
}

/**
 * Queue extensions an agent may log in to / out of: the union of the queues of every
 * group that contains the agent's *extension* (group_agents -> group_queues). Keys off
 * the extension, not the account's user_groups: put a queue and an agent in the same
 * group and that agent can log in to it. [] when in no group or on error.
 */
export async function getAgentLoginQueues(agentExt: unknown): Promise<string[]> {
  const ext = truthy(agentExt) ? pyStr(agentExt).trim() : '';
  if (!ext) return [];
  try {
    return await withConnection(async (conn) => {
      const groupIds = (await query('SELECT group_id FROM group_agents WHERE agent_ext = ?', [ext], conn)).map(
        (r) => r.group_id as SqlValue,
      );
      return (await membersOfGroups(groupIds, conn))[1];
    });
  } catch (e) {
    log.warning('⚠️  Database error get_agent_login_queues: %s', e);
    return [];
  }
}

export interface UserLiveScope {
  /** Agent extensions the user may watch live: their own first, then every group peer. */
  agent_extensions: string[];
  /** Queue extensions (the key of the live queue state, despite the name) of those groups. */
  queue_names: string[];
  /** Every group that contributed (user_groups or group_agents membership). */
  group_ids: number[];
}

/**
 * The LIVE scope of a user (core/scope's agent rule): the user's own extension plus the
 * agent extensions and queues of every group the user belongs to -- either explicitly
 * (a user_groups row) or through their extension (a group_agents row).
 *
 * Never wider than the data says: on a DB error only the user's own extension is
 * returned, which is the narrowest correct answer for a live panel.
 */
export async function getUserLiveScope(userId: number): Promise<UserLiveScope> {
  let ownExt: string | null = null;
  try {
    return await withConnection(async (conn) => {
      const user = await queryOne('SELECT extension FROM users WHERE id = ?', [userId], conn);
      ownExt = user && truthy(user.extension) ? pyStr(user.extension).trim() || null : null;
      const groupRows = await query(
        'SELECT group_id FROM user_groups WHERE user_id = ? ' +
          'UNION SELECT group_id FROM group_agents WHERE agent_ext = ? ORDER BY group_id',
        [userId, ownExt ?? ''],
        conn,
      );
      const groupIds = groupRows.map((r) => r.group_id as number);
      const [agents, queues] = await membersOfGroups(groupIds, conn);
      const agentExtensions = ownExt ? [ownExt, ...agents.filter((a) => a !== ownExt)] : agents;
      return { agent_extensions: agentExtensions, queue_names: queues, group_ids: groupIds };
    });
  } catch (e) {
    log.warning('⚠️  Database error get_user_live_scope(%s): %s', userId, e);
    return { agent_extensions: ownExt ? [ownExt] : [], queue_names: [], group_ids: [] };
  }
}

/**
 * Set which agents and queues a user can access through a hidden per-user group
 * `user_<id>` (created when missing), replacing its members. Agents and queues are
 * created in the OpDesk tables as needed. No caller today (Python kept it as well).
 */
export async function setUserAgentsAndQueues(
  userId: number,
  agentExtensions: unknown[] | null | undefined,
  queueNames: unknown[] | null | undefined,
): Promise<boolean> {
  if (!truthy(userId)) return false;
  try {
    await withConnection(async (conn: PoolConnection) => {
      const groupName = `user_${pyStr(userId)}`;
      const row = await queryOne('SELECT id FROM groups WHERE name = ?', [groupName], conn);
      // Python committed the new group on its own; autocommit does the same here.
      const groupId: number = row ? row.id : (await execute('INSERT INTO groups (name) VALUES (?)', [groupName], conn)).insertId;
      await conn.beginTransaction();
      try {
        await execute('DELETE FROM user_groups WHERE user_id = ?', [userId], conn);
        await execute('INSERT INTO user_groups (user_id, group_id) VALUES (?, ?)', [userId, groupId], conn);
        await execute('DELETE FROM group_agents WHERE group_id = ?', [groupId], conn);
        await execute('DELETE FROM group_queues WHERE group_id = ?', [groupId], conn);
        for (const raw of agentExtensions || []) {
          const ext = pyStr(raw).trim();
          if (!ext) continue;
          try {
            await execute('INSERT IGNORE INTO agents (extension, name) VALUES (?, ?)', [ext, ext], conn);
            await execute('INSERT INTO group_agents (group_id, agent_ext) VALUES (?, ?)', [groupId, ext], conn);
          } catch {
            /* Python: pass (a failed statement does not abort the transaction) */
          }
        }
        for (const raw of queueNames || []) {
          const qname = (truthy(raw) ? pyStr(raw) : '').trim();
          if (!qname) continue;
          try {
            await execute(
              'INSERT INTO queues (extension, queue_name) VALUES (?, ?) ON DUPLICATE KEY UPDATE queue_name = VALUES(queue_name)',
              [qname, qname],
              conn,
            );
            await execute('INSERT INTO group_queues (group_id, queue_extension) VALUES (?, ?)', [groupId, qname], conn);
          } catch {
            /* Python: pass */
          }
        }
        await conn.commit();
      } catch (e) {
        await conn.rollback().catch(() => undefined);
        throw e;
      }
    });
    return true;
  } catch (e) {
    if (!isDbError(e)) throw e;
    log.warning('⚠️  Database error set_user_agents_and_queues: %s', e);
    return false;
  }
}
