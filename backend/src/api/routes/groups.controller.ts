/**
 * Settings: groups (admin only). A group ties agent extensions and queues to the users who
 * supervise them; group membership is what the supervisor and agent scopes are built from.
 */

import { Controller, Req } from '@nestjs/common';
import type { Request } from 'express';
import { setRedactedAuditDetail } from '../../core/audit';
import { getLogger } from '../../core/logger';
import { runtime } from '../../core/runtime';
import * as security from '../../core/security';
import { ConnectionScope, scopeFromPrincipal } from '../../core/ws-manager';
import * as dbm from '../../db/db-manager';
import { HttpError } from '../http-error';
import { Auth, Delete, Get, Post, Put } from '../routing';
import { parseBody, pInt, v } from '../validation';

export const log = getLogger('api.routes.groups');

export const CreateGroupBody = v.model({
  name: v.str(),
  agent_extensions: v.list().nullish(),
  queue_extensions: v.list().nullish(),
  user_ids: v.list().nullish(),
});

export const UpdateGroupBody = v.model({
  name: v.str().nullish(),
  agent_extensions: v.list().nullish(),
  queue_extensions: v.list().nullish(),
  user_ids: v.list().nullish(),
});

/**
 * Re-resolve the scope of every open WebSocket after a membership change (a group's agents,
 * queues or users, or a user's role, extension or groups). A socket resolves its scope once
 * at connect, so without this an agent added to a group would see their new peers only
 * after a reload. FastAPI had the same gap.
 *
 * Uses security.pushScopeRefresh when the security module offers one; otherwise refreshes
 * the connection scopes itself and, when any changed, asks the state bridge for an
 * immediate broadcast (which is filtered per connection). Best effort: a failure here never
 * fails the admin's save.
 */
export async function refreshLiveScopes(): Promise<void> {
  try {
    const push = (security as unknown as { pushScopeRefresh?: () => Promise<void> }).pushScopeRefresh;
    if (typeof push === 'function') {
      await push();
      return;
    }
    const changed = await runtime.manager.refreshScopes(async (userId: number): Promise<ConnectionScope | null> => {
      const p = await security.principalFromUserId(userId);
      return p ? scopeFromPrincipal(p) : null;
    });
    if (changed.length && runtime.bridge) await runtime.bridge.broadcastStateNow();
  } catch (e) {
    log.warning('Could not refresh live scopes: %s', e);
  }
}

/**
 * 409 group.record.conflict when another group already carries this name (the column is
 * UNIQUE, case-insensitive). The DB would refuse the rename anyway, but update_group's
 * false also means "nothing changed", so it can't tell the route why.
 */
async function assertNameFree(name: string, exceptId: number | null): Promise<void> {
  if (await dbm.groupNameExists(name, exceptId)) throw new HttpError(409, 'Group name may already exist');
}

@Controller()
export class GroupsController {
  /** List all groups with agents, queues, and user ids. Auto `user_%` groups are hidden. */
  @Get('/api/settings/groups')
  @Auth('admin')
  async apiListGroups() {
    return { groups: await dbm.getGroupsList() };
  }

  /** Get one group (auto groups included). */
  @Get('/api/settings/groups/:group_id')
  @Auth('admin')
  async apiGetGroup(@Req() req: Request) {
    const groupId = pInt(req.params.group_id, 'group_id');
    const g = await dbm.getGroup(groupId);
    if (!g) throw new HttpError(404, 'Group not found');
    return g;
  }

  /**
   * Create a group with name, agents, queues, users. A duplicate name is a 409
   * group.record.conflict (FastAPI answered 400 with the same code).
   */
  @Post('/api/settings/groups')
  @Auth('admin')
  async apiCreateGroup(@Req() req: Request) {
    const body = parseBody(CreateGroupBody, req.body);
    const name = (body.name || '').trim();
    if (!name) throw new HttpError(400, 'Group name required');
    await assertNameFree(name, null);
    const gid = await dbm.createGroup(name);
    if (!gid) throw new HttpError(409, 'Group name may already exist');
    if (body.agent_extensions && body.agent_extensions.length) await dbm.setGroupAgents(gid, body.agent_extensions);
    if (body.queue_extensions && body.queue_extensions.length) await dbm.setGroupQueues(gid, body.queue_extensions);
    if (body.user_ids !== null && body.user_ids !== undefined) await dbm.setGroupUsers(gid, body.user_ids);
    await refreshLiveScopes();
    setRedactedAuditDetail(req, {
      id: gid,
      name,
      agent_extensions: body.agent_extensions ?? [],
      queue_extensions: body.queue_extensions ?? [],
      user_ids: body.user_ids ?? null,
    });
    return dbm.getGroup(gid);
  }

  /** Update group name, agents, queues, users. Each list sent replaces that membership. */
  @Put('/api/settings/groups/:group_id')
  @Auth('admin')
  async apiUpdateGroup(@Req() req: Request) {
    const groupId = pInt(req.params.group_id, 'group_id');
    const body = parseBody(UpdateGroupBody, req.body);
    const g = await dbm.getGroup(groupId);
    if (!g) throw new HttpError(404, 'Group not found');
    if (body.name !== null && body.name !== undefined) {
      // A blank name is ignored, as before.
      const name = (body.name || '').trim();
      if (name && name !== g.name) {
        await assertNameFree(name, groupId);
        await dbm.updateGroup(groupId, name);
      }
    }
    if (body.agent_extensions !== null && body.agent_extensions !== undefined) {
      await dbm.setGroupAgents(groupId, body.agent_extensions);
    }
    if (body.queue_extensions !== null && body.queue_extensions !== undefined) {
      await dbm.setGroupQueues(groupId, body.queue_extensions);
    }
    if (body.user_ids !== null && body.user_ids !== undefined) await dbm.setGroupUsers(groupId, body.user_ids);
    await refreshLiveScopes();
    // The lists sent replace the membership; the ones left out were not touched.
    setRedactedAuditDetail(req, {
      before: { name: g.name },
      name: body.name ?? null,
      agent_extensions: body.agent_extensions ?? null,
      queue_extensions: body.queue_extensions ?? null,
      user_ids: body.user_ids ?? null,
    });
    return dbm.getGroup(groupId);
  }

  /** Delete a group. Auto `user_%` groups cannot be deleted (404). */
  @Delete('/api/settings/groups/:group_id')
  @Auth('admin')
  async apiDeleteGroup(@Req() req: Request) {
    const groupId = pInt(req.params.group_id, 'group_id');
    const before = await dbm.getGroup(groupId);
    if (!(await dbm.deleteGroup(groupId))) throw new HttpError(404, 'Group not found or cannot delete');
    await refreshLiveScopes();
    setRedactedAuditDetail(req, { deleted: before ? { id: groupId, name: before.name } : { id: groupId } });
    return { ok: true };
  }
}
