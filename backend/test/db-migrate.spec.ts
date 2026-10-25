/**
 * Tests for the startup migration: schema.sql parsing and FK order, guarded column
 * changes, and the seed rules (admin only into an empty users table, default Not-Ready
 * codes only into an empty catalog, __WRAPUP always, settings only when missing or
 * empty). The pool and the server-level connection are mocked; nothing touches MySQL.
 */

jest.mock('../src/db/pool', () => {
  const actual = jest.requireActual('../src/db/pool');
  return { ...actual, query: jest.fn(), queryOne: jest.fn(), execute: jest.fn() };
});

const serverConn = { query: jest.fn(), end: jest.fn(async () => undefined) };
jest.mock('mysql2/promise', () => {
  const actual = jest.requireActual('mysql2/promise');
  return { ...actual, createConnection: jest.fn(async () => serverConn) };
});

import * as fs from 'fs';
import * as mysql from 'mysql2/promise';
import * as pool from '../src/db/pool';
import { setLogLevel } from '../src/core/logger';
import * as mig from '../src/db/migrate';

const q = pool.query as jest.Mock;
const q1 = pool.queryOne as jest.Mock;
const ex = pool.execute as jest.Mock;

const SCHEMA = fs.readFileSync(mig.SCHEMA_FILE, 'utf8');

beforeAll(() => setLogLevel('CRITICAL'));

describe('splitSqlStatements', () => {
  it('ignores ; and -- inside strings, and strips comments', () => {
    const sql = [
      "-- a comment; with a semicolon",
      "INSERT INTO t VALUES ('a;b', 'c -- d', \"e;\", 'it''s'); # trailing",
      '/* block; comment */ SELECT `we;ird` FROM x;',
      'SELECT 1--2',
    ].join('\n');
    expect(mig.splitSqlStatements(sql)).toEqual([
      "INSERT INTO t VALUES ('a;b', 'c -- d', \"e;\", 'it''s')",
      'SELECT `we;ird` FROM x',
      'SELECT 1--2',
    ]);
  });
});

describe('schema.sql', () => {
  const ddl = mig.createTableStatements(SCHEMA);
  const tables = ddl.map((t) => t.table);

  it('defines every OpDesk table, call_vad and audit_log included, and nothing else', () => {
    expect(new Set(tables)).toEqual(
      new Set([
        'OpDesk_settings', 'users', 'user_monitor_modes', 'agents', 'queues', 'groups', 'user_groups', 'group_agents',
        'group_queues', 'call_notifications', 'call_vad', 'call_supervision', 'device_tokens', 'sip_push_bindings',
        'pause_reasons', 'agent_activity', 'analytics_sla_settings', 'analytics_fcr_settings', 'analytics_hourly',
        'analytics_daily', 'analytics_agent_daily', 'api_keys', 'webhook_deliveries', 'contacts', 'audit_log',
      ]),
    );
    expect(tables).toHaveLength(new Set(tables).size);
  });

  it('lists every table after the tables its foreign keys reference', () => {
    ddl.forEach((t, i) => {
      for (const m of t.sql.matchAll(/REFERENCES\s+`?(\w+)`?/gi)) {
        const target = tables.indexOf(m[1]);
        expect({ table: t.table, ref: m[1], ok: target >= 0 && target < i }).toEqual({ table: t.table, ref: m[1], ok: true });
      }
    });
  });

  it('holds no seeds, events or statements against the PBX databases', () => {
    const stmts = mig.splitSqlStatements(SCHEMA);
    expect(stmts.filter((s) => !/^(CREATE TABLE IF NOT EXISTS|CREATE DATABASE IF NOT EXISTS|USE )/i.test(s))).toEqual([]);
    expect(SCHEMA).not.toMatch(/asteriskcdrdb|asterisk\./i);
  });

  it('keeps the live column shapes the code relies on', () => {
    const sql = (name: string) => ddl.find((t) => t.table === name)?.sql ?? '';
    expect(sql('device_tokens')).toMatch(/platform ENUM\('ios', 'android', 'web'\)/);
    expect(sql('pause_reasons')).toMatch(/code\s+VARCHAR\(64\)/);
    expect(sql('audit_log')).toMatch(/detail\s+MEDIUMTEXT/);
    expect(sql('call_vad')).toMatch(/uniqueid VARCHAR\(32\) NOT NULL UNIQUE/);
  });
});

describe('applyColumnGuards', () => {
  beforeEach(() => jest.resetAllMocks());

  /** information_schema as a table: {table: {column: COLUMN_TYPE}}; a column not listed is missing. */
  const schemaOf = (tables: Record<string, Record<string, string>>) =>
    q1.mockImplementation(async (sql: string, params: string[]) => {
      if (/information_schema.TABLES/.test(sql)) return tables[params[0]] ? { found: 1 } : null;
      const type = tables[params[0]]?.[params[1]];
      return type === undefined ? null : { COLUMN_TYPE: type, IS_NULLABLE: 'NO', COLUMN_DEFAULT: null };
    });
  const deliveryCols = Object.fromEntries(
    ['delivery_uuid', 'status', 'attempts', 'max_attempts', 'next_attempt_at', 'endpoint_path', 'trigger_kind', 'delivered_at'].map((c) => [c, 'x']),
  );
  const current = {
    device_tokens: { platform: "enum('ios','android','web')" },
    webhook_deliveries: deliveryCols,
    contacts: { source: "enum('manual','api','crm')", external_id: 'varchar(128)' },
    analytics_fcr_settings: { callback_window_hours: 'smallint' },
  };

  it("widens device_tokens.platform only while 'web' is missing", async () => {
    schemaOf({ ...current, device_tokens: { platform: "enum('ios','android')" } });
    ex.mockResolvedValue({ affectedRows: 0 });
    expect(await mig.applyColumnGuards()).toEqual(["ALTER TABLE device_tokens MODIFY platform ENUM('ios','android','web') NOT NULL"]);

    jest.resetAllMocks();
    schemaOf(current);
    expect(await mig.applyColumnGuards()).toEqual([]);
    expect(ex).not.toHaveBeenCalled();
  });

  it('adds analytics_fcr_settings.callback_window_hours only while it is missing', async () => {
    schemaOf({ ...current, analytics_fcr_settings: { window_days: 'tinyint' } });
    ex.mockResolvedValue({ affectedRows: 0 });
    expect(await mig.applyColumnGuards()).toEqual([
      'ALTER TABLE analytics_fcr_settings ADD COLUMN callback_window_hours SMALLINT UNSIGNED NOT NULL DEFAULT 24 AFTER short_abandon_secs',
    ]);
    expect(fs.readFileSync(mig.SCHEMA_FILE, 'utf8')).toMatch(/callback_window_hours SMALLINT UNSIGNED NOT NULL DEFAULT 24/);
  });

  it('turns an old webhook_deliveries into the retry queue, backfilling finished rows', async () => {
    schemaOf({ ...current, webhook_deliveries: { id: 'bigint' } });
    ex.mockResolvedValue({ affectedRows: 0 });
    const ran = await mig.applyColumnGuards();
    expect(ran).toEqual([
      'ALTER TABLE webhook_deliveries ADD COLUMN delivery_uuid CHAR(36) NULL, ADD UNIQUE KEY uq_delivery_uuid (delivery_uuid)',
      "ALTER TABLE webhook_deliveries ADD COLUMN status VARCHAR(12) NOT NULL DEFAULT 'pending'",
      "UPDATE webhook_deliveries SET status = IF(success = 1, 'delivered', 'failed')",
      'ALTER TABLE webhook_deliveries ADD COLUMN attempts SMALLINT UNSIGNED NOT NULL DEFAULT 1',
      'ALTER TABLE webhook_deliveries ADD COLUMN max_attempts SMALLINT UNSIGNED NOT NULL DEFAULT 1',
      'ALTER TABLE webhook_deliveries ADD COLUMN next_attempt_at DATETIME NULL, ADD INDEX idx_due (status, next_attempt_at)',
      'ALTER TABLE webhook_deliveries ADD COLUMN endpoint_path VARCHAR(255) NULL',
      "ALTER TABLE webhook_deliveries ADD COLUMN trigger_kind VARCHAR(16) NOT NULL DEFAULT 'hangup'",
      'ALTER TABLE webhook_deliveries ADD COLUMN delivered_at DATETIME NULL',
    ]);
  });

  it("gives contacts the 'api' source and the pushing system's identity", async () => {
    schemaOf({ ...current, contacts: { source: "enum('manual','crm')" } });
    ex.mockResolvedValue({ affectedRows: 0 });
    expect(await mig.applyColumnGuards()).toEqual([
      "ALTER TABLE contacts MODIFY source ENUM('manual','api','crm') NOT NULL DEFAULT 'manual'",
      'ALTER TABLE contacts ADD COLUMN external_id VARCHAR(128) NULL, ADD COLUMN source_system VARCHAR(48) NULL, ' +
        'ADD UNIQUE KEY uniq_contact_external (source_system, external_id), ADD INDEX idx_contact_name (name(150), id)',
    ]);
  });

  it('a failed ALTER skips its backfill and the next guard still runs', async () => {
    schemaOf({ ...current, webhook_deliveries: { ...deliveryCols, status: undefined as unknown as string, trigger_kind: undefined as unknown as string } });
    ex.mockImplementation(async (sql: string) => {
      if (/ADD COLUMN status/.test(sql)) throw new Error('lock wait timeout');
      return { affectedRows: 0 };
    });
    expect(await mig.applyColumnGuards()).toEqual(["ALTER TABLE webhook_deliveries ADD COLUMN trigger_kind VARCHAR(16) NOT NULL DEFAULT 'hangup'"]);
  });

  it('skips a table that does not exist', async () => {
    q1.mockResolvedValue(null);
    expect(await mig.applyColumnGuards()).toEqual([]);
    expect(ex).not.toHaveBeenCalled();
  });
});

describe('migrate', () => {
  const env0 = { ...process.env };
  let settings: Record<string, string | null>;
  let counts: Record<string, number>;
  let executed: [string, unknown[]][];

  beforeEach(() => {
    jest.resetAllMocks();
    process.env.OPDESK_DOMAIN = 'pbx.example.test';
    delete process.env.NGINX_HTTPS_PORT;
    delete process.env.OPDESK_ADMIN_PASSWORD;
    (mysql.createConnection as jest.Mock).mockImplementation(async () => serverConn);
    serverConn.query.mockResolvedValue([[{ Database: 'OpDesk' }], []]);
    serverConn.end.mockResolvedValue(undefined);
    settings = {};
    counts = { users: 0, pause_reasons: 0 };
    executed = [];
    q1.mockImplementation(async (sql: string, params: unknown[] = []) => {
      if (/COUNT\(\*\) AS n FROM users/.test(sql)) return { n: counts.users };
      if (/COUNT\(\*\) AS n FROM pause_reasons/.test(sql)) return { n: counts.pause_reasons };
      if (/FROM OpDesk_settings WHERE setting_key/.test(sql)) {
        const k = String(params[0]);
        return k in settings ? { setting_value: settings[k] } : null;
      }
      if (/information_schema/.test(sql)) return null;
      throw new Error(`unexpected ${sql}`);
    });
    ex.mockImplementation(async (sql: string, params: unknown[] = []) => {
      executed.push([sql, params]);
      if (/^INSERT INTO OpDesk_settings/.test(sql)) settings[String(params[0])] = params[1] as string;
      if (/^INSERT IGNORE INTO OpDesk_settings/.test(sql) && !(String(params[0]) in settings)) settings[String(params[0])] = params[1] as string;
      return { affectedRows: 1, insertId: 1 };
    });
  });

  afterAll(() => {
    process.env = env0;
  });

  const sqls = () => executed.map(([s]) => s);

  it('creates every table, seeds a fresh database, and never touches the PBX databases', async () => {
    await mig.migrate();
    const creates = sqls().filter((s) => /^CREATE TABLE IF NOT EXISTS/.test(s));
    expect(creates).toHaveLength(mig.createTableStatements(SCHEMA).length);
    expect(sqls().some((s) => /asterisk/i.test(s))).toBe(false);

    const admin = executed.find(([s]) => /^INSERT IGNORE INTO users/.test(s));
    expect(admin?.[1]).toEqual([mig.DEFAULT_ADMIN_PASSWORD_HASH]);

    const reasons = executed.filter(([s]) => /^INSERT IGNORE INTO pause_reasons/.test(s)).map(([, p]) => p[0]);
    expect(reasons).toEqual(['break', 'lunch', 'meeting', 'training', '__WRAPUP']);
    const wrap = executed.find(([s, p]) => /pause_reasons/.test(s) && p[0] === '__WRAPUP');
    expect(wrap?.[1]).toEqual(['__WRAPUP', 'Wrap-up', 1, '#10b981', 900, 1]);

    expect(settings.WEBRTC_PBX_SERVER).toBe('wss://pbx.example.test/sip-ws');
    expect(settings.CRM_SYNC_FIELDS).toBe('caller,destination,duration,talk_time,datetime,call_status,call_type,queue');
    expect(Object.keys(mig.defaultSettings('x'))).toHaveLength(32);
    for (const k of Object.keys(mig.defaultSettings('x'))) expect(k in settings).toBe(true);
    for (const k of ['SLA_DEFAULT_SECS', 'ANALYTICS_ENABLED', 'WRAPUP_MAX_SECS', 'SHIFT_RESET_TIME']) expect(k in settings).toBe(true);
    expect(sqls()).toContain('INSERT IGNORE INTO analytics_fcr_settings (id, window_days, short_abandon_secs) VALUES (1, 7, 5)');
  });

  it('leaves an existing install alone: no admin, no default codes, admin values kept, empty values filled', async () => {
    counts = { users: 3, pause_reasons: 2 };
    settings = { CRM_TIMEOUT: '5', CRM_SYNC_FIELDS: 'caller,linkedid,call_id', QOS_ENABLED: '' };
    await mig.migrate();
    expect(sqls().some((s) => /INTO users/.test(s))).toBe(false);
    const reasons = executed.filter(([s]) => /INTO pause_reasons/.test(s)).map(([, p]) => p[0]);
    expect(reasons).toEqual(['__WRAPUP']);
    expect(settings.CRM_TIMEOUT).toBe('5');
    expect(settings.QOS_ENABLED).toBe('false');
    expect(settings.CRM_SYNC_FIELDS).toBe('caller,call_id');
  });

  it('applies OPDESK_ADMIN_PASSWORD to the admin account on every start', async () => {
    counts = { users: 1, pause_reasons: 1 };
    process.env.OPDESK_ADMIN_PASSWORD = 'n3w-pass';
    await mig.migrate();
    const upd = executed.find(([s]) => /^UPDATE users SET password_hash/.test(s));
    expect(String(upd?.[1][0])).toMatch(/^\$2[aby]\$12\$/);
  });

  it('rewrites a port-less WEBRTC_PBX_SERVER once Nginx runs on another port', async () => {
    process.env.NGINX_HTTPS_PORT = '8443';
    settings = { WEBRTC_PBX_SERVER: 'wss://pbx.example.test/sip-ws' };
    await mig.migrate();
    expect(settings.WEBRTC_PBX_SERVER).toBe('wss://pbx.example.test:8443/sip-ws');
  });

  it('creates the database when it is missing, and carries on when it may not', async () => {
    serverConn.query.mockImplementation(async (sql: string) => (/^SHOW DATABASES/.test(sql) ? [[], []] : [[], []]));
    await mig.migrate();
    expect(serverConn.query.mock.calls.map((c) => c[0])).toContain(
      'CREATE DATABASE IF NOT EXISTS `OpDesk` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci',
    );

    jest.clearAllMocks();
    executed = [];
    serverConn.query.mockImplementation(async (sql: string) => {
      if (/^SHOW DATABASES/.test(sql)) return [[], []];
      throw Object.assign(new Error('access denied'), { errno: 1044 });
    });
    await expect(mig.migrate()).resolves.toBeUndefined();
    expect(sqls().filter((s) => /^CREATE TABLE/.test(s)).length).toBeGreaterThan(0);
  });

  it('retries a table whose FK target failed on the first pass', async () => {
    let first = true;
    ex.mockImplementation(async (sql: string) => {
      if (/CREATE TABLE IF NOT EXISTS group_agents/.test(sql) && first) {
        first = false;
        throw Object.assign(new Error('fk'), { errno: 1005, sqlState: 'HY000' });
      }
      return { affectedRows: 0 };
    });
    expect(await mig.ensureTables()).toEqual([]);
    expect(q).not.toHaveBeenCalled();
  });
});

describe('OPDESK_SKIP_MIGRATION', () => {
  it('leaves the database untouched', async () => {
    jest.resetAllMocks();
    process.env.OPDESK_SKIP_MIGRATION = '1';
    try {
      await mig.migrate();
      expect(ex).not.toHaveBeenCalled();
      expect(q1).not.toHaveBeenCalled();
      expect(mysql.createConnection).not.toHaveBeenCalled();
    } finally {
      delete process.env.OPDESK_SKIP_MIGRATION;
    }
  });
});
