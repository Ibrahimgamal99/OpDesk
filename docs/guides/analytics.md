# Analytics

The full KPI suite: what each metric means, how it is computed, and how to tune it.
See the [project README](../../README.md) for installation.

## KPIs tracked

The Overview tab shows **12 KPI cards** (6 per row) grouped into inbound quality, inbound volume, outbound, and market engagement:

| Metric | Description |
|--------|-------------|
| **SLA %** | Percentage of answered queue calls picked up within the configured threshold (default: 20 s). Per-queue overrides are configurable. |
| **FCR %** | First Contact Resolution — of the callers whose first queue call in the period was answered, the share with no repeat contact within the FCR window (default: 7 days). A repeat is any later queue call from the same number (answered or not) or one of our own calls to them within the callback window (default: 24 h). Numbers compare on their last nine digits; anonymous and internal callers are not counted. Marked provisional while the window is still open. |
| **Abandonment rate** | Percentage of calls offered to the queues that were not answered. Direct calls to an extension are never queue abandons. |
| **Short Abandon** | Calls dropped before the short-abandon threshold (default: 5 s) — accidental hangups excluded from actionable abandonment. |
| **Recovered callers** | Callers who gave up in a queue and whom an agent rang back within the callback window; the net abandon rate takes their abandoned calls out of the abandon rate. |
| **Avg Wait Time** | Mean queue wait time across all queue calls (answered and abandoned), never negative. |
| **AHT** | Average Handle Time — mean talk duration for answered inbound calls. |
| **Inbound Answer Rate** | Percentage of inbound calls that were answered by an agent. |
| **Total Calls** | Combined (inbound + outbound) total, answered, and abandoned counts. |
| **Outbound Calls** | Total outbound call volume with answered count. |
| **Outbound Answer Rate** | Percentage of outbound calls answered by the prospect. |
| **Outbound AHT** | Average Handle Time for outbound calls. |
| **Market Talk Time** | Total outbound billable talk time — measures market engagement effort. Displayed as `Xh Ym`. |

All KPIs are computed for the selected period **and** the equivalent previous period, so every card shows a delta (▲/▼) vs. prior period. Ranges longer than 31 days have no comparison.

The queue figures (SLA, abandonment, short abandon, wait, FCR, recovery) come from the queue CDR — the same rows the Queue Performance tab uses, so the two always agree. Call volumes (inbound, direct inbound, outbound, internal) come from the call history, so they match Call History. A call counts as answered by its call status (Call History's word for it); a queue leg is answered when it carried talk time.

## Tabs

| Tab | What you see |
|-----|-------------|
| **Overview** | **12 KPI cards** across two rows of 6 — inbound quality (SLA, FCR, Abandonment, Short Abandon, Avg Wait, AHT), inbound volume (Answer Rate, Total Calls), outbound (Volume, Answer Rate, AHT), and market engagement (Market Talk Time) — each with a delta vs. prior period. Interactive stacked bar + answer-rate line chart below. |
| **Queue Performance** | One card per queue — offered, answered, abandoned, SLA %, abandon and short-abandon rate, AHT, avg wait, peak hour. A **compare** chart puts queues side by side on SLA, answer rate, contact rate, abandon rate, average wait or offered calls, best first. A **detail** view (one queue or all) shows answered and abandoned per day, how long callers waited, and a **7 × 24 heatmap** of call volume by day-of-week and hour. |
| **Agent Performance** | Sortable ranked table per agent — customer calls, answered, inbound, outbound, internal (counted apart, not ranked), AHT, SLA contribution % and a 7-day sparkline trend. Click a row for that agent's calls by direction. A **compare** chart puts agents side by side on answered calls, AHT, answer rate, talk time or missed calls. |
| **Adherence** | Per agent and day: logged-in time, Ready and Not-Ready time per reason, sessions, break and DND time, and a timeline of every state change. |
| **Drilldown** | Paginated call-level records with direction, queue, agent, duration, talk time, wait, status (the 10-value call status), and SLA-met flag. Filterable by queue, agent, direction, and status. Exportable as **CSV** or **XLSX** (up to 100,000 rows; a cut file says so). |

## Settings

Admins can tune analytics behaviour under **Settings → Analytics**:

| Setting | Default | Description |
|---------|---------|-------------|
| SLA default threshold | 20 s | Global threshold (1–600 s). |
| Per-queue SLA thresholds | — | Overrides the default for one queue (stored in `analytics_sla_settings`); removing one returns the queue to the default. |
| FCR window | 7 days | How many days after the first answered call a repeat contact means it was not resolved (0–90; 0 turns FCR off). |
| Callback window | 24 h | How long after a call our own call to the same number counts as a callback, for FCR and recovered callers (0–168; 0 turns callbacks off). |
| Short-abandon threshold | 5 s | Calls abandoned faster than this are treated as accidental hangups (0–120). |

## Exports

Every tab can be downloaded as CSV with the same filters it shows:
`GET /api/analytics/export/{report}` with `report` = `overview`, `queues`, `agents`, `heatmap` or `trend`.
The Drilldown also exports CSV or XLSX, and Adherence exports CSV. The call log has its own CSV export
(`GET /api/call-log/export`, up to 50,000 rows). See [endpoints.md](../api/endpoints.md#analytics).

## Architecture

```
backend/src/services/analytics.ts   (single source of truth: all KPI math lives here)
     │
     ├── CDR queries  → asteriskcdrdb  (DB_CDR)
     ├── Settings     → OpDesk DB      (analytics_sla_settings, analytics_fcr_settings)
     ├── Aggregation  → OpDesk DB      (analytics_hourly, analytics_daily, analytics_agent_daily)
     │
     └── Background job (every 15 min)
           refreshes the current and previous hour/day buckets
```

The analytics engine reads the Asterisk **CDR table** directly, using a two-leg join (`first_leg` = queue entry, `last_leg` = answered/agent leg) to compute wait time, talk time and agent attribution. Call outcomes use the same 10-value status as the call log (`ANSWERED`, `UNANSWERED`, `BUSY`, `MISSED`, `VOICEMAIL`, `UNREACHABLE`, `FAILURE`, `NETWORK_ERROR`, `ABANDONED`, `DROPPED`). All formulas live in `analytics.ts`: the controllers only call its public functions, and the frontend never repeats a calculation.
