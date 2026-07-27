# Analytics

The full KPI suite: what each metric means, how it is computed, and how to tune it.
See the [project README](../../README.md) for installation.

## KPIs tracked

The Overview tab shows **12 KPI cards** (6 per row) grouped into inbound quality, inbound volume, outbound, and market engagement:

| Metric | Description |
|--------|-------------|
| **SLA %** | Percentage of answered calls picked up within the configured threshold (default: 20 s). Per-queue overrides are configurable. |
| **FCR %** | First Contact Resolution — callers who did *not* call back within the FCR window (default: 7 days). |
| **Abandonment rate** | Percentage of total inbound calls that were not answered. |
| **Short Abandon** | Calls dropped before the short-abandon threshold (default: 5 s) — accidental hangups excluded from actionable abandonment. |
| **Avg Wait Time** | Mean queue wait time across all calls (answered and abandoned). |
| **AHT** | Average Handle Time — mean talk duration for answered inbound calls. |
| **Inbound Answer Rate** | Percentage of inbound calls that were answered by an agent. |
| **Total Calls** | Combined (inbound + outbound) total, answered, and abandoned counts. |
| **Outbound Calls** | Total outbound call volume with answered count. |
| **Outbound Answer Rate** | Percentage of outbound calls answered by the prospect. |
| **Outbound AHT** | Average Handle Time for outbound calls. |
| **Market Talk Time** | Total outbound billable talk time — measures market engagement effort. Displayed as `Xh Ym`. |

All KPIs are computed for the selected period **and** the equivalent previous period, so every card shows a delta (▲/▼) vs. prior period.

## Tabs

| Tab | What you see |
|-----|-------------|
| **Overview** | **12 KPI cards** across two rows of 6 — inbound quality (SLA, FCR, Abandonment, Short Abandon, Avg Wait, AHT), inbound volume (Answer Rate, Total Calls), outbound (Volume, Answer Rate, AHT), and market engagement (Market Talk Time) — each with a delta vs. prior period. Interactive stacked bar + answer-rate line chart below. |
| **Queue Performance** | Sortable table — one row per queue — with total, answered, abandoned, SLA %, AHT, avg wait, peak hour, and inline progress bars. Includes a **7 × 24 heatmap** of call volume by day-of-week and hour. |
| **Agent Performance** | Sortable ranked table per agent — answered calls, AHT, SLA contribution % (with inline progress bar), and a 7-day sparkline trend. |
| **Drilldown** | Paginated call-level records with queue, agent, duration, talk time, wait, disposition, and SLA-met flag. Filterable by queue extension, agent extension, direction, and disposition. Exportable as **CSV** or **XLSX**. |

## Settings

Admins can tune analytics behaviour under **Settings → Analytics**:

| Setting | Default | Description |
|---------|---------|-------------|
| SLA default threshold | 20 s | Global threshold; overridden per queue in `analytics_sla_settings`. |
| FCR callback window | 7 days | How many days after the first answered call a repeat call counts as a callback (not resolved). |
| Short-abandon threshold | 5 s | Calls abandoned faster than this are treated as accidental hangups and excluded from actionable abandonment. |

## Architecture

```
analytics.py  (single source of truth — all KPI math lives here)
     │
     ├── CDR queries  → asterisk DB  (via DB_CDR env var)
     ├── Settings     → OpDesk DB    (analytics_sla_settings, analytics_fcr_settings)
     ├── Aggregation  → OpDesk DB    (analytics_hourly, analytics_daily, analytics_agent_daily)
     │
     └── Background loop (asyncio, every 15 min)
           refreshes current + previous hour/day buckets
```

The analytics engine reads directly from the Asterisk **CDR table** using a two-leg join (`first_leg` = queue entry, `last_leg` = answered/agent leg) to accurately compute wait time, talk time, and agent attribution. All formula logic is in `analytics.py`; `server.py` only calls the public functions and the frontend never duplicates calculations.
