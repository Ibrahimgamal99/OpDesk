/**
 * Audit log middleware: records every successful mutation made through the API in one place.
 *
 * Captures POST/PUT/PATCH/DELETE on /api/ paths that answer 2xx, taking the actor from the
 * principal the auth guard left on the request (so the token is verified once) and the
 * entity from the path. Auth, telemetry and plumbing paths are skipped, so no handler has to
 * call an audit helper. A route that wants to record WHAT changed calls setAuditDetail().
 */

import type { NextFunction, Request, Response } from 'express';
import { clientHost } from '../api/client-host';
import { isSecretKey, SECRET_MASK } from '../api/shared';
import { insertAuditLog } from '../db/manager/audit';
import { getLogger } from './logger';
import { pyDatetimeStr } from './py';
import { principalOf } from './security';

const log = getLogger('core.audit');

const AUDIT_ACTIONS: Record<string, string> = { POST: 'create', DELETE: 'delete', PUT: 'update', PATCH: 'update' };

// A route may attach a detail (any JSON-able value) saying what the mutation carried or
// removed, where the method and path alone cannot -- built from an explicit field list, never
// a raw request body (no passwords or secrets). Stored as JSON in audit_log.detail; capped so
// one bulk request cannot bloat the table, and stays valid JSON past the cap.
export const AUDIT_DETAIL_MAX = 65536;

type WithAudit = Request & { auditDetail?: unknown };

/** request.state.audit_detail = detail */
export function setAuditDetail(req: Request, detail: unknown): void {
  (req as WithAudit).auditDetail = detail;
}

/**
 * A copy of `value` safe to store as an audit detail: at any depth, a non-empty value under
 * a secret-named key (api_key, password, bearer_token, *_SECRET, *_PASS ...: api/shared's
 * isSecretKey) becomes SECRET_MASK, so the row says THAT a secret changed, never what to.
 */
export function redactAuditDetail(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactAuditDetail);
  if (value === null || typeof value !== 'object' || value instanceof Date) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = isSecretKey(k) && v !== null && v !== undefined && v !== '' ? SECRET_MASK : redactAuditDetail(v);
  }
  return out;
}

/** setAuditDetail(req, redactAuditDetail(detail)): the form every route should use. */
export function setRedactedAuditDetail(req: Request, detail: unknown): void {
  setAuditDetail(req, redactAuditDetail(detail));
}

/** json.dumps(x, ensure_ascii=False, default=str) with Python's default separators. */
function pyJsonDumpsUnicode(value: unknown): string {
  const enc = (v: unknown): string => {
    if (v === null || v === undefined) return 'null';
    if (v instanceof Date) return JSON.stringify(pyDatetimeStr(v));
    if (Array.isArray(v)) return `[${v.map(enc).join(', ')}]`;
    if (v instanceof Set) return enc([...v]);
    if (v instanceof Map) return enc(Object.fromEntries(v));
    if (typeof v === 'object') {
      return `{${Object.entries(v as object)
        .map(([k, x]) => `${JSON.stringify(k)}: ${enc(x)}`)
        .join(', ')}}`;
    }
    if (typeof v === 'number') return Number.isFinite(v) ? String(v) : v > 0 ? 'Infinity' : v < 0 ? '-Infinity' : 'NaN';
    if (typeof v === 'bigint') return v.toString();
    return JSON.stringify(v);
  };
  return enc(value);
}

/** The stored text of a detail, or null. Truncated past AUDIT_DETAIL_MAX code points. */
export function auditDetailText(detail: unknown): string | null {
  if (detail === null || detail === undefined) return null;
  const text = pyJsonDumpsUnicode(detail);
  const chars = Array.from(text);
  if (chars.length > AUDIT_DETAIL_MAX) {
    return pyJsonDumpsUnicode({ truncated: true, chars: chars.length, head: chars.slice(0, AUDIT_DETAIL_MAX).join('') });
  }
  return text;
}

/** Paths that are auth/telemetry noise, plumbing, or the audit surface itself. */
export function auditSkip(path: string): boolean {
  if (path.startsWith('/api/auth/')) return true; // login
  if (path === '/api/client-log') return true; // frontend telemetry beacon
  if (path.startsWith('/api/internal/')) return true; // dialplan plumbing (mobile wake)
  if (path === '/api/logs/ami' || path === '/api/logs/siptrace') return true; // System Logs on/off toggles
  if (path === '/api/push/web-resubscribe') return true; // the service worker rotating its subscription
  if (path === '/api/device-tokens') return true; // phones registering / dropping their push token
  if (path === '/api/audit-log') return true;
  if (path === '/api/extension-config/lookup') return true; // a read; POST only to keep the username out of the URL
  return false;
}

/** '/api/settings/users/5' -> ['settings', '5']: the first segment is the entity type, a trailing all-digits segment the id. */
export function auditEntity(path: string): [string, string | null] {
  let p = path;
  if (p.startsWith('/api/')) p = p.slice('/api/'.length);
  p = p.replace(/^\/+|\/+$/g, '');
  if (!p) return ['', null];
  const parts = p.split('/');
  const entityType = parts[0];
  const last = parts[parts.length - 1];
  const entityId = parts.length > 1 && /^\p{Nd}+$/u.test(last) ? last : null;
  return [entityType, entityId];
}

/** Express middleware: writes the audit row once the response has finished with a 2xx. */
export function auditMutations(req: Request, res: Response, next: NextFunction): void {
  const method = req.method;
  const path = req.path;
  if (!(method in AUDIT_ACTIONS) || !path.startsWith('/api/') || auditSkip(path)) {
    next();
    return;
  }
  res.on('finish', () => {
    if (res.statusCode < 200 || res.statusCode >= 300) return;
    const [entityType, entityId] = auditEntity(path);
    if (!entityType) return;
    const principal = principalOf(req);
    // Actor label: the extension, else the username (an admin without one, or apikey:<name>).
    const actorExt = principal ? principal.extension || principal.username || null : null;
    const actorUserId = principal ? principal.id : null;
    let detail: string | null;
    try {
      detail = auditDetailText((req as WithAudit).auditDetail);
    } catch (e) {
      log.error('audit log write failed: %s (audit record lost)', e, e);
      return;
    }
    insertAuditLog(AUDIT_ACTIONS[method], entityType, {
      actorExt,
      actorUserId,
      entityId,
      summary: `${method} ${path}`,
      ip: clientHost(req),
      detail,
    }).catch((e: unknown) => log.error('audit log write failed: %s (audit record lost)', e, e));
  });
  next();
}
