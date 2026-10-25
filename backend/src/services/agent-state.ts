/**
 * Agent presence state machine (Not-Ready codes, wrap-up, DND, daily shift reset).
 *
 * Replaces backend/agent_presence.py, which only OBSERVED queue actions taken elsewhere.
 * Here the manager is the system of record: the REST routes (/api/agent/login|logout|
 * status) and the WebSocket actions (agent_login / agent_logout / agent_set_status /
 * agent_wrapup_done) all go through it, it drives the queue primitives on the AMI monitor
 * (QueueAdd / QueueRemove / QueuePause), and every transition is persisted as a SEGMENT in
 * agent_activity (dbm.agentActivityTransition), so the Agent Adherence report is a plain
 * GROUP BY with no reliance on Asterisk's queue_log.
 *
 *     logged_out  not a member of any queue          (no in-memory entry / a gap)
 *     ready       member, not paused, not on a call  (QueueUnpause)
 *     on_call     connected to an ACD call           (AgentConnect -> AgentComplete)
 *     wrap_up     paused with reason __WRAPUP        (after-call work, auto-released)
 *     not_ready   paused with a real, active reason  (QueuePause + reason)
 *     dnd         out of every queue + AstDB DND     (direct calls blocked too)
 *     available   plain extension (not a queue agent) reachable, no DND
 *
 * State is RECONCILED from AMI events (QueueMember*, AgentConnect/AgentComplete) so it
 * stays right when a feature code (*45 / *46) is used outside OpDesk. All writes go
 * through apply(), which is idempotent: the AMI reflection of our own action is a no-op.
 *
 * Fixes over agent_presence.py (feature-fixes Area 4):
 *   * a Not-Ready reason must be an active, non-system catalog code;
 *   * pause/unpause/remove act on the members the agent ACTUALLY has, in any interface
 *     form (PJSIP/x, SIP/x, Local/x@from-queue/n, Local/x@from-internal), not on an
 *     assumed PJSIP/<ext> in the assigned queues;
 *   * AgentConnect only counts for an agent with a session (no phantom adherence for
 *     static members);
 *   * AgentComplete enters wrap-up (__WRAPUP) with an auto-release timer;
 *   * the reason survives a restart (hydrated from QueueStatus PausedReason);
 *   * DND and a daily shift reset are part of presence.
 *
 * Broadcasting is not done here: the event bridge puts snapshot() into every
 * state_update, and the action handlers call broadcastStateNow().
 */

import { getLogger, pyStr } from '../core/logger';
import { AsyncLock, createTask, isoformat, pyInt, truthy } from '../core/py';
import * as dbm from '../db/db-manager';
import type { Row } from '../db/pool';
import { AMIExtensionsMonitor, extFromInterface } from './ami';

export const log = getLogger('services.agent_state');

// Presence states (agent_activity.state)
export const LOGGED_OUT = 'logged_out';
export const READY = 'ready';
export const NOT_READY = 'not_ready';
export const ON_CALL = 'on_call';
export const WRAP_UP = 'wrap_up';
export const DND = 'dnd';
export const AVAILABLE = 'available';

export const WRAPUP_REASON = '__WRAPUP'; // system pause reason marking after-call work
export const ACTIVE_STATES: ReadonlySet<string> = new Set([READY, NOT_READY, ON_CALL, WRAP_UP]);
export const NOT_READY_REASON_ERROR = 'A valid Not-Ready reason is required';

// Wrap-up auto-release, from the WRAPUP_MAX_SECS setting (OpDesk_settings), read fresh per
// wrap-up so a Settings change applies from the next completed call.
export const WRAPUP_MAX_SETTING = 'WRAPUP_MAX_SECS';
export const DEFAULT_WRAPUP_MAX_SECS = 120;
export const WRAPUP_MAX_SECS_MIN = 0; // 0 = no auto-release
export const WRAPUP_MAX_SECS_MAX = 1800;

/** Clamp a wrap-up max to the supported range; the default on bad input. */
export function clampWrapupMaxSecs(value: unknown): number {
  const n = pyInt(value);
  if (n === null) return DEFAULT_WRAPUP_MAX_SECS;
  return Math.max(WRAPUP_MAX_SECS_MIN, Math.min(n, WRAPUP_MAX_SECS_MAX));
}

export async function wrapupMaxSecs(): Promise<number> {
  return clampWrapupMaxSecs(await dbm.getSetting(WRAPUP_MAX_SETTING, String(DEFAULT_WRAPUP_MAX_SECS)));
}

// Daily shift reset: at this local time each day the floor is logged out, so a shift left
// open does not run into the next one. "HH:MM"; blank turns it off.
export const SHIFT_RESET_SETTING = 'SHIFT_RESET_TIME';
export const DEFAULT_SHIFT_RESET_TIME = '00:00';
/**
 * What "turned off" is stored as. Not '': getSetting reads an empty value back as the
 * fallback, so an empty setting came back as the 00:00 default and the reset never stopped.
 */
export const SHIFT_RESET_OFF = 'off';

/** "HH:MM" -> minutes after local midnight; null (reset off) for blank or unparseable. */
export function parseShiftResetTime(value: unknown): number | null {
  const text = (truthy(value) ? pyStr(value) : '').trim();
  if (!text) return null;
  const m = /^(\d{1,2}):(\d{1,2})$/.exec(text);
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (!(h >= 0 && h <= 23 && mi >= 0 && mi <= 59)) return null;
  return h * 60 + mi;
}

/** Minutes after midnight -> "HH:MM"; null -> "". */
export function formatShiftResetTime(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined) return '';
  const p2 = (n: number) => String(n).padStart(2, '0');
  return `${p2(Math.floor(minutes / 60))}:${p2(minutes % 60)}`;
}

export async function shiftResetMinutes(): Promise<number | null> {
  return parseShiftResetTime(await dbm.getSetting(SHIFT_RESET_SETTING, DEFAULT_SHIFT_RESET_TIME));
}

/** The local start of the shift day `now` belongs to, for a boundary at `minutes`. */
export function shiftDayStart(now: Date, minutes: number): Date {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), Math.floor(minutes / 60), minutes % 60, 0, 0);
  if (start.getTime() > now.getTime()) start.setDate(start.getDate() - 1);
  return start;
}

export interface AgentPresence {
  state: string;
  since: Date;
  reason_code: string | null;
  linkedid: string | null;
  queue: string | null;
  queues: string[];
  is_agent: boolean | null;
}

/** One entry of the WebSocket `agent_states` payload. */
export interface AgentSnapshotEntry {
  extension: string;
  state: string;
  reason_code: string | null;
  since: string;
  duration_secs: number;
  linkedid: string | null;
  queue: string | null;
  is_agent: boolean | null;
}

export interface ApplyOptions {
  reasonCode?: string | null;
  linkedid?: string | null;
  queue?: string | null;
  source?: string;
  queues?: string[] | null;
  force?: boolean;
  persist?: boolean;
}

/** Result of a user action: [ok, message]. */
export type ActionResult = [boolean, string];

/** Local time with its UTC offset, so a client in another zone reads `since` right. */
function isoformatWithOffset(d: Date): string {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  const p2 = (n: number) => String(n).padStart(2, '0');
  return `${isoformat(d)}${sign}${p2(Math.floor(abs / 60))}:${p2(abs % 60)}`;
}

function evGet(p: Row, k: string, d: unknown): any {
  return Object.prototype.hasOwnProperty.call(p, k) ? p[k] : d;
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : pyStr(e);
}

interface WrapTimer {
  cancel(): void;
}

export class AgentStateManager {
  monitor: AMIExtensionsMonitor;
  states: Map<string, AgentPresence> = new Map();
  wrapTimers: Map<string, WrapTimer> = new Map();
  reasonLabels: Record<string, string> = {};
  /** On a call when the daily reset ran: logged out as soon as the call ends. */
  pendingReset: Set<string> = new Set();
  /** Serialises user actions (login/logout/status). */
  lock = new AsyncLock();
  /** Serialises transitions (separate from `lock`: AsyncLock is not reentrant). */
  applyLock = new AsyncLock();

  constructor(monitor: AMIExtensionsMonitor) {
    this.monitor = monitor;
    this.handleAmiEvent = this.handleAmiEvent.bind(this);
  }

  // ------------------------------------------------------------------
  // Catalog / membership helpers
  // ------------------------------------------------------------------
  /** Cache code -> label (hydrate and after catalog edits). */
  async reloadReasons(): Promise<void> {
    try {
      const labels: Record<string, string> = {};
      for (const r of await dbm.pauseReasonList({ activeOnly: false, includeSystem: true })) labels[r.code] = r.label;
      this.reasonLabels = labels;
    } catch (e) {
      log.warning('reload_reasons: %s', errText(e));
    }
  }

  /** The interface a NEW member of this agent gets: <device driver>/<ext>. */
  interface(agentExt: string): string {
    return this.monitor.deviceInterface(String(agentExt).trim());
  }

  /** Live member interfaces of `agentExt` in `queue` (any form), else the canonical one. */
  liveInterfaces(agentExt: string, queue: string): string[] {
    const live = this.monitor.memberInterfacesFor(String(agentExt).trim(), queue).map((m) => m.interface);
    return live.length ? live : [this.interface(agentExt)];
  }

  /** Assigned queues: the session's, else the extension's group queues. */
  async queuesFor(agentExt: string): Promise<string[]> {
    const st = this.states.get(agentExt);
    if (st && st.queues.length) return st.queues;
    return dbm.getAgentLoginQueues(agentExt);
  }

  /**
   * The (queue, interface) pairs an action must touch: every member the agent ACTUALLY
   * has right now, in any queue and any interface form; when it has none (not synced
   * yet), the canonical interface in its assigned queues.
   */
  async memberTargets(agentExt: string): Promise<Array<[string, string]>> {
    const ext = String(agentExt).trim();
    const live = this.monitor.memberInterfacesFor(ext).map((m) => [m.queue, m.interface] as [string, string]);
    if (live.length) return live;
    return (await this.queuesFor(ext)).map((q) => [q, this.interface(ext)] as [string, string]);
  }

  /** Queues the agent is in right now (live), else its assigned ones. */
  async sessionQueues(agentExt: string): Promise<string[]> {
    const live = this.monitor.liveQueuesFor(String(agentExt).trim());
    return live.length ? live : this.queuesFor(agentExt);
  }

  /** An agent = an extension in at least one queue through a group. */
  async isAgent(agentExt: string): Promise<boolean> {
    try {
      return (await dbm.getAgentLoginQueues(String(agentExt).trim())).length > 0;
    } catch (e) {
      log.warning('_is_agent(%s): %s', agentExt, errText(e));
      return false;
    }
  }

  /** An active, non-system catalog row for `code`, or null. */
  async validNotReadyReason(code: string | null | undefined): Promise<Row | null> {
    const c = (code || '').trim();
    if (!c || c.startsWith('__')) return null;
    return dbm.pauseReasonForNotReady(c);
  }

  // ------------------------------------------------------------------
  // Core transition
  // ------------------------------------------------------------------
  /**
   * Persist + record a transition; true if the state changed. state=null => logged out.
   * persist=false keeps it in memory only (presence of a plain extension must not
   * pollute the queue-based adherence report).
   */
  async apply(agentExt: string, state: string | null, opts: ApplyOptions = {}): Promise<boolean> {
    return this.applyLock.run(() => this.applyUnlocked(agentExt, state, opts));
  }

  private async applyUnlocked(agentExt: string, state: string | null, opts: ApplyOptions): Promise<boolean> {
    const reasonCode = opts.reasonCode ?? null;
    const linkedid = opts.linkedid ?? null;
    const queue = opts.queue ?? null;
    const source = opts.source ?? 'ui';
    const persist = opts.persist ?? true;
    const ext = String(agentExt).trim();
    const cur = this.states.get(ext);

    if (!opts.force) {
      if (state === null && !cur) return false;
      if (cur && cur.state === state && cur.reason_code === reasonCode
          && (!(state === ON_CALL || state === WRAP_UP) || cur.linkedid === linkedid)) {
        return false;
      }
    }

    if (state === null) {
      if (persist) await this.persist(ext, null, { source });
      this.states.delete(ext);
      return true;
    }
    if (persist) await this.persist(ext, state, { reasonCode, queue, linkedid, source });
    const keepQueues = opts.queues ?? (cur ? cur.queues : []);
    const isAgent = cur && cur.is_agent !== null ? cur.is_agent : await this.isAgent(ext);
    this.states.set(ext, {
      state,
      since: new Date(),
      reason_code: reasonCode,
      linkedid,
      queue,
      queues: keepQueues || [],
      is_agent: isAgent,
    });
    return true;
  }

  private async persist(
    ext: string,
    state: string | null,
    opts: { reasonCode?: string | null; queue?: string | null; linkedid?: string | null; source?: string },
  ): Promise<void> {
    try {
      await dbm.agentActivityTransition(ext, state, opts);
    } catch (e) {
      log.warning('agent_activity transition for %s failed: %s', ext, errText(e));
    }
  }

  cancelWrap(agentExt: string): void {
    const t = this.wrapTimers.get(agentExt);
    this.wrapTimers.delete(agentExt);
    if (t) t.cancel();
  }

  // ------------------------------------------------------------------
  // User actions
  // ------------------------------------------------------------------
  /**
   * Log in: clear DND, join every assigned queue (an existing member of the agent in a
   * queue — any interface form, e.g. a *45 feature-code login — is reused and unpaused
   * instead of adding a duplicate), enter Ready. `queues` overrides the assigned set.
   */
  async login(agentExt: string, source = 'ui', opts: { queues?: string[] | null } = {}): Promise<ActionResult> {
    const ext = String(agentExt).trim();
    if (!ext) return [false, 'Missing agent extension'];
    return this.lock.run(async (): Promise<ActionResult> => {
      const queues = opts.queues && opts.queues.length ? opts.queues : await dbm.getAgentLoginQueues(ext);
      if (!queues.length) return [false, 'No queues are assigned to this agent (add them to a group)'];
      await this.clearDnd(ext);
      const joined: string[] = [];
      for (const q of queues) {
        const existing = this.monitor.memberInterfacesFor(ext, q);
        if (existing.length) {
          let ok = true;
          for (const m of existing) if (m.paused) ok = (await this.monitor.queueUnpause(q, m.interface))[0] && ok;
          if (ok) joined.push(q);
          continue;
        }
        const [ok] = await this.monitor.queueAdd(q, this.interface(ext), { membername: ext, paused: false });
        if (ok) joined.push(q);
      }
      if (!joined.length) return [false, 'Failed to add agent to any queue'];
      this.cancelWrap(ext);
      this.pendingReset.delete(ext);
      await this.apply(ext, READY, { source, queues: joined, force: true });
      return [true, `Logged in to ${joined.length} queue(s)`];
    });
  }

  /** Log out: leave every queue (live members), clear DND, close the segment. */
  async logout(agentExt: string, source = 'ui'): Promise<ActionResult> {
    const ext = String(agentExt).trim();
    if (!ext) return [false, 'Missing agent extension'];
    return this.lock.run(async (): Promise<ActionResult> => {
      await this.leaveQueues(ext);
      await this.clearDnd(ext);
      this.cancelWrap(ext);
      this.pendingReset.delete(ext);
      await this.apply(ext, null, { source, force: true });
      return [true, 'Logged out'];
    });
  }

  /** Remove every live member of the agent; [queues touched, any success]. */
  private async leaveQueues(ext: string): Promise<[string[], boolean]> {
    const targets = await this.memberTargets(ext);
    let anyOk = false;
    const queues: string[] = [];
    for (const [q, iface] of targets) {
      const [ok] = await this.monitor.queueRemove(q, iface);
      anyOk = anyOk || ok;
      if (!queues.includes(q)) queues.push(q);
    }
    return [queues, anyOk];
  }

  /** DND: out of every queue AND direct calls blocked (AstDB DND). Agents and plain extensions. */
  async setDnd(agentExt: string, source = 'ui'): Promise<ActionResult> {
    const ext = String(agentExt).trim();
    if (!ext) return [false, 'Missing agent extension'];
    return this.lock.run(async (): Promise<ActionResult> => {
      if (this.monitor.memberInterfacesFor(ext).length) await this.leaveQueues(ext);
      if (!(await this.monitor.setDnd(ext, true))) return [false, 'Failed to set DND via AMI'];
      this.cancelWrap(ext);
      await this.apply(ext, DND, { source, force: true, persist: await this.isAgent(ext) });
      return [true, 'Do Not Disturb'];
    });
  }

  /** Available: a full login for an agent; for a plain extension, clear DND only. */
  async setAvailable(agentExt: string, source = 'ui'): Promise<ActionResult> {
    const ext = String(agentExt).trim();
    if (!ext) return [false, 'Missing extension'];
    if (await this.isAgent(ext)) return this.login(ext, source);
    return this.lock.run(async (): Promise<ActionResult> => {
      await this.clearDnd(ext);
      this.cancelWrap(ext);
      await this.apply(ext, AVAILABLE, { source, force: true, persist: false });
      return [true, 'Available'];
    });
  }

  /** Offline: a full logout for an agent; for a plain extension, clear DND and the marker. */
  async setOffline(agentExt: string, source = 'ui'): Promise<ActionResult> {
    const ext = String(agentExt).trim();
    if (!ext) return [false, 'Missing extension'];
    if (await this.isAgent(ext)) return this.logout(ext, source);
    return this.lock.run(async (): Promise<ActionResult> => {
      await this.clearDnd(ext);
      this.cancelWrap(ext);
      await this.apply(ext, null, { source, force: true, persist: false });
      return [true, 'Offline'];
    });
  }

  /**
   * The AstDB DND flag was toggled directly (POST /api/extensions/{ext}/dnd, a *78 / *79
   * feature code): reflect it in presence without touching queue membership — an agent
   * in a queue session keeps it (DND then blocks direct calls only).
   */
  async reflectDnd(agentExt: string, enabled: boolean, source = 'ui'): Promise<void> {
    const ext = String(agentExt).trim();
    if (!ext) return;
    const cur = this.states.get(ext);
    const persist = await this.isAgent(ext);
    if (enabled) {
      if (!cur || cur.state === AVAILABLE) await this.apply(ext, DND, { source, force: true, persist });
    } else if (cur && cur.state === DND) {
      await this.apply(ext, null, { source, force: true, persist });
    }
  }

  async clearDnd(agentExt: string): Promise<void> {
    try {
      await this.monitor.setDnd(String(agentExt).trim(), false);
    } catch (e) {
      log.warning('clear DND for %s: %s', agentExt, errText(e));
    }
  }

  /** Back to Ready: unpause every live member. Also ends Not-Ready or wrap-up early. */
  async setReady(agentExt: string, source = 'ui'): Promise<ActionResult> {
    const ext = String(agentExt).trim();
    if (!this.states.has(ext) && !this.monitor.memberInterfacesFor(ext).length) return [false, 'Agent is not logged in'];
    return this.lock.run(async (): Promise<ActionResult> => {
      const targets = await this.memberTargets(ext);
      let anyOk = !targets.length;
      for (const [q, iface] of targets) anyOk = (await this.monitor.queueUnpause(q, iface))[0] || anyOk;
      if (!anyOk) return [false, 'Failed to unpause the agent in any queue'];
      this.cancelWrap(ext);
      await this.apply(ext, READY, { source, force: true, queues: this.mergeQueues(ext, targets) });
      return [true, 'Ready'];
    });
  }

  /** Not Ready with a required, active, non-system reason: pause every live member. */
  async setNotReady(agentExt: string, reasonCode: string, source = 'ui'): Promise<ActionResult> {
    const ext = String(agentExt).trim();
    const reason = await this.validNotReadyReason(reasonCode);
    if (!reason) return [false, NOT_READY_REASON_ERROR];
    if (!this.states.has(ext) && !this.monitor.memberInterfacesFor(ext).length) return [false, 'Agent is not logged in'];
    const code = String(reason.code ?? reasonCode).trim();
    return this.lock.run(async (): Promise<ActionResult> => {
      const targets = await this.memberTargets(ext);
      let anyOk = !targets.length;
      for (const [q, iface] of targets) {
        anyOk = (await this.monitor.queuePause(q, iface, { paused: true, reason: code }))[0] || anyOk;
      }
      if (!anyOk) return [false, 'Failed to pause the agent in any queue'];
      this.cancelWrap(ext);
      await this.apply(ext, NOT_READY, { reasonCode: code, source, force: true, queues: this.mergeQueues(ext, targets) });
      return [true, `Not Ready — ${pyStr(reason.label ?? code)}`];
    });
  }

  private mergeQueues(ext: string, targets: Array<[string, string]>): string[] {
    const st = this.states.get(ext);
    const out = st ? [...st.queues] : [];
    for (const [q] of targets) if (!out.includes(q)) out.push(q);
    return out;
  }

  /** Agent finished after-call work -> Ready. */
  async finishWrapup(agentExt: string, source = 'ui'): Promise<ActionResult> {
    const ext = String(agentExt).trim();
    const st = this.states.get(ext);
    if (!st || st.state !== WRAP_UP) return [false, 'Agent is not in wrap-up'];
    return this.setReady(ext, source);
  }

  // ------------------------------------------------------------------
  // Daily shift reset
  // ------------------------------------------------------------------
  /**
   * Log the floor out at the shift boundary. On a call -> deferred to the call's end;
   * DND -> left alone (already out of every queue; logging out would clear DND and let
   * the desk phone ring all night); Ready / Not Ready / Wrap-up -> logged out now.
   */
  async dailyReset(source = 'system'): Promise<{ logged_out: string[]; deferred: string[]; skipped_dnd: string[] }> {
    const out = { logged_out: [] as string[], deferred: [] as string[], skipped_dnd: [] as string[] };
    for (const [ext, st] of [...this.states.entries()]) {
      if (!st.is_agent) continue;
      if (st.state === DND) {
        out.skipped_dnd.push(ext);
        continue;
      }
      if (st.state === ON_CALL) {
        this.pendingReset.add(ext);
        out.deferred.push(ext);
        continue;
      }
      if (!ACTIVE_STATES.has(st.state)) continue;
      const [ok] = await this.logout(ext, source);
      if (ok) out.logged_out.push(ext);
    }
    if (out.logged_out.length || out.deferred.length || out.skipped_dnd.length) {
      log.info('Daily shift reset: %d logged out, %d deferred (on a call), %d left on DND',
        out.logged_out.length, out.deferred.length, out.skipped_dnd.length);
    }
    return out;
  }

  // ------------------------------------------------------------------
  // AMI-driven reconciliation
  // ------------------------------------------------------------------
  /** Registered as a monitor event callback. Only monitored extensions are tracked. */
  async handleAmiEvent(p: Row): Promise<void> {
    try {
      const ev = evGet(p, 'Event', '');
      if (!['QueueMemberAdded', 'QueueMemberRemoved', 'QueueMemberPaused', 'QueueMemberPause',
        'QueueMemberUnpause', 'AgentConnect', 'AgentComplete'].includes(ev)) {
        return;
      }
      const iface = evGet(p, 'Interface', evGet(p, 'Member', evGet(p, 'Location', '')));
      const ext = extFromInterface(iface);
      if (!ext || !this.monitor.monitored.has(ext)) return;
      const queue = evGet(p, 'Queue', '');
      const linkedid = evGet(p, 'Linkedid', evGet(p, 'DestLinkedid', ''));

      if (ev === 'AgentConnect') {
        // Only an agent with a session: a static member who never logged in must not
        // accrue on-call (and then logged-in) time.
        if (this.states.has(ext)) {
          this.cancelWrap(ext);
          await this.apply(ext, ON_CALL, { linkedid, queue, source: 'ami' });
        }
        return;
      }

      if (ev === 'AgentComplete') {
        if (this.states.has(ext)) {
          if (this.pendingReset.has(ext)) {
            this.pendingReset.delete(ext);
            await this.logout(ext, 'system');
            return;
          }
          await this.enterWrapup(ext, { linkedid, queue, source: 'ami' });
        }
        return;
      }

      const reason = AMIExtensionsMonitor.eventPauseReason(p as Record<string, string>) ?? '';

      if (ev === 'QueueMemberAdded') {
        // A feature-code login outside OpDesk starts a session.
        if (!this.states.has(ext)) {
          const paused = evGet(p, 'Paused', '0') === '1';
          const loginQueues = await dbm.getAgentLoginQueues(ext);
          const queues = loginQueues.length ? loginQueues : [queue];
          if (paused && reason === WRAPUP_REASON) {
            await this.apply(ext, WRAP_UP, { reasonCode: WRAPUP_REASON, source: 'ami', queues, force: true });
          } else if (paused) {
            await this.apply(ext, NOT_READY, { reasonCode: reason || null, source: 'ami', queues, force: true });
          } else {
            await this.apply(ext, READY, { source: 'ami', queues, force: true });
          }
        }
        return;
      }

      if (ev === 'QueueMemberRemoved') {
        // Out of every queue now (matched by extension, any interface form) -> logged out.
        if (this.states.has(ext) && this.states.get(ext)!.state !== DND && !this.stillMember(ext)) {
          this.cancelWrap(ext);
          await this.apply(ext, null, { source: 'ami', force: true });
        }
        return;
      }

      // QueueMemberPause / QueueMemberPaused / QueueMemberUnpause
      if (!this.states.has(ext)) return;
      const paused = evGet(p, 'Paused', '0') === '1';
      const cur = this.states.get(ext)!;
      if (!paused) {
        // Unpaused elsewhere -> Ready (a call in progress is not paused anyway). With
        // several members, wait until none of them is paused any more.
        if ((cur.state === NOT_READY || cur.state === WRAP_UP) && !this.anyMemberPaused(ext)) {
          this.cancelWrap(ext);
          await this.apply(ext, READY, { source: 'ami' });
        }
      } else if (reason === WRAPUP_REASON) {
        // Our own wrap-up pause repeating back (no linkedid): keep the current segment.
        if (cur.state === WRAP_UP) return;
        await this.apply(ext, WRAP_UP, { reasonCode: WRAPUP_REASON, source: 'ami' });
      } else {
        // Keep a known reason when the reflected event carries none.
        const code = reason || (cur.state === NOT_READY ? cur.reason_code : null);
        if (cur.state === NOT_READY && cur.reason_code === code) return;
        this.cancelWrap(ext);
        await this.apply(ext, NOT_READY, { reasonCode: code || null, source: 'ami' });
      }
    } catch (e) {
      log.error('handle_ami_event error: %s', errText(e));
    }
  }

  /** Still a member of any queue, by extension (any interface form). */
  stillMember(agentExt: string): boolean {
    return this.monitor.memberInterfacesFor(String(agentExt).trim()).length > 0;
  }

  private anyMemberPaused(ext: string): boolean {
    return this.monitor.memberInterfacesFor(ext).some((m) => m.paused);
  }

  /** After-call work: pause every member with __WRAPUP and arm the auto-release timer. */
  async enterWrapup(agentExt: string, opts: { linkedid?: string | null; queue?: string | null; source?: string } = {}): Promise<void> {
    const ext = String(agentExt).trim();
    for (const [q, iface] of await this.memberTargets(ext)) {
      await this.monitor.queuePause(q, iface, { paused: true, reason: WRAPUP_REASON });
    }
    await this.apply(ext, WRAP_UP, {
      reasonCode: WRAPUP_REASON,
      linkedid: opts.linkedid ?? '',
      queue: opts.queue ?? '',
      source: opts.source ?? 'ami',
    });
    this.cancelWrap(ext);
    const maxSecs = await wrapupMaxSecs();
    if (maxSecs > 0) this.wrapTimers.set(ext, this.wrapTimeout(ext, maxSecs));
  }

  /** After `secs`, return a still-wrapping agent to Ready. */
  wrapTimeout(agentExt: string, secs: number): WrapTimer {
    let fired = false;
    const handle = setTimeout(() => {
      fired = true;
      if (this.wrapTimers.get(agentExt) === timer) this.wrapTimers.delete(agentExt);
      const st = this.states.get(agentExt);
      if (st && st.state === WRAP_UP) {
        log.info('Wrap-up max (%ss) reached for %s -> Ready', secs, agentExt);
        createTask(this.setReady(agentExt, 'system'), (e) => log.error('wrap-up release failed: %s', errText(e)));
      }
    }, secs * 1000);
    handle.unref?.();
    const timer: WrapTimer = {
      cancel: () => {
        if (!fired) clearTimeout(handle);
      },
    };
    return timer;
  }

  // ------------------------------------------------------------------
  // Startup hydration
  // ------------------------------------------------------------------
  /**
   * Rebuild presence from the live queue state after a (re)start: close stale open
   * segments (time while the backend was down is not counted), then open a fresh one per
   * agent with a live DYNAMIC member, using the member's PausedReason (Not-Ready code or
   * __WRAPUP). DND comes from AstDB and outranks membership.
   */
  async hydrate(): Promise<void> {
    await this.reloadReasons();
    try {
      await dbm.agentActivityCloseAllOpen('system');
    } catch (e) {
      log.warning('hydrate close_all_open: %s', errText(e));
    }

    const byExt = new Map<string, { queues: string[]; paused: boolean; reason: string }>();
    for (const m of this.monitor.queueMembers.values()) {
      if (!m.dynamic) continue;
      const ext = extFromInterface(m.interface);
      if (!ext || !this.monitor.monitored.has(ext)) continue;
      let entry = byExt.get(ext);
      if (!entry) {
        entry = { queues: [], paused: false, reason: '' };
        byExt.set(ext, entry);
      }
      if (m.queue && !entry.queues.includes(m.queue)) entry.queues.push(m.queue);
      if (m.paused) {
        entry.paused = true;
        if (m.pause_reason) entry.reason = m.pause_reason;
      }
    }

    for (const [ext, entry] of byExt) {
      if (entry.paused && entry.reason === WRAPUP_REASON) {
        await this.apply(ext, WRAP_UP, { reasonCode: WRAPUP_REASON, source: 'system', queues: entry.queues, force: true });
        // The timer did not survive the restart: re-arm it.
        const maxSecs = await wrapupMaxSecs();
        if (maxSecs > 0) this.wrapTimers.set(ext, this.wrapTimeout(ext, maxSecs));
      } else if (entry.paused) {
        await this.apply(ext, NOT_READY, { reasonCode: entry.reason || null, source: 'system', queues: entry.queues, force: true });
      } else {
        await this.apply(ext, READY, { source: 'system', queues: entry.queues, force: true });
      }
    }
    if (byExt.size) log.info('Agent presence hydrated: %d logged-in agent(s)', byExt.size);

    for (const ext of this.monitor.dnd) {
      if (!this.monitor.monitored.has(ext)) continue;
      const member = byExt.get(ext);
      if (member) {
        log.warning('hydrate DND: %s is flagged DND but is still a member of %s — '
          + 'direct calls are blocked while queue calls still ring', ext, member.queues.join(', ') || 'a queue');
      }
      await this.apply(ext, DND, { source: 'system', force: true, persist: await this.isAgent(ext) });
    }
  }

  // ------------------------------------------------------------------
  // Snapshot for the WebSocket state payload
  // ------------------------------------------------------------------
  /** {ext: entry}, filtered to `allowExtensions` (null = no filter). No label: clients map codes. */
  snapshot(allowExtensions: Iterable<unknown> | null = null): Record<string, AgentSnapshotEntry> {
    const allow = allowExtensions === null || allowExtensions === undefined ? null : new Set([...allowExtensions].map((e) => pyStr(e)));
    const now = new Date();
    const out: Record<string, AgentSnapshotEntry> = {};
    for (const [ext, st] of this.states) {
      if (allow !== null && !allow.has(ext)) continue;
      const since = st.since || now;
      out[ext] = {
        extension: ext,
        state: st.state,
        reason_code: st.reason_code,
        since: isoformatWithOffset(since),
        duration_secs: Math.max(0, Math.trunc((now.getTime() - since.getTime()) / 1000)),
        linkedid: st.linkedid,
        queue: st.queue,
        is_agent: st.is_agent ?? true,
      };
    }
    return out;
  }

  /** Presence state of one extension ('logged_out' when none). */
  stateOf(ext: string): string {
    return this.states.get(String(ext).trim())?.state ?? LOGGED_OUT;
  }
}
