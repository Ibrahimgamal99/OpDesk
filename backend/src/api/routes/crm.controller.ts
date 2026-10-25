/**
 * CRM and contacts: the CRM connection + call-data sync + contact-lookup configuration, the
 * connection and lookup probes, caller-name resolution for softphones, and the system
 * phonebook (contacts CRUD).
 *
 * Envelopes follow OpDesk's contract per route: /api/crm/test and /api/crm/lookup-test are
 * `{data}`; everything else is bare. Contact writes answer `{status: "ok"}` / `{id}`.
 *
 * Python: the matching server.py routes (+ _connector_from_request, _validated_contact,
 * _reload_resolver_contacts).
 */

import { Controller, Req } from '@nestjs/common';
import type { Request } from 'express';
import { env } from '../../core/config';
import { getLogger, pyStr } from '../../core/logger';
import { pyInt, pyJsonDumps, truthy, waitFor } from '../../core/py';
import { runtime } from '../../core/runtime';
import * as dbm from '../../db/db-manager';
import {
  CRM_SYNC_FIELD_CATALOG,
  CRMConnector,
  CRMLookupConfig,
  createCrmConnector,
  crmCallOutcomes,
  CrmValueError,
  DEFAULT_CRM_SYNC_FIELDS,
  defaultOutboundKeys,
  loadCrmLookupConfig,
  loadCrmSyncConfig,
  LOOKUP_NUMBER_FORMATS,
  lookupCacheKey,
  modernizeStatusMap,
  parseKeyMap,
  parseStatusMap,
  parseSyncFields,
  validateCrmUrl,
} from '../../integrations/crm';
import { applyCrmRuntime, monitoredExtensions, reloadResolverContacts, runLookupTest } from '../../integrations/crm-lookup';
import { AppError, codes } from '../errors';
import { HttpError } from '../http-error';
import { respond } from '../respond';
import { Auth, Delete, Get, Post, Put } from '../routing';
import { parseBody, pInt, qStr, REQUIRED, v } from '../validation';
import type { JsonObject, QueryParams } from '../validation';

const log = getLogger('api.routes.crm');

export const ContactBody = v.model({
  name: v.str(),
  phone: v.str(),
  company: v.str().nullish(),
  notes: v.str().nullish(),
});

/** A `config_data: dict` body. */
const DictBody = v.dict();

/** `config_data: dict = None`: an absent (or JSON null) body is {}. */
function optionalDict(raw: unknown): JsonObject {
  if (raw === undefined || raw === null || (typeof raw === 'string' && raw === '')) return {};
  return parseBody(DictBody, raw);
}

const isOn = (v: unknown) => ['true', '1', 'yes'].includes(String(v ?? '').toLowerCase());

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

/**
 * Build a throwaway connector from posted config values, falling back to saved secrets when a
 * field is masked ("***") or blank. Shared by the connection-test and lookup-test routes;
 * persists nothing. The caller must close() it.
 */
export async function connectorFromRequest(configData: JsonObject): Promise<CRMConnector> {
  const val = async (postedKey: string, settingKey: string, fallback = ''): Promise<string> => {
    const value = configData[postedKey];
    if (value === null || value === undefined || value === '') return settingOrEnv(settingKey, fallback);
    return String(value);
  };
  const secret = async (postedKey: string, settingKey: string): Promise<string> => {
    const value = configData[postedKey];
    if (truthy(value) && value !== '***') return String(value);
    return settingOrEnv(settingKey);
  };

  const serverUrl = ((await val('server_url', 'CRM_SERVER_URL')) || '').trim();
  if (!serverUrl) throw new HttpError(400, 'CRM server URL is required');
  const authType = ((await val('auth_type', 'CRM_AUTH_TYPE', 'api_key')) || 'api_key').toLowerCase();

  // SSRF guard — same rules as save.
  let bp: unknown = configData.block_private;
  if (bp === null || bp === undefined) bp = isOn((await dbm.getSetting('CRM_BLOCK_PRIVATE', 'false')) || 'false');
  try {
    await validateCrmUrl(serverUrl, { blockPrivate: truthy(bp) });
  } catch (e) {
    if (e instanceof CrmValueError) throw new HttpError(400, `Invalid CRM server URL: ${e.message}`);
    throw e;
  }

  const cfg: JsonObject = {
    server_url: serverUrl,
    auth_type: authType,
    endpoint_path: await val('endpoint_path', 'CRM_ENDPOINT_PATH', '/api/calls'),
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
    cfg.oauth2_token_url = await val('oauth2_token_url', 'CRM_OAUTH2_TOKEN_URL');
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

/** Normalise + validate a contact payload -> [name, phone, phone_key]. */
function validatedContact(body: { name: string; phone: string }): [string, string, string] {
  const name = (body.name || '').trim();
  const phone = (body.phone || '').trim();
  if (!name) throw new HttpError(400, 'Name is required');
  const key = lookupCacheKey(phone, 0);
  if (!key) throw new HttpError(400, 'Phone must contain digits');
  return [name, phone, key];
}

const LOOKUP_URL_ERROR = "lookup_url must be a path starting with '/' (it is appended to the CRM server URL)";

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
    const mask = async (key: string) => ((await settingOrEnv(key)) ? '***' : '');

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
   * Save the CRM configuration and apply it live (no restart). PY-quirk kept: not atomic —
   * settings written before a failing validation stay saved.
   */
  @Post('/api/crm/config')
  @Auth('admin')
  async saveCrmConfig(@Req() req: Request) {
    const data = parseBody(DictBody, req.body);

    // Reject an SSRF-unsafe server URL before persisting anything.
    const serverUrlIn = String(data.server_url || '').trim();
    if (truthy(data.enabled) && serverUrlIn) {
      let bp: unknown = data.block_private;
      if (bp === null || bp === undefined) bp = isOn((await dbm.getSetting('CRM_BLOCK_PRIVATE', 'false')) || 'false');
      try {
        await validateCrmUrl(serverUrlIn, { blockPrivate: truthy(bp) });
      } catch (e) {
        if (!(e instanceof CrmValueError)) throw e;
        // The 400 detail only reaches the browser; log the reason too.
        log.warning('CRM config save rejected: invalid server URL (%s)', e.message);
        throw new HttpError(400, `Invalid CRM server URL: ${e.message}`);
      }
    }

    const warnings: string[] = [];
    const set = (key: string, value: unknown) => dbm.setSetting(key, settingValue(value));
    try {
      await set('CRM_ENABLED', truthy(data.enabled) ? 'true' : 'false');
      await set('CRM_SERVER_URL', getOr(data, 'server_url', ''));
      await set('CRM_AUTH_TYPE', getOr(data, 'auth_type', 'api_key'));
      await set('CRM_ENDPOINT_PATH', getOr(data, 'endpoint_path', '/api/calls'));
      await set('CRM_TIMEOUT', pyStr(getOr(data, 'timeout', 30)));
      await set('CRM_VERIFY_SSL', truthy(getOr(data, 'verify_ssl', true)) ? 'true' : 'false');

      // Auth-specific settings. A secret that comes back masked ("***") or empty keeps the
      // stored value.
      const authType = getOr(data, 'auth_type', 'api_key');
      const keepOrSet = async (posted: string, key: string) => {
        const value = getOr(data, posted, '');
        if (truthy(value) && value !== '***') await set(key, value);
      };
      if (authType === 'api_key') {
        await keepOrSet('api_key', 'CRM_API_KEY');
        if (truthy(data.api_key_header)) await set('CRM_API_KEY_HEADER', data.api_key_header);
      } else if (authType === 'basic_auth') {
        if (truthy(data.username)) await set('CRM_USERNAME', data.username);
        await keepOrSet('password', 'CRM_PASSWORD');
      } else if (authType === 'bearer_token') {
        await keepOrSet('bearer_token', 'CRM_BEARER_TOKEN');
      } else if (authType === 'oauth2') {
        if (truthy(data.oauth2_client_id)) await set('CRM_OAUTH2_CLIENT_ID', data.oauth2_client_id);
        await keepOrSet('oauth2_client_secret', 'CRM_OAUTH2_CLIENT_SECRET');
        if (truthy(data.oauth2_token_url)) await set('CRM_OAUTH2_TOKEN_URL', data.oauth2_token_url);
        if (truthy(data.oauth2_scope)) await set('CRM_OAUTH2_SCOPE', data.oauth2_scope);
      }

      // ── Call-data sync (push) settings ──
      // Older clients may POST without these keys; default to "on / all" so nothing is
      // silently disabled.
      await set('CRM_SYNC_ENABLED', truthy(getOr(data, 'sync_enabled', true)) ? 'true' : 'false');
      const syncMethod = pyStr(getOr(data, 'sync_method', 'POST')).toUpperCase();
      await set('CRM_SYNC_METHOD', syncMethod === 'PUT' ? 'PUT' : 'POST');
      if ('sync_endpoint' in data) await set('CRM_SYNC_ENDPOINT', String(data.sync_endpoint || '').trim());
      if ('sync_fields' in data) {
        const rawFields = data.sync_fields;
        const cleaned = parseSyncFields(
          typeof rawFields === 'string' || Array.isArray(rawFields) ? (rawFields as string | unknown[]) : null,
        );
        // Never persist an empty selection — fall back to the compatible default, and say so.
        if (cleaned.length) {
          await set('CRM_SYNC_FIELDS', cleaned.join(','));
          // No field is forced into the body, so a selection with neither identity field
          // produces calls the CRM cannot attribute.
          if (!cleaned.includes('caller') && !cleaned.includes('destination')) {
            warnings.push('Neither Caller nor Destination is selected — the CRM will receive calls it cannot identify.');
          }
        } else {
          await set('CRM_SYNC_FIELDS', DEFAULT_CRM_SYNC_FIELDS.join(','));
          warnings.push('No sync fields were selected — reverted to the default field set.');
        }
      }
      await set('CRM_SYNC_DIR_INBOUND', truthy(getOr(data, 'sync_dir_inbound', true)) ? 'true' : 'false');
      await set('CRM_SYNC_DIR_OUTBOUND', truthy(getOr(data, 'sync_dir_outbound', true)) ? 'true' : 'false');
      await set('CRM_SYNC_DIR_INTERNAL', truthy(getOr(data, 'sync_dir_internal', true)) ? 'true' : 'false');
      await set('CRM_BLOCK_PRIVATE', truthy(getOr(data, 'block_private', false)) ? 'true' : 'false');

      // ── Payload shaping: duration unit, status remap, outbound key rename ──
      // Validated before persisting rather than silently coerced: a dropped rename or a bad
      // unit is invisible in the payload, so the operator has to be told.
      if ('sync_duration_format' in data) {
        const fmt = (truthy(data.sync_duration_format) ? pyStr(data.sync_duration_format) : 'hms').trim().toLowerCase();
        if (fmt !== 'hms' && fmt !== 'seconds') throw new HttpError(400, "sync_duration_format must be 'hms' or 'seconds'");
        await set('CRM_SYNC_DURATION_FORMAT', fmt);
      }
      if ('sync_key_map' in data) {
        const rawMap = truthy(data.sync_key_map) ? data.sync_key_map : {};
        const parsed = parseKeyMap(rawMap);
        if (rawMap && typeof rawMap === 'object' && !Array.isArray(rawMap)) {
          const m = rawMap as JsonObject;
          const dropped = Object.keys(m).filter((k) => !(k in parsed) && String(m[k] || '').trim());
          if (dropped.length) warnings.push('Ignored key rename(s) for unknown outbound key(s): ' + dropped.sort().join(', '));
        }
        await set('CRM_SYNC_KEY_MAP', pyJsonDumps(parsed));
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
        await set('CRM_SYNC_STATUS_MAP', pyJsonDumps(parsed));
      }

      // ── Contact lookup settings ──
      // The lookup URL is a *path template* appended to the already-SSRF-validated server
      // URL; refusing absolute URLs keeps that single validation surface.
      if ('lookup_enabled' in data) await set('CRM_LOOKUP_ENABLED', truthy(data.lookup_enabled) ? 'true' : 'false');
      if ('lookup_url' in data) {
        const lookupUrl = String(data.lookup_url || '').trim();
        if (lookupUrl && (!lookupUrl.startsWith('/') || lookupUrl.includes('://'))) {
          log.warning('CRM config save rejected: lookup_url is not a path (%r)', lookupUrl.slice(0, 80));
          throw new HttpError(400, LOOKUP_URL_ERROR);
        }
        await set('CRM_LOOKUP_URL', lookupUrl);
      }
      if ('lookup_name_template' in data) await set('CRM_LOOKUP_NAME_TEMPLATE', String(data.lookup_name_template || '').trim());
      if ('lookup_number_format' in data) {
        const fmt = (truthy(data.lookup_number_format) ? pyStr(data.lookup_number_format) : 'digits').trim().toLowerCase();
        if (!LOOKUP_NUMBER_FORMATS.includes(fmt)) {
          throw new HttpError(400, `lookup_number_format must be one of: ${LOOKUP_NUMBER_FORMATS.join(', ')}`);
        }
        await set('CRM_LOOKUP_NUMBER_FORMAT', fmt);
      }
      if ('lookup_match_digits' in data) {
        const n = pyInt(truthy(data.lookup_match_digits) ? data.lookup_match_digits : 0);
        if (n === null || n < 0) throw new HttpError(400, 'lookup_match_digits must be an integer >= 0');
        await set('CRM_LOOKUP_MATCH_DIGITS', String(n));
      }
      if ('lookup_verify_path' in data) await set('CRM_LOOKUP_VERIFY_PATH', String(data.lookup_verify_path || '').trim());
      if ('lookup_ttl_hours' in data) {
        const n = pyInt(truthy(data.lookup_ttl_hours) ? data.lookup_ttl_hours : 24);
        if (n === null || n < 1) throw new HttpError(400, 'lookup_ttl_hours must be a positive integer');
        await set('CRM_LOOKUP_TTL_HOURS', String(n));
      }

      log.info('CRM configuration saved to database');

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
      return {
        success: true,
        reload_ok: reloadOk,
        warnings,
        message: reloadOk ? 'CRM configuration saved and applied.' : 'CRM configuration saved (restart required to apply).',
      };
    } catch (e) {
      if (e instanceof HttpError) {
        log.warning('CRM config save rejected (%s): %s', e.status, e.message);
        throw e;
      }
      log.error('Failed to save CRM config: %s', e);
      // NOTE(port): Python put str(e) in this detail; the text stays generic so a DB error
      // never reaches the browser (the code is crm.config.save_failed either way).
      throw new HttpError(500, 'Failed to save CRM configuration: see server logs');
    }
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
    const syncEndpoint =
      String(data.sync_endpoint || (await dbm.getSetting('CRM_SYNC_ENDPOINT', '')) || '').trim() || null;
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
   * background and the client may simply retry.
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
    return { phone, name, enabled: true };
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
    if (!lookupUrl || !lookupUrl.startsWith('/') || lookupUrl.includes('://')) throw new HttpError(400, LOOKUP_URL_ERROR);
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
  // Contacts (system phonebook). Everyone can read (the same names are already shown on
  // every dashboard); only admins can write. Writes reload the resolver's in-memory
  // phonebook so the change wins on the next broadcast tick.
  // -------------------------------------------------------------------------

  /** All contacts (manual and crm-sourced), by name. */
  @Get('/api/contacts')
  @Auth('user')
  async listContacts() {
    return { contacts: await dbm.listContacts() };
  }

  /** Create a manual contact (admin only). */
  @Post('/api/contacts')
  @Auth('admin')
  async createContact(@Req() req: Request) {
    const body = parseBody(ContactBody, req.body);
    const [name, phone, key] = validatedContact(body);
    const contactId = await dbm.createContact(name, phone, key, (body.company || '').trim() || null, (body.notes || '').trim() || null);
    if (contactId === null) throw new HttpError(400, 'A contact with this phone number already exists');
    await reloadResolverContacts();
    return { id: contactId };
  }

  /** Update a contact (admin only). Editing a crm row makes it manual. */
  @Put('/api/contacts/:contact_id')
  @Auth('admin')
  async updateContact(@Req() req: Request) {
    const contactId = pInt(req.params.contact_id, 'contact_id');
    const body = parseBody(ContactBody, req.body);
    const [name, phone, key] = validatedContact(body);
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
    if (!(await dbm.deleteContact(contactId))) throw new HttpError(404, 'Contact not found');
    await reloadResolverContacts();
    return { status: 'ok' };
  }
}
