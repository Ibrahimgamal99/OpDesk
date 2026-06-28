"""
Analytics module — single source of truth for all KPI calculations.

All KPI math lives here. server.py only calls the public functions;
no formula is duplicated in the frontend or elsewhere.

KPIs implemented:
  - SLA (% answered within threshold)
  - Abandonment rate + short-abandon split
  - AHT (Average Handle Time = avg talk time)
  - FCR (First Contact Resolution via callback window)
  - Volume / trend data

CDR note: CDR queries go to the asterisk DB (DB_CDR env var).
Settings queries go to the OpDesk DB.
Background aggregation tables also live in OpDesk DB.
"""

import asyncio
import logging
import os
from collections import defaultdict
from contextlib import contextmanager
from datetime import datetime, timedelta, date as date_type
from typing import Optional

from dotenv import load_dotenv

load_dotenv()
log = logging.getLogger(__name__)

try:
    import mysql.connector
    from mysql.connector import Error
except ImportError:
    log.error("mysql-connector-python not installed")
    mysql = None
    Error = Exception

try:
    from db_manager import prune_stale_device_tokens as _prune_stale_tokens
except ImportError:  # pragma: no cover
    _prune_stale_tokens = None

_last_prune_day: Optional[date_type] = None

# ---------------------------------------------------------------------------
# DB helpers (mirror db_manager.get_db_config pattern)
# ---------------------------------------------------------------------------

def _cdr_config():
    """Config for the Asterisk CDR database."""
    return {
        'host': os.getenv('DB_HOST', 'localhost'),
        'port': int(os.getenv('DB_PORT', '3306')),
        'user': os.getenv('DB_USER', 'root'),
        'password': os.getenv('DB_PASSWORD', ''),
        'database': os.getenv('DB_CDR', 'asterisk'),
    }


def _opdesk_config():
    """Config for the OpDesk application database."""
    return {
        'host': os.getenv('DB_HOST', 'localhost'),
        'port': int(os.getenv('DB_PORT', '3306')),
        'user': os.getenv('DB_USER', 'root'),
        'password': os.getenv('DB_PASSWORD', ''),
        'database': os.getenv('DB_OpDesk', 'OpDesk'),
    }


@contextmanager
def _opdesk_db(write=False):
    """Context manager: open OpDesk DB, yield cursor, commit on success (if write=True), always close."""
    conn = mysql.connector.connect(**_opdesk_config())
    cursor = conn.cursor(dictionary=True)
    try:
        yield cursor
        if write:
            conn.commit()
    finally:
        cursor.close()
        conn.close()


@contextmanager
def _cdr_db():
    """Context manager: open CDR DB, yield dict cursor, always close."""
    conn = mysql.connector.connect(**_cdr_config())
    cursor = conn.cursor(dictionary=True)
    try:
        yield cursor
    finally:
        cursor.close()
        conn.close()


_AGENT_EXT_EXPR = "SUBSTRING_INDEX(SUBSTRING_INDEX(last_leg.dstchannel, '-', 1), '/', -1)"


def _scope_queue_condition(allowed_queues, col='first_leg.dst'):
    """Return (sql_fragment, params) to filter by allowed queue extensions (None = all)."""
    if allowed_queues is None:
        return "", []
    if not allowed_queues:
        return "AND 1=0", []
    ph = ", ".join(["%s"] * len(allowed_queues))
    return f"AND {col} IN ({ph})", list(allowed_queues)


def _scope_agent_condition(allowed_agents, col=None):
    """Return (sql_fragment, params) to filter by allowed agent extensions (None = all)."""
    if col is None:
        col = _AGENT_EXT_EXPR
    if allowed_agents is None:
        return "", []
    if not allowed_agents:
        return "AND 1=0", []
    ph = ", ".join(["%s"] * len(allowed_agents))
    return f"AND {col} IN ({ph})", list(allowed_agents)


def _default_dates(date_from, date_to):
    """Fill in default date range (last 30 days) if not provided."""
    if not date_to:
        date_to = datetime.now().strftime('%Y-%m-%d')
    if not date_from:
        date_from = (datetime.now() - timedelta(days=30)).strftime('%Y-%m-%d')
    return date_from, date_to


# ---------------------------------------------------------------------------
# Settings helpers
# ---------------------------------------------------------------------------

def get_sla_thresholds() -> dict:
    """
    Return dict of {queue_extension: threshold_secs}.
    If a queue has no row, callers should fall back to SLA_DEFAULT_SECS setting.
    """
    try:
        with _opdesk_db() as cursor:
            cursor.execute("SELECT queue_extension, threshold_secs FROM analytics_sla_settings")
            rows = cursor.fetchall()
        return {r['queue_extension']: r['threshold_secs'] for r in rows}
    except Error as e:
        log.warning(f"analytics: error loading SLA thresholds: {e}")
        return {}


def get_sla_default_secs() -> int:
    """Return the global SLA default threshold in seconds."""
    try:
        with _opdesk_db() as cursor:
            cursor.execute(
                "SELECT setting_value FROM OpDesk_settings WHERE setting_key='SLA_DEFAULT_SECS'"
            )
            row = cursor.fetchone()
        if row and row['setting_value']:
            return int(row['setting_value'])
    except Exception:
        pass
    return 20


def get_fcr_settings() -> dict:
    """Return FCR/short-abandon config as a dict."""
    try:
        with _opdesk_db() as cursor:
            cursor.execute("SELECT window_days, short_abandon_secs FROM analytics_fcr_settings WHERE id=1")
            row = cursor.fetchone()
        if row:
            return {'window_days': row['window_days'], 'short_abandon_secs': row['short_abandon_secs']}
    except Error as e:
        log.warning(f"analytics: error loading FCR settings: {e}")
    return {'window_days': 7, 'short_abandon_secs': 5}


def save_sla_thresholds(thresholds: dict) -> bool:
    """
    Upsert per-queue SLA thresholds.
    thresholds: {queue_extension: threshold_secs}
    """
    if not thresholds:
        return True
    try:
        with _opdesk_db(write=True) as cursor:
            for qext, secs in thresholds.items():
                cursor.execute(
                    """INSERT INTO analytics_sla_settings (queue_extension, threshold_secs)
                       VALUES (%s, %s)
                       ON DUPLICATE KEY UPDATE threshold_secs=%s""",
                    (str(qext), int(secs), int(secs))
                )
        return True
    except Error as e:
        log.error(f"analytics: error saving SLA thresholds: {e}")
        return False


def save_fcr_settings(window_days: int, short_abandon_secs: int) -> bool:
    """Update the singleton FCR settings row."""
    try:
        with _opdesk_db(write=True) as cursor:
            cursor.execute(
                """INSERT INTO analytics_fcr_settings (id, window_days, short_abandon_secs)
                   VALUES (1, %s, %s)
                   ON DUPLICATE KEY UPDATE window_days=%s, short_abandon_secs=%s""",
                (int(window_days), int(short_abandon_secs), int(window_days), int(short_abandon_secs))
            )
        return True
    except Error as e:
        log.error(f"analytics: error saving FCR settings: {e}")
        return False


def get_queue_names() -> dict:
    """Return {extension: queue_name} from OpDesk.queues."""
    try:
        with _opdesk_db() as cursor:
            cursor.execute("SELECT extension, queue_name FROM queues")
            rows = cursor.fetchall()
        return {r['extension']: r['queue_name'] for r in rows}
    except Error as e:
        log.warning(f"analytics: error loading queue names: {e}")
        return {}


def get_agent_names() -> dict:
    """Return {extension: name} from OpDesk.agents."""
    try:
        with _opdesk_db() as cursor:
            cursor.execute("SELECT extension, name FROM agents")
            rows = cursor.fetchall()
        return {r['extension']: r['name'] for r in rows}
    except Error as e:
        log.warning(f"analytics: error loading agent names: {e}")
        return {}


# ---------------------------------------------------------------------------
# Core CDR query — queue calls with first_leg/last_leg join
# ---------------------------------------------------------------------------

# first_leg = queue entry leg (lastapp=Queue)
# last_leg  = agent answering leg (or same as first_leg if single-leg)
#
# wait_secs = first_leg.duration - last_leg.billsec
#             (total time in system minus talk time = queue wait)
# For abandoned calls last_leg.billsec = 0, so wait_secs = first_leg.duration
#
# agent_ext is extracted from last_leg.dstchannel using the same
# SUBSTRING_INDEX expression already in db_manager.py.
#
# Inner subqueries include date filtering (with 1-day buffer) to avoid
# full-table scans on large CDR tables.
# Expects 6 base params: [date_from, date_to] × 3

def _queue_cdr_sql(extra_sql=""):
    """Build the queue CDR SQL. Caller must supply 6 base date params + extra_params."""
    return f"""
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
        {_AGENT_EXT_EXPR}              AS agent_ext,
        first_leg.linkedid
    FROM
        (
            SELECT c.*
            FROM cdr c
            JOIN (
                SELECT linkedid, MIN(sequence) AS min_seq
                FROM cdr
                WHERE calldate >= %s
                  AND calldate < DATE_ADD(%s, INTERVAL 2 DAY)
                GROUP BY linkedid
            ) x ON c.linkedid = x.linkedid AND c.sequence = x.min_seq
        ) first_leg
    JOIN (
            SELECT c.*
            FROM cdr c
            JOIN (
                SELECT linkedid, MAX(sequence) AS max_seq
                FROM cdr
                WHERE calldate >= %s
                  AND calldate < DATE_ADD(%s, INTERVAL 2 DAY)
                GROUP BY linkedid
            ) x ON c.linkedid = x.linkedid AND c.sequence = x.max_seq
        ) last_leg ON first_leg.linkedid = last_leg.linkedid
    WHERE
        first_leg.lastapp = 'Queue'
        AND first_leg.calldate >= %s
        AND first_leg.calldate < DATE_ADD(%s, INTERVAL 1 DAY)
        {extra_sql}
    """


def _run_queue_cdr(date_from: str, date_to: str, extra_sql: str = "", extra_params: list = None):
    """Execute the queue CDR base query and return rows."""
    params = [date_from, date_to, date_from, date_to, date_from, date_to] + (extra_params or [])
    try:
        with _cdr_db() as cursor:
            cursor.execute(_queue_cdr_sql(extra_sql), params)
            return cursor.fetchall()
    except Error as e:
        # Propagate so the API surfaces a 500 instead of returning empty data
        # that the UI would render as "no data for this period".
        log.error(f"analytics: CDR query error: {e}")
        raise


# ---------------------------------------------------------------------------
# All-call CDR query — includes queue, outbound, and internal calls
# ---------------------------------------------------------------------------

_CALLER_EXT_EXPR = "SUBSTRING_INDEX(SUBSTRING_INDEX(first_leg.channel, '-', 1), '/', -1)"


def _all_cdr_sql(extra_sql=""):
    """Build CDR SQL for ALL calls (queue + outbound + internal).
    Includes extra fields (lastapp, dcontext, channel, dstchannel) for direction
    classification in Python.  Caller must supply 6 base date params + extra_params."""
    return f"""
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
        {_AGENT_EXT_EXPR}              AS agent_ext,
        {_CALLER_EXT_EXPR}             AS caller_ext,
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
                WHERE calldate >= %s
                  AND calldate < DATE_ADD(%s, INTERVAL 2 DAY)
                GROUP BY linkedid
            ) x ON c.linkedid = x.linkedid AND c.sequence = x.min_seq
        ) first_leg
    JOIN (
            SELECT c.*
            FROM cdr c
            JOIN (
                SELECT linkedid, MAX(sequence) AS max_seq
                FROM cdr
                WHERE calldate >= %s
                  AND calldate < DATE_ADD(%s, INTERVAL 2 DAY)
                GROUP BY linkedid
            ) x ON c.linkedid = x.linkedid AND c.sequence = x.max_seq
        ) last_leg ON first_leg.linkedid = last_leg.linkedid
    WHERE
        first_leg.calldate >= %s
        AND first_leg.calldate < DATE_ADD(%s, INTERVAL 1 DAY)
        {extra_sql}
    """


def _run_all_cdr(date_from: str, date_to: str, extra_sql: str = "", extra_params: list = None):
    """Execute the all-call CDR query and return rows."""
    params = [date_from, date_to, date_from, date_to, date_from, date_to] + (extra_params or [])
    try:
        with _cdr_db() as cursor:
            cursor.execute(_all_cdr_sql(extra_sql), params)
            return cursor.fetchall()
    except Error as e:
        log.error(f"analytics: all-CDR query error: {e}")
        raise


def _classify_row_direction(row: dict) -> str:
    """Classify a CDR row direction (IN/OUT/INTERNAL) using the existing call_log classifier."""
    from call_log import classify_cdr_direction
    cdr_dict = {
        'src': str(row.get('src', '')),
        'dst': str(row.get('dst', '')),
        'dcontext': str(row.get('dcontext', '')),
        'channel': str(row.get('channel', '')),
        'dstchannel': str(row.get('dstchannel', '')),
        'lastapp': str(row.get('lastapp', '')),
    }
    return classify_cdr_direction(cdr_dict)


def _enrich_with_direction(rows: list) -> list:
    """Add 'direction' field to each row and normalize queue_ext for queue calls."""
    for r in rows:
        r['direction'] = _classify_row_direction(r)
        # For queue calls, dst is the queue extension; for outbound, it's the external number
        if r['direction'] == 'IN' and r.get('lastapp') == 'Queue':
            r['queue_ext'] = str(r.get('dst', ''))
        else:
            r['queue_ext'] = ''
    return rows


def _apply_scope_filter(rows: list, allowed_queues=None, allowed_agents=None) -> list:
    """Filter rows by allowed queues/agents in Python.
    None = no filter (admin sees everything), empty list = nothing allowed."""
    if allowed_queues is None and allowed_agents is None:
        return rows
    if not allowed_queues and not allowed_agents:
        return []

    allowed_q = set(str(q) for q in (allowed_queues or []))
    allowed_a = set(str(a) for a in (allowed_agents or []))

    filtered = []
    for r in rows:
        direction = r.get('direction', '')
        disp = str(r.get('disposition', '')).upper()

        # Queue scope: only applies to inbound queue calls
        if allowed_queues is not None and direction == 'IN' and r.get('lastapp') == 'Queue':
            if str(r.get('dst', '')) not in allowed_q:
                continue

        # Agent scope: applies to all calls
        if allowed_agents is not None:
            if direction == 'IN':
                # For all inbound calls (queue and non-queue), use agent_ext from dstchannel
                agent_ext = str(r.get('agent_ext', ''))
                # For non-queue inbound calls that weren't answered, include them anyway
                # (no agent was involved, so agent filter shouldn't exclude them)
                if not agent_ext and disp != 'ANSWERED':
                    pass  # Include unanswered non-queue inbound calls
                elif agent_ext and agent_ext not in allowed_a:
                    continue
                elif not agent_ext and disp == 'ANSWERED':
                    continue  # Answered but no agent info — can't verify scope
            elif direction == 'OUT':
                agent_ext = str(r.get('caller_ext', ''))
                if agent_ext not in allowed_a:
                    continue
            else:
                # INTERNAL calls: check either side
                caller = str(r.get('caller_ext', ''))
                agent = str(r.get('agent_ext', ''))
                if caller not in allowed_a and agent not in allowed_a:
                    continue
        filtered.append(r)
    return filtered


# ---------------------------------------------------------------------------
# KPI helpers
# ---------------------------------------------------------------------------

def _sla_threshold_for(queue_ext: str, thresholds: dict, default_secs: int) -> int:
    return thresholds.get(queue_ext, default_secs)


def _compute_kpis_from_rows(rows, thresholds: dict, default_secs: int, short_abandon_secs: int):
    """
    Compute aggregate KPIs from a flat list of queue CDR rows.

    Returns a dict with: total_calls, answered_calls, abandoned_calls,
    short_abandoned, sla_met, sum_wait_secs, sum_billsec.
    """
    total = answered = abandoned = short_abandoned = sla_met = 0
    sum_wait = sum_billsec = 0

    for r in rows:
        total += 1
        disp = str(r.get('disposition', '')).upper()
        wait = int(r.get('wait_secs') or 0)
        bsec = int(r.get('billsec') or 0)
        q = str(r.get('queue_ext', ''))
        threshold = _sla_threshold_for(q, thresholds, default_secs)

        if disp == 'ANSWERED':
            answered += 1
            sum_billsec += bsec
            sum_wait += wait
            if wait <= threshold:
                sla_met += 1
        else:
            abandoned += 1
            sum_wait += wait
            if wait <= short_abandon_secs:
                short_abandoned += 1

    return {
        'total_calls': total,
        'answered_calls': answered,
        'abandoned_calls': abandoned,
        'short_abandoned': short_abandoned,
        'sla_met_calls': sla_met,
        'sum_wait_secs': sum_wait,
        'sum_billsec': sum_billsec,
    }


def _derive_rates(kpis: dict) -> dict:
    """Add percentage fields to a KPI dict (modifies in-place and returns it)."""
    total = kpis['total_calls']
    answered = kpis['answered_calls']
    kpis['sla_pct'] = round(kpis['sla_met_calls'] / answered * 100, 1) if answered else None
    kpis['abandonment_rate'] = round(kpis['abandoned_calls'] / total * 100, 1) if total else None
    kpis['short_abandon_rate'] = round(kpis['short_abandoned'] / total * 100, 1) if total else None
    kpis['aht_secs'] = round(kpis['sum_billsec'] / answered) if answered else None
    kpis['avg_wait_secs'] = round(kpis['sum_wait_secs'] / total, 1) if total else None
    return kpis


def _compute_fcr(date_from: str, date_to: str, window_days: int,
                 allowed_queues=None) -> Optional[float]:
    """
    Compute FCR% for the period.

    FCR = (1 - callbacks/total_answered) * 100

    A "callback" is when the same src number places another inbound queue call
    within window_days of a previously answered call in the period.
    """
    if window_days <= 0:
        return None

    queue_cond, qparams = _scope_queue_condition(allowed_queues, col='dst')

    window_end = (
        datetime.strptime(date_to, '%Y-%m-%d') + timedelta(days=window_days + 1)
    ).strftime('%Y-%m-%d')
    try:
        with _cdr_db() as cursor:
            cursor.execute(f"""
                SELECT src, calldate
                FROM cdr
                WHERE calldate >= %s
                  AND calldate < %s
                  AND lastapp = 'Queue'
                  AND disposition = 'ANSWERED'
                  {queue_cond}
                ORDER BY src, calldate
            """, [date_from, window_end] + qparams)
            all_rows = cursor.fetchall()
    except Error as e:
        log.warning(f"analytics: FCR query error: {e}")
        return None

    src_calls = defaultdict(list)
    for r in all_rows:
        src_calls[str(r['src'])].append(r['calldate'])

    period_end = datetime.strptime(date_to, '%Y-%m-%d') + timedelta(days=1)
    period_start = datetime.strptime(date_from, '%Y-%m-%d')

    answered_in_period = set()
    for src, calls in src_calls.items():
        first_in_period = next((c for c in calls if period_start <= c < period_end), None)
        if first_in_period:
            answered_in_period.add(src)

    if not answered_in_period:
        return None

    callbacks = 0
    for src in answered_in_period:
        calls = src_calls[src]
        first_in_period = next((c for c in calls if period_start <= c < period_end), None)
        if first_in_period:
            boundary = first_in_period + timedelta(days=window_days)
            has_callback = any(c > first_in_period and c <= boundary for c in calls)
            if has_callback:
                callbacks += 1

    fcr_pct = round((1 - callbacks / len(answered_in_period)) * 100, 1)
    return fcr_pct


# ---------------------------------------------------------------------------
# Public KPI functions
# ---------------------------------------------------------------------------

def _compute_directional_kpis(rows, thresholds, default_secs, short_abandon_secs):
    """Compute KPIs split by direction (inbound queue vs outbound) from enriched rows."""
    # Split rows by direction
    in_rows = [r for r in rows if r.get('direction') == 'IN']
    out_rows = [r for r in rows if r.get('direction') == 'OUT']

    # Inbound queue KPIs (existing logic)
    in_kpis = _derive_rates(_compute_kpis_from_rows(in_rows, thresholds, default_secs, short_abandon_secs))

    # Outbound KPIs
    out_total = len(out_rows)
    out_answered = sum(1 for r in out_rows if str(r.get('disposition', '')).upper() == 'ANSWERED')
    out_billsec = sum(int(r.get('billsec') or 0) for r in out_rows if str(r.get('disposition', '')).upper() == 'ANSWERED')
    out_failed = sum(1 for r in out_rows if str(r.get('disposition', '')).upper() == 'FAILED')
    out_no_answer = sum(1 for r in out_rows if str(r.get('disposition', '')).upper() == 'NO ANSWER')
    out_busy = sum(1 for r in out_rows if str(r.get('disposition', '')).upper() == 'BUSY')

    out_kpis = {
        'total_calls': out_total,
        'answered_calls': out_answered,
        'failed_calls': out_failed,
        'no_answer_calls': out_no_answer,
        'busy_calls': out_busy,
        'aht_secs': round(out_billsec / out_answered) if out_answered else None,
        'answer_rate': round(out_answered / out_total * 100, 1) if out_total else None,
        'sum_billsec': out_billsec,
    }

    # Combined KPIs (all calls)
    all_total = len(rows)
    all_answered = in_kpis['answered_calls'] + out_answered
    all_billsec = in_kpis['sum_billsec'] + out_billsec
    combined = {
        'total_calls': all_total,
        'answered_calls': all_answered,
        'aht_secs': round(all_billsec / all_answered) if all_answered else None,
    }

    in_kpis['outbound'] = out_kpis
    in_kpis['combined'] = combined
    return in_kpis


def _compute_period_kpis_with_outbound(date_from, date_to, allowed_queues, allowed_agents,
                                        thresholds, default_secs, short_abandon_secs, window_days):
    """Compute KPIs for a period including outbound metrics.
    Uses the same call_log data source as Call History for consistency."""
    from call_log import call_log

    # Use call_log data source (same as Call History page)
    allowed_extensions = list(allowed_agents) if allowed_agents is not None else None
    all_rows = call_log(date_from=date_from, date_to=date_to,
                        allowed_extensions=allowed_extensions)

    # Apply queue scope for non-admin users
    if allowed_queues is not None:
        allowed_q = set(str(q) for q in allowed_queues)
        filtered = []
        for r in all_rows:
            call_type = r.get('call_type', '')
            if call_type == 'IN':
                dst = str(r.get('dst', ''))
                if dst and dst.isdigit() and dst not in allowed_q:
                    continue
            filtered.append(r)
        all_rows = filtered

    # Build enriched rows compatible with KPI computation
    enriched = []
    for r in all_rows:
        call_type = r.get('call_type', '')
        dst = str(r.get('dst', ''))
        disp = str(r.get('disposition', '')).upper()
        duration = int(r.get('duration') or 0)
        talk = int(r.get('talk') or 0)
        q_ext = dst if call_type == 'IN' and dst.isdigit() else ''
        enriched.append({
            'direction': call_type,
            'disposition': disp,
            'queue_ext': q_ext,
            'wait_secs': max(0, duration - talk) if q_ext else 0,
            'billsec': talk,
            'total_dur': duration,
        })

    kpis = _compute_directional_kpis(enriched, thresholds, default_secs, short_abandon_secs)
    kpis['fcr_pct'] = _compute_fcr(date_from, date_to, window_days, allowed_queues)
    return kpis


def compute_executive_kpis(
    date_from: str,
    date_to: str,
    allowed_queues=None,
    allowed_agents=None,
    sla_thresholds: dict = None,
    fcr_cfg: dict = None,
) -> dict:
    """
    Returns combined KPIs for the executive overview page.
    Includes current period + previous period (same duration) for delta calculation.
    Now includes outbound call metrics alongside queue (inbound) metrics.
    """
    date_from, date_to = _default_dates(date_from, date_to)
    thresholds = sla_thresholds or get_sla_thresholds()
    default_secs = get_sla_default_secs()
    fcr = fcr_cfg or get_fcr_settings()
    short_abandon_secs = fcr.get('short_abandon_secs', 5)
    window_days = fcr.get('window_days', 7)

    # Current period
    kpis = _compute_period_kpis_with_outbound(
        date_from, date_to, allowed_queues, allowed_agents,
        thresholds, default_secs, short_abandon_secs, window_days
    )

    # Previous period (same duration, shifted back)
    d0 = datetime.strptime(date_from, '%Y-%m-%d')
    d1 = datetime.strptime(date_to, '%Y-%m-%d')
    delta = (d1 - d0).days + 1
    prev_from = (d0 - timedelta(days=delta)).strftime('%Y-%m-%d')
    prev_to = (d0 - timedelta(days=1)).strftime('%Y-%m-%d')
    prev_kpis = _compute_period_kpis_with_outbound(
        prev_from, prev_to, allowed_queues, allowed_agents,
        thresholds, default_secs, short_abandon_secs, window_days
    )

    return {
        'period': {'from': date_from, 'to': date_to},
        'current': kpis,
        'prev_period': prev_kpis,
    }


def compute_queue_performance(
    date_from: str,
    date_to: str,
    allowed_queues=None,
    sla_thresholds: dict = None,
    fcr_cfg: dict = None,
) -> list:
    """
    Returns a list of per-queue KPI rows.
    """
    date_from, date_to = _default_dates(date_from, date_to)
    thresholds = sla_thresholds or get_sla_thresholds()
    default_secs = get_sla_default_secs()
    fcr = fcr_cfg or get_fcr_settings()
    short_abandon_secs = fcr.get('short_abandon_secs', 5)
    queue_names = get_queue_names()

    queue_cond, qparams = _scope_queue_condition(allowed_queues)
    rows = _run_queue_cdr(date_from, date_to, queue_cond, qparams)

    by_queue = defaultdict(list)
    for r in rows:
        by_queue[str(r.get('queue_ext', ''))].append(r)

    # Find peak hour per queue
    hour_counts = defaultdict(lambda: defaultdict(int))
    for r in rows:
        q = str(r.get('queue_ext', ''))
        h = r['calldate'].hour if r.get('calldate') else 0
        hour_counts[q][h] += 1

    result = []
    for q_ext, q_rows in by_queue.items():
        k = _derive_rates(_compute_kpis_from_rows(q_rows, thresholds, default_secs, short_abandon_secs))
        peak = max(hour_counts[q_ext], key=hour_counts[q_ext].get) if hour_counts[q_ext] else None
        result.append({
            'queue_extension': q_ext,
            'queue_name': queue_names.get(q_ext, q_ext),
            'total_calls': k['total_calls'],
            'answered_calls': k['answered_calls'],
            'abandoned_calls': k['abandoned_calls'],
            'sla_pct': k['sla_pct'],
            'aht_secs': k['aht_secs'],
            'avg_wait_secs': k['avg_wait_secs'],
            'peak_hour': peak,
        })

    result.sort(key=lambda x: x['total_calls'], reverse=True)
    return result


def compute_agent_performance(
    date_from: str,
    date_to: str,
    allowed_agents=None,
    sla_thresholds: dict = None,
) -> list:
    """
    Returns per-agent KPI rows with 7-day daily trend.
    Includes ALL calls (inbound, outbound, internal) — not just queue calls.
    Uses call_log for consistency with the rest of analytics.
    """
    from call_log import call_log

    date_from, date_to = _default_dates(date_from, date_to)
    thresholds = sla_thresholds or get_sla_thresholds()
    default_secs = get_sla_default_secs()
    agent_names = get_agent_names()

    # Use call_log data source (same as Call History)
    allowed_extensions = list(allowed_agents) if allowed_agents is not None else None
    all_rows = call_log(date_from=date_from, date_to=date_to,
                        allowed_extensions=allowed_extensions)

    # Build per-agent stats from all calls
    # Each agent's extension comes from the 'extension' field (dstchannel extraction)
    by_agent_total = defaultdict(int)       # total calls handled
    by_agent_answered = defaultdict(int)    # answered calls
    by_agent_billsec = defaultdict(int)     # total talk time
    by_agent_sla_met = defaultdict(int)     # SLA met (inbound queue only)
    by_agent_inbound = defaultdict(int)     # inbound calls
    by_agent_inbound_answered = defaultdict(int)  # answered inbound queue calls (SLA denominator)
    by_agent_outbound = defaultdict(int)    # outbound calls
    daily_trend_data = defaultdict(lambda: defaultdict(int))  # agent -> date -> count

    for r in all_rows:
        ext = str(r.get('extension', '') or '')
        if not ext or not ext.isdigit():
            continue

        call_type = r.get('call_type', '')
        disp = str(r.get('disposition', '')).upper()
        duration = int(r.get('duration') or 0)
        talk = int(r.get('talk') or 0)
        dst = str(r.get('dst', ''))

        by_agent_total[ext] += 1

        if call_type == 'IN':
            by_agent_inbound[ext] += 1
        elif call_type == 'OUT':
            by_agent_outbound[ext] += 1

        if disp == 'ANSWERED':
            by_agent_answered[ext] += 1
            by_agent_billsec[ext] += talk

            # SLA check (only for inbound queue calls)
            if call_type == 'IN' and dst and dst.isdigit():
                q_ext = dst
                by_agent_inbound_answered[ext] += 1
                wait = max(0, duration - talk)
                threshold = _sla_threshold_for(q_ext, thresholds, default_secs)
                if wait <= threshold:
                    by_agent_sla_met[ext] += 1

            # Daily trend (answered calls per day)
            if r.get('calldate'):
                day_key = r['calldate'].strftime('%Y-%m-%d')
                daily_trend_data[ext][day_key] += 1

    # 7-day daily trend: last 7 days of the selected period
    end_date = datetime.strptime(date_to, '%Y-%m-%d').date()
    trend_days = [(end_date - timedelta(days=i)).strftime('%Y-%m-%d') for i in range(6, -1, -1)]

    result = []
    for a_ext in by_agent_total:
        answered = by_agent_answered[a_ext]
        total_billsec = by_agent_billsec[a_ext]
        inbound_answered = by_agent_inbound_answered[a_ext]

        # SLA % = answered inbound queue calls within threshold / answered inbound queue calls
        # (mirrors the queue-level definition: sla_met_calls / answered)
        sla_pct = round(by_agent_sla_met[a_ext] / inbound_answered * 100, 1) if inbound_answered else None

        trend = [daily_trend_data[a_ext].get(d, 0) for d in trend_days]

        result.append({
            'agent_extension': a_ext,
            'agent_name': agent_names.get(a_ext, a_ext),
            'total_calls': by_agent_total[a_ext],
            'answered_calls': answered,
            'inbound_calls': by_agent_inbound[a_ext],
            'outbound_calls': by_agent_outbound[a_ext],
            'aht_secs': round(total_billsec / answered) if answered else None,
            'sla_contribution_pct': sla_pct,
            'daily_trend': trend,
        })

    result.sort(key=lambda x: x['answered_calls'], reverse=True)
    # Add rank
    for i, row in enumerate(result):
        row['rank'] = i + 1
    return result


def compute_hourly_heatmap(
    date_from: str,
    date_to: str,
    allowed_queues=None,
) -> dict:
    """
    Returns 7x24 matrix of call volumes for the heatmap widget.
    matrix[day_of_week][hour] where day_of_week: 0=Mon ... 6=Sun
    """
    date_from, date_to = _default_dates(date_from, date_to)
    queue_cond, qparams = _scope_queue_condition(allowed_queues)

    try:
        with _cdr_db() as cursor:
            cursor.execute(f"""
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
                            WHERE calldate >= %s
                              AND calldate < DATE_ADD(%s, INTERVAL 2 DAY)
                            GROUP BY linkedid
                        ) x ON c.linkedid=x.linkedid AND c.sequence=x.min_seq
                    ) first_leg
                JOIN (
                        SELECT c.*
                        FROM cdr c
                        JOIN (
                            SELECT linkedid, MAX(sequence) AS max_seq
                            FROM cdr
                            WHERE calldate >= %s
                              AND calldate < DATE_ADD(%s, INTERVAL 2 DAY)
                            GROUP BY linkedid
                        ) x ON c.linkedid=x.linkedid AND c.sequence=x.max_seq
                    ) last_leg ON first_leg.linkedid=last_leg.linkedid
                WHERE first_leg.lastapp='Queue'
                  AND first_leg.calldate >= %s
                  AND first_leg.calldate < DATE_ADD(%s, INTERVAL 1 DAY)
                  {queue_cond}
                GROUP BY dow, hr
            """, [date_from, date_to, date_from, date_to, date_from, date_to] + qparams)
            rows = cursor.fetchall()
    except Error as e:
        # Propagate so the API surfaces a 500 instead of returning an all-zero
        # matrix that the UI would render as a real (empty) heatmap.
        log.error(f"analytics: heatmap query error: {e}")
        raise

    # DAYOFWEEK: 1=Sun,2=Mon,...,7=Sat -- convert to 0=Mon..6=Sun
    matrix = [[0] * 24 for _ in range(7)]
    abandoned_matrix = [[0] * 24 for _ in range(7)]
    for r in rows:
        dow_mysql = int(r['dow'])  # 1=Sun
        # Convert to 0=Mon, 1=Tue, ..., 6=Sun
        day_idx = (dow_mysql - 2) % 7
        hr = int(r['hr'])
        total = int(r['cnt'])
        ans = int(r['answered_cnt'])
        matrix[day_idx][hr] = total
        abandoned_matrix[day_idx][hr] = total - ans

    day_labels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
    hour_labels = [f'{h:02d}:00' for h in range(24)]

    return {
        'matrix': matrix,
        'abandoned_matrix': abandoned_matrix,
        'labels': {'days': day_labels, 'hours': hour_labels},
    }


def compute_drilldown(
    date_from: str,
    date_to: str,
    queue_ext: str = None,
    agent_ext: str = None,
    direction: str = None,
    disposition_filter: str = None,
    page: int = 1,
    page_size: int = 50,
    allowed_queues=None,
    allowed_agents=None,
    sla_thresholds: dict = None,
) -> dict:
    """
    Returns paginated call records with analytics fields (wait_secs, sla_met).
    Uses the same data source as Call History (call_log module) for consistency.
    """
    from call_log import call_log, classify_cdr_direction, convert_channel_to_extension

    date_from, date_to = _default_dates(date_from, date_to)
    thresholds = sla_thresholds or get_sla_thresholds()
    default_secs = get_sla_default_secs()

    # Use call_log data source (same as Call History page)
    allowed_extensions = list(allowed_agents) if allowed_agents is not None else None
    all_rows = call_log(date_from=date_from, date_to=date_to,
                        allowed_extensions=allowed_extensions)

    # Apply filters
    filtered = []
    for r in all_rows:
        call_type = r.get('call_type', '')

        # Queue filter
        if queue_ext and str(r.get('dst', '')) != queue_ext:
            continue

        # Agent filter
        if agent_ext and str(r.get('extension', '') or '') != agent_ext:
            continue

        # Direction filter
        if direction and direction.upper() in ('IN', 'OUT', 'INTERNAL'):
            if call_type != direction.upper():
                continue

        # Disposition filter
        if disposition_filter and str(r.get('disposition', '')).upper() != disposition_filter.upper():
            continue

        # Queue scope (for non-admin)
        if allowed_queues is not None and call_type == 'IN':
            dst = str(r.get('dst', ''))
            # Only apply queue scope to queue-bound inbound calls
            if dst and dst.isdigit():
                allowed_q = set(str(q) for q in allowed_queues)
                if dst not in allowed_q:
                    continue

        filtered.append(r)

    total = len(filtered)
    # Sort most recent first, then paginate
    filtered.sort(key=lambda r: r.get('calldate') or datetime.min, reverse=True)
    start = (page - 1) * page_size
    page_rows = filtered[start:start + page_size]

    records = []
    for r in page_rows:
        disp = str(r.get('disposition', '')).upper()
        dst = str(r.get('dst', ''))
        ct = r.get('call_type', '')
        # For queue inbound calls, dst is the queue extension
        q_ext = dst if ct == 'IN' and dst.isdigit() else ''
        threshold = _sla_threshold_for(q_ext, thresholds, default_secs)
        # Wait time: only meaningful for queue calls
        duration = int(r.get('duration') or 0)
        talk = int(r.get('talk') or 0)
        wait = max(0, duration - talk) if q_ext else 0
        sla_met = bool(q_ext) and disp == 'ANSWERED' and wait <= threshold
        records.append({
            'calldate': r['calldate'].isoformat() if r.get('calldate') else None,
            'src': str(r.get('src', '')),
            'dst': dst,
            'queue_extension': q_ext,
            'agent_extension': str(r.get('extension', '') or ''),
            'duration': duration,
            'talk': talk,
            'disposition': disp,
            'status': r.get('status', 'completed' if disp == 'ANSWERED' else 'no_answer'),
            'wait_secs': wait,
            'sla_met': sla_met,
            'linkedid': str(r.get('linkedid', '')),
            'direction': r.get('call_type', ''),
        })

    return {'calls': records, 'total': total, 'page': page, 'page_size': page_size}


# ---------------------------------------------------------------------------
# Volume trend (daily call counts for the period)
# ---------------------------------------------------------------------------

def compute_volume_trend(
    date_from: str,
    date_to: str,
    allowed_queues=None,
    allowed_agents=None,
) -> list:
    """
    Returns list of {date, total_calls, answered_calls, abandoned_calls,
    outbound_total, outbound_answered} per day — one entry per day in the range.

    Uses call_log() (same source as executive KPIs) so direction classification
    goes through the single canonical classify_cdr_direction() in call_log.py.
    """
    from call_log import call_log as get_call_log

    date_from, date_to = _default_dates(date_from, date_to)
    allowed_extensions = list(allowed_agents) if allowed_agents is not None else None
    all_rows = get_call_log(date_from=date_from, date_to=date_to,
                            allowed_extensions=allowed_extensions)

    # Apply queue scope for inbound calls (same pattern as _compute_period_kpis_with_outbound)
    if allowed_queues is not None:
        allowed_q = set(str(q) for q in allowed_queues)
        filtered = []
        for r in all_rows:
            if r.get('call_type') == 'IN':
                dst = str(r.get('dst', ''))
                if dst and dst.isdigit() and dst not in allowed_q:
                    continue
            filtered.append(r)
        all_rows = filtered

    # Bucket calls by calendar day and direction
    day_stats: dict = defaultdict(lambda: {
        'in_total': 0, 'in_answered': 0, 'in_abandoned': 0,
        'out_total': 0, 'out_answered': 0,
    })
    for r in all_rows:
        call_type = r.get('call_type', '')
        disp = str(r.get('disposition', '')).upper().strip()
        # calldate may be a datetime object or 'YYYY-MM-DD HH:MM:SS' string
        day = str(r.get('calldate', ''))[:10]
        if not day or len(day) < 10:
            continue
        if call_type == 'IN':
            day_stats[day]['in_total'] += 1
            if disp == 'ANSWERED':
                day_stats[day]['in_answered'] += 1
            else:
                day_stats[day]['in_abandoned'] += 1
        elif call_type == 'OUT':
            day_stats[day]['out_total'] += 1
            if disp == 'ANSWERED':
                day_stats[day]['out_answered'] += 1

    # Emit one record per calendar day with no gaps
    d0 = datetime.strptime(date_from, '%Y-%m-%d')
    d1 = datetime.strptime(date_to, '%Y-%m-%d')
    result = []
    cur = d0
    while cur <= d1:
        day_str = cur.strftime('%Y-%m-%d')
        s = day_stats.get(day_str, {})
        result.append({
            'date': day_str,
            'total_calls': s.get('in_total', 0),
            'answered_calls': s.get('in_answered', 0),
            'abandoned_calls': s.get('in_abandoned', 0),
            'outbound_total': s.get('out_total', 0),
            'outbound_answered': s.get('out_answered', 0),
        })
        cur += timedelta(days=1)
    return result


# ---------------------------------------------------------------------------
# Pre-aggregation
# ---------------------------------------------------------------------------

def refresh_hourly_bucket(
    hour_dt: datetime,
    sla_thresholds: dict,
    default_secs: int,
    short_abandon_secs: int,
):
    """Compute and upsert analytics for one hour bucket across all queues."""
    hour_str = hour_dt.strftime('%Y-%m-%d %H:00:00')
    next_hour = hour_dt + timedelta(hours=1)
    next_hour_str = next_hour.strftime('%Y-%m-%d %H:%M:%S')

    try:
        with _cdr_db() as cursor:
            cursor.execute("""
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
                        WHERE calldate >= %s AND calldate < %s
                        GROUP BY linkedid
                     ) x ON c.linkedid=x.linkedid AND c.sequence=x.ms
                    ) first_leg
                JOIN (SELECT c.* FROM cdr c
                      JOIN (
                        SELECT linkedid, MAX(sequence) AS ms
                        FROM cdr
                        WHERE calldate >= %s AND calldate < %s
                        GROUP BY linkedid
                      ) x ON c.linkedid=x.linkedid AND c.sequence=x.ms
                     ) last_leg ON first_leg.linkedid=last_leg.linkedid
                WHERE first_leg.lastapp='Queue'
                  AND first_leg.calldate >= %s
                  AND first_leg.calldate < %s
            """, [hour_str, next_hour_str,
                  hour_str, next_hour_str,
                  hour_str, next_hour_str])
            rows = cursor.fetchall()
    except Error as e:
        log.warning(f"analytics: hourly aggregation error for {hour_str}: {e}")
        return

    # Group by queue_ext
    by_queue = defaultdict(list)
    for r in rows:
        by_queue[str(r.get('queue_ext', ''))].append(r)

    if not by_queue:
        return

    try:
        with _opdesk_db(write=True) as cursor:
            for q_ext, q_rows in by_queue.items():
                k = _compute_kpis_from_rows(
                    q_rows, sla_thresholds, default_secs, short_abandon_secs
                )
                cursor.execute("""
                    INSERT INTO analytics_hourly
                        (hour_bucket, queue_extension, total_calls, answered_calls, abandoned_calls,
                         short_abandoned, sum_wait_secs, sum_billsec, sla_met_calls)
                    VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)
                    ON DUPLICATE KEY UPDATE
                        total_calls=VALUES(total_calls),
                        answered_calls=VALUES(answered_calls),
                        abandoned_calls=VALUES(abandoned_calls),
                        short_abandoned=VALUES(short_abandoned),
                        sum_wait_secs=VALUES(sum_wait_secs),
                        sum_billsec=VALUES(sum_billsec),
                        sla_met_calls=VALUES(sla_met_calls),
                        computed_at=CURRENT_TIMESTAMP
                """, (
                    hour_str, q_ext,
                    k['total_calls'], k['answered_calls'], k['abandoned_calls'],
                    k['short_abandoned'], k['sum_wait_secs'], k['sum_billsec'],
                    k['sla_met_calls'],
                ))
    except Error as e:
        log.warning(f"analytics: hourly upsert error for {hour_str}: {e}")


def refresh_daily_bucket(
    day: date_type,
    sla_thresholds: dict,
    default_secs: int,
    short_abandon_secs: int,
    fcr_window_days: int,
):
    """Compute and upsert analytics for one calendar day across all queues."""
    day_str = day.strftime('%Y-%m-%d')

    # Re-use live compute for now (aggregation is idempotent via ON DUPLICATE KEY)
    try:
        rows = _run_queue_cdr(day_str, day_str, "", [])
    except Error as e:
        log.warning(f"analytics: skipping daily bucket for {day_str} due to CDR error: {e}")
        return
    if not rows:
        return

    by_queue = defaultdict(list)
    for r in rows:
        by_queue[str(r.get('queue_ext', ''))].append(r)

    try:
        with _opdesk_db(write=True) as cursor:
            for q_ext, q_rows in by_queue.items():
                k = _compute_kpis_from_rows(q_rows, sla_thresholds, default_secs, short_abandon_secs)
                unique_callers = len(set(str(r.get('src', '')) for r in q_rows))
                cursor.execute("""
                    INSERT INTO analytics_daily
                        (day_bucket, queue_extension, total_calls, answered_calls, abandoned_calls,
                         short_abandoned, sum_wait_secs, sum_billsec, sla_met_calls, unique_callers)
                    VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
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
                """, (
                    day_str, q_ext,
                    k['total_calls'], k['answered_calls'], k['abandoned_calls'],
                    k['short_abandoned'], k['sum_wait_secs'], k['sum_billsec'],
                    k['sla_met_calls'], unique_callers,
                ))
    except Error as e:
        log.warning(f"analytics: daily upsert error for {day_str}: {e}")


# ---------------------------------------------------------------------------
# Background aggregation loop (asyncio task — registered in server.py lifespan)
# ---------------------------------------------------------------------------

async def start_aggregation_loop():
    """
    Asyncio background task. Refreshes current and previous hour/day every 15 min.
    Started via asyncio.create_task(analytics.start_aggregation_loop()) in lifespan.
    """
    log.info("analytics: aggregation loop started")
    while True:
        try:
            thresholds = get_sla_thresholds()
            default_secs = get_sla_default_secs()
            fcr = get_fcr_settings()
            short_abandon_secs = fcr.get('short_abandon_secs', 5)
            fcr_window_days = fcr.get('window_days', 7)

            now = datetime.now()
            current_hour = now.replace(minute=0, second=0, microsecond=0)
            prev_hour = current_hour - timedelta(hours=1)

            # Hourly buckets
            refresh_hourly_bucket(current_hour, thresholds, default_secs, short_abandon_secs)
            refresh_hourly_bucket(prev_hour, thresholds, default_secs, short_abandon_secs)

            # Daily buckets (today + yesterday)
            refresh_daily_bucket(now.date(), thresholds, default_secs, short_abandon_secs, fcr_window_days)
            refresh_daily_bucket(
                (now - timedelta(days=1)).date(),
                thresholds, default_secs, short_abandon_secs, fcr_window_days
            )

            log.debug(f"analytics: aggregation cycle complete ({now.strftime('%H:%M')})")

            # Daily housekeeping: prune device tokens not refreshed in 90+ days.
            global _last_prune_day
            if _prune_stale_tokens and now.date() != _last_prune_day:
                await asyncio.to_thread(_prune_stale_tokens)
                _last_prune_day = now.date()

        except Exception as e:
            log.warning(f"analytics: aggregation loop error: {e}")

        await asyncio.sleep(900)  # 15 minutes
