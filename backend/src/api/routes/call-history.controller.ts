/**
 * Call history: the call log (+ its CSV export), call journeys, VAD results, call
 * notifications (the missed-call bell), and recordings (playback, the admin list, delete).
 *
 * Visibility (core/scope): an admin or API key sees every call; a supervisor the calls of
 * the extensions in their groups; an agent only calls their own extension took part in. The
 * list routes filter by that scope; every route that takes one call's id (journey, VAD,
 * recording) answers 403 "Not allowed to view this call" for a call outside it.
 *
 * Supervision is not the monitored agent's to see: a supervisor's ChanSpy call is keyed to
 * its target (the spy leg's src is the agent's extension), so the agent's own history would
 * list "Listen" and its journey would show LISTEN/WHISPER/BARGE. Role agent never gets
 * ChanSpy calls, nor supervision events in a journey; supervisors and admins keep both.
 */

import { Controller, Req } from '@nestjs/common';
import type { Request } from 'express';
import { getLogger } from '../../core/logger';
import { dateIso } from '../../core/py';
import { assertCallVisible, historyExtensions, isUnrestricted, type ScopeLike } from '../../core/scope';
import * as dbm from '../../db/db-manager';
import { LimitValueError } from '../../db/db-manager';
import type { Row } from '../../db/pool';
import {
  buildCallJourneyFromCdr,
  callLog as getCallLog,
  callLogPage,
  callStatus,
  type CallLogFilters,
  matchesCallLogFilters,
} from '../../services/call-log';
import {
  deleteRecordingByUniqueid,
  getRecordingPath,
  pyBasename,
  recordingContentType,
  resolveRecordingRequest,
} from '../../services/recording';
import { HttpError } from '../http-error';
import { FileResponse, RawResponse, spreadsheetSafe } from '../respond';
import { Auth, Delete, Get, Patch, principal } from '../routing';
import { parseBody, pInt, pStr, qBool, qInt, qList, qStr, QueryParams, REQUIRED, v } from '../validation';
import * as fs from 'fs';

const log = getLogger('api.routes.call_history');

export const CallNotificationUpdate = v.model({
  status_flag: v.str(),
});

// The CSV export's row cap: a month of a busy queue, and still one bounded query.
export const CALL_LOG_EXPORT_MAX_ROWS = 50_000;

/** date_from as the list route defaults it: UTC today - 30 days, when no date was given. */
function defaultDateFrom(): string {
  return new Date(Date.now() - 30 * 86400 * 1000).toISOString().slice(0, 10);
}

/** A comma-separated and/or repeated query parameter, upper/lower-cased as asked; null when absent. */
function qSet(q: QueryParams, name: string, upper = true): Set<string> | null {
  const raw = qList(q, name, null);
  if (raw === null) return null;
  const vals = raw
    .flatMap((s) => s.split(','))
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => (upper ? s.toUpperCase() : s.toLowerCase()));
  return vals.length ? new Set(vals) : null;
}

/**
 * The table filters as query parameters: status (call statuses, any spelling the UI ever
 * used), call_type (IN/OUT/INTERNAL), app (queue/ivr/direct), route (a route or its side:
 * inbound/outbound/internal), each a comma list or repeated.
 */
function qFilters(q: QueryParams): CallLogFilters {
  const status = qSet(q, 'status');
  return {
    status: status ? new Set([...status].map((s) => callStatus(s) || s)) : null,
    callType: qSet(q, 'call_type'),
    app: qSet(q, 'app', false),
    route: qSet(q, 'route', false),
  };
}

/** Role agent never sees supervision (see the module note); supervisors, admins and API keys do. */
export function hidesSupervision(p: ScopeLike): boolean {
  return p.role === 'agent' && !p.api_key;
}

/** A supervisor's ChanSpy call: OpDesk's spy-<supervisor>-<target>-<ms> key, or a ChanSpy leg. */
export function isSupervisionCall(legs: Row[]): boolean {
  return (legs || []).some((l) => String(l.linkedid ?? '').startsWith('spy-') || l.lastapp === 'ChanSpy');
}

/** A single-call read of a supervision call is 403 for an agent, as a call outside their scope is. */
function assertNotHiddenSupervision(p: ScopeLike, legs: Row[]): void {
  if (hidesSupervision(p) && isSupervisionCall(legs)) throw new HttpError(403, 'Not allowed to view this call');
}

/**
 * Extensions whose missed-call notifications `p` may read; null = every extension. An agent
 * reads their own; a supervisor the agents of their groups AND their own extension -- the
 * realtime fan-out rings a supervisor's bell for every agent in scope, and their own
 * extension is usually not one of their groups' agents, which made the bell a 403.
 */
export function notificationExtensions(p: ScopeLike): string[] | null {
  if (isUnrestricted(p)) return null;
  const allowed = historyExtensions(p) ?? [];
  const own = String(p.extension ?? '').trim();
  return own && !allowed.includes(own) ? [...allowed, own] : allowed;
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

const CSV_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

/**
 * One CSV cell: quoted when it holds a separator, quote or newline. A cell a spreadsheet
 * would run as a formula is prefixed with a quote character (respond.spreadsheetSafe).
 */
export function csvCell(value: unknown): string {
  let s = value === null || value === undefined ? '' : value instanceof Date ? dateTime(value) : String(value);
  s = spreadsheetSafe(s);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function dateTime(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${dateIso(d)} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

const DIRECTION_LABEL: Record<string, string> = { IN: 'Inbound', OUT: 'Outbound', INTERNAL: 'Internal' };
const ENDED_BY_LABEL: Record<string, string> = { agent: 'Agent', customer: 'Customer', system: 'System' };

export const CALL_LOG_CSV_HEADER = [
  'Date', 'Direction', 'From', 'To', 'Contact', 'Agent', 'Route', 'Queue', 'Duration (s)', 'Talk (s)',
  'Status', 'Ended by', 'Recording', 'Call ID',
];

/** One call-log row as the CSV line the Call History table shows. */
export function callLogCsvRow(r: Row): unknown[] {
  const endedBy = r.ended_by ? `${ENDED_BY_LABEL[r.ended_by] ?? r.ended_by}${r.ended_by_agent ? ` (${r.ended_by_agent})` : ''}` : '';
  return [
    r.calldate,
    DIRECTION_LABEL[r.call_type] ?? r.call_type ?? '',
    r.src,
    r.dst,
    r.customer_name, // the remote party's name (call-log.resolveCustomerName), never our agent's
    r.extension,
    r.app,
    r.app === 'queue' ? r.dst : '',
    r.duration ?? 0,
    r.talk ?? 0,
    r.status,
    endedBy,
    r.recording_file ? 'Yes' : 'No',
    r.linkedid,
  ];
}

export function renderCsv(header: string[], rows: unknown[][]): Buffer {
  const lines = [header, ...rows].map((cols) => cols.map(csvCell).join(','));
  return Buffer.concat([CSV_BOM, Buffer.from(lines.join('\r\n') + '\r\n', 'utf8')]);
}

@Controller()
export class CallHistoryController {
  // ---------------------------------------------------------------------------
  // Call log
  // ---------------------------------------------------------------------------

  /**
   * Call log / CDR history: {calls, total, next_cursor}, one keyset page at a time, newest
   * first. Pass next_cursor as `cursor` for the following page (null on the last).
   *
   * Query: limit (100), cursor; date | date_from + date_to ('YYYY-MM-DD'); search
   * (Call ID, number, caller-ID name, or an agent's / contact's name, on any leg of the
   * call); the table filters status, call_type, app, route (comma lists);
   * include_supervision (default true; always false for an agent); order (desc | asc).
   * `total` counts exactly the rows the pages hold; `capped` says a filtered scan stopped at
   * its 50 000-call ceiling.
   *
   * No date at all -> the last 30 days, so a large CDR table is never scanned whole by
   * accident -- except for a search, which reaches all history (a Call ID the CRM stored
   * can be from any time) and is bounded by its own predicate.
   */
  @Get('/api/call-log')
  @Auth({ scope: 'cdr:read' })
  async getCallLogEndpoint(@Req() req: Request) {
    const q = req.query as QueryParams;
    const limit = qInt(q, 'limit', 100);
    if (limit <= 0) throw new HttpError(400, 'limit must be a positive integer');
    const date = qStr(q, 'date', null);
    let dateFrom = qStr(q, 'date_from', null);
    const dateTo = qStr(q, 'date_to', null);
    const search = (qStr(q, 'search', null) || '').trim() || null;
    if (!date && !dateFrom && !dateTo && !search) dateFrom = defaultDateFrom();
    const p = principal(req);
    const agentView = hidesSupervision(p);
    const includeSupervision = !agentView && qBool(q, 'include_supervision', true);
    try {
      return await callLogPage({
        limit,
        cursor: qStr(q, 'cursor', null),
        date,
        dateFrom,
        dateTo,
        allowedExtensions: historyExtensions(p),
        search,
        excludeSupervision: !includeSupervision,
        supervision: !agentView,
        order: qStr(q, 'order', 'desc') === 'asc' ? 'asc' : 'desc',
        filters: qFilters(q),
      });
    } catch (e) {
      if (e instanceof LimitValueError) throw new HttpError(400, e.message);
      log.error('Error fetching call log: %s', e);
      throw new HttpError(500, 'Failed to fetch call log');
    }
  }

  /**
   * The Call History table as CSV (UTF-8 with BOM, so Excel reads Arabic names right):
   * the same date / search / table filters and scope as /api/call-log -- status, call_type,
   * app, route, each a comma list -- and include_supervision (default false: ChanSpy legs
   * are hidden, as on screen; never shown to an agent). At most 50 000 calls, newest first.
   */
  @Get('/api/call-log/export')
  @Auth({ scope: 'cdr:read' })
  async exportCallLogEndpoint(@Req() req: Request) {
    const q = req.query as QueryParams;
    const date = qStr(q, 'date', null);
    let dateFrom = qStr(q, 'date_from', null);
    const dateTo = qStr(q, 'date_to', null);
    const search = (qStr(q, 'search', null) || '').trim() || null;
    const p = principal(req);
    const includeSupervision = !hidesSupervision(p) && qBool(q, 'include_supervision', false);
    const filters = qFilters(q);
    if (!date && !dateFrom && !dateTo && !search) dateFrom = defaultDateFrom();
    const allowedExtensions = historyExtensions(p);

    let rows: Row[];
    try {
      rows = await getCallLog({
        limit: CALL_LOG_EXPORT_MAX_ROWS,
        date,
        dateFrom,
        dateTo,
        allowedExtensions,
        search,
        excludeSupervision: !includeSupervision,
        enrich: false,
        outcomes: true,
        supervision: false,
      });
    } catch (e) {
      log.error('Error exporting call log: %s', e);
      throw new HttpError(500, 'Failed to fetch call log');
    }
    const filtered = rows.filter((r) => {
      // A supervisor's ChanSpy leg is its own CDR call (also excluded in SQL).
      if (!includeSupervision && r.route === 'internal_supervision') return false;
      return matchesCallLogFilters(r, filters);
    });
    const from = date || dateFrom || 'all';
    const to = date || dateTo || dateIso(new Date());
    const safe = (s: string) => s.replace(/[^0-9A-Za-z-]/g, '');
    const filename = `call_history_${safe(from)}_${safe(to)}.csv`;
    return new RawResponse(renderCsv(CALL_LOG_CSV_HEADER, filtered.map(callLogCsvRow)), {
      contentType: 'text/csv; charset=utf-8',
      headers: { 'Content-Disposition': `attachment; filename="${filename}"` },
    });
  }

  /**
   * One call's timeline by linkedid: {journey: [...]}. 403 when the call is outside the
   * caller's history scope (an unknown linkedid reads the same for a scoped user).
   */
  @Get('/api/call-log/journey')
  @Auth({ scope: 'cdr:read' })
  async getCallJourneyEndpoint(@Req() req: Request) {
    const linkedid = qStr(req.query as QueryParams, 'linkedid', REQUIRED) as string;
    if (!linkedid || linkedid.trim() === '') throw new HttpError(400, 'linkedid is required');
    const lid = linkedid.trim();
    const p = principal(req);
    let cdrRows: Row[];
    try {
      cdrRows = await dbm.getCdrByLinkedid(lid);
    } catch (e) {
      log.error('Error fetching call journey: %s', e);
      throw new HttpError(500, 'Failed to fetch call journey');
    }
    await assertCallVisible(p, cdrRows);
    assertNotHiddenSupervision(p, cdrRows);
    try {
      if (!cdrRows.length) return { journey: [] };
      // Supervision (listen/whisper/barge) events for this call, injected into the timeline
      // so the supervisor shows up here instead of as a separate "-> s" row. Not for the
      // monitored agent.
      const supervision = hidesSupervision(p) ? [] : await dbm.getSupervisionForTarget(lid);
      return { journey: await buildCallJourneyFromCdr(cdrRows, supervision) };
    } catch (e) {
      log.error('Error fetching call journey: %s', e);
      throw new HttpError(500, 'Failed to fetch call journey');
    }
  }

  /** VAD (voice activity) analysis of a call by the uniqueid of any of its legs. */
  @Get('/api/call-log/vad/:uniqueid')
  @Auth({ scope: 'cdr:read' })
  async getCallVadEndpoint(@Req() req: Request) {
    const uniqueid = pStr(req.params.uniqueid).trim();
    if (!uniqueid) throw new HttpError(400, 'uniqueid is required');
    const p = principal(req);
    if (historyExtensions(p) !== null) {
      const legs = await dbm.getCallLegs({ uniqueid });
      await assertCallVisible(p, legs);
      assertNotHiddenSupervision(p, legs);
    }
    let data: Row | null;
    try {
      data = await dbm.getCallVadFromDb(uniqueid);
    } catch (e) {
      log.error('Error fetching call VAD: %s', e);
      throw new HttpError(500, 'Failed to fetch VAD data');
    }
    if (data === null) throw new HttpError(404, 'No VAD data found for this call');
    // segments is stored as a JSON string -- parse it
    if (typeof data.segments === 'string') {
      try {
        data.segments = JSON.parse(data.segments);
      } catch {
        data.segments = null;
      }
    }
    delete data.created_at;
    return data;
  }

  // ---------------------------------------------------------------------------
  // Call notifications (read/archive)
  // ---------------------------------------------------------------------------

  /**
   * The missed-call bell: {notifications, total}, newest first; `total` counts every
   * matching notification, not just the page. An agent reads their own extension's; a
   * supervisor those of the agents in their groups plus their own (notificationExtensions),
   * narrowed by `extension` within that; an admin their own extension's by default, any
   * with `extension`. `status`: new | read | archived. `reason` is a call status (old
   * lowercase rows are mapped on read).
   */
  @Get('/api/call-notifications')
  @Auth('user')
  async getCallNotificationsEndpoint(@Req() req: Request) {
    const q = req.query as QueryParams;
    let extension = qStr(q, 'extension', null);
    const status = qStr(q, 'status', null);
    const limit = qInt(q, 'limit', 200);
    if (limit <= 0) throw new HttpError(400, 'limit must be a positive integer');
    const p = principal(req);
    const allowed = notificationExtensions(p);
    if (allowed === null || p.role === 'agent') {
      // An admin's bell is their own extension unless they ask for another; an agent's
      // is always their own.
      if (p.extension && (p.role === 'agent' || !extension)) extension = p.extension;
    }
    if (allowed !== null) {
      if (!allowed.length) return { notifications: [], total: 0 };
      if (extension && !allowed.includes(extension)) throw new HttpError(403, 'Not allowed to view this extension');
    }
    if (status && !['new', 'read', 'archived'].includes(status)) throw new HttpError(400, 'Invalid status');
    const filter = {
      extension: extension || null,
      extensions: !extension && allowed !== null ? allowed : null,
      statusFlag: status,
    };
    try {
      const [notifications, total] = await Promise.all([
        dbm.getCallNotificationsFromDb({ ...filter, limit }),
        dbm.getCallNotificationsCountFromDb(filter),
      ]);
      return { notifications, total };
    } catch (e) {
      log.error('Error fetching call notifications: %s', e);
      throw new HttpError(500, 'Failed to fetch call notifications');
    }
  }

  /** Mark a notification read or archived; only for an extension whose bell the caller reads. */
  @Patch('/api/call-notifications/:notification_id')
  @Auth('user')
  async updateCallNotificationEndpoint(@Req() req: Request) {
    const notificationId = pInt(req.params.notification_id, 'notification_id');
    const body = parseBody(CallNotificationUpdate, req.body);
    if (!['read', 'archived'].includes(body.status_flag)) {
      throw new HttpError(400, "status_flag must be 'read' or 'archived'");
    }
    const notification = await dbm.getCallNotificationById(notificationId);
    if (!notification) throw new HttpError(404, 'Notification not found');
    const allowed = notificationExtensions(principal(req));
    if (allowed !== null && !allowed.includes(String(notification.extension ?? ''))) {
      throw new HttpError(403, 'Not allowed to update this notification');
    }
    const ok = await dbm.updateCallNotificationStatus(notificationId, body.status_flag);
    if (!ok) throw new HttpError(500, 'Update failed');
    return { ok: true, id: notificationId, status_flag: body.status_flag };
  }

  // ---------------------------------------------------------------------------
  // Recordings
  // ---------------------------------------------------------------------------

  /**
   * Recorded calls for the admin Recordings page, newest first, keyset-paged:
   * {recordings: [{calldate, src, dst, duration, billsec, disposition, recordingfile,
   * uniqueid, linkedid, recording_path, size_bytes}], total, next_cursor}. Filters: search
   * (number or call id), date_from / date_to ('YYYY-MM-DD', inclusive). Pass the returned
   * next_cursor as `cursor` for the following page.
   */
  @Get('/api/recordings')
  @Auth('admin')
  async listRecordingsEndpoint(@Req() req: Request) {
    const q = req.query as QueryParams;
    const limit = qInt(q, 'limit', 25);
    const cursor = qStr(q, 'cursor', null);
    const filter = {
      search: (qStr(q, 'search', null) || '').trim() || null,
      dateFrom: qStr(q, 'date_from', null),
      dateTo: qStr(q, 'date_to', null),
    };
    const page = await dbm.getRecordingsFromDb({ ...filter, limit, cursor });
    for (const r of page.items) {
      delete r.sequence;
      const p = await getRecordingPath(r.recordingfile ?? null);
      r.recording_path = p;
      try {
        r.size_bytes = p ? (await fs.promises.stat(p)).size : null;
      } catch {
        r.size_bytes = null;
      }
    }
    return { recordings: page.items, total: await dbm.getRecordingsCountFromDb(filter), next_cursor: page.next_cursor };
  }

  /**
   * Delete the local recording of a call (mixed file + leftover -sp1/-sp2 legs) by the
   * uniqueid of one of its CDR legs. The CDR row stays; its player 404s afterwards.
   */
  @Delete('/api/recordings/:uniqueid')
  @Auth('admin')
  async deleteRecordingEndpoint(@Req() req: Request) {
    const res = await deleteRecordingByUniqueid(pStr(req.params.uniqueid));
    if ('error' in res) throw new HttpError(res.error, res.message);
    return res;
  }

  /**
   * Serve a recording file, with Range/206 support. Auth: Bearer access token or an API key
   * with cdr:read -- never a `?token=` query (it would end up in access logs and history;
   * the web app fetches with the header and plays a blob).
   *
   * The path is relative to the recordings root (absolute paths must lie inside it); a
   * bare basename resolves through the recordings index. Anything resolving outside the
   * root is 403 "Access denied", a missing file 404 "Recording not found", and a call
   * outside the caller's history scope 403 "Not allowed to view this call".
   */
  @Get('/api/recordings/*file_path')
  @Auth({ scope: 'cdr:read' })
  async serveRecording(@Req() req: Request) {
    // Express 5 hands a named wildcard over as its decoded segments.
    const raw: unknown = req.params.file_path;
    const filePath = Array.isArray(raw) ? raw.join('/') : pStr(raw);
    const resolved = await resolveRecordingRequest(filePath);
    if (resolved.status === 403) throw new HttpError(403, 'Access denied');
    if (resolved.status === 404 || !resolved.path) throw new HttpError(404, 'Recording not found');
    const p = principal(req);
    // Authorize on the RESOLVED name, so a rewritten basename is the one checked. Admins
    // and API keys skip the lookup.
    if (historyExtensions(p) !== null) {
      const legs = await dbm.getCallLegs({ recordingfile: pyBasename(resolved.path) });
      await assertCallVisible(p, legs);
      assertNotHiddenSupervision(p, legs);
    }
    return new FileResponse(resolved.path, {
      contentType: recordingContentType(resolved.path),
      filename: pyBasename(resolved.path),
    });
  }
}
