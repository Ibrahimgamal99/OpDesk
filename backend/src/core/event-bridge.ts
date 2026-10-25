/**
 * AMI -> WebSocket bridge: builds the scoped live state and pushes it to every client.
 *
 * Port of server.py's AMIEventBridge. Cadence is the Python's: a 100 ms tick; when at
 * least one AMI event arrived since the last tick (up to 10 are drained per tick), or
 * 500 ms passed, every connection gets a `state_update` filtered to ITS live scope.
 *
 * Visibility (core/scope.ts rules, LIVE scope): admin and API keys see everything; a
 * supervisor sees the extensions/queues of their groups; an agent sees their own
 * extension plus every agent extension and queue of their groups. The `default` queue
 * is always hidden.
 *
 * State shape (api-contract.md §5.2) plus `agent_states` (presence, scope-filtered like
 * extensions).
 */

import type { WebSocket } from 'ws';
import * as dbm from '../db/db-manager';
import { DIALPLAN_CTX, formatDuration, type AMIExtensionsMonitor, type CallInfo } from '../services/ami';
import { getSlaDefaultSecs, getSlaThresholds, slaThresholdFor, type SlaThresholds } from '../services/analytics';
import { getLogger } from './logger';
import { nowIso, truthy } from './py';
import { runtime, type LiveStateBridge } from './runtime';
import {
  historyExtensions as scopeHistoryExtensions,
  liveExtensions as scopeLiveExtensions,
  liveQueues as scopeLiveQueues,
  type ScopeLike,
} from './scope';

const log = getLogger('core.event_bridge');

const STATE_QUEUE_MAXSIZE = 1000;
const TICK_SECONDS = 0.1;
const IDLE_PUSH_SECONDS = 0.5;
const MAX_EVENTS_PER_TICK = 10;
const QUEUE_NAMES_TTL_MS = 30_000;
const DEFAULT_QUEUE_HIDDEN = 'default';

/** A connection's scope as the WebSocket layer stores it (see api/routes/ws.ts). */
export interface LiveScope {
  role?: string | null;
  extension?: string | null;
  user_id?: number | null;
  allowed_agent_extensions?: string[] | null;
  allowed_queue_names?: string[] | null;
  live_agent_extensions?: string[] | null;
  live_queue_names?: string[] | null;
  [key: string]: unknown;
}

/** The LIVE extension filter of a scope (core/scope rules): null = unrestricted. */
export function liveExtensions(scope: LiveScope | null | undefined): string[] | null {
  return scope ? scopeLiveExtensions(scope as ScopeLike) : [];
}

/** The LIVE queue filter of a scope: null = unrestricted. */
export function liveQueues(scope: LiveScope | null | undefined): string[] | null {
  return scope ? scopeLiveQueues(scope as ScopeLike) : [];
}

/** The HISTORY extension filter of a scope (notifications): null = unrestricted. */
export function historyExtensions(scope: LiveScope | null | undefined): string[] | null {
  return scope ? scopeHistoryExtensions(scope as ScopeLike) : [];
}

function strip(v: unknown): string {
  return v === null || v === undefined ? '' : String(v).trim();
}

function isDigit(s: unknown): s is string {
  return typeof s === 'string' && /^[0-9]+$/.test(s);
}

function since(v: unknown): string | null {
  const d = v instanceof Date ? v : v ? new Date(String(v)) : null;
  if (!d || Number.isNaN(d.getTime())) return null;
  return formatDuration((Date.now() - d.getTime()) / 1000);
}

/** Bridge between AMI events and WebSocket broadcasts. */
export class AMIEventBridge {
  running = false;
  stateQueue: Record<string, string>[] = [];
  /** ext -> display name (users.name / PBX name); refreshed by the WS `sync` action. */
  extensionNames: Record<string, string> = {};
  private queueNames: Record<string, string> = {};
  private queueNamesAt = 0;
  // Each queue's service-level target (analytics settings), for the Dashboard's past-target alert.
  private slaThresholds: SlaThresholds = {};
  private slaDefaultSecs = 20;
  private timer: NodeJS.Timeout | null = null;
  private lastBroadcast = 0;
  private broadcasting = false;

  constructor(
    readonly monitor: AMIExtensionsMonitor,
  ) {}

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      this.extensionNames = await dbm.getExtensionNamesFromDb();
    } catch (e) {
      log.warning('Extension names not loaded: %s', e);
    }
    this.monitor.registerEventCallback(this.onAmiEvent);
    this.lastBroadcast = Date.now();
    this.timer = setInterval(() => void this.tick(), TICK_SECONDS * 1000);
    this.timer.unref();
    log.info('AMI Event Bridge started');
  }

  async stop(): Promise<void> {
    this.running = false;
    this.monitor.unregisterEventCallback(this.onAmiEvent);
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    log.info('AMI Event Bridge stopped');
  }

  /** Queue an AMI event for the next tick (an arrow, so it can be unregistered). */
  onAmiEvent = (event: Record<string, string>): void => {
    if (this.stateQueue.length >= STATE_QUEUE_MAXSIZE) this.stateQueue.shift();
    this.stateQueue.push(event);
  };

  private async tick(): Promise<void> {
    if (!this.running || this.broadcasting) return;
    this.broadcasting = true;
    try {
      let processed = 0;
      while (this.stateQueue.length && processed < MAX_EVENTS_PER_TICK) {
        this.stateQueue.shift();
        processed += 1;
      }
      const now = Date.now();
      if (processed > 0 || (now - this.lastBroadcast) / 1000 >= IDLE_PUSH_SECONDS) {
        await this.broadcastCurrentState();
        this.lastBroadcast = now;
      }
    } catch (e) {
      log.error('Broadcast loop error: %s', e);
    } finally {
      this.broadcasting = false;
    }
  }

  /** Send each client its own scope-filtered state. */
  async broadcastCurrentState(): Promise<void> {
    const manager = runtime.manager;
    const connections: WebSocket[] = [...manager.activeConnections];
    if (!connections.length) return;
    await this.refreshQueueNames();
    // Clients sharing a scope get the same state: build it once per distinct filter.
    const cache = new Map<string, Record<string, unknown>>();
    const timestamp = nowIso();
    for (const ws of connections) {
      const scope = manager.getScope(ws) as LiveScope;
      const allowExt = liveExtensions(scope);
      const allowQueues = liveQueues(scope);
      const key = JSON.stringify([allowExt, allowQueues]);
      let state = cache.get(key);
      if (!state) {
        state = this.buildState(allowExt, allowQueues);
        cache.set(key, state);
      }
      await manager.sendPersonal(ws, { type: 'state_update', data: state, timestamp });
    }
  }

  async broadcastStateNow(): Promise<void> {
    await this.broadcastCurrentState();
  }

  /** The state for one scope (null filters = unrestricted). */
  async getCurrentState(
    allowExtensions: (string | number)[] | null = null,
    allowQueues: (string | number)[] | null = null,
  ): Promise<Record<string, unknown>> {
    await this.refreshQueueNames();
    return this.buildState(
      allowExtensions === null ? null : allowExtensions.map(String),
      allowQueues === null ? null : allowQueues.map(String),
    );
  }

  /**
   * queues.queue_name display names and the SLA targets (cached: the Python hit the DB per
   * client per tick).
   */
  private async refreshQueueNames(force = false): Promise<void> {
    if (!force && Date.now() - this.queueNamesAt < QUEUE_NAMES_TTL_MS) return;
    try {
      const names: Record<string, string> = {};
      for (const q of await dbm.getQueuesList()) names[String(q.extension)] = q.queue_name;
      this.queueNames = names;
      this.slaThresholds = await getSlaThresholds();
      this.slaDefaultSecs = await getSlaDefaultSecs();
      this.queueNamesAt = Date.now();
    } catch (e) {
      log.debug('queue names refresh failed: %s', e);
    }
  }

  /** Forget cached display names (after a sync / rename). */
  invalidateNames(): void {
    this.queueNamesAt = 0;
  }

  buildState(allowExt: string[] | null, allowQueues: string[] | null): Record<string, unknown> {
    const extSet = allowExt === null ? null : new Set(allowExt);
    const queueSet = allowQueues === null ? null : new Set(allowQueues);
    const monitor = this.monitor;

    const extensions: Record<string, unknown> = {};
    for (const ext of monitor.monitored) {
      if (extSet !== null && !extSet.has(ext)) continue;
      const extData = monitor.extensions.get(ext) || {};
      const callInfo = monitor.activeCalls.get(ext) || {};
      const statusCode = Object.prototype.hasOwnProperty.call(extData, 'Status') ? extData['Status'] : '-1';
      // A call entry outranks the device hint only when it describes a live channel:
      // crossRef creates a bare placeholder the moment someone dials this extension, and
      // if the destination never gets a channel (caller gave up first, unregistered
      // phone) that placeholder would pin the card on "In Call" while the hint says Idle.
      // An `ended` entry (its channel is gone; kept for the call's final-hangup push, as a
      // ring-all leg the ACD cancelled is) leaves the card to the hint as well.
      const callLive = truthy(callInfo['channel']) && !truthy(callInfo['ended']);
      const callState = callLive ? strip(callInfo['state']) : '';
      let status: string;
      if (callLive) {
        if (callState === 'Ringing') status = 'ringing';
        else if (callState === 'Up' || callState === 'Busy') status = 'in_call';
        else if (callState === 'Ring') status = 'dialing';
        else status = 'in_call';
      } else if (statusCode === '0') status = 'idle';
      else if (statusCode === '1' || statusCode === '2') status = 'in_call';
      else if (statusCode === '8') status = 'ringing';
      else if (statusCode === '4' || statusCode === '-1') status = 'unavailable';
      else if (statusCode === '16' || statusCode === '32') status = 'on_hold';
      else status = 'idle';

      extensions[ext] = {
        extension: ext,
        name: this.extensionNames[ext] ?? '',
        status,
        status_code: statusCode,
        dnd: monitor.dnd.has(ext),
        call_info: callLive ? this.formatCallInfo(ext, callInfo) : null,
      };
    }

    // Active calls, caller perspective only.
    const activeCalls: Record<string, unknown> = {};
    const callees = new Set<string>();
    for (const [ext, info] of monitor.activeCalls) {
      const caller = info['caller'] || '';
      if (caller && caller !== ext && isDigit(caller) && caller.length <= 5) callees.add(ext);
    }
    for (const [ext, info] of monitor.activeCalls) {
      if (extSet !== null && !extSet.has(ext)) continue;
      if (!truthy(info['channel']) || !isDigit(ext) || DIALPLAN_CTX.has(ext)) continue;
      // A key that is an outside number (a waiting queue caller) is bookkeeping, not a row.
      if (!monitor.monitored.has(ext) && !(ext.length >= 3 && ext.length <= 5)) continue;
      if (callees.has(ext)) continue;
      const state = strip(info['state']);
      if (state && state.toLowerCase() === 'down') continue;
      if (truthy(info['ended'])) continue;
      activeCalls[ext] = this.formatCallInfo(ext, info);
    }

    const queues: Record<string, { extension: string; name: string; members: unknown; calls_waiting: number; sla_secs: number }> = {};
    for (const [queueExt, queueInfo] of monitor.queues) {
      if ((queueExt || '').trim().toLowerCase() === DEFAULT_QUEUE_HIDDEN) continue;
      if (queueSet !== null && !queueSet.has(queueExt)) continue;
      queues[queueExt] = {
        extension: queueExt,
        name: this.queueNames[queueExt] || queueExt,
        members: queueInfo.members || {},
        calls_waiting: queueInfo.calls_waiting || 0,
        sla_secs: slaThresholdFor(queueExt, this.slaThresholds, this.slaDefaultSecs),
      };
    }

    const queueMembers: Record<string, unknown> = {};
    for (const [memberKey, m] of monitor.queueMembers) {
      const q = m.queue || '';
      if (q.trim().toLowerCase() === DEFAULT_QUEUE_HIDDEN) continue;
      if (queueSet !== null && !queueSet.has(q)) continue;
      queueMembers[memberKey] = {
        queue: q,
        interface: m.interface || '',
        membername: m.membername || '',
        status: monitor.memberStatus(m),
        paused: !!m.paused,
        pause_reason: m.paused ? m.pause_reason || '' : '',
        dynamic: !!m.dynamic,
      };
    }

    const queueEntries: Record<string, unknown> = {};
    for (const [uniqueid, entry] of monitor.queueEntries) {
      const q = entry.queue || '';
      if (q.trim().toLowerCase() === DEFAULT_QUEUE_HIDDEN) continue;
      if (queueSet !== null && !queueSet.has(q)) continue;
      queueEntries[uniqueid] = {
        queue: q,
        callerid: entry.callerid || '',
        position: entry.position || 0,
        wait_time: entry.entry_time ? since(entry.entry_time) : null,
      };
    }

    const agentStates = runtime.agentState ? runtime.agentState.snapshot(allowExt) : {};

    let totalWaiting = 0;
    for (const q of Object.values(queues)) totalWaiting += Number(q.calls_waiting || 0);

    return {
      extensions,
      active_calls: activeCalls,
      queues,
      queue_members: queueMembers,
      queue_entries: queueEntries,
      agent_states: agentStates,
      stats: {
        total_extensions: Object.keys(extensions).length,
        active_calls_count: Object.keys(activeCalls).length,
        total_queues: Object.keys(queues).length,
        total_waiting: totalWaiting,
      },
    };
  }

  /** The CallInfo shape the frontend renders. */
  formatCallInfo(ext: string, info: CallInfo): Record<string, unknown> {
    let duration: string | null = null;
    let talkTime: string | null = null;
    if (Object.prototype.hasOwnProperty.call(info, 'start_time')) {
      duration = since(info['start_time']);
      if (info['answer_time']) talkTime = since(info['answer_time']);
    }
    const talkingTo = this.monitor.displayNumber(info, ext);
    // resolveCached is a memory-only lookup by contract (this runs per call row, per
    // client, per tick); a miss schedules one background fetch and resolves later.
    let contactName = '';
    const resolver = runtime.contactResolver as { resolveCached?: (n: string, m?: Set<string> | null) => unknown } | null;
    if (resolver && typeof resolver.resolveCached === 'function') {
      try {
        const r = resolver.resolveCached(talkingTo, this.monitor.monitored);
        contactName = typeof r === 'string' ? r : '';
      } catch {
        contactName = '';
      }
    }
    return {
      extension: ext,
      state: info['state'] ?? '',
      talking_to: talkingTo,
      contact_name: contactName,
      duration,
      talk_time: talkTime,
      channel: info['channel'] ?? '',
      caller: info['caller'] ?? '',
      callerid: info['callerid'] ?? '',
      destination: info['destination'] ?? '',
      original_destination: info['original_destination'] ?? '',
      route: this.monitor.liveRoute(info, ext),
    };
  }
}

// ---------------------------------------------------------------------------
// The running bridge (one per process)
// ---------------------------------------------------------------------------
let current: AMIEventBridge | null = null;

export function getBridge(): AMIEventBridge | null {
  return current;
}

export function setBridge(b: AMIEventBridge | null): void {
  current = b;
  runtime.bridge = b as unknown as LiveStateBridge | null;
}

/**
 * Push the current state to every client now (after a mutating REST/WS action).
 * A no-op when AMI never connected.
 */
export async function broadcastStateNow(): Promise<void> {
  if (current) await current.broadcastStateNow();
}

/** ext -> display name cache the bridge renders (mobile setup / wake read it too). */
export function extensionNames(): Record<string, string> {
  return current ? current.extensionNames : {};
}
