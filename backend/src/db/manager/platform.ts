/**
 * Platform tables of the app database: OpDesk_settings, device push tokens, RFC 8599
 * push bindings, Web Push (VAPID) rotation, machine-to-machine API keys, the CRM
 * webhook delivery log and the contacts phonebook.
 *
 * Settings are stored in plaintext, as OpDesk always stored them: the Python backend
 * and analytics read OpDesk_settings directly, so encrypting values here would make a
 * rollback unreadable. Masking secrets is the settings route's job.
 */

import { createHash, randomBytes } from 'node:crypto';
import { getLogger } from '../../core/logger';
import { isoformat, pyInt, pyJsonDumps } from '../../core/py';
import { dbErrno, execute, query, queryOne, withTransaction } from '../pool';
import type { Params, Row, SqlValue } from '../pool';

const log = getLogger('db_manager');

// MySQL duplicate-key errno.
export const ERR_DUP_ENTRY = 1062;

/** s[:n] by code point, as Python slices a str (not by UTF-16 unit). */
function pySlice(s: string, n: number): string {
  if (s.length <= n) return s; // every UTF-16 unit count >= code point count
  return Array.from(s).slice(0, n).join('');
}

// ---------------------------------------------------------------------------
// Settings (OpDesk_settings)
// ---------------------------------------------------------------------------

/**
 * A setting value, or `fallback` when the key is missing, its value is empty/NULL, or
 * the DB cannot be read (Python: `result['setting_value'] or default`).
 */
export async function getSetting(key: string, fallback: string | null = null): Promise<string | null> {
  try {
    const row = await queryOne('SELECT setting_value FROM OpDesk_settings WHERE setting_key = ?', [key]);
    if (row) return (row.setting_value as string | null) || fallback;
    return fallback;
  } catch (e) {
    log.warning('⚠️  Database error getting setting %s: %s', key, e);
    return fallback;
  }
}

const UPSERT_SETTING_SQL =
  'INSERT INTO OpDesk_settings (setting_key, setting_value) VALUES (?, ?) ' +
  'ON DUPLICATE KEY UPDATE setting_value = ?, updated_at = CURRENT_TIMESTAMP';

/** Write one setting. True on success. */
export async function setSetting(key: string, value: string | null): Promise<boolean> {
  try {
    await execute(UPSERT_SETTING_SQL, [key, value, value]);
    return true;
  } catch (e) {
    log.error('❌ Failed to set setting %s: %s', key, e);
    return false;
  }
}

/** Write several settings in one transaction: all or none. */
export async function setSettings(values: Record<string, string | null>): Promise<boolean> {
  try {
    await withTransaction(async (conn) => {
      for (const [key, value] of Object.entries(values)) await execute(UPSERT_SETTING_SQL, [key, value, value], conn);
    });
    return true;
  } catch (e) {
    log.error('❌ Failed to set settings %s: %s', Object.keys(values).join(', '), e);
    return false;
  }
}

/**
 * Every setting as {key: value}. {} on error; with `strict` the error is re-raised so a
 * caller can tell "nothing configured" from "database down".
 */
export async function getAllSettings(strict = false): Promise<Record<string, string | null>> {
  const settings: Record<string, string | null> = {};
  try {
    for (const row of await query('SELECT setting_key, setting_value FROM OpDesk_settings')) {
      settings[row.setting_key] = row.setting_value;
    }
  } catch (e) {
    log.warning('⚠️  Database error getting all settings: %s', e);
    if (strict) throw e;
  }
  return settings;
}

// ---------------------------------------------------------------------------
// Device push tokens (FCM / APNs / Web Push)
// ---------------------------------------------------------------------------

/** SHA-256 of a push token: the unique key (the token itself is too long for an index). */
export function tokenHash(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * Register (upsert) a device push token. Re-registering the same token updates its
 * owner/extension and last_seen_at instead of duplicating it. platform: ios | android |
 * web; token_type: voip (iOS PushKit) | alert. For web, `token` is the JSON-encoded
 * Web Push subscription.
 */
export async function registerDeviceToken(
  userId: number | null,
  extension: string | null,
  platform: string,
  tokenType: string,
  token: string,
  appVersion: string | null = null,
): Promise<boolean> {
  if (!['ios', 'android', 'web'].includes(platform) || !['voip', 'alert'].includes(tokenType) || !token) return false;
  try {
    await execute(
      `INSERT INTO device_tokens
           (user_id, extension, platform, token_type, token, token_hash, app_version)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
           user_id = VALUES(user_id),
           extension = VALUES(extension),
           platform = VALUES(platform),
           token_type = VALUES(token_type),
           app_version = VALUES(app_version),
           last_seen_at = CURRENT_TIMESTAMP`,
      [userId, extension || null, platform, tokenType, token, tokenHash(token), appVersion || null],
    );
    return true;
  } catch (e) {
    log.warning('⚠️  Database error registering device token: %s', e);
    return false;
  }
}

/** Delete a device token (logout, or the push provider reported it dead). True when removed. */
export async function deleteDeviceToken(token: string): Promise<boolean> {
  if (!token) return false;
  try {
    return (await execute('DELETE FROM device_tokens WHERE token_hash = ?', [tokenHash(token)])).affectedRows > 0;
  } catch (e) {
    log.warning('⚠️  Database error deleting device token: %s', e);
    return false;
  }
}

/**
 * Rotate a stored Web Push subscription in place (browser 'pushsubscriptionchange'):
 * the row matched by the OLD subscription keeps its owner and gets the new JSON. Never
 * creates a row, so it is safe behind an unauthenticated endpoint. True when rotated.
 */
export async function replaceWebPushSubscription(oldToken: string, newToken: string): Promise<boolean> {
  if (!oldToken || !newToken) return false;
  try {
    const res = await execute(
      "UPDATE device_tokens SET token = ?, token_hash = ?, last_seen_at = CURRENT_TIMESTAMP WHERE token_hash = ? AND platform = 'web'",
      [newToken, tokenHash(newToken), tokenHash(oldToken)],
    );
    return res.affectedRows > 0;
  } catch (e) {
    log.warning('⚠️  Database error rotating web push subscription: %s', e);
    return false;
  }
}

/** Tokens registered for an extension ({token, platform, token_type}), optionally of one type. */
export async function getDeviceTokensForExtension(extension: string, tokenType: string | null = null): Promise<Row[]> {
  if (!extension) return [];
  try {
    let sql = 'SELECT token, platform, token_type FROM device_tokens WHERE extension = ?';
    const params: Params = [extension];
    if (tokenType !== null && tokenType !== undefined) {
      sql += ' AND token_type = ?';
      params.push(tokenType);
    }
    return await query(sql, params);
  } catch (e) {
    log.warning('⚠️  Database error getting device tokens: %s', e);
    return [];
  }
}

/** True when the extension has a device token or an RFC 8599 binding (it can be woken by push). */
export async function extensionHasMobileToken(extension: string): Promise<boolean> {
  if (!extension) return false;
  try {
    if ((await queryOne('SELECT 1 AS found FROM device_tokens WHERE extension = ? LIMIT 1', [extension])) !== null) return true;
  } catch (e) {
    log.warning('⚠️  Database error checking mobile token for %s: %s', extension, e);
    return false;
  }
  return extensionHasSipPushBinding(extension);
}

/**
 * Delete device tokens AND RFC 8599 bindings not refreshed in `days` days (OpDesk's
 * daily housekeeping prunes both with this one call). Returns rows deleted.
 */
export async function pruneStaleDeviceTokens(days = 90): Promise<number> {
  try {
    let count = (await execute('DELETE FROM device_tokens WHERE last_seen_at < NOW() - INTERVAL ? DAY', [days])).affectedRows;
    count += await pruneStaleSipPushBindings(days);
    if (count) log.info('Pruned %s stale device token(s) (not seen in %s+ days)', count, days);
    return count;
  } catch (e) {
    log.warning('⚠️  Database error pruning stale device tokens: %s', e);
    return 0;
  }
}

/** Delete every browser subscription (they are bound to the VAPID key being replaced). Rows deleted. */
export async function deleteWebPushSubscriptions(): Promise<number> {
  try {
    return (await execute("DELETE FROM device_tokens WHERE platform = 'web'")).affectedRows;
  } catch (e) {
    log.warning('⚠️  Database error deleting web push subscriptions: %s', e);
    return 0;
  }
}

/**
 * Write new VAPID key settings and delete every Web Push subscription in one
 * transaction. Rows deleted, or null (nothing changed) on error.
 */
export async function replaceVapidKeys(values: Record<string, string | null>): Promise<number | null> {
  try {
    return await withTransaction(async (conn) => {
      for (const [key, value] of Object.entries(values)) await execute(UPSERT_SETTING_SQL, [key, value, value], conn);
      return (await execute("DELETE FROM device_tokens WHERE platform = 'web'", [], conn)).affectedRows;
    });
  } catch (e) {
    log.error('❌  Database error replacing VAPID keys: %s', e);
    return null;
  }
}

// ---------------------------------------------------------------------------
// RFC 8599 push bindings (pn-provider / pn-prid / pn-param of a REGISTER Contact)
// ---------------------------------------------------------------------------

export const SIP_PUSH_BINDING_COLUMNS =
  'id, extension, pn_provider, pn_prid, pn_param, contact_uri, user_agent, created_at, last_seen_at';

/**
 * The binding key: SHA-256 of extension, provider, prid and param joined by '\n'.
 *
 * The separator is part of the stored data: every existing binding_hash was computed
 * this way, so a different join would insert a duplicate for every phone on its next
 * REGISTER instead of refreshing its row. The extension is in the key because one phone
 * with two accounts sends the same token for both (RFC 8599 §5.2 matches on the rest).
 */
export function sipPushBindingHash(extension: string, provider: string, prid: string, param: string | null | undefined): string {
  return createHash('sha256').update([extension, provider, prid, param || ''].join('\n'), 'utf8').digest('hex');
}

/** Store or refresh one binding. A missing user_agent keeps the stored one. */
export async function upsertSipPushBinding(
  extension: string,
  provider: string,
  prid: string,
  param: string | null = null,
  contactUri: string | null = null,
  userAgent: string | null = null,
): Promise<boolean> {
  if (!extension || !provider || !prid) return false;
  try {
    await execute(
      `INSERT INTO sip_push_bindings
           (extension, pn_provider, pn_prid, pn_param, prid_hash, binding_hash, contact_uri, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
           contact_uri = VALUES(contact_uri),
           user_agent = COALESCE(VALUES(user_agent), user_agent),
           last_seen_at = CURRENT_TIMESTAMP`,
      [
        extension,
        provider,
        prid,
        param || null,
        tokenHash(prid),
        sipPushBindingHash(extension, provider, prid, param),
        contactUri,
        userAgent ? pySlice(userAgent, 255) : null,
      ],
    );
    return true;
  } catch (e) {
    log.warning('⚠️  Database error upserting push binding: %s', e);
    return false;
  }
}

/**
 * Bindings, newest first: all of them, or one extension's. Accepts Python's positional
 * extension or an options object ({extension, limit}); there is no LIMIT unless one is given.
 */
export async function listSipPushBindings(
  arg: string | null | { extension?: string | null; limit?: number | null } = null,
): Promise<Row[]> {
  const opts = arg !== null && typeof arg === 'object' ? arg : { extension: arg };
  let sql = `SELECT ${SIP_PUSH_BINDING_COLUMNS} FROM sip_push_bindings`;
  const params: Params = [];
  if (opts.extension !== null && opts.extension !== undefined) {
    sql += ' WHERE extension = ?';
    params.push(opts.extension);
  }
  sql += ' ORDER BY last_seen_at DESC';
  if (opts.limit !== null && opts.limit !== undefined) {
    sql += ' LIMIT ?';
    params.push(Math.max(1, Math.min(Math.trunc(opts.limit), 5000)));
  }
  try {
    return await query(sql, params);
  } catch (e) {
    if (dbErrno(e) === 1146) log.debug('Database error listing push bindings: %s', e);
    else log.warning('⚠️  Database error listing push bindings: %s', e);
    return [];
  }
}

/** True when the extension has at least one RFC 8599 binding. */
export async function extensionHasSipPushBinding(extension: string): Promise<boolean> {
  if (!extension) return false;
  try {
    return (await queryOne('SELECT 1 AS found FROM sip_push_bindings WHERE extension = ? LIMIT 1', [extension])) !== null;
  } catch (e) {
    log.debug('Database error checking push binding for %s: %s', extension, e);
    return false;
  }
}

/** Forget one binding by id (admin). True when removed. */
export async function deleteSipPushBinding(bindingId: number): Promise<boolean> {
  try {
    return (await execute('DELETE FROM sip_push_bindings WHERE id = ?', [bindingId])).affectedRows > 0;
  } catch (e) {
    log.warning('⚠️  Database error deleting push binding: %s', e);
    return false;
  }
}

/** Delete every binding carrying a token the push provider reported dead. Rows deleted. */
export async function deleteSipPushBindingsByPrid(provider: string, prid: string): Promise<number> {
  try {
    return (await execute('DELETE FROM sip_push_bindings WHERE prid_hash = ? AND pn_provider = ?', [tokenHash(prid), provider]))
      .affectedRows;
  } catch (e) {
    log.warning('⚠️  Database error deleting push bindings: %s', e);
    return 0;
  }
}

/** Delete bindings no REGISTER refreshed in `days` days. Rows deleted (0 when the table is missing). */
export async function pruneStaleSipPushBindings(days = 90): Promise<number> {
  try {
    return (await execute('DELETE FROM sip_push_bindings WHERE last_seen_at < NOW() - INTERVAL ? DAY', [days])).affectedRows;
  } catch (e) {
    log.debug('Database error pruning push bindings: %s', e);
    return 0;
  }
}

// ---------------------------------------------------------------------------
// API keys (machine-to-machine credentials)
// ---------------------------------------------------------------------------
// System-level credentials identified by name and scoped by an explicit permission
// list. The plaintext key ("opd_" + 40 hex) is returned exactly once, at creation; only
// its SHA-256 is stored. Unsalted on purpose: it must be a deterministic lookup key, and
// 160 bits of CSPRNG output leave nothing for a salt or work factor to defend.

export const API_KEY_PREFIX = 'opd_';

const COLS_API_KEYS = 'id, name, key_prefix, key_hash, scopes, enabled, created_by, last_used_at, expires_at, created_at';

/** SHA-256 hex of a plaintext API key. */
export function hashApiKey(plaintext: string): string {
  return createHash('sha256').update(plaintext, 'utf8').digest('hex');
}

/**
 * An incoming expiry as a MySQL DATETIME ('YYYY-MM-DD HH:MM:SS'). Accepts a plain date,
 * an ISO 8601 datetime (T / Z / millis) or empty (=> null, never expires).
 */
export function normalizeExpiry(expiresAt: string | null | undefined): string | null {
  if (!expiresAt) return null;
  let s = expiresAt.trim();
  if (!s) return null;
  s = s.replaceAll('Z', '').replaceAll('T', ' ');
  if (s.includes('.')) s = s.split('.', 1)[0];
  s = s.trim();
  if (Array.from(s).length === 10) s += ' 00:00:00';
  return s;
}

/** A DB row as the public metadata dict (never the hash). */
export function rowToApiKey(row: Row): Row {
  let scopes: unknown;
  try {
    scopes = JSON.parse(row.scopes || '[]');
  } catch {
    scopes = [];
  }
  return {
    id: row.id,
    name: row.name,
    key_prefix: row.key_prefix,
    scopes,
    enabled: Boolean(row.enabled),
    created_by: row.created_by ?? null,
    last_used_at: row.last_used_at ? isoformat(row.last_used_at) : null,
    expires_at: row.expires_at ? isoformat(row.expires_at) : null,
    created_at: row.created_at ? isoformat(row.created_at) : null,
  };
}

/** A fresh plaintext key: "opd_" + 20 random bytes as hex. */
export function generateApiKeyPlaintext(): string {
  return API_KEY_PREFIX + randomBytes(20).toString('hex');
}

/** Create a key. Its metadata plus the one-time plaintext `key`, or null on error. */
export async function createApiKey(
  name: string,
  scopes: string[] | null,
  opts: { createdBy?: number | null; expiresAt?: string | null } = {},
): Promise<Row | null> {
  const plaintext = generateApiKeyPlaintext();
  let keyId: number;
  try {
    const res = await execute(
      'INSERT INTO api_keys (name, key_prefix, key_hash, scopes, created_by, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
      [
        name,
        plaintext.slice(0, 12), // e.g. "opd_ab12cd34"
        hashApiKey(plaintext),
        pyJsonDumps([...(scopes || [])]),
        opts.createdBy ?? null,
        normalizeExpiry(opts.expiresAt),
      ],
    );
    keyId = res.insertId;
  } catch (e) {
    log.error('❌ Error creating API key: %s', e);
    return null;
  }
  const result = await getApiKey(keyId);
  if (result) result.key = plaintext; // shown exactly once, never recoverable afterwards
  return result;
}

/** All keys (metadata only), newest first. */
export async function listApiKeys(): Promise<Row[]> {
  try {
    return (await query(`SELECT ${COLS_API_KEYS} FROM api_keys ORDER BY created_at DESC, id DESC`)).map(rowToApiKey);
  } catch (e) {
    log.warning('⚠️  Error listing API keys: %s', e);
    return [];
  }
}

/** One key's metadata, or null. */
export async function getApiKey(keyId: number): Promise<Row | null> {
  try {
    const row = await queryOne(`SELECT ${COLS_API_KEYS} FROM api_keys WHERE id = ?`, [keyId]);
    return row ? rowToApiKey(row) : null;
  } catch (e) {
    log.warning('⚠️  Error getting API key %s: %s', keyId, e);
    return null;
  }
}

/**
 * Update a key; only given fields change. An `expiresAt` of "" clears the expiry.
 * The updated metadata, or null on error.
 */
export async function updateApiKey(
  keyId: number,
  opts: { name?: string | null; scopes?: string[] | null; enabled?: boolean | null; expiresAt?: string | null } = {},
): Promise<Row | null> {
  const fields: string[] = [];
  const values: Params = [];
  if (opts.name !== null && opts.name !== undefined) {
    fields.push('name = ?');
    values.push(opts.name);
  }
  if (opts.scopes !== null && opts.scopes !== undefined) {
    fields.push('scopes = ?');
    values.push(pyJsonDumps([...opts.scopes]));
  }
  if (opts.enabled !== null && opts.enabled !== undefined) {
    fields.push('enabled = ?');
    values.push(opts.enabled ? 1 : 0);
  }
  if (opts.expiresAt !== null && opts.expiresAt !== undefined) {
    fields.push('expires_at = ?');
    values.push(normalizeExpiry(opts.expiresAt));
  }
  if (!fields.length) return getApiKey(keyId);
  values.push(keyId);
  try {
    await execute(`UPDATE api_keys SET ${fields.join(', ')} WHERE id = ?`, values);
  } catch (e) {
    log.error('❌ Error updating API key %s: %s', keyId, e);
    return null;
  }
  return getApiKey(keyId);
}

/** Delete (revoke) a key. True when a row was removed. */
export async function deleteApiKey(keyId: number): Promise<boolean> {
  try {
    return (await execute('DELETE FROM api_keys WHERE id = ?', [keyId])).affectedRows > 0;
  } catch (e) {
    log.error('❌ Error deleting API key %s: %s', keyId, e);
    return false;
  }
}

/**
 * Validate a presented plaintext key: its metadata (with scopes) when it exists, is
 * enabled and has not expired -- both enforced in SQL -- else null. Stamps last_used_at.
 */
export async function lookupApiKey(plaintext: string | null | undefined): Promise<Row | null> {
  if (!plaintext || !plaintext.startsWith(API_KEY_PREFIX)) return null;
  try {
    const row = await queryOne(
      `SELECT ${COLS_API_KEYS} FROM api_keys WHERE key_hash = ? AND enabled = 1 AND (expires_at IS NULL OR expires_at > NOW())`,
      [hashApiKey(plaintext)],
    );
    if (!row) return null;
    await execute('UPDATE api_keys SET last_used_at = NOW() WHERE id = ?', [row.id]);
    return rowToApiKey(row);
  } catch (e) {
    log.warning('⚠️  Error looking up API key: %s', e);
    return null;
  }
}

// ---------------------------------------------------------------------------
// CRM webhook delivery log (one row per push attempt)
// ---------------------------------------------------------------------------
// PII: rows hold call metadata and the full request body. Request HEADERS are never
// stored (that is where the CRM credentials live); URLs arrive pre-redacted. Rows are
// pruned by pruneWebhookDeliveries.

/** Max characters kept per stored body/error. */
export const DELIVERY_BODY_MAX = 8192;

// The list view leaves the bodies out: a 50-row page with request + response JSON
// would be hundreds of KB.
const DELIVERY_LIST_COLS =
  'id, created_at, call_id, uniqueid, caller, destination, call_type, call_status, ' +
  'method, url, status_code, success, error, duration_ms, attempt, parent_id, ' +
  'resent_by, truncated';

const DELIVERY_ALL_COLS =
  'id, created_at, call_id, uniqueid, caller, destination, call_type, call_status, method, url, ' +
  'request_body, status_code, success, response_body, error, duration_ms, attempt, parent_id, resent_by, truncated';

/** Truncate a body/error to DELIVERY_BODY_MAX code points: [value, wasTruncated]. */
export function clipDeliveryText(value: unknown): [string | null, boolean] {
  if (value === null || value === undefined) return [null, false];
  const s = String(value);
  const cps = Array.from(s);
  if (cps.length <= DELIVERY_BODY_MAX) return [s, false];
  return [cps.slice(0, DELIVERY_BODY_MAX).join('') + '…[truncated]', true];
}

export interface WebhookDeliveryInput {
  url: string;
  method?: string;
  callId?: string | null;
  uniqueid?: string | null;
  caller?: string | null;
  destination?: string | null;
  callType?: string | null;
  callStatus?: string | null;
  requestBody?: string | null;
  statusCode?: number | null;
  success?: boolean;
  responseBody?: string | null;
  error?: string | null;
  durationMs?: number | null;
  attempt?: number;
  parentId?: number | null;
  resentBy?: number | string | null;
  // Python's keyword spellings, accepted as well.
  call_id?: string | null;
  call_type?: string | null;
  call_status?: string | null;
  request_body?: string | null;
  status_code?: number | null;
  response_body?: string | null;
  duration_ms?: number | null;
  parent_id?: number | null;
  resent_by?: number | string | null;
}

/** Record one CRM push attempt (camelCase or Python's snake_case keys). The new row id, or null on error. */
export async function insertWebhookDelivery(d: WebhookDeliveryInput): Promise<number | null> {
  const [req, reqTruncated] = clipDeliveryText(d.requestBody ?? d.request_body);
  const [resp] = clipDeliveryText(d.responseBody ?? d.response_body);
  const [err] = clipDeliveryText(d.error);
  const resentBy = pyInt(d.resentBy ?? d.resent_by);
  try {
    const res = await execute(
      'INSERT INTO webhook_deliveries ' +
        '(call_id, uniqueid, caller, destination, call_type, call_status, method, url, ' +
        ' request_body, status_code, success, response_body, error, duration_ms, ' +
        ' attempt, parent_id, resent_by, truncated) ' +
        'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [
        d.callId ?? d.call_id ?? null,
        d.uniqueid ?? null,
        d.caller ?? null,
        d.destination ?? null,
        d.callType ?? d.call_type ?? null,
        d.callStatus ?? d.call_status ?? null,
        pySlice(d.method || 'POST', 8),
        pySlice(d.url || '', 1024),
        req,
        d.statusCode ?? d.status_code ?? null,
        d.success ? 1 : 0,
        resp,
        err,
        d.durationMs ?? d.duration_ms ?? null,
        pyInt(d.attempt) || 1,
        d.parentId ?? d.parent_id ?? null,
        resentBy,
        reqTruncated ? 1 : 0,
      ],
    );
    return res.insertId;
  } catch (e) {
    log.warning('⚠️  Database error insert_webhook_delivery: %s', e);
    return null;
  }
}

/** success/truncated as booleans and created_at as isoformat, as the API sends a delivery row. */
function shapeDelivery(r: Row): Row {
  r.success = Boolean(r.success);
  r.truncated = Boolean(r.truncated);
  if (r.created_at !== null && r.created_at !== undefined && r.created_at instanceof Date) r.created_at = isoformat(r.created_at);
  return r;
}

export interface WebhookDeliveryFilter {
  success?: boolean | null;
  callId?: string | null;
  callType?: string | null;
  search?: string | null;
  dateFrom?: string | null;
  dateTo?: string | null;
  limit?: number | null;
  afterId?: number | null;
}

/**
 * [rows, hasMore] for the delivery log, newest first, bodies omitted. Keyset paginated
 * on id (`id < afterId`): the table grows by one row per pushed call forever, and an
 * OFFSET would scan and discard every earlier row. One extra row is fetched to answer
 * hasMore without a COUNT. limit is clamped to 1..200 (default 50).
 */
export async function listWebhookDeliveries(f: WebhookDeliveryFilter = {}): Promise<[Row[], boolean]> {
  const limit = Math.max(1, Math.min(pyInt(f.limit) || 50, 200));
  const where: string[] = [];
  const params: SqlValue[] = [];
  if (f.success !== null && f.success !== undefined) {
    where.push('success = ?');
    params.push(f.success ? 1 : 0);
  }
  if (f.callId) {
    where.push('call_id = ?');
    params.push(String(f.callId));
  }
  if (f.callType) {
    where.push('call_type = ?');
    params.push(String(f.callType));
  }
  if (f.search) {
    where.push('(caller LIKE ? OR destination LIKE ? OR call_id LIKE ? OR uniqueid LIKE ?)');
    const like = `%${f.search}%`;
    params.push(like, like, like, like);
  }
  if (f.dateFrom) {
    where.push('created_at >= ?');
    params.push(f.dateFrom);
  }
  if (f.dateTo) {
    // A bare date includes the whole end day.
    where.push(String(f.dateTo).length === 10 ? 'created_at < DATE_ADD(?, INTERVAL 1 DAY)' : 'created_at <= ?');
    params.push(f.dateTo);
  }
  if (f.afterId !== null && f.afterId !== undefined) {
    const after = pyInt(f.afterId);
    if (after !== null) {
      where.push('id < ?');
      params.push(after);
    }
  }
  const clause = where.length ? ' WHERE ' + where.join(' AND ') : '';
  try {
    const rows = (
      await query(`SELECT ${DELIVERY_LIST_COLS} FROM webhook_deliveries${clause} ORDER BY id DESC LIMIT ?`, [...params, limit + 1])
    ).map(shapeDelivery);
    return [rows.slice(0, limit), rows.length > limit];
  } catch (e) {
    log.warning('⚠️  Database error list_webhook_deliveries: %s', e);
    return [[], false];
  }
}

/** One delivery with its request/response bodies, or null. */
export async function getWebhookDelivery(deliveryId: number): Promise<Row | null> {
  try {
    const row = await queryOne(`SELECT ${DELIVERY_ALL_COLS} FROM webhook_deliveries WHERE id = ?`, [deliveryId]);
    return row ? shapeDelivery(row) : null;
  } catch (e) {
    log.warning('⚠️  Database error get_webhook_delivery %s: %s', deliveryId, e);
    return null;
  }
}

/**
 * Delete deliveries older than `days` (min 1, default 30 for a non-number). Rows
 * removed. Runs from the daily housekeeping job, not a MySQL EVENT: the event scheduler
 * needs SUPER to enable and is off on these boxes.
 */
export async function pruneWebhookDeliveries(days: unknown = 30): Promise<number> {
  const n = pyInt(days);
  const d = n === null ? 30 : Math.max(1, n);
  try {
    return (await execute('DELETE FROM webhook_deliveries WHERE created_at < DATE_SUB(NOW(), INTERVAL ? DAY)', [d])).affectedRows || 0;
  } catch (e) {
    log.warning('⚠️  Database error prune_webhook_deliveries: %s', e);
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Contacts (system phonebook)
// ---------------------------------------------------------------------------
// One row per phone_key (the normalized match key the caller derives). source 'manual'
// rows are admin-curated; 'crm' rows are inserted by the CRM lookup and never overwrite
// an existing number. Editing a crm row flips it to manual.

const COLS_CONTACTS = 'id, name, phone, phone_key, company, notes, source, created_at, updated_at';

/** Every contact, manual and crm, by name. [] on error. */
export async function listContacts(): Promise<Row[]> {
  try {
    return await query(`SELECT ${COLS_CONTACTS} FROM contacts ORDER BY name, id`);
  } catch (e) {
    log.warning('⚠️  Database error list_contacts: %s', e);
    return [];
  }
}

/**
 * Insert a manual contact (name/phone/phone_key clipped to 255/64/32, company to 255).
 * The new id, or null when phone_key is taken or on error.
 */
export async function createContact(
  name: string,
  phone: string,
  phoneKey: string,
  company: string | null = null,
  notes: string | null = null,
): Promise<number | null> {
  try {
    const res = await execute(
      "INSERT INTO contacts (name, phone, phone_key, company, notes, source) VALUES (?,?,?,?,?,'manual')",
      [pySlice(name, 255), pySlice(phone, 64), pySlice(phoneKey, 32), company ? pySlice(company, 255) : null, notes || null],
    );
    return res.insertId;
  } catch (e) {
    if (dbErrno(e) === ERR_DUP_ENTRY) return null;
    log.warning('⚠️  Database error create_contact: %s', e);
    return null;
  }
}

/**
 * Update a contact and flip it to source='manual'. True on success, false when the id
 * does not exist, null when the new phone_key collides with another contact.
 */
export async function updateContact(
  contactId: number,
  name: string,
  phone: string,
  phoneKey: string,
  company: string | null = null,
  notes: string | null = null,
): Promise<boolean | null> {
  try {
    const res = await execute(
      "UPDATE contacts SET name=?, phone=?, phone_key=?, company=?, notes=?, source='manual' WHERE id=?",
      [pySlice(name, 255), pySlice(phone, 64), pySlice(phoneKey, 32), company ? pySlice(company, 255) : null, notes || null, contactId],
    );
    if (res.affectedRows) return true;
    // 0 is both "no such id" and "nothing changed": tell them apart.
    return (await queryOne('SELECT 1 AS found FROM contacts WHERE id=?', [contactId])) !== null;
  } catch (e) {
    if (dbErrno(e) === ERR_DUP_ENTRY) return null;
    log.warning('⚠️  Database error update_contact: %s', e);
    return false;
  }
}

/** Delete a contact. True when a row was removed. */
export async function deleteContact(contactId: number): Promise<boolean> {
  try {
    return ((await execute('DELETE FROM contacts WHERE id=?', [contactId])).affectedRows || 0) > 0;
  } catch (e) {
    log.warning('⚠️  Database error delete_contact: %s', e);
    return false;
  }
}

/**
 * Insert a CRM-resolved contact unless the number already exists (INSERT IGNORE:
 * manual data is never overwritten by a lookup). True when a row was added.
 */
export async function addCrmContactIfNew(phone: string, phoneKey: string, name: string): Promise<boolean> {
  if (!phoneKey || !name) return false;
  try {
    const res = await execute("INSERT IGNORE INTO contacts (name, phone, phone_key, source) VALUES (?,?,?,'crm')", [
      pySlice(name, 255),
      pySlice(phone || '', 64),
      pySlice(phoneKey, 32),
    ]);
    return (res.affectedRows || 0) > 0;
  } catch (e) {
    log.warning('⚠️  Database error add_crm_contact_if_new: %s', e);
    return false;
  }
}

/** Every [phone_key, name] pair, for the ContactResolver's in-memory map (Python returned tuples). */
export async function getContactsForResolver(): Promise<[string, string][]> {
  try {
    return (await query('SELECT phone_key, name FROM contacts')).map((r) => [r.phone_key, r.name] as [string, string]);
  } catch (e) {
    log.warning('⚠️  Database error get_contacts_for_resolver: %s', e);
    return [];
  }
}
