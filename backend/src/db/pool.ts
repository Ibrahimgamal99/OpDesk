/**
 * MySQL access: one pool per database OpDesk talks to.
 *
 *   app   the OpDesk application database (DB_OpDesk, default "OpDesk")
 *   pbx   the FreePBX database (DB_NAME, default "asterisk")
 *   cdr   the CDR/CEL database (DB_CDR, default "asteriskcdrdb")
 *
 * Rows come back in the shapes the Python code relied on, because those shapes
 * reach the API and the dialplan unchanged:
 *   DATETIME/TIMESTAMP -> Date (naive server-local, as mysql-connector gave datetime)
 *   DATE               -> 'YYYY-MM-DD' string (Python's date, already isoformat)
 *   TIME               -> seconds as a number (Python's timedelta, which the API sent as seconds)
 *   DECIMAL            -> number
 *   JSON               -> the raw string (callers JSON.parse, as they json.loads'd)
 *
 * Queries use `?` placeholders. SQL is never built from input: identifiers that
 * vary come from an allowlist in the caller.
 */

import * as mysql from 'mysql2/promise';
import type { FieldPacket, Pool, PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import type { Field, Next } from 'mysql2/typings/mysql/lib/parsers/typeCast';
import { env } from '../core/config';
import { isoformat } from '../core/py';

/** A database row: column name -> value. Named once so "open shape" is a visible decision. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Row = Record<string, any>;
export type SqlValue = string | number | boolean | Date | Buffer | null | undefined | SqlValue[];
export type Params = SqlValue[];
export type DbName = 'app' | 'pbx' | 'cdr';

/** Name of the OpDesk application database (also interpolated by cross-schema queries). */
export function appDbName(): string {
  return env('DB_OpDesk', 'OpDesk');
}

/** The FreePBX database (DB_NAME). */
export function pbxDbName(): string {
  return env('DB_NAME', 'asterisk');
}

/** The CDR/CEL database (DB_CDR). */
export function cdrDbName(): string {
  return env('DB_CDR', 'asteriskcdrdb');
}

function typeCast(field: Field, next: Next): unknown {
  switch (field.type) {
    case 'DATE':
      return field.string();
    case 'TIME': {
      const v = field.string();
      if (v === null) return null;
      const m = /^(-)?(\d+):(\d{2}):(\d{2})(?:\.(\d+))?$/.exec(v);
      if (!m) return v;
      const secs = Number(m[2]) * 3600 + Number(m[3]) * 60 + Number(m[4]) + (m[5] ? Number(`0.${m[5]}`) : 0);
      return m[1] ? -secs : secs;
    }
    case 'JSON':
      return field.string('utf8');
    default:
      return next();
  }
}

const pools = new Map<DbName, Pool>();

function databaseFor(name: DbName): string {
  return name === 'app' ? appDbName() : name === 'pbx' ? pbxDbName() : cdrDbName();
}

export function pool(name: DbName = 'app'): Pool {
  let p = pools.get(name);
  if (!p) {
    p = mysql.createPool({
      host: env('DB_HOST', 'localhost'),
      port: Number(env('DB_PORT', '3306')),
      user: env('DB_USER', 'root'),
      password: env('DB_PASSWORD', ''),
      database: databaseFor(name),
      connectionLimit: Number(env('DB_POOL_SIZE', '10')),
      waitForConnections: true,
      connectTimeout: 10_000,
      // Naive local times in and out, as mysql-connector-python did.
      timezone: 'local',
      dateStrings: false,
      decimalNumbers: true,
      supportBigNumbers: true,
      bigNumberStrings: false,
      charset: 'utf8mb4',
      // rowcount semantics of mysql-connector: affectedRows counts rows CHANGED, not matched.
      // Code like `if (res.affectedRows) return 'linked'` depends on it.
      flags: ['-FOUND_ROWS'],
      typeCast,
    });
    pools.set(name, p);
  }
  return p;
}

/** Where a statement runs: a pool by name, or a connection already borrowed (transaction). */
export type Executor = DbName | Pool | PoolConnection;

function on(target: Executor): Pool | PoolConnection {
  return typeof target === 'string' ? pool(target) : target;
}

/** SELECT -> rows (cursor.fetchall() with dictionary=True). */
export async function query<T extends Row = Row>(sql: string, params: Params = [], target: Executor = 'app'): Promise<T[]> {
  const [rows] = (await on(target).query(sql, params)) as [RowDataPacket[], FieldPacket[]];
  return rows as T[];
}

/** SELECT -> first row or null (cursor.fetchone()). */
export async function queryOne<T extends Row = Row>(sql: string, params: Params = [], target: Executor = 'app'): Promise<T | null> {
  const rows = await query<T>(sql, params, target);
  return rows.length ? rows[0] : null;
}

/** INSERT/UPDATE/DELETE -> { insertId, affectedRows } (cursor.lastrowid / cursor.rowcount). */
export async function execute(sql: string, params: Params = [], target: Executor = 'app'): Promise<ResultSetHeader> {
  const [res] = (await on(target).query(sql, params)) as [ResultSetHeader, FieldPacket[]];
  return res;
}

/** cursor.executemany: one statement over many parameter rows, on one connection. Returns rows affected. */
export async function executeMany(sql: string, rows: Params[], target: Executor = 'app'): Promise<number> {
  if (!rows.length) return 0;
  const run = async (conn: PoolConnection) => {
    let affected = 0;
    for (const r of rows) affected += (await execute(sql, r, conn)).affectedRows;
    return affected;
  };
  if (typeof target === 'string') return withConnection(run, target);
  if ('release' in target) return run(target as PoolConnection);
  return withConnection(run);
}

/** Borrow one connection for statements that must share it (LAST_INSERT_ID, session variables). */
export async function withConnection<T>(fn: (conn: PoolConnection) => Promise<T>, db: DbName = 'app'): Promise<T> {
  const conn = await pool(db).getConnection();
  try {
    return await fn(conn);
  } finally {
    conn.release();
  }
}

/** One transaction: commit when fn resolves, roll back when it throws (conn.commit()/rollback()). */
export async function withTransaction<T>(fn: (conn: PoolConnection) => Promise<T>, db: DbName = 'app'): Promise<T> {
  const conn = await pool(db).getConnection();
  try {
    await conn.beginTransaction();
    const out = await fn(conn);
    await conn.commit();
    return out;
  } catch (e) {
    try {
      await conn.rollback();
    } catch {
      /* the connection goes back to the pool either way */
    }
    throw e;
  } finally {
    conn.release();
  }
}

/** True for an error raised by the MySQL driver or the connection (mysql.connector.Error). */
export function isDbError(e: unknown): e is Error & { code?: string; errno?: number; sqlMessage?: string } {
  if (!(e instanceof Error)) return false;
  const err = e as Error & { code?: unknown; errno?: unknown; sqlState?: unknown };
  return err.errno !== undefined || err.sqlState !== undefined || (typeof err.code === 'string' && /^(ER_|ECONN|ETIMEDOUT|PROTOCOL_)/.test(err.code));
}

/** The MySQL error number (e.errno), e.g. 1062 for a duplicate key. */
export function dbErrno(e: unknown): number | undefined {
  return isDbError(e) ? e.errno : undefined;
}

export async function closePools(): Promise<void> {
  await Promise.all([...pools.values()].map((p) => p.end().catch(() => undefined)));
  pools.clear();
}

/** `?, ?, ?` for an IN (...) list of n values. */
export function placeholders(n: number): string {
  return Array.from({ length: n }, () => '?').join(', ');
}

// ---------------------------------------------------------------------------
// Shared query helpers (db_manager's _clamp_limit / cursors / _keyset_page)
// ---------------------------------------------------------------------------

// Server-side ceiling on any collection endpoint. An uncapped `limit` lets one
// request ask for the whole table.
export const MAX_PAGE_LIMIT = 500;

export function clampLimit(limit: unknown, fallback = 200): number {
  let n: number;
  if (typeof limit === 'number') n = Math.trunc(limit);
  else if (typeof limit === 'string' && /^\s*[+-]?\d+\s*$/.test(limit)) n = parseInt(limit, 10);
  else return fallback;
  if (Number.isNaN(n)) return fallback;
  return Math.max(1, Math.min(n, MAX_PAGE_LIMIT));
}

/** Opaque forward cursor carrying the sort-key values of the last row sent. */
export function encodeCursor(...parts: unknown[]): string {
  const raw = JSON.stringify(parts.map((p) => (p instanceof Date ? isoformat(p) : p)));
  return Buffer.from(raw, 'utf8').toString('base64url');
}

/** Reverse of encodeCursor. null for absent or malformed cursors (degrades to page one). */
export function decodeCursor(cursor: string | null | undefined, arity: number): SqlValue[] | null {
  if (!cursor) return null;
  try {
    const parts: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (Array.isArray(parts) && parts.length === arity) return parts as SqlValue[];
  } catch {
    /* malformed cursor: first page */
  }
  return null;
}

/** Escape LIKE metacharacters so "_" or "%" typed by a user matches literally. */
export function likeEscape(term: string): string {
  return term.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

/** A sort key: a column ("id", "t.id") or an [expression, row key] pair for a nullable column. */
export type KeysetKey = string | [expression: string, rowKey: string];

export interface KeysetPage<T extends Row = Row> {
  items: T[];
  next_cursor: string | null;
}

/**
 * One keyset-paginated query -> { items, next_cursor }. `keys` is the sort key and its
 * last element must be unique (id) or pages can stall on a tie. Over-fetches by one
 * row to learn whether a next page exists without a COUNT. `columns`, `table`,
 * `clauses` and `order` are fixed SQL from the caller, never request input.
 */
export async function keysetPage<T extends Row = Row>(
  target: Executor,
  columns: string,
  table: string,
  clauses: string[],
  params: Params,
  order: string,
  keys: KeysetKey[],
  limit: unknown,
  cursor: string | null | undefined,
  descending = false,
): Promise<KeysetPage<T>> {
  const lim = clampLimit(limit);
  const where = [...clauses];
  const args: Params = [...params];
  const parts: [string, string][] = keys.map((k) => (typeof k === 'string' ? [k, k.split('.').pop() as string] : k));
  const after = decodeCursor(cursor, parts.length);
  if (after) {
    const cmp = descending ? '<' : '>';
    where.push(`(${parts.map(([e]) => e).join(', ')}) ${cmp} (${placeholders(parts.length)})`);
    args.push(...after);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  args.push(lim + 1);
  const rows = await query<T>(`SELECT ${columns} FROM ${table} ${whereSql} ORDER BY ${order} LIMIT ?`, args, target);
  const items = rows.slice(0, lim);
  let next: string | null = null;
  if (rows.length > lim && items.length) {
    const last = items[items.length - 1];
    next = encodeCursor(...parts.map(([, rk]) => last[rk]));
  }
  return { items, next_cursor: next };
}

// errnos mysql-connector raised as IntegrityError: duplicate key, FK violations, NOT NULL.
const INTEGRITY_ERRNOS = new Set([1022, 1048, 1062, 1169, 1216, 1217, 1451, 1452, 1557, 1586, 1761, 1762]);

/** `except mysql.connector.errors.IntegrityError` */
export function isIntegrityError(e: unknown): boolean {
  const n = dbErrno(e);
  return n !== undefined && INTEGRITY_ERRNOS.has(n);
}
