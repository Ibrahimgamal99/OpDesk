/**
 * db_manager.py, call history part: the CDR / CEL queries behind Call History, the call
 * journey and the per-call authorization lookups, call notifications, the call_vad rows, and
 * the recordings list.
 *
 * CDR and CEL live in asteriskcdrdb (pool target 'cdr'); call_notifications and call_vad in
 * the OpDesk database ('app'). Every function here logs and returns an empty value on a
 * database error, as the Python did, so a CDR hiccup degrades a page instead of failing it.
 */

import { getLogger, pyStr } from '../../core/logger';
import { isoformat, truthy } from '../../core/py';
import { callStatus } from '../../services/call-outcomes';
import { execute, keysetPage, placeholders, query, queryOne } from '../pool';
import type { KeysetPage, Params, Row, SqlValue } from '../pool';

const log = getLogger('db.db_manager');

/** str(x or ''). */
function strOr(v: unknown): string {
  return truthy(v) ? pyStr(v) : '';
}

/** os.path.basename on POSIX: the text after the last '/'. */
function posixBasename(p: string): string {
  return p.slice(p.lastIndexOf('/') + 1);
}

/** datetime -> isoformat() as the Python's row post-processing did; strings pass through. */
function isoOrStr(v: unknown): unknown {
  if (v instanceof Date) return isoformat(v);
  return v === null || v === undefined ? v : String(v);
}

/**
 * SQL for the extension a CDR channel column names: 'PJSIP/1003-0000abcd' -> '1003',
 * 'Local/1003@from-queue-0001;1' -> '1003'. The '@' step is what makes queue, ring-group
 * and follow-me legs (FreePBX rings members through Local channels) match their agent; the
 * two-step form OpDesk used before read those as '1003@from'. Mirrors
 * services/call-log.convertChannelToExtension. `column` is always a fixed name.
 */
function channelExtSql(column: string): string {
  return `SUBSTRING_INDEX(SUBSTRING_INDEX(SUBSTRING_INDEX(${column}, '@', 1), '-', 1), '/', -1)`;
}

/**
 * WHERE fragment over bare `cdr` columns, and its params: the leg involves one of these
 * extensions -- as its origin channel (outbound), its destination channel (inbound/queue)
 * or its src. Callers widen a matching leg to the whole call by linkedid.
 */
function cdrExtensionMatch(extensions: SqlValue[]): [string, Params] {
  const ph = placeholders(extensions.length);
  const sql =
    '(' + channelExtSql('dstchannel') + ' IN (' + ph + ') ' +
    'OR ' + channelExtSql('channel') + ' IN (' + ph + ') ' +
    'OR src IN (' + ph + '))';
  return [sql, [...extensions, ...extensions, ...extensions]];
}

// ===========================================================================
// CEL: hangup facts and IVR steps
// ===========================================================================

// Calls per CEL lookup. The IN list is bounded rather than the page: a linkedid is ~30 bytes,
// so this keeps the statement small while still being one round trip for a normal page.
export const CEL_CHUNK = 500;

/** One channel's hangup, as CEL's HANGUP row `extra` JSON records it. */
export interface CelHangup {
  cause: string;
  source: string;
  dialstatus: string;
  forwarded: boolean;
  seq: number;
}

/**
 * Per-channel hangup facts for a page of calls, as {linkedid: {channame: {...}}}.
 *
 * The CDR carries no hangup cause -- `asteriskcdrdb.cdr` has no such column, only a
 * four-value `disposition` -- so the call history could never tell a callee who declined
 * from one whose line was busy, or a caller who gave up mid-ring from one who never reached
 * the phone at all. CEL has all of it: every HANGUP row's `extra` is
 * {"hangupcause", "hangupsource", "dialstatus"}, and `hangupsource` names the channel that
 * ended the call, which is the only direct evidence of WHO hung up.
 *
 * Fetched for a whole page in ONE query (per 500 calls) rather than per row: the usable index
 * is linkedid_index, so `linkedid IN (...)` is both the correct access path and what keeps
 * this off the N+1 road. Never fatal: a PBX without CEL (it may be unconfigured on Issabel),
 * or an `extra` that is not JSON, just leaves the status on the CDR disposition.
 */
export async function celHangupsByLinkedid(
  linkedids: unknown[] | null | undefined,
): Promise<Record<string, Record<string, CelHangup>>> {
  const ids = [...new Set((linkedids || []).filter((x) => truthy(x)).map((x) => pyStr(x)))];
  if (!ids.length) return {};
  const out: Record<string, Record<string, CelHangup>> = {};
  try {
    for (let start = 0; start < ids.length; start += CEL_CHUNK) {
      const chunk = ids.slice(start, start + CEL_CHUNK);
      const rows = await query(
        `SELECT id, linkedid, channame, extra, cid_rdnis FROM cel ` +
          `WHERE eventtype='HANGUP' AND linkedid IN (${placeholders(chunk.length)}) ORDER BY id`,
        chunk,
        'cdr',
      );
      for (const r of rows) {
        let extra: unknown;
        try {
          extra = JSON.parse(truthy(r.extra) ? String(r.extra) : '{}');
        } catch {
          continue;
        }
        if (extra === null || typeof extra !== 'object' || Array.isArray(extra)) continue;
        const ex = extra as Record<string, unknown>;
        if (!(r.linkedid in out)) out[r.linkedid] = {};
        out[r.linkedid][r.channame] = {
          cause: 'hangupcause' in ex && ex.hangupcause !== null ? pyStr(ex.hangupcause) : '',
          source: strOr(ex.hangupsource),
          dialstatus: strOr(ex.dialstatus),
          // The channel's redirecting number at hangup: set when the far end forwarded the
          // call (SIP 181/302). Carried for completeness; no verdict reads it today.
          forwarded: String(r.cid_rdnis || '').trim() !== '',
          // CEL row id: the order the legs hung up in (call-log.callEndedBy).
          seq: Number(r.id) || 0,
        };
      }
    }
    return out;
  } catch (e) {
    log.warning('cel_hangups_by_linkedid: %s', e);
    return {};
  }
}

/**
 * The IVR menus a call passed through, in order, as [{context, eventtime, selection}] -- one
 * entry each time the call ENTERED an `ivr-*` context (a caller who goes back to the same
 * menu gets a second entry).
 *
 * The CDR cannot show this: it records one row per bridge, and an IVR is time a channel
 * spends in dialplan before any bridge. CEL rows carry the context and extension the channel
 * was in at each event (CHAN_START, ANSWER, STREAM_BEGIN for the prompts, ...), which is
 * enough to see the menus. `selection` is the key the caller pressed when a CEL event fired
 * on that menu's digit extension (FreePBX/IssabelPBX route a choice to `exten => <digit>` in
 * the same ivr-N context); null when CEL saw none -- Asterisk logs no DTMF, so a choice that
 * jumps straight out of the menu leaves no trace. Never fatal; [] without CEL.
 */
export async function celIvrStepsByLinkedid(linkedid: unknown): Promise<Row[]> {
  if (!truthy(linkedid)) return [];
  try {
    const rows = await query(
      `SELECT id, eventtime, context, exten, channame FROM cel ` +
        `WHERE linkedid = ? AND context LIKE 'ivr-%' ORDER BY id`,
      [pyStr(linkedid)],
      'cdr',
    );
    const steps: Row[] = [];
    let prev: string | null = null;
    for (const r of rows) {
      const ctx = strOr(r.context);
      const exten = strOr(r.exten);
      if (ctx !== prev) {
        prev = ctx;
        steps.push({ context: ctx, eventtime: r.eventtime, selection: null });
      }
      const step = steps[steps.length - 1];
      if (step.selection === null && /^[0-9*#]{1,6}$/.test(exten)) step.selection = exten;
    }
    return steps;
  } catch (e) {
    log.warning('cel_ivr_steps_by_linkedid: %s', e);
    return [];
  }
}

/**
 * {ivr id: display name} from the PBX's IVR table (FreePBX and IssabelPBX both keep
 * `ivr_details` with id + name), so a journey can say "Main menu" rather than "ivr-3".
 * {} when the table is missing or unreadable.
 */
export async function getIvrNamesFromDb(): Promise<Record<string, string>> {
  try {
    const rows = await query('SELECT id, name FROM ivr_details', [], 'pbx');
    const out: Record<string, string> = {};
    for (const r of rows) if (truthy(r.name)) out[pyStr(r.id)] = pyStr(r.name);
    return out;
  } catch (e) {
    log.debug('ivr_details not readable: %s', e);
    return {};
  }
}

// ===========================================================================
// CDR
// ===========================================================================

/**
 * Fetch CDR rows for a given linkedid. Returns list of dicts or [] on error.
 *
 * `sequence` orders the legs (origin -> final); uniqueid/linkedid identify them.
 * crmIdentityFromCdr collapses multi-leg calls using sequence, so omitting it would
 * silently produce an arbitrary leg order.
 */
export async function getCdrByLinkedid(linkedid: string): Promise<Row[]> {
  try {
    return await query(
      `SELECT sequence, calldate, billsec, duration, disposition, src, dst,
              dcontext, channel, dstchannel, lastapp, uniqueid, linkedid
       FROM cdr
       WHERE linkedid = ?`,
      [linkedid],
      'cdr',
    );
  } catch (e) {
    log.warning('Database error: %s', e);
    return [];
  }
}

/**
 * Every CDR leg of one call, identified by linkedid, uniqueid, or recording filename, as
 * the rows core/scope.assertCallVisible checks (linkedid, uniqueid, src, dst, channel,
 * dstchannel). A uniqueid or a recording names one leg, so it is widened to its linkedid
 * first: authorization looks at the whole call, exactly the set of legs the call-log list
 * matches an agent on. [] when the call is unknown, which callers treat as "deny".
 *
 * The recording is matched on its basename, and also as the tail of a stored path:
 * IssabelPBX and some FreePBX versions store `recordingfile` as a full or YYYY/MM/DD path.
 */
export async function getCallLegs(
  opts: { linkedid?: string | null; uniqueid?: string | null; recordingfile?: string | null } = {},
): Promise<Row[]> {
  const cols = 'linkedid, uniqueid, src, dst, channel, dstchannel';
  try {
    let lid: string | null = null;
    if (truthy(opts.linkedid) && pyStr(opts.linkedid).trim()) {
      lid = pyStr(opts.linkedid).trim();
    } else if (truthy(opts.uniqueid) && pyStr(opts.uniqueid).trim()) {
      const row = await queryOne('SELECT linkedid FROM cdr WHERE uniqueid = ? LIMIT 1', [pyStr(opts.uniqueid).trim()], 'cdr');
      lid = row && truthy(row.linkedid) ? pyStr(row.linkedid) : null;
    } else if (truthy(opts.recordingfile) && pyStr(opts.recordingfile).trim()) {
      const base = posixBasename(pyStr(opts.recordingfile).trim());
      if (!base) return [];
      const row = await queryOne(
        "SELECT linkedid FROM cdr WHERE recordingfile = ? OR recordingfile LIKE CONCAT('%/', ?) LIMIT 1",
        [base, base],
        'cdr',
      );
      lid = row && truthy(row.linkedid) ? pyStr(row.linkedid) : null;
    }
    if (!lid) return [];
    return await query(`SELECT ${cols} FROM cdr WHERE linkedid = ?`, [lid], 'cdr');
  } catch (e) {
    log.warning('Database error resolving call legs: %s', e);
    return [];
  }
}

export interface CallLogQuery {
  limit?: number | null;
  date?: string | null;
  dateFrom?: string | null;
  dateTo?: string | null;
  allowedExtensions?: SqlValue[] | null;
  search?: string | null;
}

/** Python's ValueError for a bad `limit`: not a database error, so it propagates. */
export class LimitValueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValueError';
  }
}

/**
 * Get call log data from the database: one row per call (linkedid), newest first.
 *
 *   limit              maximum number of calls (optional)
 *   date               exact date 'YYYY-MM-DD' (legacy)
 *   date_from/date_to  inclusive date range 'YYYY-MM-DD'
 *   allowed_extensions only calls where one of these extensions took part on ANY leg
 *                      (null = unrestricted, [] = nothing)
 *   search             free text over caller / destination / call ids (whole history)
 *
 * Each row joins the call's first leg (min sequence: who called, when, where it entered)
 * with its last leg (max sequence: the final outcome and talk time). Two fixes over the
 * query OpDesk had:
 *   * the last leg's caller channel is `last_channel` -- it was aliased `channel` and then
 *     overwritten by first_leg.channel in the row, losing the channel Dial() leaves
 *     DIALSTATUS on, which the status derivation (call-log.outcomeFromCel) needs;
 *   * `recordingfile` is the call's recording from ANY leg (MAX(NULLIF(...,'')) per
 *     linkedid), not the first leg's: [opdesk-record] stamps CDR(recordingfile) on the
 *     channel that ran the predial hook, which on a queue call is a member's Local leg.
 */
export async function getCallLogFromDb(opts: CallLogQuery = {}): Promise<Row[]> {
  const date = opts.date ?? null;
  const dateFrom = opts.dateFrom ?? null;
  const dateTo = opts.dateTo ?? null;
  const allowedExtensions = opts.allowedExtensions ?? null;
  const search = opts.search ?? null;
  const limit = opts.limit ?? null;
  let data: Row[] = [];

  try {
    // Push the date window INTO each GROUP BY linkedid subquery so they scan only the
    // relevant slice of `cdr` (using an index on calldate) instead of grouping the entire
    // table and filtering afterwards. A 2-day upper buffer keeps legs of calls that span
    // midnight; the outer WHERE below still applies the precise 1-day-granular bound. No
    // date filter (a CRM uniqueid search reaching all history) -> no pushdown.
    const subConds: string[] = [];
    const subParams: Params = [];
    if (truthy(date)) {
      subConds.push('calldate >= ? AND calldate < DATE_ADD(?, INTERVAL 2 DAY)');
      subParams.push(date, date);
    } else {
      if (truthy(dateFrom)) {
        subConds.push('calldate >= ?');
        subParams.push(dateFrom);
      }
      if (truthy(dateTo)) {
        subConds.push('calldate < DATE_ADD(?, INTERVAL 2 DAY)');
        subParams.push(dateTo);
      }
    }
    const subWhere = subConds.length ? 'WHERE ' + subConds.join(' AND ') : '';

    let sql = `
            SELECT
                first_leg.calldate,
                first_leg.src,
                first_leg.dst          AS dst,
                first_leg.dcontext     AS dcontext,
                last_leg.dst           AS answered_by,
                last_leg.channel       AS last_channel,
                last_leg.dstchannel    AS dstchannel,
                last_leg.lastapp,
                first_leg.lastapp      AS first_lastapp,
                last_leg.duration,
                last_leg.billsec,
                last_leg.disposition,
                first_leg.channel,
                rec.recordingfile,
                first_leg.cnam,
                first_leg.uniqueid,
                first_leg.linkedid,
                last_leg.userfield,
                leg_count.total_legs AS call_journey_count,
                CASE
                    WHEN first_leg.dcontext LIKE '%queue%' THEN 'queue'
                    WHEN first_leg.dcontext LIKE '%ivr%'   THEN 'ivr'
                    ELSE 'direct'
                END AS call_app
            FROM
                (
                    SELECT c.*
                    FROM cdr c
                    JOIN (
                        SELECT linkedid, MIN(sequence) AS min_seq
                        FROM cdr
                        ${subWhere}
                        GROUP BY linkedid
                    ) x ON c.linkedid = x.linkedid AND c.sequence = x.min_seq
                ) first_leg
            JOIN (
                    SELECT c.*
                    FROM cdr c
                    JOIN (
                        SELECT linkedid, MAX(sequence) AS max_seq
                        FROM cdr
                        ${subWhere}
                        GROUP BY linkedid
                    ) x ON c.linkedid = x.linkedid AND c.sequence = x.max_seq
                ) last_leg ON first_leg.linkedid = last_leg.linkedid
            JOIN (
                SELECT linkedid, COUNT(*) AS total_legs
                FROM cdr
                ${subWhere}
                GROUP BY linkedid
            ) leg_count ON first_leg.linkedid = leg_count.linkedid
            LEFT JOIN (
                -- The recording can land on any leg, not just the first: MAX(NULLIF(...,''))
                -- ignores the empty-string legs and returns the recorded filename.
                SELECT linkedid, MAX(NULLIF(recordingfile, '')) AS recordingfile
                FROM cdr
                ${subWhere}
                GROUP BY linkedid
            ) rec ON first_leg.linkedid = rec.linkedid
        `;

    // The four GROUP BY subqueries reference subWhere left-to-right, so their date params
    // come first (once per subquery), then the outer params.
    const conditions: string[] = [];
    const params: Params = [...subParams, ...subParams, ...subParams, ...subParams];

    // Precise outer date bound, against the bare column so an index on calldate is usable.
    if (truthy(date)) {
      conditions.push('first_leg.calldate >= ? AND first_leg.calldate < DATE_ADD(?, INTERVAL 1 DAY)');
      params.push(date, date);
    }
    if (truthy(dateFrom)) {
      conditions.push('first_leg.calldate >= ?');
      params.push(dateFrom);
    }
    if (truthy(dateTo)) {
      conditions.push('first_leg.calldate < DATE_ADD(?, INTERVAL 1 DAY)');
      params.push(dateTo);
    }
    // Filter by agent extension. The agent's extension lives in a DIFFERENT place per
    // direction: on an OUTBOUND call it is the origin `channel`, on an INBOUND/queue call
    // the `dstchannel`, and it is usually on an intermediate leg (queue answer, transfer),
    // not the first or last. Scan all legs and collapse via linkedid so any matching leg
    // surfaces the one call-log row (kept identical to getCallLogCountFromDb).
    if (allowedExtensions !== null) {
      if (!allowedExtensions.length) {
        conditions.push('1 = 0');
      } else {
        const [extSql, extParams] = cdrExtensionMatch(allowedExtensions);
        conditions.push('first_leg.linkedid IN (SELECT linkedid FROM cdr WHERE ' + extSql + ')');
        params.push(...extParams);
      }
    }

    // Free-text search across caller/destination and call ids (whole-history search).
    if (truthy(search)) {
      const like = `%${pyStr(search).trim()}%`;
      conditions.push(
        '(first_leg.src LIKE ? OR first_leg.dst LIKE ? OR last_leg.dst LIKE ? ' +
          'OR first_leg.uniqueid LIKE ? OR first_leg.linkedid LIKE ?)',
      );
      params.push(like, like, like, like, like);
    }

    if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
    sql += ' ORDER BY first_leg.calldate DESC';

    if (truthy(limit)) {
      if (!Number.isInteger(limit) || (limit as number) <= 0) {
        throw new LimitValueError('limit must be a positive integer');
      }
      sql += ' LIMIT ?';
      params.push(limit);
    }

    data = await query(sql, params, 'cdr');
  } catch (e) {
    if (e instanceof LimitValueError) throw e;
    log.warning('⚠️  Database error getting call log: %s', e);
  }
  return data;
}

/**
 * Total count of call log rows with the same filters as getCallLogFromDb (no limit), so the
 * UI can show the total beyond the fetch limit. COUNT(DISTINCT linkedid) over bare cdr is
 * orders of magnitude faster than the self-join on large CDR tables, and each linkedid is
 * one call-log row, so the count is equivalent.
 */
export async function getCallLogCountFromDb(
  opts: Omit<CallLogQuery, 'limit'> = {},
): Promise<number> {
  const allowedExtensions = opts.allowedExtensions ?? null;
  try {
    const conditions: string[] = [];
    const params: Params = [];
    if (truthy(opts.date)) {
      conditions.push('calldate >= ? AND calldate < DATE_ADD(?, INTERVAL 1 DAY)');
      params.push(opts.date, opts.date);
    }
    if (truthy(opts.dateFrom)) {
      conditions.push('calldate >= ?');
      params.push(opts.dateFrom);
    }
    if (truthy(opts.dateTo)) {
      conditions.push('calldate < DATE_ADD(?, INTERVAL 1 DAY)');
      params.push(opts.dateTo);
    }
    if (allowedExtensions !== null) {
      if (!allowedExtensions.length) return 0; // no allowed extensions -> zero results
      // Same predicate as getCallLogFromDb, widened to the call: COUNT(DISTINCT linkedid)
      // then counts every call one of the extensions took part in.
      const [extSql, extParams] = cdrExtensionMatch(allowedExtensions);
      conditions.push('linkedid IN (SELECT linkedid FROM cdr WHERE ' + extSql + ')');
      params.push(...extParams);
    }
    if (truthy(opts.search)) {
      const like = `%${pyStr(opts.search).trim()}%`;
      conditions.push('(src LIKE ? OR dst LIKE ? OR uniqueid LIKE ? OR linkedid LIKE ?)');
      params.push(like, like, like, like);
    }
    const whereClause = conditions.length ? ' WHERE ' + conditions.join(' AND ') : '';
    const row = await queryOne('SELECT COUNT(DISTINCT linkedid) AS cnt FROM cdr' + whereClause, params, 'cdr');
    return row && truthy(row.cnt) ? Number(row.cnt) : 0;
  } catch (e) {
    log.warning('⚠️  Database error getting call log count: %s', e);
    return 0;
  }
}

// ===========================================================================
// Call notifications (the missed-call bell)
// ===========================================================================

/**
 * Insert a call notification (OpDesk DB). Called from the AMI monitor on hangup.
 * `reason` is a call status (call-outcomes.CALL_OUTCOMES), e.g. BUSY, UNANSWERED, MISSED.
 * Rows written before that vocabulary hold the old lowercase words (busy, noanswer,
 * switched_off, failed, invalid_number), which getCallNotificationsFromDb maps on read.
 * Returns the new id, or null on error.
 */
export async function insertCallNotification(
  extension: string,
  opts: { callerFrom?: string | null; queue?: string | null; callId?: string | null; reason?: string | null } = {},
): Promise<number | null> {
  try {
    const res = await execute(
      `INSERT INTO call_notifications (extension, caller_from, queue, call_id, reason)
       VALUES (?, ?, ?, ?, ?)`,
      [extension, opts.callerFrom || null, opts.queue || null, opts.callId || null, opts.reason || null],
    );
    return res.insertId;
  } catch (e) {
    log.warning('⚠️  Database error inserting call notification: %s', e);
    return null;
  }
}

/** A stored notification reason as today's call status; a non-outcome reason passes through. */
export function notificationReason(reason: unknown): unknown {
  if (reason === null || reason === undefined) return reason;
  return callStatus(reason) || reason;
}

function notificationRow(row: Row): Row {
  const out: Row = { ...row };
  if (truthy(out.event_time)) out.event_time = isoOrStr(out.event_time);
  out.reason = notificationReason(out.reason);
  return out;
}

/**
 * Get call notifications from the OpDesk DB, newest first. Filter by extension (or a set
 * of extensions: a supervisor's scope, applied in SQL so the limit counts only rows they
 * may see) and/or status (new, read, archived).
 */
export async function getCallNotificationsFromDb(
  opts: { extension?: string | null; extensions?: string[] | null; statusFlag?: string | null; limit?: number } = {},
): Promise<Row[]> {
  const limit = opts.limit ?? 200;
  try {
    const conditions: string[] = [];
    const params: Params = [];
    if (opts.extension !== null && opts.extension !== undefined) {
      conditions.push('extension = ?');
      params.push(opts.extension);
    }
    if (opts.extensions !== null && opts.extensions !== undefined) {
      if (!opts.extensions.length) return [];
      conditions.push(`extension IN (${placeholders(opts.extensions.length)})`);
      params.push(...opts.extensions);
    }
    if (opts.statusFlag !== null && opts.statusFlag !== undefined) {
      conditions.push('status_flag = ?');
      params.push(opts.statusFlag);
    }
    const where = conditions.length ? ' WHERE ' + conditions.join(' AND ') : '';
    params.push(limit);
    const rows = await query(
      'SELECT id, extension, caller_from, queue, status_flag, event_time, call_id, reason ' +
        `FROM call_notifications${where} ORDER BY event_time DESC LIMIT ?`,
      params,
    );
    return rows.map(notificationRow);
  } catch (e) {
    log.warning('⚠️  Database error getting call notifications: %s', e);
    return [];
  }
}

/** Get a single call notification by id. Returns null if not found. */
export async function getCallNotificationById(notificationId: number): Promise<Row | null> {
  try {
    const row = await queryOne(
      'SELECT id, extension, caller_from, queue, status_flag, event_time, call_id, reason ' +
        'FROM call_notifications WHERE id = ?',
      [notificationId],
    );
    return row ? notificationRow(row) : null;
  } catch (e) {
    log.warning('⚠️  Database error getting call notification: %s', e);
    return null;
  }
}

/** Update a call notification's status (new, read or archived). True on success. */
export async function updateCallNotificationStatus(notificationId: number, statusFlag: string): Promise<boolean> {
  if (!['new', 'read', 'archived'].includes(statusFlag)) return false;
  try {
    const res = await execute('UPDATE call_notifications SET status_flag = ? WHERE id = ?', [statusFlag, notificationId]);
    return res.affectedRows > 0;
  } catch (e) {
    log.warning('⚠️  Database error updating call notification: %s', e);
    return false;
  }
}

/**
 * Delete READ notifications older than `days` (7 by default): the job schema.sql's
 * evt_cleanup_read_call_notifications EVENT was meant to do, which never runs on installs
 * where the MySQL event_scheduler is off (the default). Run once a day from the background
 * loop. Returns the number of rows deleted (0 on error).
 */
export async function cleanupReadCallNotifications(days = 7): Promise<number> {
  try {
    const res = await execute(
      "DELETE FROM call_notifications WHERE status_flag = 'read' AND event_time < DATE_SUB(NOW(), INTERVAL ? DAY)",
      [Math.max(1, Math.trunc(days))],
    );
    return res.affectedRows;
  } catch (e) {
    log.warning('⚠️  Database error cleaning up call notifications: %s', e);
    return 0;
  }
}

// ===========================================================================
// call_vad: post-call voice activity analysis
// ===========================================================================

const COLS_CALL_VAD =
  'id, uniqueid, base, duration, sp1_talk_seconds, sp2_talk_seconds, overlap_seconds, ' +
  'sp1_segments, sp2_segments, segments, created_at';

/**
 * Store (or replace) the VAD analysis for one call in the OpDesk DB, keyed by uniqueid.
 * Called from vad-runner after the recording legs are analysed. Idempotent on uniqueid.
 */
export async function upsertCallVad(
  uniqueid: string,
  opts: {
    base?: string | null;
    duration?: number | null;
    sp1TalkSeconds?: number | null;
    sp2TalkSeconds?: number | null;
    overlapSeconds?: number | null;
    sp1Segments?: number | null;
    sp2Segments?: number | null;
    segmentsJson?: string | null;
  } = {},
): Promise<boolean> {
  if (!truthy(uniqueid)) return false;
  try {
    await execute(
      `INSERT INTO call_vad
           (uniqueid, base, duration, sp1_talk_seconds, sp2_talk_seconds,
            overlap_seconds, sp1_segments, sp2_segments, segments)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
           base=VALUES(base), duration=VALUES(duration),
           sp1_talk_seconds=VALUES(sp1_talk_seconds),
           sp2_talk_seconds=VALUES(sp2_talk_seconds),
           overlap_seconds=VALUES(overlap_seconds),
           sp1_segments=VALUES(sp1_segments), sp2_segments=VALUES(sp2_segments),
           segments=VALUES(segments)`,
      [
        uniqueid,
        opts.base ?? null,
        opts.duration ?? null,
        opts.sp1TalkSeconds ?? null,
        opts.sp2TalkSeconds ?? null,
        opts.overlapSeconds ?? null,
        opts.sp1Segments ?? null,
        opts.sp2Segments ?? null,
        opts.segmentsJson ?? null,
      ],
    );
    return true;
  } catch (e) {
    log.warning('⚠️  Database error upserting call_vad (%s): %s', uniqueid, e);
    return false;
  }
}

/**
 * All CDR leg uniqueids that share a call (linkedid) with the given uniqueid.
 *
 * Recording (and so the VAD row) attaches to whichever channel ran [opdesk-record] -- on a
 * queue call a member's Local leg -- while Call History asks by the first leg's uniqueid.
 * Expanding to every leg of the call lets the VAD lookup match either way.
 */
export async function siblingUniqueids(uniqueid: string): Promise<string[]> {
  if (!truthy(uniqueid)) return [];
  try {
    const rows = await query(
      'SELECT DISTINCT uniqueid FROM cdr WHERE linkedid = (SELECT linkedid FROM cdr WHERE uniqueid = ? LIMIT 1)',
      [uniqueid],
      'cdr',
    );
    return rows.filter((r) => truthy(r.uniqueid)).map((r) => pyStr(r.uniqueid));
  } catch (e) {
    log.warning('DB error resolving sibling uniqueids (%s): %s', uniqueid, e);
    return [];
  }
}

/**
 * Fetch the VAD analysis for one call by uniqueid, falling back to the other legs of the
 * same call. Returns null if not found.
 */
export async function getCallVadFromDb(uniqueid: string): Promise<Row | null> {
  if (!truthy(uniqueid)) return null;
  try {
    let row = await queryOne(`SELECT ${COLS_CALL_VAD} FROM call_vad WHERE uniqueid = ? LIMIT 1`, [uniqueid]);
    if (!row) {
      const siblings = (await siblingUniqueids(uniqueid)).filter((u) => u !== uniqueid);
      if (siblings.length) {
        row = await queryOne(
          `SELECT ${COLS_CALL_VAD} FROM call_vad WHERE uniqueid IN (${placeholders(siblings.length)}) LIMIT 1`,
          siblings,
        );
      }
    }
    return row ? { ...row } : null;
  } catch (e) {
    log.warning('DB error fetching call_vad (%s): %s', uniqueid, e);
    return null;
  }
}

// ===========================================================================
// Recordings (the admin Recordings page)
// ===========================================================================

function recordingsWhere(search: string | null | undefined, params: Params): string {
  const conds = ['recordingfile IS NOT NULL', "recordingfile != ''"];
  if (search) {
    const like = '%' + String(search).trim() + '%';
    conds.push('(src LIKE ? OR dst LIKE ? OR uniqueid LIKE ? OR linkedid LIKE ?)');
    params.push(like, like, like, like);
  }
  return 'WHERE ' + conds.join(' AND ');
}

/**
 * CDR legs that have a recording, newest first, one keyset page at a time, for the
 * Recordings page (GET /api/recordings): {items, next_cursor}. The cursor carries the last
 * row's (calldate, uniqueid, sequence), so paging stays stable while new calls arrive.
 */
export async function getRecordingsFromDb(
  opts: { limit?: number; cursor?: string | null; search?: string | null } = {},
): Promise<KeysetPage> {
  try {
    const params: Params = [];
    const where = recordingsWhere(opts.search ?? null, params);
    return await keysetPage(
      'cdr',
      'calldate, src, dst, duration, billsec, disposition, recordingfile, uniqueid, linkedid, sequence',
      'cdr',
      [where.replace(/^WHERE /, '')],
      params,
      'calldate DESC, uniqueid DESC, sequence DESC',
      ['calldate', 'uniqueid', 'sequence'],
      opts.limit ?? 25,
      opts.cursor ?? null,
      true,
    );
  } catch (e) {
    log.warning('⚠️  Database error getting recordings: %s', e);
    return { items: [], next_cursor: null };
  }
}

/** Total count of CDR rows with a recording, same filter as getRecordingsFromDb. */
export async function getRecordingsCountFromDb(search: string | null = null): Promise<number> {
  try {
    const params: Params = [];
    const where = recordingsWhere(search, params);
    const row = await queryOne(`SELECT COUNT(*) AS cnt FROM cdr ${where}`, params, 'cdr');
    return row && truthy(row.cnt) ? Number(row.cnt) : 0;
  } catch (e) {
    log.warning('⚠️  Database error counting recordings: %s', e);
    return 0;
  }
}

/**
 * The recording of the call one CDR leg belongs to, by uniqueid: that leg's own
 * recordingfile, else any leg of the same call's (the recording can sit on any leg).
 */
export async function getCdrRecordingfile(uniqueid: string | null | undefined): Promise<string | null> {
  if (!uniqueid) return null;
  try {
    const row = await queryOne(
      `SELECT COALESCE(NULLIF(c.recordingfile, ''),
                       (SELECT MAX(NULLIF(o.recordingfile, '')) FROM cdr o WHERE o.linkedid = c.linkedid)) AS recordingfile
       FROM cdr c WHERE c.uniqueid = ? LIMIT 1`,
      [uniqueid],
      'cdr',
    );
    return row && truthy(row.recordingfile) ? pyStr(row.recordingfile) : null;
  } catch (e) {
    log.warning('⚠️  Database error getting recordingfile for %s: %s', uniqueid, e);
    return null;
  }
}
