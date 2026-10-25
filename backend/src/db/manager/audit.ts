/**
 * Audit log: an append-only record of mutations made through the API (table `audit_log`,
 * created by db/migrate.ts from schema.sql).
 *
 * Columns: id, actor_ext, actor_user_id, action, entity_type, entity_id, summary, ip, detail,
 * created_at. `actor_ext` is the actor's label: their extension, else their username (an
 * admin without an extension, or `apikey:<name>` for a machine key).
 */

import { getLogger } from '../../core/logger';
import { isoformat, pyInt } from '../../core/py';
import { execute, query } from '../pool';
import type { Params, Row } from '../pool';

const log = getLogger('db.audit');

/**
 * Append one row. Best-effort: never raises to the caller (an audit write must not fail the
 * request that already succeeded). `detail` is the JSON text core/audit.ts built.
 */
export async function insertAuditLog(
  action: string,
  entityType: string,
  opts: {
    actorExt?: string | null;
    actorUserId?: number | null;
    entityId?: string | null;
    summary?: string | null;
    ip?: string | null;
    detail?: string | null;
  } = {},
): Promise<boolean> {
  try {
    await execute(
      'INSERT INTO audit_log (actor_ext, actor_user_id, action, entity_type, entity_id, summary, ip, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [
        opts.actorExt ?? null,
        opts.actorUserId ?? null,
        action,
        entityType,
        opts.entityId ?? null,
        opts.summary ?? null,
        opts.ip ?? null,
        opts.detail ?? null,
      ],
    );
    return true;
  } catch (e) {
    log.error('Error writing audit_log row: %s', e, e);
    return false;
  }
}

/** The filters the audit log narrows by. */
export interface AuditLogFilter {
  action?: string | null;
  entityType?: string | null;
  actor?: string | null;
  /** created_at >= from ('YYYY-MM-DD' = that day's midnight, or an ISO datetime). */
  from?: string | null;
  /** created_at <= to; a plain date includes that whole day. */
  to?: string | null;
}

/** 'YYYY-MM-DD' or an ISO datetime -> 'YYYY-MM-DD HH:MM:SS' (naive, server-local), or null. */
function sqlDatetime(s: string | null | undefined, endOfDay: boolean): string | null {
  const v = String(s ?? '').trim();
  if (!v) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return `${v} ${endOfDay ? '23:59:59' : '00:00:00'}`;
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2})?)/.exec(v);
  if (!m) return null;
  return `${m[1]} ${m[2].length === 5 ? `${m[2]}:00` : m[2]}`;
}

/**
 * The one WHERE builder for the list and its facets. `omitAction` drops the action filter,
 * which is how the action facet ignores its own selection and honours the rest.
 */
function auditWhere(opts: AuditLogFilter, omitAction = false): { where: string[]; params: Params } {
  const where: string[] = [];
  const params: Params = [];
  if (opts.action && !omitAction) {
    where.push('a.action = ?');
    params.push(opts.action);
  }
  if (opts.entityType) {
    where.push('a.entity_type = ?');
    params.push(opts.entityType);
  }
  if (opts.actor) {
    // The stored label, or the account's username / display name (what the panel shows).
    where.push('(a.actor_ext = ? OR a.actor_user_id IN (SELECT id FROM users WHERE username = ? OR name = ?))');
    params.push(opts.actor, opts.actor, opts.actor);
  }
  const from = sqlDatetime(opts.from, false);
  if (from) {
    where.push('a.created_at >= ?');
    params.push(from);
  }
  const to = sqlDatetime(opts.to, true);
  if (to) {
    where.push('a.created_at <= ?');
    params.push(to);
  }
  return { where, params };
}

/** Per-value counts for the audit log's filters, keyed by value. */
export interface AuditLogFacets {
  action: Record<string, number>;
  entity_type: Record<string, number>;
}

/**
 * How many rows carry each action (under the other filters) and each entity type (under all
 * filters but the entity type). Only values that occur are returned. null when the table
 * cannot be read, so the caller can fall back.
 */
export async function auditLogFacets(opts: AuditLogFilter = {}): Promise<AuditLogFacets | null> {
  try {
    const facets: AuditLogFacets = { action: {}, entity_type: {} };
    const a = auditWhere(opts, true);
    const actionSql = `SELECT a.action, COUNT(*) AS n FROM audit_log a${a.where.length ? ` WHERE ${a.where.join(' AND ')}` : ''} GROUP BY a.action`;
    for (const r of await query(actionSql, a.params)) {
      if (typeof r.action === 'string' && r.action) facets.action[r.action] = pyInt(r.n || 0) ?? 0;
    }
    const e = auditWhere({ ...opts, entityType: null });
    const entitySql = `SELECT a.entity_type, COUNT(*) AS n FROM audit_log a${e.where.length ? ` WHERE ${e.where.join(' AND ')}` : ''} GROUP BY a.entity_type`;
    for (const r of await query(entitySql, e.params)) {
      if (typeof r.entity_type === 'string' && r.entity_type) facets.entity_type[r.entity_type] = pyInt(r.n || 0) ?? 0;
    }
    return facets;
  } catch (e) {
    log.warning('Error reading audit_log facets: %s', e);
    return null;
  }
}

export interface AuditLogPage {
  entries: Row[];
  /** Pass back as `before_id` (via the route's opaque cursor) for the next, older page; null on the last page. */
  next_before_id: number | null;
}

/**
 * Recent rows, newest first, optionally filtered. Keyset-paged on id: `beforeId` returns
 * rows older than that id. `limit` defaults to 200, clamped to [1, 1000]. An unreadable
 * table reads as empty (logged), never as an error.
 */
export async function listAuditLog(opts: AuditLogFilter & { limit?: unknown; beforeId?: number | null } = {}): Promise<AuditLogPage> {
  const { where, params } = auditWhere(opts);
  const n = pyInt(opts.limit === undefined || opts.limit === null ? 200 : opts.limit);
  const limit = n === null ? 200 : Math.max(1, Math.min(n, 1000));
  if (opts.beforeId !== null && opts.beforeId !== undefined && Number.isFinite(opts.beforeId)) {
    where.push('a.id < ?');
    params.push(opts.beforeId);
  }
  // `actor` is the display label: the user's name, else their username, else the stored
  // actor_ext (an API key's `apikey:<name>`, or a user deleted since).
  let sql =
    'SELECT a.id, a.actor_ext, a.actor_user_id, a.action, a.entity_type, a.entity_id, a.summary, a.ip, a.detail, a.created_at, ' +
    "COALESCE(NULLIF(u.name, ''), u.username, a.actor_ext) AS actor " +
    'FROM audit_log a LEFT JOIN users u ON u.id = a.actor_user_id';
  if (where.length) sql += ` WHERE ${where.join(' AND ')}`;
  sql += ' ORDER BY a.id DESC LIMIT ?';
  params.push(limit + 1);
  const entries: Row[] = [];
  let more = false;
  try {
    const rows = await query(sql, params);
    more = rows.length > limit;
    for (const r of rows.slice(0, limit)) {
      let detail: unknown = null;
      if (r.detail !== null && r.detail !== undefined && r.detail !== '') {
        try {
          detail = JSON.parse(String(r.detail));
        } catch {
          detail = String(r.detail);
        }
      }
      entries.push({
        id: Number(r.id),
        actor: r.actor ?? r.actor_ext ?? null,
        actor_ext: r.actor_ext ?? null,
        actor_user_id: r.actor_user_id ?? null,
        action: r.action,
        entity_type: r.entity_type,
        entity_id: r.entity_id ?? null,
        summary: r.summary ?? null,
        ip: r.ip ?? null,
        detail,
        created_at: r.created_at instanceof Date ? isoformat(r.created_at) : r.created_at ? String(r.created_at) : null,
      });
    }
  } catch (e) {
    log.warning('Error reading audit_log: %s', e);
  }
  const last = entries[entries.length - 1];
  return { entries, next_before_id: more && last ? Number(last.id) : null };
}
