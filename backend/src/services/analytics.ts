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
 *   - FCR (First Contact Resolution via callback window)
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
import { BUSY, callStatus, FAILURE, NETWORK_ERROR, UNANSWERED } from './call-outcomes';
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

/** Fill in the default date range (the last 30 days, ending today) where one is missing. */
export function defaultDates(dateFrom: string | null | undefined, dateTo: string | null | undefined): [string, string] {
  const today = dateIso(new Date());
  return [dateFrom || addDaysYmd(today, -30), dateTo || today];
}

// ---------------------------------------------------------------------------
// Settings helpers
// ---------------------------------------------------------------------------

export type SlaThresholds = Record<string, number>;

export interface FcrSettings {
  window_days: number;
  short_abandon_secs: number;
}

/**
 * Return dict of {queue_extension: threshold_secs}.
 * If a queue has no row, callers should fall back to SLA_DEFAULT_SECS setting.
 */
export async function getSlaThresholds(): Promise<SlaThresholds> {
  try {
    const rows = await query('SELECT queue_extension, threshold_secs FROM analytics_sla_settings');
    const out: SlaThresholds = {};
    for (const r of rows) out[r.queue_extension] = r.threshold_secs;
    return out;
  } catch (e) {
    log.warning('analytics: error loading SLA thresholds: %s', e);
    return {};
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

/** Return FCR/short-abandon config as a dict. */
export async function getFcrSettings(): Promise<FcrSettings> {
  try {
    const row = await queryOne('SELECT window_days, short_abandon_secs FROM analytics_fcr_settings WHERE id=1');
    if (row) return { window_days: row.window_days, short_abandon_secs: row.short_abandon_secs };
  } catch (e) {
    log.warning('analytics: error loading FCR settings: %s', e);
  }
  return { window_days: 7, short_abandon_secs: 5 };
}

/**
 * Upsert per-queue SLA thresholds.
 * thresholds: {queue_extension: threshold_secs}
 */
export async function saveSlaThresholds(thresholds: Record<string, unknown>): Promise<boolean> {
  if (!truthy(thresholds)) return true;
  const entries = Object.entries(thresholds);
  try {
    await withTransaction(async (conn) => {
      for (const [qext, secs] of entries) {
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

/** Update the singleton FCR settings row. */
export async function saveFcrSettings(windowDays: unknown, shortAbandonSecs: unknown): Promise<boolean> {
  const wd = toInt(windowDays);
  const sa = toInt(shortAbandonSecs);
  try {
    await execute(
      `INSERT INTO analytics_fcr_settings (id, window_days, short_abandon_secs)
         VALUES (1, ?, ?)
         ON DUPLICATE KEY UPDATE window_days=?, short_abandon_secs=?`,
      [wd, sa, wd, sa],
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
        CASE
            WHEN last_leg.billsec > 0
            THEN first_leg.duration - last_leg.billsec
            ELSE first_leg.duration
        END                             AS wait_secs,
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
        CASE
            WHEN first_leg.lastapp = 'Queue' AND last_leg.billsec > 0
            THEN first_leg.duration - last_leg.billsec
            WHEN first_leg.lastapp = 'Queue'
            THEN first_leg.duration
            ELSE 0
        END                             AS wait_secs,
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
 * Aggregate KPIs from a flat list of queue rows (raw queue CDR rows or the call-log rows
 * shaped for KPIs): every row that is not ANSWERED is an abandon.
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
    const disp = sget(r, 'disposition').toUpperCase();
    const wait = intOr0(dget(r, 'wait_secs', null));
    const bsec = intOr0(dget(r, 'billsec', null));
    const threshold = slaThresholdFor(sget(r, 'queue_ext'), thresholds, defaultSecs);

    if (disp === 'ANSWERED') {
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

/**
 * FCR% for the period: (1 - callbacks / callers answered) * 100.
 *
 * A "callback" is when the same src number places another answered inbound queue call
 * within window_days of its first answered call in the period. None when the window is
 * off, nobody was answered, or the query failed.
 */
export async function computeFcr(
  dateFrom: string,
  dateTo: string,
  windowDays: number,
  allowedQueues: Scope = null,
): Promise<number | null> {
  if (windowDays <= 0) return null;

  const [queueCond, qparams] = scopeQueueCondition(allowedQueues, 'dst');
  const windowEnd = addDaysYmd(dateTo, windowDays + 1);
  let allRows: Row[];
  try {
    allRows = await query(
      `SELECT src, calldate
         FROM cdr
        WHERE calldate >= ?
          AND calldate < ?
          AND lastapp = 'Queue'
          AND disposition = 'ANSWERED'
          ${queueCond}
        ORDER BY src, calldate`,
      [dateFrom, windowEnd, ...qparams],
      'cdr',
    );
  } catch (e) {
    log.warning('analytics: FCR query error: %s', e);
    return null;
  }

  const srcCalls = new Map<string, Date[]>();
  for (const r of allRows) pushTo(srcCalls, pyStr(r.src), r.calldate as Date);

  const periodStart = wall(strptimeYmd(dateFrom));
  const periodEnd = wall(strptimeYmd(dateTo)) + DAY_SECS * 1000;
  const inPeriod = (c: Date) => periodStart <= wall(c) && wall(c) < periodEnd;

  let answeredInPeriod = 0;
  let callbacks = 0;
  for (const calls of srcCalls.values()) {
    const first = calls.find(inPeriod);
    if (!first) continue;
    answeredInPeriod += 1;
    const boundary = wall(first) + windowDays * DAY_SECS * 1000;
    if (calls.some((c) => wall(c) > wall(first) && wall(c) <= boundary)) callbacks += 1;
  }
  if (!answeredInPeriod) return null;
  return pyRound((1 - callbacks / answeredInPeriod) * 100, 1);
}

// ---------------------------------------------------------------------------
// Answer rate: people, not calls
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
// digits is an extension or feature code, not an outside line.

export const NUMBER_KEY_DIGITS = 9;
export const MIN_EXTERNAL_DIGITS = 7;

/** A comparable key for an outside number, or '' when it is not one. */
export function numberKey(num: unknown): string {
  const digits = (truthy(num) ? pyStr(num) : '').replace(/[^\p{Nd}]/gu, '');
  if ([...digits].length < MIN_EXTERNAL_DIGITS) return '';
  return [...digits].slice(-NUMBER_KEY_DIGITS).join('');
}

/** part / whole as a 1-dp percentage, None on an empty whole. */
export function rate(part: number, whole: number): number | null {
  return whole ? pyRound((part / whole) * 100, 1) : null;
}

const isAnswered = (r: Row): boolean => sget(r, 'disposition').toUpperCase() === 'ANSWERED';

/** answer_rate / contact_rate and the counts behind them, for one slice of rows. */
export function peopleRates(rows: Row[]): Row {
  const answeredRows = rows.filter(isAnswered);
  const customers = new Set(rows.map((r) => r.counterparty).filter((k) => truthy(k)));
  const reached = new Set(answeredRows.map((r) => r.counterparty).filter((k) => truthy(k)));
  return {
    customers: customers.size,
    customers_answered: reached.size,
    answer_rate: rate(reached.size, customers.size),
    contact_rate: rate(answeredRows.length, rows.length),
  };
}

// ---------------------------------------------------------------------------
// Public KPI functions
// ---------------------------------------------------------------------------

/** KPIs split by direction (inbound queue vs outbound) plus the all-calls block. */
export function computeDirectionalKpis(
  rows: Row[],
  thresholds: SlaThresholds,
  defaultSecs: number,
  shortAbandonSecs: number,
): Row {
  const inRows = rows.filter((r) => r.direction === 'IN');
  const outRows = rows.filter((r) => r.direction === 'OUT');

  // Inbound queue KPIs
  const inKpis: Row = deriveRates(computeKpisFromRows(inRows, thresholds, defaultSecs, shortAbandonSecs));
  Object.assign(inKpis, peopleRates(inRows));

  // Outbound KPIs. The failure split counts the call status (the vocabulary Call History
  // shows) rather than raw CDR dispositions, so "No answer" here is UNANSWERED there.
  const outAnsweredRows = outRows.filter(isAnswered);
  const outAnswered = outAnsweredRows.length;
  const outBillsec = outAnsweredRows.reduce((s, r) => s + intOr0(dget(r, 'billsec', null)), 0);
  const countStatus = (st: string) => outRows.filter((r) => r.status === st).length;
  const outKpis: Row = {
    total_calls: outRows.length,
    answered_calls: outAnswered,
    failed_calls: countStatus(FAILURE),
    no_answer_calls: countStatus(UNANSWERED),
    busy_calls: countStatus(BUSY),
    aht_secs: outAnswered ? pyRound(outBillsec / outAnswered) : null,
    sum_billsec: outBillsec,
    ...peopleRates(outRows),
  };

  // Combined KPIs (all calls). Every direction on both sides, internal included: the
  // total always counted internal calls, so the answered count has to as well or the two
  // disagree.
  const allAnsweredRows = rows.filter(isAnswered);
  const allAnswered = allAnsweredRows.length;
  const allBillsec = allAnsweredRows.reduce((s, r) => s + intOr0(dget(r, 'billsec', null)), 0);
  const combined: Row = {
    total_calls: rows.length,
    // Everything that is neither inbound nor outbound: extension to extension, feature
    // codes and audio-test calls. Part of the total, so the split adds up.
    internal_calls: rows.filter((r) => r.direction !== 'IN' && r.direction !== 'OUT').length,
    answered_calls: allAnswered,
    aht_secs: allAnswered ? pyRound(allBillsec / allAnswered) : null,
    ...peopleRates(rows),
  };

  inKpis.outbound = outKpis;
  inKpis.combined = combined;
  return inKpis;
}

/** Call-history rows for a period, the same data source the Call History page reads. */
async function periodCallLogRows(dateFrom: string, dateTo: string, allowedAgents: Scope, outcomes = false): Promise<Row[]> {
  // enrich=false: analytics reuses the call-history data source but never reads recording
  // paths or supervision flags, so skip that per-row work (no filesystem index walk, no
  // supervision query) — a real saving when scanning a whole period.
  return callLog({
    dateFrom,
    dateTo,
    allowedExtensions: allowedAgents != null ? [...allowedAgents] : null,
    enrich: false,
    outcomes,
  });
}

/**
 * Queue scope on call-history rows: an inbound call to a numeric dst (a queue) outside
 * the caller's queues is dropped; everything else is left to the extension scope.
 */
export function queueScopeFilter(rows: Row[], allowedQueues: Scope): Row[] {
  if (allowedQueues === null || allowedQueues === undefined) return rows;
  const allowedQ = new Set(allowedQueues.map(String));
  return rows.filter((r) => {
    if (dget<unknown>(r, 'call_type', '') !== 'IN') return true;
    const dst = sget(r, 'dst');
    return !(dst && isDigits(dst) && !allowedQ.has(dst));
  });
}

/** KPIs for one period, inbound + outbound + combined, from the Call History data. */
export async function computePeriodKpisWithOutbound(
  dateFrom: string,
  dateTo: string,
  allowedQueues: Scope,
  allowedAgents: Scope,
  thresholds: SlaThresholds,
  defaultSecs: number,
  shortAbandonSecs: number,
  windowDays: number,
): Promise<Row> {
  const allRows = queueScopeFilter(await periodCallLogRows(dateFrom, dateTo, allowedAgents), allowedQueues);

  // Rows shaped for the KPI computation
  const enriched: Row[] = allRows.map((r) => {
    const callType = dget<unknown>(r, 'call_type', '');
    const dst = sget(r, 'dst');
    const duration = intOr0(dget(r, 'duration', null));
    const talk = intOr0(dget(r, 'talk', null));
    const qExt = callType === 'IN' && isDigits(dst) ? dst : '';
    return {
      direction: callType,
      // The outside party: who we dialled on an outbound call, who called us otherwise.
      counterparty: numberKey(callType === 'OUT' ? dget(r, 'dst', null) : dget(r, 'src', null)),
      disposition: sget(r, 'disposition').toUpperCase(),
      status: dget(r, 'status', null),
      queue_ext: qExt,
      wait_secs: qExt ? Math.max(0, duration - talk) : 0,
      billsec: talk,
      total_dur: duration,
    };
  });

  const kpis = computeDirectionalKpis(enriched, thresholds, defaultSecs, shortAbandonSecs);
  kpis.fcr_pct = await computeFcr(dateFrom, dateTo, windowDays, allowedQueues);
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
 * Combined KPIs for the executive overview: the current period plus the previous period of
 * the same length (for deltas), inbound queue metrics with outbound and combined blocks.
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
  const shortAbandonSecs = dget(fcr, 'short_abandon_secs', 5);
  const windowDays = dget(fcr, 'window_days', 7);
  const allowedQueues = opts.allowedQueues ?? null;
  const allowedAgents = opts.allowedAgents ?? null;

  const kpis = await computePeriodKpisWithOutbound(
    df, dt, allowedQueues, allowedAgents, thresholds, defaultSecs, shortAbandonSecs, windowDays,
  );
  const [prevFrom, prevTo] = previousPeriod(df, dt);
  const prevKpis = await computePeriodKpisWithOutbound(
    prevFrom, prevTo, allowedQueues, allowedAgents, thresholds, defaultSecs, shortAbandonSecs, windowDays,
  );
  return { period: { from: df, to: dt }, current: kpis, prev_period: prevKpis };
}

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
  const shortAbandonSecs = dget(fcr, 'short_abandon_secs', 5);
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

  const result: Row[] = [];
  for (const [qExt, qRows] of byQueue) {
    const k = deriveRates(computeKpisFromRows(qRows, thresholds, defaultSecs, shortAbandonSecs));
    // The callers behind the calls, for the per-person answer rate (as the overview counts it).
    const people = peopleRates(qRows.map((r) => ({ disposition: r.disposition, counterparty: numberKey(r.src) })));
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
    });
  }

  // Array.sort is stable, as Python's sort is.
  result.sort((a, b) => b.total_calls - a.total_calls);
  return result;
}

/**
 * Per-agent KPI rows with a 7-day daily trend (answered calls on each of the last 7 days
 * of the period). Covers ALL calls (inbound, outbound, internal), from Call History data.
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

  const allRows = await periodCallLogRows(df, dt, opts.allowedAgents ?? null);

  const byAgentTotal = new Map<string, number>(); // total calls handled (also the agent order)
  const byAgentAnswered = new Map<string, number>();
  const byAgentBillsec = new Map<string, number>();
  const byAgentSlaMet = new Map<string, number>(); // SLA met (inbound queue only)
  const byAgentInbound = new Map<string, number>();
  const byAgentInboundAnswered = new Map<string, number>(); // SLA denominator
  const byAgentOutbound = new Map<string, number>();
  const dailyTrend = new Map<string, Map<string, number>>(); // agent -> day -> answered
  const byAgentMissed = new Map<string, number>(); // calls that rang the agent, unanswered
  const byAgentPeople = new Map<string, Row[]>(); // [{disposition, counterparty}] for answer_rate

  for (const r of allRows) {
    const ext = sgetOr(r, 'extension');
    if (!ext || !isDigits(ext)) continue;

    const callType = dget<unknown>(r, 'call_type', '');
    const disp = sget(r, 'disposition').toUpperCase();
    const duration = intOr0(dget(r, 'duration', null));
    const talk = intOr0(dget(r, 'talk', null));
    const dst = sget(r, 'dst');

    inc(byAgentTotal, ext);
    if (callType === 'IN') inc(byAgentInbound, ext);
    else if (callType === 'OUT') inc(byAgentOutbound, ext);
    if (disp !== 'ANSWERED' && callType !== 'OUT') inc(byAgentMissed, ext);
    pushTo(byAgentPeople, ext, {
      disposition: disp,
      counterparty: numberKey(callType === 'OUT' ? dget(r, 'dst', null) : dget(r, 'src', null)),
    });

    if (disp === 'ANSWERED') {
      inc(byAgentAnswered, ext);
      inc(byAgentBillsec, ext, talk);

      // SLA check (only for inbound queue calls)
      if (callType === 'IN' && dst && isDigits(dst)) {
        inc(byAgentInboundAnswered, ext);
        const wait = Math.max(0, duration - talk);
        if (wait <= slaThresholdFor(dst, thresholds, defaultSecs)) inc(byAgentSlaMet, ext);
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

  const result: Row[] = [];
  for (const [aExt, total] of byAgentTotal) {
    const answered = byAgentAnswered.get(aExt) ?? 0;
    const totalBillsec = byAgentBillsec.get(aExt) ?? 0;
    const inboundAnswered = byAgentInboundAnswered.get(aExt) ?? 0;
    // SLA % = answered inbound queue calls within threshold / answered inbound queue calls
    // (the queue-level definition: sla_met_calls / answered)
    const slaPct = inboundAnswered ? pyRound(((byAgentSlaMet.get(aExt) ?? 0) / inboundAnswered) * 100, 1) : null;
    const days = dailyTrend.get(aExt);
    result.push({
      agent_extension: aExt,
      agent_name: dget(agentNames, aExt, aExt),
      total_calls: total,
      answered_calls: answered,
      inbound_calls: byAgentInbound.get(aExt) ?? 0,
      outbound_calls: byAgentOutbound.get(aExt) ?? 0,
      aht_secs: answered ? pyRound(totalBillsec / answered) : null,
      sla_contribution_pct: slaPct,
      daily_trend: trendDays.map((d) => days?.get(d) ?? 0),
      // Beyond the Python's row, for the agent comparison chart: distinct outside numbers
      // reached / involved, talk time of the answered calls, and the calls that rang this
      // agent (anything but their own outbound) and were not answered.
      answer_rate: peopleRates(byAgentPeople.get(aExt) ?? []).answer_rate,
      talk_secs: totalBillsec,
      missed_calls: byAgentMissed.get(aExt) ?? 0,
    });
  }

  result.sort((a, b) => b.answered_calls - a.answered_calls);
  result.forEach((row, i) => {
    row.rank = i + 1;
  });
  return result;
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
            SUM(CASE WHEN last_leg.disposition='ANSWERED' THEN 1 ELSE 0 END) AS answered_cnt
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
 * Per-value counts for the drilldown's Direction and Status filters, keyed by value
 * (IN / OUT / INTERNAL; the call-status vocabulary). Only values that occur appear.
 */
export interface DrilldownFacets {
  direction: Record<string, number>;
  status: Record<string, number>;
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
  /** Also count each direction and status under the other filters (see DrilldownFacets). */
  facets?: boolean;
}

/**
 * Paginated call records with analytics fields (wait_secs, sla_met), from the same data
 * source as Call History so a call reads the same in both.
 *
 * `dispositionFilter` (the wire's `disposition` param) names a call status and matches the
 * status the row shows; a raw CDR disposition (NO ANSWER, FAILED, ...) is accepted in any
 * spelling callStatus() knows.
 */
export async function computeDrilldown(
  dateFrom: string | null | undefined,
  dateTo: string | null | undefined,
  opts: DrilldownOptions = {},
): Promise<Row> {
  const queueExt = opts.queueExt ?? null;
  const agentExt = opts.agentExt ?? null;
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
  const allRows = queueScopeFilter(await periodCallLogRows(df, dt, opts.allowedAgents ?? null, true), opts.allowedQueues ?? null);

  const wantDir = direction && ['IN', 'OUT', 'INTERNAL'].includes(direction.toUpperCase()) ? direction.toUpperCase() : null;
  const wantStatus = dispositionFilter ? drilldownStatusFilter(dispositionFilter) : null;

  // With `facets`, the same pass also counts each direction and status under every OTHER
  // filter -- a facet ignores its own selection, so the choices beside the picked one
  // stay visible. It costs nothing extra: the period is scanned anyway.
  const filtered: Row[] = [];
  const facets: DrilldownFacets = { direction: {}, status: {} };
  for (const r of allRows) {
    const callType = dget<unknown>(r, 'call_type', '');
    const rowStatus = dget<unknown>(r, 'status', null);
    const queueOk = !(queueExt && sget(r, 'dst') !== queueExt);
    const agentOk = !(agentExt && sgetOr(r, 'extension') !== agentExt);
    const directionOk = !(wantDir && callType !== wantDir);
    const statusOk = !(wantStatus && rowStatus !== wantStatus);

    if (opts.facets && queueOk && agentOk) {
      if (statusOk && typeof callType === 'string' && callType) {
        facets.direction[callType] = (facets.direction[callType] ?? 0) + 1;
      }
      if (directionOk && typeof rowStatus === 'string' && rowStatus) {
        facets.status[rowStatus] = (facets.status[rowStatus] ?? 0) + 1;
      }
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
    // For queue inbound calls, dst is the queue extension
    const qExt = ct === 'IN' && isDigits(dst) ? dst : '';
    const threshold = slaThresholdFor(qExt, thresholds, defaultSecs);
    // Wait time: only meaningful for queue calls
    const duration = intOr0(dget(r, 'duration', null));
    const talk = intOr0(dget(r, 'talk', null));
    const wait = qExt ? Math.max(0, duration - talk) : 0;
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
      status: dget(r, 'status', null) || mapCallOutcome({ disposition: disp, answered: talk > 0 }),
      wait_secs: wait,
      sla_met: Boolean(qExt) && disp === 'ANSWERED' && wait <= threshold,
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

/**
 * One {date, total_calls, answered_calls, abandoned_calls, outbound_total,
 * outbound_answered} per calendar day of the range, no gaps. The inbound figures cover
 * ALL inbound calls (abandoned = inbound with no answer); direction classification goes
 * through the single classifier in call-log.ts, as the executive KPIs do.
 */
export async function computeVolumeTrend(
  dateFrom: string | null | undefined,
  dateTo: string | null | undefined,
  allowedQueues: Scope = null,
  allowedAgents: Scope = null,
): Promise<Row[]> {
  const [df, dt] = defaultDates(dateFrom, dateTo);
  const allRows = queueScopeFilter(await periodCallLogRows(df, dt, allowedAgents), allowedQueues);

  interface DayStats { in_total: number; in_answered: number; in_abandoned: number; out_total: number; out_answered: number }
  const dayStats = new Map<string, DayStats>();
  for (const r of allRows) {
    const callType = dget<unknown>(r, 'call_type', '');
    const disp = sget(r, 'disposition').toUpperCase().trim();
    const day = sget(r, 'calldate').slice(0, 10);
    if (!day || day.length < 10) continue;
    let s = dayStats.get(day);
    if (!s) dayStats.set(day, (s = { in_total: 0, in_answered: 0, in_abandoned: 0, out_total: 0, out_answered: 0 }));
    if (callType === 'IN') {
      s.in_total += 1;
      if (disp === 'ANSWERED') s.in_answered += 1;
      else s.in_abandoned += 1;
    } else if (callType === 'OUT') {
      s.out_total += 1;
      if (disp === 'ANSWERED') s.out_answered += 1;
    }
  }

  const result: Row[] = [];
  const end = ymdOrdinal(dt);
  for (let d = ymdOrdinal(df); d <= end; d++) {
    const dayStr = ordinalYmd(d);
    const s = dayStats.get(dayStr);
    result.push({
      date: dayStr,
      total_calls: s?.in_total ?? 0,
      answered_calls: s?.in_answered ?? 0,
      abandoned_calls: s?.in_abandoned ?? 0,
      outbound_total: s?.out_total ?? 0,
      outbound_answered: s?.out_answered ?? 0,
    });
  }
  return result;
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
            CASE WHEN last_leg.billsec>0
                 THEN first_leg.duration - last_leg.billsec
                 ELSE first_leg.duration END AS wait_secs,
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
