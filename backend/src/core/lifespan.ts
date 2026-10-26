/**
 * Application lifespan: startup and shutdown, driven by LifespanService in app.module.ts.
 *
 * Startup, in the order the subsystems depend on each other:
 *   1. App DB schema, seeds, default settings, WebRTC URL and CRM field renames (db/migrate.ts)
 *   2. CRM connector + contact resolver
 *   3. QoS / mobile-wake dialplan (when enabled in settings)
 *   4. Push service + SIP push
 *   5. Call-recording dialplan (when enabled)
 *   6. AMI monitor -> state bridge, agent presence, background jobs (services/realtime.ts)
 * Shutdown runs the other way round and never throws.
 *
 * OPDESK_SHADOW=1 (core/shadow.ts) runs all of this against a copy of the app database
 * while refusing every PBX change, so it can sit beside the live instance.
 */

import { closeWebSockets } from '../api/routes/ws';
import { mobileWakeSettings } from '../api/routes/push.controller';
import * as dbm from '../db/db-manager';
import { closePools } from '../db/pool';
import { closeCrmRuntime, initCrmRuntime } from '../integrations/crm-lookup';
import { loadCrmSyncConfig } from '../integrations/crm';
import * as pushService from '../integrations/push-service';
import { setContactNameResolver } from '../services/call-log';
import { enableMobileWake, enableQos, enableRecording, recordingHookConflicts } from '../services/dialplan';
import { startRealtime, stopRealtime } from '../services/realtime';
import * as sipPush from '../services/sip-push';
import { stopVadWorker } from '../services/vad-runner';
import { env } from './config';
import { getLogger } from './logger';
import { runtime } from './runtime';
import { shadowMode } from './shadow';
import { sipTracer } from './system-logs';

export { shadowMode };

const log = getLogger('core.lifespan');

type StepFn = () => Promise<void> | void;

const startupSteps: [string, StepFn][] = [];
const shutdownSteps: [string, StepFn][] = [];

/**
 * Register an extra startup step (runs after the built-in ones, in registration order). A
 * failing step is logged and the server keeps booting, as the Python lifespan did for every
 * optional subsystem.
 */
export function onStartup(name: string, fn: StepFn): void {
  startupSteps.push([name, fn]);
}

/** Register a shutdown step (runs before the built-in ones, most recent first). */
export function onShutdown(name: string, fn: StepFn): void {
  shutdownSteps.push([name, fn]);
}

/**
 * Step 1: ensure the app DB schema. db/migrate.ts is loaded by a computed path so this file
 * compiles before that module exists; whichever entry point it exports is called.
 */
async function migrateDatabase(): Promise<void> {
  const modPath = '../db/migrate';
  let mod: Record<string, unknown>;
  try {
    mod = (await import(modPath)) as Record<string, unknown>;
  } catch (e) {
    log.warning('db/migrate not available, schema not checked: %s', e);
    return;
  }
  for (const name of ['migrate', 'runMigrations', 'ensureSchema', 'initDatabase', 'default']) {
    const fn = mod[name];
    if (typeof fn === 'function') {
      await (fn as () => Promise<unknown>)();
      return;
    }
  }
  log.warning('db/migrate exports no migrate() entry point; schema not checked');
}

const truthy = (v: string | null | undefined): boolean => ['true', '1', 'yes'].includes(String(v ?? '').trim().toLowerCase());

/** Run one optional startup step: a failure is logged and the server keeps booting. */
async function optional(name: string, fn: StepFn): Promise<void> {
  try {
    await fn();
  } catch (e) {
    log.error('Startup step %s failed: %s', name, e, e);
  }
}

/** Boot the subsystems in order. Never throws for an optional subsystem. */
export async function startup(): Promise<void> {
  log.info('Starting OpDesk server...');
  if (shadowMode()) log.warning('Shadow mode: PBX changes are refused (read-only AMI, no config writes, no file deletes)');

  // 1. DB schema. A failure here is fatal: every route needs the tables.
  await migrateDatabase();

  // 2. CRM connector (+ field migration) and the contact resolver's config and phonebook.
  await optional('CRM runtime', () => initCrmRuntime());
  // Call History names a row's remote party from the phonebook: a memory lookup that never
  // starts a CRM fetch, read through runtime so a rebuilt resolver is picked up.
  setContactNameResolver((n) => runtime.contactResolver?.nameFor(n) ?? null);

  // 3. Dialplan features that must survive an Asterisk config regeneration.
  await optional('QoS', async () => {
    if (!truthy(await dbm.getSetting('QOS_ENABLED', env('QOS_ENABLED', '')))) {
      log.info('QOS_ENABLED is not set or disabled. QoS will not be configured automatically.');
      return;
    }
    log.info((await enableQos()) ? 'QoS configuration enabled on startup' : 'Failed to enable QoS configuration on startup');
  });
  const wake = await mobileWakeSettings().catch((e: unknown) => {
    log.warning('Mobile wake settings not read: %s', e);
    return null;
  });
  if (wake?.enabled) {
    await optional('mobile wake', async () => {
      const ok = await enableMobileWake(wake.hold_seconds, wake.settle_seconds);
      if (ok) log.info('Mobile wake dialplan enabled on startup (hold=%ss, settle=%ss)', wake.hold_seconds, wake.settle_seconds);
      else log.warning('Failed to enable mobile wake dialplan on startup');
    });
  }

  // 4. Push providers and the RFC 8599 SIP push watcher.
  await optional('push service', () => pushService.reloadConfig());
  await optional('SIP push', () => sipPush.start(!!wake?.enabled, wake?.client_marker ?? ''));

  // 5. Call recording dialplan.
  await optional('call recording', async () => {
    if (!truthy(await dbm.getSetting('RECORDING_ENABLED', env('RECORDING_ENABLED', '')))) return;
    const format = (await dbm.getSetting('RECORDING_FORMAT', env('RECORDING_FORMAT', 'wav'))) || 'wav';
    if (!(await enableRecording({ mixFormat: format }))) {
      log.warning('Failed to enable call recording dialplan on startup');
      return;
    }
    log.info('Call recording dialplan enabled on startup (format=%s)', format);
    const conflicts = await recordingHookConflicts();
    if (conflicts && conflicts.length) {
      // Left as is (an admin's choice is not undone at boot); Settings -> Recordings shows it.
      log.warning('Call recording is on but not wired: the predial hooks are defined by %s', JSON.stringify(conflicts));
    }
  });

  // 6. AMI monitor, state bridge, agent presence and the background jobs.
  await optional('realtime', async () => {
    await startRealtime({ crmConnector: runtime.crmConnector, crmSyncConfig: await loadCrmSyncConfig() });
  });

  for (const [name, fn] of startupSteps) await optional(name, fn);
  log.info('Startup complete');
}

/** Stop everything startup started, newest first. Never throws. */
export async function shutdown(): Promise<void> {
  const step = async (name: string, fn: StepFn): Promise<void> => {
    try {
      await fn();
    } catch (e) {
      log.warning('Shutdown step %s failed: %s', name, e);
    }
  };
  for (const [name, fn] of [...shutdownSteps].reverse()) await step(name, fn);

  await step('realtime', () => stopRealtime());
  // Close every open socket so clients reconnect to the next process.
  await step('websockets', () => closeWebSockets());
  await step('CRM runtime', () => closeCrmRuntime());
  await step('SIP push', () => sipPush.stop());
  await step('push service', () => pushService.close());
  await step('SIP trace', () => sipTracer.stop());
  await step('VAD worker', () => stopVadWorker());
  await step('DB pools', () => closePools());
  log.info('Shutdown complete');
}
