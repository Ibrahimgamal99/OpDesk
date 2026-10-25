/**
 * RFC 8599 push gateway for Asterisk.
 *
 * RFC 8599 has the softphone, not an app-side API, tell the registrar how to wake it: the
 * REGISTER Contact URI carries
 *
 *     pn-provider   fcm | apns | apns-sandbox
 *     pn-prid       the device's push token (FCM registration token / PushKit VoIP token)
 *     pn-param      FCM: the Firebase project ID; APNs: "<Team ID>.<topic>" (optional)
 *
 * and the proxy, on an INVITE for that binding, sends a push, holds the INVITE until the
 * device re-registers, then forwards it. Asterisk does not do this itself, so OpDesk does it
 * next to it:
 *
 *   * Bindings are learned from Asterisk's PJSIP contacts over AMI (ContactStatus events,
 *     plus a full PJSIPShowContacts sync at startup and every SYNC_INTERVAL) and kept in the
 *     sip_push_bindings table after the registration itself has expired.
 *   * The [from-internal-custom] hook (services/dialplan.ts writeMobileWakeConf) asks wake()
 *     before the extension is dialed. With a binding, wake() snapshots the extension's
 *     contacts, sends a "call" push and returns true ("1" to the dialplan); the dialplan then
 *     polls ready() every 0.5 s for up to the hold time, waits the settle window, and lets
 *     the PBX dial as usual.
 *   * ready() is true once a mobile contact registered after the push: a new contact, or a
 *     refreshed one (later expiration). A mobile contact is one whose URI has pn-* params or
 *     whose User-Agent contains the mobile client marker.
 *   * If the caller hangs up during the hold, or the hold runs out, cancel() sends a
 *     "cancel" push so the phone stops ringing (FCM only; see push-service sendRfc8599).
 *
 * Push payload (the Medut-SDK contract): type ("call" | "cancel"), caller_uri, caller_name,
 * aor. There is deliberately no call_id: Asterisk picks the INVITE's Call-ID itself, and the
 * app turns away an INVITE whose Call-ID differs from the one its push named.
 *
 * The AMI connection here is separate from the call monitor's: polling contacts on the
 * monitor's connection would swallow call events that arrive while a reply is awaited.
 *
 * Python: backend/sip_push.py
 */

import * as net from 'net';
import { amiActionAllowed, refused } from '../core/shadow';

import { env } from '../core/config';
import { getLogger } from '../core/logger';
import { runtime } from '../core/runtime';
import { createTask, monotonic, pyInt } from '../core/py';
import * as dbm from '../db/db-manager';
import type { Row } from '../db/pool';
import { monitoredExtensions } from '../integrations/crm-lookup';
import * as pushService from '../integrations/push-service';

const log = getLogger('services.sip_push');

export const SYNC_INTERVAL = 600; // full contact sync, seconds
export const PENDING_TTL = 90; // forget a wake the dialplan never closed, seconds
export const DEFAULT_HOLD = 10;
export const DEFAULT_SETTLE = 3;
export const DEFAULT_MARKER = 'Medut'; // Medut's User-Agent is "Medut/<version> (android|ios)"

// =============================================================================
// RFC 8599 Contact parameters
// =============================================================================

/** The pn-* parameters of one Contact URI. */
export interface PnParams {
  provider: string;
  prid: string;
  param: string;
}

/** urllib.parse.unquote: decode %XX runs as UTF-8 (bad bytes become U+FFFD), leave the rest. */
function unquote(value: string): string {
  if (!value.includes('%')) return value;
  return value.replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) =>
    Buffer.from(run.split('%').slice(1).map((h) => parseInt(h, 16))).toString('utf8'),
  );
}

/**
 * The pn-provider / pn-prid / pn-param of a Contact URI, or null when it has no pn-provider
 * and pn-prid. Parameter names are case-insensitive, values percent-decoded.
 */
export function parsePnParams(uri: string | null | undefined): PnParams | null {
  if (!uri) return null;
  let body = uri.trim();
  if (body.startsWith('<')) body = body.includes('>') ? body.slice(1, body.indexOf('>')) : body.slice(1);
  body = body.split('?')[0];
  const params: Record<string, string> = {};
  for (const part of body.split(';').slice(1)) {
    const eq = part.indexOf('=');
    const name = (eq === -1 ? part : part.slice(0, eq)).trim().toLowerCase();
    const value = eq === -1 ? '' : part.slice(eq + 1);
    if (name.startsWith('pn-')) params[name] = unquote(value.trim());
  }
  const provider = (params['pn-provider'] ?? '').toLowerCase();
  const prid = params['pn-prid'] ?? '';
  if (!provider || !prid) return null;
  return { provider, prid, param: params['pn-param'] ?? '' };
}

// =============================================================================
// AMI client (actions keyed by ActionID + 'system' events)
// =============================================================================

/** One AMI message: `Output:` lines collected into a list, any other repeated key keeps its first value. */
export type AmiMessage = Record<string, string | string[]>;

export interface AmiActionResult {
  response: AmiMessage | null;
  events: AmiMessage[];
}

interface PendingAction extends AmiActionResult {
  resolve: (v: AmiActionResult | null) => void;
  done: boolean;
}

/** Parse one AMI message block. */
export function parseAmiMessage(raw: string): AmiMessage {
  const msg: AmiMessage = {};
  const output: string[] = [];
  for (const line of raw.split('\r\n')) {
    const sep = line.indexOf(':');
    if (sep === -1) continue;
    const key = line.slice(0, sep).trim();
    const value = line.slice(sep + 1).trim();
    if (key === 'Output') output.push(value);
    else if (!(key in msg)) msg[key] = value;
  }
  if (output.length) msg.Output = output;
  return msg;
}

/**
 * Minimal AMI client: one reader routes replies to the action that asked by ActionID, and
 * hands ContactStatus events to `onEvent`. Reconnects on its own (2 s, doubling to 60 s).
 */
export class AMIClient {
  host = env('AMI_HOST', '127.0.0.1');
  port = pyInt(env('AMI_PORT', '5038')) ?? 5038;
  username = env('AMI_USERNAME', '');
  secret = env('AMI_SECRET', '');
  connected = false;
  private socket: net.Socket | null = null;
  private pending = new Map<string, PendingAction>();
  private ids = 1;
  private stopped = true;
  private loop: Promise<void> | null = null;
  private wakeLoop: (() => void) | null = null;
  private connectedWaiters: (() => void)[] = [];

  constructor(private readonly onEvent: (ev: AmiMessage) => void) {}

  start(): void {
    if (this.loop) return;
    this.stopped = false;
    this.loop = this.run().finally(() => {
      this.loop = null;
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.wakeLoop) this.wakeLoop();
    this.close();
    if (this.loop) await this.loop;
  }

  private close(): void {
    this.connected = false;
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
    for (const p of this.pending.values()) {
      if (!p.done) {
        p.done = true;
        p.resolve(null);
      }
    }
    this.pending.clear();
  }

  /** Resolve once connected, or false after `timeout` seconds. */
  waitConnected(timeout: number): Promise<boolean> {
    if (this.connected) return Promise.resolve(true);
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        this.connectedWaiters = this.connectedWaiters.filter((w) => w !== done);
        resolve(false);
      }, timeout * 1000);
      this.connectedWaiters.push(done);
    });
  }

  private nextId(): string {
    return `opdesk-pn-${this.ids++}`;
  }

  /** One connection's lifetime: resolves when the socket closes for any reason. */
  private session(): Promise<void> {
    return new Promise((resolve) => {
      const sock = net.createConnection({ host: this.host, port: this.port });
      this.socket = sock;
      sock.setNoDelay(true);
      let buf = '';
      let bannerSeen = false;
      const loginId = this.nextId();
      let loggedIn = false;
      sock.on('connect', () => {
        sock.write(
          `Action: Login\r\nUsername: ${this.username}\r\nSecret: ${this.secret}\r\n` +
            `Events: system\r\nActionID: ${loginId}\r\n\r\n`,
        );
      });
      sock.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        if (!bannerSeen) {
          const nl = buf.indexOf('\r\n');
          if (nl === -1) return;
          buf = buf.slice(nl + 2); // banner
          bannerSeen = true;
        }
        let end: number;
        while ((end = buf.indexOf('\r\n\r\n')) !== -1) {
          const msg = parseAmiMessage(buf.slice(0, end));
          buf = buf.slice(end + 4);
          if (!loggedIn) {
            if (msg.ActionID !== loginId) continue;
            if (msg.Response !== 'Success') {
              log.warning('RFC 8599 AMI login failed: %s', msg.Message ?? '');
              sock.destroy();
              return;
            }
            loggedIn = true;
            this.connected = true;
            const waiters = this.connectedWaiters;
            this.connectedWaiters = [];
            for (const w of waiters) w();
            log.info('RFC 8599 push gateway connected to AMI');
            continue;
          }
          this.route(msg);
        }
      });
      sock.on('error', (e) => {
        if (this.connected) log.warning('RFC 8599 AMI connection lost: %s', e.message);
      });
      sock.on('close', () => resolve());
    });
  }

  private async run(): Promise<void> {
    let delay = 2;
    while (!this.stopped) {
      const wasConnected = await this.session().then(() => this.connected);
      this.close();
      if (wasConnected) delay = 2;
      if (this.stopped) break;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, delay * 1000);
        this.wakeLoop = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      this.wakeLoop = null;
      delay = Math.min(delay * 2, 60);
    }
  }

  private route(msg: AmiMessage): void {
    const pending = this.pending.get(String(msg.ActionID ?? ''));
    if (pending === undefined) {
      if (msg.Event === 'ContactStatus') {
        try {
          this.onEvent(msg);
        } catch (e) {
          log.debug('ContactStatus handler error: %s', e);
        }
      }
      return;
    }
    let done: boolean;
    if ('Response' in msg) {
      pending.response = msg;
      done = msg.Response !== 'Success' || String(msg.EventList ?? '').toLowerCase() !== 'start';
    } else {
      pending.events.push(msg);
      done = String(msg.EventList ?? '').toLowerCase() === 'complete';
    }
    if (done && !pending.done) {
      pending.done = true;
      pending.resolve({ response: pending.response, events: pending.events });
    }
  }

  /**
   * Run one action; resolves {response, events}, or null when AMI is unreachable or the
   * reply is late.
   */
  async action(name: string, params: Record<string, string> = {}, timeout = 3.0): Promise<AmiActionResult | null> {
    if (!this.connected || !this.socket) return null;
    if (!amiActionAllowed(name, params)) {
      refused(`AMI action ${name}`);
      return null;
    }
    const actionId = this.nextId();
    const lines = [`Action: ${name}`, `ActionID: ${actionId}`, ...Object.entries(params).map(([k, v]) => `${k}: ${v}`)];
    try {
      return await new Promise<AmiActionResult | null>((resolve) => {
        const timer = setTimeout(() => {
          const p = this.pending.get(actionId);
          if (p && !p.done) {
            p.done = true;
            resolve(null);
          }
        }, timeout * 1000);
        this.pending.set(actionId, {
          response: null,
          events: [],
          done: false,
          resolve: (v) => {
            clearTimeout(timer);
            resolve(v);
          },
        });
        this.socket!.write(lines.join('\r\n') + '\r\n\r\n');
      });
    } catch {
      return null;
    } finally {
      this.pending.delete(actionId);
    }
  }
}

// =============================================================================
// Gateway state
// =============================================================================

/** A wake in progress, keyed by the dialplan's UNIQUEID. */
export interface PendingWake {
  extension: string;
  started: number;
  /** contact id -> expiration at push time */
  baseline: Map<string, number>;
  /** false when AMI could not list the contacts at push time */
  baselineKnown: boolean;
  bindings: Row[];
  /** legacy-only wake (no RFC 8599 binding): any (re-)registration counts */
  anyContact: boolean;
}

/** One registered contact of an endpoint. */
export interface EndpointContact {
  id: string;
  uri: string;
  user_agent: string;
  expires: number;
}

let ami: AMIClient | null = null;
let syncLoopTask: { cancelled: boolean; wake: (() => void) | null } | null = null;
let bindings = new Map<string, Row[]>(); // extension -> bindings (cache of the DB table)
export const pending = new Map<string, PendingWake>(); // dialplan UNIQUEID -> wake in progress
export const registeredAt = new Map<string, number>(); // extension -> time a mobile contact was last Created
const settings = { marker: DEFAULT_MARKER, enabled: false };

/** Apply the Mobile Wake settings that matter at run time (the dialplan holds the rest). */
export function configure(opts: { marker?: string | null; enabled?: boolean | null } = {}): void {
  if (opts.marker !== null && opts.marker !== undefined) settings.marker = opts.marker.trim();
  if (opts.enabled !== null && opts.enabled !== undefined) settings.enabled = Boolean(opts.enabled);
}

export function isEnabled(): boolean {
  return settings.enabled;
}

export function isMobile(uri: string, userAgent: string): boolean {
  const marker = settings.marker.toLowerCase();
  return Boolean(parsePnParams(uri)) || Boolean(marker && (userAgent || '').toLowerCase().includes(marker));
}

/** The host phones use for this PBX: OPDESK_DOMAIN, else the WebRTC server's host. */
export async function publicHost(): Promise<string> {
  const domain = env('OPDESK_DOMAIN', '').trim();
  if (domain) return domain;
  try {
    const raw = (await dbm.getSetting('WEBRTC_PBX_SERVER', '')) || '';
    return raw ? new URL(raw).hostname.replace(/^\[|\]$/g, '').toLowerCase() : '';
  } catch {
    return '';
  }
}

/** Load the stored bindings, connect to AMI and start the periodic contact sync. */
export async function start(enabled: boolean, marker: string): Promise<void> {
  configure({ marker, enabled });
  await reloadBindings();
  ami = new AMIClient(onContactStatus);
  ami.start();
  const task = { cancelled: false, wake: null as (() => void) | null };
  syncLoopTask = task;
  createTask(syncLoop(task));
}

export async function stop(): Promise<void> {
  if (syncLoopTask) {
    syncLoopTask.cancelled = true;
    if (syncLoopTask.wake) syncLoopTask.wake();
    syncLoopTask = null;
  }
  if (ami) await ami.stop();
  ami = null;
}

/** Refill the cache from the table. A new map is built and swapped in, never half-filled. */
export async function reloadBindings(): Promise<void> {
  const fresh = new Map<string, Row[]>();
  for (const row of await dbm.listSipPushBindings()) {
    const ext = String(row.extension);
    const list = fresh.get(ext);
    if (list) list.push(row);
    else fresh.set(ext, [row]);
  }
  bindings = fresh;
}

/** Store a binding seen in a Contact. */
async function remember(extension: string, pn: PnParams, uri: string, userAgent = ''): Promise<void> {
  await dbm.upsertSipPushBinding(extension, pn.provider, pn.prid, pn.param, uri, userAgent || null);
  await reloadBindings();
}

/** A ContactStatus event: a Created mobile contact marks the extension ready; a pn-* URI is learned. */
export function onContactStatus(ev: AmiMessage): void {
  const status = String(ev.ContactStatus ?? '');
  const uri = String(ev.URI ?? '');
  const extension = String(ev.AOR || ev.EndpointName || '');
  if ((status !== 'Created' && status !== 'Reachable') || !extension) return;
  const pn = parsePnParams(uri);
  if (status === 'Created' && isMobile(uri, '')) registeredAt.set(extension, monotonic());
  if (pn) createTask(remember(extension, pn, uri, ''), (e) => log.debug('push binding store failed: %s', e));
}

async function syncLoop(task: { cancelled: boolean; wake: (() => void) | null }): Promise<void> {
  while (!task.cancelled) {
    try {
      if (ami && (await ami.waitConnected(10))) await syncContacts();
    } catch (e) {
      log.debug('RFC 8599 contact sync error: %s', e);
    }
    if (task.cancelled) break;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, SYNC_INTERVAL * 1000);
      task.wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
    task.wake = null;
  }
}

/** Learn the bindings of every currently registered contact. Returns how many it saw. */
export async function syncContacts(): Promise<number> {
  if (!ami) return 0;
  const res = await ami.action('PJSIPShowContacts', {}, 10);
  let seen = 0;
  for (const ev of res?.events ?? []) {
    if (ev.Event !== 'ContactList') continue;
    const uri = String(ev.Uri ?? '');
    const pn = parsePnParams(uri);
    const extension = String(ev.Aor || ev.Endpoint || '');
    if (pn && extension) {
      await remember(extension, pn, uri, String(ev.UserAgent ?? ''));
      seen += 1;
    }
  }
  return seen;
}

/**
 * The extension's registered contacts; null when AMI could not answer (as opposed to []
 * for no contacts).
 */
export async function endpointContacts(extension: string): Promise<EndpointContact[] | null> {
  if (!ami) return null;
  const res = await ami.action('PJSIPShowEndpoint', { Endpoint: extension }, 2.5);
  if (res === null) return null;
  const contacts: EndpointContact[] = [];
  for (const ev of res.events) {
    if (ev.Event !== 'ContactStatusDetail') continue;
    contacts.push({
      id: String(ev.ID || ev.URI || ''),
      uri: String(ev.URI ?? ''),
      user_agent: String(ev.UserAgent ?? ''),
      expires: pyInt(ev.RegExpire || 0) ?? 0,
    });
  }
  return contacts;
}

function expirePending(): void {
  const now = monotonic();
  for (const [uid, p] of [...pending.entries()]) if (now - p.started > PENDING_TTL) pending.delete(uid);
}

export function hasBindings(extension: string): boolean {
  return (bindings.get(extension) ?? []).length > 0;
}

export function bindingsFor(extension: string): Row[] {
  return [...(bindings.get(extension) ?? [])];
}

/** The "call" push payload. */
export function callData(extension: string, caller: string, callerName: string, host: string): Record<string, string> {
  return {
    type: 'call',
    caller_uri: caller && host ? `sip:${caller}@${host}` : caller,
    caller_name: callerName || caller,
    aor: host ? `sip:${extension}@${host}` : extension,
  };
}

/**
 * Pre-dial wake. True means a push went out and the dialplan should hold the call and poll
 * ready(); false (no binding, or no provider configured for it) lets the call ring at once.
 * Legacy app-registered tokens (POST /api/device-tokens) are woken too, through
 * push-service sendCallWake.
 */
export async function wake(extension: string, uid: string, caller: string, callerName: string, holdSeconds: number): Promise<boolean> {
  expirePending();
  const rows = bindingsFor(extension);
  const legacy = (await dbm.getDeviceTokensForExtension(extension)) as pushService.DeviceTokenRow[];
  if (!pushService.canWake(rows, legacy)) return false;

  const contacts = await endpointContacts(extension);
  pending.set(uid || `${extension}-${monotonic()}`, {
    extension,
    started: monotonic(),
    baseline: new Map((contacts ?? []).map((c) => [c.id, c.expires])),
    baselineKnown: contacts !== null,
    bindings: rows,
    anyContact: rows.length === 0, // legacy-only: any (re-)registration counts
  });

  const host = await publicHost();
  if (rows.length) {
    createTask(pushService.sendRfc8599(rows, callData(extension, caller, callerName, host), holdSeconds, uid || null));
  }
  if (legacy.length) {
    createTask(pushService.sendCallWake(extension, caller, `predial-${extension}`, callerName || null));
  }
  return true;
}

/**
 * Has a mobile contact registered since the wake's push? Unknown uid: true, so a call is
 * never held for a wake OpDesk no longer knows about.
 */
export async function ready(uid: string): Promise<boolean> {
  const p = pending.get(uid);
  if (p === undefined) return true;
  const extension = p.extension;
  if ((registeredAt.get(extension) ?? 0) > p.started) return true;
  const contacts = await endpointContacts(extension);
  for (const c of contacts ?? []) {
    if (!(p.anyContact || isMobile(c.uri, c.user_agent))) continue;
    const before = p.baseline.get(c.id);
    if (!p.baselineKnown || before === undefined || c.expires > before) {
      const pn = parsePnParams(c.uri);
      if (pn) createTask(remember(extension, pn, c.uri, c.user_agent), (e) => log.debug('push binding store failed: %s', e));
      return true;
    }
  }
  return false;
}

/** The call was released to the dialplan: nothing to cancel. */
export function done(uid: string): void {
  pending.delete(uid);
}

/** The caller hung up during the hold, or the hold ran out: stop the phone ringing. */
export async function cancel(uid: string): Promise<void> {
  const p = pending.get(uid);
  pending.delete(uid);
  if (!p || !p.bindings.length) return;
  const host = await publicHost();
  await pushService.sendRfc8599(p.bindings, {
    type: 'cancel',
    aor: host ? `sip:${p.extension}@${host}` : p.extension,
  });
}

/**
 * DialBegin fallback for a call that did not pass the pre-dial hook (an inbound route
 * straight to the extension): push so a backgrounded app answers the INVITE that is
 * already on its way.
 */
export async function ring(extension: string, caller: string, callerName: string): Promise<void> {
  const rows = bindingsFor(extension);
  if (!rows.length || !isEnabled()) return;
  const host = await publicHost();
  await pushService.sendRfc8599(rows, callData(extension, caller, callerName, host), 20);
}

// =============================================================================
// Call-time hooks for the AMI monitor (server.py lifespan callbacks)
// =============================================================================

// runtime.preWoken: extensions that received a predial VoIP wake push, keyed by
// extension -> monotonic(). onIncomingCall suppresses the second VoIP push while the entry
// is fresh, so the mobile app only ever gets one VoIP push (and therefore one
// CallKit/ConnectionService call UUID) per incoming call.
export const PRE_WAKE_TTL = 12; // seconds — covers Wait(3) + dial setup + clock slop

/** Record that the pre-dial hook pushed this extension (the internal mobile-wake route). */
export function markPreWoken(extension: string): void {
  runtime.preWoken.set(extension, monotonic());
}

/**
 * The monitor's incoming-call callback (ring time): warm the contact-name cache, then —
 * unless the pre-dial hook already pushed this extension within PRE_WAKE_TTL — send the app
 * wake push and the RFC 8599 ring push. Two VoIP pushes would mean two CallKit UUIDs, the
 * end-call event landing on the wrong one, no SIP BYE, and a stuck caller.
 */
export function onIncomingCall(extension: string, caller: string, callId: string, displayName: string): void {
  try {
    // Warm the CRM contact cache at first ring so the name is usually resolved by the
    // time the softphone asks for it. Runs before the pre-wake dedup below — that guard is
    // about VoIP pushes only.
    runtime.contactResolver?.resolveCached(caller, monitoredExtensions());
  } catch (e) {
    log.debug('contact warm-up failed: %s', e);
  }
  const wakeTime = runtime.preWoken.get(extension);
  runtime.preWoken.delete(extension);
  if (wakeTime !== undefined && monotonic() - wakeTime < PRE_WAKE_TTL) return;
  createTask(pushService.sendCallWake(extension, caller, callId, displayName || null));
  // RFC 8599 bindings: this call skipped the pre-dial hook (or the hook is off), so push
  // now and let the app answer the INVITE already on its way.
  createTask(ring(extension, caller, displayName));
}

/**
 * The missed-call banner (the monitor's call-notification callback, after the WS broadcast):
 * built from the extension's latest notification row and sent as an alert push. Never throws.
 */
export async function dispatchMissedCallPush(extension: string): Promise<void> {
  try {
    const rows = await dbm.getCallNotificationsFromDb({ extension, statusFlag: null, limit: 1 });
    const row: Row = rows && rows.length ? rows[0] : {};
    const caller = row.caller_from || 'Unknown';
    let body = `Missed call from ${caller}`;
    if (row.queue) body += ` (queue ${row.queue})`;
    await pushService.sendAlert(extension, 'Missed call', body, {
      type: 'call_notification_new',
      extension,
      caller_from: row.caller_from || '',
      queue: row.queue || '',
      reason: row.reason || '',
      call_id: row.call_id || '',
    });
  } catch (e) {
    log.debug('missed-call push dispatch error: %s', e);
  }
}
