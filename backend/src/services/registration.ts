/**
 * Extension reachability: is the device registered, or — asleep — can push still wake it?
 *
 * Reachability is what starts and stops an extension's AVAILABILITY (agent-state): there
 * is no manual "Offline"; a phone that registers is Available, one that goes away is not.
 *
 *   * Registered comes from the ENDPOINT's own device state (PJSIP/100, SIP/100):
 *     DeviceStateChange events, synced at startup by DeviceStateList + PJSIPShowEndpoints.
 *     UNAVAILABLE / INVALID = not registered. NOT the extension hint: on FreePBX the hint
 *     is "PJSIP/100&Custom:DND100", and DND sets Custom:DND100 BUSY, so an unregistered
 *     phone on DND reads Busy there (found in a live test). The hint is only a fallback
 *     for a device whose state was never reported, and a Busy hint with DND on does not
 *     count in it.
 *   * Not registered but push-wakeable (Mobile Wake on, an RFC 8599 binding or a legacy
 *     app token: sip-push canWakeExtension) = still reachable, via 'push'. A mobile
 *     softphone sleeps and unregisters all day; it is not offline, it is asleep.
 *
 * Each reachable stretch is one extension_registration row (the Registered column of the
 * adherence report). Changes are pushed to agentState.onReachability().
 *
 * A periodic sweep re-evaluates everyone (push bindings change without a hint event,
 * monitored extensions come and go) and reconciles DND set by a feature code (*78 / *79
 * writes AstDB directly; no AMI event says so).
 */

import { getLogger, pyStr } from '../core/logger';
import { AsyncLock } from '../core/py';
import * as dbm from '../db/db-manager';
import type { Row } from '../db/pool';
import type { AMIExtensionsMonitor } from './ami';
import * as sipPush from './sip-push';

const log = getLogger('services.registration');

export type ReachVia = 'sip' | 'push';

/** Hint status codes that mean the device is not registered. */
export const UNREGISTERED_CODES: ReadonlySet<string> = new Set(['4', '-1']);

/** Endpoint device states that mean nothing is registered (normalised: upper, no spaces). */
export const UNREGISTERED_DEVICE_STATES: ReadonlySet<string> = new Set(['UNAVAILABLE', 'INVALID']);

/** A bare endpoint device name: PJSIP/100, SIP/100 (not a channel, not Custom:...). */
const RE_ENDPOINT_DEVICE = /^(PJSIP|SIP|IAX2)\/(\d+)$/i;

/** 'Not in use' / 'NOT_INUSE' / 'Unavailable' -> 'NOT_INUSE' / 'UNAVAILABLE'. */
export function normDeviceState(v: unknown): string {
  return pyStr(v).trim().toUpperCase().replace(/[\s_]+/g, '_').replace(/^NOT_IN_USE$/, 'NOT_INUSE');
}

/** How often everyone is re-evaluated (and DND reconciled), seconds. */
export const SWEEP_SECS = 30;

/** What agent-state needs from a reachability source. */
export interface ReachabilityListener {
  onReachability(ext: string, via: ReachVia | null, source?: string): Promise<void>;
  reconcileDnd?(): Promise<void>;
}

function evGet(p: Row, k: string): string {
  return Object.prototype.hasOwnProperty.call(p, k) ? pyStr(p[k]) : '';
}

/** The extension a ContactStatus event is about: EndpointName, else the AOR. */
function contactExt(p: Row): string {
  const ep = evGet(p, 'EndpointName') || evGet(p, 'AOR');
  return ep.trim();
}

export class RegistrationTracker {
  monitor: AMIExtensionsMonitor;
  listener: ReachabilityListener | null = null;
  /** ext -> how it is reachable now; absent = unreachable. */
  reach: Map<string, ReachVia> = new Map();
  /** ext -> its endpoint's device state (normalised), from AMI. */
  deviceStates: Map<string, string> = new Map();
  /** Push-wake check, injectable for tests. */
  canWake: (ext: string) => Promise<boolean> = (ext) => sipPush.canWakeExtension(ext);
  private lock = new AsyncLock();
  private timer: NodeJS.Timeout | null = null;

  constructor(monitor: AMIExtensionsMonitor) {
    this.monitor = monitor;
    this.handleAmiEvent = this.handleAmiEvent.bind(this);
  }

  /**
   * Is the phone registered? The endpoint device state when Asterisk has reported one;
   * else the hint, where a Busy with DND on is DND's Custom: device, not the phone.
   */
  registered(ext: string): boolean {
    const dev = this.deviceStates.get(ext);
    if (dev && dev !== 'UNKNOWN') return !UNREGISTERED_DEVICE_STATES.has(dev);
    const st = this.monitor.extensions.get(ext);
    if (!st || !Object.prototype.hasOwnProperty.call(st, 'Status')) return false;
    const code = pyStr(st['Status']).trim();
    if (UNREGISTERED_CODES.has(code)) return false;
    if (code === '2' && this.monitor.dnd.has(ext)) return false;
    return true;
  }

  /** Back-compat name. */
  hintRegistered(ext: string): boolean {
    return this.registered(ext);
  }

  /** Learn endpoint device states: DeviceStateList, then PJSIPShowEndpoints for the rest. */
  async syncDeviceStates(): Promise<void> {
    try {
      for (const m of (await this.monitor.sendActionWithEvents('DeviceStateList', null, 'DeviceStateListComplete')) ?? []) {
        const hit = RE_ENDPOINT_DEVICE.exec(pyStr(m['Device'] ?? ''));
        if (hit && m['State']) this.deviceStates.set(hit[2], normDeviceState(m['State']));
      }
    } catch (e) {
      log.warning('DeviceStateList: %s', e);
    }
    try {
      for (const m of (await this.monitor.sendActionWithEvents('PJSIPShowEndpoints', null, 'EndpointListComplete')) ?? []) {
        const ext = pyStr(m['ObjectName'] ?? '').trim();
        if (ext && m['DeviceState'] && !this.deviceStates.has(ext)) this.deviceStates.set(ext, normDeviceState(m['DeviceState']));
      }
    } catch (e) {
      log.warning('PJSIPShowEndpoints: %s', e);
    }
  }

  /** How `ext` is reachable right now, or null. */
  async compute(ext: string): Promise<ReachVia | null> {
    if (this.registered(ext)) return 'sip';
    if (await this.canWake(ext)) return 'push';
    return null;
  }

  viaOf(ext: string): ReachVia | null {
    return this.reach.get(String(ext).trim()) ?? null;
  }

  isReachable(ext: string): boolean {
    return this.reach.has(String(ext).trim());
  }

  /**
   * Startup: close rows a previous process left open (downtime is not counted), then open
   * one per extension reachable now. No listener calls: agent-state hydrates from reach.
   */
  async hydrate(): Promise<void> {
    await this.syncDeviceStates();
    await dbm.registrationCloseAllOpen();
    this.reach.clear();
    for (const ext of [...this.monitor.monitored]) {
      const via = await this.compute(ext);
      if (!via) continue;
      this.reach.set(ext, via);
      await dbm.registrationOpen(ext, via, 'system');
    }
    log.info('Reachability hydrated: %d of %d extension(s) reachable', this.reach.size, this.monitor.monitored.size);
  }

  /** Re-evaluate one extension; records and announces a change. */
  async reevaluate(ext: string, source = 'ami'): Promise<void> {
    const e = String(ext).trim();
    if (!e) return;
    await this.lock.run(async () => {
      const prev = this.reach.get(e) ?? null;
      const via = this.monitor.monitored.has(e) ? await this.compute(e) : null;
      if (prev === via) return;
      if (prev) await dbm.registrationClose(e);
      if (via) {
        await dbm.registrationOpen(e, via, source);
        this.reach.set(e, via);
      } else {
        this.reach.delete(e);
      }
      log.info('Reachability %s: %s -> %s', e, prev ?? 'offline', via ?? 'offline');
      if (this.listener) {
        try {
          await this.listener.onReachability(e, via, source);
        } catch (err) {
          log.warning('onReachability(%s) failed: %s', e, err);
        }
      }
    });
  }

  /** Monitor event callback: hint and contact changes. */
  async handleAmiEvent(p: Row): Promise<void> {
    const ev = evGet(p, 'Event');
    let ext = '';
    if (ev === 'DeviceStateChange') {
      const hit = RE_ENDPOINT_DEVICE.exec(evGet(p, 'Device').trim());
      if (!hit) return; // Custom:DND100 and friends are not the phone
      ext = hit[2];
      this.deviceStates.set(ext, normDeviceState(evGet(p, 'State')));
    } else if (ev === 'ExtensionStatus') ext = evGet(p, 'Exten').trim();
    else if (ev === 'ContactStatus') ext = contactExt(p);
    else return;
    if (!ext || !this.monitor.monitored.has(ext)) return;
    await this.reevaluate(ext);
  }

  /** Re-evaluate every monitored (and every previously reachable) extension. */
  async sweep(): Promise<void> {
    await this.syncDeviceStates();
    const all = new Set<string>([...this.monitor.monitored, ...this.reach.keys()]);
    for (const ext of all) await this.reevaluate(ext, 'system');
    if (this.listener?.reconcileDnd) {
      try {
        await this.listener.reconcileDnd();
      } catch (e) {
        log.warning('DND reconcile failed: %s', e);
      }
    }
  }

  start(intervalSecs = SWEEP_SECS): void {
    this.stop();
    this.timer = setInterval(() => {
      this.sweep().catch((e) => log.warning('reachability sweep failed: %s', e));
    }, intervalSecs * 1000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
