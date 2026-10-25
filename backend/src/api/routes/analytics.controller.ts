/**
 * Analytics: KPIs, performance reports (+ one agent's calls), adherence (+ per-agent
 * timeline), heatmap, trend, drilldown, exports, and the SLA / FCR settings.
 *
 * Every report is behind {scope: 'analytics:read'} (an API key holding the scope, or any
 * signed-in user) and then narrowed by role in core/scope.analyticsScope(): agents are
 * refused ("Agents do not have access to analytics" — not even their own adherence trace,
 * the report compares colleagues), supervisors see their groups' queues and agents, admins
 * and API keys see everything.
 * Report routes answer bare JSON (OpDesk's legacy shape); exports are file downloads.
 *
 * Port of the /api/analytics/* routes of backend/server.py.
 */

import { Readable } from 'stream';
import { Controller, Req } from '@nestjs/common';
import type { Request } from 'express';
import ExcelJS from 'exceljs';
import { getLogger, pyStr } from '../../core/logger';
import { dateIso, truthy } from '../../core/py';
import { analyticsScope } from '../../core/scope';
import * as dbm from '../../db/db-manager';
import type { Row } from '../../db/pool';
import * as analyticsModule from '../../services/analytics';
import { HttpError } from '../http-error';
import { csvResponse, spreadsheetSafe, StreamResponse } from '../respond';
import { Auth, Get, Post, principal } from '../routing';
import { JsonObject, parseBody, qBool, qInt, qStr, QueryParams, REQUIRED, v } from '../validation';

const log = getLogger('api.routes.analytics');

// ---------------------------------------------------------------------------
// Scope and handler plumbing
// ---------------------------------------------------------------------------

/**
 * The try/except every report handler wraps itself in: an HttpError passes through,
 * anything else is logged and answered with a bare 500 (whose text never reaches the
 * client: the error renderer replaces it with the safe message).
 */
async function guarded<T>(what: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof HttpError) throw e;
    log.error('%s error: %s', what, e);
    throw new HttpError(500, 'Internal server error');
  }
}

/** Optional[str] = None date parameters shared by every report. */
function dateRange(req: Request): [string | null, string | null] {
  const q = req.query as QueryParams;
  return [qStr(q, 'date_from', null), qStr(q, 'date_to', null)];
}

/** dict.get(k, default): a present None stays None. */
function get(obj: Row, key: string, fallback: unknown): unknown {
  return Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : fallback;
}

// ---------------------------------------------------------------------------
// File helpers
// ---------------------------------------------------------------------------

const p2 = (n: number) => String(n).padStart(2, '0');

/** strftime('%Y-%m-%d %H:%M:%S') */
function stampSeconds(d: Date): string {
  return `${dateIso(d)} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
}

/** strftime('%Y%m%d-%H%M%S') */
function stampFile(d: Date): string {
  return `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
}

/**
 * Seconds -> HH:MM:SS, zero-padded like the on-screen report, so a column of them sorts and
 * lines up. Hours are not wrapped at 24. Blank on bad input; negative -> 0.
 */
export function fmtHms(secs: unknown): string {
  const raw = truthy(secs) ? secs : 0;
  let s: number;
  if (typeof raw === 'number' && Number.isFinite(raw)) s = Math.trunc(raw);
  else if (typeof raw === 'boolean') s = raw ? 1 : 0;
  else if (typeof raw === 'string' && /^\s*[+-]?\d+\s*$/.test(raw)) s = parseInt(raw, 10);
  else return '';
  if (s < 0) s = 0;
  const h = Math.floor(s / 3600);
  const rem = s % 3600;
  return `${p2(h)}:${p2(Math.floor(rem / 60))}:${p2(rem % 60)}`;
}

/** str() of a value Python held as a float: a whole number still prints as '85.0'. */
function floatStr(val: unknown): unknown {
  return typeof val === 'number' && Number.isInteger(val) ? `${val}.0` : val;
}

/** str(v) of a CSV cell, as the Python wrote it (None -> 'None'), never a live formula. */
function cellStr(val: unknown): string {
  if (val instanceof Date) return stampSeconds(val);
  return typeof val === 'string' ? spreadsheetSafe(val) : pyStr(val);
}

const quoted = (vals: string[]): string => vals.map((s) => `"${s.replace(/"/g, '""')}"`).join(',') + '\r\n';

const BOM = '\ufeff';
const CSV_MEDIA_TYPE = 'text/csv; charset=utf-8';
const XLSX_MEDIA_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** A worksheet value as openpyxl wrote it: None -> an empty cell. Text never reads as a formula. */
function xlsxCell(val: unknown): ExcelJS.CellValue {
  if (val === null || val === undefined) return null;
  if (typeof val === 'string') return spreadsheetSafe(val);
  if (typeof val === 'number' || typeof val === 'boolean' || val instanceof Date) return val;
  return spreadsheetSafe(pyStr(val));
}

async function xlsxBuffer(sheetTitle: string, rows: unknown[][]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheetTitle);
  // openpyxl's ws.append([]) still advances a row; addRow([]) does the same here.
  for (const r of rows) ws.addRow(r.map(xlsxCell));
  return Buffer.from(await wb.xlsx.writeBuffer());
}

function download(body: Buffer | string, contentType: string, filename: string, headers: Record<string, string> = {}): StreamResponse {
  const buf = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
  return new StreamResponse(Readable.from([buf]), {
    contentType,
    headers: { 'Content-Disposition': `attachment; filename="${filename}"`, ...headers },
  });
}

/** The most rows one drilldown export writes; past it the file says it was cut. */
export const DRILLDOWN_EXPORT_CAP = 100000;

/** A drilldown call's direction as the Call History export words it. */
const DIRECTION_LABEL: Record<string, string> = { IN: 'Inbound', OUT: 'Outbound', INTERNAL: 'Internal' };

/**
 * A whole number inside the setting's range (analyticsModule.SETTING_RANGES), or a 400 that
 * names the field. Accepts a JSON number or a string of digits; anything else is refused.
 */
export function settingInt(field: string, value: unknown, range: readonly [number, number]): number {
  const n = typeof value === 'number'
    ? value
    : typeof value === 'string' && /^\s*-?\d+\s*$/.test(value) ? parseInt(value, 10) : NaN;
  const [lo, hi] = range;
  if (!Number.isInteger(n) || n < lo || n > hi) {
    throw new HttpError(400, `${field} must be a whole number from ${lo} to ${hi}`);
  }
  return n;
}

// ---------------------------------------------------------------------------
// Report exports: the JSON of a report as a table
// ---------------------------------------------------------------------------

/** The reports GET /api/analytics/export/{report} serves, each the JSON route of that name. */
export const EXPORT_REPORTS = ['overview', 'queues', 'agents', 'heatmap', 'trend'] as const;
export type ExportReport = (typeof EXPORT_REPORTS)[number];

const SHEET_TITLES: Record<ExportReport, string> = {
  overview: 'Overview', queues: 'Queue Performance', agents: 'Agent Performance', heatmap: 'Heatmap', trend: 'Trend',
};

const QUEUE_COLUMNS = [
  'queue_extension', 'queue_name', 'total_calls', 'answered_calls', 'abandoned_calls',
  'sla_pct', 'aht_secs', 'avg_wait_secs', 'peak_hour', 'answer_rate', 'talk_secs', 'missed_calls',
  'abandonment_rate', 'short_abandon_rate',
];
const AGENT_COLUMNS = [
  'rank', 'agent_extension', 'agent_name', 'total_calls', 'answered_calls', 'inbound_calls',
  'outbound_calls', 'internal_calls', 'aht_secs', 'sla_contribution_pct', 'answer_rate', 'talk_secs', 'missed_calls',
];
const TREND_COLUMNS = [
  'date', 'total_calls', 'answered_calls', 'abandoned_calls', 'outbound_total', 'outbound_answered',
  'internal_total', 'customers', 'customers_answered',
];

/** Flatten a KPI block into [dotted key, value] pairs: outbound.answer_rate etc. */
function flatten(obj: Row, prefix = ''): [string, unknown][] {
  const out: [string, unknown][] = [];
  for (const [k, val] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (val !== null && typeof val === 'object' && !Array.isArray(val) && !(val instanceof Date)) out.push(...flatten(val as Row, key));
    else out.push([key, val]);
  }
  return out;
}

/**
 * A report's JSON as [header, ...rows]: the columns are the JSON keys, so a column means
 * exactly what the same key means in the API, in every UI language.
 *
 *   overview  metric | current | prev_period, one row per KPI (nested blocks dotted:
 *             outbound.total_calls), led by the two periods' bounds.
 *   queues    one row per queue (the per-day and wait-bucket series stay JSON-only).
 *   agents    one row per agent; daily_trend spreads over one column per day.
 *   heatmap   series | day | 00:00 .. 23:00 (series = matrix or abandoned_matrix).
 *   trend     one row per day.
 */
export function reportTable(report: ExportReport, data: Row, dateTo: string | null = null): unknown[][] {
  switch (report) {
    case 'overview': {
      const period = (data.period ?? {}) as Row;
      // No previous period past the comparable range: its bounds are blank, like its figures.
      const prev = period.from && period.to && data.prev_period
        ? analyticsModule.previousPeriod(period.from, period.to) : [null, null];
      const current = flatten((data.current ?? {}) as Row);
      const previous = new Map(flatten((data.prev_period ?? {}) as Row));
      return [
        ['metric', 'current', 'prev_period'],
        ['period.from', period.from ?? null, prev[0]],
        ['period.to', period.to ?? null, prev[1]],
        ...current.map(([k, val]) => [k, val, previous.has(k) ? previous.get(k) : null]),
      ];
    }
    case 'queues':
      return [QUEUE_COLUMNS, ...((data.queues ?? []) as Row[]).map((q) => QUEUE_COLUMNS.map((c) => q[c] ?? null))];
    case 'agents': {
      // daily_trend is the last 7 days of the period, oldest first.
      const end = analyticsModule.defaultDates(null, dateTo)[1];
      const days = [6, 5, 4, 3, 2, 1, 0].map((i) => analyticsModule.addDaysYmd(end, -i));
      return [
        [...AGENT_COLUMNS, ...days.map((d) => `daily_trend ${d}`)],
        ...((data.agents ?? []) as Row[]).map((a) => [
          ...AGENT_COLUMNS.map((c) => a[c] ?? null),
          ...days.map((_, i) => (Array.isArray(a.daily_trend) ? a.daily_trend[i] ?? null : null)),
        ]),
      ];
    }
    case 'heatmap': {
      const labels = (data.labels ?? {}) as Row;
      const dayLabels = (labels.days ?? analyticsModule.HEATMAP_DAYS) as string[];
      const hours = (labels.hours ?? analyticsModule.HEATMAP_HOURS) as string[];
      const rows: unknown[][] = [['series', 'day', ...hours]];
      for (const series of ['matrix', 'abandoned_matrix']) {
        ((data[series] ?? []) as number[][]).forEach((row, i) => rows.push([series, dayLabels[i] ?? String(i), ...row]));
      }
      return rows;
    }
    case 'trend':
      return [TREND_COLUMNS, ...((data.trend ?? []) as Row[]).map((d) => TREND_COLUMNS.map((c) => d[c] ?? null))];
  }
}

@Controller()
export class AnalyticsController {
  // -------------------------------------------------------------------------
  // Report builders, shared by the JSON routes and GET /api/analytics/export/{report}
  // -------------------------------------------------------------------------

  private async overview(req: Request): Promise<Row> {
    const [dateFrom, dateTo] = dateRange(req);
    const [allowedQueues, allowedAgents] = analyticsScope(principal(req));
    const thresholds = await analyticsModule.getSlaThresholds();
    const fcrCfg = await analyticsModule.getFcrSettings();
    return analyticsModule.computeExecutiveKpis(dateFrom, dateTo, {
      allowedQueues, allowedAgents, slaThresholds: thresholds, fcrCfg,
    });
  }

  private async queues(req: Request): Promise<Row> {
    const [dateFrom, dateTo] = dateRange(req);
    const [allowedQueues] = analyticsScope(principal(req));
    const thresholds = await analyticsModule.getSlaThresholds();
    const fcrCfg = await analyticsModule.getFcrSettings();
    return {
      queues: await analyticsModule.computeQueuePerformance(dateFrom, dateTo, {
        allowedQueues, slaThresholds: thresholds, fcrCfg,
      }),
      // The threshold the short-abandon rate was counted against, for its explanation.
      short_abandon_secs: get(fcrCfg, 'short_abandon_secs', analyticsModule.FCR_DEFAULTS.short_abandon_secs),
    };
  }

  private async agents(req: Request): Promise<Row> {
    const [dateFrom, dateTo] = dateRange(req);
    const [, allowedAgents] = analyticsScope(principal(req));
    const thresholds = await analyticsModule.getSlaThresholds();
    return {
      agents: await analyticsModule.computeAgentPerformance(dateFrom, dateTo, { allowedAgents, slaThresholds: thresholds }),
    };
  }

  private async heatmap(req: Request): Promise<Row> {
    const [dateFrom, dateTo] = dateRange(req);
    const [allowedQueues] = analyticsScope(principal(req));
    // ?queue= narrows to one queue, never past the caller's scope: a queue outside it reads
    // as an empty heatmap, not as someone else's traffic.
    const queue = (qStr(req.query as QueryParams, 'queue', null) ?? '').trim();
    const scope = !queue
      ? allowedQueues
      : allowedQueues === null || allowedQueues.map(String).includes(queue) ? [queue] : [];
    return analyticsModule.computeHourlyHeatmap(dateFrom, dateTo, scope);
  }

  private async trend(req: Request): Promise<Row> {
    const [dateFrom, dateTo] = dateRange(req);
    const [allowedQueues, allowedAgents] = analyticsScope(principal(req));
    return analyticsModule.computeVolumeSeries(dateFrom, dateTo, allowedQueues, allowedAgents);
  }

  // -------------------------------------------------------------------------
  // Reports
  // -------------------------------------------------------------------------

  /**
   * Executive KPI overview: SLA%, FCR%, abandonment, AHT, answer/contact rates, volume,
   * with the previous period of the same length for deltas. Roles: admin, supervisor.
   */
  @Get('/api/analytics/overview')
  @Auth({ scope: 'analytics:read' })
  async analyticsOverview(@Req() req: Request) {
    return guarded('analytics overview', () => this.overview(req));
  }

  /** Per-queue KPI table. Roles: admin, supervisor. */
  @Get('/api/analytics/queue-performance')
  @Auth({ scope: 'analytics:read' })
  async analyticsQueuePerformance(@Req() req: Request) {
    return guarded('analytics queue performance', () => this.queues(req));
  }

  /** Per-agent KPI table with 7-day trend. Roles: admin, supervisor. */
  @Get('/api/analytics/agent-performance')
  @Auth({ scope: 'analytics:read' })
  async analyticsAgentPerformance(@Req() req: Request) {
    return guarded('analytics agent performance', () => this.agents(req));
  }

  /**
   * One agent's calls for the period, split by direction, with the paginated call list
   * behind it (`direction`, `status` filters). Backs the Agent Performance row click.
   * Scope-checked on the same allowed_agents list as the table, so a supervisor cannot open
   * an agent whose row they are not allowed to see. Roles: admin, supervisor.
   */
  @Get('/api/analytics/agent-calls')
  @Auth({ scope: 'analytics:read' })
  async analyticsAgentCalls(@Req() req: Request) {
    const q = req.query as QueryParams;
    const agent = qStr(q, 'agent', REQUIRED) as string;
    const direction = qStr(q, 'direction', null);
    const status = qStr(q, 'status', null);
    const page = qInt(q, 'page', 1);
    const pageSize = qInt(q, 'page_size', 50);
    const [dateFrom, dateTo] = dateRange(req);
    return guarded('analytics agent calls', async () => {
      const [, allowedAgents] = analyticsScope(principal(req));
      const ext = String(agent || '').trim();
      if (!/^\d+$/.test(ext)) throw new HttpError(400, 'agent must be an extension');
      if (allowedAgents !== null && !new Set(allowedAgents.map(String)).has(ext)) {
        throw new HttpError(403, 'Agent is outside your scope');
      }
      if (direction && !(analyticsModule.AGENT_CALL_DIRECTIONS as readonly string[]).includes(direction.toUpperCase())) {
        throw new HttpError(400, 'Unknown direction');
      }
      return analyticsModule.computeAgentCalls(ext, dateFrom, dateTo, {
        direction,
        status,
        page: Math.max(1, page),
        pageSize: Math.min(200, Math.max(1, pageSize)),
      });
    });
  }

  /**
   * Agent Adherence: Login / Logout / Sessions / Logged In / Ready / On Call / Wrap-up /
   * Break / Not Ready / DND / Occupancy per agent for the selected period, from
   * agent_activity presence segments. Scope-filtered. Roles: admin, supervisor.
   */
  @Get('/api/analytics/agent-adherence')
  @Auth({ scope: 'analytics:read' })
  async analyticsAgentAdherence(@Req() req: Request) {
    const [dateFrom, dateTo] = dateRange(req);
    return guarded('analytics agent adherence', async () => {
      const [, allowedAgents] = analyticsScope(principal(req));
      return analyticsModule.computeAgentAdherence(dateFrom, dateTo, allowedAgents);
    });
  }

  /**
   * One agent's state-change trace for the period: every login session and, inside it,
   * every move (Ready / On Call / Wrap-up / Not Ready with its reason / DND) with when it
   * happened and how long it held. Backs the Agent Adherence row click.
   *
   * Scope-checked on the SAME allowed_agents list as the summary, so a supervisor cannot
   * open a trace for an agent whose row they are not allowed to see.
   */
  @Get('/api/analytics/agent-adherence/timeline')
  @Auth({ scope: 'analytics:read' })
  async analyticsAgentTimeline(@Req() req: Request) {
    const agent = qStr(req.query as QueryParams, 'agent', REQUIRED) as string;
    const [dateFrom, dateTo] = dateRange(req);
    return guarded('analytics agent timeline', async () => {
      const [, allowedAgents] = analyticsScope(principal(req));
      const ext = String(agent || '').trim();
      if (!ext) throw new HttpError(400, 'agent is required');
      if (allowedAgents !== null && !new Set(allowedAgents.map(String)).has(ext)) {
        throw new HttpError(403, 'Agent is outside your scope');
      }
      return analyticsModule.computeAgentTimeline(ext, dateFrom, dateTo);
    });
  }

  /**
   * Export the Agent Adherence report as CSV or XLSX. Roles: admin, supervisor.
   *
   * Columns mirror the on-screen report plus a per-agent Not-Ready breakdown, and a
   * server-side 'Generated at' stamp (in the filename and a header line).
   */
  @Get('/api/analytics/agent-adherence/export')
  @Auth({ scope: 'analytics:read' })
  async analyticsAgentAdherenceExport(@Req() req: Request) {
    const format = qStr(req.query as QueryParams, 'format', 'csv');
    const [dateFrom, dateTo] = dateRange(req);
    return guarded('agent adherence export', async () => {
      const [, allowedAgents] = analyticsScope(principal(req));
      const result = await analyticsModule.computeAgentAdherence(dateFrom, dateTo, allowedAgents);
      const agents = get(result, 'agents', []) as Row[];

      const generatedAt = new Date();
      const genStamp = stampSeconds(generatedAt);
      const dateLabel = `${dateFrom || 'all'}_${dateTo || 'all'}`;
      const filenameBase = `agent_adherence_${dateLabel}_${stampFile(generatedAt)}`;

      const headersRow = [
        'Agent', 'Name', 'Login', 'Logout', 'Still Logged In', 'Sessions',
        'Logged In', 'Ready', 'On Call', 'Wrap-up', 'Break', 'Not Ready', 'DND',
        'Occupancy %', 'Not Ready Breakdown',
      ];

      const rowValues = (a: Row, forCsv: boolean): unknown[] => {
        const breakdown = (get(a, 'not_ready_breakdown', []) as Row[])
          .map((b) => `${pyStr(get(b, 'label', b.code ?? null))}: ${fmtHms(b.secs ?? null)}`)
          .join('; ');
        const occupancy = get(a, 'occupancy_pct', 0);
        return [
          get(a, 'agent', ''),
          get(a, 'name', ''),
          truthy(a.login) ? a.login : '',
          truthy(a.logged_in) ? '' : truthy(a.logout) ? a.logout : '',
          truthy(a.logged_in) ? 'Yes' : 'No',
          get(a, 'sessions', 0),
          fmtHms(a.logged_in_secs ?? null),
          fmtHms(a.ready_secs ?? null),
          fmtHms(a.on_call_secs ?? null),
          fmtHms(a.wrap_secs ?? null),
          fmtHms(a.break_secs ?? null),
          fmtHms(a.not_ready_secs ?? null),
          fmtHms(a.dnd_secs ?? null),
          // A Python float: str(85.0) is '85.0' in the CSV; the spreadsheet keeps the number.
          forCsv ? floatStr(occupancy) : occupancy,
          breakdown,
        ];
      };

      if (format.toLowerCase() === 'xlsx') {
        const rows: unknown[][] = [
          [`Generated at: ${genStamp}`],
          [`Period: ${dateFrom || 'all'} to ${dateTo || 'all'}`],
          [],
          headersRow,
          ...agents.map((a) => rowValues(a, false)),
        ];
        return download(await xlsxBuffer('Agent Adherence', rows), XLSX_MEDIA_TYPE, `${filenameBase}.xlsx`);
      }
      // CSV with UTF-8 BOM for Excel compatibility: the stamp lines, a blank line, then the
      // quoted header and rows.
      return csvResponse(`${filenameBase}.csv`, headersRow, agents.map((a) => rowValues(a, true)), {
        preamble: [`Generated at: ${genStamp}`, `Period: ${dateFrom || 'all'} to ${dateTo || 'all'}`],
      });
    });
  }

  /** 7x24 call volume heatmap matrix; `queue` narrows it to one queue in scope. Roles: admin, supervisor. */
  @Get('/api/analytics/heatmap')
  @Auth({ scope: 'analytics:read' })
  async analyticsHeatmap(@Req() req: Request) {
    return guarded('analytics heatmap', () => this.heatmap(req));
  }

  /** Daily volume trend (inbound, outbound, internal) and calls by hour of day. Roles: admin, supervisor. */
  @Get('/api/analytics/trend')
  @Auth({ scope: 'analytics:read' })
  async analyticsTrend(@Req() req: Request) {
    return guarded('analytics trend', () => this.trend(req));
  }

  /**
   * Paginated drilldown with analytics fields (wait_secs, sla_met). `disposition` names a
   * call status (raw CDR spellings accepted); `facets=1` adds per-value counts for the
   * Direction and Status filters. Roles: admin, supervisor.
   */
  @Get('/api/analytics/drilldown')
  @Auth({ scope: 'analytics:read' })
  async analyticsDrilldown(@Req() req: Request) {
    const q = req.query as QueryParams;
    const [dateFrom, dateTo] = dateRange(req);
    const queue = qStr(q, 'queue', null);
    const agent = qStr(q, 'agent', null);
    const direction = qStr(q, 'direction', null);
    const disposition = qStr(q, 'disposition', null);
    const page = qInt(q, 'page', 1);
    const pageSize = qInt(q, 'page_size', 50);
    const facets = qBool(q, 'facets', false);
    return guarded('analytics drilldown', async () => {
      const [allowedQueues, allowedAgents] = analyticsScope(principal(req));
      const thresholds = await analyticsModule.getSlaThresholds();
      return analyticsModule.computeDrilldown(dateFrom, dateTo, {
        queueExt: queue,
        agentExt: agent,
        direction,
        dispositionFilter: disposition,
        page: Math.max(1, page),
        pageSize: Math.min(200, Math.max(1, pageSize)),
        allowedQueues,
        allowedAgents,
        slaThresholds: thresholds,
        facets,
      });
    });
  }

  /**
   * Export drilldown data as CSV or XLSX: the status the table shows and the direction
   * beside it. Capped at DRILLDOWN_EXPORT_CAP rows; a cut file ends with a line saying so
   * and carries `X-Export-Truncated: <total>`. Roles: admin, supervisor.
   */
  @Get('/api/analytics/export')
  @Auth({ scope: 'analytics:read' })
  async analyticsExport(@Req() req: Request) {
    const q = req.query as QueryParams;
    const format = qStr(q, 'format', 'csv');
    const [dateFrom, dateTo] = dateRange(req);
    const queue = qStr(q, 'queue', null);
    const agent = qStr(q, 'agent', null);
    const direction = qStr(q, 'direction', null);
    const disposition = qStr(q, 'disposition', null);
    return guarded('analytics export', async () => {
      const [allowedQueues, allowedAgents] = analyticsScope(principal(req));
      const thresholds = await analyticsModule.getSlaThresholds();
      const result = await analyticsModule.computeDrilldown(dateFrom, dateTo, {
        queueExt: queue,
        agentExt: agent,
        direction,
        dispositionFilter: disposition,
        page: 1,
        pageSize: DRILLDOWN_EXPORT_CAP,
        allowedQueues,
        allowedAgents,
        slaThresholds: thresholds,
      });
      const calls = get(result, 'calls', []) as Row[];
      const total = Number(get(result, 'total', calls.length)) || calls.length;
      const truncated = total > calls.length;
      const extraHeaders: Record<string, string> = truncated ? { 'X-Export-Truncated': String(total) } : {};
      const note = truncated ? [`Truncated: the first ${calls.length} of ${total} calls (narrow the range or filters for the rest)`] : null;
      const dateLabel = `${dateFrom || 'all'}_${dateTo || 'all'}`;

      const headersRow = ['Date', 'Direction', 'Src', 'Queue', 'Agent', 'Duration(s)', 'Talk(s)', 'Wait(s)', 'Status', 'SLA Met'];
      // SLA Met only where the SLA applies -- an answered queue call -- as the table shows it.
      const rowValues = (r: Row): unknown[] => [
        get(r, 'calldate', ''),
        DIRECTION_LABEL[pyStr(r.direction)] ?? get(r, 'direction', ''),
        get(r, 'src', ''),
        get(r, 'queue_extension', ''),
        get(r, 'agent_extension', ''),
        get(r, 'duration', ''),
        get(r, 'talk', ''),
        get(r, 'wait_secs', ''),
        r.status || get(r, 'disposition', ''),
        truthy(r.queue_extension) && r.status === 'ANSWERED' ? (truthy(r.sla_met) ? 'Yes' : 'No') : '',
      ];

      if (format.toLowerCase() === 'xlsx') {
        const rows: unknown[][] = [headersRow, ...calls.map(rowValues)];
        if (note) rows.push([], note);
        return download(await xlsxBuffer('Analytics Export', rows), XLSX_MEDIA_TYPE, `analytics_${dateLabel}.xlsx`, extraHeaders);
      }
      // CSV with UTF-8 BOM for Excel compatibility; the header row is unquoted (legacy).
      let buf = BOM + headersRow.join(',') + '\r\n';
      for (const r of calls) buf += quoted(rowValues(r).map(cellStr));
      if (note) buf += '\r\n' + quoted(note);
      return download(buf, CSV_MEDIA_TYPE, `analytics_${dateLabel}.csv`, extraHeaders);
    });
  }

  /**
   * A report tab as a file: exactly what the JSON route of the same report returns for the
   * same query parameters, as a table (see reportTable). `format=xlsx` for a workbook, CSV
   * otherwise. report: overview | queues | agents | heatmap | trend.
   */
  @Get('/api/analytics/export/:report')
  @Auth({ scope: 'analytics:read' })
  async analyticsReportExport(@Req() req: Request) {
    const report = String(req.params.report ?? '') as ExportReport;
    const format = qStr(req.query as QueryParams, 'format', 'csv');
    const [dateFrom, dateTo] = dateRange(req);
    if (!(EXPORT_REPORTS as readonly string[]).includes(report)) throw new HttpError(404, 'Unknown report');
    return guarded(`analytics ${report} export`, async () => {
      const data = await this[report](req);
      const table = reportTable(report, data, dateTo);
      const base = `${report}_${dateFrom || 'all'}_${dateTo || 'all'}`;
      if (format.toLowerCase() === 'xlsx') {
        return download(await xlsxBuffer(SHEET_TITLES[report], table), XLSX_MEDIA_TYPE, `${base}.xlsx`);
      }
      return csvResponse(`${base}.csv`, table[0], table.slice(1));
    });
  }

  // -------------------------------------------------------------------------
  // Settings
  // -------------------------------------------------------------------------

  /** Get SLA thresholds and FCR config. Roles: admin only (a JWT; API keys are refused). */
  @Get('/api/analytics/settings')
  @Auth('user')
  async getAnalyticsSettings(@Req() req: Request) {
    if (principal(req).role !== 'admin') throw new HttpError(403, 'Admin only');
    const fcr: Row = await analyticsModule.getFcrSettings();
    const defaults = analyticsModule.FCR_DEFAULTS;
    return guarded('analytics settings', async () => ({
      sla_thresholds: await analyticsModule.getSlaThresholds(),
      sla_default_secs: await analyticsModule.getSlaDefaultSecs(),
      fcr_window_days: get(fcr, 'window_days', defaults.window_days),
      short_abandon_secs: get(fcr, 'short_abandon_secs', defaults.short_abandon_secs),
      callback_window_hours: get(fcr, 'callback_window_hours', defaults.callback_window_hours),
    }));
  }

  /**
   * Save SLA thresholds (per queue; null removes a queue's override), the SLA default and/or
   * the FCR config. Roles: admin only.
   *
   * Every value is checked against SETTING_RANGES before anything is written: one bad field
   * is a 400 naming it and nothing is saved. A write the database refuses is a 500, never a
   * silent { ok: true }. Fields left out keep their stored value.
   */
  @Post('/api/analytics/settings')
  @Auth('user')
  async saveAnalyticsSettings(@Req() req: Request) {
    const body: JsonObject = parseBody(v.dict(), req.body);
    if (principal(req).role !== 'admin') throw new HttpError(403, 'Admin only');
    const R = analyticsModule.SETTING_RANGES;

    let thresholds: Record<string, number | null> | null = null;
    if ('sla_thresholds' in body) {
      const raw = body.sla_thresholds;
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new HttpError(400, 'sla_thresholds must be an object of queue extension to seconds');
      }
      thresholds = {};
      for (const [queue, secs] of Object.entries(raw as Record<string, unknown>)) {
        if (!/^\d{1,20}$/.test(queue)) throw new HttpError(400, `sla_thresholds: '${queue}' is not a queue extension`);
        thresholds[queue] = secs === null ? null : settingInt(`sla_thresholds.${queue}`, secs, R.sla_threshold_secs);
      }
    }
    const slaDefault = 'sla_default_secs' in body ? settingInt('sla_default_secs', body.sla_default_secs, R.sla_default_secs) : null;
    const fcrFields = ['fcr_window_days', 'short_abandon_secs', 'callback_window_hours'] as const;
    const fcrIn = fcrFields.some((f) => f in body);
    const fcrVals = Object.fromEntries(fcrFields.filter((f) => f in body).map((f) => [f, settingInt(f, body[f], R[f])]));

    return guarded('analytics settings save', async () => {
      const failed = (what: string) => {
        log.error('analytics settings save: %s was not saved', what);
        return new HttpError(500, 'The analytics settings could not be saved');
      };
      if (thresholds && Object.keys(thresholds).length && !(await analyticsModule.saveSlaThresholds(thresholds))) {
        throw failed('sla_thresholds');
      }
      if (slaDefault !== null && !(await dbm.setSetting('SLA_DEFAULT_SECS', String(slaDefault)))) {
        throw failed('sla_default_secs');
      }
      if (fcrIn) {
        const cur = await analyticsModule.getFcrSettings();
        const ok = await analyticsModule.saveFcrSettings(
          fcrVals.fcr_window_days ?? cur.window_days,
          fcrVals.short_abandon_secs ?? cur.short_abandon_secs,
          fcrVals.callback_window_hours ?? cur.callback_window_hours,
        );
        if (!ok) throw failed('fcr settings');
      }
      return { ok: true };
    });
  }
}
