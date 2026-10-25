/**
 * Analytics module — single source of truth for all KPI calculations.
 *
 * All KPI math lives here. The analytics controller only calls the public functions;
 * no formula is duplicated in the frontend or elsewhere.
 *
 * KPIs implemented:
 *   - SLA (% answered within threshold)
 *   - Abandonment rate + short-abandon split
 *   - AHT (Average Handle Time = avg talk time)
 *   - FCR (First Contact Resolution via repeat-contact window)
 *   - Abandoned-caller recovery (callers we rang back after they gave up)
 *   - Answer rate (people) and contact rate (calls)
 *   - Volume / trend data
 *   - Agent adherence (presence segments) and the per-agent state trace
 *
 * CDR note: CDR queries go to the CDR database (DB_CDR, pool target 'cdr').
 * Settings queries go to the OpDesk DB (pool target 'app').
 * Background aggregation tables also live in the OpDesk DB.
 *
 * Port of backend/analytics.py.
 */

import { getLogger, pyStr } from '../core/logger';
import { dateIso, floorDiv, isoformat, mysqlDatetime, pyInt, pyMod, pyRound, sleep, truthy } from '../core/py';
import { execute, placeholders, query, queryOne, withTransaction, type Params, type Row } from '../db/pool';
import * as dbm from '../db/db-manager';
import { ANSWERED, BUSY, callStatus, FAILURE, MISSED, NETWORK_ERROR, UNANSWERED } from './call-outcomes';
import { callLog, classifyCdrDirection, mapCallOutcome } from './call-log';
import { shiftResetMinutes } from './agent-state';

const log = getLogger('analytics');

let lastPruneDay: string | null = null;

// ---------------------------------------------------------------------------
// Python-semantics helpers local to this module
// ---------------------------------------------------------------------------

/** ValueError, for the places Python's strptime()/int() raised one (the route answers 500). */
export class ValueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValueError';
  }
}

const hasOwn = (obj: object, key: string): boolean => Object.prototype.hasOwnProperty.call(obj, key);

/** dict.get(key, fallback): a present None is returned as None, not the fallback. */
function dget<T>(obj: object | null | undefined, key: string, fallback: T): T {
  if (obj && hasOwn(obj, key)) return (obj as Row)[key] as T;
  return fallback;
}

/** str(x) where x may be a datetime (str(datetime) is the space-separated isoformat). */
function strOf(v: unknown): string {
  return v instanceof Date ? isoformat(v, ' ') : pyStr(v);
}

/** str(row.get(key, '')) */
function sget(row: Row, key: string): string {
  return hasOwn(row, key) ? strOf(row[key]) : '';
}

/** str(row.get(key, '') or '') */
function sgetOr(row: Row, key: string): string {
  const v = hasOwn(row, key) ? row[key] : '';
  return truthy(v) ? strOf(v) : '';
}

/** int(x): raises where Python raised. */
export function toInt(v: unknown): number {
  const n = pyInt(v);
  if (n === null) throw new ValueError(`invalid literal for int(): ${pyStr(v)}`);
  return n;
}

/** int(x or 0) */
function intOr0(v: unknown): number {
  return truthy(v) ? toInt(v) : 0;
}

/** str.isdigit() of a whole string ('' is not). */
function isDigits(s: string): boolean {
  return /^\p{Nd}+$/u.test(s);
}

// Naive datetimes. Python compares and subtracts naive datetimes on the wall clock; a Date
// subtracts real instants, which differ by an hour across a DST change (this box runs on a
// zone with DST). These keep the Python arithmetic.

/** Milliseconds of the naive (wall-clock) value of a local Date. */
function wall(d: Date): number {
  return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(),
    d.getSeconds(), d.getMilliseconds());
}

function fromWall(ms: number): Date {
  const t = new Date(ms);
  return new Date(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate(), t.getUTCHours(),
    t.getUTCMinutes(), t.getUTCSeconds(), t.getUTCMilliseconds());
}

/** dt + timedelta(seconds=secs) on the wall clock. */
function wallAdd(d: Date, secs: number): Date {
  return fromWall(wall(d) + secs * 1000);
}

/** (a - b).total_seconds() on the wall clock. */
function wallDiffSecs(a: Date, b: Date): number {
  return (wall(a) - wall(b)) / 1000;
}

const maxDt = (a: Date, b: Date): Date => (wall(b) > wall(a) ? b : a);
const minDt = (a: Date, b: Date): Date => (wall(b) < wall(a) ? b : a);

const DAY_SECS = 86400;

/** The (y, m, d) of a '%Y-%m-%d' string, or ValueError where strptime raised. */
function ymdParts(s: string): [number, number, number] {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(String(s));
  if (!m) throw new ValueError(`time data '${pyStr(s)}' does not match format '%Y-%m-%d'`);
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const t = new Date(Date.UTC(y, mo - 1, d));
  if (mo < 1 || mo > 12 || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) {
    throw new ValueError(`time data '${pyStr(s)}' does not match format '%Y-%m-%d'`);
  }
  return [y, mo, d];
}

/** datetime.strptime(s, '%Y-%m-%d'): local midnight. */
function strptimeYmd(s: string): Date {
  const [y, mo, d] = ymdParts(s);
  return new Date(y, mo - 1, d);
}

/** Days since the epoch of a '%Y-%m-%d' string (date arithmetic without a clock). */
function ymdOrdinal(s: string): number {
  const [y, mo, d] = ymdParts(s);
  return Date.UTC(y, mo - 1, d) / 86400000;
}

function ordinalYmd(n: number): string {
  const t = new Date(n * 86400000);
  const p = (x: number) => String(x).padStart(2, '0');
  return `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())}`;
}

/** (strptime(s) + timedelta(days)).strftime('%Y-%m-%d') */
export function addDaysYmd(s: string, days: number): string {
  return ordinalYmd(ymdOrdinal(s) + days);
}

/** dt.strftime('%Y-%m-%d %H:00:00') */
function hourStr(d: Date): string {
  return `${dateIso(d)} ${String(d.getHours()).padStart(2, '0')}:00:00`;
}

/** Append to a Map of lists (defaultdict(list)). */
function pushTo<K, V>(m: Map<K, V[]>, k: K, v: V): void {
  const list = m.get(k);
  if (list) list.push(v);
  else m.set(k, [v]);
}

function inc<K>(m: Map<K, number>, k: K, by = 1): void {
  m.set(k, (m.get(k) ?? 0) + by);
}

// ---------------------------------------------------------------------------
// Scope and date helpers
// ---------------------------------------------------------------------------

/** The answering agent's extension, from the last leg's destination channel. */
export const AGENT_EXT_EXPR = "SUBSTRING_INDEX(SUBSTRING_INDEX(last_leg.dstchannel, '-', 1), '/', -1)";

// ---------------------------------------------------------------------------
// What counts as an inbound queue call
// ---------------------------------------------------------------------------
//
// `lastapp = 'Queue'` alone does not mean a customer rang a queue: a Queue() run from a
// dialplan `s` extension (an IVR branch, a test harness) leaves a first leg whose dst is
// 's', which then showed up in Queue Performance as a queue named "s". A real queue call's
// dst is the queue's own extension, so the guard is a numeric destination.
export const REAL_QUEUE_LEG_SQL = "AND {leg}.dst REGEXP '^[0-9]+$'";

/** The `AND ...` fragment that keeps a queue query to real inbound queue calls. */
export function realQueueCond(leg = 'first_leg'): string {
  return REAL_QUEUE_LEG_SQL.split('{leg}').join(leg);
}

// The SQL twin of the answered rule queue rows use in code (queueRowAnswered): Asterisk can
// mark a leg ANSWERED that carried no audio, and leave a real conversation under another
// disposition, so either signal counts. Aggregations done in SQL ask the same question, or a
// heatmap cell disagrees with the queue's abandoned total for the same period.
export const ANSWERED_SQL = "(last_leg.disposition = 'ANSWERED' OR last_leg.billsec > 0)";
// The same rule where there is no joined last_leg to name -- a single-table scan over cdr.
export const QUEUE_ANSWERED_BARE_SQL = "disposition = 'ANSWERED' OR billsec > 0";

/** A list of extensions/queues a caller may see; null = unrestricted (admin, API key). */
export type Scope = readonly (string | number)[] | null | undefined;

/** Return [sql_fragment, params] to filter by allowed queue extensions (null = all). */
export function scopeQueueCondition(allowedQueues: Scope, col = 'first_leg.dst'): [string, Params] {
  if (allowedQueues === null || allowedQueues === undefined) return ['', []];
  if (!allowedQueues.length) return ['AND 1=0', []];
  return [`AND ${col} IN (${placeholders(allowedQueues.length)})`, [...allowedQueues]];
}

/** Return [sql_fragment, params] to filter by allowed agent extensions (null = all). */
export function scopeAgentCondition(allowedAgents: Scope, col: string | null = null): [string, Params] {
  if (col === null) col = AGENT_EXT_EXPR;
  if (allowedAgents === null || allowedAgents === undefined) return ['', []];
  if (!allowedAgents.length) return ['AND 1=0', []];
  return [`AND ${col} IN (${placeholders(allowedAgents.length)})`, [...allowedAgents]];
}

/**
 * Fill in the default date range where one is missing: the last 30 days, today included --
 * the same range as the UI's "Last 30 days" preset, which is what the Analytics page opens
 * on, so an omitted parameter answers the question the page asks.
 */
export function defaultDates(dateFrom: string | null | undefined, dateTo: string | null | undefined): [string, string] {
  const today = dateIso(new Date());
  return [dateFrom || addDaysYmd(today, -29), dateTo || today];
}

// ---------------------------------------------------------------------------
// Settings helpers
// ---------------------------------------------------------------------------

export type SlaThresholds = Record<string, number>;

export interface FcrSettings {
  window_days: number;
  short_abandon_secs: number;
  callback_window_hours: number;
}

/**
 * Return dict of {queue_extension: threshold_secs}.
 * If a queue has no row, callers should fall back to SLA_DEFAULT_SECS setting.
 *
 * A database error propagates: an empty dict here would quietly measure every queue against
 * the default threshold, a wrong SLA rather than a missing one.
 */
export async function getSlaThresholds(): Promise<SlaThresholds> {
  try {
    const rows = await query('SELECT queue_extension, threshold_secs FROM analytics_sla_settings');
    const out: SlaThresholds = {};
    for (const r of rows) out[r.queue_extension] = r.threshold_secs;
    return out;
  } catch (e) {
    log.error('analytics: error loading SLA thresholds: %s', e);
    throw e;
  }
}

/** Return the global SLA default threshold in seconds. */
export async function getSlaDefaultSecs(): Promise<number> {
  try {
    const raw = await dbm.getSetting('SLA_DEFAULT_SECS', null);
    if (raw) {
      const n = pyInt(raw);
      if (n !== null) return n;
    }
  } catch {
    /* pass */
  }
  return 20;
}

// What the settings row means when it cannot be read, and what a fresh install starts on.
// 7 days is the middle of the 3-14 the industry uses for a repeat contact; 5 seconds is the
// short-abandon window; 24 hours is how long our own call back to a customer still counts as
// us returning their call.
export const FCR_DEFAULTS: Readonly<FcrSettings> = { window_days: 7, short_abandon_secs: 5, callback_window_hours: 24 };

/** Return FCR / short-abandon / callback-window config as a dict. */
export async function getFcrSettings(): Promise<FcrSettings> {
  try {
    const row = await queryOne(
      'SELECT window_days, short_abandon_secs, callback_window_hours FROM analytics_fcr_settings WHERE id=1',
    );
    if (row) {
      return {
        window_days: row.window_days,
        short_abandon_secs: row.short_abandon_secs,
        callback_window_hours: row.callback_window_hours,
      };
    }
  } catch (e) {
    // A database the migration has not reached yet has no callback_window_hours column; the
    // defaults are exactly what it behaved as before the column existed.
    log.warning('analytics: error loading FCR settings: %s', e);
  }
  return { ...FCR_DEFAULTS };
}

/**
 * The accepted range of every analytics setting, inclusive. The save route answers 400 for
 * anything outside it, so a typo cannot store a negative threshold or a window the
 * TINYINT/SMALLINT column would clip.
 */
export const SETTING_RANGES = {
  sla_default_secs: [1, 600],
  sla_threshold_secs: [1, 600],
  fcr_window_days: [0, 90],
  short_abandon_secs: [0, 120],
  callback_window_hours: [0, 168],
} as const;

/**
 * Upsert per-queue SLA thresholds.
 * thresholds: {queue_extension: threshold_secs}; a null threshold removes that queue's
 * override, so the queue falls back to the default again.
 */
export async function saveSlaThresholds(thresholds: Record<string, unknown>): Promise<boolean> {
  if (!truthy(thresholds)) return true;
  const entries = Object.entries(thresholds);
  try {
    await withTransaction(async (conn) => {
      for (const [qext, secs] of entries) {
        if (secs === null) {
          await execute('DELETE FROM analytics_sla_settings WHERE queue_extension = ?', [String(qext)], conn);
          continue;
        }
        // int(secs) raises inside the loop, outside `except Error`: the route answers 500.
        const n = toInt(secs);
        await execute(
          `INSERT INTO analytics_sla_settings (queue_extension, threshold_secs)
             VALUES (?, ?)
             ON DUPLICATE KEY UPDATE threshold_secs=?`,
          [String(qext), n, n],
          conn,
        );
      }
    });
    return true;
  } catch (e) {
    if (e instanceof ValueError) throw e;
    log.error('analytics: error saving SLA thresholds: %s', e);
    return false;
  }
}

/**
 * Update the singleton FCR settings row.
 *
 * `callbackWindowHours` omitted keeps whatever is stored, so a caller that only knows about
 * the older two fields cannot silently reset the third to its default.
 */
export async function saveFcrSettings(
  windowDays: unknown,
  shortAbandonSecs: unknown,
  callbackWindowHours: unknown = null,
): Promise<boolean> {
  if (callbackWindowHours === null || callbackWindowHours === undefined) {
    callbackWindowHours = (await getFcrSettings()).callback_window_hours;
  }
  const wd = toInt(windowDays);
  const sa = toInt(shortAbandonSecs);
  const cb = toInt(callbackWindowHours);
  try {
    await execute(
      `INSERT INTO analytics_fcr_settings (id, window_days, short_abandon_secs, callback_window_hours)
         VALUES (1, ?, ?, ?)
         ON DUPLICATE KEY UPDATE window_days=?, short_abandon_secs=?, callback_window_hours=?`,
      [wd, sa, cb, wd, sa, cb],
    );
    return true;
  } catch (e) {
    log.error('analytics: error saving FCR settings: %s', e);
    return false;
  }
}

/** Return {extension: queue_name} from OpDesk.queues. */
export async function getQueueNames(): Promise<Record<string, string>> {
  try {
    const out: Record<string, string> = {};
    for (const r of await query('SELECT extension, queue_name FROM queues')) out[r.extension] = r.queue_name;
    return out;
  } catch (e) {
    log.warning('analytics: error loading queue names: %s', e);
    return {};
  }
}

/** Return {extension: name} from OpDesk.agents. */
export async function getAgentNames(): Promise<Record<string, string>> {
  try {
    const out: Record<string, string> = {};
    for (const r of await query('SELECT extension, name FROM agents')) out[r.extension] = r.name;
    return out;
  } catch (e) {
    log.warning('analytics: error loading agent names: %s', e);
    return {};
  }
}

// ---------------------------------------------------------------------------
// Core CDR query — queue calls with first_leg/last_leg join
// ---------------------------------------------------------------------------
//
// first_leg = queue entry leg (lastapp=Queue)
// last_leg  = agent answering leg (or same as first_leg if single-leg)
//
// wait_secs = first_leg.duration - last_leg.billsec
//             (total time in system minus talk time = queue wait)
// For abandoned calls last_leg.billsec = 0, so wait_secs = first_leg.duration
// Clamped at 0: a last leg that outlives the queue leg it came from (a transfer, a queue leg
// that recorded duration 0) makes the difference negative, and a negative wait dragged the
// average below zero and passed the SLA check for free.
//
// Inner subqueries include date filtering (with a 1-day buffer) to avoid full-table scans
// on large CDR tables. Expects 6 base params: [date_from, date_to] x 3.

/** Build the queue CDR SQL. Caller must supply 6 base date params + extra params. */
export function queueCdrSql(extraSql = ''): string {
  return `
    SELECT
        first_leg.calldate,
        first_leg.src,
        first_leg.dst                   AS queue_ext,
        first_leg.duration              AS total_dur,
        last_leg.billsec                AS billsec,
        last_leg.disposition            AS disposition,
        GREATEST(CASE
            WHEN last_leg.billsec > 0
            THEN first_leg.duration - last_leg.billsec
            ELSE first_leg.duration
        END, 0)                         AS wait_secs,
        ${AGENT_EXT_EXPR}              AS agent_ext,
        first_leg.linkedid
    FROM
        (
            SELECT c.*
            FROM cdr c
            JOIN (
                SELECT linkedid, MIN(sequence) AS min_seq
                FROM cdr
                WHERE calldate >= ?
                  AND calldate < DATE_ADD(?, INTERVAL 2 DAY)
                GROUP BY linkedid
            ) x ON c.linkedid = x.linkedid AND c.sequence = x.min_seq
        ) first_leg
    JOIN (
            SELECT c.*
            FROM cdr c
            JOIN (
                SELECT linkedid, MAX(sequence) AS max_seq
                FROM cdr
                WHERE calldate >= ?
                  AND calldate < DATE_ADD(?, INTERVAL 2 DAY)
                GROUP BY linkedid
            ) x ON c.linkedid = x.linkedid AND c.sequence = x.max_seq
        ) last_leg ON first_leg.linkedid = last_leg.linkedid
    WHERE
        first_leg.lastapp = 'Queue'
        ${realQueueCond()}
        AND first_leg.calldate >= ?
        AND first_leg.calldate < DATE_ADD(?, INTERVAL 1 DAY)
        ${extraSql}
    `;
}

/**
 * Execute the queue CDR base query and return rows.
 *
 * A database error propagates so the API surfaces a 500 instead of returning empty data
 * that the UI would render as "no data for this period".
 */
export async function runQueueCdr(dateFrom: string, dateTo: string, extraSql = '', extraParams: Params = []): Promise<Row[]> {
  const params: Params = [dateFrom, dateTo, dateFrom, dateTo, dateFrom, dateTo, ...extraParams];
  try {
    return await query(queueCdrSql(extraSql), params, 'cdr');
  } catch (e) {
    log.error('analytics: CDR query error: %s', e);
    throw e;
  }
}

// ---------------------------------------------------------------------------
// All-call CDR query — includes queue, outbound, and internal calls
// ---------------------------------------------------------------------------
// The public reports read the Call History data source (call-log.ts) instead; these stay
// for callers that want the raw two-leg join with direction classified the same way.

export const CALLER_EXT_EXPR = "SUBSTRING_INDEX(SUBSTRING_INDEX(first_leg.channel, '-', 1), '/', -1)";

/**
 * Build CDR SQL for ALL calls (queue + outbound + internal). Includes the extra fields
 * (lastapp, dcontext, channel, dstchannel) the direction classifier reads. Caller must
 * supply 6 base date params + extra params.
 */
export function allCdrSql(extraSql = ''): string {
  return `
    SELECT
        first_leg.calldate,
        first_leg.src,
        first_leg.dst                   AS dst,
        first_leg.duration              AS total_dur,
        last_leg.billsec                AS billsec,
        last_leg.disposition            AS disposition,
        GREATEST(CASE
            WHEN first_leg.lastapp = 'Queue' AND last_leg.billsec > 0
            THEN first_leg.duration - last_leg.billsec
            WHEN first_leg.lastapp = 'Queue'
            THEN first_leg.duration
            ELSE 0
        END, 0)                         AS wait_secs,
        ${AGENT_EXT_EXPR}              AS agent_ext,
        ${CALLER_EXT_EXPR}             AS caller_ext,
        first_leg.lastapp               AS lastapp,
        first_leg.dcontext              AS dcontext,
        first_leg.channel               AS channel,
        last_leg.dstchannel             AS dstchannel,
        first_leg.linkedid
    FROM
        (
            SELECT c.*
            FROM cdr c
            JOIN (
                SELECT linkedid, MIN(sequence) AS min_seq
                FROM cdr
                WHERE calldate >= ?
                  AND calldate < DATE_ADD(?, INTERVAL 2 DAY)
                GROUP BY linkedid
            ) x ON c.linkedid = x.linkedid AND c.sequence = x.min_seq
        ) first_leg
    JOIN (
            SELECT c.*
            FROM cdr c
            JOIN (
                SELECT linkedid, MAX(sequence) AS max_seq
                FROM cdr
                WHERE calldate >= ?
                  AND calldate < DATE_ADD(?, INTERVAL 2 DAY)
                GROUP BY linkedid
            ) x ON c.linkedid = x.linkedid AND c.sequence = x.max_seq
        ) last_leg ON first_leg.linkedid = last_leg.linkedid
    WHERE
        first_leg.calldate >= ?
        AND first_leg.calldate < DATE_ADD(?, INTERVAL 1 DAY)
        ${extraSql}
    `;
}

/** Execute the all-call CDR query and return rows. */
export async function runAllCdr(dateFrom: string, dateTo: string, extraSql = '', extraParams: Params = []): Promise<Row[]> {
  const params: Params = [dateFrom, dateTo, dateFrom, dateTo, dateFrom, dateTo, ...extraParams];
  try {
    return await query(allCdrSql(extraSql), params, 'cdr');
  } catch (e) {
    log.error('analytics: all-CDR query error: %s', e);
    throw e;
  }
}

/** Classify a CDR row direction (IN/OUT/INTERNAL) with the Call History classifier. */
export function classifyRowDirection(row: Row): string {
  return classifyCdrDirection({
    src: sget(row, 'src'),
    dst: sget(row, 'dst'),
    dcontext: sget(row, 'dcontext'),
    channel: sget(row, 'channel'),
    dstchannel: sget(row, 'dstchannel'),
    lastapp: sget(row, 'lastapp'),
  });
}

/** Add 'direction' to each row and normalise queue_ext for queue calls. */
export function enrichWithDirection(rows: Row[]): Row[] {
  for (const r of rows) {
    r.direction = classifyRowDirection(r);
    // For queue calls, dst is the queue extension; for outbound, it's the external number
    r.queue_ext = r.direction === 'IN' && dget(r, 'lastapp', null) === 'Queue' ? sget(r, 'dst') : '';
  }
  return rows;
}

/**
 * Filter direction-enriched rows by allowed queues/agents.
 * null = no filter (admin sees everything), empty list = nothing allowed.
 */
export function applyScopeFilter(rows: Row[], allowedQueues: Scope = null, allowedAgents: Scope = null): Row[] {
  if ((allowedQueues === null || allowedQueues === undefined) && (allowedAgents === null || allowedAgents === undefined)) {
    return rows;
  }
  if (!allowedQueues?.length && !allowedAgents?.length) return [];
  const allowedQ = new Set((allowedQueues ?? []).map(String));
  const allowedA = new Set((allowedAgents ?? []).map(String));

  const filtered: Row[] = [];
  for (const r of rows) {
    const direction = dget<unknown>(r, 'direction', '');
    const disp = sget(r, 'disposition').toUpperCase();

    // Queue scope: only applies to inbound queue calls
    if (allowedQueues != null && direction === 'IN' && dget(r, 'lastapp', null) === 'Queue') {
      if (!allowedQ.has(sget(r, 'dst'))) continue;
    }

    // Agent scope: applies to all calls
    if (allowedAgents != null) {
      if (direction === 'IN') {
        // Inbound calls that nobody answered had no agent, so the agent filter must not
        // drop them; an answered call with no agent leg cannot be verified and is dropped.
        const agentExt = sget(r, 'agent_ext');
        if (!agentExt && disp !== 'ANSWERED') {
          /* include */
        } else if (agentExt && !allowedA.has(agentExt)) {
          continue;
        } else if (!agentExt && disp === 'ANSWERED') {
          continue;
        }
      } else if (direction === 'OUT') {
        if (!allowedA.has(sget(r, 'caller_ext'))) continue;
      } else {
        // INTERNAL calls: either side
        if (!allowedA.has(sget(r, 'caller_ext')) && !allowedA.has(sget(r, 'agent_ext'))) continue;
      }
    }
    filtered.push(r);
  }
  return filtered;
}

// ---------------------------------------------------------------------------
// KPI helpers
// ---------------------------------------------------------------------------

export function slaThresholdFor(queueExt: string, thresholds: SlaThresholds, defaultSecs: number): number {
  return hasOwn(thresholds, queueExt) ? thresholds[queueExt] : defaultSecs;
}

/**
 * Did this call-history row actually enter a queue?
 *
 * The single queue test for every call-history-sourced figure. It replaces the old
 * `call_type == 'IN' and dst is all digits` guess, which treated a direct dial to an
 * extension as a queue call: a colleague ringing an unattended desk counted as a queue
 * abandon, and for a supervisor those same calls dropped out of the totals because the
 * extension was "not one of my queues". `app` comes from the first leg's dcontext in the
 * call-log query, the same signal Call History shows.
 */
export function isQueueCall(row: Row): boolean {
  return row.call_type === 'IN' && row.app === 'queue';
}

/**
 * The answered test for a call-history row: the `status` the call log already derived, so
 * Analytics, Call History and the drilldown cannot disagree about which calls were answered.
 */
export function rowAnswered(row: Row): boolean {
  return row.status === ANSWERED;
}

/**
 * The answered test for a queue CDR row: the same call-outcome rule, fed the last leg's
 * disposition and whether it carried talk time (ANSWERED_SQL is its SQL twin).
 */
export function queueRowAnswered(r: Row): boolean {
  return mapCallOutcome({
    disposition: sget(r, 'disposition').toUpperCase(),
    answered: intOr0(dget(r, 'billsec', null)) > 0,
  }) === ANSWERED;
}

/** A queue CDR row's wait, never negative (see queueCdrSql). */
function queueWait(r: Row): number {
  return Math.max(0, intOr0(dget(r, 'wait_secs', null)));
}

/**
 * Drop queue calls belonging to queues outside the caller's scope.
 *
 * Only QUEUE calls are subject to the queue restriction. Direct inbound, outbound and
 * internal calls stay governed by the extension scope the call log already applied -- the
 * same scope Call History enforces -- so the two pages show a supervisor the same calls.
 */
export function queueScopeFilter(rows: Row[], allowedQueues: Scope): Row[] {
  if (allowedQueues === null || allowedQueues === undefined) return rows;
  const allowedQ = new Set(allowedQueues.map(String));
  return rows.filter((r) => !(isQueueCall(r) && !allowedQ.has(sget(r, 'dst'))));
}

export interface QueueKpis {
  total_calls: number;
  answered_calls: number;
  abandoned_calls: number;
  short_abandoned: number;
  sla_met_calls: number;
  sum_wait_secs: number;
  sum_billsec: number;
}

export interface DerivedKpis extends QueueKpis {
  sla_pct: number | null;
  abandonment_rate: number | null;
  short_abandon_rate: number | null;
  aht_secs: number | null;
  avg_wait_secs: number | null;
}

/**
 * Aggregate KPIs from a flat list of queue CDR rows: every row that is not answered
 * (queueRowAnswered) is an abandon. Waits are clamped at 0.
 */
export function computeKpisFromRows(
  rows: Row[],
  thresholds: SlaThresholds,
  defaultSecs: number,
  shortAbandonSecs: number,
): QueueKpis {
  let total = 0;
  let answered = 0;
  let abandoned = 0;
  let shortAbandoned = 0;
  let slaMet = 0;
  let sumWait = 0;
  let sumBillsec = 0;

  for (const r of rows) {
    total += 1;
    const wait = queueWait(r);
    const bsec = intOr0(dget(r, 'billsec', null));
    const threshold = slaThresholdFor(sget(r, 'queue_ext'), thresholds, defaultSecs);

    if (queueRowAnswered(r)) {
      answered += 1;
      sumBillsec += bsec;
      sumWait += wait;
      if (wait <= threshold) slaMet += 1;
    } else {
      abandoned += 1;
      sumWait += wait;
      if (wait <= shortAbandonSecs) shortAbandoned += 1;
    }
  }

  return {
    total_calls: total,
    answered_calls: answered,
    abandoned_calls: abandoned,
    short_abandoned: shortAbandoned,
    sla_met_calls: slaMet,
    sum_wait_secs: sumWait,
    sum_billsec: sumBillsec,
  };
}

/** Add the percentage fields to a KPI dict. */
export function deriveRates(kpis: QueueKpis): DerivedKpis {
  const total = kpis.total_calls;
  const answered = kpis.answered_calls;
  return Object.assign(kpis, {
    sla_pct: answered ? pyRound((kpis.sla_met_calls / answered) * 100, 1) : null,
    abandonment_rate: total ? pyRound((kpis.abandoned_calls / total) * 100, 1) : null,
    short_abandon_rate: total ? pyRound((kpis.short_abandoned / total) * 100, 1) : null,
    aht_secs: answered ? pyRound(kpis.sum_billsec / answered) : null,
    avg_wait_secs: total ? pyRound(kpis.sum_wait_secs / total, 1) : null,
  });
}

// ---------------------------------------------------------------------------
// People: number keys, answer rate, callbacks
// ---------------------------------------------------------------------------
//
// Two rates, deliberately both:
//   * answer_rate  -- distinct outside numbers that were answered / distinct outside
//     numbers involved. Five calls to one person who finally picks up is ONE person who
//     answered. Internal extension-to-extension calls have no outside party, so they are
//     on neither side of it.
//   * contact_rate -- answered calls / all calls. Every call counts, retries included.
//
// The same customer is written '01012345678' by one system and '+201012345678' by
// another, so numbers compare on their last nine digits. Anything shorter than seven
// digits is an extension or feature code, not an outside line -- and an anonymous or empty
// caller ID is no one at all.

export const NUMBER_KEY_DIGITS = 9;
export const MIN_EXTERNAL_DIGITS = 7;

/** A comparable key for an outside number, or '' when it is not one. */
export function numberKey(num: unknown): string {
  const digits = (truthy(num) ? pyStr(num) : '').replace(/[^\p{Nd}]/gu, '');
  if ([...digits].length < MIN_EXTERNAL_DIGITS) return '';
  return [...digits].slice(-NUMBER_KEY_DIGITS).join('');
}

/** The outside party on a call-history row: who we dialled on an outbound call, who called us otherwise. */
export function counterpartyKey(row: Row): string {
  return numberKey(row.call_type === 'OUT' ? dget(row, 'dst', null) : dget(row, 'src', null));
}

/** part / whole as a 1-dp percentage, None on an empty whole. */
export function rate(part: number, whole: number): number | null {
  return whole ? pyRound((part / whole) * 100, 1) : null;
}

/** One call as the people rates see it: answered or not, and who the outside party was. */
export interface PersonCall {
  answered: boolean;
  counterparty: string;
}

/** answer_rate / contact_rate and the counts behind them, for one slice of calls. */
export function peopleRates(calls: PersonCall[]): Row {
  const answered = calls.filter((c) => c.answered);
  const customers = new Set(calls.map((c) => c.counterparty).filter((k) => truthy(k)));
  const reached = new Set(answered.map((c) => c.counterparty).filter((k) => truthy(k)));
  return {
    customers: customers.size,
    customers_answered: reached.size,
    answer_rate: rate(reached.size, customers.size),
    contact_rate: rate(answered.length, calls.length),
  };
}

/** Queue CDR rows as people-rate calls: the caller is always the outside party. */
function queuePeople(rows: Row[]): PersonCall[] {
  return rows.map((r) => ({ answered: queueRowAnswered(r), counterparty: numberKey(dget(r, 'src', null)) }));
}

/** 'YYYY-MM-DD HH:MM:SS' of a wall-clock instant built on the calendar (no DST involved). */
function wallStamp(ms: number): string {
  const t = new Date(ms);
  const p = (x: number) => String(x).padStart(2, '0');
  return `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())} `
    + `${p(t.getUTCHours())}:${p(t.getUTCMinutes())}:${p(t.getUTCSeconds())}`;
}

/**
 * Our own outbound calls to outside numbers in the window: {number_key: [calldate, ...]}.
 *
 * "We called them back" is a claim about the FIRST leg of an outbound call: the leg an
 * agent's phone placed, whose `dst` is the customer. Read once and matched here rather than
 * joined per caller: FCR's callback test and the abandoned-caller recovery count both use
 * it, and a busy month has hundreds of callers.
 *
 * The window is stretched by `hours` past the end of the range, so a call on the last
 * evening of the period can still be answered by a callback the next morning.
 */
export async function outboundCallbacks(dateFrom: string, dateTo: string, hours: number): Promise<Map<string, Date[]>> {
  const out = new Map<string, Date[]>();
  if (hours <= 0) return out;
  const windowEnd = wallStamp((ymdOrdinal(dateTo) + 1) * 86400000 + hours * 3600000);
  let rows: Row[];
  try {
    rows = await query(
      `
        SELECT first_leg.dst AS dst, first_leg.calldate AS calldate
        FROM (
            SELECT c.*
            FROM cdr c
            JOIN (
                SELECT linkedid, MIN(sequence) AS min_seq
                FROM cdr
                WHERE calldate >= ? AND calldate < ?
                GROUP BY linkedid
            ) x ON c.linkedid = x.linkedid AND c.sequence = x.min_seq
        ) first_leg
        WHERE first_leg.calldate >= ?
          AND first_leg.calldate < ?
          AND first_leg.dcontext = 'from-internal'
          AND CHAR_LENGTH(first_leg.dst) >= ${MIN_EXTERNAL_DIGITS}
      `,
      [dateFrom, windowEnd, dateFrom, windowEnd],
      'cdr',
    );
  } catch (e) {
    // Propagated: without the callbacks FCR and recovery would read better than they are.
    log.error('analytics: outbound callback query error: %s', e);
    throw e;
  }
  for (const r of rows) {
    const key = numberKey(r.dst);
    if (key) pushTo(out, key, r.calldate as Date);
  }
  for (const v of out.values()) v.sort((a, b) => wall(a) - wall(b));
  return out;
}

/** Did we call this customer back in the `hours` after `after`? */
export function calledBackWithin(callbacks: Map<string, Date[]>, key: string, after: Date, hours: number): boolean {
  if (!hours) return false;
  const a = wall(after);
  const limit = a + hours * 3600 * 1000;
  return (callbacks.get(key) ?? []).some((c) => a < wall(c) && wall(c) <= limit);
}

export interface FcrResult {
  fcr_pct: number | null;
  /** Callers whose first answered queue call fell in the period: the denominator. */
  base: number;
  /** Of those, the ones with a repeat contact inside the window. */
  repeat: number;
  /** The window has not closed on the newest callers yet, so the figure can still fall. */
  provisional: boolean;
}

/**
 * First Contact Resolution for the period.
 *
 * FCR = the share of callers whose first answered queue call in the period was the END of
 * the matter. Anything inside `windowDays` of that call that says it was not makes them a
 * repeat:
 *
 *   * THEY CALLED AGAIN. Any inbound queue call from the same number counts, answered or
 *     not. Counting only answered repeats scored a customer who rang back twice and gave
 *     up both times as perfectly resolved -- the worst case reported as the best.
 *   * WE CALLED THEM. An agent dialling the customer within `callbackHours` of the call is
 *     us saying the first call left something outstanding.
 *
 * Numbers are matched on numberKey, so '+2010...' and '010...' are one caller, and an
 * anonymous, empty or internal (short) caller ID is no caller at all. Off (fcr_pct null)
 * when the window is 0. A database error propagates (a 500, not a missing figure).
 */
export async function computeFcr(
  dateFrom: string,
  dateTo: string,
  windowDays: number,
  opts: { callbackHours?: number; allowedQueues?: Scope; callbacks?: Map<string, Date[]> | null } = {},
): Promise<FcrResult> {
  const callbackHours = opts.callbackHours ?? 0;
  const off: FcrResult = { fcr_pct: null, base: 0, repeat: 0, provisional: false };
  if (windowDays <= 0) return off;

  const [queueCond, qparams] = scopeQueueCondition(opts.allowedQueues ?? null, 'dst');
  const windowEnd = addDaysYmd(dateTo, windowDays + 1);
  let rows: Row[];
  try {
    // Every real inbound queue call in the period and its follow-on window, answered or
    // not. `answered` decides which of them can START a case; all of them can end one.
    rows = await query(
      `SELECT src, calldate, (${QUEUE_ANSWERED_BARE_SQL}) AS answered
         FROM cdr
        WHERE calldate >= ?
          AND calldate < ?
          AND lastapp = 'Queue'
          ${realQueueCond('cdr')}
          ${queueCond}
        ORDER BY calldate`,
      [dateFrom, windowEnd, ...qparams],
      'cdr',
    );
  } catch (e) {
    log.error('analytics: FCR query error: %s', e);
    throw e;
  }

  const byCaller = new Map<string, [Date, boolean][]>();
  for (const r of rows) {
    const key = numberKey(r.src);
    if (key) pushTo(byCaller, key, [r.calldate as Date, truthy(r.answered)]);
  }

  const callbacks = callbackHours
    ? opts.callbacks ?? await outboundCallbacks(dateFrom, dateTo, callbackHours)
    : new Map<string, Date[]>();

  const periodStart = wall(strptimeYmd(dateFrom));
  const periodEnd = wall(strptimeYmd(dateTo)) + DAY_SECS * 1000;
  let base = 0;
  let repeat = 0;
  for (const [key, calls] of byCaller) {
    const first = calls.find(([d, answered]) => answered && periodStart <= wall(d) && wall(d) < periodEnd);
    if (!first) continue; // nobody we answered in this period: not a case this period opened
    base += 1;
    const f = wall(first[0]);
    const boundary = f + windowDays * DAY_SECS * 1000;
    const rangAgain = calls.some(([d]) => f < wall(d) && wall(d) <= boundary);
    if (rangAgain || calledBackWithin(callbacks, key, first[0], callbackHours)) repeat += 1;
  }
  if (!base) return off;
  return {
    fcr_pct: pyRound((1 - repeat / base) * 100, 1),
    base,
    repeat,
    provisional: periodEnd + windowDays * DAY_SECS * 1000 > wall(new Date()),
  };
}

export interface RecoveryBlock {
  abandoned_callers: number;
  recovered_callers: number;
  recovery_rate: number | null;
  net_abandonment_rate: number | null;
}

/**
 * Abandoned callers we went back and got: the figure an abandon rate alone cannot show.
 *
 * A caller who gave up waiting and whom an agent then rang back within the callback window
 * is not the same outcome as one nobody ever spoke to, but the abandon rate counts them
 * identically -- and should, which is why `abandonment_rate` is left exactly as it is. This
 * adds the second figure beside it. Counted in PEOPLE: someone who gave up three times and
 * was reached once is one caller recovered.
 *
 * `net_abandonment_rate` is the abandon rate with the recovered people's abandoned calls
 * taken out of the numerator, over the same offered calls.
 */
export function recoveryBlock(queueRows: Row[], kpis: QueueKpis, callbacks: Map<string, Date[]>, callbackHours: number): RecoveryBlock {
  const firstAbandon = new Map<string, Date>();
  for (const r of queueRows) {
    if (queueRowAnswered(r)) continue;
    const key = numberKey(dget(r, 'src', null));
    const when = truthy(r.calldate) ? (r.calldate as Date) : null;
    if (!key || !when) continue;
    const prev = firstAbandon.get(key);
    if (prev === undefined || wall(when) < wall(prev)) firstAbandon.set(key, when);
  }
  const recovered = new Set<string>();
  if (callbackHours) {
    for (const [k, when] of firstAbandon) if (calledBackWithin(callbacks, k, when, callbackHours)) recovered.add(k);
  }
  // The abandoned CALLS of the recovered people, which is what comes out of the rate.
  const recoveredCalls = queueRows.filter((r) => !queueRowAnswered(r) && recovered.has(numberKey(dget(r, 'src', null)))).length;
  return {
    abandoned_callers: firstAbandon.size,
    recovered_callers: recovered.size,
    recovery_rate: callbackHours ? rate(recovered.size, firstAbandon.size) : null,
    net_abandonment_rate: rate(Math.max(0, kpis.abandoned_calls - recoveredCalls), kpis.total_calls),
  };
}

// ---------------------------------------------------------------------------
// Call-history volume
// ---------------------------------------------------------------------------

/**
 * Call-history rows for a period, the same data source the Call History page reads, with
 * the queue scope applied (queueScopeFilter) on top of the extension scope.
 *
 * enrich=false: analytics never reads recording paths or supervision flags, so that per-row
 * work is skipped -- a real saving when scanning a whole period. The call log answers []
 * when its CDR read fails, so an empty period is confirmed against the CDR database before
 * it is reported as one: a dead database is a 500, not "no calls".
 */
export async function periodCallLogRows(
  dateFrom: string,
  dateTo: string,
  allowedQueues: Scope,
  allowedAgents: Scope,
  outcomes = false,
): Promise<Row[]> {
  const rows = await callLog({
    dateFrom,
    dateTo,
    allowedExtensions: allowedAgents != null ? [...allowedAgents] : null,
    enrich: false,
    outcomes,
  });
  if (!rows.length) await query('SELECT 1 FROM cdr LIMIT 1', [], 'cdr');
  return queueScopeFilter(rows, allowedQueues);
}

/**
 * Volume figures for one slice of call-history rows: the one shape behind every direction
 * block (inbound, direct inbound, outbound, internal, combined), so a rate never means one
 * thing on one card and something else on the next. Answered is the row's derived status.
 */
export function volumeBlock(rows: Row[]): Row {
  const answeredRows = rows.filter(rowAnswered);
  const answered = answeredRows.length;
  const talk = answeredRows.reduce((s, r) => s + intOr0(dget(r, 'talk', null)), 0);
  return {
    total_calls: rows.length,
    answered_calls: answered,
    missed_calls: rows.length - answered,
    aht_secs: answered ? pyRound(talk / answered) : null,
    sum_billsec: talk,
    ...peopleRates(rows.map((r) => ({ answered: rowAnswered(r), counterparty: counterpartyKey(r) }))),
  };
}

/**
 * The volume blocks of a period, split the way the Dashboard and the Overview show them.
 * Combined counts every call in scope, internal included, on both sides of every ratio.
 */
export function computeVolumeKpis(rows: Row[]): Row {
  const inRows = rows.filter((r) => r.call_type === 'IN');
  const outRows = rows.filter((r) => r.call_type === 'OUT');
  // Everything that is neither inbound nor outbound: extension to extension, feature
  // codes and audio-test calls. Part of the total, so the split adds up.
  const internalRows = rows.filter((r) => r.call_type !== 'IN' && r.call_type !== 'OUT');

  // The outbound failure split counts the call status (the vocabulary Call History shows)
  // rather than raw CDR dispositions, so "No answer" here is UNANSWERED there.
  const countStatus = (st: string) => outRows.filter((r) => r.status === st).length;
  const outbound = volumeBlock(outRows);
  Object.assign(outbound, {
    failed_calls: countStatus(FAILURE),
    no_answer_calls: countStatus(UNANSWERED),
    busy_calls: countStatus(BUSY),
  });
  const internal = volumeBlock(internalRows);
  return {
    // Every inbound call, queue and direct together: the inbound card's volume.
    inbound: volumeBlock(inRows),
    // Inbound that never entered a queue: someone dialled an extension direct. No SLA and
    // no abandonment apply -- there was no queue to wait in.
    inbound_direct: volumeBlock(inRows.filter((r) => !isQueueCall(r))),
    outbound,
    internal,
    combined: { ...volumeBlock(rows), internal_calls: internal.total_calls },
  };
}

/**
 * KPIs for one period: queue quality + call volume, each from the data source that owns it.
 *
 *   * queue quality (SLA, abandonment, short abandon, wait, queue AHT, FCR, recovery) -- the
 *     queue CDR run, the same rows and the same wait formula Queue Performance uses, so the
 *     Overview and the Queues tab cannot report different figures for the same day. A direct
 *     dial to an extension that rang out is not a queue abandon.
 *   * volume (inbound, direct inbound, outbound, internal, combined) -- the call log, the
 *     same source as Call History.
 */
export async function computePeriodKpisWithOutbound(
  dateFrom: string,
  dateTo: string,
  allowedQueues: Scope,
  allowedAgents: Scope,
  thresholds: SlaThresholds,
  defaultSecs: number,
  shortAbandonSecs: number,
  windowDays: number,
  callbackHours = 0,
): Promise<Row> {
  const [queueCond, qparams] = scopeQueueCondition(allowedQueues);
  const queueRows = await runQueueCdr(dateFrom, dateTo, queueCond, qparams);
  const kpis: Row = deriveRates(computeKpisFromRows(queueRows, thresholds, defaultSecs, shortAbandonSecs));
  Object.assign(kpis, peopleRates(queuePeople(queueRows)));

  const rows = await periodCallLogRows(dateFrom, dateTo, allowedQueues, allowedAgents);
  Object.assign(kpis, computeVolumeKpis(rows));

  // One read of our outbound calls serves both FCR's callback test and recovery.
  const callbacks = await outboundCallbacks(dateFrom, dateTo, callbackHours);
  Object.assign(kpis, recoveryBlock(queueRows, kpis as QueueKpis, callbacks, callbackHours));

  const fcr = await computeFcr(dateFrom, dateTo, windowDays, { callbackHours, allowedQueues, callbacks });
  kpis.fcr_pct = fcr.fcr_pct;
  // What the percentage was computed from, so the UI can name the population, and mark a
  // figure whose window has not closed yet.
  kpis.fcr_callers = fcr.base;
  kpis.fcr_repeat_callers = fcr.repeat;
  kpis.fcr_provisional = fcr.provisional;
  return kpis;
}

export interface ReportScope {
  allowedQueues?: Scope;
  allowedAgents?: Scope;
  slaThresholds?: SlaThresholds | null;
  fcrCfg?: Partial<FcrSettings> | null;
}

/** The [prev_from, prev_to] window of equal length right before [dateFrom, dateTo]. */
export function previousPeriod(dateFrom: string, dateTo: string): [string, string] {
  const delta = ymdOrdinal(dateTo) - ymdOrdinal(dateFrom) + 1;
  return [addDaysYmd(dateFrom, -delta), addDaysYmd(dateFrom, -1)];
}

/**
 * The widest range that still gets a previous-period comparison. A month covers every
 * preset read as "how are we doing against last time"; beyond it the comparison doubles a
 * long scan to decorate the cards with an arrow, and prev_period is null instead.
 */
export const COMPARABLE_PERIOD_DAYS = 31;

/**
 * Combined KPIs for the executive overview: the current period plus the previous period of
 * the same length (for deltas; null past COMPARABLE_PERIOD_DAYS), queue quality with the
 * volume blocks, and the settings the figures were computed against.
 */
export async function computeExecutiveKpis(
  dateFrom: string | null | undefined,
  dateTo: string | null | undefined,
  opts: ReportScope = {},
): Promise<Row> {
  const [df, dt] = defaultDates(dateFrom, dateTo);
  const thresholds = truthy(opts.slaThresholds) ? (opts.slaThresholds as SlaThresholds) : await getSlaThresholds();
  const defaultSecs = await getSlaDefaultSecs();
  const fcr: Partial<FcrSettings> = truthy(opts.fcrCfg) ? (opts.fcrCfg as Partial<FcrSettings>) : await getFcrSettings();
  const shortAbandonSecs = dget(fcr, 'short_abandon_secs', FCR_DEFAULTS.short_abandon_secs);
  const windowDays = dget(fcr, 'window_days', FCR_DEFAULTS.window_days);
  const callbackHours = dget(fcr, 'callback_window_hours', FCR_DEFAULTS.callback_window_hours);
  const allowedQueues = opts.allowedQueues ?? null;
  const allowedAgents = opts.allowedAgents ?? null;
  const period = (from: string, to: string) => computePeriodKpisWithOutbound(
    from, to, allowedQueues, allowedAgents, thresholds, defaultSecs, shortAbandonSecs, windowDays, callbackHours,
  );

  const kpis = await period(df, dt);
  let prevKpis: Row | null = null;
  if (ymdOrdinal(dt) - ymdOrdinal(df) + 1 <= COMPARABLE_PERIOD_DAYS) {
    const [prevFrom, prevTo] = previousPeriod(df, dt);
    prevKpis = await period(prevFrom, prevTo);
  }
  return {
    period: { from: df, to: dt },
    current: kpis,
    prev_period: prevKpis,
    // The thresholds these KPIs were computed against, so the UI can state the real numbers
    // when it explains a KPI. Not sensitive: anyone holding analytics:read already sees the
    // figures derived from them.
    settings: {
      sla_default_secs: defaultSecs,
      fcr_window_days: windowDays,
      short_abandon_secs: shortAbandonSecs,
      callback_window_hours: callbackHours,
    },
  };
}

/** Lower edges of the queue wait-time buckets, in seconds; the last one is open-ended. */
export const WAIT_BUCKET_EDGES = [0, 10, 20, 30, 60, 120, 300] as const;

/** Per-queue KPI rows, busiest queue first. */
export async function computeQueuePerformance(
  dateFrom: string | null | undefined,
  dateTo: string | null | undefined,
  opts: ReportScope = {},
): Promise<Row[]> {
  const [df, dt] = defaultDates(dateFrom, dateTo);
  const thresholds = truthy(opts.slaThresholds) ? (opts.slaThresholds as SlaThresholds) : await getSlaThresholds();
  const defaultSecs = await getSlaDefaultSecs();
  const fcr: Partial<FcrSettings> = truthy(opts.fcrCfg) ? (opts.fcrCfg as Partial<FcrSettings>) : await getFcrSettings();
  const shortAbandonSecs = dget(fcr, 'short_abandon_secs', FCR_DEFAULTS.short_abandon_secs);
  const queueNames = await getQueueNames();

  const [queueCond, qparams] = scopeQueueCondition(opts.allowedQueues ?? null);
  const rows = await runQueueCdr(df, dt, queueCond, qparams);

  const byQueue = new Map<string, Row[]>();
  // Calls per hour of day per queue, for the peak hour
  const hourCounts = new Map<string, Map<number, number>>();
  for (const r of rows) {
    const q = sget(r, 'queue_ext');
    pushTo(byQueue, q, r);
    let hc = hourCounts.get(q);
    if (!hc) hourCounts.set(q, (hc = new Map()));
    inc(hc, truthy(r.calldate) ? (r.calldate as Date).getHours() : 0);
  }

  // Each queue's own day-by-day offered / answered / abandoned, for the detail chart. Every
  // day of the range is present (zeros included) so queues line up on one axis.
  const dailyOf = (qRows: Row[]): Row[] => {
    const byDay = new Map<string, { offered: number; answered: number }>();
    for (const r of qRows) {
      if (!truthy(r.calldate)) continue;
      const day = dateIso(r.calldate as Date);
      const d = byDay.get(day) ?? { offered: 0, answered: 0 };
      d.offered += 1;
      if (queueRowAnswered(r)) d.answered += 1;
      byDay.set(day, d);
    }
    const out: Row[] = [];
    for (let cur = ymdOrdinal(df); cur <= ymdOrdinal(dt); cur++) {
      const day = ordinalYmd(cur);
      const d = byDay.get(day) ?? { offered: 0, answered: 0 };
      out.push({ date: day, offered: d.offered, answered: d.answered, abandoned: d.offered - d.answered });
    }
    return out;
  };

  // How long each queue's callers waited, answered and abandoned, in fixed buckets: the
  // shape behind the average wait. Wait is the same clamped figure the SLA and the average use.
  const waitDistOf = (qRows: Row[]): Row[] => {
    const buckets = WAIT_BUCKET_EDGES.map((from, i) => ({
      from_secs: from, to_secs: WAIT_BUCKET_EDGES[i + 1] ?? null, answered: 0, abandoned: 0,
    }));
    for (const r of qRows) {
      const wait = queueWait(r);
      let i = buckets.length - 1;
      while (i > 0 && wait < buckets[i].from_secs) i--;
      if (queueRowAnswered(r)) buckets[i].answered += 1;
      else buckets[i].abandoned += 1;
    }
    return buckets;
  };

  const result: Row[] = [];
  for (const [qExt, qRows] of byQueue) {
    const k = deriveRates(computeKpisFromRows(qRows, thresholds, defaultSecs, shortAbandonSecs));
    // The callers behind the calls, for the per-person answer rate (as the overview counts it).
    const people = peopleRates(queuePeople(qRows));
    // max(counts, key=counts.get): the first hour with the highest count
    let peak: number | null = null;
    let best = -1;
    for (const [h, n] of hourCounts.get(qExt) ?? []) {
      if (n > best) {
        best = n;
        peak = h;
      }
    }
    result.push({
      queue_extension: qExt,
      queue_name: dget(queueNames, qExt, qExt),
      total_calls: k.total_calls,
      answered_calls: k.answered_calls,
      abandoned_calls: k.abandoned_calls,
      sla_pct: k.sla_pct,
      aht_secs: k.aht_secs,
      avg_wait_secs: k.avg_wait_secs,
      peak_hour: peak,
      // Beyond the Python's row, for the queue comparison chart: distinct callers answered
      // / distinct callers, talk time of the answered calls, and the unanswered calls.
      answer_rate: people.answer_rate,
      talk_secs: k.sum_billsec,
      missed_calls: k.abandoned_calls,
      // The same derived rates the Overview's queue service shows, per queue.
      abandonment_rate: k.abandonment_rate,
      short_abandon_rate: k.short_abandon_rate,
      daily: dailyOf(qRows),
      wait_distribution: waitDistOf(qRows),
    });
  }

  // Array.sort is stable, as Python's sort is.
  result.sort((a, b) => b.total_calls - a.total_calls);
  return result;
}

/**
 * Per-agent KPI rows with a 7-day daily trend (answered calls on each of the last 7 days
 * of the period), from Call History data.
 *
 * Each row is keyed by the extension the call is credited to, and only extensions inside
 * the caller's agent scope are listed: the call log returns every call that TOUCHED an
 * in-scope extension, which includes calls credited to colleagues outside it.
 *
 * The table ranks people on CUSTOMER work. An extension-to-extension call is a colleague
 * asking a question: it is not a handled contact and has no SLA, so it is reported in its
 * own `internal_calls` column and left out of total, answered and the rank.
 */
export async function computeAgentPerformance(
  dateFrom: string | null | undefined,
  dateTo: string | null | undefined,
  opts: ReportScope = {},
): Promise<Row[]> {
  const [df, dt] = defaultDates(dateFrom, dateTo);
  const thresholds = truthy(opts.slaThresholds) ? (opts.slaThresholds as SlaThresholds) : await getSlaThresholds();
  const defaultSecs = await getSlaDefaultSecs();
  const agentNames = await getAgentNames();
  const allowedAgents = opts.allowedAgents ?? null;
  const inScope = allowedAgents === null ? null : new Set(allowedAgents.map(String));

  const allRows = await periodCallLogRows(df, dt, null, allowedAgents);

  const byAgentTotal = new Map<string, number>(); // customer calls handled (inbound + outbound)
  const byAgentAnswered = new Map<string, number>();
  const byAgentBillsec = new Map<string, number>();
  const byAgentSlaMet = new Map<string, number>(); // SLA met (inbound queue only)
  const byAgentInbound = new Map<string, number>();
  const byAgentInboundAnswered = new Map<string, number>(); // SLA denominator
  const byAgentOutbound = new Map<string, number>();
  const byAgentInternal = new Map<string, number>(); // extension to extension: counted, not ranked
  const dailyTrend = new Map<string, Map<string, number>>(); // agent -> day -> answered
  const byAgentMissed = new Map<string, number>(); // calls that rang the agent, unanswered
  const byAgentPeople = new Map<string, PersonCall[]>(); // for answer_rate
  const seen: string[] = []; // first-seen order of every listed agent

  for (const r of allRows) {
    const ext = sgetOr(r, 'extension');
    if (!ext || !isDigits(ext)) continue;
    if (inScope && !inScope.has(ext)) continue;
    if (!byAgentTotal.has(ext) && !byAgentInternal.has(ext)) seen.push(ext);

    const callType = dget<unknown>(r, 'call_type', '');
    if (callType !== 'IN' && callType !== 'OUT') {
      inc(byAgentInternal, ext);
      continue;
    }

    const answered = rowAnswered(r);
    const duration = intOr0(dget(r, 'duration', null));
    const talk = intOr0(dget(r, 'talk', null));

    inc(byAgentTotal, ext);
    if (callType === 'IN') inc(byAgentInbound, ext);
    else inc(byAgentOutbound, ext);
    if (!answered && callType === 'IN') inc(byAgentMissed, ext);
    pushTo(byAgentPeople, ext, { answered, counterparty: counterpartyKey(r) });

    if (answered) {
      inc(byAgentAnswered, ext);
      inc(byAgentBillsec, ext, talk);

      // SLA check: real queue calls only. A direct dial the agent picked up has no queue
      // threshold to be measured against.
      if (isQueueCall(r)) {
        inc(byAgentInboundAnswered, ext);
        const wait = Math.max(0, duration - talk);
        if (wait <= slaThresholdFor(sget(r, 'dst'), thresholds, defaultSecs)) inc(byAgentSlaMet, ext);
      }

      if (truthy(r.calldate)) {
        let days = dailyTrend.get(ext);
        if (!days) dailyTrend.set(ext, (days = new Map()));
        inc(days, dateIso(r.calldate as Date));
      }
    }
  }

  // 7-day daily trend: the last 7 days of the selected period
  const trendDays: string[] = [];
  for (let i = 6; i >= 0; i--) trendDays.push(addDaysYmd(dt, -i));

  const g = (m: Map<string, number>, k: string) => m.get(k) ?? 0;
  const result: Row[] = [];
  // An agent who only took internal calls still gets a row, zeroes where the customer work
  // would be: leaving them out would read as "did not work".
  for (const aExt of seen) {
    const answered = g(byAgentAnswered, aExt);
    const totalBillsec = g(byAgentBillsec, aExt);
    const inboundAnswered = g(byAgentInboundAnswered, aExt);
    // SLA % = answered inbound queue calls within threshold / answered inbound queue calls
    // (the queue-level definition: sla_met_calls / answered)
    const slaPct = inboundAnswered ? pyRound((g(byAgentSlaMet, aExt) / inboundAnswered) * 100, 1) : null;
    const days = dailyTrend.get(aExt);
    result.push({
      agent_extension: aExt,
      agent_name: dget(agentNames, aExt, aExt),
      total_calls: g(byAgentTotal, aExt),
      answered_calls: answered,
      inbound_calls: g(byAgentInbound, aExt),
      outbound_calls: g(byAgentOutbound, aExt),
      internal_calls: g(byAgentInternal, aExt),
      aht_secs: answered ? pyRound(totalBillsec / answered) : null,
      sla_contribution_pct: slaPct,
      daily_trend: trendDays.map((d) => days?.get(d) ?? 0),
      // Beyond the Python's row, for the agent comparison chart: distinct outside numbers
      // reached / involved, talk time of the answered calls, and the inbound calls that
      // rang this agent and were not answered.
      answer_rate: peopleRates(byAgentPeople.get(aExt) ?? []).answer_rate,
      talk_secs: totalBillsec,
      missed_calls: g(byAgentMissed, aExt),
    });
  }

  result.sort((a, b) => b.answered_calls - a.answered_calls);
  result.forEach((row, i) => {
    row.rank = i + 1;
  });
  return result;
}

/** The directions an agent's calls split into (computeAgentCalls). */
export const AGENT_CALL_DIRECTIONS = ['IN', 'OUT', 'INTERNAL'] as const;
export type AgentCallDirection = (typeof AGENT_CALL_DIRECTIONS)[number];

/** One direction's totals in the agent detail. */
export interface AgentDirectionSummary {
  direction: AgentCallDirection;
  calls: number;
  answered: number;
  /** Rang this agent and they did not take it -- including calls a colleague answered. */
  missed: number;
  /** Everything else: the other end never picked up, was busy, the line failed... */
  not_connected: number;
  talk_secs: number;
}

// The detail re-asks on every page and filter click, and the scan behind it is the whole
// period's call history for that extension. A minute of reuse covers a supervisor clicking
// through one agent without serving a figure staler than the live boards would.
const AGENT_CALLS_TTL_MS = 60_000;
const AGENT_CALLS_CACHE_MAX = 20;
const agentCallsCache = new Map<string, { at: number; rows: Promise<Row[]> }>();

function agentCallRows(agent: string, df: string, dt: string): Promise<Row[]> {
  const key = `${agent}|${df}|${dt}`;
  const now = Date.now();
  const hit = agentCallsCache.get(key);
  if (hit && now - hit.at < AGENT_CALLS_TTL_MS) return hit.rows;
  for (const [k, entry] of agentCallsCache) if (now - entry.at >= AGENT_CALLS_TTL_MS) agentCallsCache.delete(k);
  if (agentCallsCache.size >= AGENT_CALLS_CACHE_MAX) agentCallsCache.delete(agentCallsCache.keys().next().value as string);
  // outcomes=true: the list shows each call's status as Call History does (CEL facts).
  const rows = periodCallLogRows(df, dt, null, [agent], true);
  agentCallsCache.set(key, { at: now, rows });
  // A failed scan must not be served for the next minute.
  rows.catch(() => agentCallsCache.delete(key));
  return rows;
}

/** Test hook: forget every cached agent-calls scan. */
export function clearAgentCallsCache(): void {
  agentCallsCache.clear();
}

/**
 * Agent Performance row click: one agent's calls for the period, split by direction, with
 * the paginated call list behind it (newest first).
 *
 * The rows are Call History's, for every call that touched this extension on any leg -- the
 * same match the history scope uses. That reaches calls the table does not credit to the
 * agent: a queue call that rang them while a colleague answered, or nobody did. Those read
 * as MISSED here (`agent_status`), because from this agent's side that is what they were;
 * the row's own `status` still says how the call itself ended. `is_handled` is whether the
 * call is the agent's: the extension the row credits, or for an internal call either end.
 *
 * The caller must already have checked that `agent` is inside the requester's scope. A page
 * past the end is clamped to the last page.
 */
export async function computeAgentCalls(
  agent: string,
  dateFrom: string | null | undefined,
  dateTo: string | null | undefined,
  opts: { direction?: string | null; status?: string | null; page?: number; pageSize?: number } = {},
): Promise<Row> {
  const [df, dt] = defaultDates(dateFrom, dateTo);
  const pageSize = Math.max(1, opts.pageSize ?? 50);
  const wantDir = opts.direction ? opts.direction.toUpperCase() : null;
  const wantStatus = opts.status ? drilldownStatusFilter(opts.status) : null;
  const agentNames = await getAgentNames();
  const rows = await agentCallRows(agent, df, dt);

  const byDirection = new Map<string, AgentDirectionSummary>(AGENT_CALL_DIRECTIONS.map((d) => [d, {
    direction: d, calls: 0, answered: 0, missed: 0, not_connected: 0, talk_secs: 0,
  }]));
  const statusCounts: Record<string, number> = {};
  const listed: Row[] = [];
  for (const r of rows) {
    const ct = pyStr(dget(r, 'call_type', ''));
    const direction: AgentCallDirection = ct === 'IN' || ct === 'OUT' ? ct : 'INTERNAL';
    const isHandled = sgetOr(r, 'extension') === agent || (direction === 'INTERNAL' && sget(r, 'src') === agent);
    const status = pyStr(dget(r, 'status', '') ?? '');
    const agentStatus = isHandled ? status : MISSED;

    const sum = byDirection.get(direction) as AgentDirectionSummary;
    sum.calls += 1;
    if (agentStatus === ANSWERED) {
      sum.answered += 1;
      sum.talk_secs += intOr0(dget(r, 'talk', null));
    } else if (agentStatus === MISSED) {
      sum.missed += 1;
    } else {
      sum.not_connected += 1;
    }

    if (wantDir && direction !== wantDir) continue;
    // A facet ignores its own selection, so the other statuses stay pickable.
    if (agentStatus) statusCounts[agentStatus] = (statusCounts[agentStatus] ?? 0) + 1;
    if (wantStatus && agentStatus !== wantStatus) continue;
    listed.push({
      calldate: truthy(r.calldate) ? isoformat(r.calldate as Date) : null,
      direction,
      src: sget(r, 'src'),
      dst: sget(r, 'dst'),
      queue_extension: isQueueCall(r) ? sget(r, 'dst') : '',
      agent_extension: sgetOr(r, 'extension'),
      duration: intOr0(dget(r, 'duration', null)),
      talk: intOr0(dget(r, 'talk', null)),
      status,
      agent_status: agentStatus,
      is_handled: isHandled,
      linkedid: sget(r, 'linkedid'),
    });
  }

  // Newest first, as Call History lists them (ISO stamps sort as text).
  listed.sort((a, b) => pyStr(b.calldate ?? '').localeCompare(pyStr(a.calldate ?? '')));
  const lastPage = Math.max(1, Math.ceil(listed.length / pageSize));
  const page = Math.min(Math.max(1, opts.page ?? 1), lastPage);
  const start = (page - 1) * pageSize;
  return {
    agent,
    agent_name: dget(agentNames, agent, agent),
    directions: [...byDirection.values()],
    status_counts: statusCounts,
    calls: listed.slice(start, start + pageSize),
    total: listed.length,
    page,
    page_size: pageSize,
  };
}

export const HEATMAP_DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
export const HEATMAP_HOURS = Array.from({ length: 24 }, (_, h) => `${String(h).padStart(2, '0')}:00`);

/**
 * 7x24 matrix of queue call volumes for the heatmap widget: matrix[day_of_week][hour]
 * where day_of_week 0=Mon ... 6=Sun, plus the same matrix of unanswered calls.
 */
export async function computeHourlyHeatmap(
  dateFrom: string | null | undefined,
  dateTo: string | null | undefined,
  allowedQueues: Scope = null,
): Promise<Row> {
  const [df, dt] = defaultDates(dateFrom, dateTo);
  const [queueCond, qparams] = scopeQueueCondition(allowedQueues);

  let rows: Row[];
  try {
    rows = await query(
      `
        SELECT
            DAYOFWEEK(first_leg.calldate) AS dow,
            HOUR(first_leg.calldate)      AS hr,
            COUNT(*)                      AS cnt,
            -- Same answered rule as the KPIs, so a cell's abandon count agrees with the
            -- queue's abandoned total for that period.
            SUM(CASE WHEN ${ANSWERED_SQL} THEN 1 ELSE 0 END) AS answered_cnt
        FROM
            (
                SELECT c.*
                FROM cdr c
                JOIN (
                    SELECT linkedid, MIN(sequence) AS min_seq
                    FROM cdr
                    WHERE calldate >= ?
                      AND calldate < DATE_ADD(?, INTERVAL 2 DAY)
                    GROUP BY linkedid
                ) x ON c.linkedid=x.linkedid AND c.sequence=x.min_seq
            ) first_leg
        JOIN (
                SELECT c.*
                FROM cdr c
                JOIN (
                    SELECT linkedid, MAX(sequence) AS max_seq
                    FROM cdr
                    WHERE calldate >= ?
                      AND calldate < DATE_ADD(?, INTERVAL 2 DAY)
                    GROUP BY linkedid
                ) x ON c.linkedid=x.linkedid AND c.sequence=x.max_seq
            ) last_leg ON first_leg.linkedid=last_leg.linkedid
        WHERE first_leg.lastapp='Queue'
          ${realQueueCond()}
          AND first_leg.calldate >= ?
          AND first_leg.calldate < DATE_ADD(?, INTERVAL 1 DAY)
          ${queueCond}
        GROUP BY dow, hr
      `,
      [df, dt, df, dt, df, dt, ...qparams],
      'cdr',
    );
  } catch (e) {
    // Propagate so the API surfaces a 500 instead of an all-zero matrix that the UI would
    // render as a real (empty) heatmap.
    log.error('analytics: heatmap query error: %s', e);
    throw e;
  }

  const matrix = Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
  const abandonedMatrix = Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
  for (const r of rows) {
    // DAYOFWEEK: 1=Sun, 2=Mon, ..., 7=Sat -> 0=Mon ... 6=Sun
    const dayIdx = pyMod(toInt(r.dow) - 2, 7);
    const hr = toInt(r.hr);
    const total = toInt(r.cnt);
    const ans = toInt(r.answered_cnt);
    matrix[dayIdx][hr] = total;
    abandonedMatrix[dayIdx][hr] = total - ans;
  }

  return {
    matrix,
    abandoned_matrix: abandonedMatrix,
    labels: { days: [...HEATMAP_DAYS], hours: [...HEATMAP_HOURS] },
  };
}

/**
 * Per-value counts for the drilldown's filters, keyed by value: direction (IN / OUT /
 * INTERNAL), status (the call-status vocabulary), queue (queue calls by queue extension) and
 * agent (by the extension a call is credited to). Only values that occur appear.
 */
export interface DrilldownFacets {
  direction: Record<string, number>;
  status: Record<string, number>;
  queue: Record<string, number>;
  agent: Record<string, number>;
}

/** The CDR disposition words callStatus() does not know, as the status they read as. */
const CDR_DISPOSITION_STATUS: Readonly<Record<string, string>> = {
  'NO ANSWER': UNANSWERED,
  CONGESTION: NETWORK_ERROR,
};

/**
 * The status a drilldown `disposition` filter value selects: a call status in any
 * spelling callStatus() knows, or a raw CDR disposition (ANSWERED, NO ANSWER, BUSY,
 * FAILED, CONGESTION) as the status it reads as. Anything else is matched upper-cased,
 * so an unknown value selects nothing rather than everything.
 */
export function drilldownStatusFilter(value: string): string {
  const upper = value.trim().toUpperCase();
  return callStatus(upper) || CDR_DISPOSITION_STATUS[upper.replace(/\s+/g, ' ')] || upper;
}

export interface DrilldownOptions {
  queueExt?: string | null;
  agentExt?: string | null;
  direction?: string | null;
  dispositionFilter?: string | null;
  page?: number;
  pageSize?: number;
  allowedQueues?: Scope;
  allowedAgents?: Scope;
  slaThresholds?: SlaThresholds | null;
  /** Also count each filter's values under the other filters (see DrilldownFacets). */
  facets?: boolean;
}

/**
 * Paginated call records with analytics fields (wait_secs, sla_met), from the same data
 * source as Call History so a call reads the same in both.
 *
 * `queueExt` and `agentExt` match exactly: the queue a QUEUE call entered, and the extension
 * a call is credited to. `dispositionFilter` (the wire's `disposition` param) names a call
 * status and matches the status the row shows; a raw CDR disposition (NO ANSWER, FAILED,
 * ...) is accepted in any spelling callStatus() knows.
 */
export async function computeDrilldown(
  dateFrom: string | null | undefined,
  dateTo: string | null | undefined,
  opts: DrilldownOptions = {},
): Promise<Row> {
  const queueExt = opts.queueExt ? opts.queueExt.trim() : null;
  const agentExt = opts.agentExt ? opts.agentExt.trim() : null;
  const direction = opts.direction ?? null;
  const dispositionFilter = opts.dispositionFilter ?? null;
  const page = opts.page ?? 1;
  const pageSize = opts.pageSize ?? 50;

  const [df, dt] = defaultDates(dateFrom, dateTo);
  const thresholds = truthy(opts.slaThresholds) ? (opts.slaThresholds as SlaThresholds) : await getSlaThresholds();
  const defaultSecs = await getSlaDefaultSecs();

  // outcomes=true: the drilldown shows and filters by call status, so it reads the CEL
  // hangup facts Call History does -- a call is MISSED in both, never MISSED in one and
  // UNANSWERED in the other.
  const allRows = await periodCallLogRows(df, dt, opts.allowedQueues ?? null, opts.allowedAgents ?? null, true);

  const wantDir = direction && ['IN', 'OUT', 'INTERNAL'].includes(direction.toUpperCase()) ? direction.toUpperCase() : null;
  const wantStatus = dispositionFilter ? drilldownStatusFilter(dispositionFilter) : null;

  // With `facets`, the same pass also counts each filter's values under every OTHER filter
  // -- a facet ignores its own selection, so the choices beside the picked one stay
  // visible. It costs nothing extra: the period is scanned anyway.
  const filtered: Row[] = [];
  const facets: DrilldownFacets = { direction: {}, status: {}, queue: {}, agent: {} };
  const bump = (m: Record<string, number>, k: unknown) => {
    if (typeof k === 'string' && k) m[k] = (m[k] ?? 0) + 1;
  };
  for (const r of allRows) {
    const callType = dget<unknown>(r, 'call_type', '');
    const rowStatus = dget<unknown>(r, 'status', null);
    const rowQueue = isQueueCall(r) ? sget(r, 'dst') : '';
    const rowAgent = sgetOr(r, 'extension');
    const queueOk = !(queueExt && rowQueue !== queueExt);
    const agentOk = !(agentExt && rowAgent !== agentExt);
    const directionOk = !(wantDir && callType !== wantDir);
    const statusOk = !(wantStatus && rowStatus !== wantStatus);

    if (opts.facets) {
      if (queueOk && agentOk && statusOk) bump(facets.direction, callType);
      if (queueOk && agentOk && directionOk) bump(facets.status, rowStatus);
      if (agentOk && directionOk && statusOk) bump(facets.queue, rowQueue);
      if (queueOk && directionOk && statusOk) bump(facets.agent, rowAgent);
    }
    if (queueOk && agentOk && directionOk && statusOk) filtered.push(r);
  }

  const total = filtered.length;
  // Most recent first (stable, as Python's sort), then paginate
  const sortKey = (r: Row): number => (truthy(r.calldate) ? wall(r.calldate as Date) : -Infinity);
  filtered.sort((a, b) => {
    const ka = sortKey(a);
    const kb = sortKey(b);
    return ka === kb ? 0 : ka < kb ? 1 : -1;
  });
  const start = (page - 1) * pageSize;
  const pageRows = filtered.slice(start, start + pageSize);

  const records: Row[] = pageRows.map((r) => {
    const disp = sget(r, 'disposition').toUpperCase();
    const dst = sget(r, 'dst');
    const ct = dget<unknown>(r, 'call_type', '');
    // For queue calls, dst is the queue extension
    const qExt = isQueueCall(r) ? dst : '';
    const threshold = slaThresholdFor(qExt, thresholds, defaultSecs);
    // Wait time: only meaningful for queue calls
    const duration = intOr0(dget(r, 'duration', null));
    const talk = intOr0(dget(r, 'talk', null));
    const wait = qExt ? Math.max(0, duration - talk) : 0;
    const status = dget(r, 'status', null) || mapCallOutcome({ disposition: disp, answered: talk > 0 });
    return {
      calldate: truthy(r.calldate) ? isoformat(r.calldate as Date) : null,
      src: sget(r, 'src'),
      dst,
      queue_extension: qExt,
      agent_extension: sgetOr(r, 'extension'),
      duration,
      talk,
      disposition: disp,
      // The call status, as Call History shows it; `disposition` is the raw CDR value.
      status,
      wait_secs: wait,
      sla_met: Boolean(qExt) && status === ANSWERED && wait <= threshold,
      linkedid: sget(r, 'linkedid'),
      direction: ct,
    };
  });

  const out: Row = { calls: records, total, page, page_size: pageSize };
  if (opts.facets) out.facets = facets;
  return out;
}

// ---------------------------------------------------------------------------
// Volume trend (daily call counts for the period)
// ---------------------------------------------------------------------------

/** Calls in one hour of the day across the range, by direction. */
export interface HourVolume {
  hour: number;
  inbound: number;
  outbound: number;
  internal: number;
}

/**
 * The daily trend and, from the same rows, the period's calls by hour of day.
 *
 * trend: one {date, total_calls, answered_calls, abandoned_calls, outbound_total,
 * outbound_answered, internal_total, customers, customers_answered} per calendar day of the
 * range, no gaps. The inbound figures cover ALL inbound calls (abandoned = inbound with no
 * answer, which is why the chart says "unanswered"; queue abandonment is the narrower KPI).
 * customers / customers_answered are that day's distinct inbound callers and how many got
 * through, for the per-person answer rate. Answered is the row's derived status.
 *
 * hourly: 24 {hour, inbound, outbound, internal}; summed, they equal the trend's totals.
 */
export async function computeVolumeSeries(
  dateFrom: string | null | undefined,
  dateTo: string | null | undefined,
  allowedQueues: Scope = null,
  allowedAgents: Scope = null,
): Promise<{ trend: Row[]; hourly: HourVolume[] }> {
  const [df, dt] = defaultDates(dateFrom, dateTo);
  const allRows = await periodCallLogRows(df, dt, allowedQueues, allowedAgents);

  interface DayStats {
    in_total: number; in_answered: number; in_abandoned: number;
    out_total: number; out_answered: number; internal_total: number;
    people: Set<string>; people_answered: Set<string>;
  }
  const hourly: HourVolume[] = Array.from({ length: 24 }, (_, hour) => ({ hour, inbound: 0, outbound: 0, internal: 0 }));
  const dayStats = new Map<string, DayStats>();
  for (const r of allRows) {
    const callType = dget<unknown>(r, 'call_type', '');
    const calldate = sget(r, 'calldate');
    const day = calldate.slice(0, 10);
    if (!day || day.length < 10) continue;
    let s = dayStats.get(day);
    if (!s) {
      dayStats.set(day, (s = {
        in_total: 0, in_answered: 0, in_abandoned: 0, out_total: 0, out_answered: 0, internal_total: 0,
        people: new Set(), people_answered: new Set(),
      }));
    }
    const answered = rowAnswered(r);
    const hour = Number(calldate.slice(11, 13));
    const h = calldate.length >= 13 && Number.isInteger(hour) && hour >= 0 && hour < 24 ? hourly[hour] : null;
    if (callType === 'IN') {
      s.in_total += 1;
      if (h) h.inbound += 1;
      const key = counterpartyKey(r);
      if (key) {
        s.people.add(key);
        if (answered) s.people_answered.add(key);
      }
      if (answered) s.in_answered += 1;
      else s.in_abandoned += 1;
    } else if (callType === 'OUT') {
      s.out_total += 1;
      if (h) h.outbound += 1;
      if (answered) s.out_answered += 1;
    } else {
      s.internal_total += 1;
      if (h) h.internal += 1;
    }
  }

  const trend: Row[] = [];
  const end = ymdOrdinal(dt);
  for (let d = ymdOrdinal(df); d <= end; d++) {
    const dayStr = ordinalYmd(d);
    const s = dayStats.get(dayStr);
    trend.push({
      date: dayStr,
      total_calls: s?.in_total ?? 0,
      answered_calls: s?.in_answered ?? 0,
      abandoned_calls: s?.in_abandoned ?? 0,
      outbound_total: s?.out_total ?? 0,
      outbound_answered: s?.out_answered ?? 0,
      internal_total: s?.internal_total ?? 0,
      customers: s?.people.size ?? 0,
      customers_answered: s?.people_answered.size ?? 0,
    });
  }
  return { trend, hourly };
}

/** The daily trend alone (computeVolumeSeries without the hourly series). */
export async function computeVolumeTrend(
  dateFrom: string | null | undefined,
  dateTo: string | null | undefined,
  allowedQueues: Scope = null,
  allowedAgents: Scope = null,
): Promise<Row[]> {
  return (await computeVolumeSeries(dateFrom, dateTo, allowedQueues, allowedAgents)).trend;
}

// ---------------------------------------------------------------------------
// Pre-aggregation
// ---------------------------------------------------------------------------

/** Compute and upsert analytics for one hour bucket across all queues. */
export async function refreshHourlyBucket(
  hourDt: Date,
  slaThresholds: SlaThresholds,
  defaultSecs: number,
  shortAbandonSecs: number,
): Promise<void> {
  const hourS = hourStr(hourDt);
  const nextHourS = mysqlDatetime(wallAdd(new Date(hourDt.getFullYear(), hourDt.getMonth(), hourDt.getDate(), hourDt.getHours()), 3600));

  let rows: Row[];
  try {
    rows = await query(
      `
        SELECT
            first_leg.dst            AS queue_ext,
            last_leg.disposition,
            GREATEST(CASE WHEN last_leg.billsec>0
                 THEN first_leg.duration - last_leg.billsec
                 ELSE first_leg.duration END, 0) AS wait_secs,
            last_leg.billsec
        FROM
            (SELECT c.* FROM cdr c
             JOIN (
                SELECT linkedid, MIN(sequence) AS ms
                FROM cdr
                WHERE calldate >= ? AND calldate < ?
                GROUP BY linkedid
             ) x ON c.linkedid=x.linkedid AND c.sequence=x.ms
            ) first_leg
        JOIN (SELECT c.* FROM cdr c
              JOIN (
                SELECT linkedid, MAX(sequence) AS ms
                FROM cdr
                WHERE calldate >= ? AND calldate < ?
                GROUP BY linkedid
              ) x ON c.linkedid=x.linkedid AND c.sequence=x.ms
             ) last_leg ON first_leg.linkedid=last_leg.linkedid
        WHERE first_leg.lastapp='Queue'
          ${realQueueCond()}
          AND first_leg.calldate >= ?
          AND first_leg.calldate < ?
      `,
      [hourS, nextHourS, hourS, nextHourS, hourS, nextHourS],
      'cdr',
    );
  } catch (e) {
    log.warning('analytics: hourly aggregation error for %s: %s', hourS, e);
    return;
  }

  const byQueue = new Map<string, Row[]>();
  for (const r of rows) pushTo(byQueue, sget(r, 'queue_ext'), r);
  if (!byQueue.size) return;

  try {
    await withTransaction(async (conn) => {
      for (const [qExt, qRows] of byQueue) {
        const k = computeKpisFromRows(qRows, slaThresholds, defaultSecs, shortAbandonSecs);
        await execute(
          `
            INSERT INTO analytics_hourly
                (hour_bucket, queue_extension, total_calls, answered_calls, abandoned_calls,
                 short_abandoned, sum_wait_secs, sum_billsec, sla_met_calls)
            VALUES (?,?,?,?,?,?,?,?,?)
            ON DUPLICATE KEY UPDATE
                total_calls=VALUES(total_calls),
                answered_calls=VALUES(answered_calls),
                abandoned_calls=VALUES(abandoned_calls),
                short_abandoned=VALUES(short_abandoned),
                sum_wait_secs=VALUES(sum_wait_secs),
                sum_billsec=VALUES(sum_billsec),
                sla_met_calls=VALUES(sla_met_calls),
                computed_at=CURRENT_TIMESTAMP
          `,
          [hourS, qExt, k.total_calls, k.answered_calls, k.abandoned_calls,
            k.short_abandoned, k.sum_wait_secs, k.sum_billsec, k.sla_met_calls],
          conn,
        );
      }
    });
  } catch (e) {
    log.warning('analytics: hourly upsert error for %s: %s', hourS, e);
  }
}

/** Compute and upsert analytics for one calendar day ('YYYY-MM-DD') across all queues. */
export async function refreshDailyBucket(
  day: string,
  slaThresholds: SlaThresholds,
  defaultSecs: number,
  shortAbandonSecs: number,
  fcrWindowDays: number,
): Promise<void> {
  void fcrWindowDays; // accepted and unused, as in the Python
  // Re-use live compute for now (aggregation is idempotent via ON DUPLICATE KEY)
  let rows: Row[];
  try {
    rows = await runQueueCdr(day, day);
  } catch (e) {
    log.warning('analytics: skipping daily bucket for %s due to CDR error: %s', day, e);
    return;
  }
  if (!rows.length) return;

  const byQueue = new Map<string, Row[]>();
  for (const r of rows) pushTo(byQueue, sget(r, 'queue_ext'), r);

  try {
    await withTransaction(async (conn) => {
      for (const [qExt, qRows] of byQueue) {
        const k = computeKpisFromRows(qRows, slaThresholds, defaultSecs, shortAbandonSecs);
        const uniqueCallers = new Set(qRows.map((r) => sget(r, 'src'))).size;
        await execute(
          `
            INSERT INTO analytics_daily
                (day_bucket, queue_extension, total_calls, answered_calls, abandoned_calls,
                 short_abandoned, sum_wait_secs, sum_billsec, sla_met_calls, unique_callers)
            VALUES (?,?,?,?,?,?,?,?,?,?)
            ON DUPLICATE KEY UPDATE
                total_calls=VALUES(total_calls),
                answered_calls=VALUES(answered_calls),
                abandoned_calls=VALUES(abandoned_calls),
                short_abandoned=VALUES(short_abandoned),
                sum_wait_secs=VALUES(sum_wait_secs),
                sum_billsec=VALUES(sum_billsec),
                sla_met_calls=VALUES(sla_met_calls),
                unique_callers=VALUES(unique_callers),
                computed_at=CURRENT_TIMESTAMP
          `,
          [day, qExt, k.total_calls, k.answered_calls, k.abandoned_calls,
            k.short_abandoned, k.sum_wait_secs, k.sum_billsec, k.sla_met_calls, uniqueCallers],
          conn,
        );
      }
    });
  } catch (e) {
    log.warning('analytics: daily upsert error for %s: %s', day, e);
  }
}

// ---------------------------------------------------------------------------
// Background aggregation loop (started by the lifespan once AMI is up)
// ---------------------------------------------------------------------------

/** One aggregation pass: current + previous hour, today + yesterday, daily housekeeping. */
export async function aggregationCycle(now: Date = new Date()): Promise<void> {
  const thresholds = await getSlaThresholds();
  const defaultSecs = await getSlaDefaultSecs();
  const fcr = await getFcrSettings();
  const shortAbandonSecs = dget(fcr, 'short_abandon_secs', 5);
  const fcrWindowDays = dget(fcr, 'window_days', 7);

  const currentHour = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), 0, 0, 0);
  const prevHour = wallAdd(currentHour, -3600);

  // Hourly buckets
  await refreshHourlyBucket(currentHour, thresholds, defaultSecs, shortAbandonSecs);
  await refreshHourlyBucket(prevHour, thresholds, defaultSecs, shortAbandonSecs);

  // Daily buckets (today + yesterday)
  const today = dateIso(now);
  await refreshDailyBucket(today, thresholds, defaultSecs, shortAbandonSecs, fcrWindowDays);
  await refreshDailyBucket(addDaysYmd(today, -1), thresholds, defaultSecs, shortAbandonSecs, fcrWindowDays);

  const p2 = (n: number) => String(n).padStart(2, '0');
  log.debug('analytics: aggregation cycle complete (%s)', `${p2(now.getHours())}:${p2(now.getMinutes())}`);

  // Daily housekeeping: prune device tokens not refreshed in 90+ days, and age out the CRM
  // delivery log. This rides the aggregation loop rather than a MySQL EVENT because
  // enabling the event scheduler needs SUPER, which the OpDesk DB user does not have.
  if (today !== lastPruneDay) {
    await dbm.pruneStaleDeviceTokens();
    // int(get_setting(...) or 30), falling back to 30 where int() raised.
    const days = pyInt((await dbm.getSetting('WEBHOOK_LOG_RETENTION_DAYS', '30')) || '30') ?? 30;
    const removed = await dbm.pruneWebhookDeliveries(days);
    if (removed) log.info('analytics: pruned %s webhook delivery rows older than %s days', removed, days);
    lastPruneDay = today;
  }
}

let loopStop = false;

/** Stop the aggregation loop after its current sleep (shutdown, tests). */
export function stopAggregationLoop(): void {
  loopStop = true;
}

/** Background task: refreshes current and previous hour/day every 15 minutes. */
export async function startAggregationLoop(): Promise<void> {
  log.info('analytics: aggregation loop started');
  loopStop = false;
  while (!loopStop) {
    try {
      await aggregationCycle();
    } catch (e) {
      log.warning('analytics: aggregation loop error: %s', e);
    }
    await sleep(900); // 15 minutes
  }
}

// ===========================================================================
// Agent Adherence
// Aggregates agent_activity presence SEGMENTS into a per-agent summary: Login, Logout,
// Sessions, Logged In, Ready, On Call, Wrap-up, Break, Not Ready, DND, Occupancy — plus
// computeAgentTimeline(), the per-agent state-change trace behind a row click (every
// transition, when it happened, how long it lasted and why).
// Segments are clamped to the selected window so a shift that spans midnight is split
// correctly. Totalled here rather than by a GROUP BY, because which segments belong to a
// shift at all is a sequence question (see splitSessions) that SQL would have to answer
// with window functions — and this schema is MariaDB 5.5 safe.
// ===========================================================================

/** The states that mean the ACD can see the agent. DND is not one: it leaves every queue. */
export const ACTIVE_STATES = ['ready', 'on_call', 'wrap_up', 'not_ready'] as const;

/**
 * Seconds between two segments before they count as two separate logins. A transition
 * closes one segment and opens the next on one connection, so a same-session gap is 0-1s
 * of clock; anything longer is a real logout the agent came back from.
 */
export const SESSION_GAP_SECS = 5;

/**
 * Ceiling on one adherence read. Segments are totalled here, so they all cross the wire; a
 * presence transition is a human action, so even a year of a busy floor lands far below
 * this. The cap keeps an "All time" range from becoming a full-table read. Hitting it is
 * logged and drops the OLDEST part of the window, never the newest.
 */
export const SEGMENT_ROW_CAP = 50000;
const SEGMENT_LIMIT_SQL = `LIMIT ${SEGMENT_ROW_CAP}`;

/** One agent_activity presence segment. started_at/ended_at are naive local datetimes. */
export interface Segment {
  id: number;
  agent_ext: string;
  state: string;
  reason_code: string | null;
  queue: string | null;
  linkedid: string | null;
  source: string | null;
  started_at: Date;
  ended_at: Date | null;
}

/**
 * Presence segments overlapping the window, oldest first (per agent).
 *
 * started_at/ended_at come back RAW: clamping to the window is the caller's, so a segment
 * that began before the window opened can still be recognised for what it is. A database
 * failure is raised, not swallowed: an empty list here would read as "this agent did not
 * work", and the report would render its empty state over a dead DB.
 */
export async function segmentRows(
  windowStart: string,
  windowEnd: string,
  opts: { allowedAgents?: Scope; agentExt?: string | null } = {},
): Promise<Segment[]> {
  let cond: string;
  let params: Params;
  if (opts.agentExt) {
    [cond, params] = ['AND agent_ext = ?', [opts.agentExt]];
  } else {
    [cond, params] = scopeAgentCondition(opts.allowedAgents ?? null, 'agent_ext');
  }
  const rows = (await query(
    `SELECT id, agent_ext, state, reason_code, queue, linkedid, source, started_at, ended_at
       FROM agent_activity
      WHERE started_at <= ? AND (ended_at IS NULL OR ended_at >= ?)
      ${cond}
      ORDER BY started_at DESC, id DESC
      ${SEGMENT_LIMIT_SQL}`,
    [windowEnd, windowStart, ...params],
  )) as Segment[];
  if (rows.length >= SEGMENT_ROW_CAP) {
    log.warning('adherence: segment cap (%s) hit for %s..%s — oldest activity dropped',
      SEGMENT_ROW_CAP, windowStart, windowEnd);
  }
  // Read newest-first so the cap keeps the recent end, then restore the chronological
  // order per agent that splitSessions walks.
  rows.sort((a, b) => {
    const ea = pyStr(a.agent_ext);
    const eb = pyStr(b.agent_ext);
    if (ea !== eb) return ea < eb ? -1 : 1;
    const sa = wall(a.started_at);
    const sb = wall(b.started_at);
    if (sa !== sb) return sa < sb ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return rows;
}

export interface Session {
  login: Date;
  logout: Date | null;
  open: boolean;
  closed_by: string | null;
  duration_secs: number;
  segments: Segment[];
}

/**
 * Group one agent's ordered segments into login sessions.
 *
 * A session runs from a login to the logout that ended it. Three things end one:
 *
 *   * A GAP in the segment stream: logout writes no row of its own (the presence manager
 *     closes the open segment and stops), so the absence IS the logout.
 *
 *   * A DND the agent never comes back from that shift day. DND drops the agent from
 *     every queue just as logout does, and it is a common way to sign off: the PBX DND
 *     flag survives the night and startup hydration re-opens it, so a single "DND" can
 *     run for days. Counted as shift time it would report agents logged in around the
 *     clock.
 *
 *   * The SHIFT BOUNDARY. Segments arrive already cut at it (splitAtShiftBoundary), and a
 *     session ends when the shift day rolls over, so an agent who never logs out reports
 *     one shift per day instead of one session running for a week. It is the same
 *     boundary the forced end-of-day logout runs on.
 *
 * A DND the agent DOES return from the same shift day is a real in-shift DND and stays
 * inside the session, counted like any other state.
 *
 * Sessions are clamped to the window, so a shift that started yesterday reports only
 * today's part of itself. Each carries `closed_by`: 'dnd' when a sign-off DND ended it.
 */
export function splitSessions(
  segments: Segment[],
  winStart: Date,
  winEnd: Date,
  now: Date,
  boundaryMinutes: number | null = null,
): Session[] {
  // A comparable key for the shift day: the boundary datetime, or the calendar date.
  const shiftDay = (dt: Date): string =>
    boundaryMinutes !== null && boundaryMinutes !== undefined
      ? isoformat(shiftDayStart(dt, boundaryMinutes))
      : dateIso(dt);

  interface Building {
    login: Date;
    logout: Date;
    closed_by: string | null;
    open: boolean;
    segments: Segment[];
  }
  const sessions: Building[] = [];
  let cur: Building | null = null; // the session being built
  let pendingDnd: Segment[] = []; // DND segments held until we know whether the agent came back

  const close = (endDt: Date, closedBy: string | null, isOpen: boolean): void => {
    if (cur === null) return;
    cur.logout = endDt;
    cur.closed_by = closedBy;
    cur.open = isOpen;
    sessions.push(cur);
  };

  let prevEnd: Date | null = null;
  for (const s of segments) {
    const start = s.started_at;
    const end = s.ended_at || now;

    // A gap ends whatever was open, and drops any DND that was still pending: the agent
    // signed off on that DND and what follows is a new shift. So does the shift boundary,
    // for an agent still logged in when the day rolled over.
    if (cur !== null && prevEnd !== null
        && (wallDiffSecs(start, prevEnd) > SESSION_GAP_SECS || shiftDay(start) !== shiftDay(cur.login))) {
      close(pendingDnd.length ? pendingDnd[0].started_at : prevEnd, pendingDnd.length ? 'dnd' : null, false);
      cur = null;
      pendingDnd = [];
    }

    prevEnd = end;

    if (s.state === 'dnd') {
      if (cur !== null) pendingDnd.push(s);
      // A DND before any active segment is not a shift starting: it is an agent who has
      // not signed in yet. Dropped.
      continue;
    }

    if (cur === null) {
      cur = { login: start, logout: end, closed_by: null, open: false, segments: [] };
    } else if (pendingDnd.length) {
      if (shiftDay(start) === shiftDay(pendingDnd[0].started_at)) {
        cur.segments.push(...pendingDnd); // in-shift DND
      } else {
        close(pendingDnd[0].started_at, 'dnd', false);
        cur = { login: start, logout: end, closed_by: null, open: false, segments: [] };
      }
      pendingDnd = [];
    }
    cur.segments.push(s);
    cur.logout = end;
  }

  if (cur !== null) {
    const c: Building = cur;
    if (pendingDnd.length) close(pendingDnd[0].started_at, 'dnd', false);
    else close(c.logout, null, c.segments[c.segments.length - 1].ended_at === null);
  }

  const out: Session[] = [];
  for (const s of sessions) {
    const login = maxDt(s.login, winStart);
    const logout = minDt(s.logout, winEnd);
    if (wall(logout) < wall(login)) continue; // a session that ended before the window opened
    // ...or exactly as it opened: a shift cut at a midnight boundary leaves its pre-window
    // piece ending on the window's first second, which is no session inside the window.
    if (wall(s.login) < wall(winStart) && wall(s.logout) <= wall(winStart)) continue;
    s.segments.sort((a, b) => {
      const sa = wall(a.started_at);
      const sb = wall(b.started_at);
      if (sa !== sb) return sa < sb ? -1 : 1;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
    out.push({
      login,
      logout: s.open ? null : logout,
      open: s.open,
      closed_by: s.closed_by,
      duration_secs: Math.trunc(wallDiffSecs(logout, login)),
      segments: s.segments,
    });
  }
  return out;
}

/**
 * Minutes after midnight at which the shift day rolls over, or null when the daily reset
 * is off. The same setting the forced end-of-day logout runs on, so the report's idea of a
 * day and the floor's cannot drift apart.
 */
export async function shiftBoundaryMinutes(): Promise<number | null> {
  try {
    return await shiftResetMinutes();
  } catch (e) {
    log.warning('shift boundary unavailable, falling back to midnight: %s', e);
    return 0;
  }
}

/** The shift boundary at or before `dt`: the start of the shift day it belongs to. */
export function shiftDayStart(dt: Date, minutes: number): Date {
  const hour = floorDiv(minutes, 60);
  const minute = pyMod(minutes, 60);
  if (hour < 0 || hour > 23) throw new ValueError('hour must be in 0..23');
  let boundary = new Date(dt.getFullYear(), dt.getMonth(), dt.getDate(), hour, minute, 0, 0);
  if (wall(dt) < wall(boundary)) boundary = wallAdd(boundary, -DAY_SECS);
  return boundary;
}

/**
 * Cut every segment that runs through a shift boundary into one piece per shift day, so
 * splitSessions can end a session at the boundary the same way it ends one at a logout.
 * Totals are unchanged: a cut segment's pieces still sum to the original.
 */
export function splitAtShiftBoundary(segments: Segment[], minutes: number | null, now: Date): Segment[] {
  if (minutes === null || minutes === undefined) return segments;
  const out: Segment[] = [];
  for (const seg of segments) {
    const end = seg.ended_at || now;
    let cur = seg.started_at;
    let boundary = wallAdd(shiftDayStart(cur, minutes), DAY_SECS);
    while (wall(boundary) < wall(end)) {
      out.push({ ...seg, started_at: cur, ended_at: boundary });
      cur = boundary;
      boundary = wallAdd(boundary, DAY_SECS);
    }
    out.push({ ...seg, started_at: cur }); // keeps the original ended_at, null (still open) included
  }
  return out;
}

/**
 * Collapse consecutive segments that are the same state into one entry. A restart
 * re-opens the state the agent was already in, so one unbroken Ready can arrive as
 * several rows; they are not moves. Same state, reason, queue and call = one entry,
 * keeping the first start and the last end. Totals are unaffected.
 */
export function mergeRuns(segments: Segment[]): Segment[] {
  const out: Segment[] = [];
  for (const seg of segments) {
    const prev = out.length ? out[out.length - 1] : null;
    const same = prev !== null
      && prev.state === seg.state
      && prev.reason_code === seg.reason_code
      && prev.queue === seg.queue
      // Two calls back to back are two moves, not one: the linkedid separates them.
      && prev.linkedid === seg.linkedid
      && prev.ended_at !== null;
    if (same && prev) prev.ended_at = seg.ended_at;
    else out.push({ ...seg });
  }
  return out;
}

/** Seconds of `seg` that fall inside the window. */
export function clampedSecs(seg: Segment, winStart: Date, winEnd: Date, now: Date): number {
  const start = maxDt(seg.started_at, winStart);
  const end = minDt(seg.ended_at || now, winEnd);
  return Math.max(0, Math.trunc(wallDiffSecs(end, start)));
}

/** 'YYYY-MM-DD' + 'HH:MM:SS' as a naive local datetime (the window bounds). */
function windowDt(dateStr: string, time: string): Date {
  const [y, mo, d] = ymdParts(dateStr);
  const [h, mi, s] = time.split(':').map(Number);
  return new Date(y, mo - 1, d, h, mi, s);
}

/**
 * {agents: [row, ...], reasons: [catalog]} for the Agent Adherence report.
 *
 * Each row: agent, name, login (iso), logout (iso|null), logged_in (bool), sessions,
 * logged_in_secs, ready_secs, on_call_secs, wrap_secs, not_ready_secs, break_secs,
 * dnd_secs, productive_not_ready_secs, occupancy_pct, not_ready_breakdown[] by reason.
 *
 * Logged In = ready + on call + wrap-up + not ready + DND: the whole signed-in shift.
 * Occupancy = (on call + wrap) / (on call + wrap + ready). Break and DND are outside that
 * denominator: an agent on lunch was never available to be occupied. Login is the first
 * session's login and Logout the last session's logout (null while still logged in), both
 * cut at the shift boundary.
 *
 * An agent with no session in the window is not reported. Time spent signed off on DND
 * belongs to no shift and is counted nowhere, and every figure resets at the daily shift
 * boundary, so a multi-day range is a sum of day-shaped shifts.
 */
export async function computeAgentAdherence(
  dateFrom: string | null | undefined,
  dateTo: string | null | undefined,
  allowedAgents: Scope = null,
): Promise<Row> {
  const [df, dt] = defaultDates(dateFrom, dateTo);
  const windowStart = `${df} 00:00:00`;
  const windowEnd = `${dt} 23:59:59`;
  const winStartDt = windowDt(df, '00:00:00');
  const winEndDt = windowDt(dt, '23:59:59');
  const now = new Date();

  const agentNames = await getAgentNames();
  // Reason metadata for the productive split + labels.
  const reasonMeta = new Map<string, Row>();
  try {
    for (const r of await query('SELECT code, label, productive, color, is_system FROM pause_reasons')) {
      reasonMeta.set(r.code, r);
    }
  } catch (e) {
    log.warning('adherence reason_meta: %s', e);
  }

  const boundary = await shiftBoundaryMinutes();
  // Map, not an object: extensions are numeric strings and must keep first-seen order.
  const byAgent = new Map<string, Segment[]>();
  for (const s of splitAtShiftBoundary(await segmentRows(windowStart, windowEnd, { allowedAgents }), boundary, now)) {
    pushTo(byAgent, pyStr(s.agent_ext), s);
  }

  const result: Row[] = [];
  for (const [ext, segs] of byAgent) {
    const sessions = splitSessions(segs, winStartDt, winEndDt, now, boundary);
    if (!sessions.length) continue;

    const a = {
      ready_secs: 0, on_call_secs: 0, wrap_secs: 0, not_ready_secs: 0,
      break_secs: 0, dnd_secs: 0, productive_not_ready_secs: 0,
    };
    const breakdown = new Map<string, { code: string; label: unknown; productive: boolean; secs: number }>();
    for (const session of sessions) {
      for (const seg of session.segments) {
        const secs = clampedSecs(seg, winStartDt, winEndDt, now);
        const state = seg.state;
        if (state === 'ready') a.ready_secs += secs;
        else if (state === 'on_call') a.on_call_secs += secs;
        else if (state === 'wrap_up') a.wrap_secs += secs;
        else if (state === 'dnd') a.dnd_secs += secs;
        else if (state === 'not_ready') {
          a.not_ready_secs += secs;
          const code = seg.reason_code || 'unknown';
          const meta: Row = reasonMeta.get(code) ?? {};
          const productive = truthy(dget(meta, 'productive', null));
          if (productive) {
            a.productive_not_ready_secs += secs;
          } else {
            // Break = the unproductive part of Not Ready (break, lunch, an unknown
            // pause): "how long on breaks" is the question asked of this report, and a
            // Meeting is not a break.
            a.break_secs += secs;
          }
          let bd = breakdown.get(code);
          if (!bd) {
            bd = { code, label: dget(meta, 'label', code), productive, secs: 0 };
            breakdown.set(code, bd);
          }
          bd.secs += secs;
        }
      }
    }

    const loggedIn = a.ready_secs + a.on_call_secs + a.wrap_secs + a.not_ready_secs + a.dnd_secs;
    const handling = a.on_call_secs + a.wrap_secs;
    const avail = handling + a.ready_secs;
    const last = sessions[sessions.length - 1];
    const stillIn = last.open;
    result.push({
      agent: ext,
      name: dget(agentNames, ext, ''),
      login: isoformat(sessions[0].login),
      logout: stillIn ? null : isoformat(last.logout as Date),
      logged_in: stillIn,
      sessions: sessions.length,
      logged_in_secs: loggedIn,
      ...a,
      occupancy_pct: avail > 0 ? pyRound((handling / avail) * 100, 1) : 0.0,
      not_ready_breakdown: [...breakdown.values()].sort((x, y) => y.secs - x.secs),
    });
  }

  result.sort((x, y) => {
    if (x.logged_in_secs !== y.logged_in_secs) return y.logged_in_secs - x.logged_in_secs;
    return x.agent < y.agent ? -1 : x.agent > y.agent ? 1 : 0;
  });
  return { agents: result, reasons: [...reasonMeta.values()] };
}

/**
 * One agent's state-change trace for the window: every move, in order.
 *
 * Returns {agent, name, sessions: [{login, logout, open, closed_by, duration_secs,
 * entries[]}]}, newest session first. An entry is one presence state the agent was in:
 * state, why (reason label), which queue/call, when it started and ended, and how long it
 * held. Login and logout are not entries: they are the session's own boundaries.
 * `closed_by='dnd'` marks a shift the agent ended by going Do Not Disturb.
 *
 * Durations are the segment's time INSIDE the window, while started_at/ended_at are the
 * real clock times, so a shift crossing midnight reads honestly on both days. The caller
 * must already have checked that `agentExt` is inside the requester's scope.
 */
export async function computeAgentTimeline(
  agentExt: string | null | undefined,
  dateFrom: string | null | undefined,
  dateTo: string | null | undefined,
): Promise<Row> {
  const [df, dt] = defaultDates(dateFrom, dateTo);
  const windowStart = `${df} 00:00:00`;
  const windowEnd = `${dt} 23:59:59`;
  const winStartDt = windowDt(df, '00:00:00');
  const winEndDt = windowDt(dt, '23:59:59');
  const now = new Date();

  const ext = (agentExt || '').trim();
  const name = dget(await getAgentNames(), ext, '');

  const labels = new Map<string, Row>();
  try {
    for (const r of await query('SELECT code, label, productive, color FROM pause_reasons')) labels.set(r.code, r);
  } catch (e) {
    log.warning('timeline reason labels: %s', e);
  }

  const boundary = await shiftBoundaryMinutes();
  const segs = splitAtShiftBoundary(await segmentRows(windowStart, windowEnd, { agentExt: ext }), boundary, now);
  const sessions: Row[] = [];
  for (const s of splitSessions(segs, winStartDt, winEndDt, now, boundary)) {
    const entries: Row[] = mergeRuns(s.segments).map((seg) => {
      const code = seg.reason_code ?? null;
      const meta: Row = code ? labels.get(code) ?? {} : {};
      return {
        id: seg.id ?? null,
        state: seg.state,
        reason_code: code,
        reason_label: dget(meta, 'label', null) || code,
        queue: seg.queue ?? null,
        source: seg.source ?? null,
        started_at: isoformat(seg.started_at),
        ended_at: seg.ended_at ? isoformat(seg.ended_at) : null,
        open: seg.ended_at === null,
        duration_secs: clampedSecs(seg, winStartDt, winEndDt, now),
      };
    });
    sessions.push({
      login: isoformat(s.login),
      logout: s.logout ? isoformat(s.logout) : null,
      open: s.open,
      closed_by: s.closed_by,
      duration_secs: s.duration_secs,
      entries,
    });
  }

  sessions.reverse(); // newest session first: the one a supervisor opens the row to see
  return { agent: ext, name, sessions };
}
