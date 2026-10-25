/**
 * Live PBX state over REST (api-contract.md R20, R47, R53-R57): extensions, active calls,
 * transfer, queues, status, the queue picker and click-to-call. All bare JSON.
 *
 * Visibility is the LIVE scope (core/scope rules): admin / API key everything; supervisor
 * their groups; agent their own extension plus their groups' agents and queues.
 */

import { Controller, Req } from '@nestjs/common';
import type { Request } from 'express';
import { liveExtensions, liveQueues } from '../../core/event-bridge';
import { setRedactedAuditDetail } from '../../core/audit';
import { getLogger } from '../../core/logger';
import { isoformat } from '../../core/py';
import { runtime } from '../../core/runtime';
import * as dbm from '../../db/db-manager';
import { broadcastStateNow } from '../../core/event-bridge';
import { normalizeDialNumber, type AMIExtensionsMonitor } from '../../services/ami';
import { HttpError } from '../http-error';
import { Auth, Get, Post, principal } from '../routing';
import { parseBody, v } from '../validation';

const log = getLogger('api.routes.live');

export const TransferCallBody = v.model({ destination: v.str() });

export const ClickToCallBody = v.model({
  extension: v.str(),
  number: v.str(),
  caller_id: v.str().nullish(),
  timeout: v.int().nullish(),
});

/**
 * jsonable_encoder for the raw monitor dicts: Date -> naive local isoformat, Map ->
 * object, Set -> list. (FastAPI rendered datetimes with isoformat().)
 */
export function jsonable(value: unknown): unknown {
  if (value instanceof Date) return isoformat(value);
  if (value instanceof Map) return Object.fromEntries([...value].map(([k, x]) => [String(k), jsonable(x)]));
  if (value instanceof Set) return [...value].map(jsonable);
  if (Array.isArray(value)) return value.map(jsonable);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(value as Record<string, unknown>)) out[k] = jsonable(x);
    return out;
  }
  return value;
}

function requireMonitor(): AMIExtensionsMonitor {
  const monitor = runtime.monitor;
  if (!monitor) throw new HttpError(503, 'AMI not connected');
  return monitor;
}

const notDefault = (q: string | null | undefined) => (q || '').trim().toLowerCase() !== 'default';

@Controller()
export class LiveController {
  /** R53: monitored extensions with their AMI status code and raw call entry. */
  @Get('/api/extensions')
  @Auth({ scope: 'calls:read' })
  async getExtensions(@Req() req: Request) {
    const monitor = requireMonitor();
    const allowed = liveExtensions(principal(req) as never);
    const allowSet = allowed === null ? null : new Set(allowed);
    const extensions: Record<string, unknown>[] = [];
    for (const ext of monitor.monitored) {
      if (allowSet !== null && !allowSet.has(ext)) continue;
      const extData = monitor.extensions.get(ext) || {};
      // An `ended` entry only waits for its call's final hangup: the extension is free.
      const callInfo = monitor.activeCalls.get(ext);
      const live = !!callInfo && !callInfo['ended'];
      extensions.push({
        extension: ext,
        status: Object.prototype.hasOwnProperty.call(extData, 'Status') ? extData['Status'] : '-1',
        in_call: live,
        call_info: live && Object.keys(callInfo).length ? jsonable(callInfo) : null,
      });
    }
    return { extensions };
  }

  /** R54: active calls (resynced from AMI on every request), keyed by extension. */
  @Get('/api/calls')
  @Auth({ scope: 'calls:read' })
  async getActiveCalls(@Req() req: Request) {
    const monitor = requireMonitor();
    await monitor.syncActiveCalls();
    const allowed = liveExtensions(principal(req) as never);
    const calls: Record<string, unknown> = {};
    for (const [ext, info] of monitor.activeCalls) {
      if (allowed !== null && !allowed.includes(ext)) continue;
      if (info['ended']) continue;
      calls[ext] = jsonable(info);
    }
    return { calls };
  }

  /** R55: blind-transfer the signed-in user's own current call. */
  @Post('/api/calls/transfer')
  @Auth('user')
  async transferCall(@Req() req: Request) {
    const body = parseBody(TransferCallBody, req.body);
    const monitor = requireMonitor();
    const user = principal(req);
    let sourceExt: string | null = null;
    if (user.id !== null) {
      try {
        const creds = await dbm.getUserWebrtcCredentials(user.id);
        sourceExt = creds?.extension ? String(creds.extension) : null;
      } catch (e) {
        log.debug('webrtc credentials lookup failed: %s', e);
      }
    }
    sourceExt = sourceExt || (user.extension ? String(user.extension) : null);
    if (!sourceExt) throw new HttpError(400, 'No extension associated with current user');
    const dest = (body.destination || '').trim();
    if (!dest) throw new HttpError(400, 'Destination is required');
    const ok = await monitor.transferCall(sourceExt, dest);
    if (!ok) throw new HttpError(500, 'Failed to transfer call');
    await broadcastStateNow();
    setRedactedAuditDetail(req, { source: sourceExt, destination: dest });
    return { ok: true, source: sourceExt, destination: dest };
  }

  /** R56: the raw queue dicts (default queue hidden), filtered by queue scope. */
  @Get('/api/queues')
  @Auth({ scope: 'calls:read' })
  async getQueues(@Req() req: Request) {
    const monitor = requireMonitor();
    const allowed = liveQueues(principal(req) as never);
    const ok = (q: string) => notDefault(q) && (allowed === null || allowed.includes(q));
    const queues: Record<string, unknown> = {};
    for (const [k, q] of monitor.queues) if (ok(k)) queues[k] = jsonable(q);
    const members: Record<string, unknown> = {};
    for (const [k, m] of monitor.queueMembers) {
      if (ok(m.queue)) members[k] = jsonable({ ...m, status: monitor.memberStatus(m), pause_reason: m.pause_reason || '' });
    }
    const entries: Record<string, unknown> = {};
    for (const [k, e] of monitor.queueEntries) if (ok(e.queue)) entries[k] = jsonable(e);
    return { queues, members, entries };
  }

  /** R57 */
  @Get('/api/status')
  @Auth({ scope: 'calls:read' })
  async getStatus() {
    const monitor = runtime.monitor;
    return {
      connected: monitor ? monitor.connected : false,
      extensions_count: monitor ? monitor.monitored.size : 0,
      active_calls: monitor ? monitor.activeCalls.size : 0,
      websocket_clients: runtime.manager.activeConnections.size,
    };
  }

  /**
   * R47: the queue picker; adds the live PBX queues to the queues table first. Never prunes:
   * any signed-in user can call this, and a queue missing from one QueueStatus reply would
   * take its group links with it.
   */
  @Get('/api/settings/queues')
  @Auth('user')
  async listQueues() {
    const nameMap = await dbm.getQueueNamesFromDb();
    const monitor = runtime.monitor;
    const liveNames = monitor && monitor.queues.size ? [...monitor.queues.keys()] : [];
    if (liveNames.length) {
      await dbm.syncQueuesFromList(liveNames, nameMap);
    } else if (Object.keys(nameMap).length) {
      await dbm.syncQueuesFromList(Object.keys(nameMap), nameMap);
    }
    let queues = await dbm.getQueuesList();
    if (!queues.length && liveNames.length) {
      await dbm.syncQueuesFromList(liveNames, nameMap);
      queues = await dbm.getQueuesList();
    }
    if (!queues.length && Object.keys(nameMap).length) {
      await dbm.syncQueuesFromList(Object.keys(nameMap), nameMap);
      queues = await dbm.getQueuesList();
    }
    return { queues };
  }

  /**
   * R20: originate from an extension to a number (202: Asterisk accepts the Originate long
   * before the call connects; correlate via action_id, the WebSocket feed or the CDR).
   */
  @Post('/api/integration/click-to-call', { status: 202 })
  @Auth({ scope: 'calls:write' })
  async clickToCall(@Req() req: Request) {
    const body = parseBody(ClickToCallBody, req.body);
    const monitor = runtime.monitor;
    if (!monitor || !monitor.connected) throw new HttpError(503, 'AMI not connected');

    const ext = String(body.extension || '').trim();
    if (!ext) throw new HttpError(400, 'extension is required');
    // Checked before anything reaches AMI.
    if (!monitor.monitored.has(ext)) throw new HttpError(404, `Unknown extension: ${ext}`);

    // require_scope lets any JWT through with no role check: without this, any agent
    // could dial from a colleague's phone.
    const user = principal(req);
    if (!user.api_key && user.role !== 'admin') {
      const own = String(user.extension || '');
      const allowed = user.role === 'agent' ? [] : user.allowed_agent_extensions || [];
      if (ext !== own && !allowed.includes(ext)) {
        throw new HttpError(403, 'Not permitted to originate calls from this extension');
      }
    }

    const num = normalizeDialNumber(body.number);
    if (!num) {
      throw new HttpError(400, "number must be 2-20 digits, optionally starting with '+' (spaces, dashes, dots and brackets are stripped)");
    }
    const timeoutS = body.timeout === null || body.timeout === undefined ? 30 : Number(body.timeout) || 30;
    if (timeoutS < 5 || timeoutS > 120) throw new HttpError(400, 'timeout must be between 5 and 120 seconds');

    const ctx = (await dbm.getSetting('CLICK_TO_CALL_CONTEXT', process.env.CLICK_TO_CALL_CONTEXT || 'from-internal')) || 'from-internal';
    const [ok, msg] = await monitor.originateCall(ext, num, { context: ctx, timeoutMs: timeoutS * 1000, callerId: body.caller_id ?? null });
    if (!ok) throw new HttpError(502, `Asterisk rejected the call: ${msg}`);
    log.info('Click-to-call accepted: %s -> %s (by %s)', ext, num, user.username);
    // The number an external system (or a user) made OpDesk dial: the method and path
    // alone cannot say which.
    setRedactedAuditDetail(req, { extension: ext, number: num, action_id: msg, timeout: timeoutS });
    return { accepted: true, action_id: msg, extension: ext, number: num };
  }
}
