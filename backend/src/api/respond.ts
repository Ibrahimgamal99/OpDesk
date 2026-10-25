/**
 * Response writing, envelopes, trace ids and the one error renderer (api/envelope.py +
 * api/middleware.py).
 *
 * Success bodies are BARE by default: OpDesk's legacy routes return plain objects and most
 * frontend call sites read top-level keys. The ~17 routes the Python wrapped return
 * `respond(x)` -> `{"data": x}` or `respondList(items, page)` -> `{"data": [...], "page": {...}}`
 * explicitly; nothing is wrapped behind a handler's back.
 *
 * Errors are ALWAYS the envelope, whatever the route:
 *     {"error": {"code", "message", "severity", "retryable", "trace_id", "params", "fields", "details"}}
 * with `code` from api/errors.ts (registry + the legacy message table). Every HTTP response
 * carries `X-Trace-Id`; an inbound one is honoured when it looks like one.
 *
 * Handlers that must not return JSON return one of the response classes below (raw text, a
 * file, a stream, a redirect, or JSON with a non-default status).
 */

import { randomUUID } from 'crypto';
import * as fs from 'fs';
import type { Readable } from 'stream';
import { ArgumentsHost, Catch, ExceptionFilter, HttpException } from '@nestjs/common';
import { ExpressAdapter } from '@nestjs/platform-express';
import type { NextFunction, Request, Response } from 'express';
import { getLogger, pyStr } from '../core/logger';
import { isoformat, pyDatetimeStr } from '../core/py';
import { AppError, codeForLegacy, codes, metaFor, publicMessage, toEnvelope } from './errors';
import type { ErrorEnvelope } from './errors';
import { ErrorDetail, ErrorField, HttpError, STATUS_PHRASES } from './http-error';
import { pyJsonError } from './py-json-error';
import { RequestValidationError } from './validation';

const log = getLogger('api.middleware');

// ---------------------------------------------------------------------------
// Trace ids
// ---------------------------------------------------------------------------

export const TRACE_HEADER = 'X-Trace-Id';
const TRACE_RE = /^[A-Za-z0-9._-]{8,64}$/;

/** uuid4().hex: hex, not the dashed form, so it survives copy-paste out of a UI intact. */
export function newTraceId(): string {
  return randomUUID().replace(/-/g, '');
}

type WithTrace = Request & { traceId?: string };

/** The request's trace id (assigned by traceMiddleware; a fresh one if it never ran). */
export function traceIdOf(req: Request | null | undefined): string {
  const r = req as WithTrace | null | undefined;
  if (r) {
    if (!r.traceId) r.traceId = newTraceId();
    return r.traceId;
  }
  return newTraceId();
}

/**
 * First middleware: honour an inbound X-Trace-Id when it looks like one (an unbounded client
 * string would poison the logs), else mint one, and put it on the response before anything
 * else can write it -- so success, error, static file and SPA responses all carry it.
 */
export function traceMiddleware(req: Request, res: Response, next: NextFunction): void {
  const inbound = String(req.headers['x-trace-id'] ?? '').trim();
  const tid = TRACE_RE.test(inbound) ? inbound : newTraceId();
  (req as WithTrace).traceId = tid;
  res.setHeader(TRACE_HEADER, tid);
  next();
}

// ---------------------------------------------------------------------------
// Envelopes and cursor pagination
// ---------------------------------------------------------------------------

// `limit` is bounded server-side: a client asking for 100 000 rows is a mistake, not a request.
export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;

/** Single-resource envelope `{"data": x}`. null is a legitimate payload. */
export function respond<T>(data: T): { data: T } {
  return { data };
}

export interface PageInfo {
  cursor: string | null;
  next_cursor: string | null;
  limit: number;
  total?: number;
}

/**
 * Collection envelope `{"data": [...], "page": {cursor, next_cursor, limit[, total]}}`.
 * `total` is omitted unless given: it is optional on purpose so callers cannot depend on a
 * COUNT(*) per request.
 */
export function respondList<T>(
  items: Iterable<T>,
  page: { limit?: number; cursor?: string | null; nextCursor?: string | null; total?: number | null } = {},
): { data: T[]; page: PageInfo } {
  const info: PageInfo = { cursor: page.cursor ?? null, next_cursor: page.nextCursor ?? null, limit: page.limit ?? DEFAULT_LIMIT };
  if (page.total !== undefined && page.total !== null) info.total = Math.trunc(Number(page.total));
  return { data: [...items], page: info };
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v instanceof Date) return pyDatetimeStr(v);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as object).sort()) out[k] = sortKeys((v as Record<string, unknown>)[k]);
    return out;
  }
  return v;
}

/** encode_cursor: base64url (no padding) of compact sorted-key JSON. `{id: 123}` -> `eyJpZCI6MTIzfQ`. */
export function encodePageCursor(payload: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(sortKeys(payload)), 'utf8').toString('base64url');
}

/** decode_cursor: {} for no cursor; a coded 400 (request.cursor.invalid) for a malformed one. */
export function decodePageCursor(cursor: string | null | undefined): Record<string, unknown> {
  if (!cursor) return {};
  try {
    if (!/^[A-Za-z0-9_-]+={0,2}$/.test(cursor)) throw new Error('Invalid base64-encoded string');
    const data: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('cursor payload is not an object');
    return data as Record<string, unknown>;
  } catch (e) {
    throw new AppError(codes.REQUEST_CURSOR_INVALID, 'That page link is no longer valid. Reload the list to continue.', {
      details: { reason: e instanceof Error ? e.message : String(e) },
    });
  }
}

export interface PageParams {
  limit: number;
  cursor: string | null;
  keyset: Record<string, unknown>;
}

/** PageParams.parse: default limit 50, clamped to [1, 200]; the cursor decoded (or a 400). */
export function parsePage(cursor?: string | null, limit?: number | null): PageParams {
  let eff = limit === null || limit === undefined || Number.isNaN(limit) ? DEFAULT_LIMIT : Math.trunc(limit);
  eff = Math.max(1, Math.min(MAX_LIMIT, eff));
  return { limit: eff, cursor: cursor || null, keyset: decodePageCursor(cursor) };
}

/** Given `limit + 1` fetched rows: [page, hasMore]. */
export function sliceWithLookahead<T>(rows: T[], limit: number): [T[], boolean] {
  return rows.length > limit ? [rows.slice(0, limit), true] : [rows, false];
}

// ---------------------------------------------------------------------------
// Response classes (FastAPI's Response / JSONResponse / FileResponse / ...)
// ---------------------------------------------------------------------------

export interface ResponseInit {
  status?: number;
  /** A list value sends the header once per item (Set-Cookie). */
  headers?: Record<string, string | string[]>;
}

/** A body sent exactly as given (PlainTextResponse, Response(status_code=204), HTMLResponse). */
export class RawResponse {
  constructor(
    readonly body: string | Buffer = '',
    readonly init: ResponseInit & { contentType?: string } = {},
  ) {}
}

/** JSON with an explicit status/headers (JSONResponse). Never enveloped. */
export class JsonResponse {
  constructor(
    readonly body: unknown,
    readonly init: ResponseInit = {},
  ) {}
}

/** A file from disk (FileResponse): Content-Type, Range/206 and Last-Modified handled by Express. */
export class FileResponse {
  constructor(
    readonly path: string,
    readonly init: ResponseInit & { filename?: string; contentType?: string } = {},
  ) {}
}

/** A streamed body (StreamingResponse). */
export class StreamResponse {
  constructor(
    readonly stream: Readable,
    readonly init: ResponseInit & { contentType?: string } = {},
  ) {}
}

/** A redirect (RedirectResponse; 307 by default, as Starlette). */
export class RedirectResponse {
  constructor(
    readonly url: string,
    readonly init: ResponseInit = {},
  ) {}
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

/**
 * A text cell a spreadsheet would run as a formula -- one starting with = + - @, a tab or a
 * carriage return -- prefixed with a single quote, so Excel and LibreOffice show it as text
 * (CSV / formula injection: a caller ID or a contact name is outside data). A plain number
 * keeps its sign: '+201012345678' and '-5' are data, and no formula is digits alone. Every
 * spreadsheet export writes its text cells through here, CSV and XLSX alike.
 */
export function spreadsheetSafe(s: string): string {
  return /^[=+\-@\t\r]/.test(s) && !/^[+-]?\d+(\.\d+)?$/.test(s) ? `'${s}` : s;
}

function csvCell(v: unknown): string {
  let s: string;
  if (v === null || v === undefined) s = '';
  else if (v instanceof Date) s = pyDatetimeStr(v);
  else if (typeof v === 'boolean') s = v ? 'True' : 'False';
  else if (typeof v === 'number') s = Number.isFinite(v) ? String(v) : '';
  else if (typeof v === 'object') s = spreadsheetSafe(pyStr(v));
  else s = spreadsheetSafe(String(v));
  return `"${s.replace(/"/g, '""')}"`;
}

/** The CSV text OpDesk exports write: UTF-8 BOM (Excel), every cell quoted, CRLF lines. */
export function csvText(header: readonly unknown[], rows: Iterable<readonly unknown[]>, opts: { preamble?: string[]; bom?: boolean } = {}): string {
  const lines: string[] = [];
  for (const p of opts.preamble || []) lines.push(p === '' ? '' : csvCell(p));
  if (opts.preamble?.length) lines.push('');
  lines.push(header.map(csvCell).join(','));
  for (const r of rows) lines.push(r.map(csvCell).join(','));
  return (opts.bom === false ? '' : '﻿') + lines.map((l) => `${l}\r\n`).join('');
}

/**
 * A CSV download: `text/csv; charset=utf-8`, `Content-Disposition: attachment; filename="<name>"`.
 * `preamble` lines (e.g. "Generated at: ...") are written quoted above a blank line, as the
 * Python exports did.
 */
export function csvResponse(
  filename: string,
  header: readonly unknown[],
  rows: Iterable<readonly unknown[]>,
  opts: { preamble?: string[]; bom?: boolean } = {},
): RawResponse {
  const name = filename.toLowerCase().endsWith('.csv') ? filename : `${filename}.csv`;
  return new RawResponse(Buffer.from(csvText(header, rows, opts), 'utf8'), {
    contentType: 'text/csv; charset=utf-8',
    headers: { 'Content-Disposition': `attachment; filename="${name.replace(/"/g, '')}"` },
  });
}

// ---------------------------------------------------------------------------
// JSON encoding with FastAPI's jsonable_encoder semantics
// ---------------------------------------------------------------------------

/**
 * Converts a handler's return value into what FastAPI would have serialised:
 * Date -> naive local isoformat, Buffer -> utf-8 text, Set -> list, Map -> object,
 * and a key whose value is undefined -> null (a Python dict literal always carried its keys).
 */
export function toJsonable(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : isoformat(value);
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(toJsonable);
  if (value instanceof Set) return [...value].map(toJsonable);
  if (value instanceof Map) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of value) out[String(k)] = toJsonable(v);
    return out;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as object)) {
    if (typeof v === 'function') continue;
    out[k] = toJsonable(v);
  }
  return out;
}

function applyHeaders(res: Response, headers?: Record<string, string | string[]>): void {
  for (const [k, v] of Object.entries(headers || {})) res.setHeader(k, v);
}

/** Write a JSON body (bare: nothing is wrapped here). */
export function sendJson(res: Response, status: number, body: unknown, headers?: Record<string, string | string[]>): void {
  applyHeaders(res, headers);
  res.status(status);
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(toJsonable(body)));
}

/**
 * ExpressAdapter whose reply() is the single writer of every controller result. Nest passes
 * the @HttpCode status (default 200 via api/routing.ts) on res.
 */
export class OpDeskExpressAdapter extends ExpressAdapter {
  override reply(response: Response, body: unknown, statusCode?: number): void {
    const res = response;
    const status = statusCode ?? res.statusCode ?? 200;
    if (body instanceof RawResponse) {
      applyHeaders(res, body.init.headers);
      res.status(body.init.status ?? status);
      if (body.init.contentType) res.setHeader('Content-Type', body.init.contentType);
      res.end(body.body);
      return;
    }
    if (body instanceof JsonResponse) {
      sendJson(res, body.init.status ?? status, body.body, body.init.headers);
      return;
    }
    if (body instanceof FileResponse) {
      applyHeaders(res, body.init.headers);
      res.status(body.init.status ?? status);
      if (body.init.contentType) res.type(body.init.contentType);
      if (body.init.filename) res.attachment(body.init.filename);
      res.sendFile(
        body.path,
        { dotfiles: 'allow', headers: body.init.contentType ? { 'Content-Type': body.init.contentType } : undefined },
        (err) => {
          if (err && !res.headersSent) {
            const missing = !fs.existsSync(body.path);
            renderError(res.req as Request, res, new HttpError(missing ? 404 : 500, missing ? 'Not Found' : null));
          }
        },
      );
      return;
    }
    if (body instanceof StreamResponse) {
      applyHeaders(res, body.init.headers);
      res.status(body.init.status ?? status);
      if (body.init.contentType) res.setHeader('Content-Type', body.init.contentType);
      body.stream.on('error', (e) => {
        log.error('stream response failed on %s', res.req?.path, e);
        res.destroy(e);
      });
      body.stream.pipe(res);
      return;
    }
    if (body instanceof RedirectResponse) {
      applyHeaders(res, body.init.headers);
      res.redirect(body.init.status ?? 307, body.url);
      return;
    }
    sendJson(res, status, body);
  }
}

// ---------------------------------------------------------------------------
// /api 404 / 405 (the `/api/{rest:path}` fallback)
// ---------------------------------------------------------------------------

interface RouterLayer {
  route?: { path?: unknown; methods?: Record<string, boolean> };
  match?: (path: string) => boolean;
}

/**
 * Methods of every real /api route whose pattern matches `path` (sorted, upper-case). Read
 * from Express's own router so it can never disagree with routing. The SPA catch-all is not
 * an /api route and does not count -- counting it would turn every 404 into a 405.
 */
export function allowedApiMethods(req: Request, path: string): string[] {
  const app = req.app as unknown as { router?: { stack?: RouterLayer[] }; _router?: { stack?: RouterLayer[] } } | undefined;
  const stack = app?.router?.stack ?? app?._router?.stack ?? [];
  const allowed = new Set<string>();
  for (const layer of stack) {
    const route = layer.route;
    if (!route || typeof route.path !== 'string' || !route.path.startsWith('/api')) continue;
    if (typeof layer.match !== 'function') continue;
    let hit = false;
    try {
      hit = layer.match(path);
    } catch {
      hit = false;
    }
    if (!hit) continue;
    for (const [m, on] of Object.entries(route.methods || {})) if (on && m !== '_all') allowed.add(m.toUpperCase());
  }
  return [...allowed].sort();
}

/** The error an unrouted /api request gets: 405 + Allow when the path exists, else 404. */
export function apiFallbackError(req: Request): HttpError {
  const allowed = allowedApiMethods(req, req.path);
  if (allowed.length) return new HttpError(405, 'Method Not Allowed', { Allow: allowed.join(', ') });
  return new HttpError(404, 'Not Found');
}

export function isApiPath(path: string): boolean {
  return path === '/api' || path.startsWith('/api/');
}

let spaInstalled = false;

/** Called by the SPA controller when frontend/dist exists: unrouted non-GET paths are then 405 (Allow: GET). */
export function markSpaInstalled(): void {
  spaInstalled = true;
}

// ---------------------------------------------------------------------------
// The error renderer
// ---------------------------------------------------------------------------

function isBodyParserError(e: unknown): e is Error & { status: number; type: string; body?: unknown } {
  return e instanceof Error && typeof (e as { type?: unknown }).type === 'string' && typeof (e as { status?: unknown }).status === 'number';
}

function httpStatusOf(e: unknown): number | null {
  if (!(e instanceof Error)) return null;
  const s = (e as { status?: unknown; statusCode?: unknown }).status ?? (e as { statusCode?: unknown }).statusCode;
  return typeof s === 'number' && s >= 400 && s < 600 ? s : null;
}

function fromHttpError(err: HttpError): AppError {
  const detail: string | ErrorDetail | null = err.detail;
  if (detail && typeof detail === 'object') {
    const message = detail.message || detail.detail || STATUS_PHRASES[err.status] || 'Request failed.';
    const code = detail.code || codeForLegacy(err.status, message);
    return new AppError(code, err.status >= 500 && !detail.code ? publicMessage(code, message, err.status) : message, {
      status: err.status,
      fields: detail.fields,
      details: detail.details,
      params: detail.params,
      headers: err.headers,
    });
  }
  // Starlette filled a missing detail with the status phrase.
  const text = detail === null ? STATUS_PHRASES[err.status] || '' : String(detail);
  const code = codeForLegacy(err.status, text);
  const meta = metaFor(code);
  return new AppError(code, publicMessage(code, text, err.status), {
    status: err.status,
    severity: meta.severity,
    retryable: meta.retryable,
    headers: err.headers,
  });
}

/** Any thrown value -> the AppError it renders as. Unknown errors become a safe 500. */
export function toAppError(exception: unknown, req: Request): AppError {
  if (exception instanceof AppError) return exception;
  if (exception instanceof RequestValidationError) {
    const fields = exception.fields;
    return new AppError(codes.REQUEST_BODY_INVALID, fields.length ? 'Some fields need attention.' : 'The request body is not valid.', {
      fields,
      severity: 'warning',
    });
  }
  if (exception instanceof HttpError) return fromHttpError(exception);
  if (exception instanceof HttpException) {
    const status = exception.getStatus();
    // Nest's router found no route ("Cannot GET /x"): the /api fallback, or Starlette's
    // 405 (Allow: GET) for a non-GET on a path only the SPA catch-all would serve.
    if (status === 404 && /^Cannot [A-Z]+ /.test(exception.message)) {
      if (isApiPath(req.path)) return fromHttpError(apiFallbackError(req));
      if (spaInstalled && req.method !== 'GET' && req.method !== 'HEAD') {
        return fromHttpError(new HttpError(405, 'Method Not Allowed', { Allow: 'GET' }));
      }
      return fromHttpError(new HttpError(404, 'Not Found'));
    }
    return fromHttpError(new HttpError(status, STATUS_PHRASES[status] || exception.message));
  }
  if (isBodyParserError(exception)) {
    if (exception.type === 'entity.parse.failed') {
      // Pydantic's json_invalid: the loc is ('body', <pos>) -> path "[pos]", params.error is
      // json.loads's message ("Expecting value", ...). The body parser keeps the raw text.
      const raw = exception.body;
      const where = typeof raw === 'string' ? pyJsonError(raw) : null;
      const fields: ErrorField[] = [
        {
          path: where ? `[${where.pos}]` : '_',
          code: 'value.json_invalid',
          message: 'JSON decode error',
          params: where ? { error: where.msg } : {},
        },
      ];
      return new AppError(codes.REQUEST_BODY_INVALID, 'Some fields need attention.', { fields, severity: 'warning' });
    }
    return fromHttpError(new HttpError(exception.status, STATUS_PHRASES[exception.status] || null));
  }
  const status = httpStatusOf(exception);
  if (status !== null && status < 500) return fromHttpError(new HttpError(status, STATUS_PHRASES[status] || null));
  return new AppError(codes.INTERNAL_UNEXPECTED, publicMessage(codes.INTERNAL_UNEXPECTED, '', 500), { cause: exception });
}

/** The envelope an error renders as for this request (used by tests and the WS layer). */
export function errorEnvelope(exception: unknown, req: Request): { status: number; body: ErrorEnvelope; headers: Record<string, string> } {
  const err = toAppError(exception, req);
  const tid = traceIdOf(req);
  return { status: err.status, body: toEnvelope(err, tid), headers: { ...(err.headers || {}), [TRACE_HEADER]: tid } };
}

/**
 * Write the error envelope for `exception`. 5xx are ours and logged with the trace id and the
 * real error (whose text never reaches the client); 401/403 are warnings so an auth regression
 * is visible; other 4xx are the caller's mistake and already an access-log line.
 */
export function renderError(req: Request, res: Response, exception: unknown): void {
  const { status, body, headers } = errorEnvelope(exception, req);
  const tid = body.error.trace_id;
  if (status >= 500) {
    const raw = exception instanceof HttpError ? pyStr(exception.detail) : '';
    log.error('[%s] %s %s -> %s %s%s', tid, req.method, req.path, status, body.error.code, raw ? ` (detail=${raw})` : '', exception);
  } else if (status === 401 || status === 403) {
    log.warning('[%s] %s %s -> %s %s', tid, req.method, req.path, status, body.error.code);
  } else {
    log.debug('[%s] %s %s -> %s %s', tid, req.method, req.path, status, body.error.code);
  }
  sendJson(res, status, body, headers);
}

/** The global exception filter: every error from any route, guard or middleware ends here. */
@Catch()
export class EnvelopeExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    if (host.getType() !== 'http') return; // the /ws socket handles its own
    const ctx = host.switchToHttp();
    const req = ctx.getRequest<Request>();
    const res = ctx.getResponse<Response>();
    if (!res || typeof res.status !== 'function') return;
    if (res.headersSent) {
      log.error('error after the response started on %s', req?.path, exception);
      res.end();
      return;
    }
    renderError(req, res, exception);
  }
}

/**
 * Express error middleware, mounted right after the JSON body parser. Nest maps any
 * SyntaxError to a bare 400 before filters run; re-wrapping the parser's error as a plain
 * Error keeps its type, status and raw body, so the filter can render Pydantic's json_invalid.
 */
export function jsonBodyErrors(err: unknown, req: Request, res: Response, next: NextFunction): void {
  if (err instanceof SyntaxError && (err as { type?: unknown }).type === 'entity.parse.failed') {
    // The client-log beacon is fire-and-forget (sendBeacon at pagehide can truncate the
    // body): it has always answered 204 whatever it received, so a client never retries it.
    if (req.path === '/api/client-log') {
      res.status(204).end();
      return;
    }
    next(Object.assign(new Error('JSON decode error'), { type: 'entity.parse.failed', status: 400, body: (err as { body?: unknown }).body }));
    return;
  }
  next(err);
}

/** Last-resort Express error handler (errors raised outside Nest, e.g. by express.static). */
export function expressErrorHandler(err: unknown, req: Request, res: Response, next: NextFunction): void {
  if (res.headersSent) {
    next(err);
    return;
  }
  renderError(req, res, err);
}
