/**
 * Background jobs the lifespan starts (via services/realtime.startRealtime):
 *
 *   * analytics pre-aggregation (services/analytics.startAggregationLoop: hourly/daily
 *     buckets every 15 min, plus its own daily prune of stale device tokens and old
 *     webhook deliveries);
 *   * read call notifications older than 7 days are deleted once a day. schema.sql's
 *     MySQL EVENT did this, but event_scheduler is off on most boxes (FreePBX and Issabel
 *     alike), so the rows were never cleaned;
 *   * recording retention (services/recording.runRecordingRetention), once a day;
 *   * the daily shift reset (agent presence), polled every 5 minutes.
 *
 * Every loop logs and continues; none of them can stop the process. In shadow mode (a
 * side-by-side test instance) nothing that writes runs.
 */

import { getLogger } from '../core/logger';
import { dateIso } from '../core/py';
import { runtime } from '../core/runtime';
import * as dbm from '../db/db-manager';
import { formatShiftResetTime, shiftDayStart, shiftResetMinutes } from './agent-state';

const log = getLogger('services.background');

export const NOTIFICATION_RETENTION_DAYS = 7;
const DAY_SECONDS = 86_400;
const SHIFT_RESET_POLL_SECONDS = 300;

const timers: NodeJS.Timeout[] = [];
let started = false;

/** Run `fn` after `firstDelay` seconds, then every `interval` seconds; errors are logged. */
function every(name: string, firstDelay: number, interval: number, fn: () => Promise<unknown>): void {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      await fn();
    } catch (e) {
      log.warning('%s failed: %s', name, e);
    } finally {
      running = false;
    }
  };
  const first = setTimeout(() => {
    void run();
    const t = setInterval(() => void run(), interval * 1000);
    t.unref();
    timers.push(t);
  }, firstDelay * 1000);
  first.unref();
  timers.push(first);
}

/** Delete read call notifications older than the retention window. */
export async function cleanupNotifications(days = NOTIFICATION_RETENTION_DAYS): Promise<number> {
  const removed = await dbm.cleanupReadCallNotifications(days);
  if (removed) log.info('Deleted %s read call notification(s) older than %s days', removed, days);
  return removed;
}

/** Daily recording retention sweep (age / size quotas from Settings). */
export async function recordingRetention(): Promise<void> {
  const mod = (await import('./recording')) as { runRecordingRetention?: () => Promise<{ local_deleted: number }> };
  if (typeof mod.runRecordingRetention !== 'function') return;
  const summary = await mod.runRecordingRetention();
  if (summary && summary.local_deleted) log.info('Recording retention sweep: %s', JSON.stringify(summary));
}

/** Analytics pre-aggregation loop (runs forever inside services/analytics). */
async function startAggregation(): Promise<void> {
  const mod = (await import('./analytics')) as { startAggregationLoop?: () => Promise<void> };
  if (typeof mod.startAggregationLoop === 'function') {
    void mod.startAggregationLoop().catch((e) => log.warning('analytics aggregation loop stopped: %s', e));
  }
}

/**
 * State of the daily shift reset: the shift day the last reset belonged to. A restart is
 * not a missed boundary: the current shift day is adopted, so a backend that comes up at
 * 09:00 does not log the floor out for a boundary that passed at 00:00. Neither is a new
 * reset time: moving 00:00 to 15:00 at 14:00 puts "now" in a shift day that started at
 * 15:00 yesterday, which is not a boundary passing; the clock re-anchors without firing.
 */
export class ShiftResetClock {
  lastResetDay: string | null = null;
  private minutes: number | null;

  constructor(minutes: number | null, now = new Date()) {
    this.minutes = minutes;
    if (minutes !== null) this.lastResetDay = dateIso(shiftDayStart(now, minutes));
  }

  /** True when the boundary passed since the last call (and records it). */
  due(minutes: number | null, now = new Date()): boolean {
    if (minutes === null) {
      this.lastResetDay = null; // turned off: re-arm cleanly when turned back on
      this.minutes = null;
      return false;
    }
    const day = dateIso(shiftDayStart(now, minutes));
    if (minutes !== this.minutes) {
      this.minutes = minutes;
      this.lastResetDay = day;
      return false;
    }
    if (this.lastResetDay === null) {
      this.lastResetDay = day;
      return false;
    }
    if (day !== this.lastResetDay) {
      this.lastResetDay = day;
      return true;
    }
    return false;
  }
}

async function startShiftReset(): Promise<void> {
  const clock = new ShiftResetClock(await shiftResetMinutes());
  every('Shift reset', SHIFT_RESET_POLL_SECONDS, SHIFT_RESET_POLL_SECONDS, async () => {
    const minutes = await shiftResetMinutes();
    if (!clock.due(minutes) || !runtime.agentState) return;
    const summary = await runtime.agentState.dailyReset('system');
    log.info('Shift reset at %s: %s', formatShiftResetTime(minutes), JSON.stringify(summary));
  });
}

/** Start every background job once (idempotent). */
export function startBackgroundJobs(): void {
  if (started) return;
  started = true;
  every('Call notification cleanup', 120, DAY_SECONDS, () => cleanupNotifications());
  every('Recording retention', 60, DAY_SECONDS, () => recordingRetention());
  void startAggregation().catch((e) => log.warning('analytics aggregation not started: %s', e));
  void startShiftReset().catch((e) => log.warning('shift reset loop not started: %s', e));
}

export function stopBackgroundJobs(): void {
  for (const t of timers.splice(0)) {
    clearTimeout(t);
    clearInterval(t);
  }
  started = false;
  void import('./analytics')
    .then((m) => {
      const stop = (m as { stopAggregationLoop?: () => void }).stopAggregationLoop;
      if (typeof stop === 'function') stop();
    })
    .catch(() => undefined);
}
