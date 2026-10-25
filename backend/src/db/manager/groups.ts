/**
 * Groups and their junction tables: group_agents (agent extensions), group_queues
 * (queue extensions) and user_groups (accounts).
 *
 * Groups named `user_<id>` are hidden per-user groups (setUserAgentsAndQueues). They
 * are excluded from the Groups screen and cannot be renamed or deleted through it.
 *
 * Membership semantics are OpDesk's: a group's `user_ids` are its user_groups rows
 * only. (Agents reach a group through their extension; that is the scope layer's
 * business -- see users.getUserLiveScope -- not this screen's.)
 */

import { getLogger, pyStr } from '../../core/logger';
import { pyInt, truthy } from '../../core/py';
import { execute, placeholders, query, queryOne, withConnection, withTransaction } from '../pool';
import type { Executor, Row } from '../pool';

const log = getLogger('db_manager');

export interface GroupQueue {
  extension: string;
  queue_name: string;
}

export interface Group {
  id: number;
  name: string;
  agent_extensions: string[];
  queues: GroupQueue[];
  user_ids: number[];
}

/**
 * Agents, queues and user ids for a set of group rows: three queries for the whole
 * list instead of Python's three per group. Same values, same per-group order
 * (agents and users in table order, queues in join order).
 */
async function expandGroups(rows: Row[], conn: Executor): Promise<Group[]> {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id as number);
  const ph = placeholders(ids.length);
  const agents = new Map<number, string[]>(ids.map((i) => [i, []]));
  const queues = new Map<number, GroupQueue[]>(ids.map((i) => [i, []]));
  const users = new Map<number, number[]>(ids.map((i) => [i, []]));
  for (const x of await query(`SELECT group_id, agent_ext FROM group_agents WHERE group_id IN (${ph})`, ids, conn)) {
    if (truthy(x.agent_ext)) agents.get(x.group_id)?.push(x.agent_ext);
  }
  for (const x of await query(
    `SELECT gq.group_id, q.extension, q.queue_name FROM group_queues gq JOIN queues q ON gq.queue_extension = q.extension WHERE gq.group_id IN (${ph})`,
    ids,
    conn,
  )) {
    queues.get(x.group_id)?.push({ extension: x.extension, queue_name: x.queue_name });
  }
  for (const x of await query(`SELECT group_id, user_id FROM user_groups WHERE group_id IN (${ph})`, ids, conn)) {
    users.get(x.group_id)?.push(x.user_id);
  }
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    agent_extensions: agents.get(r.id) ?? [],
    queues: queues.get(r.id) ?? [],
    user_ids: users.get(r.id) ?? [],
  }));
}

/** Every group except the hidden user_<id> ones, by name, with agents, queues and user ids. [] on error. */
export async function getGroupsList(): Promise<Group[]> {
  try {
    return await withConnection(async (conn) => {
      const rows = await query("SELECT id, name FROM groups WHERE name NOT LIKE 'user\\_%' ORDER BY name", [], conn);
      return expandGroups(rows, conn);
    });
  } catch (e) {
    log.warning('⚠️  Database error get_groups_list: %s', e);
    return [];
  }
}

/** One group by id (any group, as Python did), or null. */
export async function getGroup(groupId: number): Promise<Group | null> {
  try {
    return await withConnection(async (conn) => {
      const row = await queryOne('SELECT id, name FROM groups WHERE id = ?', [groupId], conn);
      if (!row) return null;
      return (await expandGroups([row], conn))[0];
    });
  } catch (e) {
    log.warning('⚠️  Database error get_group: %s', e);
    return null;
  }
}

/** True when a group with this name exists (other than `excludeId`): lets a route answer a conflict. */
export async function groupNameExists(name: string, excludeId: number | null = null): Promise<boolean> {
  const n = (name || '').trim();
  if (!n) return false;
  try {
    const row =
      excludeId === null
        ? await queryOne('SELECT id FROM groups WHERE name = ? LIMIT 1', [n])
        : await queryOne('SELECT id FROM groups WHERE name = ? AND id <> ? LIMIT 1', [n, excludeId]);
    return row !== null;
  } catch (e) {
    log.warning('⚠️  Database error group_name_exists: %s', e);
    return false;
  }
}

/** Create a group. Its id, or null for a blank or duplicate name or a DB error. */
export async function createGroup(name: string | null | undefined): Promise<number | null> {
  const n = (name || '').trim();
  if (!n) return null;
  try {
    return (await execute('INSERT INTO groups (name) VALUES (?)', [n])).insertId;
  } catch (e) {
    log.warning('⚠️  Database error create_group: %s', e);
    return null;
  }
}

/**
 * Rename a group (never a user_<id> group). True when a row changed; renaming to the
 * current name reads false, as in Python (rowcount counted changed rows there too).
 */
export async function updateGroup(groupId: number, name: string | null | undefined): Promise<boolean> {
  const n = (name || '').trim();
  if (!n || !groupId) return false;
  try {
    const res = await execute("UPDATE groups SET name = ? WHERE id = ? AND name NOT LIKE 'user\\_%'", [n, groupId]);
    return res.affectedRows > 0;
  } catch (e) {
    log.warning('⚠️  Database error update_group: %s', e);
    return false;
  }
}

/**
 * Replace a group's agents, creating agent rows as needed. Transactional: any row error
 * rolls back the whole replacement, so a group is never left with a partial member set.
 */
export async function setGroupAgents(groupId: number, agentExtensions: unknown[] | null | undefined): Promise<boolean> {
  if (!groupId) return false;
  try {
    await withTransaction(async (conn) => {
      await execute('DELETE FROM group_agents WHERE group_id = ?', [groupId], conn);
      for (const raw of agentExtensions || []) {
        const ext = pyStr(raw).trim();
        if (!ext) continue;
        await execute('INSERT IGNORE INTO agents (extension, name) VALUES (?, ?)', [ext, ext], conn);
        await execute('INSERT INTO group_agents (group_id, agent_ext) VALUES (?, ?)', [groupId, ext], conn);
      }
    });
    return true;
  } catch (e) {
    log.warning('⚠️  Database error set_group_agents: %s', e);
    return false;
  }
}

/** Replace a group's queues by extension, creating queue rows as needed ('default' skipped). Transactional. */
export async function setGroupQueues(groupId: number, queueExtensions: unknown[] | null | undefined): Promise<boolean> {
  if (!groupId) return false;
  try {
    await withTransaction(async (conn) => {
      await execute('DELETE FROM group_queues WHERE group_id = ?', [groupId], conn);
      for (const raw of queueExtensions || []) {
        const qext = pyStr(raw).trim();
        if (!qext || qext.toLowerCase() === 'default') continue;
        await execute(
          'INSERT INTO queues (extension, queue_name) VALUES (?, ?) ON DUPLICATE KEY UPDATE queue_name = VALUES(queue_name)',
          [qext, qext],
          conn,
        );
        await execute('INSERT INTO group_queues (group_id, queue_extension) VALUES (?, ?)', [groupId, qext], conn);
      }
    });
    return true;
  } catch (e) {
    log.warning('⚠️  Database error set_group_queues: %s', e);
    return false;
  }
}

/** int(x) for an id list; null where Python's int() raised (the id is skipped). */
function intOrSkip(x: unknown): number | null {
  return pyInt(x);
}

/** Replace which users belong to a group. Non-integer ids are skipped up front. Transactional. */
export async function setGroupUsers(groupId: number, userIds: unknown[] | null | undefined): Promise<boolean> {
  if (!groupId) return false;
  const clean = (userIds || []).map(intOrSkip).filter((x): x is number => x !== null);
  try {
    await withTransaction(async (conn) => {
      await execute('DELETE FROM user_groups WHERE group_id = ?', [groupId], conn);
      for (const uid of clean) {
        await execute('INSERT INTO user_groups (user_id, group_id) VALUES (?, ?)', [uid, groupId], conn);
      }
    });
    return true;
  } catch (e) {
    log.warning('⚠️  Database error set_group_users: %s', e);
    return false;
  }
}

/**
 * Replace the groups a user belongs to. This also drops the user from any user_<id>
 * group (every user_groups row of the user is replaced). Transactional.
 */
export async function setUserGroups(userId: number, groupIds: unknown[] | null | undefined): Promise<boolean> {
  if (!userId) return false;
  const clean = (groupIds || []).map(intOrSkip).filter((x): x is number => x !== null);
  try {
    await withTransaction(async (conn) => {
      await execute('DELETE FROM user_groups WHERE user_id = ?', [userId], conn);
      for (const gid of clean) {
        await execute('INSERT INTO user_groups (user_id, group_id) VALUES (?, ?)', [userId, gid], conn);
      }
    });
    return true;
  } catch (e) {
    log.warning('⚠️  Database error set_user_groups: %s', e);
    return false;
  }
}

/** Delete a group (never a user_<id> group); CASCADE removes its junction rows. True when deleted. */
export async function deleteGroup(groupId: number): Promise<boolean> {
  if (!groupId) return false;
  try {
    const res = await execute("DELETE FROM groups WHERE id = ? AND name NOT LIKE 'user\\_%'", [groupId]);
    return res.affectedRows > 0;
  } catch (e) {
    log.warning('⚠️  Database error delete_group: %s', e);
    return false;
  }
}
