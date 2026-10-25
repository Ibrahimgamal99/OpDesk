/**
 * Contact-name resolution.
 *
 * ContactResolver resolves a caller number to a contact name from the contacts table
 * (loaded into an in-memory map — resolution runs on every broadcast tick and must never
 * touch the DB). On a miss it does one live GET to the CRM (via the shared CRMConnector)
 * and, if the CRM knows the number, saves it as a source='crm' contact so it is a normal
 * phonebook row from then on. A lookup never overwrites an existing contact, so manual
 * (admin-edited) data always wins. Lookups are modeled on 3CX's server-side CRM
 * integration: a [Number] URL template, a name template of JSON paths, prefix/last-N-digits
 * number handling and optional phone-match verification.
 *
 * Consumers:
 *   - the AMI event bridge's call-info formatting calls resolveCached() on every state
 *     broadcast (dashboards), and the incoming-call hook calls it at first ring to warm it.
 *   - GET /api/crm/contact awaits resolve() (softphone ring / dial).
 *
 * Python: backend/crm_lookup.py
 */

import { getLogger } from '../core/logger';
import { createTask, monotonic, pyJsonDumps } from '../core/py';
import * as dbm from '../db/db-manager';
import { runtime } from '../core/runtime';
import {
  CRMConnector,
  CRMLookupConfig,
  CRMSyncConfig,
  extractJsonPath,
  initCrmConnector,
  loadCrmLookupConfig,
  loadCrmSyncConfig,
  lookupCacheKey,
  migrateCrmSyncFields,
  renderLookupUrl,
  renderNameTemplate,
} from './crm';
import { startCrmDeliveryWorker, stopCrmDeliveryWorker } from './crm-delivery';

const log = getLogger('integrations.crm_lookup');

// Transport/HTTP-5xx failures back off shorter so a down CRM recovers quickly.
export const ERROR_RETRY_SECS = 60.0;
// Leak guard for the miss set; the working set (unknown numbers currently on calls) is
// tiny, so this should essentially never trigger.
export const MISS_CAP = 5000;

/** One phonebook entry as getContactsForResolver() returns it: a (phone_key, name) pair or row. */
export type ContactPair = readonly [unknown, unknown] | { phone_key?: unknown; name?: unknown };

/** Numbers we never look up: blank, internal-extension-sized, or a monitored extension. */
export function skipNumber(rawNumber: string | null | undefined, monitored?: ReadonlySet<string> | null): boolean {
  const raw = (rawNumber || '').trim();
  if (!raw) return true;
  if (monitored && monitored.size && monitored.has(raw)) return true;
  // Same heuristic the AMI monitor uses to tell internal extensions from real numbers.
  return raw.replace(/\D/g, '').length <= 5;
}

/** Contact-name resolver. Single event loop, so no locks are needed. */
export class ContactResolver {
  private cfg: CRMLookupConfig | null = null;
  private connector: CRMConnector | null = null;
  // Raw (phone_key, name) rows from the contacts table, and the same rekeyed per the
  // current match_digits so a hit is one map lookup.
  private pairs: ContactPair[] = [];
  private contacts = new Map<string, string>();
  // key -> monotonic deadline before which we won't re-ask the CRM.
  private missUntil = new Map<string, number>();
  private tasks = new Map<string, Promise<void>>();

  /** Swap config + connector (live reload). Contacts are rekeyed so a changed match_digits applies at once. */
  setConfig(cfg: CRMLookupConfig | null, connector: CRMConnector | null): void {
    this.cfg = cfg;
    this.connector = connector;
    this.missUntil.clear();
    this.rebuild();
  }

  /**
   * Replace the contact set with (phone_key, name) rows from the DB; called at startup and
   * after every contacts CRUD so edits win on the next broadcast tick.
   */
  setContacts(pairs: readonly ContactPair[] | null | undefined): void {
    this.pairs = [...(pairs || [])];
    this.rebuild();
  }

  /** Re-key contacts for the current match_digits (keys must reduce the same way lookup keys do). */
  private rebuild(): void {
    const md = this.cfg ? this.cfg.matchDigits : 0;
    const rebuilt = new Map<string, string>();
    for (const pair of this.pairs) {
      const [phoneKey, name] = Array.isArray(pair)
        ? pair
        : [(pair as { phone_key?: unknown }).phone_key, (pair as { name?: unknown }).name];
      const key = lookupCacheKey(phoneKey ? String(phoneKey) : '', md);
      if (key && name) rebuilt.set(key, String(name));
    }
    this.contacts = rebuilt;
  }

  /** Whether live CRM lookups can run (contacts resolve regardless). */
  usable(): boolean {
    return Boolean(this.cfg && this.cfg.usable() && this.connector);
  }

  private key(rawNumber: string): string {
    return lookupCacheKey(rawNumber, this.cfg ? this.cfg.matchDigits : 0);
  }

  /**
   * Memory-only resolution. INVARIANT: this runs per call-row per WS client per broadcast
   * tick (<=500ms) — it must stay a map lookup and must never touch the DB or HTTP. An
   * unknown number schedules one background CRM fetch (deduped) and returns null for now.
   */
  resolveCached(rawNumber: string | null | undefined, monitored?: ReadonlySet<string> | null): string | null {
    if (skipNumber(rawNumber, monitored)) return null;
    const raw = String(rawNumber);
    const key = this.key(raw);
    if (!key) return null;
    const name = this.contacts.get(key);
    if (name) return name;
    if (this.usable() && !this.tasks.has(key) && (this.missUntil.get(key) ?? 0) <= monotonic()) {
      this.tasks.set(key, createTask(this.fetch(key, raw)).then(() => undefined));
    }
    return null;
  }

  /**
   * Memory-only name for a number, and no CRM fetch on a miss: Call History names a whole
   * page of (often old) calls through this, which must not fan out into CRM lookups.
   */
  nameFor(rawNumber: string | null | undefined): string | null {
    if (skipNumber(rawNumber)) return null;
    const key = this.key(String(rawNumber));
    return key ? (this.contacts.get(key) ?? null) : null;
  }

  /**
   * Awaitable resolution for the REST endpoint: joins the in-flight fetch (or starts one)
   * instead of waiting for the next broadcast tick.
   */
  async resolve(rawNumber: string | null | undefined, monitored?: ReadonlySet<string> | null): Promise<string | null> {
    if (skipNumber(rawNumber, monitored)) return null;
    const raw = String(rawNumber);
    const key = this.key(raw);
    if (!key) return null;
    const name = this.contacts.get(key);
    if (name) return name;
    if (!this.usable() || (this.missUntil.get(key) ?? 0) > monotonic()) return null;
    let task = this.tasks.get(key);
    if (task === undefined) {
      task = createTask(this.fetch(key, raw)).then(() => undefined);
      this.tasks.set(key, task);
    }
    await task;
    return this.contacts.get(key) ?? null;
  }

  /** One live CRM lookup; a hit becomes a source='crm' contact. Never throws. */
  private async fetch(key: string, rawNumber: string): Promise<void> {
    const cfg = this.cfg as CRMLookupConfig;
    const connector = this.connector as CRMConnector;
    try {
      // How long a "no match" answer suppresses re-asking about a number. Misses are not
      // persisted (only real contacts are), so this is the only guard against re-querying
      // an unknown caller on every tick.
      const missSecs = Math.max(1, Math.trunc(cfg.ttlHours)) * 3600;
      const path = renderLookupUrl(cfg.urlTemplate, rawNumber, cfg.numberFormat);
      const result = await connector.getJson(path);

      if (result.success) {
        let name = renderNameTemplate(result.data, cfg.nameTemplate);
        if (name && cfg.verifyPath) {
          const recordPhone = extractJsonPath(result.data, cfg.verifyPath);
          if (lookupCacheKey(recordPhone || '', cfg.matchDigits) !== key) {
            log.info('CRM lookup: verification failed for %s (record phone mismatch)', key);
            name = null;
          }
        }
        if (name) {
          await dbm.addCrmContactIfNew(rawNumber, key, name);
          this.contacts.set(key, name);
        } else {
          this.rememberMiss(key, missSecs);
        }
      } else if (result.status_code === 404) {
        // The CRM answered "no such contact".
        this.rememberMiss(key, missSecs);
      } else {
        // Transport error / 5xx: back off briefly.
        this.rememberMiss(key, ERROR_RETRY_SECS);
      }
    } catch (e) {
      log.warning('CRM lookup failed for %s: %s', key, e instanceof Error ? e.name : typeof e);
      this.rememberMiss(key, ERROR_RETRY_SECS);
    } finally {
      this.tasks.delete(key);
    }
  }

  private rememberMiss(key: string, ttlSecs: number): void {
    if (this.missUntil.size >= MISS_CAP) {
      // Evict the ~10% closest to expiry; effectively never runs in practice.
      const oldest = [...this.missUntil.entries()].sort((a, b) => a[1] - b[1]).slice(0, Math.floor(MISS_CAP / 10));
      for (const [k] of oldest) this.missUntil.delete(k);
    }
    this.missUntil.set(key, monotonic() + Math.max(1.0, ttlSecs));
  }
}

/** POST /api/crm/lookup-test's result. */
export interface LookupTestResult {
  success: boolean;
  status_code: number | null;
  name: string | null;
  matched: boolean;
  verify_detail: string;
  raw_excerpt: string;
  error: string | null;
}

/**
 * Run the full lookup pipeline once, bypassing the contact set. Used by
 * POST /api/crm/lookup-test so an admin can debug templates without curl.
 */
export async function runLookupTest(connector: CRMConnector, cfg: CRMLookupConfig, rawPhone: string): Promise<LookupTestResult> {
  const path = renderLookupUrl(cfg.urlTemplate, rawPhone, cfg.numberFormat);
  const result = await connector.getJson(path);

  let rawExcerpt = '';
  const data = result.data;
  if (data !== null && data !== undefined) {
    try {
      rawExcerpt = [...pyJsonDumps(data, { ensureAscii: false })].slice(0, 500).join('');
    } catch {
      rawExcerpt = String(data).slice(0, 500);
    }
  }

  if (!result.success) {
    return {
      success: false,
      status_code: result.status_code,
      name: null,
      matched: false,
      verify_detail: '',
      raw_excerpt: rawExcerpt,
      error: [...String(result.error || '')].slice(0, 300).join(''),
    };
  }

  const name = renderNameTemplate(data, cfg.nameTemplate);
  let matched = Boolean(name);
  let verifyDetail = '';
  if (name && cfg.verifyPath) {
    const recordPhone = extractJsonPath(data, cfg.verifyPath);
    const searchedKey = lookupCacheKey(rawPhone, cfg.matchDigits);
    if (lookupCacheKey(recordPhone || '', cfg.matchDigits) !== searchedKey) {
      matched = false;
      verifyDetail = `record phone ${recordPhone || '(empty)'} does not match searched ${searchedKey}`;
    }
  }
  return {
    success: true,
    status_code: result.status_code,
    name: matched ? name : null,
    matched,
    verify_detail: verifyDetail,
    raw_excerpt: rawExcerpt,
    error: null,
  };
}

// ===========================================================================
// Runtime wiring (server.py lifespan + the CRM config save's live reload)
// ===========================================================================

/** The monitor's monitored extensions (never looked up as caller numbers), when it is up. */
export function monitoredExtensions(): ReadonlySet<string> | null {
  const m = runtime.monitor as unknown as { monitored?: unknown } | null;
  return m && m.monitored instanceof Set ? (m.monitored as Set<string>) : null;
}

/** Reload the resolver's in-memory phonebook (after every contacts write). */
export async function reloadResolverContacts(): Promise<void> {
  if (runtime.contactResolver) runtime.contactResolver.setContacts(await dbm.getContactsForResolver());
}

/**
 * Startup: rewrite retired sync-field names, build the CRM connector, arm the contact
 * resolver with the phonebook (names resolve even with no CRM) and the lookup config
 * (live CRM fetch on a miss), and start the delivery retry worker. Sets
 * runtime.crmConnector / crmLookupConnector / contactResolver. The AMI monitor is built
 * afterwards with `loadCrmSyncConfig()` and runtime.crmConnector.
 */
export async function initCrmRuntime(): Promise<void> {
  await migrateCrmSyncFields();
  runtime.crmConnector = await initCrmConnector();
  runtime.crmLookupConnector = runtime.crmConnector;
  if (!runtime.contactResolver) runtime.contactResolver = new ContactResolver();
  runtime.contactResolver.setConfig(await loadCrmLookupConfig(), runtime.crmConnector);
  runtime.contactResolver.setContacts(await dbm.getContactsForResolver());
  // Always on: deliveries queued before a restart are due whether or not CRM is on now
  // (the worker claims nothing while there is no connector).
  startCrmDeliveryWorker();
}

/**
 * Apply saved CRM settings live (no restart): rebuild the connector and sync config, hand
 * them to the AMI monitor (`monitor.setCrm(connector, syncConfig)`), and re-arm the resolver.
 * The previous connector is closed once nothing references it. Throws when the rebuild
 * fails; the caller reports "restart required".
 */
export async function applyCrmRuntime(): Promise<void> {
  const previous = runtime.crmConnector;
  const connector = await initCrmConnector();
  const syncConfig = await loadCrmSyncConfig();
  runtime.crmConnector = connector;
  runtime.crmLookupConnector = connector;
  const monitor = runtime.monitor as unknown as { setCrm?: (c: CRMConnector | null, s: CRMSyncConfig) => void } | null;
  if (monitor && typeof monitor.setCrm === 'function') monitor.setCrm(connector, syncConfig);
  if (runtime.contactResolver) runtime.contactResolver.setConfig(await loadCrmLookupConfig(), connector);
  if (previous && previous !== connector) createTask(previous.close());
  log.info('✅ CRM configuration reloaded live (no restart needed)');
}

/** Shutdown: stop the delivery worker (pushing parked wrap-up calls) and close the CRM connector's HTTP client. */
export async function closeCrmRuntime(): Promise<void> {
  await stopCrmDeliveryWorker();
  if (runtime.crmConnector) {
    await runtime.crmConnector.close();
    log.info('CRM connector closed');
  }
}
