/**
 * Agent presence over REST: Not-Ready reason catalog (R40-R43), the softphone header's
 * queue session (R44-R46 + GET /api/agent/status), per-extension DND (R39), and the
 * wrap-up / shift-reset settings. All bare JSON.
 *
 * Every presence change goes through the AgentStateManager (services/agent-state), so the
 * REST routes, the WebSocket agent_* actions and AMI feature codes share one state.
 */

import { Controller, Req } from '@nestjs/common';
import type { Request } from 'express';
import { setRedactedAuditDetail } from '../../core/audit';
import { broadcastStateNow } from '../../core/event-bridge';
import { getLogger } from '../../core/logger';
import { truthy } from '../../core/py';
import { runtime } from '../../core/runtime';
import type { Principal } from '../../core/security';
import * as dbm from '../../db/db-manager';
import {
  clampWrapupMaxSecs,
  DEFAULT_SHIFT_RESET_TIME,
  DEFAULT_WRAPUP_MAX_SECS,
  formatShiftResetTime,
  LOGGED_OUT,
  NOT_READY_REASON_ERROR,
  parseShiftResetTime,
  SHIFT_RESET_OFF,
  SHIFT_RESET_SETTING,
  shiftResetMinutes,
  WRAPUP_MAX_SECS_MAX,
  WRAPUP_MAX_SECS_MIN,
  WRAPUP_MAX_SETTING,
  wrapupMaxSecs,
  type AgentStateManager,
} from '../../services/agent-state';
import { HttpError } from '../http-error';
import { Auth, Delete, Get, Patch, Post, principal } from '../routing';
import { parseBody, pInt, qBool, v } from '../validation';

const log = getLogger('api.routes.agents');

export const DndBody = v.model({ enabled: v.bool() });
export const AgentStatusBody = v.model({ ready: v.bool().default(true), reason_code: v.str().nullish() });
export const WrapUpConfigBody = v.model({ max_secs: v.int().default(DEFAULT_WRAPUP_MAX_SECS) });
export const ShiftResetBody = v.model({ time: v.str().default(DEFAULT_SHIFT_RESET_TIME) });

function isDict(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

/** The signed-in user's extension, or 400. */
function ownExtension(user: Principal): string {
  const ext = user.extension ? String(user.extension).trim() : '';
  if (!ext) throw new HttpError(400, 'Your account has no extension');
  return ext;
}

function requireAgentState(): AgentStateManager {
  if (!runtime.monitor || !runtime.agentState) throw new HttpError(503, 'AMI monitor not available');
  return runtime.agentState;
}

/** Queues the user logs into: the extension's group queues, else the account's groups. */
async function loginQueues(user: Principal, ext: string): Promise<string[]> {
  let queues = await dbm.getAgentLoginQueues(ext);
  if (!queues.length && user.id !== null) {
    const [, accountQueues] = await dbm.getUserAgentsAndQueues(user.id);
    queues = accountQueues;
  }
  return queues.map(String).filter(Boolean);
}

/** R38/R39 rule: admin any; agent own; supervisor own + their scope. */
function mayChangeExtension(user: Principal, ext: string): boolean {
  if (user.role === 'admin') return true;
  const own = user.extension ? String(user.extension) : '';
  if (user.role === 'agent') return !!own && own === ext;
  if (own && own === ext) return true;
  return (user.allowed_agent_extensions || []).map(String).includes(ext);
}

@Controller()
export class AgentsController {
  // ---------------------------------------------------------------------------
  // Not-Ready reason catalog
  // ---------------------------------------------------------------------------
  /**
   * R40. `active_only` / `include_system` are honoured for admins (the catalog editor asks
   * for system rows explicitly); everyone else gets active, non-system codes only.
   */
  @Get('/api/pause-reasons')
  @Auth('user')
  async listPauseReasons(@Req() req: Request) {
    let activeOnly = qBool(req.query, 'active_only', false);
    let includeSystem = qBool(req.query, 'include_system', false);
    if (principal(req).role !== 'admin') {
      activeOnly = true;
      includeSystem = false;
    }
    return { reasons: await dbm.pauseReasonList({ activeOnly, includeSystem }) };
  }

  /** R41. Codes starting with `__` are reserved for system reasons (e.g. __WRAPUP). */
  @Post('/api/pause-reasons')
  @Auth('admin')
  async createPauseReason(@Req() req: Request) {
    const body = isDict(req.body) ? req.body : {};
    const code = String(body.code ?? '').trim();
    if (code.startsWith('__')) throw new HttpError(400, 'Codes starting with __ are reserved for system reasons');
    const rid = await dbm.pauseReasonCreate({
      code,
      label: body.label ?? '',
      productive: truthy(body.productive ?? false),
      color: body.color ?? null,
      sort_order: body.sort_order ?? 100,
      is_active: body.is_active === undefined ? true : truthy(body.is_active),
    });
    if (!rid) throw new HttpError(400, 'Invalid or duplicate pause reason (code + label required)');
    await runtime.agentState?.reloadReasons();
    setRedactedAuditDetail(req, {
      id: rid,
      code,
      label: body.label ?? '',
      productive: truthy(body.productive ?? false),
      is_active: body.is_active === undefined ? true : truthy(body.is_active),
    });
    return { ok: true, id: rid };
  }

  /** R42. Only label/productive/color/sort_order/is_active; system rows are refused. */
  @Patch('/api/pause-reasons/:reason_id')
  @Auth('admin')
  async updatePauseReason(@Req() req: Request) {
    const reasonId = pInt(req.params.reason_id, 'reason_id');
    const fields = isDict(req.body) ? { ...req.body } : {};
    delete fields.code;
    delete fields.is_system;
    if (!(await dbm.pauseReasonUpdate(reasonId, fields))) throw new HttpError(400, 'Nothing to update or update failed');
    await runtime.agentState?.reloadReasons();
    // Only the columns the update writes (see pauseReasonUpdate), never the raw body.
    const changed = Object.fromEntries(
      ['label', 'productive', 'color', 'sort_order', 'is_active'].filter((k) => k in fields).map((k) => [k, fields[k]]),
    );
    setRedactedAuditDetail(req, { changed });
    return { ok: true };
  }

  /** R43 */
  @Delete('/api/pause-reasons/:reason_id')
  @Auth('admin')
  async deletePauseReason(@Req() req: Request) {
    const reasonId = pInt(req.params.reason_id, 'reason_id');
    if (!(await dbm.pauseReasonDelete(reasonId))) throw new HttpError(400, 'Cannot delete (not found or system reason)');
    await runtime.agentState?.reloadReasons();
    setRedactedAuditDetail(req, { deleted: reasonId });
    return { ok: true };
  }

  // ---------------------------------------------------------------------------
  // The signed-in agent's queue session
  // ---------------------------------------------------------------------------
  /**
   * R44. Body `{ready?: bool = true, reason_code?}`. Joins the assigned queues; with
   * ready=false the agent then goes Not Ready with `reason_code`, which must be a valid
   * code (400 otherwise — the Python paused without any reason).
   */
  @Post('/api/agent/login')
  @Auth('user')
  async agentLogin(@Req() req: Request) {
    const user = principal(req);
    const ext = ownExtension(user);
    const agentState = requireAgentState();
    const body = isDict(req.body) ? req.body : {};
    const ready = body.ready === undefined || body.ready === null ? true : truthy(body.ready);
    const queues = await loginQueues(user, ext);
    if (!queues.length) throw new HttpError(400, 'No queues are assigned to your account');
    const reasonCode = String(body.reason_code ?? '').trim();
    if (!ready && !(await agentState.validNotReadyReason(reasonCode))) throw new HttpError(400, NOT_READY_REASON_ERROR);

    let [ok] = await agentState.login(ext, 'ui', { queues });
    if (ok && !ready) [ok] = await agentState.setNotReady(ext, reasonCode, 'ui');
    await broadcastStateNow();
    setRedactedAuditDetail(req, { extension: ext, queues, ready, reason_code: ready ? null : reasonCode, ok });
    return { ok, extension: ext, queues: agentState.states.get(ext)?.queues ?? queues, ready };
  }

  /** R45. Leaves every queue the agent is actually in (else the assigned ones); clears DND. */
  @Post('/api/agent/logout')
  @Auth('user')
  async agentLogout(@Req() req: Request) {
    const user = principal(req);
    const ext = ownExtension(user);
    const agentState = requireAgentState();
    let queues = await agentState.sessionQueues(ext);
    if (!queues.length) queues = await loginQueues(user, ext);
    // ok = at least one member was actually removed (the Python's any(queue_remove)).
    const before = runtime.monitor!.memberInterfacesFor(ext).length;
    await agentState.logout(ext, 'ui');
    const ok = before > 0 && runtime.monitor!.memberInterfacesFor(ext).length < before;
    await broadcastStateNow();
    setRedactedAuditDetail(req, { extension: ext, queues, ok });
    return { ok, extension: ext, queues };
  }

  /**
   * R46. Body `{ready: bool = true, reason_code?}` (body required). Not Ready needs an
   * active, non-system reason: 400 "A valid Not-Ready reason is required". `ok` reflects
   * whether the queue members were actually paused/unpaused.
   */
  @Post('/api/agent/status')
  @Auth('user')
  async setAgentStatus(@Req() req: Request) {
    const body = parseBody(AgentStatusBody, req.body);
    const user = principal(req);
    const ext = ownExtension(user);
    const agentState = requireAgentState();
    const ready = body.ready ?? true;
    const reason = (body.reason_code ?? '').trim();
    let ok: boolean;
    if (ready) {
      [ok] = await agentState.setReady(ext, 'ui');
    } else {
      if (!(await agentState.validNotReadyReason(reason))) throw new HttpError(400, NOT_READY_REASON_ERROR);
      [ok] = await agentState.setNotReady(ext, reason, 'ui');
    }
    await broadcastStateNow();
    setRedactedAuditDetail(req, { extension: ext, ready, reason_code: ready ? null : reason, ok });
    return { ok, extension: ext, ready, reason_code: reason };
  }

  /** The signed-in user's live presence (softphone bootstrap). */
  @Get('/api/agent/status')
  @Auth('user')
  async getAgentStatus(@Req() req: Request) {
    const ext = String(principal(req).extension || '');
    const presence = ext && runtime.agentState ? runtime.agentState.snapshot([ext])[ext] ?? null : null;
    return { extension: ext, state: presence ? presence.state : LOGGED_OUT, presence };
  }

  // ---------------------------------------------------------------------------
  // DND
  // ---------------------------------------------------------------------------
  /** R39. AstDB DND/<ext> flag; mirrored into presence; state pushed at once. */
  @Post('/api/extensions/:extension/dnd')
  @Auth('user')
  async setExtensionDnd(@Req() req: Request) {
    const body = parseBody(DndBody, req.body);
    const user = principal(req);
    const ext = String(req.params.extension);
    if (!mayChangeExtension(user, ext)) throw new HttpError(403, 'Not allowed to change DND for this extension');
    const monitor = runtime.monitor;
    if (!monitor) throw new HttpError(503, 'AMI monitor not available');
    const enabled = !!body.enabled;
    if (!(await monitor.setDnd(ext, enabled))) throw new HttpError(502, 'Failed to set DND via AMI');
    try {
      await runtime.agentState?.reflectDnd(ext, enabled, user.extension && String(user.extension) === ext ? 'ui' : 'supervisor');
    } catch (e) {
      log.warning('DND presence update for %s failed: %s', ext, e);
    }
    await broadcastStateNow();
    log.info(`DND ${enabled ? 'enabled' : 'disabled'} for extension: ${ext}`);
    setRedactedAuditDetail(req, { extension: ext, dnd: enabled });
    return { ok: true, extension: ext, dnd: enabled };
  }

  // ---------------------------------------------------------------------------
  // Wrap-up and shift reset settings
  // ---------------------------------------------------------------------------
  @Get('/api/agents/wrapup-config')
  @Auth('user')
  async getWrapupConfig() {
    return { max_secs: await wrapupMaxSecs(), min_secs: WRAPUP_MAX_SECS_MIN, max_secs_limit: WRAPUP_MAX_SECS_MAX };
  }

  /** Seconds in wrap-up before auto-Ready (0 = never). Applies from the next completed call. */
  @Post('/api/agents/wrapup-config')
  @Auth('admin')
  async setWrapupConfig(@Req() req: Request) {
    const body = parseBody(WrapUpConfigBody, req.body);
    const secs = clampWrapupMaxSecs(body.max_secs);
    if (!(await dbm.setSetting(WRAPUP_MAX_SETTING, String(secs)))) throw new HttpError(500, 'Failed to save the wrap-up setting');
    setRedactedAuditDetail(req, { [WRAPUP_MAX_SETTING]: secs });
    return {
      max_secs: secs,
      min_secs: WRAPUP_MAX_SECS_MIN,
      max_secs_limit: WRAPUP_MAX_SECS_MAX,
      message: secs === 0
        ? 'Wrap-up auto-release disabled — agents stay in wrap-up until they finish it.'
        : `Wrap-up max set to ${secs}s. Applies from the next completed call.`,
    };
  }

  @Get('/api/agents/shift-reset')
  @Auth('user')
  async getShiftReset() {
    return { time: formatShiftResetTime(await shiftResetMinutes()) };
  }

  /** "HH:MM" (24 h) or "" to turn the daily reset off. */
  @Post('/api/agents/shift-reset')
  @Auth('admin')
  async setShiftReset(@Req() req: Request) {
    const body = parseBody(ShiftResetBody, req.body);
    const raw = (body.time || '').trim();
    const minutes = parseShiftResetTime(raw);
    if (raw && minutes === null) throw new HttpError(400, 'Time must be HH:MM (24-hour), or empty to turn the reset off');
    const value = formatShiftResetTime(minutes);
    if (!(await dbm.setSetting(SHIFT_RESET_SETTING, value || SHIFT_RESET_OFF))) throw new HttpError(500, 'Failed to save the shift reset setting');
    setRedactedAuditDetail(req, { [SHIFT_RESET_SETTING]: value || SHIFT_RESET_OFF });
    return {
      time: value,
      message: minutes === null
        ? 'Daily shift reset turned off — agents stay logged in until they log out.'
        : `Agents are logged out of their queues at ${value} each day.`,
    };
  }
}
