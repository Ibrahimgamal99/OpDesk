/**
 * Who may see what. Pure rules over the lists core/security.ts loads into the principal.
 *
 * Two scopes, deliberately different:
 *
 *   HISTORY  call log, recordings, journey, VAD, notifications, analytics.
 *            admin / API key: everything (null).
 *            supervisor:      the agent extensions and queues of the groups they belong to.
 *            agent:           their OWN extension only. Group membership lets a team see each
 *                             other work; it does not let one agent read another's call record.
 *
 *   LIVE     Extensions / Queues / Active-calls panels and every WS state frame.
 *            admin / API key: everything (null).
 *            supervisor:      same lists as history.
 *            agent:           own extension + every agent extension and queue of every group the
 *                             agent belongs to (through their account or their extension).
 *
 * `null` always means unrestricted; an empty list means nothing. Functions accept either a
 * request Principal or a WS ConnectionScope (both carry the same keys).
 */

import { HttpError } from '../api/http-error';
import type { Row } from '../db/pool';

/** The keys the rules read: a Principal or a ws-manager ConnectionScope. */
export interface ScopeLike {
  role?: string | null;
  extension?: string | null;
  api_key?: boolean;
  allowed_agent_extensions?: string[] | null;
  allowed_queue_names?: string[] | null;
  live_agent_extensions?: string[] | null;
  live_queue_names?: string[] | null;
}

/** Admins and API keys (role admin with null lists) see everything. */
export function isUnrestricted(p: ScopeLike | null | undefined): boolean {
  return Boolean(p && (p.role === 'admin' || p.api_key));
}

function asList(v: string[] | null | undefined): string[] | null {
  // undefined (a key that was never loaded) denies; only an explicit null is unrestricted.
  if (v === null) return null;
  return (v || []).map(String);
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

/** Extensions whose call history `p` may read. null = no filter. */
export function historyExtensions(p: ScopeLike): string[] | null {
  if (isUnrestricted(p)) return null;
  if (p.role === 'agent') {
    const ext = String(p.extension ?? '').trim();
    return ext ? [ext] : [];
  }
  return asList(p.allowed_agent_extensions);
}

/** Queues whose history `p` may read. null = no filter; agents get none. */
export function historyQueues(p: ScopeLike): string[] | null {
  if (isUnrestricted(p)) return null;
  if (p.role === 'agent') return [];
  return asList(p.allowed_queue_names);
}

export function canSeeExtensionHistory(p: ScopeLike, ext: unknown): boolean {
  const allowed = historyExtensions(p);
  return allowed === null || allowed.includes(String(ext ?? '').trim());
}

/**
 * The extension a channel belongs to: `PJSIP/101-0000002a` -> 101, `SIP/101-...` -> 101,
 * `Local/101@from-queue-0001;1` -> 101. null for anything without one.
 */
export function channelExtension(channel: unknown): string | null {
  const s = String(channel ?? '').trim();
  if (!s) return null;
  const m = /^[A-Za-z0-9_]+\/([^-@;/]+)/.exec(s);
  return m ? m[1] : null;
}

/** Every extension a CDR/CEL leg touches: src, dst, cnum, and the channels' extensions. */
export function legExtensions(leg: Row): Set<string> {
  const out = new Set<string>();
  for (const key of ['src', 'dst', 'cnum']) {
    const v = leg[key];
    if (v !== null && v !== undefined && String(v).trim()) out.add(String(v).trim());
  }
  for (const key of ['channel', 'dstchannel']) {
    const ext = channelExtension(leg[key]);
    if (ext) out.add(ext);
  }
  return out;
}

/**
 * Authorize a single-call read (journey, VAD, recording audio) against the history scope.
 *
 * Those endpoints take a call id straight from the client; filtering only the list would
 * let anyone holding an id read any call. Passes when some leg's src/dst/channel/dstchannel
 * extension is in scope. No legs (call not found) is a denial for scoped users, never a
 * fall-through.
 */
export function assertCallVisible(p: ScopeLike, legs: Row[]): void {
  const allowed = historyExtensions(p);
  if (allowed === null) return;
  const set = new Set(allowed);
  for (const leg of legs || []) {
    for (const ext of legExtensions(leg)) if (set.has(ext)) return;
  }
  throw new HttpError(403, 'Not allowed to view this call');
}

/**
 * _analytics_scope: [queues, extensions] filters for analytics. Agents get a 403; admin
 * (null, null); a supervisor their groups' lists.
 */
export function analyticsScope(p: ScopeLike): [string[] | null, string[] | null] {
  if (p.role === 'agent' && !p.api_key) throw new HttpError(403, 'Agents do not have access to analytics');
  if (isUnrestricted(p)) return [null, null];
  return [asList(p.allowed_queue_names) ?? [], asList(p.allowed_agent_extensions) ?? []];
}

// ---------------------------------------------------------------------------
// Live
// ---------------------------------------------------------------------------

/** Extensions `p` may see live. null = all. Falls back to the history list when no live list was loaded. */
export function liveExtensions(p: ScopeLike): string[] | null {
  if (isUnrestricted(p)) return null;
  if (p.live_agent_extensions !== undefined) return asList(p.live_agent_extensions);
  return historyExtensions(p);
}

/** Queues `p` may see live. null = all. */
export function liveQueues(p: ScopeLike): string[] | null {
  if (isUnrestricted(p)) return null;
  if (p.live_queue_names !== undefined) return asList(p.live_queue_names);
  return historyQueues(p);
}

export function canSeeExtensionLive(p: ScopeLike, ext: unknown): boolean {
  const allowed = liveExtensions(p);
  return allowed === null || allowed.includes(String(ext ?? '').trim());
}

export function canSeeQueueLive(p: ScopeLike, queue: unknown): boolean {
  const allowed = liveQueues(p);
  return allowed === null || allowed.includes(String(queue ?? '').trim());
}

type Dict = Record<string, unknown>;

function isDict(v: unknown): v is Dict {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Map);
}

function pickKeys(obj: unknown, keep: (key: string, value: unknown) => boolean): unknown {
  if (obj instanceof Map) {
    const out = new Map<unknown, unknown>();
    for (const [k, v] of obj) if (keep(String(k), v)) out.set(k, v);
    return out;
  }
  if (!isDict(obj)) return obj;
  const out: Dict = {};
  for (const [k, v] of Object.entries(obj)) if (keep(k, v)) out[k] = v;
  return out;
}

function sizeOf(obj: unknown): number {
  if (obj instanceof Map) return obj.size;
  return isDict(obj) ? Object.keys(obj).length : 0;
}

function valuesOf(obj: unknown): unknown[] {
  if (obj instanceof Map) return [...obj.values()];
  return isDict(obj) ? Object.values(obj) : [];
}

/**
 * Narrow a live state snapshot (the WS `State`: extensions, active_calls, queues,
 * queue_members, queue_entries, agent_states, stats) to what `p` may see live. Keys keyed
 * by extension or queue are filtered; member/entry rows by their `queue`; `stats` is
 * recomputed from what is left. Unknown keys pass through. Returns the same object when
 * the principal is unrestricted.
 */
export function filterLiveState<T extends Dict>(p: ScopeLike, state: T): T {
  const exts = liveExtensions(p);
  const queues = liveQueues(p);
  if (exts === null && queues === null) return state;
  const extOk = (k: string) => exts === null || exts.includes(k);
  const queueOk = (k: unknown) => queues === null || queues.includes(String(k ?? ''));
  const out: Dict = { ...state };
  for (const key of ['extensions', 'active_calls', 'agent_states']) {
    if (key in out) out[key] = pickKeys(out[key], (k) => extOk(k));
  }
  if ('queues' in out) out.queues = pickKeys(out.queues, (k) => queueOk(k));
  for (const key of ['queue_members', 'queue_entries']) {
    if (key in out) out[key] = pickKeys(out[key], (_k, v) => isDict(v) && queueOk(v.queue));
  }
  if (isDict(out.stats)) {
    let waiting = 0;
    for (const q of valuesOf(out.queues)) {
      if (isDict(q)) waiting += Number(q.calls_waiting) || 0;
    }
    out.stats = {
      ...out.stats,
      total_extensions: sizeOf(out.extensions),
      active_calls_count: sizeOf(out.active_calls),
      total_queues: sizeOf(out.queues),
      total_waiting: waiting,
    };
  }
  return out as T;
}
