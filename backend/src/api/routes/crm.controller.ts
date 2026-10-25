/**
 * CRM and contacts: the CRM connection + call-data sync + contact-lookup configuration, the
 * connection and lookup probes, caller-name resolution for softphones, and the system
 * phonebook (contacts CRUD, plus the bulk upsert external systems push over an API key).
 *
 * Envelopes follow OpDesk's contract per route: /api/crm/test and /api/crm/lookup-test are
 * `{data}`; everything else is bare. Contact writes answer `{status: "ok"}` / `{id, ...}`.
 *
 * Python: the matching server.py routes (+ _connector_from_request, _validated_contact,
 * _reload_resolver_contacts).
 */

import { Controller, Req } from '@nestjs/common';
import type { Request } from 'express';
import { setRedactedAuditDetail } from '../../core/audit';
import { env } from '../../core/config';
import { getLogger, pyStr } from '../../core/logger';
import { pyInt, pyJsonDumps, truthy, waitFor } from '../../core/py';
import { runtime } from '../../core/runtime';
import type { Principal } from '../../core/security';
import * as dbm from '../../db/db-manager';
import type { Row } from '../../db/pool';
import {
  clampRetryMaxAttempts,
  clampWrapupTimeout,
  CRM_SYNC_FIELD_CATALOG,
  CRM_SYNC_TRIGGERS,
  CRMConnector,
  CRMLookupConfig,
  createCrmConnector,
  crmCallOutcomes,
  crmUnavailableReason,
  CrmValueError,
  DEFAULT_CRM_SYNC_FIELDS,
  defaultOutboundKeys,
  loadCrmLookupConfig,
  loadCrmSyncConfig,
  LOOKUP_NUMBER_FORMATS,
  lookupCacheKey,
  modernizeStatusMap,
  parseKeyMap,
  parseRetryDelays,
  parseStatusMap,
  parseSyncFields,
  validateCrmPath,
  validateCrmUrl,
} from '../../integrations/crm';
import { applyCrmRuntime, monitoredExtensions, reloadResolverContacts, runLookupTest } from '../../integrations/crm-lookup';
import { AppError, codes } from '../errors';
import { HttpError } from '../http-error';
import { respond } from '../respond';
import { Auth, Delete, Get, Post, principal, Put } from '../routing';
import { parseBody, pInt, qInt, qStr, REQUIRED, v } from '../validation';
import type { JsonObject, QueryParams } from '../validation';

const log = getLogger('api.routes.crm');

export const ContactBody = v.model({
  name: v.str(),
  phone: v.str(),
  company: v.str().nullish(),
  notes: v.str().nullish(),
  // The pushing system's own identity (API writes): a contact whose number changed
  // upstream updates its row instead of stranding it.
  external_id: v.str().nullish(),
  source_system: v.str().nullish(),
});

export const ContactBulkBody = v.model({ contacts: v.list(ContactBody) });

type ContactBodyT = ReturnType<typeof ContactBody.parse>;

/** Cap on one bulk request: an uncapped batch is a memory and a lock-duration problem; a sync pages instead. */
export const CONTACT_BULK_MAX = 500;

/** A `config_data: dict` body. */
const DictBody = v.dict();

/** `config_data: dict = None`: an absent (or JSON null) body is {}. */
function optionalDict(raw: unknown): JsonObject {
  if (raw === undefined || raw === null || (typeof raw === 'string' && raw === '')) return {};
  return parseBody(DictBody, raw);
}

const isOn = (v: unknown) => ['true', '1', 'yes'].includes(String(v ?? '').toLowerCase());

const AUTH_TYPES = ['api_key', 'basic_auth', 'bearer_token', 'oauth2'];

/** The value the CRM config uses for "a secret is stored here" (GET) / "keep it" (POST). */
const CRM_SECRET_MASK = '***';

/** get_setting(key, os.getenv(key, default)) as a string ('' for a NULL row). */
async function settingOrEnv(key: string, fallback = ''): Promise<string> {
  const value = await dbm.getSetting(key, env(key, fallback));
  return value === null || value === undefined ? '' : String(value);
}

/** set_setting(key, x) for a value the client sent: str() of a scalar, NULL for null. */
function settingValue(x: unknown): string | null {
  if (x === null || x === undefined) return null;
  return typeof x === 'string' ? x : pyStr(x);
}

/** Python's `x.get(key, default)` (a present null stays null). */
function getOr(obj: JsonObject, key: string, fallback: unknown): unknown {
  return Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : fallback;
}

/** validateCrmUrl as a 400 naming the field. */
async function vetUrl(raw: string, label: string, blockPrivate: boolean): Promise<void> {
  try {
    await validateCrmUrl(raw, { blockPrivate });
  } catch (e) {
    if (e instanceof CrmValueError) throw new HttpError(400, `Invalid ${label}: ${e.message}`);
    throw e;
  }
}

/** validateCrmPath as a 400. */
function vetPath(raw: unknown, field: string): string {
  const path = String(raw ?? '').trim();
  try {
    validateCrmPath(path, field);
  } catch (e) {
    if (e instanceof CrmValueError) throw new HttpError(400, e.message);
    throw e;
  }
  return path;
}

/** An integer setting from the body, or a 400 naming the field. */
function intField(raw: unknown, fallback: number, field: string, min: number): number {
  const n = pyInt(truthy(raw) ? raw : fallback);
  if (n === null || n < min) throw new HttpError(400, `${field} must be an integer >= ${min}`);
  return n;
}

/**
 * Build a throwaway connector from posted config values, falling back to saved secrets when a
 * field is masked ("***") or blank. Shared by the connection-test and lookup-test routes and
 * by the config save's completeness check; persists nothing. The caller must close() it.
 */
export async function connectorFromRequest(configData: JsonObject): Promise<CRMConnector> {
  const val = async (postedKey: string, settingKey: string, fallback = ''): Promise<string> => {
    const value = configData[postedKey];
    if (value === null || value === undefined || value === '') return settingOrEnv(settingKey, fallback);
    return String(value);
  };
  const secret = async (postedKey: string, settingKey: string): Promise<string> => {
    const value = configData[postedKey];
    if (truthy(value) && value !== CRM_SECRET_MASK) return String(value);
    return settingOrEnv(settingKey);
  };

  const serverUrl = ((await val('server_url', 'CRM_SERVER_URL')) || '').trim();
  if (!serverUrl) throw new HttpError(400, 'CRM server URL is required');
  const authType = ((await val('auth_type', 'CRM_AUTH_TYPE', 'api_key')) || 'api_key').toLowerCase();

  // SSRF guard — same rules as save: the server URL, the OAuth2 token URL, and every path
  // that is appended to the server URL.
  let bp: unknown = configData.block_private;
  if (bp === null || bp === undefined) bp = isOn((await dbm.getSetting('CRM_BLOCK_PRIVATE', 'false')) || 'false');
  const blockPrivate = truthy(bp);
  await vetUrl(serverUrl, 'CRM server URL', blockPrivate);

  const cfg: JsonObject = {
    server_url: serverUrl,
    auth_type: authType,
    endpoint_path: vetPath(await val('endpoint_path', 'CRM_ENDPOINT_PATH', '/api/calls'), 'endpoint_path'),
    block_private: blockPrivate,
  };
  cfg.verify_ssl =
    typeof configData.verify_ssl === 'boolean'
      ? configData.verify_ssl
      : isOn((await dbm.getSetting('CRM_VERIFY_SSL', 'true')) || 'true');
  const timeout = pyInt(truthy(configData.timeout) ? configData.timeout : (await dbm.getSetting('CRM_TIMEOUT', '30')) || 30);
  cfg.timeout = timeout === null ? 30 : timeout;

  if (authType === 'api_key') {
    cfg.api_key = await secret('api_key', 'CRM_API_KEY');
    const header = await val('api_key_header', 'CRM_API_KEY_HEADER', 'X-API-Key');
    if (header) cfg.api_key_header = header;
  } else if (authType === 'basic_auth') {
    cfg.username = await val('username', 'CRM_USERNAME');
    cfg.password = await secret('password', 'CRM_PASSWORD');
  } else if (authType === 'bearer_token') {
    cfg.bearer_token = await secret('bearer_token', 'CRM_BEARER_TOKEN');
  } else if (authType === 'oauth2') {
    cfg.oauth2_client_id = await val('oauth2_client_id', 'CRM_OAUTH2_CLIENT_ID');
    cfg.oauth2_client_secret = await secret('oauth2_client_secret', 'CRM_OAUTH2_CLIENT_SECRET');
    cfg.oauth2_token_url = (await val('oauth2_token_url', 'CRM_OAUTH2_TOKEN_URL')).trim();
    if (cfg.oauth2_token_url) await vetUrl(String(cfg.oauth2_token_url), 'OAuth2 token URL', blockPrivate);
    const scope = await val('oauth2_scope', 'CRM_OAUTH2_SCOPE');
    if (scope) cfg.oauth2_scope = scope;
  }

  try {
    return createCrmConnector(cfg);
  } catch (e) {
    if (e instanceof CrmValueError) throw new HttpError(400, e.message);
    throw e;
  }
}

/**
 * Normalized match key for a contact number: digits only, reduced to the last N per the
 * configured CRM_LOOKUP_MATCH_DIGITS. Every phonebook write keys through this, so the UNIQUE
 * index on contacts.phone_key and the resolver's in-memory map agree about what "the same
 * number" means ('+20 100 555 1234' and '0100 555 1234' are one contact at 10 digits).
 */
export async function contactKey(phone: string): Promise<string> {
  const cfg = await loadCrmLookupConfig();
  return lookupCacheKey(phone, cfg.matchDigits);
}

/** Normalise + validate a contact payload -> [name, phone, phone_key]. */
async function validatedContact(body: { name: string; phone: string }): Promise<[string, string, string]> {
  const name = (body.name || '').trim();
  const phone = (body.phone || '').trim();
  if (!name) throw new HttpError(400, 'Name is required');
  const key = await contactKey(phone);
  if (!key) throw new HttpError(400, 'Phone must contain digits');
  return [name, phone, key];
}

/**
 * A contact write by a JWT user must come from an admin: requireScope's JWT fallback does no
 * role check. An API key that got here already holds contacts:write.
 */
export function requireContactWriter(user: Principal): void {
  if (user.api_key) return;
  if (user.role !== 'admin') throw new HttpError(403, 'Admin only');
}

/** Machine writes are tagged 'api', human writes 'manual': the precedence ladder acts on it. */
export function contactSourceFor(user: Principal): string {
  return user.api_key ? 'api' : 'manual';
}

/**
 * A contacts row in its API shape. One mapper for the list and the single GET, so both are
 * identical by construction, and a column added to the table never reaches a client unnoticed.
 */
export function contactDto(row: Row): Row {
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    phone_key: row.phone_key,
    company: row.company ?? null,
    notes: row.notes ?? null,
    source: row.source,
    external_id: row.external_id ?? null,
    source_system: row.source_system ?? null,
    created_at: row.created_at ?? null,
    updated_at: row.updated_at ?? null,
  };
}

/** The fields of a contact an audit row records (the number and name, never the notes). */
function contactAudit(body: ContactBodyT): Row {
  return { name: body.name, phone: body.phone, external_id: body.external_id ?? null, source_system: body.source_system ?? null };
}

const LOOKUP_URL_ERROR =
  "lookup_url must be a path starting with '/' (no '@', '://' or spaces); it is appended to the CRM server URL";

/**
 * Validate a CRM config body completely and return the settings to write, without writing
 * anything: {writes, warnings}. Throws the 400 for the first invalid field.
 */
async function plannedCrmSettings(data: JsonObject): Promise<{ writes: Record<string, string | null>; warnings: string[] }> {
  const warnings: string[] = [];
  const writes: Record<string, string | null> = {};
  const set = (key: string, value: unknown) => {
    writes[key] = settingValue(value);
  };
  const enabled = truthy(data.enabled);
  const blockPrivate = truthy(getOr(data, 'block_private', false));

  const authType = pyStr(getOr(data, 'auth_type', 'api_key') ?? 'api_key').trim().toLowerCase() || 'api_key';
  if (!AUTH_TYPES.includes(authType)) throw new HttpError(400, `auth_type must be one of: ${AUTH_TYPES.join(', ')}`);

  // Reject an SSRF-unsafe server URL before persisting anything.
  const serverUrl = String(data.server_url || '').trim();
  if (enabled && !serverUrl) throw new HttpError(400, 'CRM server URL is required');
  if (enabled && serverUrl) {
    try {
      await validateCrmUrl(serverUrl, { blockPrivate });
    } catch (e) {
      if (!(e instanceof CrmValueError)) throw e;
      // The 400 detail only reaches the browser; log the reason too.
      log.warning('CRM config save rejected: invalid server URL (%s)', e.message);
      throw new HttpError(400, `Invalid CRM server URL: ${e.message}`);
    }
  }

  set('CRM_ENABLED', enabled ? 'true' : 'false');
  set('CRM_SERVER_URL', getOr(data, 'server_url', ''));
  set('CRM_AUTH_TYPE', authType);
  set('CRM_ENDPOINT_PATH', vetPath(getOr(data, 'endpoint_path', '/api/calls'), 'endpoint_path') || '/api/calls');
  set('CRM_TIMEOUT', String(intField(getOr(data, 'timeout', 30), 30, 'timeout', 1)));
  set('CRM_VERIFY_SSL', truthy(getOr(data, 'verify_ssl', true)) ? 'true' : 'false');

  // Auth-specific settings. A secret that comes back masked ("***") or empty keeps the
  // stored value; a plain field that is sent is written as sent, so it can be cleared.
  const keepOrSet = (posted: string, key: string) => {
    const value = getOr(data, posted, '');
    if (truthy(value) && value !== CRM_SECRET_MASK) set(key, value);
  };
  const plain = (posted: string, key: string) => {
    if (posted in data) set(key, String(data[posted] ?? '').trim());
  };
  if (authType === 'api_key') {
    keepOrSet('api_key', 'CRM_API_KEY');
    plain('api_key_header', 'CRM_API_KEY_HEADER');
  } else if (authType === 'basic_auth') {
    plain('username', 'CRM_USERNAME');
    keepOrSet('password', 'CRM_PASSWORD');
  } else if (authType === 'bearer_token') {
    keepOrSet('bearer_token', 'CRM_BEARER_TOKEN');
  } else {
    plain('oauth2_client_id', 'CRM_OAUTH2_CLIENT_ID');
    keepOrSet('oauth2_client_secret', 'CRM_OAUTH2_CLIENT_SECRET');
    if ('oauth2_token_url' in data) {
      // The token request leaves the box like the push does, so it is vetted like the server URL.
      const tokenUrl = String(data.oauth2_token_url ?? '').trim();
      if (tokenUrl) await vetUrl(tokenUrl, 'OAuth2 token URL', blockPrivate);
      set('CRM_OAUTH2_TOKEN_URL', tokenUrl);
    }
    plain('oauth2_scope', 'CRM_OAUTH2_SCOPE');
  }

  // ── Call-data sync (push) settings ──
  // Older clients may POST without these keys; default to "on / all" so nothing is
  // silently disabled.
  set('CRM_SYNC_ENABLED', truthy(getOr(data, 'sync_enabled', true)) ? 'true' : 'false');
  const syncMethod = pyStr(getOr(data, 'sync_method', 'POST')).toUpperCase();
  set('CRM_SYNC_METHOD', syncMethod === 'PUT' ? 'PUT' : 'POST');
  if ('sync_endpoint' in data) set('CRM_SYNC_ENDPOINT', vetPath(data.sync_endpoint, 'sync_endpoint'));
  if ('sync_fields' in data) {
    const rawFields = data.sync_fields;
    const cleaned = parseSyncFields(
      typeof rawFields === 'string' || Array.isArray(rawFields) ? (rawFields as string | unknown[]) : null,
    );
    // Never persist an empty selection — fall back to the compatible default, and say so.
    if (cleaned.length) {
      set('CRM_SYNC_FIELDS', cleaned.join(','));
      // No field is forced into the body, so a selection with neither identity field
      // produces calls the CRM cannot attribute.
      if (!cleaned.includes('caller') && !cleaned.includes('destination')) {
        warnings.push('Neither Caller nor Destination is selected — the CRM will receive calls it cannot identify.');
      }
    } else {
      set('CRM_SYNC_FIELDS', DEFAULT_CRM_SYNC_FIELDS.join(','));
      warnings.push('No sync fields were selected — reverted to the default field set.');
    }
  }
  set('CRM_SYNC_DIR_INBOUND', truthy(getOr(data, 'sync_dir_inbound', true)) ? 'true' : 'false');
  set('CRM_SYNC_DIR_OUTBOUND', truthy(getOr(data, 'sync_dir_outbound', true)) ? 'true' : 'false');
  set('CRM_SYNC_DIR_INTERNAL', truthy(getOr(data, 'sync_dir_internal', true)) ? 'true' : 'false');
  set('CRM_BLOCK_PRIVATE', blockPrivate ? 'true' : 'false');

  // ── When the push fires, and its automatic retry ──
  if ('sync_trigger' in data) {
    const trigger = pyStr(data.sync_trigger ?? 'hangup').trim().toLowerCase() || 'hangup';
    if (!CRM_SYNC_TRIGGERS.includes(trigger)) throw new HttpError(400, `sync_trigger must be one of: ${CRM_SYNC_TRIGGERS.join(', ')}`);
    set('CRM_SYNC_TRIGGER', trigger);
  }
  if ('sync_wrapup_timeout' in data) {
    if (truthy(data.sync_wrapup_timeout) && pyInt(data.sync_wrapup_timeout) === null) {
      throw new HttpError(400, 'sync_wrapup_timeout must be a whole number of seconds');
    }
    set('CRM_SYNC_WRAPUP_TIMEOUT', String(clampWrapupTimeout(data.sync_wrapup_timeout)));
  }
  if ('sync_retry_enabled' in data) set('CRM_SYNC_RETRY_ENABLED', truthy(data.sync_retry_enabled) ? 'true' : 'false');
  if ('sync_retry_max_attempts' in data) {
    if (truthy(data.sync_retry_max_attempts) && pyInt(data.sync_retry_max_attempts) === null) {
      throw new HttpError(400, 'sync_retry_max_attempts must be a whole number');
    }
    set('CRM_SYNC_RETRY_MAX_ATTEMPTS', String(clampRetryMaxAttempts(data.sync_retry_max_attempts)));
  }
  if ('sync_retry_delays' in data) {
    // Normalised through the parser the worker reads with, so what the UI shows back is
    // what the queue will do: a bad ladder is corrected here, not reinterpreted at send time.
    const raw = data.sync_retry_delays;
    set('CRM_SYNC_RETRY_DELAYS', parseRetryDelays(typeof raw === 'string' || Array.isArray(raw) ? raw : null).join(','));
  }

  // ── Payload shaping: duration unit, status remap, outbound key rename ──
  // Validated before persisting rather than silently coerced: a dropped rename or a bad
  // unit is invisible in the payload, so the operator has to be told.
  if ('sync_duration_format' in data) {
    const fmt = (truthy(data.sync_duration_format) ? pyStr(data.sync_duration_format) : 'hms').trim().toLowerCase();
    if (fmt !== 'hms' && fmt !== 'seconds') throw new HttpError(400, "sync_duration_format must be 'hms' or 'seconds'");
    set('CRM_SYNC_DURATION_FORMAT', fmt);
  }
  if ('sync_key_map' in data) {
    const rawMap = truthy(data.sync_key_map) ? data.sync_key_map : {};
    const parsed = parseKeyMap(rawMap);
    if (rawMap && typeof rawMap === 'object' && !Array.isArray(rawMap)) {
      const m = rawMap as JsonObject;
      const dropped = Object.keys(m).filter((k) => !(k in parsed) && String(m[k] || '').trim());
      if (dropped.length) warnings.push('Ignored key rename(s) for unknown outbound key(s): ' + dropped.sort().join(', '));
    }
    set('CRM_SYNC_KEY_MAP', pyJsonDumps(parsed));
  }
  if ('sync_status_map' in data) {
    const rawMap = truthy(data.sync_status_map) ? data.sync_status_map : {};
    // Sources in a retired call-status spelling (NO_ANSWER, CANCELED, OUT_OF_REACH...)
    // are saved under today's word, so they keep matching.
    const parsed = modernizeStatusMap(parseStatusMap(rawMap));
    const outcomes = crmCallOutcomes();
    const unknown = Object.keys(parsed).filter((k) => !outcomes.includes(k));
    if (unknown.length) {
      warnings.push('Outcome remap source(s) not produced by OpDesk (will never match): ' + unknown.sort().join(', '));
    }
    set('CRM_SYNC_STATUS_MAP', pyJsonDumps(parsed));
  }

  // ── Contact lookup settings ──
  // The lookup URL is a *path template* appended to the already-SSRF-validated server
  // URL; refusing anything but a path keeps that single validation surface.
  if ('lookup_enabled' in data) set('CRM_LOOKUP_ENABLED', truthy(data.lookup_enabled) ? 'true' : 'false');
  if ('lookup_url' in data) {
    const lookupUrl = String(data.lookup_url || '').trim();
    try {
      validateCrmPath(lookupUrl, 'lookup_url');
    } catch {
      log.warning('CRM config save rejected: lookup_url is not a path (%r)', lookupUrl.slice(0, 80));
      throw new HttpError(400, LOOKUP_URL_ERROR);
    }
    set('CRM_LOOKUP_URL', lookupUrl);
  }
  if ('lookup_name_template' in data) set('CRM_LOOKUP_NAME_TEMPLATE', String(data.lookup_name_template || '').trim());
  if ('lookup_number_format' in data) {
    const fmt = (truthy(data.lookup_number_format) ? pyStr(data.lookup_number_format) : 'digits').trim().toLowerCase();
    if (!LOOKUP_NUMBER_FORMATS.includes(fmt)) {
      throw new HttpError(400, `lookup_number_format must be one of: ${LOOKUP_NUMBER_FORMATS.join(', ')}`);
    }
    set('CRM_LOOKUP_NUMBER_FORMAT', fmt);
  }
  if ('lookup_match_digits' in data) {
    const n = pyInt(truthy(data.lookup_match_digits) ? data.lookup_match_digits : 0);
    if (n === null || n < 0 || n > 32) throw new HttpError(400, 'lookup_match_digits must be an integer between 0 and 32');
    set('CRM_LOOKUP_MATCH_DIGITS', String(n));
  }
  if ('lookup_verify_path' in data) set('CRM_LOOKUP_VERIFY_PATH', String(data.lookup_verify_path || '').trim());
  if ('lookup_ttl_hours' in data) {
    const n = pyInt(truthy(data.lookup_ttl_hours) ? data.lookup_ttl_hours : 24);
    if (n === null || n < 1) throw new HttpError(400, 'lookup_ttl_hours must be a positive integer');
    set('CRM_LOOKUP_TTL_HOURS', String(n));
  }
  // An enabled lookup with no name template can never put a name on a number.
  const lookupOn = 'CRM_LOOKUP_ENABLED' in writes ? writes.CRM_LOOKUP_ENABLED === 'true' : isOn(await settingOrEnv('CRM_LOOKUP_ENABLED'));
  const nameTemplate = 'CRM_LOOKUP_NAME_TEMPLATE' in writes ? writes.CRM_LOOKUP_NAME_TEMPLATE : (await settingOrEnv('CRM_LOOKUP_NAME_TEMPLATE')).trim();
  if (lookupOn && !nameTemplate) throw new HttpError(400, 'lookup_name_template is required when the contact lookup is enabled');

  // An enabled CRM must be buildable from what will be stored (stored secrets fill in the
  // masked ones), or every call would be a failed delivery.
  if (enabled) {
    const connector = await connectorFromRequest({ ...data, auth_type: authType, block_private: blockPrivate });
    await connector.close().catch(() => undefined);
  }
  return { writes, warnings };
}

@Controller()
export class CrmController {
  // -------------------------------------------------------------------------
  // CRM configuration
  // -------------------------------------------------------------------------

  /** Current CRM configuration (secrets masked as "***"). */
  @Get('/api/crm/config')
  @Auth('admin')
  async getCrmConfig() {
    const timeout = pyInt(await settingOrEnv('CRM_TIMEOUT', '30'));
    const config: JsonObject = {
      enabled: isOn(await settingOrEnv('CRM_ENABLED')),
      server_url: await settingOrEnv('CRM_SERVER_URL'),
      auth_type: (await settingOrEnv('CRM_AUTH_TYPE', 'api_key')).toLowerCase(),
      endpoint_path: await settingOrEnv('CRM_ENDPOINT_PATH', '/api/calls'),
      timeout: timeout === null ? 30 : timeout,
      verify_ssl: isOn(await settingOrEnv('CRM_VERIFY_SSL', 'true')),
    };
    const mask = async (key: string) => ((await settingOrEnv(key)) ? CRM_SECRET_MASK : '');

    // Auth-specific fields (secrets masked).
    const authType = config.auth_type;
    if (authType === 'api_key') {
      config.api_key = await mask('CRM_API_KEY');
      config.api_key_header = await settingOrEnv('CRM_API_KEY_HEADER');
    } else if (authType === 'basic_auth') {
      config.username = await settingOrEnv('CRM_USERNAME');
      config.password = await mask('CRM_PASSWORD');
    } else if (authType === 'bearer_token') {
      config.bearer_token = await mask('CRM_BEARER_TOKEN');
    } else if (authType === 'oauth2') {
      config.oauth2_client_id = await settingOrEnv('CRM_OAUTH2_CLIENT_ID');
      config.oauth2_client_secret = await mask('CRM_OAUTH2_CLIENT_SECRET');
      config.oauth2_token_url = await settingOrEnv('CRM_OAUTH2_TOKEN_URL');
      config.oauth2_scope = await settingOrEnv('CRM_OAUTH2_SCOPE');
    }
    // Whether the saved config is live: false with a reason when CRM is on but its
    // connector could not be built (pushes are then recorded as failed deliveries).
    config.active = Boolean(runtime.crmConnector);
    config.unavailable_reason = crmUnavailableReason();

    // Call-data sync (push) configuration + the field catalog the UI renders as checkboxes.
    const sync = await loadCrmSyncConfig();
    config.sync_enabled = sync.enabled;
    config.sync_endpoint = (await dbm.getSetting('CRM_SYNC_ENDPOINT', '')) || '';
    config.sync_method = sync.method;
    config.sync_fields = sync.fields;
    config.sync_dir_inbound = sync.dirInbound;
    config.sync_dir_outbound = sync.dirOutbound;
    config.sync_dir_internal = sync.dirInternal;
    config.block_private = sync.blockPrivate;
    config.sync_duration_format = sync.durationFormat;
    config.sync_status_map = sync.statusMap;
    config.sync_key_map = sync.keyMap;
    config.sync_trigger = sync.trigger;
    config.sync_wrapup_timeout = sync.wrapupTimeout;
    config.sync_retry_enabled = sync.retryEnabled;
    // The stored budget, not the effective one (1 while retries are off), so switching
    // retries back on shows what will apply.
    config.sync_retry_max_attempts = clampRetryMaxAttempts(await settingOrEnv('CRM_SYNC_RETRY_MAX_ATTEMPTS'));
    config.sync_retry_delays = sync.retryDelays;
    config.field_catalog = [...CRM_SYNC_FIELD_CATALOG];
    // Read-only, server-derived: the UI renders the rename grid and the status-map editor
    // from these, so it never hardcodes wire key names or call-status values.
    config.default_keys = defaultOutboundKeys();
    config.call_outcomes = crmCallOutcomes();

    // Contact lookup configuration (no secrets — reuses the connection auth).
    const lookup = await loadCrmLookupConfig();
    config.lookup_enabled = lookup.enabled;
    config.lookup_url = lookup.urlTemplate;
    config.lookup_name_template = lookup.nameTemplate;
    config.lookup_number_format = lookup.numberFormat;
    config.lookup_match_digits = lookup.matchDigits;
    config.lookup_verify_path = lookup.verifyPath;
    config.lookup_ttl_hours = lookup.ttlHours;
    return config;
  }

  /**
   * Save the CRM configuration and apply it live (no restart). The whole body is validated
   * first and the settings are written in one transaction, so a rejected save changes
   * nothing. An enabled CRM whose connector cannot be built is a 400; one that saved but did
   * not come up live answers `active: false` with a warning, not "saved and applied".
   */
  @Post('/api/crm/config')
  @Auth('admin')
  async saveCrmConfig(@Req() req: Request) {
    const data = parseBody(DictBody, req.body);
    let planned: { writes: Record<string, string | null>; warnings: string[] };
    try {
      planned = await plannedCrmSettings(data);
    } catch (e) {
      if (e instanceof HttpError) log.warning('CRM config save rejected (%s): %s', e.status, e.message);
      throw e;
    }
    const { writes, warnings } = planned;
    if (!(await dbm.setSettings(writes))) {
      // The text stays generic so a DB error never reaches the browser.
      throw new HttpError(500, 'Failed to save CRM configuration: see server logs');
    }
    log.info('CRM configuration saved to database');
    setRedactedAuditDetail(req, data);

    // Apply immediately — rebuild the connector + sync config and hand them to the live
    // AMI monitor and the contact resolver.
    let reloadOk = true;
    try {
      await applyCrmRuntime();
    } catch (e) {
      reloadOk = false;
      log.error('CRM config saved but live reload failed (restart to apply): %s', e);
      warnings.push('Configuration saved, but applying it live failed — restart the server to apply.');
    }
    const enabled = writes.CRM_ENABLED === 'true';
    const active = Boolean(runtime.crmConnector);
    if (reloadOk && enabled && !active) {
      warnings.push(`CRM is enabled but not active: ${crmUnavailableReason() || 'the connector could not be built'}.`);
    }
    let message = 'CRM configuration saved and applied.';
    if (!reloadOk) message = 'CRM configuration saved (restart required to apply).';
    else if (enabled && !active) message = 'CRM configuration saved, but the CRM is not active.';
    return { success: true, reload_ok: reloadOk, active, warnings, message };
  }

  /**
   * Test connectivity to the CRM with the values in the request body (masked/blank secrets
   * fall back to the saved ones). Persists nothing, so credentials can be checked before saving.
   */
  @Post('/api/crm/test')
  @Auth('admin')
  async testCrmConnection(@Req() req: Request) {
    const data = optionalDict(req.body);
    const connector = await connectorFromRequest(data);
    // Prefer testing the actual push endpoint when one is configured.
    const syncEndpoint = vetPath(data.sync_endpoint || (await dbm.getSetting('CRM_SYNC_ENDPOINT', '')) || '', 'sync_endpoint') || null;
    try {
      const result = await connector.testConnection(syncEndpoint);
      return respond({
        success: Boolean(result.success),
        status_code: result.status_code,
        message: result.message ?? '',
        method: result.method ?? null,
      });
    } catch (e) {
      throw new AppError(
        codes.CRM_LOOKUP_UNAVAILABLE,
        'The CRM connection test could not complete. Check the server URL and credentials.',
        { details: { reason: e instanceof Error ? e.message : String(e) }, cause: e },
      );
    } finally {
      await connector.close().catch(() => undefined);
    }
  }

  /**
   * Resolve a phone number to a contact name (phonebook first, then a live CRM lookup if
   * configured). Called by the softphone on ring and on dial, so any signed-in user may use
   * it. Waits up to 5 s for an in-flight CRM fetch; on timeout the fetch continues in the
   * background and the client may simply retry. `enabled` says whether a live CRM lookup can
   * run, so the client can tell "lookup is off" from "looked and found nothing".
   */
  @Get('/api/crm/contact')
  @Auth('user')
  async getCrmContact(@Req() req: Request) {
    const phone = [...String(qStr(req.query as QueryParams, 'phone', REQUIRED)).trim()].slice(0, 64).join('');
    const resolver = runtime.contactResolver;
    if (!resolver) return { phone, name: null, enabled: false };
    let name: string | null;
    try {
      name = await waitFor(resolver.resolve(phone, monitoredExtensions()), 5);
    } catch {
      name = null;
    }
    return { phone, name, enabled: resolver.usable() };
  }

  /**
   * Run one contact lookup with the values in the request body (masked secrets fall back to
   * saved ones), bypassing all caches and persisting nothing. Returns the resolved name plus
   * a truncated raw-response excerpt so an operator can debug a name template without curl.
   */
  @Post('/api/crm/lookup-test')
  @Auth('admin')
  async testCrmLookup(@Req() req: Request) {
    const data = optionalDict(req.body);
    const phone = String(data.phone || '').trim();
    if (!phone) throw new HttpError(400, 'phone is required');

    const lookupUrl = String(data.lookup_url || (await dbm.getSetting('CRM_LOOKUP_URL', '')) || '').trim();
    try {
      if (!lookupUrl) throw new CrmValueError(LOOKUP_URL_ERROR);
      validateCrmPath(lookupUrl, 'lookup_url');
    } catch {
      throw new HttpError(400, LOOKUP_URL_ERROR);
    }
    const nameTemplate = String(data.lookup_name_template || (await dbm.getSetting('CRM_LOOKUP_NAME_TEMPLATE', '')) || '').trim();
    if (!nameTemplate) throw new HttpError(400, 'lookup_name_template is required');

    let numberFormat = String(
      data.lookup_number_format || (await dbm.getSetting('CRM_LOOKUP_NUMBER_FORMAT', 'digits')) || 'digits',
    ).toLowerCase();
    if (!LOOKUP_NUMBER_FORMATS.includes(numberFormat)) numberFormat = 'digits';
    const md = pyInt(
      data.lookup_match_digits !== null && data.lookup_match_digits !== undefined
        ? data.lookup_match_digits
        : (await dbm.getSetting('CRM_LOOKUP_MATCH_DIGITS', '0')) || 0,
    );
    const matchDigits = md === null ? 0 : Math.max(0, md);

    const cfg = new CRMLookupConfig({
      enabled: true,
      urlTemplate: lookupUrl,
      nameTemplate,
      numberFormat,
      matchDigits,
      verifyPath: String(data.lookup_verify_path || (await dbm.getSetting('CRM_LOOKUP_VERIFY_PATH', '')) || '').trim(),
    });

    const connector = await connectorFromRequest(data);
    try {
      return respond(await runLookupTest(connector, cfg, phone));
    } catch (e) {
      log.error('CRM lookup test failed: %s', e instanceof Error ? e.name : typeof e);
      // A completed request reporting a failed probe. `error` is surfaced on purpose —
      // diagnosing why the CRM rejected the lookup is the point of this admin-only tool —
      // and stays truncated so an upstream body cannot flood the response.
      return respond({
        success: false,
        status_code: null,
        name: null,
        matched: false,
        verify_detail: '',
        raw_excerpt: '',
        error: [...(e instanceof Error ? e.message : String(e))].slice(0, 300).join(''),
      });
    } finally {
      await connector.close().catch(() => undefined);
    }
  }

  // -------------------------------------------------------------------------
  // Contacts (system phonebook). Readable by every signed-in user (the same names are
  // already shown on every dashboard) and by an API key with contacts:read. POST and the
  // bulk upsert take an admin or an API key with contacts:write; PUT and DELETE stay
  // admin-only, so a machine key can never edit or remove a curated contact. Writes reload
  // the resolver's in-memory phonebook so the change wins on the next broadcast tick.
  // -------------------------------------------------------------------------

  /**
   * A phonebook page, alphabetical: {contacts, next_cursor}. Keyset-paginated (`cursor` is
   * opaque, next_cursor null on the last page); `search` matches name, company or number.
   */
  @Get('/api/contacts')
  @Auth({ scope: 'contacts:read' })
  async listContacts(@Req() req: Request) {
    const q = req.query as QueryParams;
    const page = await dbm.contactsPage({
      search: qStr(q, 'search', null as string | null),
      limit: qInt(q, 'limit', 200),
      cursor: qStr(q, 'cursor', null as string | null),
    });
    return { contacts: page.items.map(contactDto), next_cursor: page.next_cursor };
  }

  /** One contact. */
  @Get('/api/contacts/:contact_id')
  @Auth({ scope: 'contacts:read' })
  async getContact(@Req() req: Request) {
    const row = await dbm.getContact(pInt(req.params.contact_id, 'contact_id'));
    if (!row) throw new HttpError(404, 'Contact not found');
    return contactDto(row);
  }

  /**
   * Create a contact. From an admin it is a manual contact and a number already in the
   * phonebook is a 400. From an API key it is an upsert (source 'api'): a sync does not know
   * whether OpDesk has seen a number before, and must not overwrite a manual contact —
   * that write answers 200 with action 'skipped' and the reason.
   */
  @Post('/api/contacts')
  @Auth({ scope: 'contacts:write' })
  async createContact(@Req() req: Request) {
    const body = parseBody(ContactBody, req.body);
    const user = principal(req);
    requireContactWriter(user);
    const [name, phone, key] = await validatedContact(body);
    setRedactedAuditDetail(req, contactAudit(body));
    const company = (body.company || '').trim() || null;
    const notes = (body.notes || '').trim() || null;
    if (!user.api_key) {
      const contactId = await dbm.createContact(name, phone, key, company, notes);
      if (contactId === null) throw new HttpError(400, 'A contact with this phone number already exists');
      await reloadResolverContacts();
      return { id: contactId, action: 'created', reason: null };
    }
    const result = await dbm.contactUpsert(name, phone, key, {
      company,
      notes,
      source: contactSourceFor(user),
      externalId: (body.external_id || '').trim() || null,
      sourceSystem: (body.source_system || '').trim() || null,
    });
    await reloadResolverContacts();
    if (result.id === null) throw new HttpError(400, result.error || 'Contact not written');
    return { id: result.id, action: result.action, reason: result.error };
  }

  /**
   * Upsert up to CONTACT_BULK_MAX contacts. Per-item results rather than all-or-nothing: one
   * bad row in a large sync must not discard the rest, and the caller needs to know which to
   * fix. Each result carries `index`, `id`, `action` (created / updated / skipped) and, on a
   * skip, `reason`; `counts` totals them. Precedence is manual > api > crm.
   */
  @Post('/api/contacts/bulk')
  @Auth({ scope: 'contacts:write' })
  async bulkContacts(@Req() req: Request) {
    const body = parseBody(ContactBulkBody, req.body);
    const user = principal(req);
    requireContactWriter(user);
    const items = body.contacts || [];
    if (!items.length) throw new HttpError(400, 'No contacts supplied');
    if (items.length > CONTACT_BULK_MAX) throw new HttpError(400, `Too many contacts in one request (max ${CONTACT_BULK_MAX})`);
    const source = contactSourceFor(user);
    const md = (await loadCrmLookupConfig()).matchDigits;

    const results: Row[] = [];
    for (const [index, item] of items.entries()) {
      const name = (item.name || '').trim();
      const phone = (item.phone || '').trim();
      const key = lookupCacheKey(phone, md);
      if (!name) {
        results.push({ index, id: null, action: 'skipped', reason: 'Name is required' });
        continue;
      }
      if (!key) {
        results.push({ index, id: null, action: 'skipped', reason: 'Phone must contain digits' });
        continue;
      }
      const res = await dbm.contactUpsert(name, phone, key, {
        company: (item.company || '').trim() || null,
        notes: (item.notes || '').trim() || null,
        source,
        externalId: (item.external_id || '').trim() || null,
        sourceSystem: (item.source_system || '').trim() || null,
      });
      results.push({ index, id: res.id, action: res.action, reason: res.error });
    }
    await reloadResolverContacts();
    const counts: Record<string, number> = { created: 0, updated: 0, skipped: 0 };
    for (const r of results) counts[r.action] = (counts[r.action] ?? 0) + 1;
    setRedactedAuditDetail(req, { contacts: items.map(contactAudit), counts });
    return { results, counts };
  }

  /** Update a contact (admin only). Editing a crm or api row makes it manual. */
  @Put('/api/contacts/:contact_id')
  @Auth('admin')
  async updateContact(@Req() req: Request) {
    const contactId = pInt(req.params.contact_id, 'contact_id');
    const body = parseBody(ContactBody, req.body);
    const [name, phone, key] = await validatedContact(body);
    const result = await dbm.updateContact(
      contactId,
      name,
      phone,
      key,
      (body.company || '').trim() || null,
      (body.notes || '').trim() || null,
    );
    if (result === null) throw new HttpError(400, 'A contact with this phone number already exists');
    if (result === false) throw new HttpError(404, 'Contact not found');
    setRedactedAuditDetail(req, contactAudit(body));
    await reloadResolverContacts();
    return { status: 'ok' };
  }

  /**
   * Delete a contact (admin only). A crm-sourced row may reappear on the number's next call
   * if the CRM still knows it.
   */
  @Delete('/api/contacts/:contact_id')
  @Auth('admin')
  async deleteContact(@Req() req: Request) {
    const contactId = pInt(req.params.contact_id, 'contact_id');
    const row = await dbm.getContact(contactId);
    if (!(await dbm.deleteContact(contactId))) throw new HttpError(404, 'Contact not found');
    if (row) setRedactedAuditDetail(req, { name: row.name, phone: row.phone, source: row.source });
    await reloadResolverContacts();
    return { status: 'ok' };
  }
}
