/**
 * Logs: the browser log beacon, the audit log, the System Logs panel (live AMI events and the
 * SIP trace), and the CRM delivery log (list, detail, resend).
 *
 * Envelopes follow OpDesk's contract per route: GET /api/logs/deliveries is the one
 * respond_list collection; everything else is bare; the beacon answers 204 with no body.
 *
 * Python: the matching server.py routes.
 */

import { Controller, Req } from '@nestjs/common';
import type { Request } from 'express';
import { getLogger } from '../../core/logger';
import { createTask, pyInt, pyJsonDumps } from '../../core/py';
import { runtime } from '../../core/runtime';
import { amiEventBuffer, sipTracer } from '../../core/system-logs';
import * as dbm from '../../db/db-manager';
import { loadCrmSyncConfig, sendCrmDataAsync } from '../../integrations/crm';
import { setPjsipLogger } from '../../services/dialplan';
import { HttpError } from '../http-error';
import { decodePageCursor, encodePageCursor, parsePage, RawResponse, respondList } from '../respond';
import { Auth, Get, Post, principal } from '../routing';
import { parseBody, pInt, qBool, qInt, qStr, v } from '../validation';
import type { QueryParams } from '../validation';

const log = getLogger('api.routes.logs');

/** Browser-side log lines land under this logger name. */
export const clientLog = getLogger('opdesk.client');

const CLIENT_LOG_MAX_BYTES = 64 * 1024;

export const LogToggleBody = v.model({ enabled: v.bool() });

/**
 * `await request.body()` for the client-log beacon.
 *
 * A text/plain beacon (navigator.sendBeacon with a string) reaches the handler unread, so the
 * bytes are read here. A JSON-typed one was already consumed by the body parser in main.ts;
 * its bytes are gone (`consumed`), and req.body holds what it parsed.
 */
async function clientLogBody(req: Request): Promise<{ raw: Buffer | null; consumed: boolean }> {
  if (req.body !== undefined || (req.complete && !req.readable)) return { raw: null, consumed: true };
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  return { raw: Buffer.concat(chunks), consumed: false };
}

/** str(x) of a JSON value, Python style (True/False/None, dicts as their repr is close enough). */
function pyText(x: unknown): string {
  if (x === null || x === undefined) return 'None';
  if (typeof x === 'boolean') return x ? 'True' : 'False';
  if (typeof x === 'object') return pyJsonDumps(x);
  return String(x);
}

function cp(s: string, n: number): string {
  return [...s].slice(0, n).join('');
}

function q(req: Request, name: string): string | null {
  const value = qStr(req.query as QueryParams, name, null as string | null);
  return value === null ? null : String(value);
}

@Controller()
export class LogsController {
  /**
   * Diagnostic sink for browser-side logs (esp. mobile, where devtools are not reachable).
   * Intentionally UNAUTHENTICATED: the frontend ships logs via navigator.sendBeacon(), which
   * cannot set an Authorization header and must work during pagehide/freeze — exactly the
   * moment we need to capture. Entries are size-capped and only logged, never persisted.
   * Body: { session: str, entries: [{ t: <ms>, tag: str, msg: str, data?: any }, ...] }.
   * Always 204, even for a body that is not JSON.
   */
  @Post('/api/client-log')
  @Auth('public')
  async clientLogEndpoint(@Req() req: Request) {
    const empty = new RawResponse('', { status: 204, contentType: 'text/plain; charset=utf-8' });
    let payload: unknown;
    try {
      const body = await clientLogBody(req);
      if (body.consumed) {
        payload = req.body ?? {};
        if (Buffer.byteLength(JSON.stringify(payload), 'utf8') > CLIENT_LOG_MAX_BYTES) return empty; // truncated JSON never parsed
      } else {
        let raw = body.raw as Buffer;
        if (raw.length > CLIENT_LOG_MAX_BYTES) raw = raw.subarray(0, CLIENT_LOG_MAX_BYTES); // cap payload; drop anything abusive
        payload = JSON.parse(raw.length ? raw.toString('utf8') : '{}');
      }
    } catch {
      return empty;
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return empty;
    const p = payload as Record<string, unknown>;
    const session = cp(pyText(p.session === undefined ? '?' : p.session), 64);
    const entries = Array.isArray(p.entries) ? p.entries : [];
    for (const e of entries.slice(0, 200)) {
      if (!e || typeof e !== 'object' || Array.isArray(e)) continue;
      const entry = e as Record<string, unknown>;
      const tag = cp(pyText(entry.tag === undefined ? '' : entry.tag), 40);
      const msg = cp(pyText(entry.msg === undefined ? '' : entry.msg), 1000);
      const data = entry.data;
      const isEmptyDict = data !== null && typeof data === 'object' && !Array.isArray(data) && Object.keys(data).length === 0;
      const suffix = data !== undefined && data !== null && data !== '' && !isEmptyDict ? ` | ${cp(pyJsonDumps(data), 1000)}` : '';
      clientLog.info('CLIENT[%s] %s: %s%s', session, tag, msg, suffix);
    }
    return empty;
  }

  // -------------------------------------------------------------------------
  // System Logs (admin). Literal sub-paths are declared before /api/logs/deliveries/:id.
  // -------------------------------------------------------------------------

  /** Live AMI events newer than `since`. The panel polls this with a seq cursor. */
  @Get('/api/logs')
  @Auth('admin')
  async apiLogs(@Req() req: Request) {
    const query = req.query as QueryParams;
    const since = qInt(query, 'since', 0);
    const event = String(qStr(query, 'event', ''));
    const text = String(qStr(query, 'q', ''));
    return { lines: amiEventBuffer.snapshot({ since, event, q: text }) };
  }

  /** Distinct AMI event names currently buffered (drives the filter dropdown). */
  @Get('/api/logs/events')
  @Auth('admin')
  async apiLogEventNames() {
    return { events: amiEventBuffer.eventNames() };
  }

  /** Whether AMI event buffering is on. */
  @Get('/api/logs/ami')
  @Auth('admin')
  async apiGetAmiLogging() {
    return { enabled: amiEventBuffer.enabled };
  }

  /** Turn AMI event buffering on/off. Off by default — this is a debugging tool. */
  @Post('/api/logs/ami')
  @Auth('admin')
  async apiSetAmiLogging(@Req() req: Request) {
    const body = parseBody(LogToggleBody, req.body);
    amiEventBuffer.enabled = Boolean(body.enabled);
    log.info('AMI event buffering %s by %s', body.enabled ? 'enabled' : 'disabled', principal(req).username);
    return { enabled: amiEventBuffer.enabled };
  }

  /** Whether the raw SIP message trace is running, plus the last start failure. */
  @Get('/api/logs/siptrace')
  @Auth('admin')
  async apiGetSipTrace() {
    return { enabled: sipTracer.enabled, error: sipTracer.lastError };
  }

  /**
   * Turn the SIP message trace on/off. Two moving parts: Asterisk's PJSIP logger (so it
   * writes SIP messages at all) and our log tailer (so they reach the panel). The tailer
   * starts first — if it cannot read the log file there is no point enabling the logger.
   * A start failure is a 500 with the safe message; the reason is in GET's `error`.
   */
  @Post('/api/logs/siptrace')
  @Auth('admin')
  async apiSetSipTrace(@Req() req: Request) {
    const body = parseBody(LogToggleBody, req.body);
    if (body.enabled) {
      if (!(await sipTracer.start())) throw new HttpError(500, sipTracer.lastError || 'Could not start SIP trace');
      await setPjsipLogger(true);
    } else {
      await setPjsipLogger(false);
      sipTracer.stop();
    }
    log.info('SIP trace %s by %s', body.enabled ? 'enabled' : 'disabled', principal(req).username);
    return { enabled: sipTracer.enabled, error: sipTracer.lastError };
  }

  // -------------------------------------------------------------------------
  // CRM delivery log (admin)
  // -------------------------------------------------------------------------

  /**
   * Page through CRM call-data push attempts, newest first. Bodies omitted — see the detail
   * route. Cursor-paginated: `?cursor=` is opaque (it carries the last seen id, used as a
   * keyset seek).
   */
  @Get('/api/logs/deliveries')
  @Auth('admin')
  async listDeliveries(@Req() req: Request) {
    const query = req.query as QueryParams;
    const success = qBool(query, 'success', null as boolean | null);
    const limit = qInt(query, 'limit', 50);
    const page = parsePage(q(req, 'cursor'), limit);
    const afterId = pyInt(page.keyset.id);
    const [rows, hasMore] = await dbm.listWebhookDeliveries({
      success,
      callId: q(req, 'call_id'),
      callType: q(req, 'call_type'),
      search: q(req, 'search'),
      dateFrom: q(req, 'date_from'),
      dateTo: q(req, 'date_to'),
      limit: page.limit,
      afterId,
    });
    return respondList(rows, {
      limit: page.limit,
      cursor: page.cursor,
      nextCursor: hasMore && rows.length ? encodePageCursor({ id: rows[rows.length - 1].id }) : null,
    });
  }

  /** One delivery attempt in full, including the request and response bodies. */
  @Get('/api/logs/deliveries/:delivery_id')
  @Auth('admin')
  async getDelivery(@Req() req: Request) {
    const deliveryId = pInt(req.params.delivery_id, 'delivery_id');
    const row = await dbm.getWebhookDelivery(deliveryId);
    if (!row) throw new HttpError(404, 'Delivery not found');
    return row;
  }

  /**
   * Replay a delivery through the CURRENT connector configuration.
   *
   * The stored request body is replayed verbatim — buildCrmPayload is deliberately NOT
   * re-run: the body is the historical fact worth replaying, and a resend that sends
   * different data than the UI shows is a debugging trap. The credentials and URL, by
   * contrast, are re-read from current config: a wrong endpoint is usually why it failed.
   */
  @Post('/api/logs/deliveries/:delivery_id/resend', { status: 202 })
  @Auth('admin')
  async resendDelivery(@Req() req: Request) {
    const deliveryId = pInt(req.params.delivery_id, 'delivery_id');
    const user = principal(req);
    const row = await dbm.getWebhookDelivery(deliveryId);
    if (!row) throw new HttpError(404, 'Delivery not found');
    if (row.truncated) throw new HttpError(400, 'Request body was truncated when logged and cannot be replayed safely.');
    let body: unknown;
    try {
      body = JSON.parse(String(row.request_body || ''));
    } catch {
      throw new HttpError(400, 'Stored request body is not valid JSON');
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'Stored request body is not a JSON object');
    if (!runtime.crmConnector) throw new HttpError(503, 'CRM connector is not configured');
    if (!runtime.monitor) throw new HttpError(503, 'AMI monitor unavailable');

    const cfg = await loadCrmSyncConfig();
    const meta = {
      call_id: row.call_id,
      uniqueid: row.uniqueid,
      caller: row.caller,
      destination: row.destination,
      call_type: row.call_type,
      call_status: row.call_status,
      attempt: (pyInt(row.attempt) || 1) + 1,
      parent_id: deliveryId,
      resent_by: user.id,
    };
    createTask(
      sendCrmDataAsync(runtime.crmConnector, body as Record<string, unknown>, {
        method: cfg.method,
        endpointPath: cfg.endpoint,
        meta,
      }),
    );
    log.info('Delivery #%s resent by %s', deliveryId, user.username);
    return { accepted: true, delivery_id: deliveryId, original_created_at: row.created_at ?? null };
  }
}
