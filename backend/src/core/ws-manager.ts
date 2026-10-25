/**
 * WebSocket client registry: tracks connected clients and their scopes, and broadcasts to them
 * (server.py ConnectionManager).
 *
 * Every connection carries the scope it authenticated with (both the history and the live
 * lists, see core/scope.ts). Broadcasts are filtered by the LIVE scope, so a frame never
 * reaches a browser that may not see what it describes:
 *   - `state_update` / `initial_state` frames have their `data` narrowed per connection
 *     (filterLiveState);
 *   - a frame naming an `extension` goes only to connections that may see that extension live;
 *   - anything else goes to everyone.
 */

import { WebSocket } from 'ws';
import { getLogger } from './logger';
import { AsyncLock, pyDatetimeStr } from './py';
import { canSeeExtensionLive, filterLiveState } from './scope';
import type { Principal } from './security';

const log = getLogger('core.ws_manager');

/** One connection's scope: who it is and what it may see. */
export interface ConnectionScope {
  user_id?: number | null;
  username?: string | null;
  role?: string | null;
  extension?: string | null;
  monitor_modes?: string[];
  allowed_agent_extensions?: string[] | null;
  allowed_queue_names?: string[] | null;
  live_agent_extensions?: string[] | null;
  live_queue_names?: string[] | null;
  [key: string]: unknown;
}

/** The scope a socket stores for an authenticated principal. */
export function scopeFromPrincipal(p: Principal): ConnectionScope {
  return {
    user_id: p.id,
    username: p.username,
    role: p.role,
    extension: p.extension,
    monitor_modes: [...p.monitor_modes],
    allowed_agent_extensions: p.allowed_agent_extensions,
    allowed_queue_names: p.allowed_queue_names,
    live_agent_extensions: p.live_agent_extensions,
    live_queue_names: p.live_queue_names,
  };
}

/**
 * json.dumps(message, default=str): a datetime that reaches a frame is written as str(dt)
 * ("2026-10-18 21:00:00"), not JSON.stringify's UTC ISO form. A Map is written as an object
 * and a Set as an array, so a monitor dict ported as a Map serialises as the Python dict did.
 */
export function dumps(message: unknown): string {
  return JSON.stringify(message, function (this: Record<string, unknown>, key: string, value: unknown) {
    const raw = this[key];
    if (raw instanceof Date) return pyDatetimeStr(raw);
    if (value instanceof Map) return Object.fromEntries(value);
    if (value instanceof Set) return [...value];
    return value;
  });
}

/**
 * Starlette's `await websocket.send_text(data)`: rejects when the socket is not open or the
 * write fails, so callers can drop the connection where Python caught the exception.
 */
export function sendText(ws: WebSocket, data: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (ws.readyState !== WebSocket.OPEN) {
      reject(new Error('WebSocket is not connected'));
      return;
    }
    try {
      ws.send(data, (err) => (err ? reject(err) : resolve()));
    } catch (e) {
      reject(e);
    }
  });
}

/** `old.get(k) == new.get(k)` for the scope values (None, str, list of str). */
function pyEq(a: unknown, b: unknown): boolean {
  const na = a === undefined ? null : a;
  const nb = b === undefined ? null : b;
  if (Array.isArray(na) && Array.isArray(nb)) {
    return na.length === nb.length && na.every((x, i) => pyEq(x, nb[i]));
  }
  return na === nb;
}

const STATE_FRAMES = new Set(['state_update', 'initial_state']);

// The keys that decide visibility; a refresh that changes none of them re-pushes nothing.
const VISIBILITY_KEYS = ['role', 'allowed_agent_extensions', 'allowed_queue_names', 'live_agent_extensions', 'live_queue_names'];

/** Manages WebSocket connections and broadcasts. Stores per-connection user scope for filtered state. */
export class ConnectionManager {
  activeConnections: Set<WebSocket> = new Set();
  /** websocket -> scope */
  connectionScope: Map<WebSocket, ConnectionScope> = new Map();
  // asyncio.Lock in Python. Node is single threaded and none of the critical sections
  // await, so this only keeps the Python ordering.
  lock = new AsyncLock();

  constructor() {
    // Passed around as bare callables (monitor callbacks, services).
    this.broadcast = this.broadcast.bind(this);
    this.broadcastAll = this.broadcastAll.bind(this);
    this.sendToExtension = this.sendToExtension.bind(this);
  }

  /** Register an already-accepted WebSocket with its scope. */
  async connect(websocket: WebSocket, userScope: ConnectionScope | null = null): Promise<void> {
    await this.lock.run(() => {
      this.activeConnections.add(websocket);
      this.connectionScope.set(websocket, userScope || {});
    });
    log.info(`Client connected. Total connections: ${this.activeConnections.size}`);
  }

  async disconnect(websocket: WebSocket): Promise<void> {
    await this.lock.run(() => {
      this.activeConnections.delete(websocket);
      this.connectionScope.delete(websocket);
    });
    log.info(`Client disconnected. Total connections: ${this.activeConnections.size}`);
  }

  /** Replace one live connection's scope. */
  async updateScope(websocket: WebSocket, userScope: ConnectionScope): Promise<void> {
    await this.lock.run(() => {
      if (this.activeConnections.has(websocket)) this.connectionScope.set(websocket, userScope || {});
    });
  }

  /** The scope this connection authenticated with ({} when unknown). */
  getScope(websocket: WebSocket): ConnectionScope {
    return this.connectionScope.get(websocket) ?? {};
  }

  /** [(ws, scope)] for every open connection, snapshotted. */
  async snapshot(): Promise<[WebSocket, ConnectionScope][]> {
    return this.lock.run(() => [...this.activeConnections].map((ws): [WebSocket, ConnectionScope] => [ws, this.getScope(ws)]));
  }

  /**
   * Re-resolve every connection's scope and return [(ws, scope)] for the ones whose
   * visibility actually changed. A scope is read once at connect; callers that change group
   * membership call this so the change reaches already-connected browsers. One load per
   * distinct user; sockets that disconnect meanwhile are not resurrected.
   */
  async refreshScopes(
    resolve: (userId: number) => ConnectionScope | null | undefined | Promise<ConnectionScope | null | undefined>,
  ): Promise<[WebSocket, ConnectionScope][]> {
    const targets = await this.lock.run(() => {
      const out: [WebSocket, number][] = [];
      for (const [ws, sc] of this.connectionScope) if (sc.user_id) out.push([ws, sc.user_id]);
      return out;
    });
    if (!targets.length) return [];
    const resolved = new Map<number, ConnectionScope | null | undefined>();
    for (const uid of new Set(targets.map(([, uid]) => uid))) resolved.set(uid, await resolve(uid));
    const changed: [WebSocket, ConnectionScope][] = [];
    await this.lock.run(() => {
      for (const [ws, uid] of targets) {
        if (!this.activeConnections.has(ws)) continue;
        const fresh = resolved.get(uid);
        if (!fresh) continue;
        const old = this.connectionScope.get(ws) || {};
        const next: ConnectionScope = { ...old, ...fresh, user_id: uid };
        if (VISIBILITY_KEYS.every((k) => pyEq(old[k], next[k]))) continue;
        this.connectionScope.set(ws, next);
        changed.push([ws, next]);
      }
    });
    if (changed.length) log.info(`Scope refreshed for ${changed.length} live connection(s) after a membership change`);
    return changed;
  }

  private async drop(disconnected: Set<WebSocket>): Promise<void> {
    if (!disconnected.size) return;
    await this.lock.run(() => {
      for (const ws of disconnected) {
        this.activeConnections.delete(ws);
        this.connectionScope.delete(ws);
      }
    });
  }

  /**
   * Broadcast a frame, filtered by each connection's LIVE scope (see the module comment).
   * Use broadcastAll() for a frame every client must get whatever it may see.
   */
  async broadcast(message: Record<string, unknown>): Promise<void> {
    if (!this.activeConnections.size) return;
    const type = String(message.type ?? '');
    const data = message.data;
    const isState = STATE_FRAMES.has(type) && typeof data === 'object' && data !== null && !Array.isArray(data);
    const ext = typeof message.extension === 'string' || typeof message.extension === 'number' ? String(message.extension) : null;
    if (!isState && ext === null) {
      await this.broadcastAll(message);
      return;
    }
    await this.broadcastScoped((scope) => {
      if (isState) return { ...message, data: filterLiveState(scope, data as Record<string, unknown>) };
      return canSeeExtensionLive(scope, ext) ? message : null;
    });
  }

  /** Broadcast the same frame to every connected client, unfiltered. */
  async broadcastAll(message: Record<string, unknown>): Promise<void> {
    if (!this.activeConnections.size) return;
    const data = dumps(message);
    const connections = await this.lock.run(() => [...this.activeConnections]);
    const disconnected = new Set<WebSocket>();
    for (const connection of connections) {
      try {
        await sendText(connection, data);
      } catch {
        disconnected.add(connection);
      }
    }
    await this.drop(disconnected);
  }

  /**
   * Send each connection the frame `build` makes for its scope (null skips it). This is how
   * the state loop sends every client its own filtered snapshot.
   */
  async broadcastScoped(
    build: (scope: ConnectionScope, ws: WebSocket) => Record<string, unknown> | null | undefined | Promise<Record<string, unknown> | null | undefined>,
  ): Promise<void> {
    const targets = await this.snapshot();
    const disconnected = new Set<WebSocket>();
    for (const [ws, scope] of targets) {
      let frame: Record<string, unknown> | null | undefined;
      try {
        frame = await build(scope, ws);
      } catch (e) {
        log.warning('Could not build a frame for a connection: %s', e);
        continue;
      }
      if (!frame) continue;
      try {
        await sendText(ws, dumps(frame));
      } catch {
        disconnected.add(ws);
      }
    }
    await this.drop(disconnected);
  }

  /**
   * Send a frame only to the connections of users whose own extension is `ext`, for pushes
   * that must not reach anyone else's browser. No-op when none is open.
   */
  async sendToExtension(ext: string | number | null | undefined, message: Record<string, unknown>): Promise<void> {
    const target = String(ext ?? '').trim();
    if (!target) return;
    await this.broadcastScoped((scope) => (String(scope.extension ?? '').trim() === target ? message : null));
  }

  /** Send a frame to one client. false when it is gone or the write failed. */
  async sendPersonal(websocket: WebSocket, message: Record<string, unknown>): Promise<boolean> {
    if (!this.activeConnections.has(websocket)) return false;
    try {
      await sendText(websocket, dumps(message));
      return true;
    } catch {
      return false;
    }
  }
}
