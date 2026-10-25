/**
 * Contact-center operations data: the OpDesk agents/queues tables (synced from the
 * PBX), call supervision (listen / whisper / barge), the Not-Ready reason catalog,
 * and agent presence segments (agent_activity).
 */

import type { PoolConnection } from 'mysql2/promise';
import { getLogger, pyStr } from '../../core/logger';
import { pyInt, truthy } from '../../core/py';
import { execute, placeholders, query, queryOne, withTransaction } from '../pool';
import type { Row, SqlValue } from '../pool';

const log = getLogger('db_manager');

/** `str(x or '').strip()` */
function strOrEmptyStripped(x: unknown): string {
  return (truthy(x) ? pyStr(x) : '').trim();
}

// ---------------------------------------------------------------------------
// Agents and queues (OpDesk tables, mirrored from the PBX)
// ---------------------------------------------------------------------------

/** [{extension, name}] from the agents table (name falls back to the extension). [] on error. */
export async function getAgentsList(): Promise<{ extension: string; name: string }[]> {
  try {
    const rows = await query('SELECT extension, name FROM agents ORDER BY extension');
    return rows.map((r) => ({ extension: r.extension, name: r.name || r.extension }));
  } catch (e) {
    log.warning('⚠️  Database error get_agents_list: %s', e);
    return [];
  }
}

/** [{extension, queue_name}] from the queues table, without the 'default' queue. [] on error. */
export async function getQueuesList(): Promise<{ extension: string; queue_name: string }[]> {
  try {
    const rows = await query('SELECT extension, queue_name FROM queues ORDER BY queue_name');
    return rows
      .filter((r) => String(r.extension || '').trim().toLowerCase() !== 'default')
      .map((r) => ({ extension: r.extension, queue_name: r.queue_name }));
  } catch (e) {
    log.warning('⚠️  Database error get_queues_list: %s', e);
    return [];
  }
}

export interface SyncOptions {
  /** Delete rows not in the list (cascades to group_agents / group_queues). */
  prune?: boolean;
  /** With `prune`, let an EMPTY list delete everything. Off by default. */
  pruneAllWhenEmpty?: boolean;
}

/** A third argument of `true`/`false` is Python's positional `prune`. */
function syncOpts(opts: SyncOptions | boolean | undefined): Required<SyncOptions> {
  if (typeof opts === 'boolean') return { prune: opts, pruneAllWhenEmpty: false };
  return { prune: Boolean(opts?.prune), pruneAllWhenEmpty: Boolean(opts?.pruneAllWhenEmpty) };
}

/**
 * Upsert agents for the given PBX extensions (name from `nameMap`, else the extension).
 *
 * Pruning is opt-in (`prune`), as in OpDesk: only callers that hold the authoritative
 * extension list ask for it. An empty list never prunes unless `pruneAllWhenEmpty` is
 * also set, so a transient PBX-read failure cannot wipe every agent and, through the
 * cascade, every group's agent membership.
 */
export async function syncAgentsFromExtensions(
  extensionList: unknown[] | null | undefined,
  nameMap: Record<string, string> | null | undefined,
  opts?: SyncOptions | boolean,
): Promise<void> {
  const { prune, pruneAllWhenEmpty } = syncOpts(opts);
  const normalized = (extensionList || []).map((e) => pyStr(e).trim()).filter((e) => e);
  if (!normalized.length && !(prune && pruneAllWhenEmpty)) return;
  try {
    await withTransaction(async (conn) => {
      for (const ext of normalized) {
        const name = (nameMap || {})[ext] || ext;
        await execute('INSERT INTO agents (extension, name) VALUES (?, ?) ON DUPLICATE KEY UPDATE name = VALUES(name)', [ext, name], conn);
      }
      if (prune) {
        if (normalized.length) {
          await execute(`DELETE FROM agents WHERE extension NOT IN (${placeholders(normalized.length)})`, normalized, conn);
        } else if (pruneAllWhenEmpty) {
          await execute('DELETE FROM agents', [], conn);
        }
      }
    });
  } catch (e) {
    log.warning('⚠️  Database error sync_agents_from_extensions: %s', e);
  }
}

/**
 * Upsert queues by extension (name from `nameMap`, else the extension), skipping
 * 'default'. Same opt-in pruning and empty-list guard as syncAgentsFromExtensions;
 * pruning never deletes a 'default' row.
 */
export async function syncQueuesFromList(
  queueExtensions: unknown[] | null | undefined,
  nameMap: Record<string, string> | null | undefined = null,
  opts?: SyncOptions | boolean,
): Promise<void> {
  const { prune, pruneAllWhenEmpty } = syncOpts(opts);
  const normalized = (queueExtensions || [])
    .map((q) => (truthy(q) ? pyStr(q) : '').trim())
    .filter((q) => q && q.toLowerCase() !== 'default');
  if (!normalized.length && !(prune && pruneAllWhenEmpty)) return;
  try {
    await withTransaction(async (conn) => {
      for (const qext of normalized) {
        const name = (nameMap || {})[qext] || qext;
        await execute(
          'INSERT INTO queues (extension, queue_name) VALUES (?, ?) ON DUPLICATE KEY UPDATE queue_name = VALUES(queue_name)',
          [qext, name],
          conn,
        );
      }
      if (prune) {
        if (normalized.length) {
          await execute(
            `DELETE FROM queues WHERE extension NOT IN (${placeholders(normalized.length)}) AND LOWER(extension) <> 'default'`,
            normalized,
            conn,
          );
        } else if (pruneAllWhenEmpty) {
          await execute("DELETE FROM queues WHERE LOWER(extension) <> 'default'", [], conn);
        }
      }
    });
  } catch (e) {
    log.warning('⚠️  Database error sync_queues_from_list: %s', e);
  }
}

// ---------------------------------------------------------------------------
// Call supervision (one row per ChanSpy leg, keyed by the spy channel's linkedid)
// ---------------------------------------------------------------------------
// A supervisor's ChanSpy is its own call with its own linkedid, so the CDR records a
// separate call. This table links it to the monitored call, which lets the call log
// hide the spy row and the journey show LISTEN/WHISPER/BARGE on the monitored call.

const SUPERVISION_MODES = ['listen', 'whisper', 'barge'];

/** Record one supervision leg. Idempotent on spy_linkedid. An unknown mode becomes 'listen'. */
export async function recordSupervision(
  spyLinkedid: string,
  opts: {
    targetLinkedid?: string | null;
    targetExtension?: string | null;
    supervisorExtension?: string | null;
    mode?: string;
    spyUniqueid?: string | null;
  } = {},
): Promise<boolean> {
  if (!spyLinkedid) return false;
  const mode = opts.mode && SUPERVISION_MODES.includes(opts.mode) ? opts.mode : 'listen';
  try {
    await execute(
      `INSERT INTO call_supervision
           (spy_linkedid, spy_uniqueid, target_linkedid, target_extension, supervisor_extension, mode)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
           spy_uniqueid=VALUES(spy_uniqueid),
           target_linkedid=VALUES(target_linkedid),
           target_extension=VALUES(target_extension),
           supervisor_extension=VALUES(supervisor_extension),
           mode=VALUES(mode)`,
      [
        String(spyLinkedid),
        opts.spyUniqueid ?? null,
        opts.targetLinkedid ?? null,
        opts.targetExtension ?? null,
        opts.supervisorExtension ?? null,
        mode,
      ],
    );
    return true;
  } catch (e) {
    log.warning('⚠️  DB error recording supervision (%s): %s', spyLinkedid, e);
    return false;
  }
}

/**
 * Supervision rows whose spy_linkedid OR spy_uniqueid is in `keys`, keyed by BOTH
 * values, so a call-log row matches by either its linkedid or its uniqueid. {} on error.
 */
export async function getSupervisionBySpyKeys(keys: unknown[]): Promise<Record<string, Row>> {
  const ids = (keys || []).filter((x) => truthy(x)).map((x) => String(x));
  if (!ids.length) return {};
  const out: Record<string, Row> = {};
  try {
    const ph = placeholders(ids.length);
    const rows = await query(
      `SELECT spy_linkedid, spy_uniqueid, target_linkedid, target_extension, supervisor_extension, mode
       FROM call_supervision
       WHERE spy_linkedid IN (${ph}) OR spy_uniqueid IN (${ph})`,
      [...ids, ...ids],
    );
    for (const row of rows) {
      if (row.spy_linkedid) out[String(row.spy_linkedid)] = row;
      if (row.spy_uniqueid) out[String(row.spy_uniqueid)] = row;
    }
  } catch (e) {
    log.warning('⚠️  DB error fetching call_supervision by spy keys: %s', e);
  }
  return out;
}

/**
 * Every supervision row of one monitored call (by target_linkedid), oldest first:
 * {spy_linkedid, target_linkedid, target_extension, supervisor_extension, mode,
 * created_at}. Feeds the LISTEN/WHISPER/BARGE events of that call's journey. [] on error.
 */
export async function getSupervisionForTarget(targetLinkedid: string | null | undefined): Promise<Row[]> {
  if (!targetLinkedid) return [];
  try {
    return await query(
      `SELECT spy_linkedid, target_linkedid, target_extension, supervisor_extension, mode, created_at
       FROM call_supervision
       WHERE target_linkedid = ?
       ORDER BY created_at ASC, id ASC`,
      [String(targetLinkedid)],
    );
  } catch (e) {
    log.warning('⚠️  DB error fetching call_supervision for target: %s', e);
    return [];
  }
}

/**
 * Bulk getSupervisionForTarget for a page of call-log rows: {target_linkedid: [rows]},
 * so the call log can mark supervised calls (supervision_count) in one query.
 */
export async function getSupervisionTargets(targetLinkedids: unknown[]): Promise<Record<string, Row[]>> {
  const ids = (targetLinkedids || []).filter((x) => truthy(x)).map((x) => String(x));
  if (!ids.length) return {};
  const out: Record<string, Row[]> = {};
  try {
    const rows = await query(
      `SELECT spy_linkedid, target_linkedid, target_extension, supervisor_extension, mode, created_at
       FROM call_supervision
       WHERE target_linkedid IN (${placeholders(ids.length)})
       ORDER BY created_at ASC, id ASC`,
      ids,
    );
    for (const row of rows) (out[String(row.target_linkedid)] ??= []).push(row);
  } catch (e) {
    log.warning('⚠️  DB error fetching call_supervision targets: %s', e);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Not-Ready reason catalog (pause_reasons)
// ---------------------------------------------------------------------------
// Admin-managed codes an agent picks when going Not-Ready. `productive` splits paid work
// (meeting, training) from breaks for adherence. System rows (is_system=1, code prefix
// "__") are used by the backend itself -- __WRAPUP marks after-call work -- and are never
// offered to agents, edited or deleted through the API.

/** The system reason the backend pauses an agent with during after-call work. */
export const WRAPUP_REASON_CODE = '__WRAPUP';

/** Seeded once into an empty catalog: [code, label, productive, color, sort_order, is_system]. */
export const DEFAULT_PAUSE_REASONS: readonly [string, string, number, string, number, number][] = [
  ['break', 'Break', 0, '#d29922', 10, 0],
  ['lunch', 'Lunch', 0, '#f85149', 20, 0],
  ['meeting', 'Meeting', 1, '#58a6ff', 30, 0],
  ['training', 'Training', 1, '#3fb950', 40, 0],
];

/** System rows, seeded idempotently (INSERT IGNORE) on every start. */
export const SYSTEM_PAUSE_REASONS: readonly [string, string, number, string, number, number][] = [
  [WRAPUP_REASON_CODE, 'Wrap-up', 1, '#10b981', 900, 1],
];

const COLS_PAUSE_REASONS = 'id, code, label, productive, color, sort_order, is_active, is_system';

/**
 * Reasons by sort_order, label. `activeOnly` hides disabled codes; `includeSystem`
 * (default true, as Python's) false hides system codes. [] on error.
 */
export async function pauseReasonList(opts: { activeOnly?: boolean | null; includeSystem?: boolean | null } = {}): Promise<Row[]> {
  const conds: string[] = [];
  if (opts.activeOnly) conds.push('is_active = 1');
  if (opts.includeSystem === false) conds.push('is_system = 0');
  const where = conds.length ? ' WHERE ' + conds.join(' AND ') : '';
  try {
    return await query(`SELECT ${COLS_PAUSE_REASONS} FROM pause_reasons${where} ORDER BY sort_order, label`);
  } catch (e) {
    log.warning('⚠️  Database error pause_reason_list: %s', e);
    return [];
  }
}

/** One reason by code, or null. */
export async function pauseReasonGet(code: string | null | undefined): Promise<Row | null> {
  if (!code) return null;
  try {
    return await queryOne(`SELECT ${COLS_PAUSE_REASONS} FROM pause_reasons WHERE code = ?`, [code]);
  } catch (e) {
    log.warning('⚠️  Database error pause_reason_get: %s', e);
    return null;
  }
}

/**
 * The catalog row for a Not-Ready request, or null when the code is empty, unknown,
 * inactive, or a system code. An agent may only go Not-Ready with a code the picker
 * offers; anything else must be refused ("A valid Not-Ready reason is required"), or
 * adherence reports time under a code nobody can name.
 */
export async function pauseReasonForNotReady(code: unknown): Promise<Row | null> {
  const c = strOrEmptyStripped(code);
  if (!c) return null;
  const row = await pauseReasonGet(c);
  if (!row || !truthy(row.is_active) || truthy(row.is_system)) return null;
  return row;
}

/** True when `code` may be used to go Not-Ready (see pauseReasonForNotReady). */
export async function isValidNotReadyReason(code: unknown): Promise<boolean> {
  return (await pauseReasonForNotReady(code)) !== null;
}

/**
 * Create a (non-system) reason. The new id, or null for a missing code/label, a
 * duplicate code, or a DB error. Takes Python's positional form
 * (code, label, productive, color, sortOrder, isActive) or one fields object
 * ({code, label, productive, color, sort_order, is_active}).
 */
/**
 * A sort order from a request: missing or blank -> the default 100, an integer (0
 * included) as given, anything else null (refused). `int(x or 100)` turned an explicit 0
 * into 100, so a code meant to sort first sorted after the seeded 10-40 codes.
 */
function sortOrderValue(raw: unknown): number | null {
  if (raw === null || raw === undefined || (typeof raw === 'string' && !raw.trim())) return 100;
  return pyInt(raw);
}

export async function pauseReasonCreate(
  codeOrFields: string | Record<string, unknown>,
  label?: string | null,
  productive: unknown = false,
  color: string | null = null,
  sortOrder: unknown = 100,
  isActive: unknown = true,
): Promise<number | null> {
  let code: unknown = codeOrFields;
  if (codeOrFields !== null && typeof codeOrFields === 'object') {
    const f = codeOrFields;
    code = f.code;
    label = (f.label as string | null | undefined) ?? null;
    productive = f.productive ?? false;
    color = (f.color as string | null | undefined) ?? null;
    sortOrder = f.sort_order ?? 100;
    isActive = f.is_active ?? true;
  }
  const c = strOrEmptyStripped(code);
  const l = strOrEmptyStripped(label);
  if (!c || !l) return null;
  // A non-integer is refused rather than raised.
  const order = sortOrderValue(sortOrder);
  if (order === null) return null;
  try {
    const res = await execute(
      'INSERT INTO pause_reasons (code, label, productive, color, sort_order, is_active, is_system) VALUES (?, ?, ?, ?, ?, ?, 0)',
      [c, l, truthy(productive) ? 1 : 0, color || null, order, truthy(isActive) ? 1 : 0],
    );
    return res.insertId;
  } catch (e) {
    log.warning('⚠️  Database error pause_reason_create: %s', e);
    return null;
  }
}

/**
 * Update a reason's mutable fields (label, productive, color, sort_order, is_active;
 * code and is_system are immutable). False when no allowed field is given, the id does
 * not exist, the row is a system reason, or on error; true otherwise (also when nothing
 * actually changed).
 */
export async function pauseReasonUpdate(reasonId: number, fields: Record<string, unknown> | null | undefined): Promise<boolean> {
  if (!reasonId || !fields) return false;
  const allowed = new Set(['label', 'productive', 'color', 'sort_order', 'is_active']);
  const sets: string[] = [];
  const params: SqlValue[] = [];
  for (const [key, raw] of Object.entries(fields)) {
    if (!allowed.has(key)) continue;
    let val: SqlValue;
    if (key === 'productive' || key === 'is_active') val = truthy(raw) ? 1 : 0;
    else if (key === 'sort_order') {
      const n = sortOrderValue(raw);
      if (n === null) return false;
      val = n;
    } else val = raw as SqlValue;
    sets.push(`${key} = ?`);
    params.push(val);
  }
  if (!sets.length) return false;
  try {
    return await withTransaction(async (conn: PoolConnection) => {
      const row = await queryOne('SELECT is_system FROM pause_reasons WHERE id = ? FOR UPDATE', [reasonId], conn);
      if (!row || truthy(row.is_system)) return false;
      await execute(`UPDATE pause_reasons SET ${sets.join(', ')} WHERE id = ? AND is_system = 0`, [...params, reasonId], conn);
      return true;
    });
  } catch (e) {
    log.warning('⚠️  Database error pause_reason_update: %s', e);
    return false;
  }
}

/** Delete a non-system reason. True when a row was removed. */
export async function pauseReasonDelete(reasonId: number): Promise<boolean> {
  if (!reasonId) return false;
  try {
    return (await execute('DELETE FROM pause_reasons WHERE id = ? AND is_system = 0', [reasonId])).affectedRows > 0;
  } catch (e) {
    log.warning('⚠️  Database error pause_reason_delete: %s', e);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Agent presence segments (agent_activity)
// ---------------------------------------------------------------------------
// Append-only presence log behind Agent Adherence. ended_at IS NULL marks an agent's
// open segment. state is one of ready / not_ready / on_call / wrap_up / dnd (a varchar,
// so new states need no migration); sessions, break and DND totals are derived from the
// segments by the analytics service, not stored.

const COLS_AGENT_ACTIVITY = 'id, agent_ext, state, reason_code, queue, linkedid, started_at, ended_at, duration_secs, source';

/**
 * Close the agent's open segment and, unless `newState` is null (logged out), open a
 * new one -- in one transaction, so a transition is never half-applied. The new
 * segment's id, or null on logout or error.
 */
export async function agentActivityTransition(
  agentExt: unknown,
  newState: string | null | undefined,
  opts: { reasonCode?: string | null; queue?: string | null; linkedid?: string | null; source?: string } = {},
): Promise<number | null> {
  const ext = strOrEmptyStripped(agentExt);
  if (!ext) return null;
  try {
    return await withTransaction(async (conn) => {
      await execute(
        'UPDATE agent_activity SET ended_at = NOW(), duration_secs = TIMESTAMPDIFF(SECOND, started_at, NOW()) ' +
          'WHERE agent_ext = ? AND ended_at IS NULL',
        [ext],
        conn,
      );
      if (newState === null || newState === undefined) return null;
      const res = await execute(
        'INSERT INTO agent_activity (agent_ext, state, reason_code, queue, linkedid, source) VALUES (?, ?, ?, ?, ?, ?)',
        [ext, newState, opts.reasonCode ?? null, opts.queue ?? null, opts.linkedid ?? null, opts.source ?? 'ui'],
        conn,
      );
      return res.insertId;
    });
  } catch (e) {
    log.warning('⚠️  Database error agent_activity_transition(%s, %s): %s', ext, newState ?? null, e);
    return null;
  }
}

/** The agent's open segment (ended_at IS NULL), or null. */
export async function agentActivityOpen(agentExt: unknown): Promise<Row | null> {
  const ext = strOrEmptyStripped(agentExt);
  if (!ext) return null;
  try {
    return await queryOne(
      `SELECT ${COLS_AGENT_ACTIVITY} FROM agent_activity WHERE agent_ext = ? AND ended_at IS NULL ORDER BY started_at DESC, id DESC LIMIT 1`,
      [ext],
    );
  } catch (e) {
    log.warning('agent_activity_open(%s): %s', ext, e);
    return null;
  }
}

/**
 * Close every open segment. Run at startup before presence is rebuilt from live queue
 * state, so a segment left open by a previous process is clamped to now instead of
 * counting the time the backend was down. Rows affected. (`source` is accepted and
 * unused, as in Python.)
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function agentActivityCloseAllOpen(source = 'system'): Promise<number> {
  try {
    return (
      await execute(
        'UPDATE agent_activity SET ended_at = NOW(), duration_secs = TIMESTAMPDIFF(SECOND, started_at, NOW()) WHERE ended_at IS NULL',
      )
    ).affectedRows;
  } catch (e) {
    log.warning('⚠️  Database error agent_activity_close_all_open: %s', e);
    return 0;
  }
}
