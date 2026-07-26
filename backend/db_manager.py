#!/usr/bin/env python3
"""
List all Asterisk/FreePBX users from the database.

Configuration (via .env):
    DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME
"""

import hashlib
import logging
import os
from typing import Any, Optional, List
from dotenv import load_dotenv

try:
    from dialplan import reload_asterisk_sip
except ImportError:
    reload_asterisk_sip = None

load_dotenv()
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
log = logging.getLogger(__name__)

try:
    import mysql.connector
    from mysql.connector import Error
except ImportError:
    log.error("❌ mysql-connector-python not installed.")
    log.error("   Run: pip install mysql-connector-python")
    exit(1)


def get_db_config(password,database):
    """Get database configuration from environment variables."""
    return {
        'host': os.getenv('DB_HOST', 'localhost'),
        'port': int(os.getenv('DB_PORT', '3306')),
        'user': os.getenv('DB_USER', 'root'),
        'password':password,
        'database': database
    }



def get_extensions_from_db():
    """Get list of extension numbers from the PBX database.

    Returns a list on success (possibly empty when the PBX genuinely has no
    extensions), or ``None`` when the DB could not be read at all. Callers use the
    None-vs-[] distinction to avoid pruning local state on a transient read failure.
    """
    config = get_db_config(os.getenv('DB_PASSWORD', ''),os.getenv('DB_NAME', 'asterisk'))
    extensions = []
    read_ok = False
    conn = None
    cursor = None

    try:
        conn = mysql.connector.connect(**config)
        cursor = conn.cursor(dictionary=True)

        # Try FreePBX users table first
        try:
            cursor.execute("SELECT extension FROM users ORDER BY extension")
            users = cursor.fetchall()
            extensions = [str(u['extension']) for u in users if u['extension']]
            read_ok = True
        except Error:
            pass

        # If no extensions found, try PJSIP endpoints
        if not extensions:
            try:
                cursor.execute("SELECT id FROM ps_endpoints WHERE id REGEXP '^[0-9]+$' ORDER BY CAST(id AS UNSIGNED)")
                endpoints = cursor.fetchall()
                extensions = [str(e['id']) for e in endpoints if e['id']]
                read_ok = True
            except Error:
                pass

    except Error as e:
        log.warning(f"⚠️  Database error getting extensions: {e}")
    finally:
        _safe_close(cursor, conn)

    # Neither source query succeeded → signal a read failure, not an empty PBX.
    if not read_ok:
        return None
    return extensions

def get_extension_names_from_db() -> dict:
    """Get extension names mapping (extension -> name) from the database."""
    config = get_db_config(os.getenv('DB_PASSWORD', ''),os.getenv('DB_NAME', 'asterisk'))
    extension_names = {}

    try:
        conn = mysql.connector.connect(**config)
        cursor = conn.cursor(dictionary=True)

        # Try FreePBX users table first (name field)
        try:
            cursor.execute("SELECT extension, name FROM users WHERE extension IS NOT NULL ORDER BY extension")
            users = cursor.fetchall()
            for u in users:
                if u['extension']:
                    ext = str(u['extension'])
                    name = u.get('name', '') or ''
                    if name:
                        extension_names[ext] = name
        except Error as e:
            log.debug(f"Could not get names from users table: {e}")

        # Fill in any extension still missing a name from PJSIP endpoints
        # (per-extension fallback, not all-or-nothing — so a partial users.name
        # table still gets topped up from ps_endpoints.description).
        try:
            cursor.execute("SELECT id, description FROM ps_endpoints WHERE id REGEXP '^[0-9]+$' ORDER BY CAST(id AS UNSIGNED)")
            endpoints = cursor.fetchall()
            for e in endpoints:
                if e['id']:
                    ext = str(e['id'])
                    name = e.get('description', '') or ''
                    if name and ext not in extension_names:
                        extension_names[ext] = name
        except Error as e:
            log.debug(f"Could not get names from ps_endpoints table: {e}")

        cursor.close()
        conn.close()

    except Error as e:
        log.warning(f"⚠️  Database error getting extension names: {e}")

    return extension_names

def get_queue_names_from_db() -> dict:
    """Get queue names mapping (queue -> name) from the database."""
    config = get_db_config(os.getenv('DB_PASSWORD', ''),os.getenv('DB_NAME', 'asterisk'))
    queue_names = {}

    try:
        conn = mysql.connector.connect(**config)
        cursor = conn.cursor(dictionary=True)

        # Try FreePBX users table first (name field)
        try:
            cursor.execute("SELECT extension, descr FROM queues_config WHERE extension IS NOT NULL ORDER BY extension")
            users = cursor.fetchall()
            for u in users:
                if u['extension']:
                    ext = str(u['extension'])
                    name = u.get('descr', '') or ''
                    if name:
                        queue_names[ext] = name
        except Error as e:
            log.debug(f"Could not get names from users table: {e}")

        cursor.close()
        conn.close()

    except Error as e:
        log.warning(f"⚠️  Database error getting extension names: {e}")

    return queue_names


def get_extension_secret_from_db(extension):
    """Get extension secret from the database."""
    config = get_db_config(os.getenv('DB_PASSWORD', ''),os.getenv('DB_NAME', 'asterisk'))
    secret = None

    try:
        conn = mysql.connector.connect(**config)
        cursor = conn.cursor(dictionary=True)

        try:
            cursor.execute("SELECT data FROM sip WHERE id = %s and keyword = 'secret'", (extension,))
            rows = cursor.fetchall()
            secret = rows[0]['data'] if rows else None
        except Error as e:
            log.debug(f"Could not get extension secret from database: {e}")

        cursor.close()
        conn.close()

    except Error as e:
        log.warning(f"⚠️  Database error getting extension secret: {e}")

    return secret


def _upsert_sip_keyword(extension: str, keyword: str, value: str) -> bool:
    """Insert or update a keyword row in the Asterisk sip table for an extension."""
    config = get_db_config(os.getenv('DB_PASSWORD', ''), os.getenv('DB_NAME', 'asterisk'))
    try:
        conn = mysql.connector.connect(**config)
        cursor = conn.cursor()
        cursor.execute(
            "UPDATE sip SET data = %s WHERE id = %s AND keyword = %s",
            (value, extension, keyword),
        )
        if cursor.rowcount == 0:
            cursor.execute(
                "INSERT INTO sip (id, keyword, data) VALUES (%s, %s, %s)",
                (extension, keyword, value),
            )
        conn.commit()
        cursor.close()
        conn.close()
        return True
    except Error as e:
        log.warning(f"⚠️  Database error _upsert_sip_keyword ({keyword}): {e}")
        return False


def set_extension_secret_in_pbx(extension: str, secret: str) -> bool:
    """Update the SIP secret for an extension in the Asterisk DB."""
    return _upsert_sip_keyword(extension, 'secret', secret)


def set_extension_username_in_pbx(extension: str, username: str) -> bool:
    """Update the SIP username for an extension in the Asterisk DB."""
    return _upsert_sip_keyword(extension, 'username', username)


def set_extension_name_in_pbx(extension: str, name: str) -> bool:
    """Update the display name for an extension in the Asterisk users table."""
    config = get_db_config(os.getenv('DB_PASSWORD', ''), os.getenv('DB_NAME', 'asterisk'))
    try:
        conn = mysql.connector.connect(**config)
        cursor = conn.cursor()
        cursor.execute(
            "UPDATE users SET name = %s WHERE extension = %s",
            (name, extension),
        )
        conn.commit()
        cursor.close()
        conn.close()
        return True
    except Error as e:
        log.warning(f"⚠️  Database error set_extension_name_in_pbx: {e}")
        return False


def get_extensions_with_webrtc_from_users() -> list:
    """Only source for listing extensions in WebRTC tab. OpDesk users with an extension; unique by extension. Returns [{ extension, name, webrtc }, ...]."""
    config = get_db_config(os.getenv('DB_PASSWORD', ''), os.getenv('DB_OpDesk', 'OpDesk'))
    seen = set()
    out = []
    try:
        conn = mysql.connector.connect(**config)
        cursor = conn.cursor(dictionary=True)
        cursor.execute(
            "SELECT extension, name, COALESCE(webrtc, 'no') AS webrtc FROM users WHERE extension IS NOT NULL AND extension != '' ORDER BY extension"
        )
        for row in cursor.fetchall():
            ext = row.get('extension')
            if not ext:
                continue
            ext = str(ext)
            if ext in seen:
                continue
            seen.add(ext)
            out.append({
                'extension': ext,
                'name': (row.get('name') or '').strip() or ext,
                'webrtc': (row.get('webrtc') or 'no').strip().lower(),
            })
        cursor.close()
        conn.close()
    except Error as e:
        log.warning(f"get_extensions_with_webrtc_from_users: {e}")
    return out


def set_extension_webrtc(extension: str, enabled: bool, PBX: str) -> bool:
    """
    Single place for enable/disable and SIP options.
    - FreePBX: rtcp_mux, avpf, icesupport, media_encryption + certman_mapping.
    - Issabel: allow, dtls_cert_file, dtls_private_key, dtls_verify, ice_support, media_encryption, use_avpf, rtcp_mux.
    Updates OpDesk users.webrtc and Asterisk sip accordingly. Only extensions from users (same as list) can be set.
    """
    ext = str(extension).strip()
    if not ext:
        return False
    webrtc_val = 'yes' if enabled else 'no'
    is_issabel = (PBX or '').strip().lower() == 'issabel'

    # Enable/disable: OpDesk users.webrtc only
    opdesk_config = get_db_config(os.getenv('DB_PASSWORD', ''), os.getenv('DB_OpDesk', 'OpDesk'))
    try:
        conn = mysql.connector.connect(**opdesk_config)
        cursor = conn.cursor()
        cursor.execute("UPDATE users SET webrtc = %s WHERE extension = %s", (webrtc_val, ext))
        if cursor.rowcount == 0:
            cursor.close()
            conn.close()
            return False  # Extension not in users (same as list; no duplicate path)
        conn.commit()
        cursor.close()
        conn.close()
    except Error as err:
        log.warning(f"set_extension_webrtc users ({ext}): {err}")
        return False

    config = get_db_config(os.getenv('DB_PASSWORD', ''), os.getenv('DB_NAME', 'asterisk'))
    try:
        conn = mysql.connector.connect(**config)
        cursor = conn.cursor()
        updated = 0

        if is_issabel:
            # Issabel: allow, dtls_cert_file, dtls_private_key, dtls_verify, ice_support, media_encryption, use_avpf, rtcp_mux
            if enabled:
                sip_pairs = [
                    ('allow', 'ulaw,alaw,g722,gsm,vp9,vp8,h264,opus'),
                    ('dtls_cert_file', '/etc/asterisk/keys/asterisk.pem'),
                    ('dtls_private_key', '/etc/asterisk/keys/asterisk.pem'),
                    ('dtls_verify', 'fingerprint'),
                    ('ice_support', 'yes'),
                    ('media_encryption', 'dtls'),
                    ('use_avpf', 'yes'),
                    ('rtcp_mux', 'yes'),
                    ('transport', 'transport-wss')
                ]
            else:
                sip_pairs = [
                    ('allow', ''),
                    ('dtls_cert_file', ''),
                    ('dtls_private_key', ''),
                    ('dtls_verify', 'no'),
                    ('ice_support', 'no'),
                    ('media_encryption', 'no'),
                    ('use_avpf', 'no'),
                    ('rtcp_mux', 'no'),
                    ('transport', 'transport-udp')
                ]
            for keyword, value in sip_pairs:
                cursor.execute(
                    "UPDATE sip SET data = %s WHERE id = %s AND keyword = %s",
                    (value, ext, keyword),
                )
                if cursor.rowcount == 0:
                    cursor.execute(
                        "INSERT INTO sip (id, keyword, data) VALUES (%s, %s, %s)",
                        (ext, keyword, value),
                    )
                updated += cursor.rowcount
            if updated:
                log.info(f"Updated WebRTC for extension {ext} (Issabel): users.webrtc={webrtc_val}")
        else:
            # FreePBX: rtcp_mux, avpf, icesupport, media_encryption + certman_mapping
            if enabled:
                r = a = i = 'yes'
                e = 'dtls'
            else:
                r = a = i = 'no'
                e = 'no'
            for keyword, value in [
                ('rtcp_mux', r),
                ('avpf', a),
                ('icesupport', i),
                ('media_encryption', e),
            ]:
                cursor.execute(
                    "UPDATE sip SET data = %s WHERE id = %s AND keyword = %s",
                    (value, ext, keyword),
                )
                updated += cursor.rowcount
            if enabled:
                cursor.execute(
                    "REPLACE INTO certman_mapping (id, cid, verify, setup, rekey, auto_generate_cert) VALUES (%s, 2, 'fingerprint', 'actpass', 0, 0)",
                    (ext,),
                )
            else:
                cursor.execute("DELETE FROM certman_mapping WHERE id = %s", (ext,))
            if updated:
                log.info(f"Updated WebRTC for extension {ext}: users.webrtc={webrtc_val}, rtcp_mux={r}, avpf={a}, icesupport={i}, media_encryption={e}")

        conn.commit()
        cursor.close()
        conn.close()
        if updated and reload_asterisk_sip:
            reload_asterisk_sip(PBX)
        return True
    except Error as err:
        log.warning(f"set_extension_webrtc sip/certman ({ext}): {err}")
        return True  # users.webrtc was set

def get_cdr_by_linkedid(linkedid):
    """
    Fetch CDR rows for a given linkedid. Returns list of dicts or [] on error.
    """
    conn = None
    config = get_db_config(os.getenv('DB_PASSWORD', ''),os.getenv('DB_CDR', ''))
    try:
        conn = mysql.connector.connect(**config)
        cursor = conn.cursor(dictionary=True)
        query = """
        SELECT calldate, billsec, duration, disposition, src, dst, dcontext, channel, dstchannel, lastapp
        FROM cdr
        WHERE linkedid = %s
        """
        cursor.execute(query, (linkedid,))
        return cursor.fetchall()
    except mysql.connector.Error as e:
        print(f"Database error: {e}")
        return []
    finally:
        if conn is not None and conn.is_connected():
            cursor.close()
            conn.close()

def get_call_log_from_db(limit: int = None, date: str = None,
                         date_from: str = None, date_to: str = None,
                         allowed_extensions: Optional[List[str]] = None,
                         search: str = None) -> list:
    """
    Get call log data from the database.
    
    Args:
        limit: Maximum number of records to return (optional)
        date: Filter by exact date in format 'YYYY-MM-DD' (optional, legacy)
        date_from: Filter from this date inclusive, format 'YYYY-MM-DD' (optional)
        date_to: Filter up to this date inclusive, format 'YYYY-MM-DD' (optional)
        allowed_extensions: If set, only return calls where destination agent (from dstchannel) is in this list.
    
    Returns:
        List of CDR records as dictionaries
    """
    config = get_db_config(os.getenv('DB_PASSWORD', ''),os.getenv('DB_CDR', ''))
    data = []

    try:
        conn = mysql.connector.connect(**config)
        cursor = conn.cursor(dictionary=True)

        # Build the base query: first leg (min sequence) + last leg (max sequence) per linkedid,
        # with call_app derived from dcontext (queue/ivr/direct) and leg count for call journey.
        query = """
            SELECT
                first_leg.calldate,
                first_leg.src,
                first_leg.dst          AS dst,
                first_leg.dcontext     AS dcontext,
                last_leg.dst           AS answered_by,
                last_leg.channel      AS channel,
                last_leg.dstchannel    AS dstchannel,
                last_leg.lastapp,
                last_leg.duration,
                last_leg.billsec,
                last_leg.disposition,
                first_leg.channel,
                first_leg.recordingfile,
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
                        GROUP BY linkedid
                    ) x ON c.linkedid = x.linkedid AND c.sequence = x.min_seq
                ) first_leg
            JOIN (
                    SELECT c.*
                    FROM cdr c
                    JOIN (
                        SELECT linkedid, MAX(sequence) AS max_seq
                        FROM cdr
                        GROUP BY linkedid
                    ) x ON c.linkedid = x.linkedid AND c.sequence = x.max_seq
                ) last_leg ON first_leg.linkedid = last_leg.linkedid
            JOIN (
                SELECT linkedid, COUNT(*) AS total_legs
                FROM cdr
                GROUP BY linkedid
            ) leg_count ON first_leg.linkedid = leg_count.linkedid
        """
        
        # Build WHERE conditions (use first_leg for calldate/src, last_leg for dstchannel)
        conditions = []
        params = []
        
        if date:
            conditions.append("DATE(first_leg.calldate) = %s")
            params.append(date)
        if date_from:
            conditions.append("DATE(first_leg.calldate) >= %s")
            params.append(date_from)
        if date_to:
            conditions.append("DATE(first_leg.calldate) <= %s")
            params.append(date_to)
        # Filter by agent extension.
        # Include calls where the agent is either:
        #   - the destination leg (from dstchannel: part after '/' and before '-', e.g. SIP/1001-xxx -> 1001), OR
        #   - the source (first_leg.src = agent extension)
        if allowed_extensions is not None:
            if not allowed_extensions:
                conditions.append("1 = 0")
            else:
                placeholders = ", ".join(["%s"] * len(allowed_extensions))
                conditions.append(
                    "("
                    "SUBSTRING_INDEX(SUBSTRING_INDEX(last_leg.dstchannel, '-', 1), '/', -1) IN (" + placeholders + ") "
                    "OR first_leg.src IN (" + placeholders + ")"
                    ")"
                )
                params.extend(allowed_extensions)
                params.extend(allowed_extensions)

        # Free-text search across caller/destination and call ids (whole-history search).
        if search:
            like = f"%{search.strip()}%"
            conditions.append(
                "("
                "first_leg.src LIKE %s OR first_leg.dst LIKE %s OR last_leg.dst LIKE %s "
                "OR first_leg.uniqueid LIKE %s OR first_leg.linkedid LIKE %s"
                ")"
            )
            params.extend([like, like, like, like, like])

        if conditions:
            query += " WHERE " + " AND ".join(conditions)
        
        # Add ordering by calldate (most recent first)
        query += " ORDER BY first_leg.calldate DESC"
        
        # Add limit if provided (validate it's a positive integer)
        if limit:
            if not isinstance(limit, int) or limit <= 0:
                raise ValueError("limit must be a positive integer")
            query += " LIMIT %s"
            params.append(limit)

        # Execute query with parameters
        cursor.execute(query, tuple(params) if params else None)
        
        data = cursor.fetchall()

        cursor.close()
        conn.close()

    except Error as e:
        log.warning(f"⚠️  Database error getting call log: {e}")

    return data


def get_call_log_count_from_db(date: str = None,
                                date_from: str = None, date_to: str = None,
                                allowed_extensions: Optional[List[str]] = None,
                                search: str = None) -> int:
    """
    Get total count of call log rows with the same filters as get_call_log_from_db
    (same JOIN/WHERE, no limit). Used so UI can show total calls beyond the fetch limit.
    """
    config = get_db_config(os.getenv('DB_PASSWORD', ''), os.getenv('DB_CDR', ''))
    try:
        conn = mysql.connector.connect(**config)
        cursor = conn.cursor(dictionary=True)

        # Fast path: COUNT(DISTINCT linkedid) is orders of magnitude faster than
        # the triple self-join on large CDR tables (tested: 1.3 s vs timeout on
        # 410 K rows in MariaDB 5.5).  Each unique linkedid represents one call
        # group, so the count is semantically equivalent.
        conditions: list = []
        params: list = []

        if date:
            conditions.append("DATE(calldate) = %s")
            params.append(date)
        if date_from:
            conditions.append("DATE(calldate) >= %s")
            params.append(date_from)
        if date_to:
            conditions.append("DATE(calldate) <= %s")
            params.append(date_to)

        if allowed_extensions is not None:
            if not allowed_extensions:
                # No allowed extensions → zero results immediately.
                cursor.close()
                conn.close()
                return 0
            placeholders = ", ".join(["%s"] * len(allowed_extensions))
            conditions.append(
                "("
                "SUBSTRING_INDEX(SUBSTRING_INDEX(dstchannel, '-', 1), '/', -1) IN (" + placeholders + ") "
                "OR src IN (" + placeholders + ")"
                ")"
            )
            params.extend(allowed_extensions)
            params.extend(allowed_extensions)

        if search:
            like = f"%{search.strip()}%"
            conditions.append("(src LIKE %s OR dst LIKE %s OR uniqueid LIKE %s OR linkedid LIKE %s)")
            params.extend([like, like, like, like])

        where_clause = (" WHERE " + " AND ".join(conditions)) if conditions else ""
        query = "SELECT COUNT(DISTINCT linkedid) AS cnt FROM cdr" + where_clause

        cursor.execute(query, tuple(params) if params else None)
        row = cursor.fetchone()
        cursor.close()
        conn.close()
        return (row or {}).get("cnt", 0) or 0
    except Error as e:
        log.warning(f"⚠️  Database error getting call log count: {e}")
        return 0


def insert_call_notification(
    extension: str,
    caller_from: Optional[str] = None,
    queue: Optional[str] = None,
    call_id: Optional[str] = None,
    reason: Optional[str] = None,
) -> Optional[int]:
    """
    Insert a call notification (OpDesk DB). Called from AMI on hangup.
    reason: e.g. busy, noanswer, failed. Returns new id or None on error.
    """
    config = get_db_config(os.getenv('DB_PASSWORD', ''), os.getenv('DB_OpDesk', 'OpDesk'))
    try:
        conn = mysql.connector.connect(**config)
        cursor = conn.cursor()
        cursor.execute(
            """INSERT INTO call_notifications (extension, caller_from, queue, call_id, reason)
               VALUES (%s, %s, %s, %s, %s)""",
            (extension, caller_from or None, queue or None, call_id or None, reason or None),
        )
        conn.commit()
        nid = cursor.lastrowid
        cursor.close()
        conn.close()
        return nid
    except Error as e:
        log.warning(f"⚠️  Database error inserting call notification: {e}")
        return None


def upsert_call_vad(
    uniqueid: str,
    base: str = None,
    duration: float = None,
    sp1_talk_seconds: float = None,
    sp2_talk_seconds: float = None,
    overlap_seconds: float = None,
    sp1_segments: int = None,
    sp2_segments: int = None,
    segments_json: str = None,
) -> bool:
    """
    Store (or replace) the VAD analysis for one call in the OpDesk DB, keyed by uniqueid.
    Called from vad_runner after the recording legs are analysed. Idempotent on uniqueid.
    """
    if not uniqueid:
        return False
    config = get_db_config(os.getenv('DB_PASSWORD', ''), os.getenv('DB_OpDesk', 'OpDesk'))
    conn = None
    cursor = None
    try:
        conn = mysql.connector.connect(**config)
        cursor = conn.cursor()
        cursor.execute(
            """INSERT INTO call_vad
                   (uniqueid, base, duration, sp1_talk_seconds, sp2_talk_seconds,
                    overlap_seconds, sp1_segments, sp2_segments, segments)
               VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
               ON DUPLICATE KEY UPDATE
                   base=VALUES(base), duration=VALUES(duration),
                   sp1_talk_seconds=VALUES(sp1_talk_seconds),
                   sp2_talk_seconds=VALUES(sp2_talk_seconds),
                   overlap_seconds=VALUES(overlap_seconds),
                   sp1_segments=VALUES(sp1_segments), sp2_segments=VALUES(sp2_segments),
                   segments=VALUES(segments)""",
            (uniqueid, base, duration, sp1_talk_seconds, sp2_talk_seconds,
             overlap_seconds, sp1_segments, sp2_segments, segments_json),
        )
        conn.commit()
        return True
    except Error as e:
        log.warning(f"⚠️  Database error upserting call_vad ({uniqueid}): {e}")
        return False
    finally:
        if cursor:
            cursor.close()
        if conn:
            conn.close()


def get_call_vad_from_db(uniqueid: str) -> Optional[dict]:
    """Fetch VAD analysis for a single call by uniqueid. Returns None if not found."""
    if not uniqueid:
        return None
    config = get_db_config(os.getenv('DB_PASSWORD', ''), os.getenv('DB_OpDesk', 'OpDesk'))
    conn = None
    cursor = None
    try:
        conn = mysql.connector.connect(**config)
        cursor = conn.cursor(dictionary=True)
        cursor.execute(
            "SELECT * FROM call_vad WHERE uniqueid = %s LIMIT 1",
            (uniqueid,),
        )
        row = cursor.fetchone()
        return dict(row) if row else None
    except Error as e:
        log.warning(f"DB error fetching call_vad ({uniqueid}): {e}")
        return None
    finally:
        if cursor:
            cursor.close()
        if conn:
            conn.close()


def get_call_notifications_from_db(
    extension: Optional[str] = None,
    status_flag: Optional[str] = None,
    limit: int = 200,
) -> List[dict]:
    """
    Get call notifications from OpDesk DB. Filter by extension and/or status (new, read, archived).
    """
    config = get_db_config(os.getenv('DB_PASSWORD', ''), os.getenv('DB_OpDesk', 'OpDesk'))
    data = []
    try:
        conn = mysql.connector.connect(**config)
        cursor = conn.cursor(dictionary=True)
        conditions = []
        params: List[Any] = []
        if extension is not None:
            conditions.append("extension = %s")
            params.append(extension)
        if status_flag is not None:
            conditions.append("status_flag = %s")
            params.append(status_flag)
        where = (" WHERE " + " AND ".join(conditions)) if conditions else ""
        query = f"SELECT id, extension, caller_from, queue, status_flag, event_time, call_id, reason FROM call_notifications{where} ORDER BY event_time DESC LIMIT %s"
        params.append(limit)
        cursor.execute(query, tuple(params))
        data = cursor.fetchall()
        if data:
            for row in data:
                if row.get("event_time"):
                    row["event_time"] = row["event_time"].isoformat() if hasattr(row["event_time"], "isoformat") else str(row["event_time"])
        cursor.close()
        conn.close()
    except Error as e:
        log.warning(f"⚠️  Database error getting call notifications: {e}")
    return data


def get_call_notification_by_id(notification_id: int) -> Optional[dict]:
    """Get a single call notification by id. Returns None if not found."""
    config = get_db_config(os.getenv('DB_PASSWORD', ''), os.getenv('DB_OpDesk', 'OpDesk'))
    try:
        conn = mysql.connector.connect(**config)
        cursor = conn.cursor(dictionary=True)
        cursor.execute(
            "SELECT id, extension, caller_from, queue, status_flag, event_time, call_id, reason FROM call_notifications WHERE id = %s",
            (notification_id,),
        )
        row = cursor.fetchone()
        cursor.close()
        conn.close()
        if row and row.get("event_time"):
            row["event_time"] = row["event_time"].isoformat() if hasattr(row["event_time"], "isoformat") else str(row["event_time"])
        return row
    except Error as e:
        log.warning(f"⚠️  Database error getting call notification: {e}")
        return None


def update_call_notification_status(notification_id: int, status_flag: str) -> bool:
    """Update a call notification's status (read or archived). Returns True on success."""
    if status_flag not in ("new", "read", "archived"):
        return False
    config = get_db_config(os.getenv('DB_PASSWORD', ''), os.getenv('DB_OpDesk', 'OpDesk'))
    try:
        conn = mysql.connector.connect(**config)
        cursor = conn.cursor()
        cursor.execute(
            "UPDATE call_notifications SET status_flag = %s WHERE id = %s",
            (status_flag, notification_id),
        )
        conn.commit()
        ok = cursor.rowcount > 0
        cursor.close()
        conn.close()
        return ok
    except Error as e:
        log.warning(f"⚠️  Database error updating call notification: {e}")
        return False


# =============================================================================
# Device push tokens (FCM / APNs) — used to wake mobile softphones for calls.
# =============================================================================

def _token_hash(token: str) -> str:
    """SHA-256 of a push token, used as the unique key (token itself is too long for an index)."""
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def register_device_token(
    user_id: int,
    extension: Optional[str],
    platform: str,
    token_type: str,
    token: str,
    app_version: Optional[str] = None,
) -> bool:
    """
    Register (upsert) a device push token in the OpDesk DB. Idempotent: re-registering the same
    token updates its owner/extension and last_seen_at instead of creating a duplicate.
    platform: 'ios' | 'android' | 'web'. token_type: 'voip' (iOS PushKit) | 'alert'
    (regular APNs/FCM, and Web Push). For platform='web' the `token` column holds the
    JSON-encoded Web Push subscription ({endpoint, keys:{p256dh, auth}}).
    """
    if platform not in ("ios", "android", "web") or token_type not in ("voip", "alert") or not token:
        return False
    config = get_db_config(os.getenv('DB_PASSWORD', ''), os.getenv('DB_OpDesk', 'OpDesk'))
    try:
        conn = mysql.connector.connect(**config)
        cursor = conn.cursor()
        cursor.execute(
            """INSERT INTO device_tokens
                   (user_id, extension, platform, token_type, token, token_hash, app_version)
               VALUES (%s, %s, %s, %s, %s, %s, %s)
               ON DUPLICATE KEY UPDATE
                   user_id = VALUES(user_id),
                   extension = VALUES(extension),
                   platform = VALUES(platform),
                   token_type = VALUES(token_type),
                   app_version = VALUES(app_version),
                   last_seen_at = CURRENT_TIMESTAMP""",
            (user_id, extension or None, platform, token_type, token, _token_hash(token), app_version or None),
        )
        conn.commit()
        cursor.close()
        conn.close()
        return True
    except Error as e:
        log.warning(f"⚠️  Database error registering device token: {e}")
        return False


def delete_device_token(token: str) -> bool:
    """Delete a device token (on logout, or when a push provider reports it as stale/unregistered)."""
    if not token:
        return False
    config = get_db_config(os.getenv('DB_PASSWORD', ''), os.getenv('DB_OpDesk', 'OpDesk'))
    try:
        conn = mysql.connector.connect(**config)
        cursor = conn.cursor()
        cursor.execute("DELETE FROM device_tokens WHERE token_hash = %s", (_token_hash(token),))
        conn.commit()
        ok = cursor.rowcount > 0
        cursor.close()
        conn.close()
        return ok
    except Error as e:
        log.warning(f"⚠️  Database error deleting device token: {e}")
        return False


def get_device_tokens_for_extension(
    extension: str,
    token_type: Optional[str] = None,
) -> List[dict]:
    """
    Get registered device tokens for an extension. Optionally filter by token_type
    ('voip' for incoming-call wake, 'alert' for missed-call banners).
    Returns rows of {token, platform, token_type}.
    """
    if not extension:
        return []
    config = get_db_config(os.getenv('DB_PASSWORD', ''), os.getenv('DB_OpDesk', 'OpDesk'))
    data: List[dict] = []
    try:
        conn = mysql.connector.connect(**config)
        cursor = conn.cursor(dictionary=True)
        query = "SELECT token, platform, token_type FROM device_tokens WHERE extension = %s"
        params: List[Any] = [extension]
        if token_type is not None:
            query += " AND token_type = %s"
            params.append(token_type)
        cursor.execute(query, tuple(params))
        data = cursor.fetchall()
        cursor.close()
        conn.close()
    except Error as e:
        log.warning(f"⚠️  Database error getting device tokens: {e}")
    return data


def prune_stale_device_tokens(days: int = 90) -> int:
    """Delete device tokens not refreshed in `days` days. Returns the number of rows deleted."""
    config = get_db_config(os.getenv('DB_PASSWORD', ''), os.getenv('DB_OpDesk', 'OpDesk'))
    try:
        conn = mysql.connector.connect(**config)
        cursor = conn.cursor()
        cursor.execute(
            "DELETE FROM device_tokens WHERE last_seen_at < NOW() - INTERVAL %s DAY", (days,)
        )
        conn.commit()
        count = cursor.rowcount
        cursor.close()
        conn.close()
        if count:
            log.info(f"Pruned {count} stale device token(s) (not seen in {days}+ days)")
        return count
    except Error as e:
        log.warning(f"⚠️  Database error pruning stale device tokens: {e}")
        return 0


def check_database_exists(db_name: str) -> bool:
    """Check if a database exists."""
    config_no_db = get_db_config(os.getenv('DB_PASSWORD'),os.getenv('DB_OpDesk', 'OpDesk')).copy()
    config_no_db.pop('database')
    
    try:
        conn = mysql.connector.connect(**config_no_db)
        cursor = conn.cursor()
        cursor.execute("SHOW DATABASES LIKE %s", (db_name,))
        result = cursor.fetchone()
        cursor.close()
        conn.close()
        return result is not None
    except Error as e:
        log.error(f"❌ Failed to check if database exists: {e}")
        return False


def execute_sql_file(sql_file_path: str) -> bool:
    """Execute SQL commands from a file."""
    config_no_db = get_db_config(os.getenv('DB_PASSWORD'),os.getenv('DB_OpDesk', 'OpDesk')).copy()
    config_no_db.pop('database')
    
    try:
        # Read SQL file
        with open(sql_file_path, 'r', encoding='utf-8') as f:
            sql_content = f.read()
        
        # Connect without database specified
        conn = mysql.connector.connect(**config_no_db)
        cursor = conn.cursor()
        
        # Split SQL content by semicolons and execute each statement
        # Filter out empty statements, comments, and blank lines
        statements = []
        for line in sql_content.split('\n'):
            line = line.strip()
            # Skip empty lines and full-line comments
            if not line or line.startswith('--'):
                continue
            statements.append(line)
        
        # Join statements and split by semicolon
        full_sql = ' '.join(statements)
        sql_statements = [s.strip() for s in full_sql.split(';') if s.strip()]
        
        for statement in sql_statements:
            if statement:
                try:
                    cursor.execute(statement)
                except Error as e:
                    log.warning(f"⚠️  SQL execution warning for statement '{statement[:50]}...': {e}")
        
        conn.commit()
        cursor.close()
        conn.close()
        
        return True
        
    except FileNotFoundError:
        log.error(f"❌ SQL file not found: {sql_file_path}")
        return False
    except Error as e:
        log.error(f"❌ Failed to execute SQL file: {e}")
        return False
    except Exception as e:
        log.error(f"❌ Unexpected error executing SQL file: {e}")
        return False


def init_settings_table():
    """Check if OpDesk database exists, and if not, create it from schema.sql."""
    # Check if OpDesk database exists
    if check_database_exists('OpDesk'):
        log.info("✅ OpDesk database already exists")
        try:
            config = get_db_config(os.getenv('DB_PASSWORD'),os.getenv('DB_OpDesk', 'OpDesk'))
            conn = mysql.connector.connect(**config)
            cursor = conn.cursor()
            cursor.execute("SHOW TABLES LIKE 'OpDesk_settings'")
            if not cursor.fetchone():
                log.info("📋 Creating OpDesk_settings table...")
                cursor.execute("""
                    CREATE TABLE IF NOT EXISTS OpDesk_settings (
                        setting_key VARCHAR(191) PRIMARY KEY,
                        setting_value TEXT,
                        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
                    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
                """)
                conn.commit()
                log.info("✅ OpDesk_settings table created")

            admin_hash_path = os.path.join(os.path.dirname(__file__), '.admin_init_hash')
            if os.path.exists(admin_hash_path):
                with open(admin_hash_path, 'r') as f:
                    pw_hash = f.read().strip()
                if pw_hash:
                    cursor.execute(
                        "UPDATE users SET password_hash = %s WHERE username = 'admin'",
                        (pw_hash,),
                    )
                    conn.commit()
                    os.remove(admin_hash_path)
                    log.info("✅ Admin password applied from installer")

            cursor.close()
            conn.close()
        except Error as e:
            log.warning(f"⚠️  Error checking/creating table: {e}")
        return True
    
    # Database doesn't exist, create it from schema.sql
    log.info("📋 OpDesk database not found. Creating from schema.sql...")
    
    # Get path to schema.sql file
    schema_path = os.path.join(os.path.dirname(__file__), 'schema.sql')
    
    if not os.path.exists(schema_path):
        log.error(f"❌ Schema file not found: {schema_path}")
        return False
    
    # Execute schema.sql to create database and tables
    if execute_sql_file(schema_path):
        try:
            config = get_db_config(os.getenv('DB_PASSWORD'),os.getenv('DB_OpDesk', 'OpDesk'))
            conn = mysql.connector.connect(**config)
            cursor = conn.cursor()
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS OpDesk_settings (
                    setting_key VARCHAR(191) PRIMARY KEY,
                    setting_value TEXT,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
            """)

            admin_hash_path = os.path.join(os.path.dirname(__file__), '.admin_init_hash')
            if os.path.exists(admin_hash_path):
                with open(admin_hash_path, 'r') as f:
                    pw_hash = f.read().strip()
                if pw_hash:
                    cursor.execute(
                        "UPDATE users SET password_hash = %s WHERE username = 'admin'",
                        (pw_hash,),
                    )
                    conn.commit()
                    os.remove(admin_hash_path)
                    log.info("✅ Admin password applied from installer")

            cursor.close()
            conn.close()
            log.info("✅ OpDesk database and tables created successfully from schema.sql")
            return True
        except Error as e:
            log.error(f"❌ Failed to create table after database creation: {e}")
            return False
    else:
        log.error("❌ Failed to create OpDesk database from schema.sql")
        return False


def get_setting(key: str, default: str = None) -> str:
    """
    Get a setting value from the OpDesk database.
    
    Args:
        key: Setting key name
        default: Default value if setting doesn't exist
    
    Returns:
        Setting value or default
    """
    config = get_db_config(os.getenv('DB_PASSWORD'),'OpDesk')
    
    try:
        conn = mysql.connector.connect(**config)
        cursor = conn.cursor(dictionary=True)
        
        cursor.execute("SELECT setting_value FROM OpDesk_settings WHERE setting_key = %s", (key,))
        result = cursor.fetchone()
        
        cursor.close()
        conn.close()
        
        if result:
            return result['setting_value'] or default
        return default
        
    except Error as e:
        log.warning(f"⚠️  Database error getting setting {key}: {e}")
        return default


def set_setting(key: str, value: str) -> bool:
    """
    Set a setting value in the OpDesk database.
    
    Args:
        key: Setting key name
        value: Setting value
    
    Returns:
        True if successful, False otherwise
    """
    config = get_db_config(os.getenv('DB_PASSWORD', ''),os.getenv('DB_OpDesk', 'OpDesk'))
    
    try:
        # Ensure database and table exist
        init_settings_table()
        
        conn = mysql.connector.connect(**config)
        cursor = conn.cursor()
        
        cursor.execute("""
            INSERT INTO OpDesk_settings (setting_key, setting_value)
            VALUES (%s, %s)
            ON DUPLICATE KEY UPDATE setting_value = %s, updated_at = CURRENT_TIMESTAMP
        """, (key, value, value))
        
        conn.commit()
        cursor.close()
        conn.close()
        
        return True
        
    except Error as e:
        log.error(f"❌ Failed to set setting {key}: {e}")
        return False


def get_all_settings() -> dict:
    """
    Get all settings from the OpDesk database.

    Returns:
        Dictionary of all settings
    """
    config = get_db_config(os.getenv('DB_PASSWORD', ''),os.getenv('DB_OpDesk', 'OpDesk'))
    settings = {}

    try:
        conn = mysql.connector.connect(**config)
        cursor = conn.cursor(dictionary=True)

        cursor.execute("SELECT setting_key, setting_value FROM OpDesk_settings")
        results = cursor.fetchall()

        for row in results:
            settings[row['setting_key']] = row['setting_value']

        cursor.close()
        conn.close()

    except Error as e:
        log.warning(f"⚠️  Database error getting all settings: {e}")

    return settings


# ---------------------------------------------------------------------------
# Authentication (users table in OpDesk)
# ---------------------------------------------------------------------------

def get_user_by_username(username: str) -> dict:
    """Get user by username. Returns dict with id, username, extension, name, role, password_hash, is_active or None."""
    config = get_db_config(os.getenv('DB_PASSWORD', ''), os.getenv('DB_OpDesk', 'OpDesk'))
    try:
        conn = mysql.connector.connect(**config)
        cursor = conn.cursor(dictionary=True)
        cursor.execute(
            "SELECT id, username, extension, name, role, password_hash, is_active FROM users WHERE username = %s",
            (username,)
        )
        row = cursor.fetchone()
        cursor.close()
        conn.close()
        return row
    except Error as e:
        log.warning(f"⚠️  Database error get_user_by_username: {e}")
        return None


def get_user_by_extension(extension: str) -> dict:
    """Get user by extension. Returns dict with id, username, extension, name, role, password_hash, is_active or None."""
    if not extension or not str(extension).strip():
        return None
    config = get_db_config(os.getenv('DB_PASSWORD', ''), os.getenv('DB_OpDesk', 'OpDesk'))
    try:
        conn = mysql.connector.connect(**config)
        cursor = conn.cursor(dictionary=True)
        cursor.execute(
            "SELECT id, username, extension, name, role, password_hash, is_active FROM users WHERE extension = %s",
            (str(extension).strip(),)
        )
        row = cursor.fetchone()
        cursor.close()
        conn.close()
        return row
    except Error as e:
        log.warning(f"⚠️  Database error get_user_by_extension: {e}")
        return None


def verify_user_password(password_hash: str, password: str) -> bool:
    """Verify plain password against bcrypt hash."""
    if not password_hash or not password:
        return False
    try:
        import bcrypt
        return bcrypt.checkpw(password.encode('utf-8'), password_hash.encode('utf-8'))
    except Exception as e:
        log.debug(f"Password verify failed: {e}")
        return False


def update_last_login(user_id: int) -> None:
    """Update last_login_at for user."""
    config = get_db_config(os.getenv('DB_PASSWORD', ''), os.getenv('DB_OpDesk', 'OpDesk'))
    try:
        conn = mysql.connector.connect(**config)
        cursor = conn.cursor()
        cursor.execute("UPDATE users SET last_login_at = NOW() WHERE id = %s", (user_id,))
        conn.commit()
        cursor.close()
        conn.close()
    except Error as e:
        log.warning(f"⚠️  Database error update_last_login: {e}")


def authenticate_user(login: str, password: str) -> dict:
    """
    Authenticate by username or extension and password.
    login: username or extension (string).
    Returns user dict (id, username, extension, name, role, no password_hash) or None.
    """
    if not login or not password:
        return None
    login = str(login).strip()
    user = get_user_by_username(login)
    if not user:
        user = get_user_by_extension(login)
    if not user:
        return None
    if not user.get('is_active', 1):
        return None
    if not verify_user_password(user.get('password_hash') or '', password):
        return None
    update_last_login(user['id'])
    return {
        'id': user['id'],
        'username': user['username'],
        'extension': user.get('extension'),
        'name': user.get('name'),
        'role': user['role'],
    }


# ---------------------------------------------------------------------------
# User management (admin): list, create, update, delete, agents/queues
# ---------------------------------------------------------------------------

def get_all_users() -> list:
    """Get all users (id, username, extension, name, role, is_active, monitor_modes). No password_hash."""
    config = get_db_config(os.getenv('DB_PASSWORD', ''), os.getenv('DB_OpDesk', 'OpDesk'))
    try:
        conn = mysql.connector.connect(**config)
        cursor = conn.cursor(dictionary=True)
        cursor.execute(
            "SELECT id, username, extension, name, role, is_active FROM users ORDER BY username"
        )
        rows = cursor.fetchall()
        cursor.close()
        conn.close()
        out = []
        for r in rows:
            d = dict(r)
            d['monitor_modes'] = get_user_monitor_modes(d['id'])
            out.append(d)
        return out
    except Error as e:
        log.warning(f"⚠️  Database error get_all_users: {e}")
        return []


def create_user(username: str, password: str, name: str = None, extension: str = None,
                role: str = 'supervisor', monitor_mode: str = 'listen',
                monitor_modes: list = None) -> Optional[int]:
    """Create user. Returns new user id or None on error/duplicate. monitor_modes: optional list ['listen','whisper','barge']."""
    if not username or not username.strip():
        return None
    username = username.strip()
    if get_user_by_username(username):
        return None
    if extension is not None and str(extension).strip():
        ext = str(extension).strip()
        if get_user_by_extension(ext):
            return None
    try:
        import bcrypt
        password_hash = bcrypt.hashpw((password or '').encode('utf-8'), bcrypt.gensalt()).decode('utf-8')
    except Exception as e:
        log.warning(f"Password hash failed: {e}")
        return None
    config = get_db_config(os.getenv('DB_PASSWORD', ''), os.getenv('DB_OpDesk', 'OpDesk'))
    try:
        conn = mysql.connector.connect(**config)
        cursor = conn.cursor()
        cursor.execute(
            "INSERT INTO users (username, extension, password_hash, name, role) "
            "VALUES (%s, %s, %s, %s, %s)",
            (username, (extension or '').strip() or None, password_hash, (name or '').strip() or None,
             role if role in ('admin', 'supervisor', 'agent') else 'supervisor')
        )
        user_id = cursor.lastrowid
        conn.commit()
        cursor.close()
        conn.close()
        if monitor_modes is not None:
            set_user_monitor_modes(user_id, monitor_modes)
        else:
            mode_col = monitor_mode or 'listen'
            set_user_monitor_modes(user_id, [mode_col])
        return user_id
    except Error as e:
        log.warning(f"⚠️  Database error create_user: {e}")
        return None


def update_user(user_id: int | None = None, username: str = None, name: str = None, extension: str = None, role: str = None,
                is_active: bool = None, monitor_mode: str = None, monitor_modes: list = None,
                password: str = None) -> bool:
    """Update user. password optional (new hash). monitor_modes: optional list to set multiple modes. Returns True on success."""
    config = get_db_config(os.getenv('DB_PASSWORD', ''), os.getenv('DB_OpDesk', 'OpDesk'))
    try:
        conn = mysql.connector.connect(**config)
        cursor = conn.cursor(dictionary=True)

        updates = []
        params = []
        if username is not None:
            updates.append("username = %s")
            params.append(username.strip())
        if name is not None:
            updates.append("name = %s")
            params.append((name or '').strip() or None)
        if extension is not None:
            updates.append("extension = %s")
            params.append((str(extension).strip() or None))
        if role is not None and role in ('admin', 'supervisor', 'agent'):
            updates.append("role = %s")
            params.append(role)
        if is_active is not None:
            updates.append("is_active = %s")
            params.append(1 if is_active else 0)
        if password is not None and password:
            try:
                import bcrypt
                password_hash = bcrypt.hashpw(password.encode('utf-8'), bcrypt.gensalt()).decode('utf-8')
                updates.append("password_hash = %s")
                params.append(password_hash)
            except Exception:
                pass
        if updates:
            where_clauses = []
            if user_id is not None:
                where_clauses.append("id = %s")
                params.append(user_id)
            elif extension is not None:
                where_clauses.append("extension = %s")
                params.append((str(extension).strip() or None))
            if where_clauses:
                cursor.execute(
                    "UPDATE users SET " + ", ".join(updates) + " WHERE " + " AND ".join(where_clauses),
                    tuple(params),
                )
                conn.commit()
        if monitor_modes is not None:
            set_user_monitor_modes(user_id, monitor_modes)
        cursor.close()
        conn.close()
        return True
    except Error as e:
        log.warning(f"⚠️  Database error update_user: {e}")
        return False


def delete_user(user_id: int) -> bool:
    """Delete user and their group assignments and monitor modes. Returns True on success."""
    config = get_db_config(os.getenv('DB_PASSWORD', ''), os.getenv('DB_OpDesk', 'OpDesk'))
    try:
        conn = mysql.connector.connect(**config)
        cursor = conn.cursor()
        cursor.execute("DELETE FROM user_groups WHERE user_id = %s", (user_id,))
        try:
            cursor.execute("DELETE FROM user_monitor_modes WHERE user_id = %s", (user_id,))
        except Error:
            pass
        cursor.execute("DELETE FROM users WHERE id = %s", (user_id,))
        conn.commit()
        cursor.close()
        conn.close()
        return True
    except Error as e:
        log.warning(f"⚠️  Database error delete_user: {e}")
        return False


VALID_MONITOR_MODES = ('listen', 'whisper', 'barge')


def get_user_monitor_modes(user_id: int) -> list:
    """Return list of monitor modes for user (from user_monitor_modes). Default ['listen'] if none set."""
    config = get_db_config(os.getenv('DB_PASSWORD', ''), os.getenv('DB_OpDesk', 'OpDesk'))
    try:
        conn = mysql.connector.connect(**config)
        cursor = conn.cursor(dictionary=True)
        try:
            cursor.execute("SELECT mode FROM user_monitor_modes WHERE user_id = %s ORDER BY mode", (user_id,))
            rows = cursor.fetchall()
            modes = [r['mode'] for r in rows if r.get('mode') in VALID_MONITOR_MODES]
        except Error:
            modes = []
        cursor.close()
        conn.close()
        return modes if modes else ['listen']
    except Error as e:
        log.warning(f"⚠️  Database error get_user_monitor_modes: {e}")
        return ['listen']


def set_user_monitor_modes(user_id: int, modes: list) -> bool:
    """Set monitor modes for user. modes: list of 'listen', 'whisper', 'barge'."""
    if not user_id:
        return False
    valid = [m for m in (modes or []) if m in VALID_MONITOR_MODES]
    if not valid:
        valid = ['listen']
    config = get_db_config(os.getenv('DB_PASSWORD', ''), os.getenv('DB_OpDesk', 'OpDesk'))
    try:
        conn = mysql.connector.connect(**config)
        cursor = conn.cursor()
        try:
            cursor.execute("DELETE FROM user_monitor_modes WHERE user_id = %s", (user_id,))
            for m in valid:
                cursor.execute("INSERT INTO user_monitor_modes (user_id, mode) VALUES (%s, %s)", (user_id, m))
        except Error as e:
            log.warning(f"⚠️  set_user_monitor_modes: {e}")
            cursor.close()
            conn.close()
            return False
        conn.commit()
        cursor.close()
        conn.close()
        return True
    except Error as e:
        log.warning(f"⚠️  Database error set_user_monitor_modes: {e}")
        return False


def get_user_webrtc_credentials(user_id: int) -> Optional[dict]:
    """Get extension for the given user (for WebRTC softphone). Returns None if user not found."""
    config = get_db_config(os.getenv('DB_PASSWORD', ''), os.getenv('DB_OpDesk', 'OpDesk'))
    try:
        conn = mysql.connector.connect(**config)
        cursor = conn.cursor(dictionary=True)
        cursor.execute(
            "SELECT extension FROM users WHERE id = %s",
            (user_id,)
        )
        row = cursor.fetchone()
        cursor.close()
        conn.close()
        if not row:
            return None
        return {"extension": row.get("extension")}
    except Error as e:
        log.warning(f"⚠️  Database error get_user_webrtc_credentials: {e}")
        return None


def get_user_by_id(user_id: int) -> Optional[dict]:
    """Get user by id (no password_hash). Includes monitor_modes (list)."""
    config = get_db_config(os.getenv('DB_PASSWORD', ''), os.getenv('DB_OpDesk', 'OpDesk'))
    try:
        conn = mysql.connector.connect(**config)
        cursor = conn.cursor(dictionary=True)
        cursor.execute(
            "SELECT id, username, extension, name, role, is_active FROM users WHERE id = %s",
            (user_id,)
        )
        row = cursor.fetchone()
        if not row:
            cursor.close()
            conn.close()
            return None
        row = dict(row)
        row['monitor_modes'] = get_user_monitor_modes(user_id)
        cursor.close()
        conn.close()
        return row
    except Error as e:
        log.warning(f"⚠️  Database error get_user_by_id: {e}")
        return None


def get_user_group_ids(user_id: int) -> list:
    """Return list of group ids the user belongs to (excluding user_<id> auto-groups for display)."""
    config = get_db_config(os.getenv('DB_PASSWORD', ''), os.getenv('DB_OpDesk', 'OpDesk'))
    out = []
    try:
        conn = mysql.connector.connect(**config)
        cursor = conn.cursor(dictionary=True)
        cursor.execute(
            "SELECT g.id FROM user_groups ug JOIN groups g ON ug.group_id = g.id WHERE ug.user_id = %s AND g.name NOT LIKE 'user\\_%' ORDER BY g.name",
            (user_id,)
        )
        out = [r['id'] for r in cursor.fetchall()]
        cursor.close()
        conn.close()
    except Error as e:
        log.warning(f"⚠️  Database error get_user_group_ids: {e}")
    return out


def get_user_agents_and_queues(user_id: int) -> tuple:
    """Return (list of agent extensions, list of queue extensions) for user via their groups. Queue extensions are used for filtering in get_current_state (monitor.queues is keyed by extension)."""
    config = get_db_config(os.getenv('DB_PASSWORD', ''), os.getenv('DB_OpDesk', 'OpDesk'))
    agents = []
    queues = []
    try:
        conn = mysql.connector.connect(**config)
        cursor = conn.cursor(dictionary=True)
        cursor.execute("SELECT group_id FROM user_groups WHERE user_id = %s", (user_id,))
        group_ids = [r['group_id'] for r in cursor.fetchall()]
        if not group_ids:
            cursor.close()
            conn.close()
            return agents, queues
        placeholders = ",".join(["%s"] * len(group_ids))
        cursor.execute(
            "SELECT DISTINCT agent_ext FROM group_agents WHERE group_id IN (" + placeholders + ")",
            tuple(group_ids)
        )
        agents = [r['agent_ext'] for r in cursor.fetchall() if r.get('agent_ext')]
        cursor.execute(
            "SELECT DISTINCT q.extension FROM group_queues gq JOIN queues q ON gq.queue_extension = q.extension "
            "WHERE gq.group_id IN (" + placeholders + ")",
            tuple(group_ids)
        )
        queues = [str(r['extension']) for r in cursor.fetchall() if r.get('extension')]
        cursor.close()
        conn.close()
    except Error as e:
        log.warning(f"⚠️  Database error get_user_agents_and_queues: {e}")
    return agents, queues


def get_agent_login_queues(agent_ext: str) -> list:
    """Queue extensions this agent may log in to / out of — the union of the queues
    assigned to every group that contains this agent's *extension* (group_agents →
    group_queues). Keys off the extension, not the user account's user_groups, so the
    echo model holds: put a queue and an agent in the same group and that agent can
    log in/out of it. Returns [] if the agent is in no group or none of their groups
    have queues."""
    ext = str(agent_ext or '').strip()
    if not ext:
        return []
    config = get_db_config(os.getenv('DB_PASSWORD', ''), os.getenv('DB_OpDesk', 'OpDesk'))
    conn = None
    cursor = None
    queues = []
    try:
        conn = mysql.connector.connect(**config)
        cursor = conn.cursor(dictionary=True)
        cursor.execute("SELECT group_id FROM group_agents WHERE agent_ext = %s", (ext,))
        group_ids = [r['group_id'] for r in cursor.fetchall()]
        if not group_ids:
            return []
        placeholders = ",".join(["%s"] * len(group_ids))
        cursor.execute(
            "SELECT DISTINCT q.extension FROM group_queues gq JOIN queues q ON gq.queue_extension = q.extension "
            "WHERE gq.group_id IN (" + placeholders + ")",
            tuple(group_ids)
        )
        queues = [str(r['extension']) for r in cursor.fetchall() if r.get('extension')]
    except Error as e:
        log.warning(f"⚠️  Database error get_agent_login_queues: {e}")
    finally:
        _safe_close(cursor, conn)
    return queues


def set_user_agents_and_queues(user_id: int, agent_extensions: list, queue_names: list) -> bool:
    """
    Set which agents (extensions) and queues a user can access.
    Uses a single group per user (name 'user_<user_id>'). Creates group if needed.
    Ensures agents and queues exist in OpDesk tables (inserts by name/extension).
    """
    if not user_id:
        return False
    config = get_db_config(os.getenv('DB_PASSWORD', ''), os.getenv('DB_OpDesk', 'OpDesk'))
    try:
        conn = mysql.connector.connect(**config)
        cursor = conn.cursor(dictionary=True)
        group_name = f"user_{user_id}"
        cursor.execute("SELECT id FROM groups WHERE name = %s", (group_name,))
        row = cursor.fetchone()
        if row:
            group_id = row['id']
        else:
            cursor.execute("INSERT INTO groups (name) VALUES (%s)", (group_name,))
            group_id = cursor.lastrowid
            conn.commit()
        cursor.execute("DELETE FROM user_groups WHERE user_id = %s", (user_id,))
        cursor.execute("INSERT INTO user_groups (user_id, group_id) VALUES (%s, %s)", (user_id, group_id))
        cursor.execute("DELETE FROM group_agents WHERE group_id = %s", (group_id,))
        cursor.execute("DELETE FROM group_queues WHERE group_id = %s", (group_id,))
        for ext in (agent_extensions or []):
            ext = str(ext).strip()
            if not ext:
                continue
            try:
                cursor.execute("INSERT IGNORE INTO agents (extension, name) VALUES (%s, %s)", (ext, ext))
                cursor.execute("INSERT INTO group_agents (group_id, agent_ext) VALUES (%s, %s)", (group_id, ext))
            except Error:
                pass
        for qname in (queue_names or []):
            qname = (qname or '').strip()
            if not qname:
                continue
            try:
                cursor.execute("INSERT INTO queues (extension, queue_name) VALUES (%s, %s) ON DUPLICATE KEY UPDATE queue_name = VALUES(queue_name)", (qname, qname))
                cursor.execute("INSERT INTO group_queues (group_id, queue_extension) VALUES (%s, %s)", (group_id, qname))
            except Error:
                pass
        conn.commit()
        cursor.close()
        conn.close()
        return True
    except Error as e:
        log.warning(f"⚠️  Database error set_user_agents_and_queues: {e}")
        return False


def _safe_close(cursor=None, conn=None) -> None:
    """Best-effort close of a cursor + connection; never raises. Use in a finally block
    so DB resources are released even when a query raised mid-function."""
    if cursor is not None:
        try:
            cursor.close()
        except Error:
            pass
    if conn is not None:
        try:
            conn.close()
        except Error:
            pass


def get_groups_list() -> list:
    """Return all groups (excluding auto-created user_<id> ones) with agents, queues, and user ids."""
    config = get_db_config(os.getenv('DB_PASSWORD', ''), os.getenv('DB_OpDesk', 'OpDesk'))
    out = []
    conn = None
    cursor = None
    try:
        conn = mysql.connector.connect(**config)
        cursor = conn.cursor(dictionary=True)
        cursor.execute("SELECT id, name FROM groups WHERE name NOT LIKE 'user\_%' ORDER BY name")
        rows = cursor.fetchall()
        for r in rows:
            gid = r['id']
            cursor.execute("SELECT agent_ext FROM group_agents WHERE group_id = %s", (gid,))
            agents = [x['agent_ext'] for x in cursor.fetchall() if x.get('agent_ext')]
            cursor.execute(
                "SELECT q.extension, q.queue_name FROM group_queues gq JOIN queues q ON gq.queue_extension = q.extension WHERE gq.group_id = %s",
                (gid,)
            )
            queues = [{"extension": x["extension"], "queue_name": x["queue_name"]} for x in cursor.fetchall()]
            cursor.execute("SELECT user_id FROM user_groups WHERE group_id = %s", (gid,))
            user_ids = [x['user_id'] for x in cursor.fetchall()]
            out.append({
                "id": gid,
                "name": r["name"],
                "agent_extensions": agents,
                "queues": queues,
                "user_ids": user_ids,
            })
    except Error as e:
        log.warning(f"⚠️  Database error get_groups_list: {e}")
    finally:
        _safe_close(cursor, conn)
    return out


def get_group(group_id: int):
    """Return one group by id with agents, queues, and user ids, or None."""
    config = get_db_config(os.getenv('DB_PASSWORD', ''), os.getenv('DB_OpDesk', 'OpDesk'))
    conn = None
    cursor = None
    try:
        conn = mysql.connector.connect(**config)
        cursor = conn.cursor(dictionary=True)
        cursor.execute("SELECT id, name FROM groups WHERE id = %s", (group_id,))
        r = cursor.fetchone()
        if not r:
            return None
        gid = r['id']
        cursor.execute("SELECT agent_ext FROM group_agents WHERE group_id = %s", (gid,))
        agents = [x['agent_ext'] for x in cursor.fetchall() if x.get('agent_ext')]
        cursor.execute(
            "SELECT q.extension, q.queue_name FROM group_queues gq JOIN queues q ON gq.queue_extension = q.extension WHERE gq.group_id = %s",
            (gid,)
        )
        queues = [{"extension": x["extension"], "queue_name": x["queue_name"]} for x in cursor.fetchall()]
        cursor.execute("SELECT user_id FROM user_groups WHERE group_id = %s", (gid,))
        user_ids = [x['user_id'] for x in cursor.fetchall()]
        return {
            "id": gid,
            "name": r["name"],
            "agent_extensions": agents,
            "queues": queues,
            "user_ids": user_ids,
        }
    except Error as e:
        log.warning(f"⚠️  Database error get_group: {e}")
        return None
    finally:
        _safe_close(cursor, conn)


def create_group(name: str):
    """Create a group. Returns group id or None."""
    name = (name or '').strip()
    if not name:
        return None
    config = get_db_config(os.getenv('DB_PASSWORD', ''), os.getenv('DB_OpDesk', 'OpDesk'))
    conn = None
    cursor = None
    try:
        conn = mysql.connector.connect(**config)
        cursor = conn.cursor()
        cursor.execute("INSERT INTO groups (name) VALUES (%s)", (name,))
        gid = cursor.lastrowid
        conn.commit()
        return gid
    except Error as e:
        log.warning(f"⚠️  Database error create_group: {e}")
        return None
    finally:
        _safe_close(cursor, conn)


def update_group(group_id: int, name: str) -> bool:
    """Update group name. Do not use for user_<id> groups."""
    name = (name or '').strip()
    if not name or not group_id:
        return False
    config = get_db_config(os.getenv('DB_PASSWORD', ''), os.getenv('DB_OpDesk', 'OpDesk'))
    conn = None
    cursor = None
    try:
        conn = mysql.connector.connect(**config)
        cursor = conn.cursor()
        cursor.execute("UPDATE groups SET name = %s WHERE id = %s AND name NOT LIKE 'user\_%'", (name, group_id))
        ok = cursor.rowcount > 0
        conn.commit()
        return ok
    except Error as e:
        log.warning(f"⚠️  Database error update_group: {e}")
        return False
    finally:
        _safe_close(cursor, conn)


def set_group_agents(group_id: int, agent_extensions: list) -> bool:
    """Replace a group's agents. Ensures agents exist. Transactional: any row error rolls
    back the whole replacement, so a group is never left with a partial member set."""
    if not group_id:
        return False
    config = get_db_config(os.getenv('DB_PASSWORD', ''), os.getenv('DB_OpDesk', 'OpDesk'))
    conn = None
    cursor = None
    try:
        conn = mysql.connector.connect(**config)
        cursor = conn.cursor()
        cursor.execute("DELETE FROM group_agents WHERE group_id = %s", (group_id,))
        for ext in (agent_extensions or []):
            ext = str(ext).strip()
            if not ext:
                continue
            cursor.execute("INSERT IGNORE INTO agents (extension, name) VALUES (%s, %s)", (ext, ext))
            cursor.execute("INSERT INTO group_agents (group_id, agent_ext) VALUES (%s, %s)", (group_id, ext))
        conn.commit()
        return True
    except Error as e:
        log.warning(f"⚠️  Database error set_group_agents: {e}")
        if conn is not None:
            try:
                conn.rollback()
            except Error:
                pass
        return False
    finally:
        _safe_close(cursor, conn)


def set_group_queues(group_id: int, queue_extensions: list) -> bool:
    """Replace a group's queues by extension. Ensures queues exist. Transactional (see
    set_group_agents)."""
    if not group_id:
        return False
    config = get_db_config(os.getenv('DB_PASSWORD', ''), os.getenv('DB_OpDesk', 'OpDesk'))
    conn = None
    cursor = None
    try:
        conn = mysql.connector.connect(**config)
        cursor = conn.cursor()
        cursor.execute("DELETE FROM group_queues WHERE group_id = %s", (group_id,))
        for qext in (queue_extensions or []):
            qext = str(qext).strip()
            if not qext or qext.lower() == "default":
                continue
            cursor.execute("INSERT INTO queues (extension, queue_name) VALUES (%s, %s) ON DUPLICATE KEY UPDATE queue_name = VALUES(queue_name)", (qext, qext))
            cursor.execute("INSERT INTO group_queues (group_id, queue_extension) VALUES (%s, %s)", (group_id, qext))
        conn.commit()
        return True
    except Error as e:
        log.warning(f"⚠️  Database error set_group_queues: {e}")
        if conn is not None:
            try:
                conn.rollback()
            except Error:
                pass
        return False
    finally:
        _safe_close(cursor, conn)


def set_group_users(group_id: int, user_ids: list) -> bool:
    """Replace which users belong to this group. Transactional (see set_group_agents).
    Non-integer ids are skipped before the transaction runs, not swallowed mid-loop."""
    if not group_id:
        return False
    clean_uids = []
    for uid in (user_ids or []):
        try:
            clean_uids.append(int(uid))
        except (ValueError, TypeError):
            continue
    config = get_db_config(os.getenv('DB_PASSWORD', ''), os.getenv('DB_OpDesk', 'OpDesk'))
    conn = None
    cursor = None
    try:
        conn = mysql.connector.connect(**config)
        cursor = conn.cursor()
        cursor.execute("DELETE FROM user_groups WHERE group_id = %s", (group_id,))
        for uid in clean_uids:
            cursor.execute("INSERT INTO user_groups (user_id, group_id) VALUES (%s, %s)", (uid, group_id))
        conn.commit()
        return True
    except Error as e:
        log.warning(f"⚠️  Database error set_group_users: {e}")
        if conn is not None:
            try:
                conn.rollback()
            except Error:
                pass
        return False
    finally:
        _safe_close(cursor, conn)


def set_user_groups(user_id: int, group_ids: list) -> bool:
    """Set which groups a user belongs to (replaces existing). Removes user from any user_<id> auto-group."""
    if not user_id:
        return False
    clean_gids = []
    for gid in (group_ids or []):
        try:
            clean_gids.append(int(gid))
        except (ValueError, TypeError):
            continue
    config = get_db_config(os.getenv('DB_PASSWORD', ''), os.getenv('DB_OpDesk', 'OpDesk'))
    conn = None
    cursor = None
    try:
        conn = mysql.connector.connect(**config)
        cursor = conn.cursor()
        cursor.execute("DELETE FROM user_groups WHERE user_id = %s", (user_id,))
        for gid in clean_gids:
            cursor.execute("INSERT INTO user_groups (user_id, group_id) VALUES (%s, %s)", (user_id, gid))
        conn.commit()
        return True
    except Error as e:
        log.warning(f"⚠️  Database error set_user_groups: {e}")
        if conn is not None:
            try:
                conn.rollback()
            except Error:
                pass
        return False
    finally:
        _safe_close(cursor, conn)


def delete_group(group_id: int) -> bool:
    """Delete a group (only if not a user_<id> auto-group). CASCADE removes group_agents, group_queues, user_groups."""
    if not group_id:
        return False
    config = get_db_config(os.getenv('DB_PASSWORD', ''), os.getenv('DB_OpDesk', 'OpDesk'))
    conn = None
    cursor = None
    try:
        conn = mysql.connector.connect(**config)
        cursor = conn.cursor()
        cursor.execute("DELETE FROM groups WHERE id = %s AND name NOT LIKE 'user\_%'", (group_id,))
        ok = cursor.rowcount > 0
        conn.commit()
        return ok
    except Error as e:
        log.warning(f"⚠️  Database error delete_group: {e}")
        return False
    finally:
        _safe_close(cursor, conn)


def get_agents_list() -> list:
    """Get list of agents from OpDesk agents table: [{ extension, name }, ...]."""
    config = get_db_config(os.getenv('DB_PASSWORD', ''), os.getenv('DB_OpDesk', 'OpDesk'))
    try:
        conn = mysql.connector.connect(**config)
        cursor = conn.cursor(dictionary=True)
        cursor.execute("SELECT extension, name FROM agents ORDER BY extension")
        rows = cursor.fetchall()
        cursor.close()
        conn.close()
        return [{"extension": r["extension"], "name": r.get("name") or r["extension"]} for r in rows]
    except Error as e:
        log.warning(f"⚠️  Database error get_agents_list: {e}")
        return []


def get_queues_list() -> list:
    """Get list of queues from OpDesk queues table: [{ extension, queue_name }, ...]. Excludes 'default' queue."""
    config = get_db_config(os.getenv('DB_PASSWORD', ''), os.getenv('DB_OpDesk', 'OpDesk'))
    try:
        conn = mysql.connector.connect(**config)
        cursor = conn.cursor(dictionary=True)
        cursor.execute("SELECT extension, queue_name FROM queues ORDER BY queue_name")
        rows = cursor.fetchall()
        cursor.close()
        conn.close()
        return [
            {"extension": r["extension"], "queue_name": r["queue_name"]}
            for r in rows
            if (r.get("extension") or "").strip().lower() != "default"
        ]
    except Error as e:
        log.warning(f"⚠️  Database error get_queues_list: {e}")
        return []


def sync_agents_from_extensions(extension_list: list, name_map: dict,
                                prune: bool = False, prune_all_when_empty: bool = False) -> None:
    """Upsert OpDesk agents for the given extensions (from Asterisk/FreePBX).

    When ``prune`` is set, agents NOT in ``extension_list`` are deleted so the table
    stays authoritative (cascades to group_agents). As a safety guard, an empty list is
    never pruned unless ``prune_all_when_empty`` is explicitly True — this prevents a
    transient PBX-read failure from wiping every agent.
    """
    normalized = [str(e).strip() for e in (extension_list or []) if str(e).strip()]
    if not normalized and not (prune and prune_all_when_empty):
        return
    config = get_db_config(os.getenv('DB_PASSWORD', ''), os.getenv('DB_OpDesk', 'OpDesk'))
    conn = None
    cursor = None
    try:
        conn = mysql.connector.connect(**config)
        cursor = conn.cursor()
        for ext in normalized:
            name = (name_map or {}).get(ext) or ext
            cursor.execute("INSERT INTO agents (extension, name) VALUES (%s, %s) ON DUPLICATE KEY UPDATE name = VALUES(name)", (ext, name))
        if prune:
            if normalized:
                placeholders = ",".join(["%s"] * len(normalized))
                cursor.execute(f"DELETE FROM agents WHERE extension NOT IN ({placeholders})", tuple(normalized))
            elif prune_all_when_empty:
                cursor.execute("DELETE FROM agents")
        conn.commit()
    except Error as e:
        log.warning(f"⚠️  Database error sync_agents_from_extensions: {e}")
        if conn is not None:
            try:
                conn.rollback()
            except Error:
                pass
    finally:
        _safe_close(cursor, conn)


def sync_queues_from_list(queue_extensions: list, name_map: dict = None,
                          prune: bool = False, prune_all_when_empty: bool = False) -> None:
    """Upsert OpDesk queues for the given queue extensions (extension as PK). Uses
    name_map for display names; skips the 'default' queue. When ``prune`` is set, queues
    NOT in the list are deleted (cascades to group_queues), with the same empty-list
    safety guard as sync_agents_from_extensions."""
    normalized = [(q or '').strip() for q in (queue_extensions or [])]
    normalized = [q for q in normalized if q and q.lower() != "default"]
    if not normalized and not (prune and prune_all_when_empty):
        return
    config = get_db_config(os.getenv('DB_PASSWORD', ''), os.getenv('DB_OpDesk', 'OpDesk'))
    conn = None
    cursor = None
    try:
        conn = mysql.connector.connect(**config)
        cursor = conn.cursor()
        for qext in normalized:
            name = (name_map or {}).get(qext) or qext
            cursor.execute("INSERT INTO queues (extension, queue_name) VALUES (%s, %s) ON DUPLICATE KEY UPDATE queue_name = VALUES(queue_name)", (qext, name))
        if prune:
            if normalized:
                placeholders = ",".join(["%s"] * len(normalized))
                cursor.execute(
                    f"DELETE FROM queues WHERE extension NOT IN ({placeholders}) AND LOWER(extension) <> 'default'",
                    tuple(normalized),
                )
            elif prune_all_when_empty:
                cursor.execute("DELETE FROM queues WHERE LOWER(extension) <> 'default'")
        conn.commit()
    except Error as e:
        log.warning(f"⚠️  Database error sync_queues_from_list: {e}")
        if conn is not None:
            try:
                conn.rollback()
            except Error:
                pass
    finally:
        _safe_close(cursor, conn)


# ---------------------------------------------------------------------------
# Not-Ready Codes (pause reasons) — a small admin-managed catalog used when an
# agent goes Not-Ready (queue_pause with a reason_code).
# ---------------------------------------------------------------------------

_DEFAULT_PAUSE_REASONS = [
    # (code, label, productive, color, sort_order, is_system)
    ("break", "Break", 0, "#d29922", 10, 0),
    ("lunch", "Lunch", 0, "#f85149", 20, 0),
    ("meeting", "Meeting", 1, "#58a6ff", 30, 0),
    ("training", "Training", 1, "#3fb950", 40, 0),
]


def init_call_supervision_table() -> None:
    """Create the call_supervision table (if missing). One row per ChanSpy leg,
    keyed by the spy channel's linkedid, so the call log can flag/hide supervision
    (listen/whisper/barge) rows and attach them to the monitored call."""
    config = get_db_config(os.getenv('DB_PASSWORD', ''), os.getenv('DB_OpDesk', 'OpDesk'))
    conn = None
    cursor = None
    try:
        conn = mysql.connector.connect(**config)
        cursor = conn.cursor()
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS call_supervision (
                id INT PRIMARY KEY AUTO_INCREMENT,
                spy_linkedid VARCHAR(64) NOT NULL UNIQUE,
                spy_uniqueid VARCHAR(64) NULL,
                target_linkedid VARCHAR(64) NULL,
                target_extension VARCHAR(20) NULL,
                supervisor_extension VARCHAR(20) NULL,
                mode ENUM('listen','whisper','barge') NOT NULL DEFAULT 'listen',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                INDEX idx_spy_linkedid (spy_linkedid),
                INDEX idx_target_linkedid (target_linkedid),
                INDEX idx_created_at (created_at)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        """)
        conn.commit()
    except Error as e:
        log.warning(f"⚠️  Database error init_call_supervision_table: {e}")
    finally:
        _safe_close(cursor, conn)


def record_supervision(
    spy_linkedid: str,
    target_linkedid: Optional[str] = None,
    target_extension: Optional[str] = None,
    supervisor_extension: Optional[str] = None,
    mode: str = "listen",
    spy_uniqueid: Optional[str] = None,
) -> bool:
    """Record one supervision event, keyed by the ChanSpy leg's linkedid.
    mode is one of 'listen' | 'whisper' | 'barge'. Idempotent on spy_linkedid."""
    if not spy_linkedid:
        return False
    if mode not in ("listen", "whisper", "barge"):
        mode = "listen"
    config = get_db_config(os.getenv('DB_PASSWORD', ''), os.getenv('DB_OpDesk', 'OpDesk'))
    conn = None
    cursor = None
    try:
        conn = mysql.connector.connect(**config)
        cursor = conn.cursor()
        cursor.execute(
            """INSERT INTO call_supervision
                   (spy_linkedid, spy_uniqueid, target_linkedid, target_extension,
                    supervisor_extension, mode)
               VALUES (%s, %s, %s, %s, %s, %s)
               ON DUPLICATE KEY UPDATE
                   spy_uniqueid=VALUES(spy_uniqueid),
                   target_linkedid=VALUES(target_linkedid),
                   target_extension=VALUES(target_extension),
                   supervisor_extension=VALUES(supervisor_extension),
                   mode=VALUES(mode)""",
            (str(spy_linkedid), spy_uniqueid, target_linkedid,
             target_extension, supervisor_extension, mode),
        )
        conn.commit()
        return True
    except Error as e:
        log.warning(f"⚠️  DB error recording supervision ({spy_linkedid}): {e}")
        return False
    finally:
        _safe_close(cursor, conn)


def get_supervision_by_spy_keys(keys: List[str]) -> dict:
    """Fetch supervision rows whose spy_linkedid OR spy_uniqueid is in `keys`.
    Returns a dict keyed by BOTH spy_linkedid and spy_uniqueid → row dict, so a
    call-log row can be matched by either its linkedid or its uniqueid. Used to
    flag the standalone ChanSpy row as supervision so the UI can hide it."""
    ids = [str(x) for x in keys if x]
    if not ids:
        return {}
    config = get_db_config(os.getenv('DB_PASSWORD', ''), os.getenv('DB_OpDesk', 'OpDesk'))
    conn = None
    cursor = None
    out: dict = {}
    try:
        conn = mysql.connector.connect(**config)
        cursor = conn.cursor(dictionary=True)
        placeholders = ", ".join(["%s"] * len(ids))
        cursor.execute(
            f"""SELECT spy_linkedid, spy_uniqueid, target_linkedid, target_extension,
                       supervisor_extension, mode
                FROM call_supervision
                WHERE spy_linkedid IN ({placeholders})
                   OR spy_uniqueid IN ({placeholders})""",
            tuple(ids) + tuple(ids),
        )
        for row in cursor.fetchall():
            d = dict(row)
            if d.get("spy_linkedid"):
                out[str(d["spy_linkedid"])] = d
            if d.get("spy_uniqueid"):
                out[str(d["spy_uniqueid"])] = d
    except Error as e:
        log.warning(f"⚠️  DB error fetching call_supervision by spy keys: {e}")
    finally:
        _safe_close(cursor, conn)
    return out


def get_supervision_targets(target_linkedids: List[str]) -> dict:
    """Bulk lookup of supervision rows grouped by the monitored call's linkedid.
    Returns {target_linkedid: [supervision rows]} so the call log can flag which
    monitored calls were supervised (to surface a marker) in one query."""
    ids = [str(x) for x in target_linkedids if x]
    if not ids:
        return {}
    config = get_db_config(os.getenv('DB_PASSWORD', ''), os.getenv('DB_OpDesk', 'OpDesk'))
    conn = None
    cursor = None
    out: dict = {}
    try:
        conn = mysql.connector.connect(**config)
        cursor = conn.cursor(dictionary=True)
        placeholders = ", ".join(["%s"] * len(ids))
        cursor.execute(
            f"""SELECT spy_linkedid, target_linkedid, target_extension,
                       supervisor_extension, mode, created_at
                FROM call_supervision
                WHERE target_linkedid IN ({placeholders})
                ORDER BY created_at ASC""",
            tuple(ids),
        )
        for row in cursor.fetchall():
            out.setdefault(str(row["target_linkedid"]), []).append(dict(row))
    except Error as e:
        log.warning(f"⚠️  DB error fetching call_supervision targets: {e}")
    finally:
        _safe_close(cursor, conn)
    return out


def init_pause_reasons_table() -> None:
    """Create the pause_reasons table (if missing) and seed default codes once."""
    config = get_db_config(os.getenv('DB_PASSWORD', ''), os.getenv('DB_OpDesk', 'OpDesk'))
    conn = None
    cursor = None
    try:
        conn = mysql.connector.connect(**config)
        cursor = conn.cursor()
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS pause_reasons (
                id INT AUTO_INCREMENT PRIMARY KEY,
                code VARCHAR(64) NOT NULL UNIQUE,
                label VARCHAR(191) NOT NULL,
                productive TINYINT(1) NOT NULL DEFAULT 0,
                color VARCHAR(16) DEFAULT NULL,
                sort_order INT NOT NULL DEFAULT 100,
                is_active TINYINT(1) NOT NULL DEFAULT 1,
                is_system TINYINT(1) NOT NULL DEFAULT 0
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        """)
        cursor.execute("SELECT COUNT(*) FROM pause_reasons")
        (count,) = cursor.fetchone()
        if not count:
            for code, label, productive, color, order, is_system in _DEFAULT_PAUSE_REASONS:
                cursor.execute(
                    "INSERT INTO pause_reasons (code, label, productive, color, sort_order, is_active, is_system) "
                    "VALUES (%s, %s, %s, %s, %s, 1, %s)",
                    (code, label, productive, color, order, is_system),
                )
        # Widen the device_tokens.platform enum to include 'web' for browser Web Push
        # (idempotent — MODIFY is a no-op if it already includes 'web').
        try:
            cursor.execute(
                "ALTER TABLE device_tokens MODIFY platform ENUM('ios','android','web') NOT NULL"
            )
        except Error:
            pass  # table may not exist yet on a brand-new DB (schema.sql already has 'web')
        conn.commit()
    except Error as e:
        log.warning(f"⚠️  Database error init_pause_reasons_table: {e}")
    finally:
        _safe_close(cursor, conn)


def pause_reason_list(active_only: bool = False, include_system: bool = True) -> list:
    """Return pause reasons ordered by sort_order. active_only hides inactive codes;
    include_system=False hides system codes."""
    config = get_db_config(os.getenv('DB_PASSWORD', ''), os.getenv('DB_OpDesk', 'OpDesk'))
    conn = None
    cursor = None
    out = []
    try:
        conn = mysql.connector.connect(**config)
        cursor = conn.cursor(dictionary=True)
        conditions = []
        if active_only:
            conditions.append("is_active = 1")
        if not include_system:
            conditions.append("is_system = 0")
        where = (" WHERE " + " AND ".join(conditions)) if conditions else ""
        cursor.execute(f"SELECT id, code, label, productive, color, sort_order, is_active, is_system FROM pause_reasons{where} ORDER BY sort_order, label")
        out = cursor.fetchall()
    except Error as e:
        log.warning(f"⚠️  Database error pause_reason_list: {e}")
    finally:
        _safe_close(cursor, conn)
    return out


def pause_reason_create(code: str, label: str, productive: bool = False,
                        color: str = None, sort_order: int = 100, is_active: bool = True):
    """Create a pause reason. Returns the new id or None."""
    code = (code or '').strip()
    label = (label or '').strip()
    if not code or not label:
        return None
    config = get_db_config(os.getenv('DB_PASSWORD', ''), os.getenv('DB_OpDesk', 'OpDesk'))
    conn = None
    cursor = None
    try:
        conn = mysql.connector.connect(**config)
        cursor = conn.cursor()
        cursor.execute(
            "INSERT INTO pause_reasons (code, label, productive, color, sort_order, is_active, is_system) "
            "VALUES (%s, %s, %s, %s, %s, %s, 0)",
            (code, label, 1 if productive else 0, color, int(sort_order or 100), 1 if is_active else 0),
        )
        gid = cursor.lastrowid
        conn.commit()
        return gid
    except Error as e:
        log.warning(f"⚠️  Database error pause_reason_create: {e}")
        return None
    finally:
        _safe_close(cursor, conn)


def pause_reason_update(reason_id: int, fields: dict) -> bool:
    """Update a pause reason's mutable fields (label, productive, color, sort_order,
    is_active). The code and is_system flag are immutable."""
    if not reason_id or not fields:
        return False
    allowed = {"label", "productive", "color", "sort_order", "is_active"}
    sets = []
    params = []
    for key, val in fields.items():
        if key not in allowed:
            continue
        if key in ("productive", "is_active"):
            val = 1 if val else 0
        elif key == "sort_order":
            val = int(val or 100)
        sets.append(f"{key} = %s")
        params.append(val)
    if not sets:
        return False
    params.append(reason_id)
    config = get_db_config(os.getenv('DB_PASSWORD', ''), os.getenv('DB_OpDesk', 'OpDesk'))
    conn = None
    cursor = None
    try:
        conn = mysql.connector.connect(**config)
        cursor = conn.cursor()
        cursor.execute(f"UPDATE pause_reasons SET {', '.join(sets)} WHERE id = %s", tuple(params))
        conn.commit()
        return cursor.rowcount >= 0
    except Error as e:
        log.warning(f"⚠️  Database error pause_reason_update: {e}")
        return False
    finally:
        _safe_close(cursor, conn)


def pause_reason_delete(reason_id: int) -> bool:
    """Delete a non-system pause reason."""
    if not reason_id:
        return False
    config = get_db_config(os.getenv('DB_PASSWORD', ''), os.getenv('DB_OpDesk', 'OpDesk'))
    conn = None
    cursor = None
    try:
        conn = mysql.connector.connect(**config)
        cursor = conn.cursor()
        cursor.execute("DELETE FROM pause_reasons WHERE id = %s AND is_system = 0", (reason_id,))
        ok = cursor.rowcount > 0
        conn.commit()
        return ok
    except Error as e:
        log.warning(f"⚠️  Database error pause_reason_delete: {e}")
        return False
    finally:
        _safe_close(cursor, conn)


def pause_reason_get(code: str) -> Optional[dict]:
    """Return a single pause reason by code, or None."""
    if not code:
        return None
    config = get_db_config(os.getenv('DB_PASSWORD', ''), os.getenv('DB_OpDesk', 'OpDesk'))
    conn = None
    cursor = None
    try:
        conn = mysql.connector.connect(**config)
        cursor = conn.cursor(dictionary=True)
        cursor.execute(
            "SELECT id, code, label, productive, color, sort_order, is_active, is_system "
            "FROM pause_reasons WHERE code = %s",
            (code,),
        )
        return cursor.fetchone()
    except Error as e:
        log.warning(f"⚠️  Database error pause_reason_get: {e}")
        return None
    finally:
        _safe_close(cursor, conn)


# ── Agent presence segments (agent_activity) ─────────────────────────────────
# Append-only presence log powering the Agent Adherence report. The presence
# recorder (backend/agent_presence.py) is the only writer.
def init_agent_activity_table() -> None:
    """Create the agent_activity table (if missing). Idempotent; called at startup."""
    config = get_db_config(os.getenv('DB_PASSWORD', ''), os.getenv('DB_OpDesk', 'OpDesk'))
    conn = None
    cursor = None
    try:
        conn = mysql.connector.connect(**config)
        cursor = conn.cursor()
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS agent_activity (
                id            BIGINT PRIMARY KEY AUTO_INCREMENT,
                agent_ext     VARCHAR(20) NOT NULL,
                state         VARCHAR(20) NOT NULL,
                reason_code   VARCHAR(64) NULL,
                queue         VARCHAR(40) NULL,
                linkedid      VARCHAR(64) NULL,
                started_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                ended_at      TIMESTAMP NULL DEFAULT NULL,
                duration_secs INT NULL,
                source        VARCHAR(20) NOT NULL DEFAULT 'ui',
                INDEX idx_agent_started (agent_ext, started_at),
                INDEX idx_started (started_at),
                INDEX idx_open (agent_ext, ended_at)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        """)
        conn.commit()
    except Error as e:
        log.warning(f"⚠️  Database error init_agent_activity_table: {e}")
    finally:
        _safe_close(cursor, conn)


def agent_activity_transition(agent_ext: str, new_state: Optional[str], reason_code: Optional[str] = None,
                              queue: Optional[str] = None, linkedid: Optional[str] = None,
                              source: str = 'ui') -> Optional[int]:
    """Atomically close the agent's open segment (set ended_at/duration_secs) and, when
    new_state is not None, open a fresh one. new_state=None means logged out (close only).
    Both statements share one connection/commit so a transition is never half-applied.
    Returns the new open segment's id, or None on logout/error."""
    ext = str(agent_ext or '').strip()
    if not ext:
        return None
    config = get_db_config(os.getenv('DB_PASSWORD', ''), os.getenv('DB_OpDesk', 'OpDesk'))
    conn = None
    cursor = None
    try:
        conn = mysql.connector.connect(**config)
        cursor = conn.cursor()
        cursor.execute(
            "UPDATE agent_activity SET ended_at = NOW(), "
            "duration_secs = TIMESTAMPDIFF(SECOND, started_at, NOW()) "
            "WHERE agent_ext = %s AND ended_at IS NULL",
            (ext,),
        )
        new_id = None
        if new_state is not None:
            cursor.execute(
                "INSERT INTO agent_activity (agent_ext, state, reason_code, queue, linkedid, source) "
                "VALUES (%s, %s, %s, %s, %s, %s)",
                (ext, new_state, reason_code, queue, linkedid, source),
            )
            new_id = cursor.lastrowid
        conn.commit()
        return new_id
    except Error as e:
        log.warning(f"⚠️  Database error agent_activity_transition({ext}, {new_state}): {e}")
        return None
    finally:
        _safe_close(cursor, conn)


def agent_activity_close_all_open(source: str = 'system') -> int:
    """Close every open segment. Used at startup before re-hydrating from live queue
    state, so a segment left open by a previous process is clamped to now rather than
    counting time while the backend was down. Returns rows affected."""
    config = get_db_config(os.getenv('DB_PASSWORD', ''), os.getenv('DB_OpDesk', 'OpDesk'))
    conn = None
    cursor = None
    try:
        conn = mysql.connector.connect(**config)
        cursor = conn.cursor()
        cursor.execute(
            "UPDATE agent_activity SET ended_at = NOW(), "
            "duration_secs = TIMESTAMPDIFF(SECOND, started_at, NOW()) "
            "WHERE ended_at IS NULL"
        )
        n = cursor.rowcount
        conn.commit()
        return n
    except Error as e:
        log.warning(f"⚠️  Database error agent_activity_close_all_open: {e}")
        return 0
    finally:
        _safe_close(cursor, conn)
