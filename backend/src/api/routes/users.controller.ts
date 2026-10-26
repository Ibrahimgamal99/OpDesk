/** Settings: user management (admin only), and the agent list the settings forms pick from. */

import { Controller, Req } from '@nestjs/common';
import type { Request } from 'express';
import { setRedactedAuditDetail } from '../../core/audit';
import { getLogger } from '../../core/logger';
import { runtime } from '../../core/runtime';
import * as dbm from '../../db/db-manager';
import type { Row } from '../../db/pool';
import { pbxApplyCommand, reloadAsteriskSip } from '../../services/dialplan';
import { HttpError } from '../http-error';
import { Auth, Delete, Get, Post, Put, principal } from '../routing';
import { parseBody, pInt, v } from '../validation';
import { refreshLiveScopes } from './groups.controller';
import { generateSipSecret, pbxSetting } from './softphone.controller';

export const log = getLogger('api.routes.users');

// ---------------------------------------------------------------------------
// Settings: User management (admin only), agents & queues for selection
// ---------------------------------------------------------------------------
export const CreateUserBody = v.model({
  username: v.str(),
  password: v.str(),
  name: v.str().nullish(),
  extension: v.str().nullish(),
  role: v.str().default('supervisor'),
  monitor_mode: v.str().nullish(), // legacy single; use monitor_modes
  monitor_modes: v.list().nullish(), // list of 'listen','whisper','barge'
  group_ids: v.list().nullish(), // access via groups (replaces per-user agents/queues)
});

export const UpdateUserBody = v.model({
  username: v.str().nullish(),
  name: v.str().nullish(),
  extension: v.str().nullish(),
  role: v.str().nullish(),
  is_active: v.bool().nullish(),
  monitor_mode: v.str().nullish(),
  monitor_modes: v.list().nullish(), // list of 'listen','whisper','barge'
  password: v.str().nullish(),
  group_ids: v.list().nullish(), // access via groups
});

/** Admins always get every supervision mode, whatever the form sent. */
export const ALL_MONITOR_MODES = ['listen', 'whisper', 'barge'];

const CONFLICT = 'Username or extension already in use';

/**
 * The OpDesk sign-in password an admin sets: the same floor as POST /api/me/password. It is
 * the sign-in password only; the extension's SIP secret is set on its own
 * (PUT /api/settings/extensions/:ext/credentials), so the two never have to match.
 */
function assertLoginPassword(password: string | null | undefined): void {
  if (password && Array.from(password).length < 8) throw new HttpError(400, 'The password needs at least 8 characters');
}

/**
 * A users row as the Users panel reads it: the row (with monitor_modes) plus the agents,
 * queues and groups reached through user_groups, and `monitor_mode` -- the first of
 * monitor_modes. The panel has always read that legacy single-mode key; FastAPI never sent
 * it, so the panel fell back to its default.
 */
export async function userOut(user: Row): Promise<Row> {
  const [agents, queues] = await dbm.getUserAgentsAndQueues(user.id);
  const groupIds = await dbm.getUserGroupIds(user.id);
  const modes: string[] = Array.isArray(user.monitor_modes) ? user.monitor_modes : [];
  return {
    ...user,
    monitor_mode: modes[0] ?? 'listen',
    agent_extensions: agents,
    queue_names: queues,
    group_ids: groupIds,
  };
}

/** monitor_modes as strings (the Python body took any list and filtered on write). */
function modeList(raw: unknown[] | null | undefined): string[] | null {
  return raw === null || raw === undefined ? null : raw.map(String);
}

/** getattr(monitor, "monitored", None), truthy -> its extensions; else null. */
export function monitoredExtensions(): string[] | null {
  const monitored = runtime.monitor?.monitored;
  if (!monitored || !monitored.size) return null;
  return [...monitored].map(String);
}

/**
 * Apply a user save to the PBX with at most one reload, and say what did not apply ([] when
 * everything did):
 *
 *   * `name` becomes the display name of `nameExt`;
 *   * every extension in `retire` gets a fresh random SIP secret nobody knows. These are the
 *     extensions the person must no longer reach -- unlinked, moved off, deactivated or
 *     deleted -- whose secret they may still have (My Profile, the mobile QR). Every phone
 *     on such an extension signs out; an admin sets a new SIP password for whoever takes it.
 *
 * The sign-in password is never written here: it and the SIP secret are separate.
 */
async function applyToPbx(opts: { nameExt?: string | null; name?: string | null; retire?: string[] }): Promise<string[]> {
  const problems: string[] = [];
  let changed = false;
  if (opts.nameExt && opts.name) {
    if (await dbm.setExtensionNameInPbx(opts.nameExt, opts.name)) changed = true;
    else problems.push(`the display name of extension ${opts.nameExt} was not updated in the PBX`);
  }
  for (const ext of opts.retire ?? []) {
    const exists = await dbm.extensionExistsInPbx(ext);
    if (exists === false) continue; // gone from the PBX: nothing to lock
    if (exists && (await dbm.setExtensionSecretInPbx(ext, generateSipSecret()))) {
      log.info('SIP secret of extension %s replaced: its user no longer holds it', ext);
      changed = true;
    } else {
      problems.push(`the SIP password of extension ${ext} could not be replaced, so its old one still works`);
    }
  }
  if (changed) {
    const pbx = await pbxSetting();
    if (!(await reloadAsteriskSip(pbx))) problems.push(`the PBX reload failed (run '${pbxApplyCommand(pbx)}')`);
  }
  return problems;
}

/** The 502 for a save that landed in OpDesk but not (fully) in the PBX. */
function pbxProblem(what: string, problems: string[]): HttpError {
  return new HttpError(502, `${what}, but ${problems.join('; ')}.`);
}

@Controller()
export class UsersController {
  /** List all users, ordered by username. */
  @Get('/api/settings/users')
  @Auth('admin')
  async apiListUsers() {
    const users = await dbm.getAllUsers();
    const out: Row[] = [];
    for (const u of users) out.push(await userOut(u));
    return { users: out };
  }

  /** Get one user with agents, queues, and group_ids. */
  @Get('/api/settings/users/:user_id')
  @Auth('admin')
  async apiGetUser(@Req() req: Request) {
    const userId = pInt(req.params.user_id, 'user_id');
    const user = await dbm.getUserById(userId);
    if (!user) throw new HttpError(404, 'User not found');
    return userOut(user);
  }

  /**
   * Create a user and assign their groups. With an extension, the name becomes its PBX
   * display name; the extension keeps its SIP secret (the password is for OpDesk only). A taken username or
   * extension is a 409 user.record.conflict (FastAPI answered 400 with the same code).
   * Answers 200, not 201, as before.
   */
  @Post('/api/settings/users')
  @Auth('admin')
  async apiCreateUser(@Req() req: Request) {
    const body = parseBody(CreateUserBody, req.body);
    const username = (body.username || '').trim();
    if (!username) throw new HttpError(400, 'Username required');
    if (!(body.password || '').trim()) throw new HttpError(400, 'Password required');
    const role = body.role || 'supervisor';
    let monitorModes = modeList(body.monitor_modes);
    if (monitorModes === null && body.monitor_mode) monitorModes = [body.monitor_mode];
    if (role === 'admin') monitorModes = [...ALL_MONITOR_MODES];
    assertLoginPassword(body.password);
    const userId = await dbm.createUser(username, body.password, {
      name: body.name ?? null,
      extension: body.extension ?? null,
      role,
      monitorMode: body.monitor_mode || 'listen',
      monitorModes,
    });
    if (!userId) throw new HttpError(409, CONFLICT);
    await dbm.setUserGroups(userId, body.group_ids || []);
    const problems = await applyToPbx({ nameExt: (body.extension ?? '').trim(), name: body.name });
    await refreshLiveScopes();
    // `password` is masked by the redaction: the row says one was set, never what.
    setRedactedAuditDetail(req, {
      id: userId,
      username,
      name: body.name ?? null,
      extension: body.extension ?? null,
      role,
      monitor_modes: monitorModes,
      group_ids: body.group_ids || [],
      password: body.password,
    });
    if (problems.length) throw pbxProblem('User created', problems);
    const user = await dbm.getUserById(userId);
    if (!user) throw new HttpError(404, 'User not found');
    return userOut(user);
  }

  /**
   * Update a user and/or their groups. Every field is optional; group_ids replaces the
   * groups when sent. A username or extension another user holds is a 409 (FastAPI
   * silently kept the old values and answered 200).
   */
  @Put('/api/settings/users/:user_id')
  @Auth('admin')
  async apiUpdateUser(@Req() req: Request) {
    const userId = pInt(req.params.user_id, 'user_id');
    const body = parseBody(UpdateUserBody, req.body);
    const user = await dbm.getUserById(userId);
    if (!user) throw new HttpError(404, 'User not found');

    if (body.username !== null && body.username !== undefined) {
      const wanted = body.username.trim();
      // A blank username would lock the account out of sign-in.
      if (!wanted) throw new HttpError(400, 'Username required');
      const holder = await dbm.getUserByUsername(wanted);
      if (holder && holder.id !== userId) throw new HttpError(409, CONFLICT);
    }
    const wantedExt = (body.extension ?? '').trim();
    if (wantedExt) {
      const holder = await dbm.getUserByExtension(wantedExt);
      if (holder && holder.id !== userId) throw new HttpError(409, CONFLICT);
    }

    // The extension the save leaves the user with: an explicit '' unlinks it, so nothing
    // may be written to the extension they had.
    const effectiveExt = body.extension === null || body.extension === undefined ? user.extension : wantedExt;
    assertLoginPassword(body.password);

    const effectiveRole = body.role !== null && body.role !== undefined ? body.role : user.role;
    let monitorModes = modeList(body.monitor_modes);
    if (effectiveRole === 'admin') monitorModes = [...ALL_MONITOR_MODES];
    const ok = await dbm.updateUser(userId, {
      username: body.username ?? null,
      name: body.name ?? null,
      extension: body.extension ?? null,
      role: body.role ?? null,
      isActive: body.is_active ?? null,
      monitorMode: body.monitor_mode ?? null,
      monitorModes,
      password: body.password ?? null,
    });
    if (!ok) throw new HttpError(500, { code: 'user.record.update_failed', message: 'Failed to update user' });
    if (body.group_ids !== null && body.group_ids !== undefined) await dbm.setUserGroups(userId, body.group_ids);
    // Extensions this save takes away from the person: the one they had, when it is unlinked or
    // replaced, and the one they keep, when the account is switched off.
    const oldExt = String(user.extension ?? '').trim();
    const keptExt = String(effectiveExt ?? '').trim();
    const retire: string[] = [];
    if (oldExt && oldExt !== keptExt) retire.push(oldExt);
    if (body.is_active === false && user.is_active && keptExt) retire.push(keptExt);
    const problems = await applyToPbx({ nameExt: keptExt, name: body.name, retire });
    await refreshLiveScopes();
    // Only the fields the request carried; a password is reported as set, never shown.
    const sent: Record<string, unknown> = {};
    for (const k of ['username', 'name', 'extension', 'role', 'is_active', 'monitor_mode', 'monitor_modes', 'group_ids', 'password'] as const) {
      if (body[k] !== null && body[k] !== undefined) sent[k] = body[k];
    }
    setRedactedAuditDetail(req, {
      before: { username: user.username, extension: user.extension ?? null, role: user.role },
      changed: sent,
      ...(retire.length ? { sip_locked_extensions: retire } : {}),
    });
    if (problems.length) throw pbxProblem('User saved', problems);
    const updated = await dbm.getUserById(userId);
    if (!updated) throw new HttpError(404, 'User not found');
    return userOut(updated);
  }

  /** Delete a user (not yourself). */
  @Delete('/api/settings/users/:user_id')
  @Auth('admin')
  async apiDeleteUser(@Req() req: Request) {
    const userId = pInt(req.params.user_id, 'user_id');
    if (principal(req).id === userId) throw new HttpError(400, 'Cannot delete yourself');
    const user = await dbm.getUserById(userId);
    if (!user) throw new HttpError(404, 'User not found');
    if (!(await dbm.deleteUser(userId))) throw new HttpError(500, 'Failed to delete user');
    // The person keeps no way onto their extension: its secret is one they may still have.
    const ext = String(user.extension ?? '').trim();
    const problems = ext ? await applyToPbx({ retire: [ext] }) : [];
    await refreshLiveScopes();
    setRedactedAuditDetail(req, {
      deleted: { id: userId, username: user.username, extension: user.extension ?? null, role: user.role },
      ...(ext ? { sip_locked_extensions: [ext] } : {}),
    });
    if (problems.length) throw pbxProblem('User deleted', problems);
    return { ok: true };
  }

  /**
   * Extensions/agents for the settings pickers. Syncs the agents table from the live
   * monitored set first (pruning extensions the PBX no longer has).
   *
   * Scoped by role like /api/settings/extensions/webrtc: admin sees all; anyone else sees
   * their own extension plus allowed_agent_extensions.
   */
  @Get('/api/settings/agents')
  @Auth('user')
  async apiListAgents(@Req() req: Request) {
    const currentUser = principal(req);
    let exts = monitoredExtensions();
    if (exts) {
      const names = await dbm.getExtensionNamesFromDb();
      // Prune against the live PBX set so agents deleted in FreePBX/Issabel drop out of
      // the selection lists (the empty-list guard keeps a failed read safe).
      await dbm.syncAgentsFromExtensions(exts, names, true);
    }
    let agents = await dbm.getAgentsList();
    exts = monitoredExtensions();
    if (!agents.length && exts) {
      const names = await dbm.getExtensionNamesFromDb();
      await dbm.syncAgentsFromExtensions(exts, names);
      agents = await dbm.getAgentsList();
    }

    if (currentUser.role === 'admin') return { agents };

    // Non-admins are scoped to their own extension + any explicitly allowed extensions.
    const allow = new Set<string>();
    if (currentUser.extension) allow.add(String(currentUser.extension));
    for (const e of currentUser.allowed_agent_extensions || []) allow.add(String(e));
    return { agents: agents.filter((a) => allow.has(String(a.extension))) };
  }
}
