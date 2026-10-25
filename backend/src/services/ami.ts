/**
 * Asterisk AMI Extensions Monitor
 *
 * Real-time extension monitoring, call tracking, queue management, and supervisor
 * features (listen/whisper/barge, transfer, hangup, click-to-call) via the Asterisk
 * Manager Interface.
 *
 * Port of backend/ami.py. The wire protocol lives in ./ami-protocol (one reader,
 * ActionID-correlated replies, list actions collected by ActionID), so this file is the
 * call/queue state machine: the `ev*` handlers keep the Python `_ev_*` logic, the state
 * dicts keep their Python names (camelCased) and their inner dicts keep the Python keys,
 * because /api/calls, /api/queues and the WebSocket state expose them as-is.
 *
 * Deliberate changes from the Python (see the port report for the full list):
 *   * Call outcomes use the shared 10-value vocabulary (services/call-outcomes,
 *     mapCallOutcome with the `outbound` signal); the missed-call bell stores that same
 *     canonical status as `reason` and now also notifies MISSED (cause 16: the caller gave
 *     up while it rang), but never notifies whoever PLACED an unanswered call.
 *   * Queue pause reasons survive device-state changes, are read from `PausedReason`
 *     (Asterisk 13+) with a fallback to the legacy `Reason`, are hydrated from QueueStatus
 *     at startup and are cleared on unpause. `QueueMemberPause` (the Asterisk 12+ name of
 *     `QueueMemberPaused`) is handled at all.
 *   * Member interfaces are matched by extension in every form (PJSIP/x, SIP/x,
 *     Local/x@from-queue/n, Local/x@from-internal); new members are added as <tech>/<ext>
 *     where <tech> is the device's real channel driver (PJSIP or chan_sip on Issabel).
 *   * AstDB reads accept both CLI reply shapes (raw text and `Output:` headers).
 *   * An unexpected AMI disconnect reconnects with backoff and resyncs.
 */

import { env } from '../core/config';
import { getLogger, pyStr } from '../core/logger';
import { createTask, isoformat, monotonic, pyInt, sleep } from '../core/py';
import * as dbm from '../db/db-manager';
import { query } from '../db/pool';
import { CRMConnector, CRMSyncConfig, buildCrmPayload, crmUnavailableReason } from '../integrations/crm';
import type { CrmDeliveryMeta } from '../integrations/crm';
import { parkForWrapup, sendCrmDataAsync as deliverCrmPush } from '../integrations/crm-delivery';
import { crmIdentityFromCdr, mapCallOutcome } from './call-log';
import * as vadRunner from './vad-runner';
import {
  AMI_LIST_TIMEOUT,
  AMI_TIMEOUT,
  AmiClient,
  commandOutputLines,
  parse,
  type AmiMessage,
} from './ami-protocol';

export { parse, type AmiMessage } from './ami-protocol';

const log = getLogger('services.ami');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
/** One active_calls entry. Open bag: the Python dict grew keys from many events. */
export type CallInfo = Record<string, any>;

/** Which way a call in progress runs, as the Active Calls badge and the Dashboard split read it. */
export type LiveRoute = 'inbound_queue' | 'inbound_direct' | 'internal' | 'outbound';

export interface QueueMemberSummary {
  status: string;
  paused: boolean;
  membername: string;
  dynamic: boolean;
}

export interface QueueInfo {
  members: Record<string, QueueMemberSummary>;
  calls_waiting: number;
  available?: number;
  logged_in?: number;
  hold_time?: string;
  talk_time?: string;
}

export interface QueueMember {
  queue: string;
  interface: string;
  membername: string;
  status: string;
  paused: boolean;
  dynamic: boolean;
  last_update: Date;
  /** Present only while paused with a known reason (Not-Ready code or __WRAPUP). */
  pause_reason?: string;
}

export interface QueueEntry {
  queue: string;
  callerid: string;
  position: number;
  entry_time: Date;
}

interface VadPending {
  base: string;
  /** monotonic() of the DialEnd ANSWER, or null while not answered. */
  answer: number | null;
  /** A terminal non-answer DialStatus was seen. */
  nonanswer: boolean;
}

export type EventCallback = (p: AmiMessage) => unknown;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
export { AMI_RESPONSE_END, AMI_TIMEOUT } from './ami-protocol';
export const EVENT_TIMEOUT = 1.0;
export const AMI_RECONNECT_MIN_DELAY = 3.0; // seconds, first backoff after an unexpected disconnect
export const AMI_RECONNECT_MAX_DELAY = 30.0; // seconds, backoff ceiling
export const QUEUE_RECONCILE_INTERVAL = 10.0; // seconds between waiting-caller reconciles

export const DIALPLAN_CTX: ReadonlySet<string> = new Set([
  's', 'h', 'i', 't', 'o', 'a', 'e', 'start', 'hangup', 'invalid', 'timeout',
]);
export const DIALED_VARS: ReadonlySet<string> = new Set([
  'EXTEN', 'DIALEDPEERNUMBER', 'DIALEDNUMBER', 'OUTNUM', 'DIAL_NUMBER', 'CALLEDNUM', 'FROM_DID',
]);

export const STATUS_MAP: Readonly<Record<string, string>> = {
  '-1': 'Not Found', '0': 'Idle', '1': 'In Use', '2': 'Busy',
  '4': 'Unavailable', '8': 'Ringing', '9': 'In Use & Ringing',
  '16': 'On Hold', '32': 'On Hold',
};

// Queue member device status map (different from extension status!)
export const QUEUE_MEMBER_STATUS_MAP: Readonly<Record<string, string>> = {
  '0': 'Unknown',
  '1': 'Not in use', // Idle - should show GREEN
  '2': 'In use', // In use - should show BLUE
  '3': 'Busy',
  '4': 'Invalid',
  '5': 'Unavailable',
  '6': 'Ringing',
  '7': 'Ring+In use',
  '8': 'On Hold',
};

/**
 * Extension hint status code -> the queue-member status the same device would report.
 * A Local/<ext>@... member has no device state of its own (Asterisk reports it
 * 'Not in use' whatever the agent is doing), so its status is derived from the hint.
 */
export const EXT_STATUS_TO_MEMBER_STATUS: Readonly<Record<string, string>> = {
  '-1': 'Invalid', '0': 'Not in use', '1': 'In use', '2': 'Busy', '4': 'Unavailable',
  '8': 'Ringing', '9': 'Ring+In use', '16': 'On Hold', '32': 'On Hold',
};

/** Outcomes that put a call on the missed-call bell (see shouldNotifyMissedOrBusy). */
export const NOTIFY_OUTCOMES: ReadonlySet<string> = new Set([
  'BUSY', 'UNANSWERED', 'MISSED', 'UNREACHABLE', 'FAILURE', 'NETWORK_ERROR',
]);

/** Hangup causes that mean nobody answered: a ring-only recording can be deleted. */
const NOANSWER_CAUSES: ReadonlySet<string> = new Set(['17', '18', '19', '20', '21', '34', '38']);

/** Channel drivers a device may use; the first is the default when nothing else is known. */
export const DEVICE_TECHS = ['PJSIP', 'SIP', 'IAX2', 'DAHDI'] as const;
export const DEFAULT_TECH = 'PJSIP';

const WATCHED_EVENTS: ReadonlySet<string> = new Set([
  'ExtensionStatus', 'PeerStatus', 'ContactStatus', 'DeviceStateChange',
  'Newchannel', 'Hangup', 'Dial', 'DialBegin', 'DialEnd',
  'Bridge', 'NewCallerid', 'NewConnectedLine', 'Newstate', 'VarSet',
  'QueueMemberStatus', 'QueueMemberAdded', 'QueueMemberRemoved',
  'QueueEntry', 'QueueCallerJoin', 'QueueCallerLeave',
  'QueueMemberPause', 'QueueMemberPaused', 'QueueMemberUnpause',
  'QueueMemberRingInUse', 'QueueSummary',
  'AgentCalled', 'AgentConnect', 'AgentComplete',
  'UserEvent',
]);

const RE_EXT_FROM_CHANNEL = /\/(\d+)-/;
const RE_CHANNEL_TYPE = /\/([^-]+)-/;
const RE_DEVICE_CHANNEL = /^(PJSIP|SIP|IAX2|DAHDI)\/(\d+)-/i;
// Numbers accepted for origination. `*`/`#` allow feature codes. Must stay a full match:
// it is what keeps a caller-supplied string from carrying anything but a dial string.
const ORIGINATE_NUMBER_RE = /^\+?[0-9*#]{2,20}$/;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
/** Python str.isdigit() for the ASCII numbers the PBX uses. */
export function isdigit(s: unknown): boolean {
  return typeof s === 'string' && /^[0-9]+$/.test(s);
}

/** A 3-5 digit internal extension number. */
function isExtNumber(v: unknown): v is string {
  return isdigit(v) && (v as string).length >= 3 && (v as string).length <= 5;
}

/** Convert a queue member device status code to the human-readable string. */
export function queueMemberStatus(code: unknown): string {
  const k = pyStr(code);
  return Object.prototype.hasOwnProperty.call(QUEUE_MEMBER_STATUS_MAP, k)
    ? QUEUE_MEMBER_STATUS_MAP[k]
    : `Unknown (${k})`;
}

/** Return true if *value* looks like a real phone/extension number or feature code. */
export function meaningful(value: unknown): boolean {
  if (!value) return false;
  let v = pyStr(value).trim();
  // Accept feature codes like *43, *72, etc.
  if (v.startsWith('*') && v.length >= 2 && isdigit(v.slice(1))) return true;
  // A leading '+' belongs to a real E.164 number.
  if (v.startsWith('+')) v = v.slice(1);
  // Must be all digits for regular numbers
  if (!isdigit(v)) return false;
  if (DIALPLAN_CTX.has(v.toLowerCase()) || v.length <= 2) return false;
  return true;
}

/** Extract extension from channel like PJSIP/110-0000001a -> '110'. */
export function extFromChannel(channel: string | null | undefined): string | null {
  if (!channel) return null;
  const m = RE_EXT_FROM_CHANNEL.exec(channel);
  return m ? m[1] : null;
}

/** Format a duration (seconds) to HH:MM:SS, or MM:SS when under an hour. */
export function formatDuration(durationSeconds: number): string {
  const total = Math.max(0, Math.trunc(durationSeconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const p2 = (n: number) => String(n).padStart(2, '0');
  return hours > 0 ? `${p2(hours)}:${p2(minutes)}:${p2(seconds)}` : `${p2(minutes)}:${p2(seconds)}`;
}

function secondsSince(since: Date | string | null | undefined): number {
  const d = toDate(since);
  return d ? (Date.now() - d.getTime()) / 1000 : 0;
}

function toDate(v: unknown): Date | null {
  if (v instanceof Date) return v;
  if (typeof v === 'string' && v) {
    const d = new Date(v.replace('Z', '+00:00'));
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

function hms(d: Date): string {
  const p2 = (n: number) => String(n).padStart(2, '0');
  return `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
}

/** dict.get(key, default): a present key wins even when its value is empty. */
function dget<T = any>(o: Record<string, any> | null | undefined, key: string, fallback: T): any {
  return o && Object.prototype.hasOwnProperty.call(o, key) ? o[key] : fallback;
}

/** Python truthiness of a dict. */
function truthyObj(o: object | null | undefined): boolean {
  return !!o && Object.keys(o).length > 0;
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : pyStr(e);
}

/**
 * Bare extension behind a queue member interface or device, for every form OpDesk may see:
 *     'PJSIP/1001' / 'SIP/1001' / 'IAX2/1001'   -> '1001'
 *     'Local/1001@from-queue/n'                 -> '1001'
 *     'Local/1001@from-internal'                -> '1001'
 *     'PJSIP/1001-0000001a' (a channel)          -> '1001'
 *     '1001'                                    -> '1001'
 */
export function extFromInterface(iface: string | null | undefined): string {
  if (!iface) return '';
  const slash = iface.indexOf('/');
  let tail = slash !== -1 ? iface.slice(slash + 1) : iface;
  const at = tail.indexOf('@');
  if (at !== -1) tail = tail.slice(0, at);
  const s2 = tail.indexOf('/');
  if (s2 !== -1) tail = tail.slice(0, s2);
  // A channel name (PJSIP/1001-0000001a) carries a unique suffix after the last dash.
  const m = /^(\d+)-[0-9a-f]+$/i.exec(tail.trim());
  return (m ? m[1] : tail).trim();
}

/** True when `iface` is one of the forms an agent's own extension can take in a queue. */
export function interfaceMatchesExtension(iface: string | null | undefined, ext: string): boolean {
  return !!ext && extFromInterface(iface) === String(ext).trim();
}

/**
 * Normalize a queue member interface. A bare extension gets a technology prefix
 * (`tech`, default PJSIP — the caller passes the device's real driver, e.g. SIP for a
 * chan_sip extension on Issabel); anything that already carries one is passed through
 * untouched, so an existing PJSIP/<ext>, SIP/<ext> or Local/... member can still be
 * removed, paused and displayed by its real interface.
 *
 * Deliberately NOT the Local/<ext>@from-queue/n form: that context does not exist on
 * every PBX (it is missing on the FreePBX box this was developed on), and a member that
 * does not route never rings.
 *
 *     '100'        -> 'PJSIP/100'
 *     '100', 'SIP' -> 'SIP/100'
 *     'PJSIP/100'  -> 'PJSIP/100'
 *     'SIP/100'    -> 'SIP/100'
 */
export function normalizeInterface(iface: string, tech?: string | null): string;
export function normalizeInterface(iface: string | null | undefined, tech?: string | null): string | null | undefined;
export function normalizeInterface(iface: string | null | undefined, tech: string | null = null): string | null | undefined {
  if (!iface) return iface;
  const s = iface.trim();
  if (s.includes('/')) return s;
  return `${tech || DEFAULT_TECH}/${s}`;
}

/** The same phone number, allowing for a national leading zero written on one side only. */
export function sameNumber(a: string, b: string): boolean {
  return a === b || (!!a && !!b && a.replace(/^0+/, '') === b.replace(/^0+/, ''));
}

/** Strip formatting from a dialable number and validate it. null if unusable. */
export function normalizeDialNumber(raw: unknown): string | null {
  const s = pyStr(raw ?? '').replace(/[\s\-().]/g, '');
  if (!s) return null;
  return ORIGINATE_NUMBER_RE.test(s) ? s : null;
}

// ---------------------------------------------------------------------------
// Core monitor
// ---------------------------------------------------------------------------
export interface AMIExtensionsMonitorOptions {
  host?: string;
  port?: number;
  username?: string;
  secret?: string;
  context?: string;
  crmConnector?: CRMConnector | null;
  crmSyncConfig?: CRMSyncConfig | null;
}

/** Real-time Asterisk extension monitor with ChanSpy supervisor features. */
export class AMIExtensionsMonitor {
  host: string;
  port: number;
  username: string;
  secret: string;
  context: string;

  // Optional CRM connector + call-data sync (push) config.
  crmConnector: CRMConnector | null;
  crmSyncConfig: CRMSyncConfig | null;

  client: AmiClient | null = null;
  connected = false;
  /** True while live events are processed (set once the startup sync is done). */
  running = false;
  private reconnecting = false;
  private stopRequested = false;
  private dispatchChain: Promise<void> = Promise.resolve();
  private queueReconcileTimer: NodeJS.Timeout | null = null;

  // Live state
  extensions: Map<string, AmiMessage> = new Map(); // ext -> last ExtensionStatus response
  activeCalls: Map<string, CallInfo> = new Map(); // ext -> call-info dict
  ch2ext: Map<string, string> = new Map(); // channel -> ext
  chCallerid: Map<string, string> = new Map(); // channel -> callerid
  destch2ext: Map<string, string> = new Map(); // dest channel -> caller ext (for tracking ringing)
  monitored: Set<string> = new Set();
  dnd: Set<string> = new Set(); // extensions with Do-Not-Disturb enabled (AstDB DND family)
  /** ext -> channel driver (PJSIP / SIP / ...), learned from channels, members and the PBX DB. */
  techByExt: Map<string, string> = new Map();
  eventCallbacks: EventCallback[] = [];
  rawEventSink: ((p: AmiMessage) => unknown) | null = null; // System Logs: every AMI event

  // Queue state
  queues: Map<string, QueueInfo> = new Map(); // queue -> {members, calls_waiting, ...}
  queueMembers: Map<string, QueueMember> = new Map(); // "queue:interface" -> member info
  queueEntries: Map<string, QueueEntry> = new Map(); // uniqueid -> waiting caller
  dynamicMembers: Set<string> = new Set(); // members added dynamically (removable via AMI)
  ch2uniqueid: Map<string, string> = new Map(); // channel -> uniqueid (queue entry cleanup)
  ch2linkedid: Map<string, string> = new Map(); // channel -> linkedid
  linkedid2channels: Map<string, Set<string>> = new Map(); // linkedid -> live channels (final-hangup detection)
  linkedidCrmSent: Set<string> = new Set(); // "linkedid:uniqueid" already pushed (dedupe)
  answeredCh: Map<string, string> = new Map(); // device channel that reached Up -> ext
  // Linkedid -> (ext -> entry) of calls whose extension started a new call before the old
  // call's final hangup arrived: kept for that hangup's Linkedid sweep (see parkEndedCall).
  endedCalls: Map<string, Map<string, CallInfo>> = new Map();
  callNotificationCallback: ((ext: string) => unknown) | null = null;
  incomingCallCallback: ((ext: string, caller: string, callId: string, displayName: string) => unknown) | null = null;
  callOutcomeCallback: ((ext: string, callStatus: string, linkedid: string) => unknown) | null = null;
  vadPending: Map<string, VadPending> = new Map(); // uniqueid -> recording, set by OpDeskRecording UserEvent
  vadPendingCh: Map<string, string> = new Map(); // channel -> uniqueid (Hangup without Uniqueid)

  constructor(opts: AMIExtensionsMonitorOptions = {}) {
    this.host = opts.host || env('AMI_HOST', '127.0.0.1');
    this.port = opts.port || pyInt(env('AMI_PORT', '5038')) || 5038;
    this.username = opts.username || env('AMI_USERNAME', '');
    this.secret = opts.secret || env('AMI_SECRET', '');
    this.context = opts.context || env('AMI_CONTEXT', 'ext-local');
    this.crmConnector = opts.crmConnector ?? null;
    this.crmSyncConfig = opts.crmSyncConfig ?? (CRMSyncConfig ? new CRMSyncConfig() : null);
  }

  // ------------------------------------------------------------------
  // Connection
  // ------------------------------------------------------------------
  /** Connect and authenticate. Does an initial queue sync, like the Python. */
  async connect(): Promise<boolean> {
    if (this.client) await this.client.close().catch(() => undefined);
    const client = new AmiClient({
      onEvent: (raw) => this.onWireEvent(raw),
      onClose: () => this.onConnectionLost(client),
      actionIdPrefix: 'opdesk',
    });
    this.client = client;
    try {
      await client.connect(this.host, this.port, AMI_TIMEOUT);
      const { ok, reply } = await client.login(this.username, this.secret);
      if (ok) {
        this.connected = true;
        log.info('Connected & authenticated to AMI at %s:%d', this.host, this.port);
        try {
          await this.syncQueueStatus();
        } catch (e) {
          log.warning('Failed to sync initial queue status: %s', errText(e));
        }
        return true;
      }
      log.error('Auth failed: %s', reply.replace(/\r\n/g, ' | '));
      await client.close();
    } catch (e) {
      log.error('Connection error: %s', errText(e));
    }
    this.connected = false;
    if (this.client === client) this.client = null;
    return false;
  }

  /** Disconnect (intentional: no reconnect afterwards). */
  async disconnect(): Promise<void> {
    this.running = false;
    this.stopRequested = true;
    this.stopQueueReconcile();
    const client = this.client;
    this.client = null;
    if (client && this.connected) {
      client.write('Logoff');
      await sleep(0.3);
    }
    this.connected = false;
    if (client) await client.close().catch(() => undefined);
  }

  /** Start processing live events (the Python `running = True` + reader task). */
  async startEvents(): Promise<void> {
    this.stopRequested = false;
    await this.sendAsync('Events', { EventMask: 'on' });
    this.running = true;
    this.ensureQueueReconcile();
  }

  private onConnectionLost(client: AmiClient): void {
    if (this.client !== client) return; // an old connection we already replaced
    const wasConnected = this.connected;
    this.connected = false;
    if (!wasConnected) return;
    log.warning('AMI connection closed');
    if (this.running && !this.stopRequested) void this.reconnectLoop();
  }

  /**
   * Best-effort auto-reconnect after an unexpected disconnect (Asterisk restart, network
   * blip, kicked manager session). Runs until connected again or disconnect() is called.
   */
  async reconnectLoop(): Promise<void> {
    if (this.reconnecting) return;
    this.reconnecting = true;
    let delay = AMI_RECONNECT_MIN_DELAY;
    try {
      while (this.running && !this.connected && !this.stopRequested) {
        log.warning('AMI disconnected — reconnecting in %ss', delay);
        await sleep(delay);
        if (!this.running || this.stopRequested) return;
        if (await this.connect()) {
          log.info('AMI reconnected');
          try {
            await this.syncExtensionStatuses();
            await this.syncActiveCalls();
            await this.syncDndState();
          } catch (e) {
            log.warning('Post-reconnect sync failed: %s', errText(e));
          }
          await this.sendAsync('Events', { EventMask: 'on' });
          return;
        }
        delay = Math.min(delay * 2, AMI_RECONNECT_MAX_DELAY);
      }
    } finally {
      this.reconnecting = false;
    }
  }

  // ------------------------------------------------------------------
  // Low-level I/O
  // ------------------------------------------------------------------
  /** Send an action and wait for its Response (raw text), or null. */
  async sendAsync(action: string, params: Record<string, unknown> | null = null, timeout = AMI_TIMEOUT): Promise<string | null> {
    const client = this.client;
    if (!this.connected || !client) return null;
    const resp = await client.send(action, params, timeout);
    if (resp === null) log.error('Send %s failed: no response', action);
    return resp;
  }

  /**
   * Send a list action (QueueSummary, QueueStatus, Status, CoreShowChannels, ...) and
   * return [response, ...events] parsed, or null when not connected / nothing came back.
   */
  async sendActionWithEvents(
    action: string,
    params: Record<string, unknown> | null = null,
    completeEvent: string | null = null,
    timeout = AMI_LIST_TIMEOUT,
  ): Promise<AmiMessage[] | null> {
    const client = this.client;
    if (!this.connected || !client) return null;
    const raw = await client.sendList(action, params, completeEvent, timeout);
    if (raw === null) {
      log.warning('%s: no reply', action);
      return null;
    }
    const msgs = raw.map((m) => parse(m));
    const complete = completeEvent || `${action}Complete`;
    if (!msgs.some((m) => m['Event'] === complete || /complete/i.test(m['EventList'] || ''))) {
      if (msgs.length && /Success/i.test(msgs[0]['Response'] || '')) log.warning('%s: Timeout waiting for %s', action, complete);
    }
    return msgs;
  }

  /** Every wire event goes through here, in arrival order. */
  private onWireEvent(raw: string): void {
    if (!this.running) {
      // Before the startup sync finished, the System Logs sink still sees the stream.
      this.feedRawSink(parse(raw));
      return;
    }
    this.dispatchChain = this.dispatchChain
      .then(() => this.dispatchAsync(raw))
      .catch((e) => log.error('Event dispatch error: %s', errText(e)));
  }

  private feedRawSink(p: AmiMessage): void {
    if (p['Event'] && this.rawEventSink) {
      try {
        this.rawEventSink(p);
      } catch (e) {
        log.debug('raw_event_sink error: %s', e);
      }
    }
  }

  // ------------------------------------------------------------------
  // Call-info helpers
  // ------------------------------------------------------------------
  /** Get or create the active_calls entry for *ext*. */
  callInfo(ext: string): CallInfo {
    let info = this.activeCalls.get(ext);
    if (info === undefined) {
      info = {};
      this.activeCalls.set(ext, info);
    }
    return info;
  }

  /**
   * This extension's own channel is gone, but sibling legs on the same Linkedid keep the call
   * alive, so the entry must survive for the final hangup's Linkedid sweep (it holds what the
   * outcome frame and the CRM push need). Flag it as ended so every display path treats the
   * extension as free again: a queue ring-all leg the ACD cancelled when another member
   * answered must not stay Ringing while the winner talks on.
   */
  markCallEnded(ext: string, info: CallInfo): void {
    if (info['ended']) return;
    // Another of the extension's own devices is still live (two registered contacts): point
    // the entry at it instead. The channel must name the extension: ch2ext also maps a trunk
    // leg to the number it dialled.
    for (const c of this.ch2ext.keys()) {
      if (c !== (info['channel'] ?? null) && extFromChannel(c) === ext) {
        info['channel'] = c;
        return;
      }
    }
    info['ended'] = true;
    info['state'] = 'Down';
    delete info['destchannel'];
    delete info['dest_state'];
    delete info['_wake_pushed'];
    log.debug('Call entry for %s marked ended (its channel is gone, sibling legs still up)', ext);
  }

  /**
   * Move an ended entry out of active_calls but keep it reachable for its own call's final
   * hangup, so a new call on the same extension starts from a clean entry. False when it has
   * no Linkedid to be swept by (it then stays where it is).
   */
  parkEndedCall(ext: string, info: CallInfo): boolean {
    const lid = info['linkedid'];
    if (!lid) return false;
    let parked = this.endedCalls.get(lid);
    if (parked === undefined) {
      parked = new Map();
      this.endedCalls.set(lid, parked);
    }
    parked.set(ext, info);
    // Bounded: a Linkedid whose final hangup never arrives would otherwise leak.
    while (this.endedCalls.size > 500) this.endedCalls.delete(this.endedCalls.keys().next().value as string);
    return true;
  }

  /**
   * The route of a call in progress, from `ext`'s side: an outside caller through a queue or
   * straight to the extension, an extension (or a feature code) on either side, or an outside
   * number the extension dialled. null while nothing marks it yet.
   */
  liveRoute(info: CallInfo, ext: string): LiveRoute | null {
    const caller = pyStr(info['caller'] || info['queue_caller'] || '');
    if (meaningful(caller) && caller !== ext) {
      if (isExtNumber(caller)) return 'internal';
      return info['queue'] || info['queue_caller'] ? 'inbound_queue' : 'inbound_direct';
    }
    const dialled = pyStr(info['original_destination'] || info['exten'] || info['destination'] || '');
    if (dialled.startsWith('*')) return 'internal';
    if (!meaningful(dialled) || dialled === ext) return null;
    return isExtNumber(dialled) ? 'internal' : 'outbound';
  }

  /**
   * The number `ext`'s live call is talking to (what the Active Calls row shows), or null
   * when the extension has no live call.
   */
  callPeerOf(ext: string): string | null {
    const info = this.activeCalls.get(ext);
    if (!info || !info['channel'] || info['ended']) return null;
    const peer = this.displayNumber(info, ext);
    return peer === 'Unknown' ? null : peer;
  }

  /** Map channel -> ext, caching new mappings. */
  resolveExt(channel: string): string | null {
    let ext = this.ch2ext.get(channel) || null;
    if (!ext) {
      ext = extFromChannel(channel);
      if (ext) this.ch2ext.set(channel, ext);
    }
    return ext;
  }

  /** Pick the best number to show for a call, in priority order. */
  displayNumber(info: CallInfo, ext: string): string {
    for (const key of ['original_destination', 'caller', 'destination', 'exten', 'callerid']) {
      const v = info[key];
      if (v && v !== ext && meaningful(v)) return v;
    }
    return 'Unknown';
  }

  statusDesc(code: unknown, ext: string | null = null): string {
    if (ext && this.activeCalls.has(ext) && !this.activeCalls.get(ext)!['ended']) {
      const info = this.activeCalls.get(ext)!;
      const num = this.displayNumber(info, ext);
      const state = dget(info, 'state', '');
      if (state === 'Ringing') return `Ringing with ${num}`;
      return `In call with ${num}` + (!['Up', 'Ring', 'Ringing'].includes(state) ? ` (${state})` : '');
    }
    const k = pyStr(code).trim();
    return Object.prototype.hasOwnProperty.call(STATUS_MAP, k) ? STATUS_MAP[k] : `Unknown (${pyStr(code)})`;
  }

  /** Let *target* know it has an incoming call from *caller*. */
  crossRef(caller: string, target: string, linkedid = ''): void {
    if (target === caller || !meaningful(target)) return;
    // Only internal extensions (3-5 digits); external numbers would leave stale entries.
    if (!isdigit(target) || target.length > 5) return;
    const t = this.callInfo(target);
    t['caller'] = caller; // Always set caller for incoming call detection
    if (!t['original_destination']) t['original_destination'] = caller;
    // Tagged with the caller's Linkedid so the final-hangup sweep reaps the placeholder when
    // the target never gets a channel of its own (caller gave up first, unregistered phone).
    if (linkedid && !t['linkedid']) t['linkedid'] = linkedid;
  }

  /** Remember the channel driver an extension uses (from a channel or interface name). */
  learnTech(name: string | null | undefined): void {
    if (!name) return;
    const m = /^(PJSIP|SIP|IAX2|DAHDI)\/(\d+)(?:-|$)/i.exec(name);
    if (m) this.techByExt.set(m[2], m[1].toUpperCase() === 'IAX2' ? 'IAX2' : m[1].toUpperCase());
  }

  /** The channel driver to dial `ext` with: learned, else the PBX's devices table, else PJSIP. */
  deviceTech(ext: string): string {
    return this.techByExt.get(String(ext).trim()) || DEFAULT_TECH;
  }

  /** `<tech>/<ext>` for originating to / adding as a member a bare extension. */
  deviceInterface(ext: string): string {
    return normalizeInterface(String(ext).trim(), this.deviceTech(ext));
  }

  /**
   * Load ext -> driver from the PBX's `devices` table (FreePBX and Issabel both keep it:
   * tech 'pjsip' or 'sip'). Read-only; failures leave the learned map as it is.
   */
  async loadDeviceTechs(): Promise<void> {
    try {
      const rows = await query<{ id: string; tech: string }>('SELECT id, tech FROM devices', [], 'pbx');
      for (const r of rows) {
        const tech = String(r.tech || '').trim().toUpperCase();
        const ext = String(r.id || '').trim();
        if (!ext || !tech) continue;
        this.techByExt.set(ext, tech === 'PJSIP' ? 'PJSIP' : tech === 'SIP' ? 'SIP' : tech === 'IAX2' ? 'IAX2' : tech);
      }
    } catch (e) {
      log.debug('device tech lookup failed: %s', errText(e));
    }
  }

  // ------------------------------------------------------------------
  // Extension status
  // ------------------------------------------------------------------
  async getExtensionStatus(ext: string): Promise<AmiMessage | null> {
    const resp = await this.sendAsync('ExtensionState', { Exten: ext, Context: this.context });
    if (resp && resp.includes('Response: Success')) {
      const parsed = parse(resp);
      if (truthyObj(parsed)) this.extensions.set(ext, parsed);
      return parsed;
    }
    return null;
  }

  /** Query and cache status for all monitored extensions. */
  async syncExtensionStatuses(): Promise<void> {
    if (!this.connected || !this.monitored.size) return;
    for (const ext of [...this.monitored]) await this.getExtensionStatus(ext);
  }

  // ------------------------------------------------------------------
  // Do Not Disturb (AstDB "DND" family, honoured by FreePBX and Issabel dialplans)
  // ------------------------------------------------------------------
  /** Enable/disable DND for an extension (DBPut DND/<ext>=YES / DBDel). */
  async setDnd(ext: string, enabled: boolean): Promise<boolean> {
    const e = String(ext ?? '').trim();
    if (!e) return false;
    const ok = enabled ? await this.dbPut('DND', e, 'YES') : await this.dbDel('DND', e);
    if (ok) {
      if (enabled) this.dnd.add(e);
      else this.dnd.delete(e);
    }
    return ok;
  }

  /** Hydrate `dnd` from AstDB (`database show DND`), both CLI reply shapes. */
  async syncDndState(): Promise<void> {
    if (!this.connected) return;
    const family = await this.dbGetFamily('DND', true);
    if (family === null) return;
    this.dnd = new Set(Object.entries(family).filter(([, v]) => pyStr(v).trim()).map(([k]) => k));
  }

  async dbPut(family: string, key: string, val: string): Promise<boolean> {
    const resp = await this.sendAsync('DBPut', { Family: family, Key: pyStr(key), Val: pyStr(val) });
    return !!(resp && resp.includes('Response: Success'));
  }

  async dbDel(family: string, key: string): Promise<boolean> {
    const resp = await this.sendAsync('DBDel', { Family: family, Key: pyStr(key) });
    // DBDel errors when the key is already absent — the desired end state holds.
    return !!(resp && (resp.includes('Response: Success') || /does not exist/i.test(resp)));
  }

  /**
   * {key: value} of an AstDB family via the CLI `database show <family>`. Accepts the raw
   * legacy reply (Asterisk <= 13) and the `Output:` form (14+), which the Python missed —
   * on modern Asterisk its DND sync always came back empty. null when the read failed.
   */
  async dbGetFamily(family: string, nullOnFailure = false): Promise<Record<string, string>> {
    const resp = await this.sendAsync('Command', { Command: `database show ${family}` });
    const out: Record<string, string> = {};
    if (!resp) return nullOnFailure ? (null as unknown as Record<string, string>) : out;
    const prefix = `/${family}/`;
    for (const line of commandOutputLines(resp)) {
      if (!line.startsWith(prefix) || !line.includes(':')) continue;
      const i = line.indexOf(':');
      const segs = line.slice(0, i).trim().split('/');
      const key = segs[segs.length - 1];
      if (key) out[key] = line.slice(i + 1).trim();
    }
    return out;
  }

  // ------------------------------------------------------------------
  // Active-channel / sync
  // ------------------------------------------------------------------
  async getActiveChannel(ext: string): Promise<string | null> {
    // 1. local cache
    const info = this.activeCalls.get(ext);
    if (info && info['channel']) return info['channel'];
    for (const [ch, e] of this.ch2ext) if (e === ext) return ch;

    // 2. live query (only if not found in cache)
    const prefixes = DEVICE_TECHS.map((t) => `${t}/${ext}-`);
    for (const [action, complete] of [['Status', 'StatusComplete'], ['CoreShowChannels', 'CoreShowChannelsComplete']]) {
      const msgs = await this.sendActionWithEvents(action, null, complete);
      for (const m of msgs || []) {
        const ch = m['Channel'] || '';
        if (ch && prefixes.some((p) => ch.startsWith(p))) return ch;
      }
    }
    return null;
  }

  /** Rebuild active_calls / ch2ext / ch_callerid from AMI `Status`. */
  async syncActiveCalls(): Promise<Map<string, CallInfo>> {
    const msgs = await this.sendActionWithEvents('Status', null, 'StatusComplete');
    if (!msgs || !msgs.length || !/Success/i.test(msgs[0]['Response'] || '')) return this.activeCalls;

    const newActive = new Map<string, CallInfo>();
    const newCh2ext = new Map<string, string>();
    const newChCallerid = new Map<string, string>();
    const newAnswered = new Map<string, string>();
    // EVERY channel Asterisk listed, extension or not: a caller waiting in a queue sits on a
    // trunk channel, which names no extension but is very much alive.
    const liveChannels = new Set<string>();

    for (const cur of msgs.slice(1)) {
      if (cur['Event'] !== 'Status') continue;
      const ch = cur['Channel'] || '';
      if (!ch) continue;
      liveChannels.add(ch);
      const ext = extFromChannel(ch);
      if (!ext) continue;
      this.learnTech(ch);
      const state = (cur['ChannelStateDesc'] || '').trim();
      const channelState = (cur['ChannelState'] || '').trim();
      // Only channels that are actually active: not Down (ChannelState 0) / hung up.
      const isActive = !!state && !['down', ''].includes(state.toLowerCase()) && !['0', ''].includes(channelState);
      if (!isActive) continue;
      newCh2ext.set(ch, ext);
      const callerid = cur['CallerIDNum'] || '';
      const connected = cur['ConnectedLineNum'] || '';
      newChCallerid.set(ch, callerid);

      const existing = this.activeCalls.get(ext);
      let info: CallInfo;
      if (existing && truthyObj(existing)) {
        info = { ...existing };
        // Asterisk lists a live channel for this extension: whatever ended earlier is over,
        // so the `ended` flag (markCallEnded) must not hide the call just resynced.
        delete info['ended'];
        // Preserve duration tracking fields
        if (!('start_time' in info)) info['start_time'] = new Date();
        if (!('answer_time' in info)) info['answer_time'] = null;
      } else {
        info = { start_time: new Date(), answer_time: null };
      }
      Object.assign(info, {
        channel: ch,
        callerid,
        state: state || 'Up',
        destination: connected,
        original_destination: meaningful(connected) ? connected : dget(info, 'original_destination', ''),
      });
      // Python keyed by ext with "last channel wins"; keep that.
      newActive.set(ext, info);
      if ((state || 'Up') === 'Up' && RE_DEVICE_CHANNEL.test(ch)) newAnswered.set(ch, ext);
      const linkedid = cur['Linkedid'] || '';
      if (linkedid && !info['linkedid']) info['linkedid'] = linkedid;
      if (linkedid) {
        this.ch2linkedid.set(ch, linkedid);
        let set = this.linkedid2channels.get(linkedid);
        if (!set) {
          set = new Set();
          this.linkedid2channels.set(linkedid, set);
        }
        set.add(ch);
      }
    }

    // An ended entry still owes its call's final-hangup push: park it rather than lose it.
    for (const [ext, info] of this.activeCalls) {
      if (info['ended'] && !newActive.has(ext)) this.parkEndedCall(ext, info);
    }
    this.activeCalls = newActive;
    this.ch2ext = newCh2ext;
    this.chCallerid = newChCallerid;
    this.answeredCh = newAnswered;
    // Keep destch2ext for ongoing dial attempts whose channel or caller still exists.
    const chSet = new Set(newCh2ext.keys());
    for (const [ch, ext] of [...this.destch2ext]) {
      if (!chSet.has(ch) && !newActive.has(ext)) this.destch2ext.delete(ch);
    }
    // Queue entries whose channel is gone are stale. "Gone" is judged against every listed
    // channel, not just the extension ones, or each sync would evict the waiting callers.
    const newCh2uid = new Map<string, string>();
    for (const [ch, uid] of this.ch2uniqueid) {
      if (liveChannels.has(ch)) newCh2uid.set(ch, uid);
      else if (this.queueEntries.has(uid)) {
        const entry = this.queueEntries.get(uid)!;
        this.queueEntries.delete(uid);
        this.recountWaiting(entry.queue);
      }
    }
    this.ch2uniqueid = newCh2uid;

    log.info('✅ Synced: %s active call(s)', this.activeCalls.size);
    return this.activeCalls;
  }

  private recountWaiting(queue: string): void {
    const q = this.queues.get(queue);
    if (!q) return;
    let n = 0;
    for (const e of this.queueEntries.values()) if (e.queue === queue) n += 1;
    q.calls_waiting = n;
  }

  // ------------------------------------------------------------------
  // Event loop
  // ------------------------------------------------------------------
  static readonly WATCHED_EVENTS = WATCHED_EVENTS;

  /** Process one AMI event: raw sink, handler, then registered callbacks. */
  async dispatchAsync(raw: string | AmiMessage): Promise<void> {
    const p = typeof raw === 'string' ? parse(raw) : raw;
    const ev = p['Event'] || '';
    // Raw sink (System Logs panel) — deliberately BEFORE the watched-events filter.
    this.feedRawSink(p);
    if (!WATCHED_EVENTS.has(ev)) return;

    const handler = (this as unknown as Record<string, unknown>)[`ev${ev}`];
    if (typeof handler === 'function') {
      const ts = this.monitored.size ? hms(new Date()) : '';
      try {
        const r = (handler as (p: AmiMessage, ts: string) => unknown).call(this, p, ts);
        if (r instanceof Promise) await r;
      } catch (e) {
        log.error('Handler for %s failed: %s', ev, errText(e));
      }
    }
    // Callbacks see every watched event, handled here or not (agent presence needs the
    // QueueMemberPause events the Python had no handler for).
    for (const callback of [...this.eventCallbacks]) {
      try {
        const out = callback(p);
        if (out instanceof Promise) await out;
      } catch (e) {
        log.error('Event callback error: %s', errText(e));
      }
    }
  }

  registerEventCallback(callback: EventCallback): void {
    this.eventCallbacks.push(callback);
  }

  unregisterEventCallback(callback: EventCallback): void {
    const i = this.eventCallbacks.indexOf(callback);
    if (i !== -1) this.eventCallbacks.splice(i, 1);
  }

  /** Sink for EVERY parsed AMI event (System Logs). Runs on the read path: must not block. */
  setRawEventSink(callback: ((p: AmiMessage) => unknown) | null): void {
    this.rawEventSink = callback;
  }

  /** Called with the extension after a call_notifications row was inserted. */
  setCallNotificationCallback(callback: ((ext: string) => unknown) | null): void {
    this.callNotificationCallback = callback;
  }

  /** Called when a monitored extension starts ringing (ext, caller, call_id, display_name). */
  setIncomingCallCallback(callback: ((ext: string, caller: string, callId: string, displayName: string) => unknown) | null): void {
    this.incomingCallCallback = callback;
  }

  /** Called at hangup with (ext, call_status, linkedid) for a leg that connected. */
  setCallOutcomeCallback(callback: ((ext: string, callStatus: string, linkedid: string) => unknown) | null): void {
    this.callOutcomeCallback = callback;
  }

  // ------------------------------------------------------------------
  // Outcomes and notifications
  // ------------------------------------------------------------------
  /** Extract channel type like 'sbc' from PJSIP/sbc-000000a1, or 'Local' for internal extensions. */
  getChannelType(channel: string): string {
    if (!channel) return '';
    const m = RE_CHANNEL_TYPE.exec(channel);
    if (m) return isdigit(m[1]) ? 'Local' : m[1];
    return '';
  }

  /**
   * Map a hangup cause (+ dial status) to the canonical call outcome — the same word call
   * history, the bell and the CRM push carry (ANSWERED UNANSWERED BUSY MISSED VOICEMAIL
   * UNREACHABLE FAILURE NETWORK_ERROR ABANDONED DROPPED).
   */
  mapCauseToStatus(
    cause: unknown,
    opts: { dialStatus?: unknown; answered?: boolean; abandoned?: boolean; outbound?: boolean } = {},
  ): string {
    return mapCallOutcome({
      cause: cause === null || cause === undefined ? null : pyStr(cause),
      dialStatus: opts.dialStatus === null || opts.dialStatus === undefined ? null : pyStr(opts.dialStatus),
      answered: opts.answered ?? false,
      abandoned: opts.abandoned ?? false,
      outbound: opts.outbound ?? false,
    });
  }

  /** The `reason` stored on a call_notifications row: the canonical status itself. */
  notifyReason(cause: unknown): string {
    return this.mapCauseToStatus(cause);
  }

  /**
   * True only when the hangup is a missed / busy / unreachable outcome. MISSED (cause 16:
   * the caller gave up while it was ringing) notifies too — the phone rang and nobody got
   * to it. VOICEMAIL (something answered) and ABANDONED (the queue's verdict, not one
   * agent's miss) do not; nor does anything answered.
   */
  shouldNotifyMissedOrBusy(cause: unknown, callInfo: CallInfo | null = null): boolean {
    if (callInfo && callInfo['answer_time']) return false;
    return NOTIFY_OUTCOMES.has(this.mapCauseToStatus(cause));
  }

  /**
   * Whether `notifyExt` was the party that was rung (so an unanswered hangup is a missed
   * call for it), and the number to show as "from". An unanswered call this extension
   * PLACED is not a missed call for it.
   */
  missedCallParty(notifyExt: string, callInfo: CallInfo | null, knownCaller = '', startedCall = false): [boolean, string | null] {
    if (meaningful(knownCaller) && knownCaller !== notifyExt) return [true, knownCaller];
    const info: CallInfo = callInfo || {};
    const caller = info['caller'] || info['queue_caller'] || '';
    if (meaningful(caller) && caller !== notifyExt) return [true, caller];
    const dialled = info['exten'] || info['original_destination'] || '';
    if (meaningful(dialled) && dialled !== notifyExt) return [false, null]; // notifyExt placed this call
    if (startedCall && dialled === notifyExt) return [false, null];
    const callerid = info['callerid'] || '';
    return [true, meaningful(callerid) && callerid !== notifyExt ? callerid : null];
  }

  /**
   * Insert the call_notifications row (reason = canonical status), then fire the
   * notification callback (WebSocket `call_notification_new` + missed-call push). The
   * callback only runs once the row exists, which the client's refetch relies on.
   */
  notifyMissedCall(ext: string, callerVal: string | null, queue: string | null, uniqueid: string, cause: unknown): void {
    // Only a real extension has a bell: never a queue number or an outside number that
    // keys a waiting caller's entry.
    if (!isExtNumber(ext) || this.queues.has(ext)) return;
    const reason = this.notifyReason(cause);
    createTask(
      (async () => {
        await dbm.insertCallNotification(ext, {
          callerFrom: callerVal || null,
          queue: queue || null,
          callId: uniqueid || null,
          reason,
        });
        if (this.callNotificationCallback) {
          try {
            const r = this.callNotificationCallback(ext);
            if (r instanceof Promise) r.catch((e) => log.debug('call_notification_callback error: %s', e));
          } catch (e) {
            log.debug('call_notification_callback error: %s', e);
          }
        }
      })(),
      (e) => log.error('call notification for %s failed: %s', ext, errText(e)),
    );
  }

  /** The Linkedid of another call `ext` is answered on right now, or ''. */
  talkingOnOtherCall(ext: string, linkedid: string): string {
    for (const [ch, chExt] of this.answeredCh) {
      if (chExt !== ext) continue;
      const other = this.ch2linkedid.get(ch) || '';
      if (other && other !== linkedid) return other;
    }
    return '';
  }

  /**
   * Push one call's authoritative outcome to the agent's client (WebSocket
   * `call_outcome`). Withheld while the agent is talking on a different call (a ring-out
   * of a second call must not end the first one's after-call screen). Never raises.
   */
  pushCallOutcome(ext: string, status: string, linkedid: string): void {
    if (!ext || this.callOutcomeCallback === null) return;
    const other = this.talkingOnOtherCall(ext, linkedid || '');
    if (other) {
      log.info('⏸️ call_outcome %s for %s [%s] withheld: %s is still talking on %s', status, ext, linkedid, ext, other);
      return;
    }
    try {
      const r = this.callOutcomeCallback(ext, status || '', linkedid || '');
      if (r instanceof Promise) r.catch((e) => log.warning('call_outcome callback failed for %s: %s', ext, e));
    } catch (e) {
      log.warning('call_outcome callback failed for %s: %s', ext, errText(e));
    }
  }

  // ------------------------------------------------------------------
  // CRM push
  // ------------------------------------------------------------------
  /** Hot-swap the CRM connector + sync config (Settings changes apply live). */
  setCrm(crmConnector: CRMConnector | null, crmSyncConfig: CRMSyncConfig | null = null): void {
    this.crmConnector = crmConnector;
    if (crmSyncConfig !== null) this.crmSyncConfig = crmSyncConfig;
    else if (this.crmSyncConfig === null && CRMSyncConfig) this.crmSyncConfig = new CRMSyncConfig();
    const enabled = !!(this.crmSyncConfig && (this.crmSyncConfig as unknown as { enabled?: boolean }).enabled);
    log.info('🔄 CRM runtime updated (connector=%s, sync=%s)', crmConnector ? 'set' : 'none', enabled ? 'enabled' : 'disabled');
  }

  /** Seconds a queue caller waited before an agent answered, or '' when unknown. */
  crmQueueWaitSeconds(callInfo: CallInfo, queue: string | null, queueCaller: string | null): number | '' {
    try {
      let ans = callInfo['answer_time'];
      let entry = callInfo['entry_time'];
      if (!entry && queueCaller) {
        const ci = this.activeCalls.get(queueCaller);
        if (ci) {
          entry = ci['entry_time'];
          ans = ans || ci['answer_time'];
        }
      }
      const e = toDate(entry);
      const a = toDate(ans);
      if (!e || !a) return '';
      const secs = Math.trunc((a.getTime() - e.getTime()) / 1000);
      return secs >= 0 ? secs : '';
    } catch {
      return '';
    }
  }

  /** Defer to the next turn: the hangup handler finishes its bookkeeping first (Python create_task). */
  private scheduleCallFinished(ext: string, info: CallInfo, p: AmiMessage, queue: string | null, label: string): void {
    setImmediate(() => {
      createTask(this.sendCrmData(ext, info, p, queue), (e) =>
        log.error('Could not schedule CRM send task for %s %s: %s', label, ext, errText(e)),
      );
    });
  }

  /**
   * A call ended: compute its fields and outcome, push the outcome to the agent's client,
   * and send the CRM call-data push when a CRM is configured.
   */
  async sendCrmData(ext: string, callInfo: CallInfo, hangupEvent: AmiMessage, queue: string | null = null): Promise<void> {
    try {
      // Queue call still waiting (no agent answered)? The flag is on the CALLER's entry.
      let queueWaiting = !!dget(callInfo, 'queue_waiting', false);
      let queueAnswered = !!dget(callInfo, 'queue_answered', false);
      let queueCallerChannel: string = dget(callInfo, 'queue_caller_channel', '');
      const hangupChannel = dget(hangupEvent, 'Channel', '');

      let queueCaller: string = callInfo['queue_caller'] || callInfo['caller'] || '';
      if (queueCaller && queueCaller !== ext) {
        const callerCallInfo = this.activeCalls.get(queueCaller);
        if (callerCallInfo && truthyObj(callerCallInfo)) {
          queueWaiting = !!dget(callerCallInfo, 'queue_waiting', queueWaiting);
          queueAnswered = !!dget(callerCallInfo, 'queue_answered', queueAnswered);
          queueCallerChannel = dget(callerCallInfo, 'queue_caller_channel', queueCallerChannel);
        }
      }

      // Queue call nobody answered yet: only the caller's own hangup (an abandon) counts;
      // an agent's ring timeout must not push.
      let isQueueAbandon = false;
      if (queueWaiting && !queueAnswered) {
        const isCallerHangup = !!queueCallerChannel && hangupChannel === queueCallerChannel;
        const isAgentExt = isExtNumber(ext);
        if (isAgentExt && !isCallerHangup) {
          log.info(`⏸️ Queue call still waiting - skipping CRM for agent ${ext} ring timeout (waiting for caller hangup or agent answer)`);
          return;
        } else if (!isCallerHangup) {
          log.debug(`⏸️ Queue call still waiting - skipping CRM for ${ext} (not caller channel)`);
          return;
        }
        isQueueAbandon = true;
        log.info(`📤 Queue caller abandoned - sending CRM for caller ${ext}`);
      }

      const cause = dget(hangupEvent, 'Cause', '');
      const dialStatus = dget(callInfo, 'dialstatus', '');

      if (!queue) queue = callInfo['queue'] || null;
      // The queue's own extension: push from the agent's perspective instead.
      if (queue && ext === queue) {
        log.info(`⏸️ Skipping CRM send for queue extension ${ext} - will send from agent's perspective instead`);
        return;
      }

      let caller = ext;
      let destination = '';
      const originalDest = callInfo['original_destination'] || callInfo['destination'] || callInfo['exten'] || '';

      queueCaller = dget(callInfo, 'queue_caller', '');
      queueAnswered = !!dget(callInfo, 'queue_answered', false);

      // Incoming caller, in priority order: queue_caller, caller, callerid.
      let incomingCaller: string = queueCaller || callInfo['caller'] || callInfo['callerid'] || '';
      if (incomingCaller && isdigit(incomingCaller) && incomingCaller.length <= 5 && incomingCaller === ext) {
        incomingCaller = '';
      }
      const isExternalCaller = !!ext && (!isdigit(ext) || ext.length < 3 || ext.length > 5);

      if (queue && incomingCaller && incomingCaller !== ext && (incomingCaller.length > 5 || !isdigit(incomingCaller))) {
        // Queue call with an external caller: ext is the agent.
        caller = incomingCaller;
        destination = ext;
      } else if ((incomingCaller && incomingCaller !== ext) || isExternalCaller) {
        if (isExternalCaller) {
          caller = ext;
          if (isExtNumber(ext)) {
            destination = ext;
          } else {
            destination = dget(callInfo, 'destination', '');
            if (queue && destination === queue) {
              const connectedDest = dget(callInfo, 'destination', '');
              if (connectedDest && connectedDest !== queue && isExtNumber(connectedDest)) destination = connectedDest;
            }
          }
        } else {
          caller = incomingCaller;
          destination = ext;
        }
      } else {
        // Outbound call - use original destination
        destination = originalDest;
        if (queue && destination === queue) {
          const connectedDest = dget(callInfo, 'destination', '');
          if (connectedDest && connectedDest !== queue && isExtNumber(connectedDest)) destination = connectedDest;
        }
      }

      const answeredAgent: string = dget(callInfo, 'answered_agent', '') || '';
      if (queue && destination === queue && meaningful(answeredAgent)) destination = answeredAgent;

      if (!meaningful(caller) || !meaningful(destination)) {
        log.info(`⏸️ Skipping CRM send for extension ${ext}: missing meaningful caller (${caller}) or destination (${destination})`);
        return;
      }

      // Durations
      let durationSeconds = 0;
      let talkSeconds = 0;
      let datetimeStr = isoformat(new Date());
      if ('start_time' in callInfo) {
        const start = toDate(callInfo['start_time']) || new Date();
        durationSeconds = Math.trunc((Date.now() - start.getTime()) / 1000);
        datetimeStr = isoformat(start);
      }
      if ('answer_time' in callInfo) {
        const ans = toDate(callInfo['answer_time']);
        if (ans) talkSeconds = Math.trunc((Date.now() - ans.getTime()) / 1000);
      }

      // Call type
      let callType = 'internal';
      if (incomingCaller && incomingCaller !== ext) callType = 'inbound';
      else if (destination && destination !== ext) callType = isExtNumber(destination) ? 'internal' : 'outbound';

      const causeRaw = cause ? pyStr(cause) : '';
      const answered = !!callInfo['answer_time'] || queueAnswered;
      // One canonical outcome; `disposition` carries the same value.
      let callStatus = this.mapCauseToStatus(cause, {
        dialStatus,
        answered,
        abandoned: isQueueAbandon,
        outbound: callType === 'outbound',
      });
      let disposition = callStatus;

      let agent = (answeredAgent ? pyStr(answeredAgent) : '') || (callInfo['membername'] ? pyStr(callInfo['membername']) : '');
      let answeredExtension = '';
      const destS = destination ? pyStr(destination) : '';
      if (answered && isExtNumber(destS)) answeredExtension = destS;
      if (!agent && answeredExtension && queue) agent = answeredExtension;

      // The clients whose after-call screen this outcome belongs to: every party that is
      // an extension (a membername like "Ahmed" must never address the frame; a queue
      // number is not a party), and only for a call that connected.
      const linkedid = pyStr(hangupEvent['Linkedid'] || callInfo['linkedid'] || '');
      if (answered) {
        const parties = [agent || '', answeredExtension, caller ? pyStr(caller) : '', destS, ext ? pyStr(ext) : ''];
        for (const party of new Set(parties.filter((c) => isExtNumber(c) && !this.queues.has(c)))) {
          this.pushCallOutcome(party, callStatus, linkedid);
        }
      }

      // CRM off: nothing to push. CRM on but its connector could not be built (missing URL
      // or credential): carry on, so the push is recorded as a failed delivery.
      if (!this.crmConnector && !crmUnavailableReason()) {
        log.info(`⏸️ CRM connector not available - skipping CRM send for extension ${ext}`);
        return;
      }

      // Caller name (best-effort; populated by NewCallerid on the caller's leg)
      let callerName = callInfo['callerid_name'] ? pyStr(callInfo['callerid_name']) : '';
      if (!callerName && queueCaller) {
        const ci = this.activeCalls.get(queueCaller);
        if (ci) callerName = ci['callerid_name'] ? pyStr(ci['callerid_name']) : '';
      }
      const queueWaitTime = queue ? this.crmQueueWaitSeconds(callInfo, queue, queueCaller) : '';

      let agentName = '';
      if (agent) {
        try {
          agentName = (await dbm.getAgentNameByExtension(agent)) || '';
        } catch (e) {
          log.debug('agent_name lookup failed for %s: %s', agent, errText(e));
        }
      }

      const fullFields: Record<string, unknown> = {
        caller: caller ? pyStr(caller) : '',
        destination: destS,
        duration: CRMConnector.normalizeDuration(durationSeconds),
        talk_time: CRMConnector.normalizeDuration(talkSeconds),
        datetime: datetimeStr,
        call_status: callStatus,
        call_type: callType,
        queue: queue ? pyStr(queue) : '',
        caller_name: callerName,
        call_id: linkedid,
        uniqueid: pyStr(hangupEvent['Uniqueid'] || ''),
        disposition,
        hangup_cause: causeRaw,
        agent,
        agent_name: agentName,
        answered_extension: answeredExtension,
        queue_wait_time: queueWaitTime,
      };

      // CDR identity overlay: the finalized CDR (what the call log renders) wins for
      // identity; the live OUTCOME always wins (the CDR only has the coarse disposition).
      // Often a no-op: Asterisk writes the CDR in its own hangup handler.
      if (linkedid) {
        let cdrIdent: Record<string, unknown> | null = null;
        try {
          cdrIdent = (await crmIdentityFromCdr(linkedid)) as Record<string, unknown> | null;
        } catch (e) {
          log.debug('CDR identity fetch failed for %s: %s', linkedid, errText(e));
        }
        if (cdrIdent && truthyObj(cdrIdent)) {
          const liveStatus = fullFields.call_status;
          const liveDisp = fullFields.disposition;
          Object.assign(fullFields, cdrIdent);
          if (liveStatus) fullFields.call_status = liveStatus;
          if (liveDisp) fullFields.disposition = liveDisp;
          caller = pyStr(fullFields.caller ?? caller);
          destination = pyStr(fullFields.destination ?? destination);
          callType = pyStr(fullFields.call_type ?? callType);
          callStatus = pyStr(fullFields.call_status);
          disposition = pyStr(fullFields.disposition);
          log.debug('CDR identity overlay applied for %s', linkedid);
        }
      }

      // Operator's sync config: enabled? direction allowed?
      const syncCfg = this.crmSyncConfig as (CRMSyncConfig & Record<string, any>) | null;
      if (syncCfg && !syncCfg.enabled) {
        log.info(`⏸️ CRM call-data sync disabled - skipping push for ${caller} -> ${destination}`);
        return;
      }
      if (syncCfg && !syncCfg.directionAllowed(callType)) {
        log.info(`⏸️ CRM sync skipped: direction '${callType}' disabled (${caller} -> ${destination})`);
        return;
      }

      const selected: string[] | null = syncCfg && syncCfg.fields && syncCfg.fields.length ? [...syncCfg.fields] : null;
      let callData: Record<string, unknown>;
      if (selected !== null) {
        callData = buildCrmPayload(fullFields, selected, {
          durationFormat: syncCfg?.durationFormat ?? 'hms',
          statusMap: syncCfg?.statusMap ?? null,
          keyMap: syncCfg?.keyMap ?? null,
        });
      } else {
        // The legacy fixed 8-field body.
        const legacy = ['caller', 'destination', 'duration', 'talk_time', 'datetime', 'call_status', 'call_type', 'queue'];
        callData = {};
        for (const [k, v] of Object.entries(fullFields)) if (legacy.includes(k) && v !== null && v !== '') callData[k] = v;
      }

      const method = (syncCfg ? syncCfg.method : 'POST') || 'POST';
      const endpoint = (syncCfg ? syncCfg.endpoint : null) || null;
      const meta: Record<string, unknown> = {
        call_id: fullFields.call_id || '',
        uniqueid: fullFields.uniqueid || '',
        caller: fullFields.caller || '',
        destination: fullFields.destination || '',
        call_type: fullFields.call_type || '',
        call_status: fullFields.call_status || '',
      };

      log.info(`📤 Preparing CRM push: ${caller} -> ${destination} (status: ${callStatus}, type: ${callType}, ` +
        `fields: ${Object.keys(callData).length}, method: ${method}, queue: ${queue || 'N/A'})`);

      // "After wrap-up" trigger: park the call; integrations/crm-delivery pushes it once
      // the agent's wrap-up is over (or its fallback window ends).
      if (syncCfg && syncCfg.trigger === 'wrapup' && fullFields.call_id) {
        parkForWrapup(fullFields, meta);
        return;
      }

      // Fire-and-forget — never block hangup processing.
      createTask(this.sendCrmDataAsync(callData, { method, endpointPath: endpoint, meta }), (e) =>
        log.error('CRM send failed: %s', errText(e)),
      );
    } catch (e) {
      log.error(`Error preparing CRM data for call: ${errText(e)}`);
    }
  }

  /**
   * Send the CRM push: queued in webhook_deliveries before the first attempt, retried by
   * the delivery worker on a transient failure (integrations/crm-delivery).
   */
  async sendCrmDataAsync(
    callData: Record<string, unknown>,
    opts: { method?: string; endpointPath?: string | null; meta?: Record<string, unknown> | null } = {},
  ): Promise<Record<string, any>> {
    return deliverCrmPush(this.crmConnector, callData, {
      method: opts.method || 'POST',
      endpointPath: opts.endpointPath ?? null,
      meta: (opts.meta || {}) as CrmDeliveryMeta,
      syncCfg: this.crmSyncConfig,
      trigger: 'hangup',
    });
  }

  // ------------------------------------------------------------------
  // Individual event handlers (Python _ev_<Event> -> ev<Event>)
  // ------------------------------------------------------------------
  evExtensionStatus(p: AmiMessage, _ts: string): void {
    const ext = dget(p, 'Exten', '');
    if (!ext) return;
    this.extensions.set(ext, p);
    // NOTE: never drop active_calls here: an Idle status can arrive BEFORE the Hangup,
    // and the Hangup is the authoritative end of the call (it sends the CRM push).
  }

  /** chan_sip (and PJSIP) registration changes. No state is derived from them. */
  evPeerStatus(p: AmiMessage, _ts: string): void {
    this.learnTech(dget(p, 'Peer', ''));
  }

  /** PJSIP contact changes (Asterisk 13+). No state is derived from them. */
  evContactStatus(_p: AmiMessage, _ts: string): void {
    // Watched only so the System Logs feed and callbacks see it.
  }

  evDeviceStateChange(p: AmiMessage, _ts: string): void {
    // Device names carry no channel suffix (PJSIP/100), so this only matches the rare
    // channel-shaped device, exactly as the Python did. Hints come via ExtensionStatus.
    const ext = extFromChannel(dget(p, 'Device', ''));
    if (ext && this.activeCalls.has(ext)) {
      const info = this.activeCalls.get(ext)!;
      // An entry held only for the final-hangup sweep must not be revived by a late state event.
      if (!info['ended']) info['state'] = dget(p, 'State', '');
    }
  }

  evNewchannel(p: AmiMessage, _ts: string): void {
    const ch = dget(p, 'Channel', '');
    const callerid = p['CallerIDNum'] || dget(p, 'CallerIDName', '');
    const exten = dget(p, 'Exten', '');
    const uniqueid = dget(p, 'Uniqueid', '');
    const linkedid = p['Linkedid'] || uniqueid;
    let ext = extFromChannel(ch);
    this.learnTech(ch);

    if (uniqueid) this.ch2uniqueid.set(ch, uniqueid);

    if (linkedid) {
      this.ch2linkedid.set(ch, linkedid);
      let set = this.linkedid2channels.get(linkedid);
      if (!set) {
        set = new Set();
        this.linkedid2channels.set(linkedid, set);
      }
      set.add(ch);
      log.debug(`🔗 Newchannel: Channel=${ch}, Linkedid=${linkedid}, ext=${ext}`);
    }

    // Exten as a fallback only when it is a real number (not a dialplan context).
    if (!ext && meaningful(exten)) ext = exten;

    if (!ext || DIALPLAN_CTX.has(ext.toLowerCase())) {
      // Still track the channel for cleanup purposes
      this.ch2ext.set(ch, meaningful(callerid) ? callerid : '');
      return;
    }

    this.ch2ext.set(ch, ext);
    let info = this.callInfo(ext);
    if (info['ended'] && this.parkEndedCall(ext, info)) {
      // A new channel is a new call: the finished one waits for its own final hangup
      // elsewhere, and this one must not inherit its start_time, peer or queue fields.
      info = {};
      this.activeCalls.set(ext, info);
    }
    info['channel'] = ch;
    // The final-hangup sweep finds the call by it, even when the last leg to leave is a
    // trunk channel that resolves to no extension.
    if (linkedid) info['linkedid'] = linkedid;
    info['callerid'] = callerid;
    if (meaningful(exten)) info['exten'] = exten;
    else if (!('exten' in info)) info['exten'] = '';
    info['context'] = dget(p, 'Context', '');
    info['state'] = 'New';

    if (!('start_time' in info)) {
      info['start_time'] = new Date();
      info['answer_time'] = null;
    }

    // A different callerid means an incoming call (internal <= 5 digits or external).
    if (callerid && callerid !== ext && isdigit(callerid)) {
      info['caller'] = callerid;
      if (callerid.length <= 5) {
        const callerInfo = this.activeCalls.get(callerid);
        if (callerInfo && truthyObj(callerInfo) && !('original_destination' in callerInfo)) {
          callerInfo['original_destination'] = ext;
          callerInfo['exten'] = ext;
        }
      }
    }

    if (!('original_destination' in info)) {
      if (meaningful(exten) && exten !== ext) {
        info['original_destination'] = exten;
        this.crossRef(ext, exten, linkedid);
      } else {
        const conn = dget(p, 'ConnectedLineNum', '');
        if (meaningful(conn)) info['original_destination'] = conn;
      }
    }
  }

  /**
   * OpDeskRecording UserEvent, fired by [opdesk-record] when MixMonitor starts: remember
   * the recording base by Uniqueid so the matching Hangup schedules the post-call VAD
   * analysis (and DialEnd can tell whether the recording holds a conversation at all).
   */
  evUserEvent(p: AmiMessage, _ts: string): void {
    if ((p['UserEvent'] ?? null) !== 'OpDeskRecording') return;
    const uniqueid = dget(p, 'Uniqueid', '');
    const base = dget(p, 'Recbase', '');
    const ch = dget(p, 'Channel', '');
    if (!uniqueid || !base) return;
    if (this.vadPending.size > 5000) this.vadPending.delete(this.vadPending.keys().next().value as string);
    this.vadPending.set(uniqueid, { base, answer: null, nonanswer: false });
    if (ch) this.vadPendingCh.set(ch, uniqueid);
  }

  evHangup(p: AmiMessage, ts: string): void {
    const ch = dget(p, 'Channel', '');
    let uniqueid = dget(p, 'Uniqueid', '');
    const cause = dget(p, 'Cause', '');

    log.info(`🔔 Hangup event received: Channel=${ch}, Uniqueid=${uniqueid}, Cause=${cause}`);

    if (!ch) {
      log.debug('Hangup event ignored: no channel');
      return;
    }
    if (!uniqueid) uniqueid = this.ch2uniqueid.get(ch) || '';
    this.answeredCh.delete(ch);

    // Post-call VAD for a recorded channel (by uniqueid, else by channel for Local/
    // bridged legs whose Hangup carries another Uniqueid). A ring-only recording is
    // deleted only on positive evidence that nobody answered.
    let vadUid: string | null = this.vadPending.has(uniqueid) ? uniqueid : null;
    if (!vadUid) {
      const fallback = this.vadPendingCh.get(ch) || '';
      if (fallback && this.vadPending.has(fallback)) vadUid = fallback;
    }
    this.vadPendingCh.delete(ch);
    if (vadUid) {
      const rec = this.vadPending.get(vadUid)!;
      this.vadPending.delete(vadUid);
      const deleteUnanswered = rec.answer === null && (rec.nonanswer || NOANSWER_CAUSES.has(cause));
      try {
        vadRunner.schedule(rec.base, vadUid, deleteUnanswered);
      } catch (e) {
        log.warning('VAD schedule failed (%s): %s', vadUid, errText(e));
      }
    }

    // Queue name before the queue entry is cleaned up
    let queue: string | null = null;
    if (uniqueid && this.queueEntries.has(uniqueid)) {
      const entry = this.queueEntries.get(uniqueid)!;
      this.queueEntries.delete(uniqueid);
      queue = entry.queue || '';
      this.recountWaiting(queue);
    }
    this.ch2uniqueid.delete(ch);

    // Linkedid from the event, else from tracking
    const eventLinkedid = dget(p, 'Linkedid', '');
    const trackedLinkedid = this.ch2linkedid.get(ch) || '';
    const linkedid = eventLinkedid || trackedLinkedid;
    if (eventLinkedid && !trackedLinkedid) {
      this.ch2linkedid.set(ch, eventLinkedid);
      let set = this.linkedid2channels.get(eventLinkedid);
      if (!set) {
        set = new Set();
        this.linkedid2channels.set(eventLinkedid, set);
      }
      set.add(ch);
      log.info(`🔍 Found Linkedid ${eventLinkedid} in hangup event for channel ${ch}`);
    }

    let isFinalHangup = false; // only push when the final hangup is confirmed
    if (linkedid) {
      const remaining = this.linkedid2channels.get(linkedid);
      if (remaining) {
        const active = [...remaining].filter(
          (c) => c !== ch && this.ch2ext.has(c) && !c.startsWith('PJSIP/asterisk-'),
        );
        if (active.length) {
          isFinalHangup = false;
          log.info(`⏸️ Channel ${ch} hung up but other channels still active with Linkedid ${linkedid}: ${active.join(', ')} - skipping CRM send`);
        } else {
          isFinalHangup = true;
          log.info(`✅ Final channel hung up for Linkedid ${linkedid} - will send CRM data`);
        }
      } else {
        isFinalHangup = true;
        log.info(`✅ Final channel hung up for Linkedid ${linkedid} (no channel tracking) - will send CRM data`);
      }
      // Remove this channel from the Linkedid group (the Python raised KeyError here
      // when the group did not exist; treat it as empty).
      const group = this.linkedid2channels.get(linkedid);
      if (group) group.delete(ch);
      if (!group || !group.size) {
        this.linkedid2channels.delete(linkedid);
        // Linkedids are reused for queue re-rings: forget this call's dedupe keys.
        const prefix = `${linkedid}:`;
        for (const k of [...this.linkedidCrmSent]) if (k.startsWith(prefix)) this.linkedidCrmSent.delete(k);
      }
      this.ch2linkedid.delete(ch);
    } else {
      log.debug(`⏸️ Channel ${ch} hung up without Linkedid - skipping CRM send (cannot determine if final)`);
    }

    // Extension from the channel mapping, else from the channel name
    let ext: string | null = this.ch2ext.get(ch) ?? null;
    this.ch2ext.delete(ch);
    if (!ext) ext = extFromChannel(ch);

    const callerExt = this.destch2ext.get(ch) ?? null;
    this.destch2ext.delete(ch);
    const chType = this.getChannelType(ch);

    // Whether a channel-specific path below pushed this call from an extension's side; the
    // Linkedid sweep at the end only covers a call nothing else pushed.
    let extensionPushed = false;
    const pushes = (pushExt: string | null) => isExtNumber(pushExt) && !this.queues.has(pushExt);

    // Trunk/system channels are not call participants.
    const isTrunkChannel = ch.startsWith('PJSIP/asterisk-') || ch.startsWith('SIP/asterisk-');
    if (isTrunkChannel && isFinalHangup) {
      log.debug(`⏸️ Skipping CRM send for trunk channel ${ch} - CRM should be sent from agent/extension perspective`);
      isFinalHangup = false;
    }

    // This channel was a DESTINATION of callerExt's outgoing call (and has no entry of its own)
    if (callerExt && !(ext && this.activeCalls.has(ext))) {
      const callerInfo = this.activeCalls.get(callerExt);
      if (callerInfo && truthyObj(callerInfo)) {
        const destchannelMatch = (callerInfo['destchannel'] ?? null) === ch;
        const channelMatch = (callerInfo['channel'] ?? null) === ch;
        if (destchannelMatch || channelMatch) {
          if (isdigit(callerExt) && callerExt.length > 5) {
            if (!callerInfo['callerid']) callerInfo['callerid'] = callerExt;
            if (!callerInfo['caller']) callerInfo['caller'] = callerExt;
          }

          if (isFinalHangup) {
            const actualExt = isExtNumber(ext) ? ext! : callerExt;
            const crmKey = linkedid && uniqueid ? `${linkedid}:${uniqueid}` : null;
            if (crmKey && this.linkedidCrmSent.has(crmKey)) {
              log.info(`⏸️ CRM data already sent for ${crmKey} - skipping duplicate send for caller ${callerExt}`);
            } else {
              log.info(`📤 Hangup detected for caller ${callerExt}, attempting CRM send`);
              if (crmKey) this.linkedidCrmSent.add(crmKey);
              this.scheduleCallFinished(actualExt, callerInfo, p, queue, 'caller');
              extensionPushed = extensionPushed || pushes(actualExt);
              // Only the party that was rung has a missed call: when actualExt fell
              // back to callerExt (who placed the call) there is nobody to notify.
              const [notify, callerVal] = this.missedCallParty(actualExt, callerInfo, actualExt !== callerExt ? callerExt : '');
              if (actualExt && actualExt !== callerExt && notify && this.shouldNotifyMissedOrBusy(cause, callerInfo)) {
                this.notifyMissedCall(actualExt, callerVal, queue || callerInfo['queue'] || null, uniqueid, cause);
              }
            }
          }

          const num = this.displayNumber(callerInfo, callerExt);
          if (this.monitored.has(callerExt) && num !== 'Unknown') {
            let durationStr = '';
            if ('start_time' in callerInfo) {
              durationStr = ` | Duration: ${formatDuration(secondsSince(callerInfo['start_time']))}`;
              if (callerInfo['answer_time']) durationStr += ` | Talk: ${formatDuration(secondsSince(callerInfo['answer_time']))}`;
            }
            log.info('[%s] 📴 %s: Hangup with %s (channel %s)%s', ts, callerExt, num, chType || callerExt, durationStr);
          }

          if (isFinalHangup) {
            this.activeCalls.delete(callerExt);
          } else {
            delete callerInfo['destchannel'];
            // Still notify the agent who missed the call (e.g. a queue ring timeout).
            const notifExt = isExtNumber(ext) ? ext! : null;
            if (notifExt && notifExt !== callerExt) {
              const [notify, callerVal] = this.missedCallParty(notifExt, callerInfo, callerExt);
              if (notify && this.shouldNotifyMissedOrBusy(cause, callerInfo)) {
                this.notifyMissedCall(notifExt, callerVal, queue || callerInfo['queue'] || null, uniqueid, cause);
              }
            }
          }
        }
      }
    }

    // The extension's own call entry
    if (ext) {
      const extInfo = this.activeCalls.get(ext) ?? null;
      // Entries made by other events may lack the Linkedid the final-hangup sweep needs.
      if (extInfo && truthyObj(extInfo) && linkedid && !extInfo['linkedid']) extInfo['linkedid'] = linkedid;
      if (extInfo && truthyObj(extInfo)) {
        const stored = dget(extInfo, 'channel', 'NOT SET');
        if (stored !== ch) log.debug(`Channel mismatch for ${ext}: stored=${pyStr(stored)}, hangup=${ch}`);
      } else {
        log.debug(`No ext_info found for extension ${ext} in active_calls`);
      }
      const startedCall = !!uniqueid && uniqueid === linkedid;

      if (extInfo && truthyObj(extInfo) && (extInfo['channel'] ?? null) === ch) {
        if (isFinalHangup) {
          const crmKey = linkedid && uniqueid ? `${linkedid}:${uniqueid}` : null;
          if (crmKey && this.linkedidCrmSent.has(crmKey)) {
            log.info(`⏸️ CRM data already sent for ${crmKey} - skipping duplicate send for extension ${ext}`);
          } else {
            log.info(`📤 Hangup detected for extension ${ext}, attempting CRM send`);
            if (crmKey) this.linkedidCrmSent.add(crmKey);
            this.scheduleCallFinished(ext, extInfo, p, queue, 'extension');
            extensionPushed = extensionPushed || pushes(ext);
            const [notify, callerVal] = this.missedCallParty(ext, extInfo, '', startedCall);
            if (notify && this.shouldNotifyMissedOrBusy(cause, extInfo)) {
              this.notifyMissedCall(ext, callerVal, queue || extInfo['queue'] || null, uniqueid, cause);
            }
          }
        } else {
          log.info(`⏸️ Skipping CRM send for extension ${ext} - other channels still active (transfer in progress)`);
          const [notify, callerVal] = this.missedCallParty(ext, extInfo, '', startedCall);
          if (notify && this.shouldNotifyMissedOrBusy(cause, extInfo)) {
            this.notifyMissedCall(ext, callerVal, queue || extInfo['queue'] || null, uniqueid, cause);
          }
        }

        const caller = extInfo['caller'] || extInfo['callerid'] || this.chCallerid.get(ch) || '';
        const dialedExten = dget(extInfo, 'exten', '');
        const hasDestChannel = !!extInfo['destchannel'];
        if (this.monitored.has(ext)) {
          let durationStr = '';
          if ('start_time' in extInfo) {
            durationStr = ` | Duration: ${formatDuration(secondsSince(extInfo['start_time']))}`;
            if (extInfo['answer_time']) durationStr += ` | Talk: ${formatDuration(secondsSince(extInfo['answer_time']))}`;
          }
          if (meaningful(dialedExten) && dialedExten !== ext && !hasDestChannel) {
            log.info('[%s] 📴 %s: Hangup with %s (channel App)%s', ts, ext, dialedExten, durationStr);
          } else if (meaningful(caller) && caller !== ext) {
            log.info('[%s] 📴 %s: Hangup with %s (channel %s)%s', ts, ext, caller, chType || ext, durationStr);
          }
        }
        // Drop the entry only on the final hangup: while sibling legs live (a transfer, or
        // the agent hanging up before the trunk) the truly-final hangup still needs this
        // call's context for the push. Until then it is flagged ended, not shown.
        if (isFinalHangup) this.activeCalls.delete(ext);
        else this.markCallEnded(ext, extInfo);
      } else if (extInfo && truthyObj(extInfo) && (extInfo['destchannel'] ?? null) === ch) {
        delete extInfo['destchannel'];
      } else if (extInfo && truthyObj(extInfo)) {
        // Channel mismatch, but on the final hangup the entry still gets its push.
        if (isFinalHangup) {
          const crmKey = linkedid && uniqueid ? `${linkedid}:${uniqueid}` : null;
          if (crmKey && this.linkedidCrmSent.has(crmKey)) {
            log.info(`⏸️ CRM data already sent for ${crmKey} - skipping duplicate send for extension ${ext}`);
          } else {
            log.info(`📤 Final hangup detected for extension ${ext} (channel mismatch), attempting CRM send`);
            if (crmKey) this.linkedidCrmSent.add(crmKey);
            this.scheduleCallFinished(ext, extInfo, p, queue, 'extension');
            extensionPushed = extensionPushed || pushes(ext);
            const [notify, callerVal] = this.missedCallParty(ext, extInfo, '', startedCall);
            if (notify && this.shouldNotifyMissedOrBusy(cause, extInfo)) {
              this.notifyMissedCall(ext, callerVal, queue || extInfo['queue'] || null, uniqueid, cause);
            }
          }
        }
      }
    }

    // Any remaining channels of this extension (multiple channels per extension)
    if (ext) {
      for (const [chName, extName] of [...this.ch2ext]) {
        if (extName !== ext) continue;
        this.ch2ext.delete(chName);
        this.chCallerid.delete(chName);
        const chUid = this.ch2uniqueid.get(chName);
        this.ch2uniqueid.delete(chName);
        if (chUid && this.queueEntries.has(chUid)) {
          const entry = this.queueEntries.get(chUid)!;
          this.queueEntries.delete(chUid);
          this.recountWaiting(entry.queue || '');
        }
      }
    }
    this.chCallerid.delete(ch);
    if (ext) {
      for (const [chName, extName] of [...this.destch2ext]) if (extName === ext) this.destch2ext.delete(chName);
    }

    // Fallback: entries whose channel (or destination channel) is this one. Dropped only on
    // the final hangup; before that the entry keeps the call's context for the sweep below.
    for (const [extName, info] of [...this.activeCalls]) {
      if ((info['channel'] ?? null) === ch) {
        if (isFinalHangup) this.activeCalls.delete(extName);
        else this.markCallEnded(extName, info);
      } else if ((info['destchannel'] ?? null) === ch) {
        delete info['destchannel'];
      }
    }

    if (isFinalHangup && linkedid) this.sweepFinishedCall(linkedid, p, queue, extensionPushed);
  }

  /**
   * Final-hangup safety net (Linkedid sweep). The channel paths above push only when the final
   * channel resolves back to an extension's entry, but the last leg to leave a call is often
   * a trunk (the agent hung up first) or a queue-keyed leg, so the agent's entry would be
   * dropped with no outcome frame and no CRM push. Reap every entry still tagged with this
   * Linkedid (live or parked) and, when no path above pushed the call from an extension's
   * side, push it from each extension that was on it: once per call, so the callee leg of an
   * extension-to-extension call is covered by its caller's push, and a ring-all leg that was
   * cancelled unanswered (already on its own missed-call bell) is not a call of its own.
   */
  private sweepFinishedCall(linkedid: string, p: AmiMessage, queue: string | null, extensionPushed: boolean): void {
    const pending: Array<[string, CallInfo]> = [];
    const later: Array<[string, CallInfo]> = [];
    for (const [extName, info] of [...this.activeCalls]) {
      if ((info['linkedid'] ?? '') !== linkedid) continue;
      pending.push([extName, info]);
      // A channel-less entry (the queue caller's, keyed by their number) is what the pushes
      // read the queue wait and answer flags from: reap it once they have run.
      if (info['channel']) this.activeCalls.delete(extName);
      else later.push([extName, info]);
    }
    const parked = this.endedCalls.get(linkedid);
    this.endedCalls.delete(linkedid);
    if (parked) pending.push(...parked);

    if (!extensionPushed) {
      const owed = pending.filter(([extName, info]) =>
        // A crossRef placeholder never got a channel: it has no call to report.
        !!info['channel'] && isExtNumber(extName) && !this.queues.has(extName) && !(info['ended'] && !info['answer_time']),
      );
      const owedExts = new Set(owed.map(([extName]) => extName));
      for (const [extName, info] of owed) {
        const caller = pyStr(info['caller'] || '');
        if (caller !== extName && owedExts.has(caller)) continue;
        const crmKey = `${linkedid}:${pyStr(info['channel'])}`;
        if (this.linkedidCrmSent.has(crmKey)) continue;
        this.linkedidCrmSent.add(crmKey);
        log.info(`📤 Final hangup for Linkedid ${linkedid} - sending CRM for extension ${extName} (trunk/mismatched final leg)`);
        this.scheduleCallFinished(extName, info, p, queue, 'extension');
      }
    }
    // Queued after every push of this hangup (setImmediate runs in order).
    if (later.length) {
      setImmediate(() => {
        for (const [extName, info] of later) if (this.activeCalls.get(extName) === info) this.activeCalls.delete(extName);
      });
    }
  }

  evNewCallerid(p: AmiMessage, _ts: string): void {
    const ch = dget(p, 'Channel', '');
    const callerid = dget(p, 'CallerIDNum', '');
    const exten = dget(p, 'Exten', '');
    const ext = this.resolveExt(ch);

    if (meaningful(callerid)) this.chCallerid.set(ch, callerid);

    if (ext) {
      const info = this.callInfo(ext);
      if (meaningful(callerid)) info['callerid'] = callerid;
      // CallerID *name* for the CRM push (Asterisk often sends "<unknown>").
      const cidName = (p['CallerIDName'] || '').trim();
      if (cidName && cidName !== '<unknown>' && cidName !== 'unknown') info['callerid_name'] = cidName;
      if (meaningful(exten)) {
        info['exten'] = exten;
        if (!('original_destination' in info)) info['original_destination'] = exten;
      }
    }
  }

  /**
   * The party on the other end of a tracked channel changed: after a Redirect or a transfer
   * the extension stays put and only the far end changes, so the call's destination follows.
   * `destination` is a display field and always refreshed; `original_destination` is the
   * call's FIRST destination (the CRM push reads it), so it is only filled when missing.
   */
  evNewConnectedLine(p: AmiMessage, _ts: string): void {
    const ch = dget(p, 'Channel', '');
    const conn = dget(p, 'ConnectedLineNum', '');
    const ext = this.resolveExt(ch);
    if (!ext || conn === ext || !meaningful(conn)) return;
    const info = this.activeCalls.get(ext);
    if (info === undefined || info['ended']) return;
    info['destination'] = conn;
    if (!('original_destination' in info)) info['original_destination'] = conn;
  }

  evDial(p: AmiMessage, _ts: string): void {
    const ch = dget(p, 'Channel', '');
    const ext = this.resolveExt(ch);
    if (ext) {
      const info = this.callInfo(ext);
      info['destination'] = dget(p, 'Destination', '');
      info['dialstatus'] = dget(p, 'DialStatus', '');
      const dialed = dget(p, 'DialString', dget(p, 'Dialstring', '')) || dget(p, 'DestExten', '');
      if (meaningful(dialed)) {
        if (!('original_destination' in info)) info['original_destination'] = dialed;
        info['exten'] = dialed;
      }
    }
  }

  evDialBegin(p: AmiMessage, _ts: string): void {
    const ch = dget(p, 'Channel', '');
    const ext = this.resolveExt(ch);
    if (!ext) return;

    const destexten = dget(p, 'DestExten', '');
    const dialstring = dget(p, 'DialString', '');
    const destch = dget(p, 'DestChannel', '');
    this.learnTech(destch);

    const info = this.callInfo(ext);
    info['channel'] = ch;
    if (!('state' in info)) info['state'] = 'Dialing';
    info['destchannel'] = destch;
    this.ch2ext.set(ch, ext);

    if (!('start_time' in info)) {
      info['start_time'] = new Date();
      info['answer_time'] = null;
    }

    // Resolve the actual dialed number
    let dialed: string | null = null;
    if (meaningful(destexten)) {
      dialed = destexten;
    } else if (dialstring) {
      const candidate = dialstring.split('@', 1)[0].split('/', 1)[0].trim();
      if (meaningful(candidate)) dialed = candidate;
    }
    // The party dialling: an inbound trunk leg is keyed by the DID it came in on, but the
    // callee's caller is the outside number on that leg.
    const callerNum: string = !isExtNumber(ext) && meaningful(info['caller']) && info['caller'] !== ext ? info['caller'] : ext;
    if (dialed) {
      info['exten'] = dialed;
      if (!('original_destination' in info)) info['original_destination'] = dialed;
      if (dialed !== ext) this.crossRef(callerNum, dialed, dget(p, 'Linkedid', ''));
    }

    // Track the destination extension's channel (internal extensions only)
    const destExt = destch ? extFromChannel(destch) : null;
    if (destExt && !DIALPLAN_CTX.has(destExt)) {
      const destInfo = this.callInfo(destExt);
      destInfo['channel'] = destch;
      if (!('state' in destInfo)) destInfo['state'] = 'Ringing';
      destInfo['caller'] = callerNum;
      this.ch2ext.set(destch, destExt);

      // Wake a mobile softphone registered to this extension (VoIP push), once per dial leg.
      if (this.incomingCallCallback && this.monitored.has(destExt) && !destInfo['_wake_pushed']) {
        destInfo['_wake_pushed'] = true;
        const caller = p['CallerIDNum'] || ext || '';
        const display = p['CallerIDName'] || caller;
        const callId = p['DestUniqueid'] || p['Uniqueid'] || p['Linkedid'] || '';
        try {
          const r = this.incomingCallCallback(destExt, caller, callId, display);
          if (r instanceof Promise) r.catch((e) => log.debug('incoming_call_callback error: %s', e));
        } catch (e) {
          log.debug('incoming_call_callback error: %s', e);
        }
      }
    }

    if (destch) this.destch2ext.set(destch, ext);
  }

  evDialEnd(p: AmiMessage, _ts: string): void {
    const ch = dget(p, 'Channel', '');
    const ext = this.resolveExt(ch);
    const destexten = dget(p, 'DestExten', '');
    const destch = dget(p, 'DestChannel', '');
    const dialstatus = dget(p, 'DialStatus', '');

    // Recording outcome: an ANSWER means the recording holds a conversation; a terminal
    // non-answer means it is ring-only and can go at hangup.
    const rec = this.vadPending.get(dget(p, 'Uniqueid', ''));
    if (rec !== undefined) {
      const st = (dialstatus || '').toUpperCase();
      if (st === 'ANSWER') {
        if (rec.answer === null) rec.answer = monotonic();
      } else if (['BUSY', 'NOANSWER', 'CANCEL', 'CONGESTION', 'CHANUNAVAIL'].includes(st)) {
        rec.nonanswer = true;
      }
    }

    if (ext) {
      const info = this.activeCalls.get(ext);
      if (info && truthyObj(info)) {
        // ANSWER always wins; never let a later CANCEL overwrite it.
        const current = pyStr(dget(info, 'dialstatus', '')).toUpperCase();
        const next = dialstatus ? dialstatus.toUpperCase() : '';
        if (next === 'ANSWER' || current !== 'ANSWER') info['dialstatus'] = dialstatus;
        if (meaningful(destexten)) {
          if (!('original_destination' in info)) info['original_destination'] = destexten;
          info['exten'] = destexten;
        }
      }
    }

    let destExt = destch ? extFromChannel(destch) : null;
    if (!destExt && meaningful(destexten) && isdigit(destexten) && destexten.length <= 5) destExt = destexten;
    if (destExt) {
      const destInfo = this.activeCalls.get(destExt);
      // An ended entry's channel is gone: a late DialEnd must not map it back to life.
      if (destInfo && truthyObj(destInfo) && !destInfo['ended']) {
        if (destch) {
          destInfo['channel'] = destch;
          this.ch2ext.set(destch, destExt);
        }
        if (!('caller' in destInfo) && ext) destInfo['caller'] = ext;
        const current = pyStr(dget(destInfo, 'dialstatus', '')).toUpperCase();
        const next = dialstatus ? dialstatus.toUpperCase() : '';
        if (next === 'ANSWER' || current !== 'ANSWER') destInfo['dialstatus'] = dialstatus;
      }
    }
  }

  /** Asterisk 11 `Bridge` event (Asterisk 12+ never sends it; kept for parity). */
  evBridge(p: AmiMessage, _ts: string): void {
    const ch1 = dget(p, 'Channel1', '');
    const ch2 = dget(p, 'Channel2', '');
    const ext1 = ch1 ? this.resolveExt(ch1) : null;
    const ext2 = ch2 ? this.resolveExt(ch2) : null;
    const bridgeLinkedid = p['Linkedid'] || this.ch2linkedid.get(ch1) || this.ch2linkedid.get(ch2) || '';

    if (bridgeLinkedid) {
      for (const c of [ch1, ch2]) {
        if (!c) continue;
        const old = this.ch2linkedid.get(c);
        if (old && old !== bridgeLinkedid) {
          const g = this.linkedid2channels.get(old);
          if (g) {
            g.delete(c);
            if (!g.size) this.linkedid2channels.delete(old);
          }
        }
        this.ch2linkedid.set(c, bridgeLinkedid);
      }
      let set = this.linkedid2channels.get(bridgeLinkedid);
      if (!set) {
        set = new Set();
        this.linkedid2channels.set(bridgeLinkedid, set);
      }
      set.add(ch1);
      set.add(ch2);
    }

    const cid = (c: string, e: string | null) => {
      if (e && this.activeCalls.has(e)) return dget(this.activeCalls.get(e)!, 'callerid', this.chCallerid.get(c) || '');
      return this.chCallerid.get(c) || '';
    };
    const cid1 = cid(ch1, ext1);
    const cid2 = cid(ch2, ext2);
    const info1 = ext1 ? this.callInfo(ext1) : null;
    const info2 = ext2 ? this.callInfo(ext2) : null;
    if (info1) {
      info1['destination'] = cid2 && cid2 !== ext1 ? cid2 : ext2 || '';
      if (info2 && 'queue' in info2 && !('queue' in info1)) info1['queue'] = info2['queue'];
    }
    if (info2) {
      info2['destination'] = cid1 && cid1 !== ext2 ? cid1 : ext1 || '';
      if (info1 && 'queue' in info1 && !('queue' in info2)) info2['queue'] = info1['queue'];
    }
  }

  evNewstate(p: AmiMessage, ts: string): void {
    const ch = dget(p, 'Channel', '');
    const ext = this.resolveExt(ch);
    const state = p['ChannelStateDesc'] || dget(p, 'ChannelState', '');

    if (ext) {
      const info = this.callInfo(ext);
      info['state'] = state;
      if (state === 'Up' && 'answer_time' in info && info['answer_time'] === null) info['answer_time'] = new Date();
      if (!('start_time' in info)) {
        info['start_time'] = new Date();
        info['answer_time'] = null;
      }
      if (state === 'Up' && RE_DEVICE_CHANNEL.test(ch)) this.answeredCh.set(ch, ext);
    }

    const callerExt = this.destch2ext.get(ch) ?? null;
    if (callerExt) {
      const callerInfo = this.activeCalls.get(callerExt);
      if (callerInfo) callerInfo['dest_state'] = state;
    }

    if (callerExt && this.monitored.has(callerExt)) {
      const info = this.activeCalls.get(callerExt);
      if (info) {
        const num = this.displayNumber(info, callerExt);
        if (num !== 'Unknown') {
          const chType = this.getChannelType(ch) || callerExt;
          if (state === 'Ringing') log.info('[%s] 🔔 %s: Ringing %s (channel %s)', ts, callerExt, num, chType);
          else if (state === 'Up') log.info('[%s] 📞 %s: In call with %s (channel %s)', ts, callerExt, num, chType);
        }
      }
    }

    if (ext && this.monitored.has(ext)) {
      const info = this.activeCalls.get(ext);
      if (info) {
        const caller = info['caller'] || info['callerid'] || this.chCallerid.get(ch) || '';
        const dialedExten = dget(info, 'exten', '');
        if (state === 'Ringing' && meaningful(caller) && caller !== ext) {
          log.info('[%s] 📳 %s: Incoming from %s (channel %s)', ts, ext, caller, this.getChannelType(ch) || ext);
        } else if (state === 'Up') {
          const hasDestChannel = !!info['destchannel'];
          if (meaningful(dialedExten) && dialedExten !== ext && !hasDestChannel) {
            log.info('[%s] 📞 %s: In call with %s (channel App)', ts, ext, dialedExten);
          } else if (meaningful(caller) && caller !== ext && !this.destch2ext.has(ch)) {
            log.info('[%s] 📞 %s: In call with %s (channel %s)', ts, ext, caller, this.getChannelType(ch) || ext);
          }
        }
      }
    }
  }

  evVarSet(p: AmiMessage, _ts: string): void {
    const ch = dget(p, 'Channel', '');
    const variable = dget(p, 'Variable', '');
    const val = dget(p, 'Value', '');
    if (!DIALED_VARS.has(variable.toUpperCase())) return;
    const ext = this.resolveExt(ch);
    if (ext && val && val !== ext && meaningful(val)) {
      const info = this.callInfo(ext);
      if (!info['original_destination']) {
        info['original_destination'] = val;
        info['exten'] = val;
      }
    }
  }

  // ------------------------------------------------------------------
  // Queue event handlers
  // ------------------------------------------------------------------
  private queueInfo(queue: string): QueueInfo {
    let q = this.queues.get(queue);
    if (q === undefined) {
      q = { members: {}, calls_waiting: 0 };
      this.queues.set(queue, q);
    }
    return q;
  }

  /**
   * The pause reason an event carries: `PausedReason` (Asterisk 13+, documented on every
   * QueueMember* event) else the legacy `Reason`. undefined when the event has neither
   * header (so the caller keeps what it knew), '' when it says "no reason".
   */
  static eventPauseReason(p: AmiMessage): string | undefined {
    if (Object.prototype.hasOwnProperty.call(p, 'PausedReason')) return (p['PausedReason'] || '').trim();
    if (Object.prototype.hasOwnProperty.call(p, 'Reason')) return (p['Reason'] || '').trim();
    return undefined;
  }

  private applyPauseReason(member: QueueMember, paused: boolean, reason: string | undefined, previous?: string): void {
    if (!paused) {
      delete member.pause_reason;
      return;
    }
    const r = reason !== undefined ? reason : previous;
    if (r) member.pause_reason = r;
    else delete member.pause_reason;
  }

  /** QueueMemberStatus: device-state change of a member. Keeps the pause reason. */
  evQueueMemberStatus(p: AmiMessage, _ts: string): void {
    const queue = dget(p, 'Queue', '');
    const member = dget(p, 'Interface', '') || dget(p, 'Location', '');
    const membername = dget(p, 'MemberName', member);
    const status = queueMemberStatus(dget(p, 'Status', ''));
    const paused = dget(p, 'Paused', '0') === '1';
    if (!queue || !member) return;
    this.learnTech(member);
    const memberKey = `${queue}:${member}`;
    const prev = this.queueMembers.get(memberKey);
    // Membership header (Asterisk 12+) is authoritative when present.
    const membership = (p['Membership'] || '').toLowerCase();
    if (membership === 'dynamic') this.dynamicMembers.add(memberKey);
    else if (membership === 'static' || membership === 'realtime') this.dynamicMembers.delete(memberKey);
    const isDynamic = this.dynamicMembers.has(memberKey);
    const next: QueueMember = {
      queue,
      interface: member,
      membername,
      status,
      paused,
      dynamic: isDynamic,
      last_update: new Date(),
    };
    this.applyPauseReason(next, paused, AMIExtensionsMonitor.eventPauseReason(p), prev?.pause_reason);
    this.queueMembers.set(memberKey, next);
    this.queueInfo(queue).members[member] = { status, paused, membername, dynamic: isDynamic };
  }

  evQueueMemberAdded(p: AmiMessage, ts: string): void {
    const queue = dget(p, 'Queue', '');
    const member = dget(p, 'Interface', '') || dget(p, 'Location', '');
    const membername = dget(p, 'MemberName', member);
    const paused = dget(p, 'Paused', '0') === '1';
    if (!queue || !member) return;
    this.learnTech(member);
    const memberKey = `${queue}:${member}`;
    // Only fired for members added at runtime (AMI/CLI/feature code): dynamic.
    this.dynamicMembers.add(memberKey);
    const status = p['Status'] ? queueMemberStatus(p['Status']) : 'Not in use';
    const next: QueueMember = {
      queue,
      interface: member,
      membername,
      status,
      paused,
      dynamic: true,
      last_update: new Date(),
    };
    this.applyPauseReason(next, paused, AMIExtensionsMonitor.eventPauseReason(p));
    this.queueMembers.set(memberKey, next);
    this.queueInfo(queue).members[member] = { status, paused, membername, dynamic: true };
    if (this.monitored.has(queue) || this.monitored.has(member)) {
      log.info('[%s] ➕ Queue %s: Member %s (%s) added', ts, queue, membername, member);
    }
  }

  evQueueMemberRemoved(p: AmiMessage, ts: string): void {
    const queue = dget(p, 'Queue', '');
    const member = dget(p, 'Interface', '') || dget(p, 'Location', '');
    if (!queue || !member) return;
    const memberKey = `${queue}:${member}`;
    this.queueMembers.delete(memberKey);
    this.dynamicMembers.delete(memberKey);
    const q = this.queues.get(queue);
    if (q && Object.prototype.hasOwnProperty.call(q.members, member)) delete q.members[member];
    if (this.monitored.has(queue) || this.monitored.has(member)) {
      log.info('[%s] ➖ Queue %s: Member %s removed', ts, queue, member);
    }
  }

  /** QueueMemberPause (Asterisk 12+), QueueMemberPaused (11) and QueueMemberUnpause. */
  evQueueMemberPause(p: AmiMessage, ts: string): void {
    const queue = dget(p, 'Queue', '');
    const member = dget(p, 'Interface', '') || dget(p, 'Location', '');
    const paused = dget(p, 'Paused', '0') === '1';
    const reason = AMIExtensionsMonitor.eventPauseReason(p);
    if (!queue || !member) return;
    const memberKey = `${queue}:${member}`;
    const qm = this.queueMembers.get(memberKey);
    if (qm !== undefined) {
      qm.paused = paused;
      this.applyPauseReason(qm, paused, reason, qm.pause_reason);
      qm.last_update = new Date();
    }
    const q = this.queues.get(queue);
    if (q && Object.prototype.hasOwnProperty.call(q.members, member)) q.members[member].paused = paused;
    if (this.monitored.has(queue) || this.monitored.has(member)) {
      log.info('[%s] ⏸️  Queue %s: Member %s %s%s', ts, queue, member, paused ? 'paused' : 'unpaused', reason ? ` (${reason})` : '');
    }
  }

  evQueueMemberPaused(p: AmiMessage, ts: string): void {
    this.evQueueMemberPause(p, ts);
  }

  evQueueMemberUnpause(p: AmiMessage, ts: string): void {
    this.evQueueMemberPause(p, ts);
  }

  /** QueueEntry / QueueCallerJoin: a caller is waiting. */
  private queueCallerArrived(p: AmiMessage, ts: string, keepStartTime: boolean, verb: string): void {
    const queue = dget(p, 'Queue', '');
    const uniqueid = dget(p, 'Uniqueid', '');
    const callerid = dget(p, 'CallerIDNum', dget(p, 'CallerID', 'Unknown'));
    const position = dget(p, 'Position', '0');
    const channel = dget(p, 'Channel', '');
    const linkedid = dget(p, 'Linkedid', '');
    if (!queue || !uniqueid) return;

    this.queueEntries.set(uniqueid, {
      queue,
      callerid,
      position: isdigit(position) ? Number(position) : 0,
      entry_time: new Date(),
    });
    if (channel) this.ch2uniqueid.set(channel, uniqueid);

    // Mark the caller's call as waiting: no CRM push until the caller hangs up or an agent answers.
    if (channel) {
      const callerExt = this.ch2ext.get(channel) || null;
      if (callerExt) {
        const callInfo = this.activeCalls.get(callerExt);
        if (callInfo && truthyObj(callInfo)) {
          callInfo['queue'] = queue;
          callInfo['queue_waiting'] = true;
          callInfo['queue_caller_channel'] = channel;
        }
      }
    }
    if (meaningful(callerid) && callerid !== 'Unknown') {
      const callerInfo = this.callInfo(callerid);
      callerInfo['queue'] = queue;
      callerInfo['queue_waiting'] = true;
      callerInfo['queue_caller_channel'] = channel;
      callerInfo['callerid'] = callerid;
      if (!keepStartTime || !('start_time' in callerInfo)) callerInfo['start_time'] = new Date();
      if (linkedid) callerInfo['linkedid'] = linkedid;
    }
    this.queueInfo(queue);
    this.recountWaiting(queue);
    if (this.monitored.has(queue)) {
      log.info(`[%s] 📥 Queue %s: Caller %s ${verb} (position %s)`, ts, queue, callerid, position);
    }
  }

  evQueueEntry(p: AmiMessage, ts: string): void {
    this.queueCallerArrived(p, ts, true, 'entered');
  }

  evQueueCallerJoin(p: AmiMessage, ts: string): void {
    this.queueCallerArrived(p, ts, false, 'joined');
  }

  evQueueCallerLeave(p: AmiMessage, ts: string): void {
    let queue = dget(p, 'Queue', '');
    const uniqueid = dget(p, 'Uniqueid', '');
    const callerid = dget(p, 'CallerIDNum', dget(p, 'CallerID', 'Unknown'));
    const entry = this.queueEntries.get(uniqueid);
    if (entry) {
      this.queueEntries.delete(uniqueid);
      queue = entry.queue || queue;
      this.recountWaiting(queue);
      if (this.monitored.has(queue)) log.info('[%s] 📤 Queue %s: Caller %s left', ts, queue, callerid);
    }
  }

  /** The agent extension behind an Agent* event (member interface, else the agent channel). */
  private agentExtOf(member: string, channel: string): string | null {
    const fromIface = member && member.includes('/') ? extFromInterface(member) : '';
    if (fromIface && isdigit(fromIface)) return fromIface;
    return channel ? extFromChannel(channel) : null;
  }

  evAgentCalled(p: AmiMessage, _ts: string): void {
    const queue = dget(p, 'Queue', '');
    const agentChannel = dget(p, 'DestChannel', dget(p, 'AgentChannel', ''));
    const agentMember = dget(p, 'Interface', '');
    const callerid = dget(p, 'CallerIDNum', dget(p, 'CallerID', ''));
    const linkedid = dget(p, 'Linkedid', '');

    const agentExt = this.agentExtOf(agentMember, agentChannel);
    if (!agentExt) return;
    const agentInfo = this.callInfo(agentExt);
    if (meaningful(callerid)) {
      agentInfo['caller'] = callerid;
      agentInfo['queue_caller'] = callerid;
    }
    if (queue) agentInfo['queue'] = queue;
    if (linkedid) agentInfo['linkedid'] = linkedid;
    // Propagate queue_waiting from the caller's entry so the agent's hangup can see it.
    if (meaningful(callerid)) {
      const callerInfo = this.activeCalls.get(callerid);
      if (callerInfo && truthyObj(callerInfo)) {
        agentInfo['queue_waiting'] = dget(callerInfo, 'queue_waiting', false);
        agentInfo['queue_caller_channel'] = dget(callerInfo, 'queue_caller_channel', '');
      }
    }
  }

  evAgentConnect(p: AmiMessage, ts: string): void {
    const queue = dget(p, 'Queue', '');
    const agentChannel = dget(p, 'MemberChannel', dget(p, 'DestChannel', dget(p, 'Channel', '')));
    const agentMember = dget(p, 'Interface', dget(p, 'Member', ''));
    const callerid = dget(p, 'CallerIDNum', dget(p, 'CallerID', ''));
    const linkedid = dget(p, 'Linkedid', '');

    const agentExt = this.agentExtOf(agentMember, agentChannel);
    if (agentExt) {
      const agentInfo = this.activeCalls.get(agentExt);
      if (agentInfo && truthyObj(agentInfo)) {
        agentInfo['dialstatus'] = 'ANSWER';
        agentInfo['queue_answered'] = true;
        agentInfo['queue_waiting'] = false;
        agentInfo['answered_agent'] = agentExt;
        if (meaningful(callerid)) {
          agentInfo['caller'] = callerid;
          agentInfo['queue_caller'] = callerid;
        }
        if (queue) agentInfo['queue'] = queue;
        if (linkedid) agentInfo['linkedid'] = linkedid;
        if ((agentInfo['answer_time'] ?? null) === null) agentInfo['answer_time'] = new Date();
      }
      log.info(`[${ts}] ✅ Queue ${queue}: Agent ${agentExt} connected to caller ${callerid}`);
    }

    // The external caller's entry (the CRM push may use it)
    if (meaningful(callerid)) {
      let callerInfo = this.activeCalls.get(callerid);
      if (!callerInfo || !truthyObj(callerInfo)) {
        callerInfo = this.callInfo(callerid);
        callerInfo['callerid'] = callerid;
      }
      callerInfo['dialstatus'] = 'ANSWER';
      callerInfo['queue_answered'] = true;
      callerInfo['queue_waiting'] = false;
      callerInfo['answered_agent'] = agentExt;
      callerInfo['destination'] = agentExt;
      if (queue) callerInfo['queue'] = queue;
      if (linkedid) callerInfo['linkedid'] = linkedid;
      log.info(`✅ Queue call answered: caller ${callerid}, agent ${agentExt}, queue_waiting=False`);
    }

    // Every entry on the same Linkedid is part of this answered call.
    if (linkedid) {
      for (const [ext, info] of this.activeCalls) {
        if ((info['linkedid'] ?? null) === linkedid || isExtNumber(ext)) {
          const chLinkedid = this.ch2linkedid.get(info['channel'] || '') || '';
          if (chLinkedid === linkedid) {
            if (meaningful(callerid)) {
              info['caller'] = callerid;
              info['queue_caller'] = callerid;
            }
            if (queue) info['queue'] = queue;
            info['dialstatus'] = 'ANSWER';
            info['queue_answered'] = true;
            info['queue_waiting'] = false;
            info['answered_agent'] = agentExt;
          }
        }
      }
    }
  }

  evAgentComplete(p: AmiMessage, ts: string): void {
    const queue = dget(p, 'Queue', '');
    const agentMember = dget(p, 'Interface', dget(p, 'Member', ''));
    const callerid = dget(p, 'CallerIDNum', dget(p, 'CallerID', ''));
    const talktime = dget(p, 'TalkTime', '0');
    const reason = dget(p, 'Reason', '');
    const agentExt = agentMember && agentMember.includes('/') ? extFromInterface(agentMember) : null;
    if (this.monitored.has(queue) || (agentExt && this.monitored.has(agentExt))) {
      log.info(`[${ts}] 📞 Queue ${queue}: Agent ${agentExt} completed call with ${callerid} (talk: ${talktime}s, reason: ${reason})`);
    }
  }

  // ------------------------------------------------------------------
  // Queue management
  // ------------------------------------------------------------------
  async getQueueStatus(queue: string): Promise<AmiMessage[] | null> {
    const msgs = await this.sendActionWithEvents('QueueStatus', { Queue: queue }, 'QueueStatusComplete');
    return msgs && msgs.length && /Success/i.test(msgs[0]['Response'] || '') ? msgs : null;
  }

  /** {queue: {Available, LoggedIn, Callers, HoldTime, TalkTime, LongestHoldTime}} */
  async getQueueSummary(): Promise<Record<string, Record<string, string>>> {
    const msgs = await this.sendActionWithEvents('QueueSummary', null, 'QueueSummaryComplete');
    if (!msgs || !msgs.length) {
      log.warning('QueueSummary: No response from AMI');
      return {};
    }
    if (!/Success/i.test(msgs[0]['Response'] || '')) {
      log.warning('QueueSummary: AMI returned error');
      return {};
    }
    const out: Record<string, Record<string, string>> = {};
    for (const m of msgs.slice(1)) {
      if (m['Event'] !== 'QueueSummary' || !m['Queue']) continue;
      const row: Record<string, string> = (out[m['Queue']] ??= {});
      for (const k of ['Available', 'LoggedIn', 'Callers', 'HoldTime', 'TalkTime', 'LongestHoldTime']) {
        if (k in m) row[k] = m[k];
      }
    }
    return out;
  }

  /** Add a member to a queue. Returns [success, message]. */
  async queueAdd(
    queue: string,
    iface: string,
    opts: { penalty?: number; membername?: string | null; paused?: boolean; reason?: string | null } = {},
  ): Promise<[boolean, string]> {
    const penalty = Number(opts.penalty ?? 0) || 0;
    const membername = opts.membername ?? null;
    const paused = !!opts.paused;
    const params: Record<string, string> = { Queue: queue, Interface: iface };
    if (penalty > 0) params['Penalty'] = String(penalty);
    if (membername) params['MemberName'] = membername;
    if (paused) params['Paused'] = '1';

    const resp = await this.sendAsync('QueueAdd', params);
    if (resp && resp.includes('Response: Success')) {
      const memberKey = `${queue}:${iface}`;
      this.dynamicMembers.add(memberKey);
      this.learnTech(iface);
      const member: QueueMember = {
        queue,
        interface: iface,
        membername: membername || iface,
        status: 'Not in use',
        paused,
        dynamic: true,
        last_update: new Date(),
      };
      if (paused && opts.reason) member.pause_reason = opts.reason;
      this.queueMembers.set(memberKey, member);
      this.queueInfo(queue).members[iface] = { status: 'Not in use', paused, membername: membername || iface, dynamic: true };
      const msg = `Added ${iface} to queue ${queue}`;
      log.info(`✅ ${msg}`);
      // QueueAdd carries no pause reason on every Asterisk version: set it with QueuePause.
      if (paused && opts.reason) await this.queuePause(queue, iface, { paused: true, reason: opts.reason });
      return [true, msg];
    }
    const err = dget(parse(resp || ''), 'Message', 'Unknown error');
    log.error(`❌ Failed to add ${iface} to ${queue}: ${err}`);
    return [false, err];
  }

  /** Remove a member from a queue. Returns [success, message]. */
  async queueRemove(queue: string, iface: string): Promise<[boolean, string]> {
    const memberKey = `${queue}:${iface}`;
    if (!this.queueMembers.has(memberKey)) {
      const msg = `Member ${iface} not found in queue ${queue}`;
      log.error(`❌ ${msg}`);
      return [false, msg];
    }
    const resp = await this.sendAsync('QueueRemove', { Queue: queue, Interface: iface });
    if (resp && resp.includes('Response: Success')) {
      this.queueMembers.delete(memberKey);
      this.dynamicMembers.delete(memberKey);
      const q = this.queues.get(queue);
      if (q && Object.prototype.hasOwnProperty.call(q.members, iface)) delete q.members[iface];
      const msg = `Removed ${iface} from queue ${queue}`;
      log.info(`✅ ${msg}`);
      return [true, msg];
    }
    let err = dget(parse(resp || ''), 'Message', 'Unknown error');
    if (err.toLowerCase().includes('not dynamic')) {
      const qm = this.queueMembers.get(memberKey);
      if (qm) qm.dynamic = false;
      const q = this.queues.get(queue);
      if (q && Object.prototype.hasOwnProperty.call(q.members, iface)) q.members[iface].dynamic = false;
      err = 'Member is statically configured in queues.conf and cannot be removed via AMI. Edit queues.conf and reload Asterisk to remove static members.';
    }
    log.error(`❌ Failed to remove ${iface} from ${queue}: ${err}`);
    return [false, err];
  }

  /** Pause or unpause a queue member. Unpausing clears the stored reason. */
  async queuePause(queue: string, iface: string, opts: { paused?: boolean; reason?: string | null } = {}): Promise<[boolean, string]> {
    const paused = opts.paused ?? true;
    const reason = opts.reason || '';
    const memberKey = `${queue}:${iface}`;
    const params: Record<string, string> = { Queue: queue, Interface: iface, Paused: paused ? '1' : '0' };
    if (reason) params['Reason'] = reason;

    const resp = await this.sendAsync('QueuePause', params);
    if (resp && resp.includes('Response: Success')) {
      const qm = this.queueMembers.get(memberKey);
      if (qm !== undefined) {
        qm.paused = paused;
        if (!paused) delete qm.pause_reason;
        else if (reason) qm.pause_reason = reason;
        qm.last_update = new Date();
      }
      const q = this.queues.get(queue);
      if (q && Object.prototype.hasOwnProperty.call(q.members, iface)) q.members[iface].paused = paused;
      const msg = `${iface} ${paused ? 'paused' : 'unpaused'} in queue ${queue}`;
      log.info(`✅ ${msg}`);
      return [true, msg];
    }
    const err = dget(parse(resp || ''), 'Message', 'Unknown error');
    log.error(`❌ Failed to ${paused ? 'pause' : 'unpause'} ${iface} in ${queue}: ${err}`);
    return [false, err];
  }

  async queueUnpause(queue: string, iface: string): Promise<[boolean, string]> {
    return this.queuePause(queue, iface, { paused: false });
  }

  /** Live member interfaces of extension `ext` in `queue`, any interface form. */
  memberInterfacesFor(ext: string, queue: string | null = null): QueueMember[] {
    const out: QueueMember[] = [];
    for (const m of this.queueMembers.values()) {
      if (queue !== null && m.queue !== queue) continue;
      if (interfaceMatchesExtension(m.interface, ext)) out.push(m);
    }
    return out;
  }

  /** Queues `ext` is actually a member of right now (any interface form), sorted. */
  liveQueuesFor(ext: string): string[] {
    return [...new Set(this.memberInterfacesFor(ext).map((m) => m.queue).filter(Boolean))].sort();
  }

  /** Populate queues / queue_members / queue_entries from QueueSummary + QueueStatus. */
  async syncQueueStatus(): Promise<void> {
    const summary = await this.getQueueSummary();

    // Prune queues the PBX no longer has (guarded: an empty read must not wipe everything).
    const names = Object.keys(summary);
    if (names.length) {
      const current = new Set(names);
      for (const q of [...this.queues.keys()]) if (!current.has(q)) this.queues.delete(q);
      for (const [k, m] of [...this.queueMembers]) {
        if (!current.has(m.queue)) {
          this.queueMembers.delete(k);
          this.dynamicMembers.delete(k);
        }
      }
    }

    // Repopulate waiting callers from scratch.
    const oldQueues = new Set([...this.queueEntries.values()].map((e) => e.queue).filter(Boolean));
    this.queueEntries.clear();
    for (const q of oldQueues) {
      const info = this.queues.get(q);
      if (info) info.calls_waiting = 0;
    }

    for (const [name, stats] of Object.entries(summary)) {
      this.queues.set(name, {
        members: {},
        calls_waiting: pyInt(dget(stats, 'Callers', '0')) ?? 0,
        available: pyInt(dget(stats, 'Available', '0')) ?? 0,
        logged_in: pyInt(dget(stats, 'LoggedIn', '0')) ?? 0,
        hold_time: dget(stats, 'HoldTime', '0'),
        talk_time: dget(stats, 'TalkTime', '0'),
      });
    }

    const seen = new Set<string>();
    for (const name of names) {
      const msgs = await this.getQueueStatus(name);
      if (!msgs) continue;
      for (const m of msgs.slice(1)) {
        if (m['Event'] === 'QueueMember' && m['Queue'] && m['Location']) {
          const item = AMIExtensionsMonitor.queueMemberItem(m);
          this.addQueueMember(item);
          seen.add(`${item.queue}:${item.interface}`);
        } else if (m['Event'] === 'QueueEntry' && m['Queue'] && m['Uniqueid']) {
          this.addQueueEntry({
            queue: m['Queue'],
            uniqueid: m['Uniqueid'],
            callerid: m['CallerIDNum'] || 'Unknown',
            position: isdigit(m['Position']) ? Number(m['Position']) : 0,
            wait: isdigit(m['Wait']) ? Number(m['Wait']) : 0,
          });
          if (m['Channel']) this.ch2uniqueid.set(m['Channel'], m['Uniqueid']);
        }
      }
    }
    // Members of synced queues that Asterisk no longer lists are gone.
    if (names.length) {
      const synced = new Set(names);
      for (const [k, m] of [...this.queueMembers]) {
        if (synced.has(m.queue) && !seen.has(k)) {
          this.queueMembers.delete(k);
          this.dynamicMembers.delete(k);
        }
      }
    }
    log.info(`Synced ${this.queues.size} queues, ${this.queueMembers.size} members, ${this.queueEntries.size} waiting callers`);
  }

  /** One QueueStatus `QueueMember` event -> the item addQueueMember takes. */
  static queueMemberItem(m: AmiMessage): Record<string, any> {
    const item: Record<string, any> = {
      queue: m['Queue'],
      interface: m['Location'],
      membername: m['Name'] ?? m['MemberName'] ?? m['Location'],
      status: m['Status'] ?? 'Unknown',
      paused: m['Paused'] === '1',
      membership: (m['Membership'] || '').toLowerCase(),
    };
    // Carries the Not-Ready code (or __WRAPUP) across a backend restart.
    const reason = AMIExtensionsMonitor.eventPauseReason(m);
    if (reason) item.pause_reason = reason;
    return item;
  }

  /** Add/refresh a queue member from sync data. */
  addQueueMember(item: Record<string, any>): void {
    const qName: string = item.queue;
    const iface: string = item.interface;
    const membername = dget(item, 'membername', iface);
    const statusRaw = pyStr(dget(item, 'status', 'Unknown'));
    const status = isdigit(statusRaw) ? queueMemberStatus(statusRaw) : statusRaw;
    const paused = !!dget(item, 'paused', false);
    const membership = pyStr(dget(item, 'membership', '')).toLowerCase();
    const memberKey = `${qName}:${iface}`;
    this.learnTech(iface);

    let isDynamic: boolean;
    if (membership === 'dynamic') {
      isDynamic = true;
      this.dynamicMembers.add(memberKey);
    } else if (membership === 'static' || membership === 'realtime') {
      isDynamic = false;
      this.dynamicMembers.delete(memberKey);
    } else {
      isDynamic = this.dynamicMembers.has(memberKey);
    }

    const member: QueueMember = { queue: qName, interface: iface, membername, status, paused, dynamic: isDynamic, last_update: new Date() };
    if (paused && item.pause_reason) member.pause_reason = item.pause_reason;
    this.queueMembers.set(memberKey, member);
    const q = this.queues.get(qName);
    if (q !== undefined) q.members[iface] = { membername, status, paused, dynamic: isDynamic };
  }

  /** Add a waiting caller from sync data. */
  addQueueEntry(item: Record<string, any>): void {
    const qName: string = item.queue;
    const wait = Number(dget(item, 'wait', 0)) || 0;
    this.queueEntries.set(item.uniqueid, {
      queue: qName,
      callerid: dget(item, 'callerid', 'Unknown'),
      position: dget(item, 'position', 0),
      entry_time: wait ? new Date(Date.now() - wait * 1000) : new Date(),
    });
    this.recountWaiting(qName);
  }

  /**
   * Make queue_entries match Asterisk's own list of waiting callers (diff-based, so
   * entry times survive). Catches what the Join/Leave/Hangup events missed (a reconnect
   * gap, a Leave that never came). null when the read failed.
   */
  async reconcileQueueEntries(): Promise<{ added: number; removed: number } | null> {
    const msgs = await this.sendActionWithEvents('QueueStatus', null, 'QueueStatusComplete');
    if (!msgs || !msgs.length || !/Success/i.test(msgs[0]['Response'] || '')) return null;
    const truth = new Map<string, AmiMessage>();
    for (const m of msgs.slice(1)) {
      if (m['Event'] === 'QueueEntry' && m['Queue'] && m['Uniqueid']) truth.set(m['Uniqueid'], m);
    }
    const removed = [...this.queueEntries.keys()].filter((uid) => !truth.has(uid));
    for (const uid of removed) this.queueEntries.delete(uid);
    let added = 0;
    for (const [uid, m] of truth) {
      const position = isdigit(m['Position']) ? Number(m['Position']) : 0;
      const existing = this.queueEntries.get(uid);
      if (existing) {
        existing.queue = m['Queue'];
        existing.position = position;
      } else {
        this.addQueueEntry({
          queue: m['Queue'],
          uniqueid: uid,
          callerid: m['CallerIDNum'] || 'Unknown',
          position,
          wait: isdigit(m['Wait']) ? Number(m['Wait']) : 0,
        });
        added += 1;
      }
      if (m['Channel']) this.ch2uniqueid.set(m['Channel'], uid);
    }
    for (const q of this.queues.keys()) this.recountWaiting(q);
    if (added || removed.length) {
      log.info(`queue entries reconciled with Asterisk: +${added} / -${removed.length} (now ${this.queueEntries.size} waiting)`);
    }
    return { added, removed: removed.length };
  }

  ensureQueueReconcile(): void {
    if (this.queueReconcileTimer) return;
    this.queueReconcileTimer = setInterval(() => {
      if (!this.connected || !this.running) return;
      this.reconcileQueueEntries().catch((e) => log.debug('queue reconcile: %s', errText(e)));
    }, QUEUE_RECONCILE_INTERVAL * 1000);
    this.queueReconcileTimer.unref();
  }

  stopQueueReconcile(): void {
    if (this.queueReconcileTimer) clearInterval(this.queueReconcileTimer);
    this.queueReconcileTimer = null;
  }

  /**
   * Effective member status: a Local/<ext>@... member has no device state of its own, so
   * it is derived from the extension's hint; any other interface keeps its reported status.
   */
  memberStatus(member: Partial<QueueMember> | Record<string, unknown>): string {
    const iface = pyStr(member['interface'] || '');
    const reported = pyStr(member['status'] || '');
    if (!iface.toLowerCase().startsWith('local/')) return reported;
    const ext = extFromInterface(iface);
    const extData = ext ? this.extensions.get(ext) : undefined;
    if (!extData) return reported;
    const code = pyStr(dget(extData, 'Status', ''));
    return Object.prototype.hasOwnProperty.call(EXT_STATUS_TO_MEMBER_STATUS, code) ? EXT_STATUS_TO_MEMBER_STATUS[code] : reported;
  }

  // ------------------------------------------------------------------
  // Call control: hangup / transfer / originate
  // ------------------------------------------------------------------
  /** Hang up the current call on the given extension. */
  async hangupCall(ext: string): Promise<boolean> {
    if (!this.connected) {
      log.error('❌ Not connected to AMI');
      return false;
    }
    await this.syncActiveCalls();
    const ch = await this.getActiveChannel(ext);
    if (!ch) {
      log.error(`❌ No active call on extension ${ext}`);
      return false;
    }
    const resp = await this.sendAsync('Hangup', { Channel: ch });
    if (resp && resp.includes('Response: Success')) {
      log.info(`📴 Hangup requested for extension ${ext} (channel ${ch})`);
      return true;
    }
    log.error(`❌ Hangup failed for ${ext}: ${dget(parse(resp || ''), 'Message', 'Unknown error')}`);
    return false;
  }

  /**
   * The channel to Redirect for a transfer source: an extension's own channel, or — when
   * the source is the "talking to" number — the other leg of the call that party is on.
   * `owner` (the extension whose call the source belongs to) limits that search to its call,
   * so the same outside number on another extension's call is never the one moved.
   */
  channelForTransferSource(source: string, owner: string | null = null): string | null {
    const s = (source || '').trim();
    if (!s) return null;
    const own = this.activeCalls.get(s)?.['channel'];
    if (own) return own;
    const cached = this.getActiveChannelSync(s);
    if (cached) return cached;
    for (const [ext, info] of this.activeCalls) {
      if (owner && ext !== owner) continue;
      const talkingTo = this.displayNumber(info, ext);
      if (!talkingTo || talkingTo === 'Unknown' || !sameNumber(s, talkingTo)) continue;
      const agentCh = info['channel'];
      if (!agentCh) continue;
      const linkedid = this.ch2linkedid.get(agentCh);
      if (!linkedid) continue;
      const peers = [...(this.linkedid2channels.get(linkedid) || [])].filter((c) => c !== agentCh);
      if (peers.length) return peers[0];
    }
    return null;
  }

  /** Channel lookup from the cache only (no AMI query). */
  getActiveChannelSync(ext: string): string | null {
    const info = this.activeCalls.get(ext);
    if (info && info['channel']) return info['channel'];
    for (const [ch, e] of this.ch2ext) if (e === ext) return ch;
    return null;
  }

  /**
   * Blind transfer the call on *ext* (an extension or the other party's number) via Redirect.
   * `owner`: the extension whose call a party number belongs to (see channelForTransferSource).
   */
  async transferCall(
    ext: string,
    destination: string,
    opts: { context?: string | null; priority?: string; owner?: string | null } = {},
  ): Promise<boolean> {
    if (!this.connected) {
      log.error('❌ Not connected to AMI');
      return false;
    }
    if (!destination) {
      log.error('❌ No destination provided for transfer');
      return false;
    }
    await this.syncActiveCalls();
    const ch = this.channelForTransferSource(ext, opts.owner ?? null);
    if (!ch) {
      log.error(`❌ No active call on extension/number ${ext}`);
      return false;
    }
    const ctx = opts.context || this.context || 'default';
    const resp = await this.sendAsync('Redirect', { Channel: ch, Exten: destination, Context: ctx, Priority: opts.priority || '1' });
    if (resp && resp.includes('Response: Success')) {
      log.info(`🔁 Transfer requested: ${ext} -> ${destination} in ${ctx} (channel ${ch})`);
      return true;
    }
    log.error(`❌ Transfer failed for ${ext} -> ${destination}: ${dget(parse(resp || ''), 'Message', 'Unknown error')}`);
    return false;
  }

  static normalizeDialNumber(raw: unknown): string | null {
    return normalizeDialNumber(raw);
  }

  normalizeDialNumber(raw: unknown): string | null {
    return normalizeDialNumber(raw);
  }

  /**
   * Ring `extension`; when it answers, dial `number` in `context`. Returns [ok, message]:
   * ok means Asterisk ACCEPTED the Originate (Async), not that the call connected — the
   * message is then the call's ChannelId, which the HTTP route returns as `action_id`.
   */
  async originateCall(
    extension: string,
    number: string,
    opts: { context?: string | null; timeoutMs?: number; callerId?: string | null } = {},
  ): Promise<[boolean, string]> {
    if (!this.connected) return [false, 'AMI not connected'];
    const num = normalizeDialNumber(number);
    if (!num) return [false, 'Invalid destination number'];
    const ext = String(extension ?? '').trim();
    if (!ext || !isdigit(ext)) return [false, 'Invalid extension'];
    // NOT self.context (ext-local resolves only local extensions): click-to-call needs
    // from-internal so outbound routes apply.
    const ctx = (opts.context || '').trim() || 'from-internal';
    const channelId = `c2c-${ext}-${Date.now()}`;
    const resp = await this.sendAsync('Originate', {
      Channel: this.deviceInterface(ext),
      Context: ctx,
      Exten: num,
      Priority: '1',
      CallerID: opts.callerId || `${ext} <${ext}>`,
      Timeout: String(Math.trunc(opts.timeoutMs ?? 30000)),
      Async: 'true',
      ChannelId: channelId,
    });
    if (resp && resp.includes('Response: Success')) {
      log.info('📞 Click-to-call: %s -> %s (context=%s, id=%s)', ext, num, ctx, channelId);
      return [true, channelId];
    }
    const msg = resp ? (parse(resp)['Message'] || '').trim() : '';
    log.warning('Click-to-call refused by Asterisk: %s -> %s: %s', ext, num, msg || resp);
    return [false, msg || 'Asterisk rejected the Originate'];
  }

  // ------------------------------------------------------------------
  // Supervisor: listen / whisper / barge
  // ------------------------------------------------------------------
  async chanspy(supervisor: string, target: string, options: string, label: string): Promise<boolean> {
    if (!this.connected) return false;
    await this.syncActiveCalls();
    const ch = await this.getActiveChannel(target);
    if (!ch) {
      log.error(`❌ No active call on extension ${target}`);
      return false;
    }
    // The monitored call's linkedid, captured before the spy leg exists (the spy channel
    // gets its own linkedid = its forced ChannelId), so the call log can attach it.
    const targetLinkedid = this.ch2linkedid.get(ch) || this.activeCalls.get(target)?.['linkedid'] || null;
    const spyId = `spy-${supervisor}-${target}-${Date.now()}`;
    const mode = label.toLowerCase();
    // ChanSpy matches a channel-name PREFIX: `PJSIP/101` would also spy on PJSIP/1010-….
    // The full channel name (PJSIP/101-0000002a) names this call's leg and nothing else.
    const resp = await this.sendAsync('Originate', {
      Channel: this.deviceInterface(supervisor),
      ChannelId: spyId,
      Application: 'ChanSpy',
      Data: `${ch},${options}`,
      CallerID: `${label} <${target}>`,
      Timeout: '30000',
    });
    if (resp && resp.includes('Response: Success')) {
      log.info(`✅ ${supervisor} is now ${mode}ing ${target}'s call`);
      try {
        await dbm.recordSupervision(spyId, {
          targetLinkedid,
          targetExtension: target,
          supervisorExtension: supervisor,
          mode,
          spyUniqueid: spyId,
        });
      } catch (e) {
        log.warning(`⚠️  Could not record supervision (${spyId}): ${errText(e)}`);
      }
      return true;
    }
    log.error(`❌ ${label} failed: ${dget(parse(resp || ''), 'Message', 'Unknown error')}`);
    return false;
  }

  listenToCall(supervisor: string, target: string): Promise<boolean> {
    return this.chanspy(supervisor, target, 'qsE', 'Listen');
  }

  async whisperToCall(supervisor: string, target: string): Promise<boolean> {
    const ok = await this.chanspy(supervisor, target, 'qwsE', 'Whisper');
    if (ok) log.info('   (Agent hears you; caller does not)');
    return ok;
  }

  async bargeIntoCall(supervisor: string, target: string): Promise<boolean> {
    const ok = await this.chanspy(supervisor, target, 'qBsE', 'Barge');
    if (ok) log.info('   (Both parties can hear you)');
    return ok;
  }
}

// ---------------------------------------------------------------------------
// Startup summary
// ---------------------------------------------------------------------------
export function logStartupSummary(monitor: AMIExtensionsMonitor): void {
  let members = 0;
  let waiting = 0;
  for (const q of monitor.queues.values()) {
    members += Object.keys(q.members || {}).length;
    waiting += q.calls_waiting || 0;
  }
  log.info('='.repeat(60));
  log.info('📊 AMI startup summary');
  log.info(`   Extensions: ${monitor.monitored.size} monitored`);
  log.info(`   Active Calls: ${monitor.activeCalls.size}`);
  log.info(`   Queues: ${monitor.queues.size} (Members: ${members}, Waiting: ${waiting})`);
  log.info(`   DND: ${monitor.dnd.size} extension(s)`);
  log.info('='.repeat(60));
  log.info('✅ Now tracking realtime AMI events → frontend via WebSocket');
}
