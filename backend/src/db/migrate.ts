/**
 * Startup migration of the OpDesk application database.
 *
 * Python created only 8 of its tables at startup and ran schema.sql only when the whole
 * database was missing, so every upgraded install lacked whatever schema.sql gained
 * later (call_vad was never created on this box). Here every start converges the
 * database on backend/schema.sql instead:
 *
 *   1. the database itself, when the app user may create it (else the installer did);
 *   2. every CREATE TABLE IF NOT EXISTS of schema.sql, in file order (FK order);
 *   3. column changes, each guarded by information_schema (no ADD COLUMN IF NOT
 *      EXISTS on MariaDB 5.5), e.g. the device_tokens.platform 'web' widening;
 *   4. seeds: the admin account (only into an empty users table), the admin password
 *      override (.admin_init_hash / OPDESK_ADMIN_PASSWORD, as Python applied it), the
 *      default Not-Ready codes (only into an empty catalog), the __WRAPUP system code,
 *      fixed defaults, and server.py's 22 default settings plus its two rewrites.
 *
 * Each step is idempotent and fail-soft: a failing step is logged and the next one
 * still runs, as Python's init_* functions did. Only the app database is touched: no
 * DDL ever runs against `asterisk` or `asteriskcdrdb` (the app user has no such rights).
 */

import * as dgram from 'node:dgram';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as bcrypt from 'bcryptjs';
import * as mysql from 'mysql2/promise';
import { BACKEND_DIR, env, envFlag } from '../core/config';
import { getLogger } from '../core/logger';
import { appDbName, dbErrno, execute, query, queryOne } from './pool';
import { getSetting, setSetting } from './manager/platform';
import { DEFAULT_PAUSE_REASONS, SYSTEM_PAUSE_REASONS } from './manager/ops';
import { BCRYPT_ROUNDS } from './manager/users';

const log = getLogger('db.migrate');

/** backend/schema.sql: the single source of the table definitions. */
export const SCHEMA_FILE = path.join(BACKEND_DIR, 'schema.sql');

/** Written by install.sh: a bcrypt hash for the admin account, read once and deleted. */
export const ADMIN_INIT_HASH_FILE = path.join(BACKEND_DIR, '.admin_init_hash');

/** bcrypt of the default admin password shipped in OpDesk's original schema.sql. */
export const DEFAULT_ADMIN_PASSWORD_HASH = '$2b$12$BGZ/sGBqq7XxiC5MxVOlE.lsyU4Pkg1nVhs0VjEgzekDMUBiYx4PS';

// ---------------------------------------------------------------------------
// schema.sql parsing
// ---------------------------------------------------------------------------

/**
 * Split SQL text into statements: `-- ` / `#` line comments and block comments
 * are removed and `;` ends a statement, except inside quoted strings or identifiers
 * (which may hold `;` or `--`, e.g. a bcrypt hash or a color default).
 */
export function splitSqlStatements(sql: string): string[] {
  const out: string[] = [];
  let cur = '';
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    const next = sql[i + 1];
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === '\\' && c !== '`') {
          j += 2;
          continue;
        }
        if (sql[j] === c) {
          if (sql[j + 1] === c) {
            j += 2; // doubled quote
            continue;
          }
          break;
        }
        j++;
      }
      cur += sql.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    // MySQL: "--" starts a comment only when followed by whitespace (or end of input).
    if ((c === '-' && next === '-' && (i + 2 >= n || /\s/.test(sql[i + 2]))) || c === '#') {
      while (i < n && sql[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? n : end + 2;
      cur += ' ';
      continue;
    }
    if (c === ';') {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
      i++;
      continue;
    }
    cur += c;
    i++;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

export interface TableDdl {
  table: string;
  sql: string;
}

/** The CREATE TABLE IF NOT EXISTS statements of a schema file, in file order. */
export function createTableStatements(sqlText: string): TableDdl[] {
  const out: TableDdl[] = [];
  for (const stmt of splitSqlStatements(sqlText)) {
    const m = /^CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+`?([A-Za-z0-9_]+)`?/i.exec(stmt);
    if (m) out.push({ table: m[1], sql: stmt });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Step 1: the database
// ---------------------------------------------------------------------------

/**
 * Create the app database when it is missing and the app user may (its grant on
 * `OpDesk`.* allows it). When it may not, the installer is expected to have created it
 * as root; the failure is logged and the remaining steps report what is missing.
 */
async function ensureDatabase(): Promise<void> {
  const name = appDbName();
  if (!/^[A-Za-z0-9_$]+$/.test(name)) {
    log.error('❌ DB_OpDesk %s is not a plain database name; not creating it', name);
    return;
  }
  let conn: mysql.Connection | null = null;
  try {
    conn = await mysql.createConnection({
      host: env('DB_HOST', 'localhost'),
      port: Number(env('DB_PORT', '3306')),
      user: env('DB_USER', 'root'),
      password: env('DB_PASSWORD', ''),
      charset: 'utf8mb4',
      connectTimeout: 10_000,
    });
    const [rows] = (await conn.query('SHOW DATABASES LIKE ?', [name])) as [unknown[], unknown];
    if (rows.length) return;
    log.info('📋 %s database not found; creating it', name);
    await conn.query(`CREATE DATABASE IF NOT EXISTS \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    log.info('✅ %s database created', name);
  } catch (e) {
    log.warning('⚠️  Could not check/create the %s database (assuming the installer created it): %s', name, e);
  } finally {
    await conn?.end().catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// Step 2: tables
// ---------------------------------------------------------------------------

// errnos meaning "a referenced table is not there yet": retried after the first pass.
const FK_ERRNOS = new Set([1005, 1215, 1824]);

/** Run every CREATE TABLE IF NOT EXISTS of schema.sql. Returns the tables that failed. */
export async function ensureTables(schemaText?: string | null): Promise<string[]> {
  let text = schemaText ?? null;
  if (text === null) {
    try {
      text = fs.readFileSync(SCHEMA_FILE, 'utf8');
    } catch (e) {
      log.error('❌ Schema file not readable (%s): %s', SCHEMA_FILE, e);
      return ['*'];
    }
  }
  const ddl = createTableStatements(text);
  const pending: TableDdl[] = [];
  for (const t of ddl) {
    try {
      await execute(t.sql);
    } catch (e) {
      // Retried once below; only an FK ordering problem is expected to clear by then.
      if (!FK_ERRNOS.has(dbErrno(e) ?? 0)) log.warning('⚠️  Could not create table %s: %s', t.table, e);
      pending.push(t);
    }
  }
  // A second pass for tables whose FK target failed or came later in the file.
  const failed: string[] = [];
  for (const t of pending) {
    try {
      await execute(t.sql);
    } catch (e) {
      log.error('❌ Could not create table %s: %s', t.table, e);
      failed.push(t.table);
    }
  }
  if (!failed.length) log.info('✅ %d tables present', ddl.length);
  return failed;
}

// ---------------------------------------------------------------------------
// Step 3: guarded column changes
// ---------------------------------------------------------------------------

export interface ColumnInfo {
  COLUMN_TYPE: string;
  IS_NULLABLE: string;
  COLUMN_DEFAULT: string | null;
}

export interface ColumnGuard {
  table: string;
  column: string;
  /** Whether the change is needed, given the column as it is now (null = column missing). */
  needed: (col: ColumnInfo | null) => boolean;
  ddl: string;
  /** Statements run right after `ddl` succeeded (a backfill of the column it added). */
  then?: string[];
  why: string;
}

/** A guard that adds `column` to `table` when it is missing. */
function addColumn(table: string, column: string, ddl: string, why: string, then?: string[]): ColumnGuard {
  return { table, column, needed: (col) => col === null, ddl, why, ...(then ? { then } : {}) };
}

/**
 * Column changes for databases created by older schema files. Add new ones at the
 * end; each must be safe to re-check on every start. (An added column also goes into
 * the CREATE TABLE in schema.sql, so a fresh database never needs the ALTER.)
 */
export const COLUMN_GUARDS: ColumnGuard[] = [
  {
    table: 'device_tokens',
    column: 'platform',
    needed: (col) => col !== null && !/'web'/i.test(col.COLUMN_TYPE),
    ddl: "ALTER TABLE device_tokens MODIFY platform ENUM('ios','android','web') NOT NULL",
    why: "browser Web Push subscriptions are stored with platform='web'",
  },
  {
    table: 'analytics_fcr_settings',
    column: 'callback_window_hours',
    needed: (col) => col === null,
    ddl: 'ALTER TABLE analytics_fcr_settings ADD COLUMN callback_window_hours SMALLINT UNSIGNED NOT NULL DEFAULT 24 AFTER short_abandon_secs',
    why: 'FCR and abandoned-caller recovery count our own callbacks within this window',
  },
  // CRM delivery retry queue: webhook_deliveries rows became queue rows. Existing rows
  // are finished attempts, so they are backfilled as delivered/failed with one attempt.
  addColumn(
    'webhook_deliveries',
    'delivery_uuid',
    'ALTER TABLE webhook_deliveries ADD COLUMN delivery_uuid CHAR(36) NULL, ADD UNIQUE KEY uq_delivery_uuid (delivery_uuid)',
    'the idempotency key every attempt of a delivery carries',
  ),
  addColumn(
    'webhook_deliveries',
    'status',
    "ALTER TABLE webhook_deliveries ADD COLUMN status VARCHAR(12) NOT NULL DEFAULT 'pending'",
    'delivery state for the retry queue',
    ["UPDATE webhook_deliveries SET status = IF(success = 1, 'delivered', 'failed')"],
  ),
  addColumn(
    'webhook_deliveries',
    'attempts',
    'ALTER TABLE webhook_deliveries ADD COLUMN attempts SMALLINT UNSIGNED NOT NULL DEFAULT 1',
    'sends of a delivery so far',
  ),
  addColumn(
    'webhook_deliveries',
    'max_attempts',
    'ALTER TABLE webhook_deliveries ADD COLUMN max_attempts SMALLINT UNSIGNED NOT NULL DEFAULT 1',
    'the retry budget of a delivery',
  ),
  addColumn(
    'webhook_deliveries',
    'next_attempt_at',
    'ALTER TABLE webhook_deliveries ADD COLUMN next_attempt_at DATETIME NULL, ADD INDEX idx_due (status, next_attempt_at)',
    'when the retry worker may send a delivery again',
  ),
  addColumn(
    'webhook_deliveries',
    'endpoint_path',
    'ALTER TABLE webhook_deliveries ADD COLUMN endpoint_path VARCHAR(255) NULL',
    'the push path a retry reuses',
  ),
  addColumn(
    'webhook_deliveries',
    'trigger_kind',
    "ALTER TABLE webhook_deliveries ADD COLUMN trigger_kind VARCHAR(16) NOT NULL DEFAULT 'hangup'",
    'which push trigger queued a delivery',
  ),
  addColumn(
    'webhook_deliveries',
    'delivered_at',
    'ALTER TABLE webhook_deliveries ADD COLUMN delivered_at DATETIME NULL',
    'when a delivery landed',
  ),
  // Contacts pushed over the API: a third source and the pushing system's identity.
  {
    table: 'contacts',
    column: 'source',
    needed: (col) => col !== null && !/'api'/i.test(col.COLUMN_TYPE),
    ddl: "ALTER TABLE contacts MODIFY source ENUM('manual','api','crm') NOT NULL DEFAULT 'manual'",
    why: "contacts pushed by an external system are stored with source='api'",
  },
  addColumn(
    'contacts',
    'external_id',
    'ALTER TABLE contacts ADD COLUMN external_id VARCHAR(128) NULL, ADD COLUMN source_system VARCHAR(48) NULL, ' +
      'ADD UNIQUE KEY uniq_contact_external (source_system, external_id), ADD INDEX idx_contact_name (name(150), id)',
    "the pushing system's own contact id, and keyset paging by name",
  ),
];

/** Apply every COLUMN_GUARDS change the live table still needs. Returns the ALTERs run. */
export async function applyColumnGuards(guards: ColumnGuard[] = COLUMN_GUARDS): Promise<string[]> {
  const ran: string[] = [];
  for (const g of guards) {
    try {
      const table = await queryOne(
        'SELECT 1 AS found FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
        [g.table],
      );
      if (!table) continue;
      const col = (await queryOne(
        'SELECT COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT FROM information_schema.COLUMNS ' +
          'WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
        [g.table, g.column],
      )) as ColumnInfo | null;
      if (!g.needed(col)) continue;
      await execute(g.ddl);
      ran.push(g.ddl);
      for (const sql of g.then ?? []) {
        await execute(sql);
        ran.push(sql);
      }
      log.info('✅ Migrated %s.%s (%s)', g.table, g.column, g.why);
    } catch (e) {
      log.warning('⚠️  Column migration %s.%s failed: %s', g.table, g.column, e);
    }
  }
  return ran;
}

// ---------------------------------------------------------------------------
// Step 4: seeds
// ---------------------------------------------------------------------------

/**
 * The admin password override, as Python's _resolve_admin_password_hash:
 *   1. backend/.admin_init_hash (install.sh writes a bcrypt hash there): read, then deleted;
 *   2. OPDESK_ADMIN_PASSWORD (plain text, hashed here): applied on every start while set.
 * null when neither is configured.
 */
export async function resolveAdminPasswordHash(): Promise<string | null> {
  try {
    if (fs.existsSync(ADMIN_INIT_HASH_FILE)) {
      const hash = fs.readFileSync(ADMIN_INIT_HASH_FILE, 'utf8').trim();
      if (hash) {
        fs.rmSync(ADMIN_INIT_HASH_FILE, { force: true });
        return hash;
      }
    }
  } catch (e) {
    log.warning('⚠️  Could not read %s: %s', ADMIN_INIT_HASH_FILE, e);
  }
  const plain = env('OPDESK_ADMIN_PASSWORD', '');
  if (plain) return bcrypt.hash(plain, BCRYPT_ROUNDS);
  return null;
}

/** The admin account: created only when there are no users at all; the override always applies. */
async function seedAdmin(): Promise<void> {
  const override = await resolveAdminPasswordHash();
  const row = await queryOne('SELECT COUNT(*) AS n FROM users');
  if (row && Number(row.n) === 0) {
    await execute("INSERT IGNORE INTO users (username, password_hash, name, role) VALUES ('admin', ?, 'Admin', 'admin')", [
      override ?? DEFAULT_ADMIN_PASSWORD_HASH,
    ]);
    log.info('✅ Created the admin account');
  }
  if (override) {
    await execute("UPDATE users SET password_hash = ? WHERE username = 'admin'", [override]);
    log.info('✅ Admin password applied');
  }
}

/**
 * Settings with a fixed default, written only when the key has no row at all
 * (INSERT IGNORE: an admin's empty value stays empty).
 */
export const FIXED_DEFAULT_SETTINGS: Record<string, string> = {
  SLA_DEFAULT_SECS: '20',
  ANALYTICS_ENABLED: 'true',
  // Not-Ready / wrap-up: the cap on automatic after-call work, and the daily shift
  // boundary (forced logout and the adherence day). Their readers apply the same
  // defaults when the row is missing; seeding just makes them visible in Settings.
  WRAPUP_MAX_SECS: '120',
  SHIFT_RESET_TIME: '00:00',
};

async function seedFixedRows(): Promise<void> {
  await execute('INSERT IGNORE INTO analytics_fcr_settings (id, window_days, short_abandon_secs) VALUES (1, 7, 5)');
  for (const [key, value] of Object.entries(FIXED_DEFAULT_SETTINGS)) {
    await execute('INSERT IGNORE INTO OpDesk_settings (setting_key, setting_value) VALUES (?, ?)', [key, value]);
  }
}

/** Default codes into an empty catalog only (deleted codes stay deleted); system codes always. */
async function seedPauseReasons(): Promise<void> {
  const row = await queryOne('SELECT COUNT(*) AS n FROM pause_reasons');
  const sql =
    'INSERT IGNORE INTO pause_reasons (code, label, productive, color, sort_order, is_active, is_system) VALUES (?, ?, ?, ?, ?, 1, ?)';
  if (row && Number(row.n) === 0) {
    for (const r of DEFAULT_PAUSE_REASONS) await execute(sql, [...r]);
    log.info('✅ Seeded %d default Not-Ready codes', DEFAULT_PAUSE_REASONS.length);
  }
  for (const r of SYSTEM_PAUSE_REASONS) await execute(sql, [...r]);
}

// The CRM push's default field selection and the renamed catalog fields (mirrors
// crm.py DEFAULT_CRM_SYNC_FIELDS / RETIRED_CRM_SYNC_FIELDS).
export const DEFAULT_CRM_SYNC_FIELDS = ['caller', 'destination', 'duration', 'talk_time', 'datetime', 'call_status', 'call_type', 'queue'];
export const RETIRED_CRM_SYNC_FIELDS: Record<string, string> = { linkedid: 'call_id' };

/** ':<port>' for the HTTPS port Nginx serves OpDesk on, or '' for the default 443. */
export function publicPortSuffix(): string {
  const port = env('NGINX_HTTPS_PORT', '').trim();
  return port && port !== '443' ? `:${port}` : '';
}

/**
 * The local IPv4 address used for the WebRTC default: the interface the OS would route
 * 8.8.8.8 through (a UDP connect sends nothing), else the first external IPv4, else
 * loopback.
 */
export async function detectLocalIp(): Promise<string> {
  const viaRoute = await new Promise<string | null>((resolve) => {
    const sock = dgram.createSocket('udp4');
    const done = (v: string | null) => {
      clearTimeout(timer);
      try {
        sock.close();
      } catch {
        /* already closed */
      }
      resolve(v);
    };
    const timer = setTimeout(() => done(null), 1000);
    sock.on('error', () => done(null));
    try {
      sock.connect(80, '8.8.8.8', () => {
        try {
          done(sock.address().address);
        } catch {
          done(null);
        }
      });
    } catch {
      done(null);
    }
  });
  if (viaRoute && viaRoute !== '0.0.0.0') return viaRoute;
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) if (a.family === 'IPv4' && !a.internal) return a.address;
  }
  return '127.0.0.1';
}

/** server.py's default settings, written when a key is missing OR empty. */
export function defaultSettings(webrtcDefault: string): Record<string, string> {
  return {
    SIP_TLS_ENABLED: 'false',
    QOS_ENABLED: 'false',
    CRM_ENABLED: 'false',
    CRM_AUTH_TYPE: 'api_key',
    CRM_ENDPOINT_PATH: '/api/calls',
    CRM_TIMEOUT: '30',
    CRM_VERIFY_SSL: 'true',
    // Call-data sync (push): defaults reproduce the original fixed payload, so enabling
    // CRM on an upgraded install keeps the exact same behaviour.
    CRM_SYNC_ENABLED: 'true',
    CRM_SYNC_METHOD: 'POST',
    CRM_SYNC_FIELDS: DEFAULT_CRM_SYNC_FIELDS.join(','),
    CRM_SYNC_DIR_INBOUND: 'true',
    CRM_SYNC_DIR_OUTBOUND: 'true',
    CRM_SYNC_DIR_INTERNAL: 'true',
    CRM_BLOCK_PRIVATE: 'false', // allow on-prem/LAN CRM by default
    CRM_SYNC_DURATION_FORMAT: 'hms', // hms | seconds
    CRM_SYNC_STATUS_MAP: '{}', // {FROM: TO} outcome remap
    CRM_SYNC_KEY_MAP: '{}', // {defaultKey: customKey} rename
    // When the push fires, and the automatic retry of a failed push.
    CRM_SYNC_TRIGGER: 'hangup', // hangup | wrapup
    CRM_SYNC_WRAPUP_TIMEOUT: '600', // seconds a wrap-up push waits at most
    CRM_SYNC_RETRY_ENABLED: 'true',
    CRM_SYNC_RETRY_MAX_ATTEMPTS: '5',
    CRM_SYNC_RETRY_DELAYS: '30,120,600,1800', // backoff ladder in seconds; the last repeats
    // Contact lookup: GET template with [Number], name template of JSON paths, prefix
    // strategy, last-N-digit matching, optional verification.
    CRM_LOOKUP_ENABLED: 'false',
    CRM_LOOKUP_URL: '',
    CRM_LOOKUP_NAME_TEMPLATE: '',
    CRM_LOOKUP_NUMBER_FORMAT: 'digits', // digits | as_is | plus | zeros
    CRM_LOOKUP_MATCH_DIGITS: '0', // compare/cache on last N digits (0 = full)
    CRM_LOOKUP_VERIFY_PATH: '',
    CRM_LOOKUP_TTL_HOURS: '24',
    WEBHOOK_LOG_RETENTION_DAYS: '30',
    CLICK_TO_CALL_CONTEXT: 'from-internal',
    WEBRTC_PBX_SERVER: webrtcDefault,
  };
}

/** Rewrite retired catalog names in CRM_SYNC_FIELDS (idempotent). The new value, or null when unchanged. */
export function rewriteRetiredSyncFields(raw: string): string | null {
  const out: string[] = [];
  const seen = new Set<string>();
  let changed = false;
  for (let name of raw.split(',')) {
    name = name.trim();
    if (!name) continue;
    if (Object.prototype.hasOwnProperty.call(RETIRED_CRM_SYNC_FIELDS, name)) {
      name = RETIRED_CRM_SYNC_FIELDS[name];
      changed = true;
    }
    if (!seen.has(name)) {
      seen.add(name);
      out.push(name);
    }
  }
  return changed ? out.join(',') : null;
}

/** server.py's startup settings: the WEBRTC_PBX_SERVER port rewrite, the defaults, the CRM_SYNC_FIELDS rename. */
async function seedDefaultSettings(): Promise<void> {
  const host = env('OPDESK_DOMAIN', '').trim() || (await detectLocalIp());
  const suffix = publicPortSuffix();
  const webrtcDefault = `wss://${host}${suffix}/sip-ws`;

  // Before the Nginx port reached the backend, the default was seeded without a port,
  // which points at whatever owns 443 (e.g. FreePBX's Apache) when Nginx is elsewhere.
  if (suffix && (await getSetting('WEBRTC_PBX_SERVER')) === `wss://${host}/sip-ws`) {
    await setSetting('WEBRTC_PBX_SERVER', webrtcDefault);
    log.info('Migrated WEBRTC_PBX_SERVER to %s', webrtcDefault);
  }

  for (const [key, value] of Object.entries(defaultSettings(webrtcDefault))) {
    const current = await getSetting(key);
    if (current === null || current === '') {
      if (await setSetting(key, value)) log.info('Initialized default setting: %s=%s', key, value);
    }
  }

  // parse_sync_fields drops names not in the catalog, so a retired name would silently
  // lose a selected field on upgrade.
  const raw = await getSetting('CRM_SYNC_FIELDS', '');
  if (raw) {
    const next = rewriteRetiredSyncFields(raw);
    if (next !== null && (await setSetting('CRM_SYNC_FIELDS', next))) log.info('Migrated retired CRM_SYNC_FIELDS names -> %s', next);
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function step(name: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    log.error('❌ Migration step "%s" failed: %s', name, e);
  }
}

/**
 * Bring the app database up to backend/schema.sql and seed it. Idempotent; never
 * throws (each step logs its own failure). Run once at startup, before anything reads
 * the database.
 */
export async function migrate(): Promise<void> {
  // A second instance pointed at a database another OpDesk version still serves (the
  // side-by-side test of a new build) must not change that database's schema or seeds.
  if (envFlag('OPDESK_SKIP_MIGRATION')) {
    log.warning('⚠️  OPDESK_SKIP_MIGRATION is set: the %s database schema is not checked', appDbName());
    return;
  }
  log.info('Checking the %s database schema...', appDbName());
  await step('database', ensureDatabase);
  await step('tables', () => ensureTables());
  await step('columns', () => applyColumnGuards());
  await step('admin account', seedAdmin);
  await step('fixed defaults', seedFixedRows);
  await step('Not-Ready codes', seedPauseReasons);
  await step('default settings', seedDefaultSettings);
}

/** Tables schema.sql defines (for diagnostics and tests). */
export function schemaTables(schemaText: string = fs.readFileSync(SCHEMA_FILE, 'utf8')): string[] {
  return createTableStatements(schemaText).map((t) => t.table);
}

/** Tables schema.sql defines that the connected database lacks. */
export async function missingTables(): Promise<string[]> {
  const present = new Set(
    (await query('SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()')).map((r) => String(r.TABLE_NAME)),
  );
  return schemaTables().filter((t) => !present.has(t));
}
