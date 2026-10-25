/**
 * The delivery side of the CRM call-data push: the durable queue, the retry worker and the
 * "after wrap-up" trigger.
 *
 * Every push is recorded in webhook_deliveries BEFORE its first attempt, so a CRM that is
 * down, 502-ing or slower than the timeout costs a retry rather than the call: the row
 * survives this process and the worker picks it up. Whether a failure is worth repeating,
 * and when, is decided by integrations/crm's retry policy (isRetryableFailure,
 * retryDelayFor); this module applies the sync config's budget to that answer. When the
 * queue is unavailable (the DB is down) the attempt still happens, untracked.
 *
 * Every attempt of one delivery carries the same Idempotency-Key (and X-OpDesk-Delivery-Id),
 * which is the only way a receiver can tell "again" from "another" when a first attempt
 * landed but its response was lost.
 *
 * With the "wrapup" trigger a finished call is parked instead of pushed: it goes out once
 * the agent who took it has left wrap-up (the CDR is final by then, and its identity is
 * laid over the payload again), or after the trigger's fallback window, whichever comes
 * first. A call nobody answered has no wrap-up coming and goes on the next sweep.
 */

import { getLogger } from '../core/logger';
import { monotonic, pyInt, pyJsonDumps, truthy } from '../core/py';
import { runtime } from '../core/runtime';
import * as dbm from '../db/db-manager';
import type { Row } from '../db/pool';
import { crmIdentityFromCdr } from '../services/call-log';
import { TALKED_OUTCOMES } from '../services/call-outcomes';
import {
  buildCrmPayload,
  CRMConnector,
  CrmDeliveryMeta,
  CrmResult,
  CRMSyncConfig,
  crmUnavailableReason,
  CrmValueError,
  isRetryableFailure,
  loadCrmSyncConfig,
  redactUrl,
  retryDelayFor,
} from './crm';

const log = getLogger('integrations.crm_delivery');

type Json = Record<string, unknown>;

// The shortest configurable backoff is 30 s (crm DEFAULT_RETRY_DELAYS), so sweeping more
// often than this only adds DB round-trips.
export const DELIVERY_SWEEP_SECONDS = 15;
// Rows claimed per sweep, and how many are in flight at once. The product with the
// connector timeout must stay under the claim lease (DELIVERY_LEASE_SECONDS, 300 s) or a
// batch against a dead receiver would outlive its own lease: 20 / 5 = 4 rounds, worst
// case ~120 s at the default 30 s timeout.
export const DELIVERY_BATCH = 20;
export const DELIVERY_CONCURRENCY = 5;
// A parked call is not judged "out of wrap-up" before this: AgentComplete (which starts
// wrap-up) arrives just after the hangup that parked the call.
export const WRAPUP_SETTLE_SECONDS = 10;

/** The headers that identify one delivery across its attempts. */
export function deliveryHeaders(deliveryUuid: string): Record<string, string> {
  return { 'Idempotency-Key': deliveryUuid, 'X-OpDesk-Delivery-Id': deliveryUuid };
}

/** The sync config the live monitor holds, else the one in settings. */
async function currentSyncConfig(): Promise<CRMSyncConfig> {
  const monitor = runtime.monitor as unknown as { crmSyncConfig?: CRMSyncConfig | null } | null;
  return monitor?.crmSyncConfig ?? (await loadCrmSyncConfig());
}

/** The attempt budget a sync config grants a new delivery (1 when retries are off). */
export function deliveryBudget(syncCfg: CRMSyncConfig | null | undefined): number {
  if (!syncCfg || !syncCfg.retryEnabled) return 1;
  return Math.max(1, pyInt(syncCfg.retryMaxAttempts) || 1);
}

function deliveryUrl(connector: CRMConnector | null, endpointPath: string | null): string {
  const base = connector ? connector.serverUrl : '';
  const url = `${base}${endpointPath || (connector ? connector.endpointPath : '')}`;
  // redactUrl strips the query string and any embedded credentials.
  return url ? redactUrl(url) : url;
}

function bodyText(callData: Json): string {
  // json.dumps(call_data, default=str): the bytes a retry or a resend replays.
  return pyJsonDumps(callData, { defaultStr: true });
}

/**
 * Send one call-data push: queue it, attempt it once now, and leave any retry to the
 * worker. Never throws: a failure (including "connector not configured" for an enabled
 * CRM) is logged AND recorded, so a broken connector doesn't look like "no calls
 * happened" in the deliveries view.
 *
 * The AMI monitor calls it fire-and-forget at hangup (after buildCrmPayload); the
 * deliveries resend route calls it with the stored body and the resend lineage in `meta`.
 */
export async function sendCrmDataAsync(
  connector: CRMConnector | null,
  callData: Json,
  opts: {
    method?: string;
    endpointPath?: string | null;
    meta?: CrmDeliveryMeta;
    syncCfg?: CRMSyncConfig | null;
    trigger?: string;
  } = {},
): Promise<CrmResult> {
  const meta = opts.meta ?? {};
  const method = opts.method || 'POST';
  const endpointPath = opts.endpointPath ?? null;
  const row: dbm.WebhookDeliveryInput = {
    callId: meta.call_id || null,
    uniqueid: meta.uniqueid || null,
    caller: meta.caller || null,
    destination: meta.destination || null,
    callType: meta.call_type || null,
    callStatus: meta.call_status || null,
    method,
    url: deliveryUrl(connector, endpointPath),
    requestBody: bodyText(callData),
    attempt: pyInt(meta.attempt || 1) || 1,
    parentId: meta.parent_id ?? null,
    resentBy: meta.resent_by ?? null,
    endpointPath,
    triggerKind: opts.trigger || 'hangup',
  };
  const route = `${meta.caller || callData.caller || '?'} -> ${meta.destination || callData.destination || '?'}`;

  if (!connector) {
    const error = crmUnavailableReason() || 'CRM connector not configured';
    log.warning('CRM connector not available when trying to send call data: %s (%s)', route, error);
    const result: CrmResult = { success: false, status_code: null, data: null, error };
    try {
      await dbm.insertWebhookDelivery({ ...row, success: false, error, durationMs: 0 });
    } catch (e) {
      log.debug('webhook delivery log write failed: %s', e);
    }
    return result;
  }

  let delivery: dbm.QueuedDelivery | null = null;
  try {
    delivery = await dbm.enqueueWebhookDelivery({ ...row, maxAttempts: deliveryBudget(opts.syncCfg) });
  } catch (e) {
    log.warning('Could not queue the CRM delivery (sending untracked): %s', e);
  }
  log.info('📤 Sending call data to CRM: %s', route);
  const started = monotonic();
  const result = await attemptDelivery(connector, callData, {
    method,
    endpointPath,
    syncCfg: opts.syncCfg ?? null,
    delivery,
    attemptsMade: 1,
    route,
  });
  if (!delivery) {
    // Untracked: record the one attempt the old way, so it is still visible.
    try {
      await dbm.insertWebhookDelivery({
        ...row,
        statusCode: result.status_code,
        success: result.success,
        responseBody: result.data !== null && result.data !== undefined ? pyJsonDumps(result.data, { defaultStr: true }) : null,
        error: result.error,
        durationMs: Math.trunc((monotonic() - started) * 1000),
      });
    } catch (e) {
      log.debug('webhook delivery log write failed: %s', e);
    }
  }
  return result;
}

/**
 * Make ONE attempt and record what happened. `delivery` is the queue row ({id,
 * delivery_uuid}) or null when untracked; `attemptsMade` counts this attempt (1 for the
 * immediate push, the row's `attempts` for a retry, which the claim already counted).
 */
export async function attemptDelivery(
  connector: CRMConnector,
  callData: Json,
  o: {
    method: string;
    endpointPath: string | null;
    syncCfg: CRMSyncConfig | null;
    delivery: { id: number; delivery_uuid: string } | null;
    attemptsMade: number;
    route?: string;
  },
): Promise<CrmResult> {
  const firstAttempt = o.attemptsMade <= 1;
  const route = o.route || `${callData.caller ?? '?'} -> ${callData.destination ?? '?'}`;
  const started = monotonic();
  let result: CrmResult;
  let permanent = false;
  try {
    // requireFields=false: the operator chose the field set; the push must not throw if
    // caller/destination were de-selected.
    result = await connector.sendCallData(callData, {
      endpointPath: o.endpointPath,
      method: o.method,
      requireFields: false,
      extraHeaders: o.delivery?.delivery_uuid ? deliveryHeaders(o.delivery.delivery_uuid) : null,
    });
  } catch (e) {
    // sendCallData handles HTTP and transport errors itself, so this is something before
    // the request: the SSRF guard refusing the target (permanent: the same URL is refused
    // again), or an OAuth2 token fetch (no response seen, so retryable).
    const name = e instanceof Error ? e.name : 'Error';
    const msg = e instanceof Error ? e.message : String(e);
    permanent = e instanceof CrmValueError;
    result = { success: false, status_code: null, data: null, error: `${name}: ${msg}` };
  }
  const durationMs = Math.trunc((monotonic() - started) * 1000);
  if (result.success) {
    log.info('✅ Successfully sent call data to CRM: %s%s', route, firstAttempt ? '' : ` (attempt ${o.attemptsMade})`);
  } else {
    log.error(
      '❌ Failed to send call data to CRM: %s (HTTP %s, attempt %s): %s',
      route,
      result.status_code ?? 'N/A',
      o.attemptsMade,
      result.error ?? 'Unknown error',
    );
  }
  if (!o.delivery) return result;

  let retryIn: number | null = null;
  let retryable = false;
  if (!result.success) {
    retryable = !permanent && isRetryableFailure(result.status_code);
    const budget = deliveryBudget(o.syncCfg);
    if (retryable && o.attemptsMade < budget) {
      retryIn = retryDelayFor(o.attemptsMade, { delays: o.syncCfg?.retryDelays ?? null, retryAfter: result.retry_after ?? null });
      log.info('🔁 CRM delivery #%s queued for retry in %ss (attempt %s/%s)', o.delivery.id, retryIn, o.attemptsMade, budget);
    } else if (retryable && budget > 1) {
      log.error('🛑 CRM delivery #%s abandoned after %s attempt(s): %s', o.delivery.id, o.attemptsMade, route);
    }
  }
  try {
    await dbm.markWebhookDeliveryAttempt(o.delivery.id, {
      delivered: result.success,
      statusCode: result.status_code,
      error: result.error,
      responseBody: result.data !== null && result.data !== undefined ? pyJsonDumps(result.data, { defaultStr: true }) : null,
      durationMs,
      retryIn,
      retryable,
      countAttempt: firstAttempt,
    });
  } catch (e) {
    // The row keeps its lease and the sweep tries again once it expires: worse than a
    // clean record, better than a lost payload.
    log.warning('Could not record CRM delivery #%s outcome: %s', o.delivery.id, e);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Retry worker
// ---------------------------------------------------------------------------

let workerTimer: NodeJS.Timeout | null = null;
let sweeping: Promise<number> | null = null;

/**
 * One sweep: claim the due deliveries and re-send them through the CURRENT connector, at
 * most DELIVERY_CONCURRENCY at a time. Nothing is claimed while there is no connector, so
 * a delivery keeps its attempt budget until the CRM is configured again. The number of
 * rows attempted.
 */
export async function sweepCrmDeliveries(): Promise<number> {
  if (sweeping) return sweeping;
  sweeping = (async () => {
    const connector = runtime.crmConnector;
    if (!connector) return 0;
    const rows = await dbm.claimWebhookDeliveries(DELIVERY_BATCH);
    if (!rows.length) return 0;
    log.info('🔁 Retrying %d queued CRM delivery(ies)', rows.length);
    const syncCfg = await currentSyncConfig();
    const queue = [...rows];
    const one = async (row: Row): Promise<void> => {
      let body: unknown;
      try {
        body = JSON.parse(String(row.request_body || ''));
      } catch {
        body = null;
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        await dbm.markWebhookDeliveryAttempt(row.id, { delivered: false, error: 'Stored request body cannot be replayed', retryable: false });
        return;
      }
      await attemptDelivery(connector, body as Json, {
        method: String(row.method || 'POST'),
        endpointPath: row.endpoint_path || null,
        syncCfg,
        delivery: { id: row.id, delivery_uuid: String(row.delivery_uuid || '') },
        attemptsMade: pyInt(row.attempts) || 1,
        route: `${row.caller || '?'} -> ${row.destination || '?'}`,
      });
    };
    const lanes = Array.from({ length: Math.min(DELIVERY_CONCURRENCY, queue.length) }, async () => {
      for (let row = queue.shift(); row; row = queue.shift()) {
        try {
          await one(row);
        } catch (e) {
          log.error('CRM delivery retry #%s failed: %s', row.id, e);
        }
      }
    });
    await Promise.all(lanes);
    return rows.length;
  })().finally(() => {
    sweeping = null;
  });
  return sweeping;
}

/**
 * Start the retry worker (and the wrap-up sweep) if it is not running. Long-lived rather
 * than on-demand: the point is to outlast the window in which the CRM is down, including
 * one that outlasts the calls that queued the work.
 */
export function startCrmDeliveryWorker(): void {
  if (workerTimer) return;
  log.info('🔁 CRM delivery retry worker started (every %ss)', DELIVERY_SWEEP_SECONDS);
  workerTimer = setInterval(() => {
    void sweepCrmDeliveries().catch((e) => log.error('CRM delivery sweep error: %s', e));
    void flushWrapups().catch((e) => log.error('CRM wrap-up sweep error: %s', e));
  }, DELIVERY_SWEEP_SECONDS * 1000);
  workerTimer.unref?.();
}

/** Stop the worker (shutdown). Parked wrap-up calls are pushed first, so none is lost. */
export async function stopCrmDeliveryWorker(): Promise<void> {
  if (workerTimer) clearInterval(workerTimer);
  workerTimer = null;
  await flushWrapups({ all: true }).catch((e) => log.warning('Wrap-up flush at shutdown failed: %s', e));
}

// ---------------------------------------------------------------------------
// "After wrap-up" trigger
// ---------------------------------------------------------------------------

/** One parked call: everything needed to build and send its push later. */
export interface ParkedCall {
  fullFields: Json;
  meta: CrmDeliveryMeta;
  parkedAt: number;
  answered: boolean;
}

// "linkedid:uniqueid" -> parked call (one push per leg, as at hangup).
export const parkedCalls: Map<string, ParkedCall> = new Map();

/** Park a finished call for the "wrapup" trigger. A later park of the same leg refreshes it. */
export function parkForWrapup(fullFields: Json, meta: CrmDeliveryMeta): void {
  const key = `${fullFields.call_id || meta.call_id || ''}:${fullFields.uniqueid || meta.uniqueid || ''}`;
  const prev = parkedCalls.get(key);
  parkedCalls.set(key, {
    fullFields: { ...fullFields },
    meta: { ...meta },
    parkedAt: prev ? prev.parkedAt : monotonic(),
    answered: TALKED_OUTCOMES.has(String(fullFields.call_status || '').toUpperCase()),
  });
  log.info('🕓 CRM push deferred until after wrap-up: %s -> %s [%s]', meta.caller || '?', meta.destination || '?', key);
}

/** Whether any extension on the call is still in wrap-up. */
function partyInWrapup(fields: Json): boolean {
  const states = runtime.agentState;
  if (!states) return false;
  for (const k of ['agent', 'answered_extension', 'caller', 'destination']) {
    const ext = String(fields[k] ?? '').trim();
    // agent-state WRAP_UP
    if (ext && states.stateOf(ext) === 'wrap_up') return true;
  }
  return false;
}

/**
 * The payload of a parked call as it goes out now: the finalized CDR's identity laid over
 * it (the live outcome is kept: the CDR only has the coarse disposition), then the current
 * field selection, duration unit, status map and key renames.
 */
export async function wrapupPayload(fullFields: Json, syncCfg: CRMSyncConfig): Promise<Json> {
  const fields: Json = { ...fullFields };
  const linkedid = String(fields.call_id || '');
  if (linkedid) {
    try {
      const ident = await crmIdentityFromCdr(linkedid);
      if (truthy(ident)) {
        const liveStatus = fields.call_status;
        const liveDisp = fields.disposition;
        Object.assign(fields, ident);
        if (liveStatus) fields.call_status = liveStatus;
        if (liveDisp) fields.disposition = liveDisp;
      }
    } catch (e) {
      log.debug('CDR identity fetch failed for %s: %s', linkedid, e);
    }
  }
  return buildCrmPayload(fields, syncCfg.fields, {
    durationFormat: syncCfg.durationFormat,
    statusMap: syncCfg.statusMap,
    keyMap: syncCfg.keyMap,
  });
}

/**
 * Push every parked call that is due: not answered, its agent out of wrap-up, or past the
 * fallback window (`all` pushes everything, for shutdown). A config switched back to the
 * hangup trigger releases everything parked. The number of calls pushed.
 */
export async function flushWrapups(opts: { all?: boolean } = {}): Promise<number> {
  if (!parkedCalls.size) return 0;
  const syncCfg = await currentSyncConfig();
  const now = monotonic();
  let sent = 0;
  for (const [key, parked] of [...parkedCalls]) {
    const elapsed = now - parked.parkedAt;
    const due =
      opts.all ||
      syncCfg.trigger !== 'wrapup' ||
      !parked.answered ||
      elapsed >= syncCfg.wrapupTimeout ||
      (elapsed >= WRAPUP_SETTLE_SECONDS && !partyInWrapup(parked.fullFields));
    if (!due) continue;
    parkedCalls.delete(key);
    if (!syncCfg.enabled || !syncCfg.directionAllowed(String(parked.fullFields.call_type || ''))) continue;
    const callData = await wrapupPayload(parked.fullFields, syncCfg);
    sent += 1;
    await sendCrmDataAsync(runtime.crmConnector, callData, {
      method: syncCfg.method,
      endpointPath: syncCfg.endpoint || null,
      meta: parked.meta,
      syncCfg,
      trigger: 'wrapup',
    });
  }
  return sent;
}
