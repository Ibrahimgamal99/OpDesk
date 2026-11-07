/**
 * Startup / shutdown of the realtime stack: the AMI monitor, the WebSocket state bridge,
 * agent presence and the hangup-side pushes. The lifespan calls startRealtime() once
 * (after the DB, CRM connector and push services are up) and stopRealtime() on shutdown.
 *
 * Port of the AMI half of server.py's lifespan() (api-contract.md §6 step 9-10).
 */

import { AMIEventBridge, broadcastStateNow, historyExtensions, setBridge, type LiveScope } from '../core/event-bridge';
import { getLogger, pyStr } from '../core/logger';
import { createTask, monotonic, sleep } from '../core/py';
import { runtime } from '../core/runtime';
import { amiEventBuffer } from '../core/system-logs';
import * as dbm from '../db/db-manager';
import type { CRMConnector, CRMSyncConfig } from '../integrations/crm';
import * as pushService from '../integrations/push-service';
import { RegistrationTracker } from './registration';
import { AgentStateManager } from './agent-state';
import { AMIExtensionsMonitor, logStartupSummary } from './ami';
import { startBackgroundJobs, stopBackgroundJobs } from './background';
import * as sipPush from './sip-push';

const log = getLogger('services.realtime');

/** A predial VoIP push suppresses the ring-time push for this long (seconds). */
export const AMI_CONNECT_ATTEMPTS = 10;
export const AMI_CONNECT_RETRY_SECONDS = 3;

export interface StartRealtimeOptions {
  crmConnector?: CRMConnector | null;
  crmSyncConfig?: CRMSyncConfig | null;
  /** Override for tests. */
  monitor?: AMIExtensionsMonitor;
  connectAttempts?: number;
  retrySeconds?: number;
}

/**
 * Connect to AMI (10 attempts, 3 s apart: a SIP TLS enable may have just restarted
 * Asterisk), sync, and start everything that hangs off the monitor. Returns false (and
 * leaves runtime.monitor null) when AMI never answered: the app still serves HTTP.
 * The daily background jobs start either way.
 */
export async function startRealtime(opts: StartRealtimeOptions = {}): Promise<boolean> {
  const monitor = opts.monitor ?? new AMIExtensionsMonitor({
    crmConnector: opts.crmConnector ?? null,
    crmSyncConfig: opts.crmSyncConfig ?? null,
  });
  const attempts = opts.connectAttempts ?? AMI_CONNECT_ATTEMPTS;
  const retry = opts.retrySeconds ?? AMI_CONNECT_RETRY_SECONDS;

  // In shadow mode the monitor still connects: core/shadow.ts lets only read-only AMI
  // actions through, so a side-by-side instance sees live state without acting on it.
  startBackgroundJobs();

  let connected = false;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (await monitor.connect()) {
      connected = true;
      break;
    }
    if (attempt < attempts) {
      log.warning('AMI connect attempt %d/%d failed — retrying in %ds', attempt, attempts, retry);
      await sleep(retry);
    }
  }
  if (!connected) {
    log.error('Failed to connect to AMI');
    return false;
  }
  log.info('Connected to AMI');
  runtime.monitor = monitor;

  // Monitored extensions (null = PBX read failed: keep none rather than prune).
  try {
    const extensions = await dbm.getExtensionsFromDb();
    if (extensions && extensions.length) {
      monitor.monitored = new Set(extensions.map((e) => String(e)));
      log.info(`Monitoring ${extensions.length} extensions`);
    }
  } catch (e) {
    log.warning('Extension list not loaded: %s', e);
  }
  await monitor.loadDeviceTechs();

  // Initial sync, before live events are processed. Queues first: it also waits out a
  // still-booting Asterisk, so the other syncs read a live PBX.
  await monitor.syncQueuesWhenReady();
  await monitor.syncExtensionStatuses();
  await monitor.syncActiveCalls();
  await monitor.syncDndState();
  logStartupSummary(monitor);

  monitor.setCallNotificationCallback((ext: string) => {
    createTask(sendCallNotificationNew(ext));
    createTask(dispatchMissedCallPush(ext));
  });
  monitor.setCallOutcomeCallback((ext: string, status: string, linkedid: string) => {
    createTask(sendToOwnExtension(ext, { type: 'call_outcome', extension: ext, status, linkedid }));
  });
  // System Logs panel (buffer disabled by default: one attribute read per event).
  monitor.setRawEventSink((p) => amiEventBuffer.add(p));
  monitor.setIncomingCallCallback((ext, caller, callId, displayName) => {
    sipPush.onIncomingCall(ext, caller, callId, displayName);
  });

  await monitor.startEvents();

  const bridge = new AMIEventBridge(monitor);
  setBridge(bridge);
  await bridge.start();

  // Presence: reachability (registered / push-wakeable) drives availability for every
  // extension; queue login and DND are reconciled from AMI and AstDB.
  const registration = new RegistrationTracker(monitor);
  const agentState = new AgentStateManager(monitor);
  agentState.registration = registration;
  agentState.wokenAt = (ext) => runtime.wokenAt.get(ext) ?? null;
  registration.listener = agentState;
  runtime.agentState = agentState;
  runtime.registration = registration;
  try {
    await registration.hydrate();
  } catch (e) {
    log.warning('Reachability hydrate failed: %s', e);
  }
  monitor.registerEventCallback((ev) => agentState.handleAmiEvent(ev));
  monitor.registerEventCallback((ev) => registration.handleAmiEvent(ev));
  try {
    await agentState.hydrate();
  } catch (e) {
    log.warning('Agent presence hydrate failed: %s', e);
  }
  registration.start();

  log.info('🎯 Server ready - tracking realtime AMI events');
  return true;
}

/** Shutdown: bridge, monitor, background jobs. Each step is bounded and never throws. */
export async function stopRealtime(): Promise<void> {
  stopBackgroundJobs();
  const step = async (name: string, fn: () => Promise<unknown> | unknown) => {
    try {
      await Promise.race([Promise.resolve().then(fn), sleep(5)]);
    } catch (e) {
      log.warning('Shutdown step %s failed: %s', name, e);
    }
  };
  const { getBridge } = await import('../core/event-bridge');
  const bridge = getBridge();
  if (bridge) await step('event bridge', () => bridge.stop());
  setBridge(null);
  const monitor = runtime.monitor;
  if (monitor) await step('ami', () => monitor.disconnect());
  runtime.registration?.stop();
  runtime.registration = null;
  runtime.agentState = null;
  runtime.monitor = null;
}

/**
 * `call_notification_new` to every socket allowed to see `ext`'s notifications (history
 * scope: admin, the supervisors of its groups, the agent themself). The client refetches
 * /api/call-notifications on it.
 */
export async function sendCallNotificationNew(ext: string): Promise<void> {
  const msg = { type: 'call_notification_new', extension: ext };
  const manager = runtime.manager;
  for (const ws of [...manager.activeConnections]) {
    const allowed = historyExtensions(manager.getScope(ws) as LiveScope);
    if (allowed === null || allowed.includes(String(ext))) await manager.sendPersonal(ws, msg);
  }
}

/** A frame only for the connections of users whose own extension is `ext`. */
export async function sendToOwnExtension(ext: string, msg: Record<string, unknown>): Promise<void> {
  const target = String(ext || '').trim();
  if (!target) return;
  const manager = runtime.manager;
  for (const ws of [...manager.activeConnections]) {
    const scope = manager.getScope(ws) as LiveScope;
    if (String(scope.extension || '').trim() === target) await manager.sendPersonal(ws, msg);
  }
}

/** Missed-call banner from the latest notification row, as an alert push. */
export async function dispatchMissedCallPush(ext: string): Promise<void> {
  try {
    const rows = await dbm.getCallNotificationsFromDb({ extension: ext, limit: 1 });
    const row: Record<string, any> = rows && rows.length ? rows[0] : {};
    const caller = row.caller_from || 'Unknown';
    let body = `Missed call from ${caller}`;
    if (row.queue) body += ` (queue ${row.queue})`;
    await pushService.sendAlert(ext, 'Missed call', body, {
      type: 'call_notification_new',
      extension: ext,
      caller_from: row.caller_from || '',
      queue: row.queue || '',
      reason: row.reason || '',
      call_id: row.call_id || '',
    });
  } catch (e) {
    log.debug('missed-call push dispatch error: %s', pyStr(e));
  }
}

export { broadcastStateNow };
