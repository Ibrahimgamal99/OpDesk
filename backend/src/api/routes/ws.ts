/**
 * The /ws WebSocket: live state stream and client commands (api-contract.md §5).
 *
 * Nest does not route WebSockets, so main.ts calls attachWebSocket(server) with the HTTP
 * server; it answers the upgrade for `/ws` only (nginx sends /sip-ws straight to Asterisk).
 *
 * Handshake (OpDesk's, unchanged): the server accepts at once; the JWT comes from
 * `?token=` (third-party clients; an invalid one closes 4001) or, when there is none, from
 * the FIRST frame `{"token": "<jwt>"}` / `{"auth_token": "<jwt>"}` within 10 s (what the
 * web UI sends). Anything else closes with 4001, which the UI treats as "log in again".
 * API keys are not accepted here. The scope is resolved once per connection.
 *
 * Server -> client frames: initial_state, state_update, action_result {action, success,
 * message?}, error {message}, call_notification_new {extension}, call_outcome
 * {extension, status, linkedid}.
 */

import type { IncomingMessage, Server as HttpServer } from 'http';
import type { Server as HttpsServer } from 'https';
import type { Duplex } from 'stream';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { getBridge, liveExtensions, liveQueues, type LiveScope } from '../../core/event-bridge';
import { getLogger, pyStr } from '../../core/logger';
import { createTask, nowIso, truthy } from '../../core/py';
import { runtime } from '../../core/runtime';
import { authenticateWsToken, type Principal } from '../../core/security';
import * as dbm from '../../db/db-manager';
import { extFromInterface, normalizeInterface, sameNumber, type AMIExtensionsMonitor } from '../../services/ami';
import { NOT_READY_REASON_ERROR } from '../../services/agent-state';

const log = getLogger('api.routes.ws');

export const WS_CLOSE_TOKEN = 4001;
const AUTH_FRAME_TIMEOUT_SECONDS = 10;
const WS_MAX_SIZE = 16 * 1024 * 1024;
const WS_PING_INTERVAL_MS = 20_000;

// ---------------------------------------------------------------------------
// Frames in order, with a timeout for the auth frame
// ---------------------------------------------------------------------------
class Disconnected extends Error {}
class ReceiveTimeout extends Error {}

/** The socket's incoming text frames in order (a binary frame yields null). */
export class Inbox {
  private frames: (string | null)[] = [];
  private waiters: { resolve: (f: string | null) => void; reject: (e: Error) => void }[] = [];
  private closed = false;

  constructor(ws: WebSocket) {
    ws.on('message', (data: RawData, isBinary: boolean) => this.push(isBinary ? null : rawToString(data)));
    ws.on('close', () => {
      this.closed = true;
      for (const w of this.waiters.splice(0)) w.reject(new Disconnected());
    });
  }

  private push(frame: string | null): void {
    const w = this.waiters.shift();
    if (w) w.resolve(frame);
    else this.frames.push(frame);
  }

  receive(timeoutSeconds: number | null = null): Promise<string | null> {
    if (this.frames.length) return Promise.resolve(this.frames.shift()!);
    if (this.closed) return Promise.reject(new Disconnected());
    return new Promise((resolve, reject) => {
      let timer: NodeJS.Timeout | null = null;
      const waiter = {
        resolve: (f: string | null) => {
          if (timer) clearTimeout(timer);
          resolve(f);
        },
        reject: (e: Error) => {
          if (timer) clearTimeout(timer);
          reject(e);
        },
      };
      this.waiters.push(waiter);
      if (timeoutSeconds !== null) {
        timer = setTimeout(() => {
          this.waiters = this.waiters.filter((x) => x !== waiter);
          reject(new ReceiveTimeout());
        }, timeoutSeconds * 1000);
      }
    });
  }
}

function rawToString(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  return data.toString('utf8');
}

/** urllib.parse.unquote (no '+' -> space). */
export function unquote(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function isDict(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function get(d: Record<string, unknown>, k: string, fallback: unknown = null): unknown {
  return Object.prototype.hasOwnProperty.call(d, k) && d[k] !== undefined ? d[k] : fallback;
}

function closeSocket(ws: WebSocket, code: number): void {
  if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close(code);
}

/** Token -> Principal, or null when it is missing / invalid / expired. */
export async function wsAuthenticate(token: unknown): Promise<Principal | null> {
  if (!truthy(token) || typeof token !== 'string') return null;
  try {
    return (await authenticateWsToken(token)) || null;
  } catch {
    return null;
  }
}

/** The per-connection scope: role, own extension, HISTORY and LIVE lists. */
export function scopeFromPrincipal(p: Principal): LiveScope {
  return {
    user_id: p.id,
    username: p.username,
    role: p.role,
    extension: p.extension ? String(p.extension) : null,
    monitor_modes: p.monitor_modes,
    allowed_agent_extensions: p.allowed_agent_extensions,
    allowed_queue_names: p.allowed_queue_names,
    live_agent_extensions: p.live_agent_extensions,
    live_queue_names: p.live_queue_names,
  };
}

// ---------------------------------------------------------------------------
// Scope checks
// ---------------------------------------------------------------------------
/** May this connection SEE `ext` live? */
export function scopeCanAccessExtension(scope: LiveScope | null | undefined, ext: unknown): boolean {
  const allowed = liveExtensions(scope);
  if (allowed === null) return true;
  const e = pyStr(ext).trim();
  return allowed.includes(e) || (!!scope?.extension && String(scope.extension) === e);
}

/** May this connection SEE `queue` live? */
export function scopeCanAccessQueue(scope: LiveScope | null | undefined, queue: unknown): boolean {
  const allowed = liveQueues(scope);
  return allowed === null || allowed.includes(pyStr(queue).trim());
}

/**
 * Control / monitor actions on an extension (hangup, transfer, take_over, listen,
 * whisper, barge, agent_*). Agents may VIEW their group but CONTROL only their own
 * extension; supervisors control what they can see; admins everything.
 */
export function scopeCanControlExtension(scope: LiveScope | null | undefined, ext: unknown): boolean {
  if (scope && scope.role === 'agent') return pyStr(ext).trim() === String(scope.extension || '').trim();
  return scopeCanAccessExtension(scope, ext);
}

/**
 * Queue membership actions (add/remove/pause/unpause) on member `iface` of `queue`.
 * Agents may only act on their OWN member (any interface form) of a queue they can see;
 * supervisors on any member of a queue in scope; admins anywhere.
 */
export function scopeCanControlQueueMember(scope: LiveScope | null | undefined, queue: unknown, iface: unknown): boolean {
  if (scope && scope.role === 'agent') {
    const own = String(scope.extension || '').trim();
    if (!own || extFromInterface(pyStr(iface)) !== own) return false;
    return scopeCanAccessQueue(scope, queue);
  }
  return scopeCanAccessQueue(scope, queue);
}

/**
 * The extension whose call a transfer / take-over `source` belongs to, when this connection
 * may move it; null otherwise. The source is either an extension the connection controls,
 * or the party (an outside caller, a colleague) talking to such an extension's call. `ext`
 * names that extension (the Active Calls row); without it the controlled extensions on a
 * call with `source` are searched.
 */
export function transferSourceOwner(
  scope: LiveScope | null | undefined,
  monitor: AMIExtensionsMonitor,
  source: string,
  ext = '',
): string | null {
  const s = source.trim();
  const e = ext.trim();
  if (!s) return null;
  if (!e || e === s) {
    if (scopeCanControlExtension(scope, s)) return s;
    if (e) return null;
  }
  const talksTo = (owner: string) => {
    const peer = monitor.callPeerOf(owner);
    return !!peer && sameNumber(peer, s);
  };
  if (e) return scopeCanControlExtension(scope, e) && talksTo(e) ? e : null;
  for (const owner of monitor.activeCalls.keys()) {
    if (scopeCanControlExtension(scope, owner) && talksTo(owner)) return owner;
  }
  return null;
}

/**
 * Why this connection may not start `mode` (listen / whisper / barge) on `target` from
 * `supervisor`, or null when it may. Agents never supervise; the mode must be one the user
 * was granted; the spy leg rings the user's OWN extension (an admin may also ring another
 * extension of the PBX), so nobody can make a colleague's phone eavesdrop.
 */
export function supervisionRefusal(
  scope: LiveScope | null | undefined,
  monitor: AMIExtensionsMonitor,
  mode: string,
  supervisor: string,
  target: string,
): string | null {
  if (!scope || scope.role === 'agent') return 'Agents cannot supervise calls';
  const modes = Array.isArray(scope.monitor_modes) ? (scope.monitor_modes as string[]) : [];
  if (!modes.includes(mode)) return `Not allowed to ${mode}`;
  if (!/^[0-9]+$/.test(supervisor)) return 'Your extension must be a number';
  const own = String(scope.extension || '').trim();
  if (supervisor !== own && !(scope.role === 'admin' && monitor.monitored.has(supervisor))) {
    return 'Supervise from your own extension';
  }
  if (!scopeCanControlExtension(scope, target)) return 'Not allowed to monitor this extension';
  return null;
}

/** A queue member interface naming one extension: `<TECH>/<ext>` or `Local/<ext>@<context>[/n]`. */
export function isExtensionInterface(iface: string): boolean {
  return /^(PJSIP|SIP|IAX2|DAHDI)\/[0-9]{2,6}$/i.test(iface) || /^Local\/[0-9]{2,6}@[A-Za-z0-9_-]+(\/n)?$/i.test(iface);
}

/**
 * The Redirect target of a transfer: the client may only pick among the PBX's own dial
 * contexts (the AMI context, from-internal and the click-to-call context), and a numeric
 * priority. null when what the client sent is not one of those.
 */
export async function transferTarget(
  monitor: AMIExtensionsMonitor,
  context: unknown,
  priority: unknown,
): Promise<{ context: string | null; priority: string } | null> {
  const prio = priority === null || priority === undefined || priority === '' ? '1' : pyStr(priority).trim();
  if (!/^[1-9][0-9]{0,2}$/.test(prio)) return null;
  const ctx = context === null || context === undefined ? '' : pyStr(context).trim();
  if (!ctx) return { context: null, priority: prio };
  const allowed = new Set([monitor.context, 'from-internal']);
  try {
    const c2c = await dbm.getSetting('CLICK_TO_CALL_CONTEXT', process.env.CLICK_TO_CALL_CONTEXT || 'from-internal');
    if (c2c) allowed.add(String(c2c).trim());
  } catch (e) {
    log.debug('click-to-call context lookup failed: %s', e);
  }
  return allowed.has(ctx) ? { context: ctx, priority: prio } : null;
}

function sameSet(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Server wiring
// ---------------------------------------------------------------------------
let attached: WebSocketServer | null = null;

/** Close every /ws connection with 1012 (service restart) on shutdown. */
export function closeWebSockets(): void {
  if (!attached) return;
  for (const client of attached.clients) {
    try {
      client.close(1012, 'Service restart');
    } catch {
      client.terminate();
    }
  }
  attached.close();
  attached = null;
}

export function attachWebSocket(server: HttpServer | HttpsServer): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: true, maxPayload: WS_MAX_SIZE });
  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = req.url ?? '/';
    const q = url.indexOf('?');
    const pathname = q >= 0 ? url.slice(0, q) : url;
    if (pathname !== '/ws' && pathname !== '/ws/') return;
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });
  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    keepAlive(ws);
    createTask(serveConnection(ws, req));
  });
  attached = wss;
  return wss;
}

function keepAlive(ws: WebSocket): void {
  let alive = true;
  ws.on('pong', () => {
    alive = true;
  });
  const timer = setInterval(() => {
    if (!alive) {
      ws.terminate();
      return;
    }
    alive = false;
    try {
      ws.ping();
    } catch {
      // closing
    }
  }, WS_PING_INTERVAL_MS);
  timer.unref();
  ws.on('close', () => clearInterval(timer));
}

export async function serveConnection(ws: WebSocket, req: IncomingMessage): Promise<void> {
  ws.on('error', (e) => log.debug('WebSocket transport error: %s', e));
  try {
    await websocketEndpoint(ws, req);
  } catch (e) {
    log.error('WebSocket handler failed: %s', e);
  }
}

/** Token from `?token=` (raw query parsed by hand, as the Python did). */
export function queryToken(url: string): string | null {
  const qi = url.indexOf('?');
  if (qi < 0) return null;
  for (const part of url.slice(qi + 1).split('&')) {
    if (part.startsWith('token=')) return unquote(part.slice(6).trim()) || null;
  }
  return null;
}

export async function websocketEndpoint(websocket: WebSocket, request: IncomingMessage): Promise<void> {
  const inbox = new Inbox(websocket); // before any await: no frame may be missed
  let token: string | null = queryToken(request.url ?? '');
  let principal: Principal | null = null;
  if (token) {
    principal = await wsAuthenticate(token);
    if (!principal) {
      closeSocket(websocket, WS_CLOSE_TOKEN);
      return;
    }
  } else {
    try {
      const data = await inbox.receive(AUTH_FRAME_TIMEOUT_SECONDS);
      const msg: unknown = data === null ? null : JSON.parse(data);
      if (isDict(msg)) {
        const t = get(msg, 'token') || get(msg, 'auth_token');
        token = typeof t === 'string' ? t : null;
      }
    } catch (e) {
      if (e instanceof Disconnected) return;
      // timeout / invalid JSON -> 4001 below
    }
    principal = token ? await wsAuthenticate(token) : null;
    if (!principal) {
      closeSocket(websocket, WS_CLOSE_TOKEN);
      return;
    }
  }

  const scope = scopeFromPrincipal(principal);
  await runtime.manager.connect(websocket, scope as never);
  try {
    const bridge = getBridge();
    if (bridge) {
      const state = await bridge.getCurrentState(liveExtensions(scope), liveQueues(scope));
      await runtime.manager.sendPersonal(websocket, { type: 'initial_state', data: state, timestamp: nowIso() });
    }
    for (;;) {
      const data = await inbox.receive();
      let message: unknown;
      try {
        if (data === null) throw new SyntaxError('binary frame');
        message = JSON.parse(data);
      } catch {
        await runtime.manager.sendPersonal(websocket, { type: 'error', message: 'Invalid JSON' });
        continue;
      }
      // Auth frames after authentication are ignored.
      if (isDict(message) && (truthy(get(message, 'token')) || get(message, 'action') === 'auth')) continue;
      await handleClientMessage(websocket, message);
    }
  } catch (e) {
    if (!(e instanceof Disconnected)) {
      const errMsg = pyStr(e).toLowerCase();
      if (!errMsg.includes('close') && !errMsg.includes('disconnect') && !errMsg.includes('not connected')) {
        log.error(`WebSocket error: ${pyStr(e)}`);
      }
    }
  } finally {
    await runtime.manager.disconnect(websocket);
  }
}

// ---------------------------------------------------------------------------
// Client commands
// ---------------------------------------------------------------------------
type Send = (msg: Record<string, unknown>) => Promise<unknown>;

function actionResult(action: string, success: boolean, message?: string | null): Record<string, unknown> {
  const out: Record<string, unknown> = { type: 'action_result', action, success };
  if (message !== undefined && message !== null) out.message = message;
  return out;
}

async function broadcastNow(): Promise<void> {
  const bridge = getBridge();
  if (bridge) await bridge.broadcastStateNow();
}

/** Handle one client command. Scope is enforced per action. */
export async function handleClientMessage(websocket: WebSocket, message: unknown): Promise<void> {
  const send: Send = (msg) => runtime.manager.sendPersonal(websocket, msg);
  const monitor = runtime.monitor;
  if (!monitor || !monitor.connected) {
    await send({ type: 'error', message: 'Not connected to AMI' });
    return;
  }
  const scope = runtime.manager.getScope(websocket) as LiveScope;
  const m: Record<string, unknown> = isDict(message) ? message : {};
  const action = pyStr(get(m, 'action', '') ?? '');

  try {
    switch (action) {
      case 'get_state': {
        const bridge = getBridge();
        if (bridge) {
          const state = await bridge.getCurrentState(liveExtensions(scope), liveQueues(scope));
          await send({ type: 'state_update', data: state, timestamp: nowIso() });
        }
        return;
      }
      case 'sync': {
        // It writes the agents and queues tables: an admin's action. Everyone else refreshes
        // the live state with sync_calls / sync_queues.
        if (scope.role !== 'admin') {
          await send(actionResult('sync', false, 'Only an admin can run a full sync'));
          return;
        }
        // Reconcile extensions with the PBX (refresh names; prune removed ones only when the
        // extension set really changed), then resync live status, calls and queues.
        const extensions = await dbm.getExtensionsFromDb();
        if (extensions !== null && extensions !== undefined) {
          const names = await dbm.getExtensionNamesFromDb();
          const fresh = new Set(extensions.map((e) => String(e)));
          const bridge = getBridge();
          if (bridge) {
            bridge.extensionNames = names;
            bridge.invalidateNames();
          }
          const changed = !sameSet(fresh, monitor.monitored);
          monitor.monitored = fresh;
          await dbm.syncAgentsFromExtensions([...fresh], names, changed);
        }
        await monitor.loadDeviceTechs();
        await monitor.syncExtensionStatuses();
        await monitor.syncActiveCalls();
        await monitor.syncQueueStatus();
        await monitor.syncDndState();
        // New queues are added and names refreshed, never pruned: a queue missing from one
        // QueueStatus reply would take its group links with it.
        await dbm.syncQueuesFromList([...monitor.queues.keys()], await dbm.getQueueNamesFromDb());
        await send(actionResult('sync', true, 'Full sync completed'));
        return;
      }
      case 'sync_calls':
        await monitor.syncActiveCalls();
        await send(actionResult('sync_calls', true));
        return;
      case 'sync_queues':
        await monitor.syncQueueStatus();
        await send(actionResult('sync_queues', true));
        return;
      case 'listen':
      case 'whisper':
      case 'barge': {
        const supervisor = pyStr(get(m, 'supervisor', '') ?? '').trim();
        const target = pyStr(get(m, 'target', '') ?? '').trim();
        if (!supervisor || !target) return;
        const refusal = supervisionRefusal(scope, monitor, action, supervisor, target);
        if (refusal) {
          await send(actionResult(action, false, refusal));
          return;
        }
        let result: boolean;
        let verb: string;
        if (action === 'listen') {
          result = await monitor.listenToCall(supervisor, target);
          verb = 'listening to';
        } else if (action === 'whisper') {
          result = await monitor.whisperToCall(supervisor, target);
          verb = 'whispering to';
        } else {
          result = await monitor.bargeIntoCall(supervisor, target);
          verb = 'barging into';
        }
        await send(actionResult(action, result, `${result ? 'Started' : 'Failed to start'} ${verb} ${target}`));
        return;
      }
      case 'hangup': {
        const target = pyStr(get(m, 'target', '') ?? '');
        if (!target) return;
        if (!scopeCanControlExtension(scope, target)) {
          await send(actionResult('hangup', false, 'Not allowed to control this extension'));
          return;
        }
        const result = await monitor.hangupCall(target);
        await send(actionResult('hangup', result, `${result ? 'Hangup requested' : 'Failed to hang up'} for ${target}`));
        if (result) await broadcastNow();
        return;
      }
      case 'transfer': {
        const source = pyStr(get(m, 'source', '') ?? '').trim();
        const destination = pyStr(get(m, 'destination', '') ?? '').trim();
        if (!source || !destination) {
          await send(actionResult('transfer', false, 'Source and destination required'));
          return;
        }
        const owner = transferSourceOwner(scope, monitor, source, pyStr(get(m, 'ext', '') ?? ''));
        if (!owner) {
          await send(actionResult('transfer', false, 'Not allowed to control this extension'));
          return;
        }
        const redirect = await transferTarget(monitor, get(m, 'context'), get(m, 'priority'));
        if (!redirect) {
          await send(actionResult('transfer', false, 'Transfer context not allowed'));
          return;
        }
        const result = await monitor.transferCall(source, destination, { ...redirect, owner });
        await send(actionResult('transfer', result, `${result ? 'Transfer requested' : 'Failed to transfer'} ${source} to ${destination}`));
        if (result) await broadcastNow();
        return;
      }
      case 'take_over': {
        const source = pyStr(get(m, 'source', '') ?? '').trim();
        const destination = String(scope.extension || '').trim();
        const owner = source ? transferSourceOwner(scope, monitor, source, pyStr(get(m, 'ext', '') ?? '')) : null;
        const redirect = await transferTarget(monitor, get(m, 'context'), get(m, 'priority'));
        if (!source) {
          await send(actionResult('take_over', false, 'Source required'));
        } else if (!destination) {
          await send(actionResult('take_over', false, 'No extension assigned to your user; cannot take over'));
        } else if (!owner) {
          await send(actionResult('take_over', false, 'Not allowed to control this extension'));
        } else if (!redirect) {
          await send(actionResult('take_over', false, 'Transfer context not allowed'));
        } else {
          const result = await monitor.transferCall(source, destination, { ...redirect, owner });
          await send(actionResult('take_over', result,
            `${result ? 'Call transferred to you' : 'Failed to take over'} (${source} → ${destination})`));
          if (result) await broadcastNow();
        }
        return;
      }
      case 'queue_add':
      case 'queue_remove':
      case 'queue_pause':
      case 'queue_unpause':
        await handleQueueAction(action, m, scope, send);
        return;
      case 'agent_login':
      case 'agent_logout':
      case 'agent_set_status':
      case 'agent_wrapup_done':
        await handleAgentAction(action, m, scope, send);
        return;
      default:
        await send({ type: 'error', message: `Unknown action: ${action}` });
    }
  } catch (e) {
    log.error(`Error handling action ${action}: ${pyStr(e)}`);
    await send({ type: 'error', message: pyStr(e) });
  }
}

async function handleQueueAction(action: string, m: Record<string, unknown>, scope: LiveScope, send: Send): Promise<void> {
  const monitor = runtime.monitor!;
  const queue = pyStr(get(m, 'queue', '') ?? '').trim();
  const raw = pyStr(get(m, 'interface', '') ?? '').trim();
  // A bare extension gets the device's real driver (SIP on a chan_sip Issabel extension).
  const iface = raw && !raw.includes('/') ? monitor.deviceInterface(raw) : normalizeInterface(raw);
  if (!queue || !iface) return;
  if (!scopeCanControlQueueMember(scope, queue, iface)) {
    await send(actionResult(action, false, 'Not allowed to manage this queue'));
    return;
  }
  // A member is one extension's device, and one this connection can see: never a trunk,
  // an arbitrary Local channel or a dial string.
  if (action === 'queue_add' && (!isExtensionInterface(iface) || !scopeCanAccessExtension(scope, extFromInterface(iface)))) {
    await send(actionResult(action, false, `Not an extension interface: ${iface}`));
    return;
  }
  let success: boolean;
  let msg: string;
  if (action === 'queue_add') {
    const paused = truthy(get(m, 'paused', false));
    const reason = pyStr(get(m, 'reason', '') ?? '').trim();
    [success, msg] = await monitor.queueAdd(queue, iface, {
      penalty: Number(get(m, 'penalty', 0)) || 0,
      membername: pyStr(get(m, 'membername', '') ?? '') || null,
      paused,
      reason: paused && reason ? reason : null,
    });
    if (!success) msg = `Failed to add ${iface} to ${queue}: ${msg}`;
  } else if (action === 'queue_remove') {
    [success, msg] = await monitor.queueRemove(queue, iface);
    if (!success) msg = `Failed to remove ${iface} from ${queue}: ${msg}`;
  } else if (action === 'queue_pause') {
    const reason = pyStr(get(m, 'reason', '') ?? '').trim();
    [success, msg] = await monitor.queuePause(queue, iface, { paused: true, reason });
    if (!success) msg = `Failed to pause ${iface} in ${queue}: ${msg}`;
  } else {
    [success, msg] = await monitor.queueUnpause(queue, iface);
    if (!success) msg = `Failed to unpause ${iface} in ${queue}: ${msg}`;
  }
  await send(actionResult(action, success, msg));
  if (success) await broadcastNow();
}

async function handleAgentAction(action: string, m: Record<string, unknown>, scope: LiveScope, send: Send): Promise<void> {
  // Self-service by default; `agent` / `target` lets a supervisor act on an agent in scope.
  const raw = get(m, 'agent') || get(m, 'target') || scope.extension || '';
  const target = pyStr(raw).trim();
  const agentState = runtime.agentState;
  if (!target) {
    await send(actionResult(action, false, 'No agent extension'));
    return;
  }
  if (!agentState) {
    await send(actionResult(action, false, 'Agent presence not available'));
    return;
  }
  if (!scopeCanControlExtension(scope, target)) {
    await send(actionResult(action, false, 'Not allowed to control this agent'));
    return;
  }
  const src = target !== String(scope.extension || '') ? 'supervisor' : 'ui';
  let result: [boolean, string];
  if (action === 'agent_login') {
    result = await agentState.login(target, src);
  } else if (action === 'agent_logout') {
    result = await agentState.logout(target, src);
  } else if (action === 'agent_wrapup_done') {
    result = await agentState.finishWrapup(target, src);
  } else {
    const status = pyStr(get(m, 'status', '') ?? '').trim();
    if (status === 'ready') result = await agentState.setReady(target, src);
    else if (status === 'not_ready') {
      const code = pyStr(get(m, 'reason_code', '') ?? '').trim();
      result = code ? await agentState.setNotReady(target, code, src) : [false, NOT_READY_REASON_ERROR];
    } else if (status === 'dnd') result = await agentState.setDnd(target, src);
    else if (status === 'available') result = await agentState.setAvailable(target, src);
    else if (status === 'offline') result = await agentState.setOffline(target, src);
    else result = [false, 'Unknown status'];
  }
  await send(actionResult(action, result[0], result[1]));
  if (result[0]) await broadcastNow();
}
