/**
 * The PBX side of db_manager.py: what OpDesk reads from and writes to the FreePBX /
 * IssabelPBX `asterisk` database (extensions, names, queues, PJSIP keywords, WebRTC
 * options).
 *
 * Connections: Python's `get_db_config(DB_PASSWORD, DB_NAME)` is the 'pbx' pool,
 * `get_db_config(DB_PASSWORD, DB_CDR)` the 'cdr' pool, `DB_OpDesk` the 'app' pool.
 *
 * FreePBX and Issabel 5 share the FreePBX 2.x table lineage (users, devices, sip,
 * queues_config), but several tables exist on FreePBX only: ps_endpoints (realtime
 * PJSIP, usually absent on both), kvstore_* and certman_mapping. Every read of those is
 * optional: errno 1146 (no such table) degrades to "nothing there", never to an error.
 *
 * Row existence: the pool runs with -FOUND_ROWS, so an UPDATE's affectedRows counts
 * rows CHANGED, not matched -- writing the value a row already holds reads 0. Code here
 * that must know whether a row exists asks with rowExists() first (same connection or
 * transaction as the write) instead of reading 0 as "no row".
 */

import * as path from 'path';
import type { PoolConnection } from 'mysql2/promise';
import { getLogger, pyStr } from '../../core/logger';
import { pyInt, truthy } from '../../core/py';
import { dbErrno, execute, query, queryOne, withConnection, withTransaction } from '../pool';
import type { Executor, Params, Row } from '../pool';

const log = getLogger('db_manager');

// MySQL "table doesn't exist": Issabel has no kvstore_* / certman_mapping, and no box
// here has ps_endpoints. Reads of those tables treat it as "empty".
export const ERR_NO_SUCH_TABLE = 1146;

/**
 * True when `SELECT 1 FROM <from> WHERE <where>` finds a row. `from` and `where` are
 * fixed SQL from the caller; values stay parameterized. Use it on the connection that
 * then writes, so the check and the write see the same transaction.
 */
async function rowExists(from: string, where: string, params: Params, target: Executor): Promise<boolean> {
  return (await queryOne(`SELECT 1 AS found FROM ${from} WHERE ${where} LIMIT 1`, params, target)) !== null;
}

// ---------------------------------------------------------------------------
// SIP reload hook
// ---------------------------------------------------------------------------

type SipReloader = (pbx: string | null) => unknown;
let sipReloader: SipReloader | null | undefined;

/**
 * Override how setExtensionWebrtc reloads Asterisk after a SIP keyword change (tests,
 * or a caller that batches reloads). null disables the reload.
 */
export function setSipReloader(fn: SipReloader | null): void {
  sipReloader = fn;
}

/**
 * The dialplan service's reloadAsteriskSip, looked up when first needed. Python did
 * `try: from dialplan import reload_asterisk_sip except ImportError: None`; the lookup
 * is by path at run time for the same reason -- this module must load (and its tests
 * run) without the service.
 */
function resolveSipReloader(): SipReloader | null {
  if (sipReloader !== undefined) return sipReloader;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require(path.join(__dirname, '..', '..', 'services', 'dialplan')) as { reloadAsteriskSip?: SipReloader };
    sipReloader = typeof mod.reloadAsteriskSip === 'function' ? mod.reloadAsteriskSip : null;
  } catch {
    sipReloader = null;
  }
  return sipReloader;
}

// ---------------------------------------------------------------------------
// Extensions and queues
// ---------------------------------------------------------------------------

/**
 * SQL fragment: the bare extension behind a CDR channel name, for every channel form
 * Asterisk produces here.
 *
 *     PJSIP/1003-0000abcd          -> 1003
 *     Local/1003@from-queue-0001;1 -> 1003   (queue member leg)
 *     PJSIP/trunk-0000abcd         -> trunk  (never matches an extension)
 *
 * Cutting at '@' first is what makes the Local form work: the '-' inside the context
 * name ('from-queue') comes before the channel's own '-uniqueid' tail, so cutting on
 * '-' alone yields '1003@from'. `column` is a fixed identifier chosen by the caller,
 * never request input.
 */
export function cdrChannelExt(column: string): string {
  return `SUBSTRING_INDEX(SUBSTRING_INDEX(SUBSTRING_INDEX(${column}, '@', 1), '-', 1), '/', -1)`;
}

/**
 * Extension numbers from the PBX database: asterisk.users, else the numeric
 * ps_endpoints ids.
 *
 * Returns a list on success (possibly empty when the PBX genuinely has no extensions),
 * or null when the DB could not be read at all: the connection failed, or BOTH source
 * queries failed. Callers use null-vs-[] to avoid pruning local agents on a transient
 * read failure, so a failing users query followed by a missing ps_endpoints table must
 * read as null, not [].
 */
export async function getExtensionsFromDb(): Promise<string[] | null> {
  try {
    return await withConnection(async (conn) => {
      let extensions: string[] = [];
      let readOk = false;

      // Try FreePBX users table first
      try {
        const users = await query('SELECT extension FROM users ORDER BY extension', [], conn);
        extensions = users.filter((u) => truthy(u.extension)).map((u) => String(u.extension));
        readOk = true;
      } catch {
        /* fall through to ps_endpoints */
      }

      // If no extensions found, try PJSIP endpoints
      if (!extensions.length) {
        try {
          const endpoints = await query(
            "SELECT id FROM ps_endpoints WHERE id REGEXP '^[0-9]+$' ORDER BY CAST(id AS UNSIGNED)",
            [],
            conn,
          );
          extensions = endpoints.filter((e) => truthy(e.id)).map((e) => String(e.id));
          readOk = true;
        } catch {
          /* no realtime PJSIP table: normal on FreePBX and Issabel */
        }
      }

      // Neither source query succeeded: a read failure, not an empty PBX.
      return readOk ? extensions : null;
    }, 'pbx');
  } catch (e) {
    log.warning('⚠️  Database error getting extensions: %s', e);
    return null;
  }
}

/**
 * Does this extension exist in the PBX (asterisk.users or asterisk.devices)?
 * null when the read fails, so a caller never mistakes an outage for "not provisioned".
 */
export async function extensionExistsInPbx(extension: string): Promise<boolean | null> {
  const ext = pyStr(extension ?? '').trim();
  if (!ext || extension === null || extension === undefined) return false;
  try {
    let found = (await queryOne('SELECT 1 AS found FROM users WHERE extension = ? LIMIT 1', [ext], 'pbx')) !== null;
    if (!found) {
      found = (await queryOne('SELECT 1 AS found FROM devices WHERE id = ? LIMIT 1', [ext], 'pbx')) !== null;
    }
    return found;
  } catch (e) {
    log.warning('⚠️  Database error extension_exists_in_pbx(%s): %s', ext, e);
    return null;
  }
}

/** Extension -> display name, from asterisk.users, topped up from ps_endpoints.description. */
export async function getExtensionNamesFromDb(): Promise<Record<string, string>> {
  const extensionNames: Record<string, string> = {};
  try {
    await withConnection(async (conn) => {
      // Try FreePBX users table first (name field)
      try {
        const users = await query('SELECT extension, name FROM users WHERE extension IS NOT NULL ORDER BY extension', [], conn);
        for (const u of users) {
          if (!truthy(u.extension)) continue;
          const name: string = u.name || '';
          if (name) extensionNames[String(u.extension)] = name;
        }
      } catch (e) {
        log.debug('Could not get names from users table: %s', e);
      }

      // Fill in any extension still missing a name from PJSIP endpoints (per-extension
      // fallback, not all-or-nothing, so a partial users.name table still gets topped up).
      try {
        const endpoints = await query(
          "SELECT id, description FROM ps_endpoints WHERE id REGEXP '^[0-9]+$' ORDER BY CAST(id AS UNSIGNED)",
          [],
          conn,
        );
        for (const e of endpoints) {
          if (!truthy(e.id)) continue;
          const ext = String(e.id);
          const name: string = e.description || '';
          if (name && !(ext in extensionNames)) extensionNames[ext] = name;
        }
      } catch (e) {
        log.debug('Could not get names from ps_endpoints table: %s', e);
      }
    }, 'pbx');
  } catch (e) {
    log.warning('⚠️  Database error getting extension names: %s', e);
  }
  return extensionNames;
}

/** Queue extension -> description, from asterisk.queues_config. */
export async function getQueueNamesFromDb(): Promise<Record<string, string>> {
  const queueNames: Record<string, string> = {};
  try {
    await withConnection(async (conn) => {
      try {
        const rows = await query(
          'SELECT extension, descr FROM queues_config WHERE extension IS NOT NULL ORDER BY extension',
          [],
          conn,
        );
        for (const q of rows) {
          if (!truthy(q.extension)) continue;
          const name: string = q.descr || '';
          if (name) queueNames[String(q.extension)] = name;
        }
      } catch (e) {
        log.debug('Could not get names from queues_config table: %s', e);
      }
    }, 'pbx');
  } catch (e) {
    log.warning('⚠️  Database error getting queue names: %s', e);
  }
  return queueNames;
}

// ---------------------------------------------------------------------------
// Recording policy (queues and outbound routes, FreePBX config tables)
// ---------------------------------------------------------------------------

export interface QueueRecording {
  queue: string;
  name: string;
  recording: boolean;
}

/**
 * FreePBX queues with their recording state. monitor_type is empty when the queue is
 * not recorded and 'mixmon' (or similar) when it is. [] on error or with no queues.
 */
export async function getQueuesWithRecording(): Promise<QueueRecording[]> {
  const queues: QueueRecording[] = [];
  try {
    const rows = await query(
      'SELECT extension, descr, monitor_type FROM queues_config WHERE extension IS NOT NULL ORDER BY extension',
      [],
      'pbx',
    );
    for (const q of rows) {
      if (!truthy(q.extension)) continue;
      queues.push({
        queue: String(q.extension),
        name: q.descr || '',
        recording: Boolean(String(q.monitor_type || '').trim()),
      });
    }
  } catch (e) {
    log.warning('⚠️  Database error getting queues: %s', e);
  }
  return queues;
}

export interface OutboundRouteRecording {
  route_id: string;
  name: string;
  outcid: string;
  mode: string;
  recording: boolean;
}

/**
 * Outbound routes with their recording mode (callrecording_module, display='routing').
 * Recording is governed per route because a route that overrides the outbound caller ID
 * breaks FreePBX's per-extension recording lookup. [] on error, including on a PBX that
 * has no outbound_routes / callrecording_module tables.
 */
export async function getOutboundRoutesRecording(): Promise<OutboundRouteRecording[]> {
  const routes: OutboundRouteRecording[] = [];
  try {
    const rows = await query(
      'SELECT r.route_id, r.name, r.outcid, ' +
        "  COALESCE(m.callrecording, 'dontcare') AS callrecording " +
        'FROM outbound_routes r ' +
        'LEFT JOIN callrecording_module m ' +
        "  ON m.display='routing' AND m.extension = r.route_id " +
        'ORDER BY r.route_id',
      [],
      'pbx',
    );
    for (const row of rows) {
      const mode = String(row.callrecording || 'dontcare').trim();
      routes.push({
        route_id: String(row.route_id),
        name: row.name || `Route ${pyStr(row.route_id)}`,
        outcid: row.outcid || '',
        mode,
        recording: mode === 'force' || mode === 'yes',
      });
    }
  } catch (e) {
    if (dbErrno(e) === ERR_NO_SUCH_TABLE) log.debug('No outbound route recording tables: %s', e);
    else log.warning('⚠️  Database error getting outbound route recording: %s', e);
  }
  return routes;
}

/**
 * Set an outbound route's recording mode in callrecording_module. The caller reloads
 * (fwconsole reload). Upserts by existence, not by affectedRows: re-saving a route's
 * current mode reads 0 changed rows and would INSERT a duplicate (nothing is unique there).
 */
export async function setOutboundRouteMonitor(routeId: string, mode: string): Promise<boolean> {
  try {
    await withTransaction(async (conn) => {
      if (await rowExists('callrecording_module', "display='routing' AND extension=?", [String(routeId)], conn)) {
        await execute(
          "UPDATE callrecording_module SET callrecording=? WHERE display='routing' AND extension=?",
          [mode, String(routeId)],
          conn,
        );
      } else {
        await execute(
          "INSERT INTO callrecording_module (extension, cidnum, callrecording, display) VALUES (?, '', ?, 'routing')",
          [String(routeId), mode],
          conn,
        );
      }
    }, 'pbx');
    return true;
  } catch (e) {
    log.error('❌  Database error setting outbound route recording: %s', e);
    return false;
  }
}

/**
 * Set queues_config.monitor_type for one queue. True when the queue row exists (even
 * if it already held `monitorType`), false when it does not. The caller reloads.
 */
export async function setQueueMonitorType(queue: string, monitorType: string): Promise<boolean> {
  try {
    return await withConnection(async (conn) => {
      if (!(await rowExists('queues_config', 'extension = ?', [String(queue)], conn))) {
        log.warning('set_queue_monitor_type: no queue row for %s', queue);
        return false;
      }
      await execute('UPDATE queues_config SET monitor_type = ? WHERE extension = ?', [monitorType, String(queue)], conn);
      return true;
    }, 'pbx');
  } catch (e) {
    log.error('❌  Database error setting queue monitor_type: %s', e);
    return false;
  }
}

// ---------------------------------------------------------------------------
// PJSIP keywords (asterisk.sip: one row per (id, keyword))
// ---------------------------------------------------------------------------

/** The SIP secret of an extension, or null. */
export async function getExtensionSecretFromDb(extension: string): Promise<string | null> {
  let secret: string | null = null;
  try {
    await withConnection(async (conn) => {
      try {
        const rows = await query("SELECT data FROM sip WHERE id = ? and keyword = 'secret'", [extension], conn);
        secret = rows.length ? rows[0].data : null;
      } catch (e) {
        log.debug('Could not get extension secret from database: %s', e);
      }
    }, 'pbx');
  } catch (e) {
    log.warning('⚠️  Database error getting extension secret: %s', e);
  }
  return secret;
}

// The PJSIP keywords a softphone needs to register and negotiate media. FreePBX and
// Issabel spell two of them differently (icesupport/ice_support, avpf/use_avpf).
export const SOFTPHONE_SIP_PROFILE_SQL =
  'SELECT keyword, data FROM sip WHERE id = ? AND keyword IN (' +
  "'secret', 'username', 'transport', 'media_encryption', " +
  "'icesupport', 'ice_support', 'avpf', 'use_avpf', 'rtcp_mux', 'allow')";

/**
 * The softphone-relevant PJSIP keywords for one extension, as {keyword: data}.
 * Keywords with no row are absent. null when the DB could not be read, kept distinct
 * from {} (no sip rows at all) so an outage is not reported as "no encryption, no ICE".
 */
export async function getExtensionSipProfile(extension: string): Promise<Record<string, string> | null> {
  try {
    const rows = await query(SOFTPHONE_SIP_PROFILE_SQL, [String(extension)], 'pbx');
    const out: Record<string, string> = {};
    for (const r of rows) out[r.keyword] = r.data || '';
    return out;
  } catch (e) {
    log.warning('⚠️  Database error getting SIP profile (%s): %s', extension, e);
    return null;
  }
}

/**
 * A PJSIP `allow` value as a list in priority order: 'opus,ULAW&alaw,opus' ->
 * ['opus', 'ulaw', 'alaw']. Lowercased and de-duplicated (first wins), as Asterisk reads it.
 */
export function parseCodecList(value: string | null | undefined): string[] {
  const out = new Set<string>();
  for (const c of (value || '').split(/[,&]/)) {
    if (c.trim()) out.add(c.trim().toLowerCase());
  }
  return [...out];
}

/**
 * The PBX-wide audio codec list in priority order (FreePBX keeps it as
 * kvstore_Sipsettings.voicecodecs = {"alaw": 1, "ulaw": 2, ...}). [] when there is none
 * (Issabel has no kvstore tables, or the value is unreadable); null when the DB could
 * not be read.
 */
export async function getPbxDefaultCodecs(): Promise<string[] | null> {
  let row: Row | null;
  try {
    row = await queryOne("SELECT val FROM kvstore_Sipsettings WHERE `key` = 'voicecodecs'", [], 'pbx');
  } catch (e) {
    if (dbErrno(e) === ERR_NO_SUCH_TABLE) return [];
    log.warning('⚠️  Database error getting the PBX codec list: %s', e);
    return null;
  }
  try {
    const prefs: unknown = row && row.val ? JSON.parse(row.val) : {};
    if (prefs === null || typeof prefs !== 'object' || Array.isArray(prefs)) throw new TypeError('not an object');
    const entries = Object.entries(prefs as Record<string, unknown>).map(([c, p]) => {
      const n = pyInt(p);
      if (n === null) throw new TypeError(`invalid priority ${pyStr(p)}`);
      return [c, n] as const;
    });
    return entries.sort((a, b) => a[1] - b[1]).map(([c]) => c);
  } catch (e) {
    log.warning('⚠️  Unreadable PBX codec list %s: %s', row ? row.val : null, e);
    return [];
  }
}

// What Settings → Audio codecs offers: the audio codecs FreePBX's own SIP Settings page
// lists on a stock install, so any of them can be switched back on after being removed.
export const STANDARD_AUDIO_CODECS: readonly string[] = ['opus', 'ulaw', 'alaw', 'g722', 'gsm', 'g726', 'ilbc'];

/**
 * Write the PBX-wide audio codec list, first = preferred, where FreePBX's Settings →
 * Asterisk SIP Settings keeps it ({"opus": 1, "ulaw": 2, ...}). Writes the row only; the
 * caller reloads. Every extension without its own `allow` row gets this list when FreePBX
 * next regenerates its endpoints. FreePBX only: Issabel has no kvstore tables.
 */
export async function setPbxDefaultCodecs(codecs: string[]): Promise<boolean> {
  const val = JSON.stringify(Object.fromEntries(codecs.map((c, i) => [c, i + 1])));
  try {
    await execute(
      "INSERT INTO kvstore_Sipsettings (`key`, val, type, id) VALUES ('voicecodecs', ?, 'json-arr', 'noid') " +
        'ON DUPLICATE KEY UPDATE val = VALUES(val)',
      [val],
      'pbx',
    );
    return true;
  } catch (e) {
    log.warning('⚠️  Database error set_pbx_default_codecs: %s', e);
    return false;
  }
}

/**
 * Insert or update one keyword row of asterisk.sip.
 *
 * One INSERT ... ON DUPLICATE KEY UPDATE, not Python's UPDATE-then-INSERT-on-zero-rows:
 * with -FOUND_ROWS an UPDATE writing the value a row already holds reports 0, and the
 * fallback INSERT then hits the (id, keyword) primary key. Same end state either way.
 */
export async function upsertSipKeyword(extension: string, keyword: string, value: string): Promise<boolean> {
  try {
    await execute(
      'INSERT INTO sip (id, keyword, data) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE data = VALUES(data)',
      [extension, keyword, value],
      'pbx',
    );
    return true;
  } catch (e) {
    log.warning('⚠️  Database error _upsert_sip_keyword (%s): %s', keyword, e);
    return false;
  }
}

/** Update the SIP secret for an extension in the Asterisk DB. */
export async function setExtensionSecretInPbx(extension: string, secret: string): Promise<boolean> {
  return upsertSipKeyword(extension, 'secret', secret);
}

/** Update the SIP username for an extension in the Asterisk DB. */
export async function setExtensionUsernameInPbx(extension: string, username: string): Promise<boolean> {
  return upsertSipKeyword(extension, 'username', username);
}

// How many devices may hold a registration on one extension at the same time. FreePBX and
// Issabel provision every AOR with max_contacts=1 and remove_existing=yes, so the second
// client to REGISTER evicts the first: a user signed in on the web softphone and the mobile
// app is reachable on only one. At 2 Asterisk keeps a contact per device and
// PJSIP_DIAL_CONTACTS() forks a channel to each; the first to answer wins.
export const SINGLE_DEVICE_MAX_CONTACTS = 1;
export const MULTI_DEVICE_MAX_CONTACTS = 2;

/**
 * Current PJSIP max_contacts of an extension. null when the DB could not be read, kept
 * distinct from a number: the UI draws a toggle from it, and an outage must not read as
 * "single device" for an extension that is in fact set to 2.
 */
export async function getExtensionMaxContacts(extension: string): Promise<number | null> {
  try {
    const row = await queryOne("SELECT data FROM sip WHERE id = ? AND keyword = 'max_contacts'", [String(extension)], 'pbx');
    // No row: an endpoint built by hand, whose AOR carries no max_contacts line, so
    // Asterisk's own default applies, which is 1.
    if (!row || !pyStr(row.data ?? '').trim()) return SINGLE_DEVICE_MAX_CONTACTS;
    const n = pyInt(pyStr(row.data).trim());
    if (n === null) {
      log.warning('⚠️  Unreadable max_contacts for %s: %s', extension, row.data);
      return null;
    }
    return n;
  } catch (e) {
    log.warning('⚠️  Database error getting max_contacts (%s): %s', extension, e);
    return null;
  }
}

/**
 * Set how many devices may register on one extension at once, then apply the PBX config
 * (max_contacts lives on the AOR, regenerated by fwconsole reload / amportal a r). Values
 * outside 1..MULTI_DEVICE_MAX_CONTACTS are refused, not clamped. `reload: false` leaves the
 * reload to a caller that changes several keywords in a row.
 */
export async function setExtensionMaxContacts(
  extension: string,
  maxContacts: number | string,
  opts: { pbx?: string | null; reload?: boolean } = {},
): Promise<boolean> {
  const n = pyInt(maxContacts);
  if (n === null || n < SINGLE_DEVICE_MAX_CONTACTS || n > MULTI_DEVICE_MAX_CONTACTS) {
    log.warning('set_extension_max_contacts (%s): %s refused', extension, maxContacts);
    return false;
  }
  if (!(await upsertSipKeyword(String(extension), 'max_contacts', String(n)))) return false;
  if (opts.reload ?? true) {
    const reload = resolveSipReloader();
    if (reload) await reload(opts.pbx ?? null);
  }
  log.info('max_contacts for extension %s set to %s', extension, n);
  return true;
}

/**
 * Update the display name of an extension in asterisk.users.
 *
 * UPDATE only, as OpDesk always did: an extension with no users row is left alone.
 * Inserting a bare users row would make FreePBX list it as a Virtual Extension.
 */
export async function setExtensionNameInPbx(extension: string, name: string): Promise<boolean> {
  try {
    await execute('UPDATE users SET name = ? WHERE extension = ?', [name, extension], 'pbx');
    return true;
  } catch (e) {
    log.warning('⚠️  Database error set_extension_name_in_pbx: %s', e);
    return false;
  }
}

export interface ExtensionWebrtc {
  extension: string;
  name: string;
  webrtc: string;
}

/**
 * The only source of the WebRTC tab's extension list: OpDesk users with an extension,
 * unique by extension. [{extension, name, webrtc}].
 */
export async function getExtensionsWithWebrtcFromUsers(): Promise<ExtensionWebrtc[]> {
  const seen = new Set<string>();
  const out: ExtensionWebrtc[] = [];
  try {
    const rows = await query(
      "SELECT extension, name, COALESCE(webrtc, 'no') AS webrtc FROM users WHERE extension IS NOT NULL AND extension != '' ORDER BY extension",
    );
    for (const row of rows) {
      if (!truthy(row.extension)) continue;
      const ext = String(row.extension);
      if (seen.has(ext)) continue;
      seen.add(ext);
      out.push({
        extension: ext,
        name: String(row.name || '').trim() || ext,
        webrtc: String(row.webrtc || 'no').trim().toLowerCase(),
      });
    }
  } catch (e) {
    log.warning('get_extensions_with_webrtc_from_users: %s', e);
  }
  return out;
}

/**
 * UPDATE one sip keyword row and, with `insertMissing` (Issabel), INSERT it when the
 * row does not exist. Returns rows changed (0 when the row already held `value`); the
 * caller sums them to decide whether Asterisk needs a SIP reload.
 */
export async function setSipKeywordRow(
  conn: PoolConnection,
  ext: string,
  keyword: string,
  value: string,
  insertMissing: boolean,
): Promise<number> {
  if (insertMissing && !(await rowExists('sip', 'id = ? AND keyword = ?', [ext, keyword], conn))) {
    return (await execute('INSERT INTO sip (id, keyword, data) VALUES (?, ?, ?)', [ext, keyword, value], conn)).affectedRows;
  }
  return (await execute('UPDATE sip SET data = ? WHERE id = ? AND keyword = ?', [value, ext, keyword], conn)).affectedRows;
}

// Issabel spells the WebRTC keywords its own way and may lack the rows, so every one
// is written (inserted when missing). Codec order is OpDesk's, unchanged.
const ISSABEL_WEBRTC_ON: [string, string][] = [
  ['allow', 'ulaw,alaw,g722,gsm,vp9,vp8,h264,opus'],
  ['dtls_cert_file', '/etc/asterisk/keys/asterisk.pem'],
  ['dtls_private_key', '/etc/asterisk/keys/asterisk.pem'],
  ['dtls_verify', 'fingerprint'],
  ['ice_support', 'yes'],
  ['media_encryption', 'dtls'],
  ['use_avpf', 'yes'],
  ['rtcp_mux', 'yes'],
  ['transport', 'transport-wss'],
];
const ISSABEL_WEBRTC_OFF: [string, string][] = [
  ['allow', ''],
  ['dtls_cert_file', ''],
  ['dtls_private_key', ''],
  ['dtls_verify', 'no'],
  ['ice_support', 'no'],
  ['media_encryption', 'no'],
  ['use_avpf', 'no'],
  ['rtcp_mux', 'no'],
  ['transport', 'transport-udp'],
];

/**
 * Single place for WebRTC enable/disable and its SIP options.
 * - FreePBX: rtcp_mux, avpf, icesupport, media_encryption + certman_mapping.
 * - Issabel: allow, dtls_cert_file, dtls_private_key, dtls_verify, ice_support,
 *   media_encryption, use_avpf, rtcp_mux, transport.
 *
 * Sets OpDesk users.webrtc, then the Asterisk sip rows. False only when no OpDesk user
 * has this extension (the route's "not found"); a PBX-side failure still returns true,
 * because users.webrtc was set (Python's contract).
 */
export async function setExtensionWebrtc(extension: string, enabled: boolean, pbx: string | null): Promise<boolean> {
  const ext = pyStr(extension ?? '').trim();
  if (!ext || extension === null || extension === undefined) return false;
  const webrtcVal = enabled ? 'yes' : 'no';
  const isIssabel = (pbx || '').trim().toLowerCase() === 'issabel';

  // Existence, not affectedRows: re-saving the value an extension already has reads 0
  // changed rows, and must still (re)write the SIP keywords below.
  try {
    const known = await withConnection(async (conn) => {
      if (!(await rowExists('users', 'extension = ?', [ext], conn))) return false;
      await execute('UPDATE users SET webrtc = ? WHERE extension = ?', [webrtcVal, ext], conn);
      return true;
    });
    if (!known) return false; // Extension not in users (same as the list; no duplicate path)
  } catch (err) {
    log.warning('set_extension_webrtc users (%s): %s', ext, err);
    return false;
  }

  let updated = 0;
  try {
    await withTransaction(async (conn) => {
      if (isIssabel) {
        for (const [keyword, value] of enabled ? ISSABEL_WEBRTC_ON : ISSABEL_WEBRTC_OFF) {
          updated += await setSipKeywordRow(conn, ext, keyword, value, true);
        }
        if (updated) log.info('Updated WebRTC for extension %s (Issabel): users.webrtc=%s', ext, webrtcVal);
        return;
      }
      const flag = enabled ? 'yes' : 'no';
      const enc = enabled ? 'dtls' : 'no';
      for (const [keyword, value] of [
        ['rtcp_mux', flag],
        ['avpf', flag],
        ['icesupport', flag],
        ['media_encryption', enc],
      ] as [string, string][]) {
        updated += await setSipKeywordRow(conn, ext, keyword, value, false);
      }
      // certman_mapping binds the DTLS certificate. A FreePBX without the Certificate
      // Manager module has no such table; the keywords above still apply.
      try {
        if (enabled) {
          await execute(
            "REPLACE INTO certman_mapping (id, cid, verify, setup, rekey, auto_generate_cert) VALUES (?, 2, 'fingerprint', 'actpass', 0, 0)",
            [ext],
            conn,
          );
        } else {
          await execute('DELETE FROM certman_mapping WHERE id = ?', [ext], conn);
        }
      } catch (e) {
        if (dbErrno(e) !== ERR_NO_SUCH_TABLE) throw e;
        log.debug('set_extension_webrtc: no certman_mapping table (%s)', ext);
      }
      if (updated) {
        log.info(
          'Updated WebRTC for extension %s: users.webrtc=%s, rtcp_mux=%s, avpf=%s, icesupport=%s, media_encryption=%s',
          ext, webrtcVal, flag, flag, flag, enc,
        );
      }
    }, 'pbx');
  } catch (err) {
    log.warning('set_extension_webrtc sip/certman (%s): %s', ext, err);
    return true; // users.webrtc was set
  }
  // Outside the try: in Python only a DB error became `return True`; a reload failure
  // propagated to the caller.
  if (updated) {
    const reload = resolveSipReloader();
    if (reload) await reload(pbx);
  }
  return true;
}
