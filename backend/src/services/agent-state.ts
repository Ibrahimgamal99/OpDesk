/**
 * Presence: AVAILABILITY (tracked, every extension) and QUEUE LOGIN (agents), as two
 * independent layers, plus DND as a call-blocking flag.
 *
 * Availability — the adherence report's time — follows reachability (registration.ts):
 * a device that registers (or, asleep, can be woken by push) is Available; one that goes
 * away is offline. There is no manual Offline. While available an extension is
 *
 *     ready       idle, no call
 *     on_call     on any answered call (its device channel is Up), or an ACD call
 *     not_ready   on a break with a reason code (queue members paused with it, if any)
 *     wrap_up     after an ACD call (paused with __WRAPUP, auto-released)
 *
 * Calls are detected from real device channels (monitor.answeredCh), never from the hint:
 * a *78 DND sets Custom:DND<ext> BUSY in the hint, which would read as a call.
 *
 * Queue login (queueLogin / queueLogout, *45 / *46) joins and leaves the queues and is its
 * own segment table (queue_login); it never changes availability. A phone that goes
 * unreachable WITHOUT push wake-up is taken out of its queues after a grace period
 * (QUEUE_UNREGISTER_GRACE_SECS); a push-wakeable one stays.
 *
 * DND (AstDB DND flag) blocks inbound calls and OVERRIDES a break: turning it on ends any
 * break or wrap-up (the time is Idle — "Idle on DND" — while registered) and logs the
 * extension out of its queues (remembered in AstDB OPDESK_DNDQ); turning it off returns it
 * to Available and back into those queues. Taking a break turns DND off. DND stretches are
 * recorded in extension_dnd.
 *
 * ---- History of the queue-only manager this grew from ----
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
import { AMIExtensionsMonitor, extFromChannel, extFromInterface } from './ami';
import type { ReachVia } from './registration';

export const log = getLogger('services.agent_state');

// Presence states (agent_activity.state)
export const LOGGED_OUT = 'logged_out';
export const READY = 'ready';
export const NOT_READY = 'not_ready';
export const ON_CALL = 'on_call';
export const WRAP_UP = 'wrap_up';
/**
 * A break held while the phone is offline (laptop closed at lunch). Not a live state —
 * the extension is offline — but an agent_activity row, so the report can count it as the
 * break up to the reason's window (pause_reasons.max_break_secs, from the break's start).
 */
export const BREAK_OFFLINE = 'break_offline';

/** Legacy presence states: kept so old agent_activity rows and clients still parse. */
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

// Grace before an unreachable (non-push) extension is taken out of its queues.
export const QUEUE_GRACE_SETTING = 'QUEUE_UNREGISTER_GRACE_SECS';
export const DEFAULT_QUEUE_GRACE_SECS = 60;
export const QUEUE_GRACE_SECS_MAX = 3600;

export function clampQueueGraceSecs(value: unknown): number {
  const n = pyInt(value);
  if (n === null) return DEFAULT_QUEUE_GRACE_SECS;
  return Math.max(0, Math.min(n, QUEUE_GRACE_SECS_MAX));
}

export async function queueGraceSecs(): Promise<number> {
  return clampQueueGraceSecs(await dbm.getSetting(QUEUE_GRACE_SETTING, String(DEFAULT_QUEUE_GRACE_SECS)));
}

/** AstDB family holding the queues to rejoin when DND goes off: OPDESK_DNDQ/<ext> = "800,801". */
export const DND_RESTORE_FAMILY = 'OPDESK_DNDQ';

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
  since: string | null;
  duration_secs: number;
  linkedid: string | null;
  queue: string | null;
  is_agent: boolean | null;
  queue_logged_in: boolean;
  queues: string[];
  reachable_via: ReachVia | null;
  dnd: boolean;
  /** Offline on a break: the reason it resumes with when the phone is back. */
  held_break: string | null;
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

/** What the manager needs from the reachability tracker. */
export interface ReachabilitySource {
  viaOf(ext: string): ReachVia | null;
}

export const OFFLINE_ERROR = 'Extension is offline (its phone is not registered)';

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

const QUEUE_EVENTS: ReadonlySet<string> = new Set([
  'QueueMemberAdded', 'QueueMemberRemoved', 'QueueMemberPaused', 'QueueMemberPause',
  'QueueMemberUnpause', 'AgentConnect', 'AgentComplete',
]);
const CALL_EVENTS: ReadonlySet<string> = new Set(['Newstate', 'Hangup']);
const AGENT_CACHE_MS = 60_000;

export class AgentStateManager {
  monitor: AMIExtensionsMonitor;
  /** Availability, one entry per reachable extension. */
  states: Map<string, AgentPresence> = new Map();
  /** Queue login sessions: ext -> queues joined. */
  queueIn: Map<string, string[]> = new Map();
  /** Extensions with DND on (an open extension_dnd row). */
  dndOn: Set<string> = new Set();
  /** Queues to rejoin when DND goes off (mirrors AstDB OPDESK_DNDQ). */
  dndRestore: Map<string, string[]> = new Map();
  /** Reachability (registration.ts); null in tests that drive availability directly. */
  registration: ReachabilitySource | null = null;
  wrapTimers: Map<string, WrapTimer> = new Map();
  graceTimers: Map<string, NodeJS.Timeout> = new Map();
  /**
   * A break held while the phone is offline: ext -> {reason, when}. The break resumes when
   * the phone comes back, however long it was away, until the user picks Available (a
   * browser reload or a laptop closed at lunch never silently ends a break). Mirrored by an
   * open BREAK_OFFLINE row, so it survives a restart.
   */
  heldBreaks: Map<string, { reason: string; at: number }> = new Map();
  reasonLabels: Record<string, string> = {};
  /** On a call when the daily reset ran: out of the queues as soon as the call ends. */
  pendingReset: Set<string> = new Set();
  /** Serialises user actions (login/logout/status/DND). */
  lock = new AsyncLock();
  /** Serialises transitions (separate from `lock`: AsyncLock is not reentrant). */
  applyLock = new AsyncLock();
  private agentCache: Map<string, { v: boolean; at: number }> = new Map();

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
    const q = this.queueIn.get(agentExt);
    if (q && q.length) return q;
    return dbm.getAgentLoginQueues(agentExt);
  }

  /** Every member the extension ACTUALLY has right now, any queue and interface form. */
  liveTargets(agentExt: string): Array<[string, string]> {
    return this.monitor.memberInterfacesFor(String(agentExt).trim()).map((m) => [m.queue, m.interface] as [string, string]);
  }

  /**
   * The (queue, interface) pairs a queue logout must touch: the live members; when there
   * are none (not synced yet) but a session is known, the canonical interface in its queues.
   */
  async memberTargets(agentExt: string): Promise<Array<[string, string]>> {
    const ext = String(agentExt).trim();
    const live = this.liveTargets(ext);
    if (live.length) return live;
    if (!this.queueIn.has(ext)) return [];
    return (await this.queuesFor(ext)).map((q) => [q, this.interface(ext)] as [string, string]);
  }

  /** Queues the agent is in right now (live), else its assigned ones. */
  async sessionQueues(agentExt: string): Promise<string[]> {
    const live = this.monitor.liveQueuesFor(String(agentExt).trim());
    return live.length ? live : this.queuesFor(agentExt);
  }

  /** An agent = an extension in at least one queue through a group (cached briefly). */
  async isAgent(agentExt: string): Promise<boolean> {
    const ext = String(agentExt).trim();
    const hit = this.agentCache.get(ext);
    if (hit && Date.now() - hit.at < AGENT_CACHE_MS) return hit.v;
    let v = false;
    try {
      v = (await dbm.getAgentLoginQueues(ext)).length > 0;
    } catch (e) {
      log.warning('_is_agent(%s): %s', agentExt, errText(e));
    }
    this.agentCache.set(ext, { v, at: Date.now() });
    return v;
  }

  /** An active, non-system catalog row for `code`, or null. */
  async validNotReadyReason(code: string | null | undefined): Promise<Row | null> {
    const c = (code || '').trim();
    if (!c || c.startsWith('__')) return null;
    return dbm.pauseReasonForNotReady(c);
  }

  /** How the extension is reachable now (sip / push), or null. */
  viaOf(ext: string): ReachVia | null {
    if (this.registration) return this.registration.viaOf(ext);
    return this.states.has(ext) ? 'sip' : null;
  }

  isQueueLoggedIn(ext: string): boolean {
    return this.queueIn.has(ext) || this.monitor.memberInterfacesFor(ext).length > 0;
  }

  /** The device's answered call, from real channels: {linkedid} or null when idle. */
  deviceCall(ext: string): { linkedid: string | null } | null {
    for (const [ch, chExt] of this.monitor.answeredCh) {
      if (chExt === ext) return { linkedid: this.monitor.ch2linkedid.get(ch) ?? null };
    }
    return null;
  }

  /** The reason a live member is paused with (first found), '' when paused without one, null when none is paused. */
  private memberPauseReason(ext: string): string | null {
    let out: string | null = null;
    for (const m of this.monitor.memberInterfacesFor(ext)) {
      if (!m.paused) continue;
      if (m.pause_reason) return m.pause_reason;
      out = '';
    }
    return out;
  }

  // ------------------------------------------------------------------
  // Core transition
  // ------------------------------------------------------------------
  /** Persist + record an availability transition; true if the state changed. state=null => offline. */
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
    const keepQueues = opts.queues ?? this.queueIn.get(ext) ?? [];
    const isAgent = await this.isAgent(ext);
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

  /**
   * Available, idle or on a call depending on the device right now. Never forced: when the
   * extension already is in that state nothing is written. A user's "Available" and the
   * PBX's Unpause echo of it race each other (either may land first); unforced, whichever
   * is second is a no-op instead of a duplicate 0-second row.
   */
  private async applyAvailable(ext: string, source: string, force = false): Promise<void> {
    const call = this.deviceCall(ext);
    if (call) await this.apply(ext, ON_CALL, { linkedid: call.linkedid, source, force });
    else await this.apply(ext, READY, { source, force });
  }

  cancelWrap(agentExt: string): void {
    const t = this.wrapTimers.get(agentExt);
    this.wrapTimers.delete(agentExt);
    if (t) t.cancel();
  }

  cancelGrace(agentExt: string): void {
    const t = this.graceTimers.get(agentExt);
    this.graceTimers.delete(agentExt);
    if (t) clearTimeout(t);
  }

  // ------------------------------------------------------------------
  // Availability (reachability-driven)
  // ------------------------------------------------------------------
  /**
   * The tracker saw `ext` become reachable (via sip / push) or unreachable (null).
   * Reachable -> Available (a break still held on its queue members is restored);
   * unreachable -> offline, and out of its queues after the grace period.
   */
  async onReachability(agentExt: string, via: ReachVia | null, source = 'ami'): Promise<void> {
    const ext = String(agentExt).trim();
    if (!ext) return;
    await this.lock.run(async () => {
      if (via) {
        this.cancelGrace(ext);
        const held = this.heldBreaks.get(ext);
        this.heldBreaks.delete(ext);
        const resume = held && !this.dndOn.has(ext) ? held.reason : null;
        if (!this.states.has(ext)) await this.startAvailability(ext, source, resume);
        return;
      }
      this.cancelWrap(ext);
      const cur = this.states.get(ext);
      if (cur && cur.state === NOT_READY && cur.reason_code && !this.dndOn.has(ext)) {
        // Hold the break while offline: the not_ready row closes, a BREAK_OFFLINE row opens.
        this.heldBreaks.set(ext, { reason: cur.reason_code, at: Date.now() });
        await this.applyLock.run(async () => {
          await this.persist(ext, BREAK_OFFLINE, { reasonCode: cur.reason_code, source });
          this.states.delete(ext);
        });
      } else if (cur) {
        await this.apply(ext, null, { source, force: true });
      }
      if (this.isQueueLoggedIn(ext)) await this.armGrace(ext);
    });
  }

  /** Open availability for a reachable extension: a held break, wrap-up, or Available. */
  private async startAvailability(ext: string, source: string, savedBreak: string | null): Promise<void> {
    const held = this.memberPauseReason(ext);
    if (held === WRAPUP_REASON) {
      await this.apply(ext, WRAP_UP, { reasonCode: WRAPUP_REASON, source, force: true });
      const maxSecs = await wrapupMaxSecs();
      if (maxSecs > 0) this.wrapTimers.set(ext, this.wrapTimeout(ext, maxSecs));
      return;
    }
    if (held !== null) {
      await this.apply(ext, NOT_READY, { reasonCode: held || savedBreak || null, source, force: true });
      return;
    }
    if (savedBreak) {
      await this.apply(ext, NOT_READY, { reasonCode: savedBreak, source, force: true });
      return;
    }
    await this.applyAvailable(ext, source);
  }

  /** After the grace period, a still-unreachable extension leaves its queues. */
  private async armGrace(ext: string): Promise<void> {
    this.cancelGrace(ext);
    const secs = await queueGraceSecs();
    const fire = () => {
      this.graceTimers.delete(ext);
      if (this.viaOf(ext)) return;
      log.info('%s unreachable for %ss -> logged out of its queues', ext, secs);
      createTask(this.queueLogout(ext, 'system'), (e) => log.error('grace logout failed: %s', errText(e)));
    };
    const t = setTimeout(fire, secs * 1000);
    t.unref?.();
    this.graceTimers.set(ext, t);
  }

  /** A device channel changed: Available <-> On Call. Breaks and wrap-up are left alone. */
  private async onCallActivity(p: Row): Promise<void> {
    const ext = extFromChannel(evGet(p, 'Channel', ''));
    if (!ext || !this.monitor.monitored.has(ext)) return;
    const st = this.states.get(ext);
    if (!st) return;
    const call = this.deviceCall(ext);
    if (st.state === READY && call) {
      await this.apply(ext, ON_CALL, { linkedid: call.linkedid, source: 'ami' });
    } else if (st.state === ON_CALL && !call && !st.queue) {
      if (this.pendingReset.has(ext)) {
        this.pendingReset.delete(ext);
        await this.queueLogout(ext, 'system');
      }
      await this.apply(ext, READY, { source: 'ami' });
    }
  }

  // ------------------------------------------------------------------
  // Break / Available (any extension)
  // ------------------------------------------------------------------
  /** Back to Available: unpause every live member. Also ends a break or wrap-up early. */
  async setReady(agentExt: string, source = 'ui'): Promise<ActionResult> {
    const ext = String(agentExt).trim();
    if (!this.states.has(ext) && this.heldBreaks.has(ext)) {
      // Offline on a break (e.g. a supervisor ends it): drop the hold; it comes back Available.
      return this.lock.run(async (): Promise<ActionResult> => {
        await this.endHeldBreak(ext, source);
        return [true, 'Break ended (the phone is offline)'];
      });
    }
    if (!this.states.has(ext)) return [false, OFFLINE_ERROR];
    return this.lock.run(async (): Promise<ActionResult> => {
      const targets = this.monitor.memberInterfacesFor(ext).filter((m) => m.paused);
      let anyOk = !targets.length;
      for (const m of targets) anyOk = (await this.monitor.queueUnpause(m.queue, m.interface))[0] || anyOk;
      if (!anyOk) return [false, 'Failed to unpause the agent in any queue'];
      this.cancelWrap(ext);
      await this.applyAvailable(ext, source);
      return [true, 'Available'];
    });
  }

  /** Break with a required, active, non-system reason; pauses the live queue members, if any. */
  async setNotReady(agentExt: string, reasonCode: string, source = 'ui'): Promise<ActionResult> {
    const ext = String(agentExt).trim();
    const reason = await this.validNotReadyReason(reasonCode);
    if (!reason) return [false, NOT_READY_REASON_ERROR];
    if (!this.states.has(ext)) return [false, OFFLINE_ERROR];
    const code = String(reason.code ?? reasonCode).trim();
    return this.lock.run(async (): Promise<ActionResult> => {
      // DND overrides a break, so taking a break ends DND (the queues it took away come back,
      // then they are paused with the break's reason below).
      if (this.dndOn.has(ext) || this.monitor.dnd.has(ext)) {
        const [ok, msg] = await this.applyDndUnlocked(ext, false, source, { setFlag: true, restore: true });
        if (!ok) return [false, msg];
      }
      const targets = this.liveTargets(ext);
      let anyOk = !targets.length;
      for (const [q, iface] of targets) {
        anyOk = (await this.monitor.queuePause(q, iface, { paused: true, reason: code }))[0] || anyOk;
      }
      if (!anyOk) return [false, 'Failed to pause the agent in any queue'];
      this.cancelWrap(ext);
      await this.apply(ext, NOT_READY, { reasonCode: code, source, force: true });
      return [true, `Not Ready — ${pyStr(reason.label ?? code)}`];
    });
  }

  /** Close an offline-held break (its BREAK_OFFLINE row) without coming online. */
  private async endHeldBreak(ext: string, source: string): Promise<void> {
    if (!this.heldBreaks.delete(ext)) return;
    await this.applyLock.run(() => this.persist(ext, null, { source }));
  }

  /** Agent finished after-call work -> Available. */
  async finishWrapup(agentExt: string, source = 'ui'): Promise<ActionResult> {
    const ext = String(agentExt).trim();
    const st = this.states.get(ext);
    if (!st || st.state !== WRAP_UP) return [false, 'Agent is not in wrap-up'];
    return this.setReady(ext, source);
  }

  // ------------------------------------------------------------------
  // Queue login (agents) — independent of availability
  // ------------------------------------------------------------------
  /**
   * Join every assigned queue (an existing member in any interface form is reused, never
   * duplicated). On a break, members join paused with the break's reason. Clears DND:
   * asking for queue calls and blocking inbound calls contradict each other.
   */
  async queueLogin(agentExt: string, source = 'ui', opts: { queues?: string[] | null } = {}): Promise<ActionResult> {
    const ext = String(agentExt).trim();
    if (!ext) return [false, 'Missing agent extension'];
    return this.lock.run(() => this.queueLoginUnlocked(ext, source, { queues: opts.queues ?? null, keepDndRestore: false }));
  }

  private async queueLoginUnlocked(
    ext: string,
    source: string,
    opts: { queues: string[] | null; keepDndRestore: boolean },
  ): Promise<ActionResult> {
    const queues = opts.queues && opts.queues.length ? opts.queues : await dbm.getAgentLoginQueues(ext);
    if (!queues.length) return [false, 'No queues are assigned to this agent (add them to a group)'];
    if (!opts.keepDndRestore && (this.dndOn.has(ext) || this.monitor.dnd.has(ext))) {
      await this.applyDndUnlocked(ext, false, source, { setFlag: true, restore: false });
    }
    const st = this.states.get(ext);
    const breakReason = st && st.state === NOT_READY ? st.reason_code : null;
    const joined: string[] = [];
    for (const q of queues) {
      const existing = this.monitor.memberInterfacesFor(ext, q);
      if (existing.length) {
        let ok = true;
        for (const m of existing) {
          if (breakReason && !(m.paused && m.pause_reason === breakReason)) {
            ok = (await this.monitor.queuePause(q, m.interface, { paused: true, reason: breakReason }))[0] && ok;
          } else if (!breakReason && m.paused) {
            ok = (await this.monitor.queueUnpause(q, m.interface))[0] && ok;
          }
        }
        if (ok) joined.push(q);
        continue;
      }
      const [ok] = await this.monitor.queueAdd(q, this.interface(ext), {
        membername: ext,
        paused: !!breakReason,
        reason: breakReason,
      });
      if (ok) joined.push(q);
    }
    if (!joined.length) return [false, 'Failed to add agent to any queue'];
    this.pendingReset.delete(ext);
    this.queueIn.set(ext, joined);
    await dbm.queueLoginOpen(ext, source);
    if (st) st.queues = [...joined];
    this.agentCache.delete(ext);
    return [true, `Logged in to ${joined.length} queue(s)`];
  }

  /** Leave every queue (live members, any form). Availability is unchanged. */
  async queueLogout(agentExt: string, source = 'ui'): Promise<ActionResult> {
    const ext = String(agentExt).trim();
    if (!ext) return [false, 'Missing agent extension'];
    return this.lock.run(() => this.queueLogoutUnlocked(ext, source));
  }

  private async queueLogoutUnlocked(ext: string, source: string): Promise<ActionResult> {
    const [queues, anyOk] = await this.leaveQueues(ext);
    this.endQueueSession(ext);
    this.pendingReset.delete(ext);
    const st = this.states.get(ext);
    if (st && st.state === WRAP_UP) {
      this.cancelWrap(ext);
      await this.applyAvailable(ext, source);
    }
    return [true, queues.length && anyOk ? `Logged out of ${queues.length} queue(s)` : 'Logged out of queues'];
  }

  private endQueueSession(ext: string): void {
    this.cancelGrace(ext);
    const had = this.queueIn.delete(ext);
    const st = this.states.get(ext);
    if (st) st.queues = [];
    if (had) createTask(dbm.queueLoginClose(ext), (e) => log.warning('queue_login close %s: %s', ext, errText(e)));
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

  /** Back-compat names: "login" / "logout" now mean the queue layer only. */
  login(agentExt: string, source = 'ui', opts: { queues?: string[] | null } = {}): Promise<ActionResult> {
    return this.queueLogin(agentExt, source, opts);
  }

  logout(agentExt: string, source = 'ui'): Promise<ActionResult> {
    return this.queueLogout(agentExt, source);
  }

  // ------------------------------------------------------------------
  // DND (call-blocking flag)
  // ------------------------------------------------------------------
  /** DND on/off from OpDesk: sets the AstDB flag, then the queue/recording side effects. */
  async setDnd(agentExt: string, enabled = true, source = 'ui'): Promise<ActionResult> {
    const ext = String(agentExt).trim();
    if (!ext) return [false, 'Missing agent extension'];
    return this.lock.run(() => this.applyDndUnlocked(ext, enabled, source, { setFlag: true, restore: true }));
  }

  /**
   * The AstDB flag was already changed (POST /api/extensions/{ext}/dnd, a *78 / *79 code
   * found by the reconcile sweep): apply the side effects only.
   */
  async reflectDnd(agentExt: string, enabled: boolean, source = 'ui'): Promise<void> {
    const ext = String(agentExt).trim();
    if (!ext) return;
    await this.lock.run(() => this.applyDndUnlocked(ext, enabled, source, { setFlag: false, restore: true }));
  }

  private async applyDndUnlocked(
    ext: string,
    enabled: boolean,
    source: string,
    opts: { setFlag: boolean; restore: boolean },
  ): Promise<ActionResult> {
    if (opts.setFlag && !(await this.monitor.setDnd(ext, enabled))) return [false, 'Failed to set DND via AMI'];
    if (enabled) {
      if (!this.dndOn.has(ext)) {
        this.dndOn.add(ext);
        await dbm.dndOpen(ext, source);
      }
      if (this.isQueueLoggedIn(ext)) {
        const queues = this.monitor.liveQueuesFor(ext);
        const restore = queues.length ? queues : this.queueIn.get(ext) ?? [];
        if (restore.length) {
          this.dndRestore.set(ext, restore);
          await this.monitor.dbPut(DND_RESTORE_FAMILY, ext, restore.join(','));
        }
        await this.queueLogoutUnlocked(ext, 'dnd');
      }
      // DND overrides everything: a break or wrap-up ends, and the time counts as Idle
      // (reported as "Idle on DND") while the phone stays registered. A call goes on.
      const st = this.states.get(ext);
      if (!st) await this.endHeldBreak(ext, source);
      this.heldBreaks.delete(ext);
      if (st && (st.state === NOT_READY || st.state === WRAP_UP)) {
        this.cancelWrap(ext);
        await this.applyAvailable(ext, source);
      }
      return [true, 'Do Not Disturb'];
    }
    if (this.dndOn.delete(ext)) await dbm.dndClose(ext);
    const restore = this.dndRestore.get(ext);
    if (restore) {
      this.dndRestore.delete(ext);
      await this.monitor.dbDel(DND_RESTORE_FAMILY, ext);
    }
    if (opts.restore && restore && restore.length) {
      const [ok, msg] = await this.queueLoginUnlocked(ext, source, { queues: restore, keepDndRestore: true });
      return [true, ok ? `DND off — ${msg}` : 'DND off'];
    }
    return [true, 'DND off'];
  }

  /** Clear the DND flag (no queue restore). */
  async clearDnd(agentExt: string): Promise<void> {
    try {
      await this.monitor.setDnd(String(agentExt).trim(), false);
    } catch (e) {
      log.warning('clear DND for %s: %s', agentExt, e);
    }
  }

  /** Re-read the AstDB DND family and apply any change made outside OpDesk (*78 / *79). */
  async reconcileDnd(): Promise<void> {
    await this.monitor.syncDndState();
    for (const ext of [...this.monitor.dnd]) {
      if (this.monitor.monitored.has(ext) && !this.dndOn.has(ext)) await this.reflectDnd(ext, true, 'ami');
    }
    for (const ext of [...this.dndOn]) {
      if (!this.monitor.dnd.has(ext)) await this.reflectDnd(ext, false, 'ami');
    }
  }

  // ------------------------------------------------------------------
  // Daily shift reset
  // ------------------------------------------------------------------
  /**
   * Log the floor out of its queues at the shift boundary. On a call -> deferred to the
   * call's end. Availability is untouched (it follows the phone); the report splits time
   * at the same boundary. `skipped_dnd` is kept for the log line's shape: an extension on
   * DND is out of its queues already.
   */
  async dailyReset(source = 'system'): Promise<{ logged_out: string[]; deferred: string[]; skipped_dnd: string[] }> {
    const out = { logged_out: [] as string[], deferred: [] as string[], skipped_dnd: [] as string[] };
    const exts = new Set<string>(this.queueIn.keys());
    for (const m of this.monitor.queueMembers.values()) {
      if (!m.dynamic) continue;
      const ext = extFromInterface(m.interface);
      if (ext && this.monitor.monitored.has(ext)) exts.add(ext);
    }
    for (const ext of exts) {
      if (this.states.get(ext)?.state === ON_CALL) {
        this.pendingReset.add(ext);
        out.deferred.push(ext);
        continue;
      }
      const [ok] = await this.queueLogout(ext, source);
      if (ok) out.logged_out.push(ext);
    }
    if (out.logged_out.length || out.deferred.length) {
      log.info('Daily shift reset: %d logged out of queues, %d deferred (on a call)', out.logged_out.length, out.deferred.length);
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
      if (CALL_EVENTS.has(ev)) {
        await this.onCallActivity(p);
        return;
      }
      if (!QUEUE_EVENTS.has(ev)) return;
      const iface = evGet(p, 'Interface', evGet(p, 'Member', evGet(p, 'Location', '')));
      const ext = extFromInterface(iface);
      if (!ext || !this.monitor.monitored.has(ext)) return;
      const queue = evGet(p, 'Queue', '');
      const linkedid = evGet(p, 'Linkedid', evGet(p, 'DestLinkedid', ''));

      if (ev === 'AgentConnect') {
        const cur = this.states.get(ext);
        if (!cur) return;
        this.cancelWrap(ext);
        if (cur.state === ON_CALL && !cur.queue) {
          // The device call already opened the segment: it is this ACD call.
          cur.queue = queue;
          cur.linkedid = linkedid || cur.linkedid;
          return;
        }
        await this.apply(ext, ON_CALL, { linkedid, queue, source: 'ami' });
        return;
      }

      if (ev === 'AgentComplete') {
        if (!this.states.has(ext)) return;
        if (this.pendingReset.has(ext)) {
          this.pendingReset.delete(ext);
          await this.queueLogout(ext, 'system');
          await this.applyAvailable(ext, 'system');
          return;
        }
        await this.enterWrapup(ext, { linkedid, queue, source: 'ami' });
        return;
      }

      const reason = AMIExtensionsMonitor.eventPauseReason(p as Record<string, string>) ?? '';

      if (ev === 'QueueMemberAdded') {
        // A feature-code login outside OpDesk opens a queue session.
        const live = this.monitor.liveQueuesFor(ext);
        const queues = live.length ? live : [queue];
        if (!this.queueIn.has(ext)) {
          this.queueIn.set(ext, queues);
          await dbm.queueLoginOpen(ext, 'ami');
        } else {
          this.queueIn.set(ext, queues);
        }
        const st = this.states.get(ext);
        if (st) {
          st.queues = [...queues];
          const paused = evGet(p, 'Paused', '0') === '1';
          if (paused && reason && reason !== WRAPUP_REASON && st.state === READY) {
            await this.apply(ext, NOT_READY, { reasonCode: reason, source: 'ami' });
          }
        }
        return;
      }

      if (ev === 'QueueMemberRemoved') {
        if (this.stillMember(ext)) {
          const live = this.monitor.liveQueuesFor(ext);
          if (this.queueIn.has(ext)) this.queueIn.set(ext, live);
          return;
        }
        this.endQueueSession(ext);
        const st = this.states.get(ext);
        if (st && st.state === WRAP_UP) {
          this.cancelWrap(ext);
          await this.applyAvailable(ext, 'ami');
        }
        return;
      }

      // QueueMemberPause / QueueMemberPaused / QueueMemberUnpause
      const cur = this.states.get(ext);
      if (!cur) return;
      const paused = evGet(p, 'Paused', '0') === '1';
      if (!paused) {
        // Unpaused elsewhere -> Available. With several members, wait until none is paused.
        if ((cur.state === NOT_READY || cur.state === WRAP_UP) && !this.anyMemberPaused(ext)) {
          this.cancelWrap(ext);
          await this.applyAvailable(ext, 'ami');
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
    for (const [q, iface] of this.liveTargets(ext)) {
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

  /** After `secs`, return a still-wrapping agent to Available. */
  wrapTimeout(agentExt: string, secs: number): WrapTimer {
    let fired = false;
    const handle = setTimeout(() => {
      fired = true;
      if (this.wrapTimers.get(agentExt) === timer) this.wrapTimers.delete(agentExt);
      const st = this.states.get(agentExt);
      if (st && st.state === WRAP_UP) {
        log.info('Wrap-up max (%ss) reached for %s -> Available', secs, agentExt);
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
   * Rebuild after a (re)start. Open segments left by the previous process are closed (the
   * downtime is not counted) — but the reasons of open breaks are read first, so a break
   * taken without any queue member (Asterisk holds no reason for it) survives. Then:
   * queue sessions from the live DYNAMIC members, DND from AstDB, and availability for
   * every reachable extension (a paused member's reason, else the saved break, else
   * Available / On Call).
   */
  async hydrate(): Promise<void> {
    await this.reloadReasons();
    const savedBreaks = await dbm.agentActivityOpenBreaks();
    try {
      await dbm.agentActivityCloseAllOpen('system');
      await dbm.queueLoginCloseAllOpen();
      await dbm.dndCloseAllOpen();
    } catch (e) {
      log.warning('hydrate close_all_open: %s', errText(e));
    }
    this.states.clear();
    this.queueIn.clear();
    this.dndOn.clear();

    // Queue sessions.
    for (const m of this.monitor.queueMembers.values()) {
      if (!m.dynamic) continue;
      const ext = extFromInterface(m.interface);
      if (!ext || !this.monitor.monitored.has(ext)) continue;
      const qs = this.queueIn.get(ext) ?? [];
      if (m.queue && !qs.includes(m.queue)) qs.push(m.queue);
      this.queueIn.set(ext, qs);
    }
    for (const ext of this.queueIn.keys()) await dbm.queueLoginOpen(ext, 'system');

    // DND and the queues to give back when it goes off.
    try {
      const fam = await this.monitor.dbGetFamily(DND_RESTORE_FAMILY, true);
      this.dndRestore = new Map(
        Object.entries(fam || {})
          .map(([k, v]) => [k, pyStr(v).split(',').map((q) => q.trim()).filter(Boolean)] as [string, string[]])
          .filter(([, qs]) => qs.length),
      );
    } catch (e) {
      log.warning('hydrate DND restore list: %s', errText(e));
    }
    for (const ext of this.monitor.dnd) {
      if (!this.monitor.monitored.has(ext)) continue;
      this.dndOn.add(ext);
      await dbm.dndOpen(ext, 'system');
      if (this.queueIn.has(ext)) {
        log.warning('hydrate DND: %s is flagged DND but is still a member of %s', ext, (this.queueIn.get(ext) || []).join(', '));
      }
    }

    // Availability.
    let available = 0;
    this.heldBreaks.clear();
    for (const ext of this.monitor.monitored) {
      if (!this.viaOf(ext)) {
        if (this.queueIn.has(ext)) await this.armGrace(ext);
        // Offline on a break before the restart: keep holding it.
        const saved = savedBreaks.get(ext);
        if (saved && !this.dndOn.has(ext)) {
          this.heldBreaks.set(ext, { reason: saved, at: Date.now() });
          await this.persist(ext, BREAK_OFFLINE, { reasonCode: saved, source: 'system' });
        }
        continue;
      }
      // DND overrides a break: an extension on DND starts Available (Idle on DND).
      await this.startAvailability(ext, 'system', this.dndOn.has(ext) ? null : savedBreaks.get(ext) ?? null);
      available += 1;
    }
    log.info('Presence hydrated: %d available, %d in queues, %d on DND', available, this.queueIn.size, this.dndOn.size);
  }

  // ------------------------------------------------------------------
  // Snapshot for the WebSocket state payload
  // ------------------------------------------------------------------
  /** {ext: entry}, filtered to `allowExtensions` (null = no filter). No label: clients map codes. */
  snapshot(allowExtensions: Iterable<unknown> | null = null): Record<string, AgentSnapshotEntry> {
    const allow = allowExtensions === null || allowExtensions === undefined ? null : new Set([...allowExtensions].map((e) => pyStr(e)));
    const now = new Date();
    const out: Record<string, AgentSnapshotEntry> = {};
    const exts = new Set<string>([...this.states.keys(), ...this.queueIn.keys(), ...this.dndOn, ...this.heldBreaks.keys()]);
    for (const ext of exts) {
      if (allow !== null && !allow.has(ext)) continue;
      const st = this.states.get(ext);
      const queues = this.queueIn.get(ext) ?? [];
      const cached = this.agentCache.get(ext);
      out[ext] = {
        extension: ext,
        state: st ? st.state : LOGGED_OUT,
        reason_code: st ? st.reason_code : null,
        since: st ? isoformatWithOffset(st.since) : null,
        duration_secs: st ? Math.max(0, Math.trunc((now.getTime() - st.since.getTime()) / 1000)) : 0,
        linkedid: st ? st.linkedid : null,
        queue: st ? st.queue : null,
        is_agent: st?.is_agent ?? cached?.v ?? this.queueIn.has(ext),
        queue_logged_in: this.queueIn.has(ext),
        queues: [...queues],
        reachable_via: this.viaOf(ext),
        dnd: this.dndOn.has(ext),
        held_break: st ? null : this.heldBreaks.get(ext)?.reason ?? null,
      };
    }
    return out;
  }

  /** Availability state of one extension ('logged_out' when offline). */
  stateOf(ext: string): string {
    return this.states.get(String(ext).trim())?.state ?? LOGGED_OUT;
  }
}
