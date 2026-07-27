#!/usr/bin/env python3
"""
Asterisk Operator Panel WebSocket Server

Real-time extension monitoring, call tracking, and supervisor features
via WebSocket connections for React frontend.

This server wraps the AMI monitor and broadcasts events to connected clients.
"""

import asyncio
import json
import logging
import os
import re
import socket
from datetime import datetime, timedelta, timezone
from urllib.parse import unquote
from typing import Dict, Set, Optional
from contextlib import asynccontextmanager
from dotenv import load_dotenv

import jwt
from pydantic import BaseModel
from fastapi import (FastAPI, WebSocket, WebSocketDisconnect, HTTPException, Depends,
                     Body, Request, Response, Query)
from fastapi.routing import APIRoute
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, PlainTextResponse
import uvicorn

from ami import AMIExtensionsMonitor, _format_duration, DIALPLAN_CTX, normalize_interface
from db_manager import (
    get_extensions_from_db, get_extension_names_from_db, get_queue_names_from_db, init_settings_table,
    get_setting, set_setting, get_all_settings, authenticate_user, get_call_log_count_from_db, get_call_notifications_from_db, get_call_notification_by_id, update_call_notification_status,
    get_cdr_by_linkedid,
    get_all_users, get_user_by_id, get_user_webrtc_credentials, create_user as db_create_user, update_user as db_update_user,
    delete_user as db_delete_user, get_user_agents_and_queues, get_agent_login_queues, get_user_group_ids, set_user_groups,get_groups_list, get_group,
    create_group, update_group, set_group_agents, set_group_queues, set_group_users, delete_group,
    get_agents_list, get_queues_list, sync_agents_from_extensions, sync_queues_from_list,
    set_extension_webrtc, get_extensions_with_webrtc_from_users,get_extension_secret_from_db, set_extension_secret_in_pbx, set_extension_username_in_pbx, set_extension_name_in_pbx,
    register_device_token, delete_device_token, get_device_tokens_for_extension,
    get_call_vad_from_db,
    init_pause_reasons_table, pause_reason_list, pause_reason_create, pause_reason_update, pause_reason_delete,
    init_call_supervision_table,
    init_agent_activity_table,
    # Machine-to-machine API keys
    API_KEY_PREFIX, init_api_keys_table, create_api_key, list_api_keys, get_api_key,
    update_api_key, delete_api_key, lookup_api_key,
    # CRM webhook delivery log
    init_webhook_deliveries_table, list_webhook_deliveries, get_webhook_delivery,
    prune_webhook_deliveries,
    # Contacts (system phonebook, fed manually and by the CRM lookup)
    init_contacts_table, list_contacts, create_contact, update_contact,
    delete_contact, get_contacts_for_resolver,
)
from agent_presence import PresenceRecorder
from dialplan import enable_qos, disable_qos, enable_sip_tls, disable_sip_tls, enable_mobile_wake, disable_mobile_wake, enable_recording, disable_recording, reload_asterisk_sip, set_pjsip_logger
from call_log import call_log as get_call_log, build_call_journey_from_cdr, CALL_OUTCOMES
import analytics as analytics_module
import push_service

# Load environment variables
load_dotenv()

# Import CRM connector
try:
    from crm import (
        CRMConnector, create_crm_connector, AuthType,
        CRM_SYNC_FIELD_CATALOG, DEFAULT_CRM_SYNC_FIELDS, CRMSyncConfig,
        RETIRED_CRM_SYNC_FIELDS,
        parse_sync_fields, parse_key_map, parse_status_map,
        default_outbound_keys, validate_crm_url, redact_url,
        CRMLookupConfig, LOOKUP_NUMBER_FORMATS, lookup_cache_key,
    )
    from crm_lookup import ContactResolver, run_lookup_test
except ImportError:
    CRMConnector = None
    create_crm_connector = None
    AuthType = None
    CRM_SYNC_FIELD_CATALOG = []
    DEFAULT_CRM_SYNC_FIELDS = []
    CRMSyncConfig = None
    RETIRED_CRM_SYNC_FIELDS = {}
    parse_sync_fields = None
    parse_key_map = None
    parse_status_map = None
    default_outbound_keys = None
    validate_crm_url = None
    redact_url = None
    CRMLookupConfig = None
    LOOKUP_NUMBER_FORMATS = ("digits", "as_is", "plus", "zeros")
    ContactResolver = None
    run_lookup_test = None

    def lookup_cache_key(raw: str, match_digits: int = 0) -> str:
        """Fallback when the crm module is unavailable: digits-only key."""
        import re as _re
        digits = _re.sub(r"\D", "", raw or "")
        if match_digits and match_digits > 0:
            digits = digits[-match_digits:]
        return digits[:32]

# Filter to suppress "change detected" messages
class SuppressChangeDetectedFilter(logging.Filter):
    def filter(self, record):
        return "change detected" not in record.getMessage().lower()

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
log = logging.getLogger(__name__)

# Suppress "change detected" messages from Uvicorn's WatchFiles reloader
watchfiles_logger = logging.getLogger("watchfiles")
watchfiles_logger.setLevel(logging.WARNING)

# Apply filter to root logger to catch all "change detected" messages
root_logger = logging.getLogger()
root_logger.addFilter(SuppressChangeDetectedFilter())


# ---------------------------------------------------------------------------
# System Logs — live Asterisk AMI event stream
# ---------------------------------------------------------------------------
# The System Logs panel shows the raw AMI event feed. The monitor calls our
# raw-event sink for every parsed event (ami.set_raw_event_sink) BEFORE the
# WATCHED_EVENTS filter, so the panel sees the whole stream rather than the ~27
# events the app itself acts on.
#
# In memory only — capped at _AMI_BUFFER_CAPACITY events and lost on restart. That
# is deliberate: this is a live debugging console, not an audit trail, and
# persisting a high-rate event feed would cost far more than it is worth. Buffering
# is OFF by default so the steady-state cost is one attribute read per AMI event.

from collections import deque
import threading
import time as _time

# AMI fields that are pure plumbing/noise — hidden from the one-line summary (kept
# in `fields` so the expanded view still has them).
_AMI_SUMMARY_SKIP = {"Event", "Privilege", "SystemName", "Timestamp"}
# Capacity is generous because AMI can be chatty under load.
_AMI_BUFFER_CAPACITY = 3000


class AMIEventBuffer:
    """Retains the most recent AMI events in memory for the System Logs panel."""

    def __init__(self, capacity: int = _AMI_BUFFER_CAPACITY):
        self._buf: deque = deque(maxlen=capacity)
        self._seq = 0
        self._lock = threading.Lock()
        self.enabled: bool = False

    def add(self, event: dict):
        """Sink: record one parsed AMI event.

        Runs on the AMI read path for EVERY event, so it must stay synchronous and
        cheap — never add a DB write or a broadcast here or AMI event processing
        stalls globally.
        """
        if not self.enabled:
            return
        ev = event.get("Event", "")
        if not ev:
            return
        fields = {k: v for k, v in event.items() if k != "Event"}
        summary = " ".join(
            f"{k}={v}" for k, v in event.items()
            if k not in _AMI_SUMMARY_SKIP and v
        )
        with self._lock:
            self._seq += 1
            self._buf.append({
                "seq": self._seq,
                "event": ev,
                "ts": _time.time(),
                "summary": summary,
                "fields": fields,
            })

    def snapshot(self, since: int = 0, event: str = "", q: str = "", limit: int = 2000) -> list:
        """Return buffered events newer than `since`, optionally filtered by event-name
        substring and free-text `q` (matches event name or summary). Oldest first."""
        ev_l = (event or "").lower()
        q_l = (q or "").lower()
        with self._lock:
            rows = [
                e for e in self._buf
                if e["seq"] > since
                and (not ev_l or ev_l in e["event"].lower())
                and (not q_l or q_l in e["event"].lower() or q_l in e["summary"].lower())
            ]
        if len(rows) > limit:
            rows = rows[-limit:]
        return rows

    def add_sip(self, summary: str, raw: str):
        """Record a SIP message captured by the SIP tracer as a synthetic 'SIP' entry.

        Not gated on `enabled`: the SIP toggle is its own switch, so a trace can be
        watched without also buffering the whole AMI feed.
        """
        with self._lock:
            self._seq += 1
            self._buf.append({
                "seq": self._seq,
                "event": "SIP",
                "ts": _time.time(),
                "summary": summary,
                "fields": {"Message": raw},
            })

    def event_names(self) -> list:
        """Distinct event names currently buffered (sorted), for the filter dropdown."""
        with self._lock:
            names = {e["event"] for e in self._buf}
        return sorted(names)


ami_event_buffer = AMIEventBuffer()


# ---------------------------------------------------------------------------
# System Logs — raw SIP message trace
# ---------------------------------------------------------------------------
# Asterisk writes SIP messages to its own log file when the PJSIP logger is on, not
# over AMI. To interleave them with the AMI feed we tail that file, reassemble each
# multi-line SIP block, and push it into the same buffer as a 'SIP' entry.

# Default FreePBX/Issabel path; override with ASTERISK_LOG_FILE if needed.
ASTERISK_LOG_FILE = os.getenv("ASTERISK_LOG_FILE", "/var/log/asterisk/full")

_SIP_START_RE = re.compile(r"<---\s*(Received|Transmitting|Sending)", re.IGNORECASE)
_SIP_END_RE = re.compile(r"^<-{3,}>$")


class SipTracer:
    """Tails the Asterisk log file and feeds reassembled SIP messages to the buffer.

    Runs in a daemon thread because the tail is blocking file IO. Start/stop is driven
    by the panel's SIP toggle; `last_error` surfaces a path/permission problem back to
    the UI instead of failing silently.
    """

    def __init__(self, buffer: AMIEventBuffer, log_path: str):
        self.buffer = buffer
        self.log_path = log_path
        self.enabled = False
        self.last_error: Optional[str] = None
        self._thread: Optional[threading.Thread] = None
        self._stop = threading.Event()

    def start(self) -> bool:
        if self.enabled:
            return True
        # Verify the file is actually readable before claiming success — the common
        # failure here is a permission or path problem, not a runtime one.
        try:
            open(self.log_path, "r").close()
        except OSError as e:
            self.last_error = f"Cannot read {self.log_path}: {e.strerror or e}"
            log.warning("SIP tracer: %s", self.last_error)
            return False
        self.last_error = None
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, daemon=True, name="sip-tracer")
        self._thread.start()
        self.enabled = True
        return True

    def stop(self):
        self._stop.set()
        self.enabled = False

    def _emit(self, block: list):
        header = block[0]
        idx = header.find("<---")
        htext = header[idx:] if idx >= 0 else header
        summary = htext.replace("<---", "").replace("--->", "").strip()
        self.buffer.add_sip(summary or "SIP message", "\n".join(block))

    def _run(self):
        f = None
        inode = None
        block: list = []
        in_block = False
        while not self._stop.is_set():
            try:
                if f is None:
                    f = open(self.log_path, "r", errors="replace")
                    f.seek(0, os.SEEK_END)
                    inode = os.fstat(f.fileno()).st_ino
                line = f.readline()
                if not line:
                    # No new data: check for log rotation, then wait briefly.
                    try:
                        if os.stat(self.log_path).st_ino != inode:
                            f.close()
                            f = None
                            continue
                    except OSError:
                        pass
                    self._stop.wait(0.4)
                    continue
                line = line.rstrip("\n")
                stripped = line.strip()
                if _SIP_START_RE.search(line):
                    # A new block starts; flush any unterminated previous block.
                    if in_block and len(block) > 1:
                        self._emit(block)
                    in_block = True
                    block = [line]
                elif in_block:
                    if _SIP_END_RE.match(stripped):
                        self._emit(block)
                        in_block = False
                        block = []
                    else:
                        block.append(line)
                        if len(block) > 300:  # safety cap against a runaway block
                            self._emit(block)
                            in_block = False
                            block = []
            except Exception as e:
                log.debug("SIP tracer tail error: %s", e)
                try:
                    if f:
                        f.close()
                except Exception:
                    pass
                f = None
                self._stop.wait(1.0)
        if f:
            try:
                f.close()
            except Exception:
                pass


sip_tracer = SipTracer(ami_event_buffer, ASTERISK_LOG_FILE)


def detect_local_ip() -> str:
    """
    Best-effort detection of the local IPv4 address to use for WebRTC defaults.
    Falls back to loopback if detection fails.
    """
    try:
        # This does not send traffic; it just forces the OS to pick a default
        # outbound interface so we can read its local address.
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("8.8.8.8", 80))
            return s.getsockname()[0]
    except Exception:
        try:
            return socket.gethostbyname(socket.gethostname())
        except Exception:
            return "127.0.0.1"


def log_startup_summary(monitor: AMIExtensionsMonitor):
    """Log startup summary - data is sent to React via WebSocket."""
    # Count stats
    total_ext = len(monitor.monitored)
    active_calls = len(monitor.active_calls)
    total_queues = len(monitor.queues)
    total_members = len(monitor.queue_members)
    total_waiting = len(monitor.queue_entries)
    
    log.info("=" * 60)
    log.info("🚀 INITIAL STATE LOADED")
    log.info(f"   Extensions: {total_ext} monitored")
    log.info(f"   Active Calls: {active_calls}")
    log.info(f"   Queues: {total_queues} (Members: {total_members}, Waiting: {total_waiting})")
    log.info("=" * 60)
    log.info("✅ Now tracking realtime AMI events → React frontend via WebSocket")

# ---------------------------------------------------------------------------
# Connection Manager for WebSocket clients
# ---------------------------------------------------------------------------
class ConnectionManager:
    """Manages WebSocket connections and broadcasts. Stores per-connection user scope for filtered state."""
    
    def __init__(self):
        self.active_connections: Set[WebSocket] = set()
        self._connection_scope: Dict[WebSocket, dict] = {}  # websocket -> {role, allowed_agent_extensions, allowed_queue_names}
        self._lock = asyncio.Lock()
    
    async def connect(self, websocket: WebSocket, user_scope: Optional[dict] = None):
        """Register an already-accepted WebSocket. user_scope: {role, extension, allowed_agent_extensions, allowed_queue_names}."""
        async with self._lock:
            self.active_connections.add(websocket)
            self._connection_scope[websocket] = user_scope or {}
        log.info(f"Client connected. Total connections: {len(self.active_connections)}")
    
    async def disconnect(self, websocket: WebSocket):
        async with self._lock:
            self.active_connections.discard(websocket)
            self._connection_scope.pop(websocket, None)
        log.info(f"Client disconnected. Total connections: {len(self.active_connections)}")
    
    def get_scope(self, websocket: WebSocket) -> dict:
        """Get user scope for this connection (for filtered state)."""
        return self._connection_scope.get(websocket, {})
    
    async def broadcast(self, message: dict):
        """Broadcast same message to all connected clients."""
        if not self.active_connections:
            return
        
        data = json.dumps(message, default=str)
        disconnected = set()
        
        async with self._lock:
            connections = list(self.active_connections)
        
        for connection in connections:
            try:
                await connection.send_text(data)
            except Exception:
                disconnected.add(connection)
        
        if disconnected:
            async with self._lock:
                self.active_connections -= disconnected
                for ws in disconnected:
                    self._connection_scope.pop(ws, None)
    
    async def send_personal(self, websocket: WebSocket, message: dict):
        """Send message to specific client."""
        # Skip if websocket is no longer in active connections
        if websocket not in self.active_connections:
            return False
        try:
            await websocket.send_text(json.dumps(message, default=str))
            return True
        except Exception:
            # Silently handle - client likely disconnected
            return False


# ---------------------------------------------------------------------------
# AMI Event Bridge - connects AMI events to WebSocket broadcasts
# ---------------------------------------------------------------------------
class AMIEventBridge:
    """Bridge between AMI events and WebSocket broadcasts."""
    
    def __init__(self, manager: ConnectionManager, monitor: AMIExtensionsMonitor):
        self.manager = manager
        self.monitor = monitor
        self._running = False
        self._event_task: Optional[asyncio.Task] = None
        self._broadcast_task: Optional[asyncio.Task] = None
        self._state_queue: asyncio.Queue = asyncio.Queue(maxsize=1000)
        self._extension_names: Dict[str, str] = {}  # Cache extension names
    
    async def start(self):
        """Start the event bridge."""
        if self._running:
            return
        
        self._running = True
        
        # Load extension names from database
        self._extension_names = get_extension_names_from_db()
        
        
        # Register callback to receive AMI events
        self.monitor.register_event_callback(self._on_ami_event)
        
        # Start state broadcast task
        self._broadcast_task = asyncio.create_task(self._broadcast_state_loop())
        
        log.info("AMI Event Bridge started")
    
    async def stop(self):
        """Stop the event bridge."""
        self._running = False
        self.monitor.unregister_event_callback(self._on_ami_event)
        
        if self._broadcast_task:
            self._broadcast_task.cancel()
            try:
                await self._broadcast_task
            except asyncio.CancelledError:
                pass
        
        log.info("AMI Event Bridge stopped")
    
    async def _on_ami_event(self, event: Dict[str, str]):
        """Handle AMI event - queue for broadcast."""
        try:
            self._state_queue.put_nowait(event)
        except asyncio.QueueFull:
            # Drop oldest event to make room for the new one
            try:
                self._state_queue.get_nowait()
            except asyncio.QueueEmpty:
                pass
            self._state_queue.put_nowait(event)
    
    async def _broadcast_state_loop(self):
        """Periodically broadcast state and process event queue."""
        last_broadcast = datetime.now()
        
        while self._running:
            try:
                # Process queued events with debouncing
                events_processed = 0
                while not self._state_queue.empty() and events_processed < 10:
                    try:
                        event = self._state_queue.get_nowait()
                        events_processed += 1
                    except asyncio.QueueEmpty:
                        break
                
                # Broadcast current state every 500ms or when events occur
                now = datetime.now()
                if events_processed > 0 or (now - last_broadcast).total_seconds() >= 0.5:
                    await self._broadcast_current_state()
                    last_broadcast = now
                
                await asyncio.sleep(0.1)
                
            except asyncio.CancelledError:
                break
            except Exception as e:
                log.error(f"Broadcast loop error: {e}")
                await asyncio.sleep(1)
    
    async def _broadcast_current_state(self):
        """Broadcast state to each client with their scope filter (role/ext/queue)."""
        async with self.manager._lock:
            connections = list(self.manager.active_connections)
            scopes = {ws: self.manager.get_scope(ws) for ws in connections}
        disconnected = set()
        for connection in connections:
            scope = scopes.get(connection, {})
            allow_ext = None if scope.get("role") == "admin" else (scope.get("allowed_agent_extensions") or [])
            allow_queues = None if scope.get("role") == "admin" else (scope.get("allowed_queue_names") or [])
            state = self.get_current_state(allow_extensions=allow_ext, allow_queues=allow_queues)
            try:
                await self.manager.send_personal(connection, {
                    "type": "state_update",
                    "data": state,
                    "timestamp": datetime.now().isoformat()
                })
            except Exception:
                disconnected.add(connection)
        if disconnected:
            async with self.manager._lock:
                for ws in disconnected:
                    self.manager.active_connections.discard(ws)
                    self.manager._connection_scope.pop(ws, None)
    
    async def broadcast_state_now(self):
        """Trigger immediate state broadcast (public method)."""
        await self._broadcast_current_state()
    
    def get_current_state(self, allow_extensions: Optional[list] = None, allow_queues: Optional[list] = None) -> dict:
        """Get current state, optionally filtered by allowed extensions and queue names (None = no filter)."""
        ext_set = None if allow_extensions is None else set(str(e) for e in allow_extensions)
        queue_set = None if allow_queues is None else set(str(q) for q in allow_queues)
        # Build extensions status
        extensions = {}
        monitored = self.monitor.monitored if ext_set is None else (self.monitor.monitored & ext_set)
        for ext in monitored:
            ext_data = self.monitor.extensions.get(ext, {})
            call_info = self.monitor.active_calls.get(ext, {})
            
            status_code = ext_data.get('Status', '-1')
            
            # Determine display status
            if ext in self.monitor.active_calls:
                state = call_info.get('state', '')
                if state == 'Ringing':
                    status = 'ringing'
                elif state in ('Up', 'Busy'):
                    status = 'in_call'
                elif state == 'Ring':
                    status = 'dialing'
                else:
                    status = 'in_call'
            elif status_code == '0':
                status = 'idle'
            elif status_code in ('1', '2'):
                status = 'in_call'
            elif status_code == '8':
                status = 'ringing'
            elif status_code in ('4', '-1'):
                status = 'unavailable'
            elif status_code in ('16', '32'):
                status = 'on_hold'
            else:
                status = 'idle'
            
            extensions[ext] = {
                "extension": ext,
                "name": self._extension_names.get(ext, ""),
                "status": status,
                "status_code": status_code,
                "dnd": ext in self.monitor.dnd,
                "call_info": self._format_call_info(ext, call_info) if call_info else None
            }
        
        # Build active calls (caller perspective only), filter by ext_set if present
        active_calls = {}
        callees = set()
        
        for ext, info in self.monitor.active_calls.items():
            caller = info.get('caller', '')
            if caller and caller.isdigit() and len(caller) <= 5:
                callees.add(ext)
        
        for ext, info in self.monitor.active_calls.items():
            if ext_set is not None and ext not in ext_set:
                continue
            if not info.get('channel') or not ext.isdigit() or ext in DIALPLAN_CTX:
                continue
            if ext in callees:
                continue
            state = info.get('state', '').strip()
            if state and state.lower() == 'down':
                continue
            
            active_calls[ext] = self._format_call_info(ext, info)
        
        # Build queue info, filter by queue_set if present (extension + display name like agents). Hide "default" queue.
        DEFAULT_QUEUE_HIDDEN = "default"
        queue_display = {q["extension"]: q["queue_name"] for q in get_queues_list()}
        queues = {}
        for queue_ext, queue_info in self.monitor.queues.items():
            if (queue_ext or "").strip().lower() == DEFAULT_QUEUE_HIDDEN:
                continue
            if queue_set is not None and queue_ext not in queue_set:
                continue
            queues[queue_ext] = {
                "extension": queue_ext,
                "name": queue_display.get(queue_ext) or queue_ext,
                "members": queue_info.get('members', {}),
                "calls_waiting": queue_info.get('calls_waiting', 0)
            }
        
        queue_members = {}
        for member_key, member_info in self.monitor.queue_members.items():
            q = member_info.get('queue', '')
            if (q or "").strip().lower() == DEFAULT_QUEUE_HIDDEN:
                continue
            if queue_set is not None and q not in queue_set:
                continue
            queue_members[member_key] = {
                "queue": member_info.get('queue', ''),
                "interface": member_info.get('interface', ''),
                "membername": member_info.get('membername', ''),
                "status": member_info.get('status', ''),
                "paused": member_info.get('paused', False),
                "pause_reason": member_info.get('pause_reason', '') or '',
                "dynamic": member_info.get('dynamic', False)
            }
        
        queue_entries = {}
        for uniqueid, entry in self.monitor.queue_entries.items():
            q = entry.get('queue', '')
            if (q or "").strip().lower() == DEFAULT_QUEUE_HIDDEN:
                continue
            if queue_set is not None and q not in queue_set:
                continue
            entry_time = entry.get('entry_time')
            wait_time = None
            if entry_time:
                wait_duration = datetime.now() - entry_time
                wait_time = _format_duration(wait_duration)
            
            queue_entries[uniqueid] = {
                "queue": entry.get('queue', ''),
                "callerid": entry.get('callerid', ''),
                "position": entry.get('position', 0),
                "wait_time": wait_time
            }
        
        return {
            "extensions": extensions,
            "active_calls": active_calls,
            "queues": queues,
            "queue_members": queue_members,
            "queue_entries": queue_entries,
            "stats": {
                "total_extensions": len(extensions),
                "active_calls_count": len(active_calls),
                "total_queues": len(queues),
                "total_waiting": sum(q.get('calls_waiting', 0) for q in queues.values())
            }
        }
    
    def _format_call_info(self, ext: str, info: dict) -> dict:
        """Format call info for frontend."""
        # Calculate durations
        duration = None
        talk_time = None
        
        if 'start_time' in info:
            duration = _format_duration(datetime.now() - info['start_time'])
            if info.get('answer_time'):
                talk_time = _format_duration(datetime.now() - info['answer_time'])
        
        # Get talking to number
        talking_to = self.monitor._display_number(info, ext)

        # Resolved CRM contact name for the remote party. resolve_cached is a
        # memory-only dict lookup (this method runs per call-row per WS client
        # per broadcast tick) — a miss schedules one background CRM fetch and the
        # name simply appears on a later tick.
        contact_name = ""
        if contact_resolver is not None:
            contact_name = contact_resolver.resolve_cached(
                talking_to, getattr(self.monitor, 'monitored', None)) or ""

        return {
            "extension": ext,
            "state": info.get('state', ''),
            "talking_to": talking_to,
            "contact_name": contact_name,
            "duration": duration,
            "talk_time": talk_time,
            "channel": info.get('channel', ''),
            "caller": info.get('caller', ''),
            "callerid": info.get('callerid', ''),
            "destination": info.get('destination', ''),
            "original_destination": info.get('original_destination', '')
        }


# ---------------------------------------------------------------------------
# CRM Configuration Helper
# ---------------------------------------------------------------------------
def init_crm_connector() -> Optional[CRMConnector]:
    """
    Initialize CRM connector from database settings.
    
    Database settings:
        CRM_ENABLED: Set to 'true' or '1' to enable CRM (default: disabled)
        CRM_SERVER_URL: CRM server URL (required if enabled)
        CRM_AUTH_TYPE: Authentication type - 'api_key', 'basic_auth', 'bearer_token', or 'oauth2' (required if enabled)
        
        For API_KEY auth:
            CRM_API_KEY: API key
            CRM_API_KEY_HEADER: API key header name (optional, default: 'X-API-Key')
        
        For BASIC_AUTH:
            CRM_USERNAME: Username
            CRM_PASSWORD: Password
        
        For BEARER_TOKEN:
            CRM_BEARER_TOKEN: Bearer token
        
        For OAUTH2:
            CRM_OAUTH2_CLIENT_ID: OAuth2 client ID
            CRM_OAUTH2_CLIENT_SECRET: OAuth2 client secret
            CRM_OAUTH2_TOKEN_URL: OAuth2 token endpoint URL
            CRM_OAUTH2_SCOPE: OAuth2 scope (optional)
        
        Optional:
            CRM_ENDPOINT_PATH: API endpoint path (default: '/api/calls')
            CRM_TIMEOUT: Request timeout in seconds (default: 30)
            CRM_VERIFY_SSL: Verify SSL certificates (default: 'true')
    
    Returns:
        CRMConnector instance if configured, None otherwise
    """
    if CRMConnector is None:
        log.warning("CRM connector not available - CRM functionality disabled")
        return None
    
    # Check if CRM is enabled (from database, fallback to env)
    crm_enabled_str = get_setting('CRM_ENABLED', os.getenv('CRM_ENABLED', ''))
    crm_enabled = crm_enabled_str.lower() in ('true', '1', 'yes')
    if not crm_enabled:
        log.info("CRM is disabled (set CRM_ENABLED=true to enable)")
        return None
    
    # Get required configuration (from database, fallback to env)
    server_url = get_setting('CRM_SERVER_URL', os.getenv('CRM_SERVER_URL', '')).strip()
    auth_type_str = get_setting('CRM_AUTH_TYPE', os.getenv('CRM_AUTH_TYPE', '')).strip().lower()
    
    if not server_url:
        log.warning("CRM_ENABLED is true but CRM_SERVER_URL is not set - CRM disabled")
        return None
    
    if not auth_type_str:
        log.warning("CRM_ENABLED is true but CRM_AUTH_TYPE is not set - CRM disabled")
        return None
    
    # Build configuration dictionary (from database, fallback to env)
    config = {
        "server_url": server_url,
        "auth_type": auth_type_str,
        "endpoint_path": get_setting('CRM_ENDPOINT_PATH', os.getenv('CRM_ENDPOINT_PATH', '/api/calls')),
        "timeout": int(get_setting('CRM_TIMEOUT', os.getenv('CRM_TIMEOUT', '30'))),
        "verify_ssl": get_setting('CRM_VERIFY_SSL', os.getenv('CRM_VERIFY_SSL', 'true')).lower() in ('true', '1', 'yes')
    }
    
    # Add auth-specific configuration (from database, fallback to env)
    if auth_type_str == 'api_key':
        api_key = get_setting('CRM_API_KEY', os.getenv('CRM_API_KEY', '')).strip()
        if not api_key:
            log.warning("CRM_AUTH_TYPE is 'api_key' but CRM_API_KEY is not set - CRM disabled")
            return None
        config["api_key"] = api_key
        api_key_header = get_setting('CRM_API_KEY_HEADER', os.getenv('CRM_API_KEY_HEADER', '')).strip()
        if api_key_header:
            config["api_key_header"] = api_key_header
    
    elif auth_type_str == 'basic_auth':
        username = get_setting('CRM_USERNAME', os.getenv('CRM_USERNAME', '')).strip()
        password = get_setting('CRM_PASSWORD', os.getenv('CRM_PASSWORD', '')).strip()
        if not username or not password:
            log.warning("CRM_AUTH_TYPE is 'basic_auth' but CRM_USERNAME or CRM_PASSWORD is not set - CRM disabled")
            return None
        config["username"] = username
        config["password"] = password
    
    elif auth_type_str == 'bearer_token':
        bearer_token = get_setting('CRM_BEARER_TOKEN', os.getenv('CRM_BEARER_TOKEN', '')).strip()
        if not bearer_token:
            log.warning("CRM_AUTH_TYPE is 'bearer_token' but CRM_BEARER_TOKEN is not set - CRM disabled")
            return None
        config["bearer_token"] = bearer_token
    
    elif auth_type_str == 'oauth2':
        client_id = get_setting('CRM_OAUTH2_CLIENT_ID', os.getenv('CRM_OAUTH2_CLIENT_ID', '')).strip()
        client_secret = get_setting('CRM_OAUTH2_CLIENT_SECRET', os.getenv('CRM_OAUTH2_CLIENT_SECRET', '')).strip()
        token_url = get_setting('CRM_OAUTH2_TOKEN_URL', os.getenv('CRM_OAUTH2_TOKEN_URL', '')).strip()
        if not client_id or not client_secret:
            log.warning("CRM_AUTH_TYPE is 'oauth2' but CRM_OAUTH2_CLIENT_ID or CRM_OAUTH2_CLIENT_SECRET is not set - CRM disabled")
            return None
        config["oauth2_client_id"] = client_id
        config["oauth2_client_secret"] = client_secret
        if token_url:
            config["oauth2_token_url"] = token_url
        oauth2_scope = get_setting('CRM_OAUTH2_SCOPE', os.getenv('CRM_OAUTH2_SCOPE', '')).strip()
        if oauth2_scope:
            config["oauth2_scope"] = oauth2_scope
    else:
        log.warning(f"Invalid CRM_AUTH_TYPE: {auth_type_str}. Must be one of: api_key, basic_auth, bearer_token, oauth2")
        return None
    
    # Create and return CRM connector
    try:
        crm_connector = create_crm_connector(config)
        log.info(f"✅ CRM connector initialized: {server_url} (auth: {auth_type_str})")
        return crm_connector
    except Exception as e:
        log.error(f"Failed to initialize CRM connector: {e}")
        return None


def load_crm_sync_config() -> Optional["CRMSyncConfig"]:
    """
    Build the call-data sync configuration from settings.

    This is read at startup AND rebuilt whenever the config is saved, so changes
    take effect without a server restart. Defaults preserve the original
    behaviour: sync enabled, all directions on, and the legacy 8-field payload.
    """
    if CRMSyncConfig is None:
        return None

    def _flag(key: str, default: str = 'true') -> bool:
        return (get_setting(key, os.getenv(key, default)) or default).lower() in ('true', '1', 'yes')

    # The push endpoint falls back to the connection endpoint_path when unset, so
    # an upgraded install keeps POSTing to the same path it always did.
    sync_endpoint = (get_setting('CRM_SYNC_ENDPOINT', os.getenv('CRM_SYNC_ENDPOINT', '')) or '').strip()
    if not sync_endpoint:
        sync_endpoint = get_setting('CRM_ENDPOINT_PATH', os.getenv('CRM_ENDPOINT_PATH', '/api/calls'))

    method = (get_setting('CRM_SYNC_METHOD', os.getenv('CRM_SYNC_METHOD', 'POST')) or 'POST').upper()
    if method not in ('POST', 'PUT'):
        method = 'POST'

    raw_fields = get_setting('CRM_SYNC_FIELDS', os.getenv('CRM_SYNC_FIELDS', ''))
    fields = parse_sync_fields(raw_fields) if raw_fields else list(DEFAULT_CRM_SYNC_FIELDS)
    if not fields:
        fields = list(DEFAULT_CRM_SYNC_FIELDS)

    duration_format = (get_setting('CRM_SYNC_DURATION_FORMAT',
                                   os.getenv('CRM_SYNC_DURATION_FORMAT', 'hms'))
                       or 'hms').strip().lower()
    if duration_format not in ('hms', 'seconds'):
        duration_format = 'hms'

    status_map = parse_status_map(get_setting('CRM_SYNC_STATUS_MAP', '')) if parse_status_map else {}
    key_map = parse_key_map(get_setting('CRM_SYNC_KEY_MAP', '')) if parse_key_map else {}

    return CRMSyncConfig(
        enabled=_flag('CRM_SYNC_ENABLED'),
        endpoint=sync_endpoint,
        method=method,
        fields=fields,
        dir_inbound=_flag('CRM_SYNC_DIR_INBOUND'),
        dir_outbound=_flag('CRM_SYNC_DIR_OUTBOUND'),
        dir_internal=_flag('CRM_SYNC_DIR_INTERNAL'),
        block_private=_flag('CRM_BLOCK_PRIVATE', 'false'),
        duration_format=duration_format,
        status_map=status_map,
        key_map=key_map,
    )


def load_crm_lookup_config() -> Optional["CRMLookupConfig"]:
    """
    Build the contact-lookup configuration from settings. Like load_crm_sync_config,
    this is read at startup AND rebuilt on every config save (live reload).
    """
    if CRMLookupConfig is None:
        return None

    def _flag(key: str, default: str = 'false') -> bool:
        return (get_setting(key, os.getenv(key, default)) or default).lower() in ('true', '1', 'yes')

    def _text(key: str, default: str = '') -> str:
        return (get_setting(key, os.getenv(key, default)) or default).strip()

    def _int(key: str, default: int, minimum: int) -> int:
        try:
            return max(minimum, int(_text(key, str(default)) or default))
        except (TypeError, ValueError):
            return default

    number_format = _text('CRM_LOOKUP_NUMBER_FORMAT', 'digits').lower()
    if number_format not in LOOKUP_NUMBER_FORMATS:
        number_format = 'digits'

    return CRMLookupConfig(
        enabled=_flag('CRM_LOOKUP_ENABLED'),
        url_template=_text('CRM_LOOKUP_URL'),
        name_template=_text('CRM_LOOKUP_NAME_TEMPLATE'),
        number_format=number_format,
        match_digits=_int('CRM_LOOKUP_MATCH_DIGITS', 0, 0),
        verify_path=_text('CRM_LOOKUP_VERIFY_PATH'),
        ttl_hours=_int('CRM_LOOKUP_TTL_HOURS', 24, 1),
    )


def _migrate_crm_sync_fields() -> None:
    """One-shot: rewrite retired catalog names in the stored CRM_SYNC_FIELDS.

    parse_sync_fields() silently discards any field not in the current catalog, so
    without this an upgraded install would lose a selected field (e.g. `linkedid`,
    now `call_id`) with no warning. Idempotent — after the first run the stored
    value contains no retired names.
    """
    if not RETIRED_CRM_SYNC_FIELDS:
        return
    try:
        raw = get_setting('CRM_SYNC_FIELDS', '')
        if not raw:
            return
        out, seen, changed = [], set(), False
        for name in str(raw).split(','):
            name = name.strip()
            if not name:
                continue
            if name in RETIRED_CRM_SYNC_FIELDS:
                name = RETIRED_CRM_SYNC_FIELDS[name]
                changed = True
            if name not in seen:
                seen.add(name)
                out.append(name)
        if changed:
            set_setting('CRM_SYNC_FIELDS', ','.join(out))
            log.info("Migrated retired CRM_SYNC_FIELDS names -> %s", ','.join(out))
    except Exception as e:
        log.warning("CRM_SYNC_FIELDS migration skipped: %s", e)


# ---------------------------------------------------------------------------
# Global instances
# ---------------------------------------------------------------------------
manager = ConnectionManager()
monitor: Optional[AMIExtensionsMonitor] = None
bridge: Optional[AMIEventBridge] = None
crm_connector: Optional[CRMConnector] = None
presence: Optional[PresenceRecorder] = None
# Contact-name resolver (CRM lookup). Always constructed so call sites can stay
# unconditional; it is inert until set_config() gives it a usable config+connector.
contact_resolver = ContactResolver() if ContactResolver else None

# Extensions that received a predial VoIP wake push, keyed by extension → loop.time().
# _on_incoming_call suppresses the second VoIP push while this entry is fresh so the
# mobile app only ever gets one VoIP push (and therefore one CallKit/ConnectionService
# call UUID) per incoming call.
_pre_woken: Dict[str, float] = {}
_PRE_WAKE_TTL = 12  # seconds — covers Wait(3) + dial setup + clock slop


# ---------------------------------------------------------------------------
# FastAPI App
# ---------------------------------------------------------------------------
@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan - setup and teardown."""
    global monitor, bridge, crm_connector, presence

    # Startup
    log.info("Starting Asterisk Operator Panel Server...")

    # Initialize settings table
    init_settings_table()
    # Ensure the Not-Ready Codes (pause reasons) catalog exists + is seeded
    init_pause_reasons_table()
    # Ensure the supervision (listen/whisper/barge) events table exists
    init_call_supervision_table()
    # Ensure the agent presence segments table (Agent Adherence data source) exists
    init_agent_activity_table()
    # Ensure the machine-to-machine API key table exists
    init_api_keys_table()
    # Ensure the CRM webhook delivery log table exists
    init_webhook_deliveries_table()
    # Ensure the contacts table (system phonebook) exists
    init_contacts_table()


    # WebRTC default host: prefer the configured public domain (its TLS cert matches); otherwise
    # fall back to the detected local IP. Can be overridden via settings/UI.
    webrtc_host = os.getenv("OPDESK_DOMAIN", "").strip() or detect_local_ip()

    # Initialize default settings if they don't exist
    default_settings = {
        'SIP_TLS_ENABLED': 'false',
        'QOS_ENABLED': 'false',
        'CRM_ENABLED': 'false',
        'CRM_AUTH_TYPE': 'api_key',
        'CRM_ENDPOINT_PATH': '/api/calls',
        'CRM_TIMEOUT': '30',
        'CRM_VERIFY_SSL': 'true',
        # Call-data sync (push) — defaults reproduce the original fixed payload so
        # enabling CRM on an upgraded install keeps the exact same behaviour.
        'CRM_SYNC_ENABLED': 'true',
        'CRM_SYNC_METHOD': 'POST',
        'CRM_SYNC_FIELDS': ','.join(DEFAULT_CRM_SYNC_FIELDS),
        'CRM_SYNC_DIR_INBOUND': 'true',
        'CRM_SYNC_DIR_OUTBOUND': 'true',
        'CRM_SYNC_DIR_INTERNAL': 'true',
        'CRM_BLOCK_PRIVATE': 'false',  # allow on-prem/LAN CRM by default
        'CRM_SYNC_DURATION_FORMAT': 'hms',  # hms | seconds
        'CRM_SYNC_STATUS_MAP': '{}',        # {FROM: TO} outcome remap
        'CRM_SYNC_KEY_MAP': '{}',           # {defaultKey: customKey} rename
        # Contact lookup (3CX-style): GET template with [Number], name template of
        # JSON paths, prefix strategy, last-N-digit matching, optional verification.
        'CRM_LOOKUP_ENABLED': 'false',
        'CRM_LOOKUP_URL': '',
        'CRM_LOOKUP_NAME_TEMPLATE': '',
        'CRM_LOOKUP_NUMBER_FORMAT': 'digits',  # digits | as_is | plus | zeros
        'CRM_LOOKUP_MATCH_DIGITS': '0',        # compare/cache on last N digits (0 = full)
        'CRM_LOOKUP_VERIFY_PATH': '',
        'CRM_LOOKUP_TTL_HOURS': '24',
        'WEBHOOK_LOG_RETENTION_DAYS': '30',
        'CLICK_TO_CALL_CONTEXT': 'from-internal',
        'WEBRTC_PBX_SERVER': f'wss://{webrtc_host}/sip-ws',
    }

    for key, default_value in default_settings.items():
        current_value = get_setting(key)
        if current_value is None or current_value == '':
            set_setting(key, default_value)
            log.info(f"Initialized default setting: {key}={default_value}")

    # Rewrite retired catalog names before any sync config is read.
    _migrate_crm_sync_fields()

    # Initialize CRM connector if configured
    crm_connector = init_crm_connector()

    # Arm the contact-name resolver: load the phonebook into memory (resolves
    # names even with no CRM) and the lookup config (live CRM fetch on miss).
    if contact_resolver is not None:
        contact_resolver.set_config(load_crm_lookup_config(), crm_connector)
        contact_resolver.set_contacts(get_contacts_for_resolver())

    # Check and apply QoS configuration from database (fallback to env)
    qos_enabled_str = get_setting('QOS_ENABLED', os.getenv('QOS_ENABLED', ''))
    qos_enabled = qos_enabled_str.lower() in ('true', '1', 'yes')
    if qos_enabled:
        log.info("QOS_ENABLED is set to true. Enabling QoS configuration...")
        try:
            if enable_qos():
                log.info("✅ QoS configuration enabled on startup")
            else:
                log.warning("⚠️ Failed to enable QoS configuration on startup")
        except Exception as e:
            log.error(f"Error enabling QoS on startup: {e}")
    else:
        log.info("QOS_ENABLED is not set or disabled. QoS will not be configured automatically.")

    # Check and apply mobile wake configuration from database (fallback to env)
    mobile_wake_enabled_str = get_setting('MOBILE_WAKE_ENABLED', os.getenv('MOBILE_WAKE_ENABLED', ''))
    if mobile_wake_enabled_str.lower() in ('true', '1', 'yes'):
        wait_seconds_str = get_setting('MOBILE_WAKE_WAIT', os.getenv('MOBILE_WAKE_WAIT', '3'))
        try:
            if enable_mobile_wake(wait_seconds=int(wait_seconds_str)):
                log.info("✅ Mobile wake dialplan enabled on startup (wait=%ss)", wait_seconds_str)
            else:
                log.warning("⚠️ Failed to enable mobile wake dialplan on startup")
        except Exception as e:
            log.error(f"Error enabling mobile wake on startup: {e}")

    # Check and apply call recording configuration from database (fallback to env)
    recording_enabled_str = get_setting('RECORDING_ENABLED', os.getenv('RECORDING_ENABLED', ''))
    if recording_enabled_str.lower() in ('true', '1', 'yes'):
        rec_format = get_setting('RECORDING_FORMAT', os.getenv('RECORDING_FORMAT', 'wav'))
        try:
            if enable_recording(mix_format=rec_format):
                log.info("✅ Call recording dialplan enabled on startup (format=%s)", rec_format)
            else:
                log.warning("⚠️ Failed to enable call recording dialplan on startup")
        except Exception as e:
            log.error(f"Error enabling call recording on startup: {e}")

    # Create AMI monitor with CRM connector + call-data sync config
    monitor = AMIExtensionsMonitor(crm_connector=crm_connector, crm_sync_config=load_crm_sync_config())

    # Retry loop — needed when SIP TLS startup restarts Asterisk right before we connect
    _ami_connected = False
    for _attempt in range(1, 11):
        if await monitor.connect():
            _ami_connected = True
            break
        log.warning("AMI connect attempt %d/10 failed — retrying in 3s", _attempt)
        await asyncio.sleep(3)

    if _ami_connected:
        log.info("Connected to AMI")
        
        # Load extensions
        extensions = get_extensions_from_db()
        if extensions:
            monitor.monitored = set(str(e) for e in extensions)
            log.info(f"Monitoring {len(extensions)} extensions")
        
        # Initial sync (BEFORE starting event reader to avoid concurrent reads)
        # This gets the current state of all calls, extensions and queues
        await monitor.sync_extension_statuses()
        await monitor.sync_active_calls()
        await monitor.sync_queue_status()
        await monitor.sync_dnd_state()
        
        # 🚀 Log startup summary (data goes to React via WebSocket)
        log_startup_summary(monitor)
        
        # Enable event monitoring (after syncs complete)
        await monitor._send_async('Events', {'EventMask': 'on'})
        monitor.running = True
        monitor._event_task = asyncio.create_task(monitor._read_events_async())

        def _on_call_notification_new(ext: str):
            try:
                loop = asyncio.get_running_loop()
                loop.create_task(manager.broadcast({"type": "call_notification_new", "extension": ext}))
                loop.create_task(_dispatch_missed_call_push(ext))
            except RuntimeError:
                pass
        monitor.set_call_notification_callback(_on_call_notification_new)

        # Feed the System Logs panel. The buffer is disabled by default, so until an
        # admin turns it on this costs one attribute read per AMI event.
        monitor.set_raw_event_sink(ami_event_buffer.add)

        def _on_incoming_call(ext: str, caller: str, call_id: str, display_name: str):
            try:
                loop = asyncio.get_running_loop()
                # Warm the CRM contact cache at first ring so the name is usually
                # resolved by the time the softphone asks for it. Runs before the
                # pre-wake dedup below — that guard is about VoIP pushes only.
                if contact_resolver is not None:
                    contact_resolver.resolve_cached(caller, monitor.monitored if monitor else None)
                # If a predial VoIP push was already sent for this extension, skip the
                # second push.  Two VoIP pushes → two CallKit UUIDs → end-call event
                # lands on the wrong UUID → no SIP BYE → caller stuck.
                wake_time = _pre_woken.pop(ext, 0.0)
                if loop.time() - wake_time < _PRE_WAKE_TTL:
                    return
                loop.create_task(push_service.send_call_wake(ext, caller, call_id, display_name))
            except RuntimeError:
                pass
        monitor.set_incoming_call_callback(_on_incoming_call)

        # Start event bridge
        bridge = AMIEventBridge(manager, monitor)
        await bridge.start()

        # Agent presence recorder — writes agent_activity segments (Agent Adherence
        # data source). Reconciles call flow + feature-code actions from AMI events,
        # then hydrates from the live queue state so already-logged-in agents count.
        presence = PresenceRecorder(monitor)
        monitor.register_event_callback(presence.handle_ami_event)
        try:
            await presence.hydrate()
        except Exception as e:
            log.warning(f"Agent presence hydrate failed: {e}")

        # Start analytics pre-aggregation background task
        asyncio.create_task(analytics_module.start_aggregation_loop())

        log.info("🎯 Server ready - tracking realtime AMI events")
    else:
        log.error("Failed to connect to AMI")
    
    yield
    
    # Shutdown
    log.info("Shutting down...")
    if bridge:
        await bridge.stop()
    if monitor:
        await monitor.disconnect()
    if crm_connector:
        await crm_connector.close()
        log.info("CRM connector closed")
    await push_service.close()


async def _dispatch_missed_call_push(ext: str):
    """Build a missed-call banner from the latest notification row and send it as an alert push."""
    try:
        rows = await asyncio.to_thread(get_call_notifications_from_db, ext, None, 1)
        row = rows[0] if rows else {}
        caller = row.get("caller_from") or "Unknown"
        body = f"Missed call from {caller}"
        if row.get("queue"):
            body += f" (queue {row['queue']})"
        await push_service.send_alert(
            ext,
            title="Missed call",
            body=body,
            data={
                "type": "call_notification_new",
                "extension": ext,
                "caller_from": row.get("caller_from") or "",
                "queue": row.get("queue") or "",
                "reason": row.get("reason") or "",
                "call_id": row.get("call_id") or "",
            },
        )
    except Exception as e:
        log.debug("missed-call push dispatch error: %s", e)


app = FastAPI(
    title="Asterisk Operator Panel",
    description="Real-time extension monitoring and call management",
    version="1.2.0",
    lifespan=lifespan
)

# CORS for React development
_cors_origins_env = os.getenv("CORS_ALLOWED_ORIGINS", "")
_cors_origins = [o.strip() for o in _cors_origins_env.split(",") if o.strip()] or ["*"]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_credentials=(_cors_origins != ["*"]),
    allow_methods=["*"],
    allow_headers=["*"],
)

# Auth: JWT
JWT_ALGORITHM = "HS256"
JWT_EXPIRE_HOURS = 24


def _get_jwt_secret() -> str:
    secret = get_setting("JWT_SECRET", os.getenv("JWT_SECRET", "")).strip()
    if not secret:
        secret = "opdesk-dev-secret-change-in-production"
        log.warning("JWT_SECRET not set; using default (set JWT_SECRET in production)")
    return secret


def create_access_token(user: dict) -> str:
    payload = {
        "sub": str(user["id"]),
        "username": user["username"],
        "role": user["role"],
        "exp": datetime.now(timezone.utc) + timedelta(hours=JWT_EXPIRE_HOURS),
        "iat": datetime.now(timezone.utc),
    }
    return jwt.encode(payload, _get_jwt_secret(), algorithm=JWT_ALGORITHM)


def decode_token(token: str) -> Optional[dict]:
    try:
        return jwt.decode(token, _get_jwt_secret(), algorithms=[JWT_ALGORITHM])
    except Exception:
        return None


security = HTTPBearer(auto_error=False)


def _get_user_scope(user_id: int) -> dict:
    """Load user extension, monitor_modes (list), and allowed agents/queues. Admin: allowed_* = None. All roles: monitor_modes from DB (or default listen)."""
    user = get_user_by_id(user_id)
    if not user:
        return {"role": "supervisor", "extension": None, "monitor_modes": ["listen"], "allowed_agent_extensions": [], "allowed_queue_names": []}
    role = user.get("role") or "supervisor"
    extension = user.get("extension")
    monitor_modes = user.get("monitor_modes") or ["listen"]
    if role == "admin":
        return {"role": "admin", "extension": extension, "monitor_modes": monitor_modes, "allowed_agent_extensions": None, "allowed_queue_names": None}
    if role == "agent":
        agent_exts = [extension] if extension else []
        return {"role": "agent", "extension": extension, "monitor_modes": [], "allowed_agent_extensions": agent_exts, "allowed_queue_names": []}
    agents, queues = get_user_agents_and_queues(user_id)
    return {
        "role": role,
        "extension": extension,
        "monitor_modes": monitor_modes,
        "allowed_agent_extensions": agents or [],
        "allowed_queue_names": queues or [],
    }


def _user_from_jwt(credentials: Optional[HTTPAuthorizationCredentials]) -> dict:
    """Resolve a bearer JWT into the principal dict. Raises 401 if it is missing or invalid."""
    if not credentials or not credentials.credentials:
        raise HTTPException(status_code=401, detail="Not authenticated")
    payload = decode_token(credentials.credentials)
    if not payload:
        raise HTTPException(status_code=401, detail="Invalid or expired token")
    user_id = int(payload["sub"])
    scope = _get_user_scope(user_id)
    return {
        "id": user_id,
        "username": payload["username"],
        "role": scope["role"],
        "extension": scope.get("extension"),
        "monitor_modes": scope.get("monitor_modes") or ["listen"],
        "allowed_agent_extensions": scope.get("allowed_agent_extensions"),
        "allowed_queue_names": scope.get("allowed_queue_names"),
    }


async def get_current_user(
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(security),
) -> dict:
    """Dependency: require a valid JWT. Returns id, username, role, extension,
    allowed_agent_extensions, allowed_queue_names.

    ⚠️  DELIBERATELY JWT-ONLY — it must NEVER consult _extract_api_key(). This is the
    fail-closed property of the whole API-key design: a machine key works only on the
    routes explicitly wired with require_scope(), so every other route — all of
    /api/settings*, /api/crm/*, /api/api-keys*, /api/logs*, /api/users* — is
    unreachable by a key. "Unifying" the two dependencies would silently promote every
    API key to a full admin credential.
    """
    return _user_from_jwt(credentials)


# ---------------------------------------------------------------------------
# Machine-to-machine API keys
# ---------------------------------------------------------------------------
API_KEY_HEADER = "X-API-Key"

# Permission tokens a key can be granted, in `resource:verb` form. Every one of these
# gates at least one real route (see require_scope call sites) — unreachable
# "reserved" scopes are deliberately not offered, because showing them in the
# Settings picker invites operators to grant access that does not exist.
ALL_PERMISSIONS = [
    "calls:read",      # live calls, extensions, queues, AMI status
    "calls:write",     # call origination (click-to-call)
    "cdr:read",        # call history, journey, VAD, recordings
    "analytics:read",  # dashboards, KPIs, CSV/XLSX export
]


def _extract_api_key(request: Request) -> Optional[str]:
    """Pull a presented API key from the request, or None.

    Accepted as `X-API-Key`, or as `Authorization: Bearer opd_…` — the key prefix is
    what disambiguates a key from a JWT on the shared Authorization header.
    """
    key = request.headers.get(API_KEY_HEADER)
    if key and key.strip():
        return key.strip()
    auth = request.headers.get("Authorization", "")
    if auth.startswith("Bearer "):
        token = auth[7:].strip()
        if API_KEY_PREFIX and token.startswith(API_KEY_PREFIX):
            return token
    return None


def _apikey_principal(meta: dict) -> dict:
    """Shape a validated key into a principal dict.

    role is "admin" and the row-scoping lists are None so downstream per-user
    filtering (call-log extension scoping, _analytics_scope) returns unrestricted
    data — a machine credential is a *system* principal, not a person. What the key
    can actually reach is bounded by its scopes, not by this role.
    """
    return {
        "id": None,
        "username": f"apikey:{meta['name']}",
        "role": "admin",
        "extension": None,
        "monitor_modes": ["listen", "whisper", "barge"],
        "allowed_agent_extensions": None,
        "allowed_queue_names": None,
        "api_key": True,
        "api_key_id": meta["id"],
        "scopes": meta.get("scopes") or [],
    }


def require_scope(scope: str):
    """Dependency factory for the integration surface: accept an API key holding
    `scope`, or fall back to a normal JWT.

    Note the JWT fallback performs NO role check — that is correct for the read
    routes, which already scope their rows by the caller's groups, but any route with
    a side effect must add its own authorisation check on top (see click-to-call).
    """
    async def dependency(
        request: Request,
        credentials: Optional[HTTPAuthorizationCredentials] = Depends(security),
    ) -> dict:
        raw_key = _extract_api_key(request)
        if raw_key:
            meta = lookup_api_key(raw_key) if lookup_api_key else None
            if not meta:
                raise HTTPException(status_code=401, detail="Invalid or expired API key")
            if scope not in (meta.get("scopes") or []):
                raise HTTPException(
                    status_code=403,
                    detail=f"API key missing required scope: {scope}")
            return _apikey_principal(meta)
        return _user_from_jwt(credentials)

    return dependency


# ---------------------------------------------------------------------------
# Auth API (public)
# ---------------------------------------------------------------------------

# Brute-force protection: track failed attempts per IP
_LOGIN_MAX_ATTEMPTS = 10   # failures before lockout
_LOGIN_WINDOW_SECS = 300   # sliding window (5 min)
_LOCKOUT_SECS = 600        # lockout duration (10 min)
_login_attempts: Dict[str, list] = {}   # ip -> [timestamp, ...]
_login_locked: Dict[str, float] = {}    # ip -> lockout_until


def _check_login_rate_limit(ip: str) -> None:
    now = datetime.now(timezone.utc).timestamp()
    # Check active lockout
    if ip in _login_locked:
        if now < _login_locked[ip]:
            retry_after = int(_login_locked[ip] - now)
            raise HTTPException(
                status_code=429,
                detail=f"Too many failed login attempts. Try again in {retry_after}s.",
                headers={"Retry-After": str(retry_after)},
            )
        else:
            del _login_locked[ip]
            _login_attempts.pop(ip, None)
    # Prune old attempts outside window
    attempts = _login_attempts.get(ip, [])
    attempts = [t for t in attempts if now - t < _LOGIN_WINDOW_SECS]
    _login_attempts[ip] = attempts


def _record_login_failure(ip: str) -> None:
    now = datetime.now(timezone.utc).timestamp()
    attempts = _login_attempts.setdefault(ip, [])
    attempts.append(now)
    if len(attempts) >= _LOGIN_MAX_ATTEMPTS:
        _login_locked[ip] = now + _LOCKOUT_SECS
        _login_attempts.pop(ip, None)
        log.warning(f"Login rate limit: {ip} locked out for {_LOCKOUT_SECS}s")


def _clear_login_failures(ip: str) -> None:
    _login_attempts.pop(ip, None)
    _login_locked.pop(ip, None)


class LoginBody(BaseModel):
    login: str
    password: str


@app.post("/api/auth/login")
async def auth_login(body: LoginBody, request: Request):
    """
    Login with extension or username and password.
    Body: { "login": "ext_or_username", "password": "..." }
    Returns: { "access_token": "...", "token_type": "bearer", "user": { id, username, name, role } }
    """
    client_ip = request.client.host if request.client else "unknown"
    _check_login_rate_limit(client_ip)
    login = (body.login or "").strip()
    password = body.password or ""
    if not login or not password:
        raise HTTPException(status_code=400, detail="Login and password required")
    user = authenticate_user(login, password)
    if not user:
        _record_login_failure(client_ip)
        raise HTTPException(status_code=401, detail="Invalid extension/username or password")
    _clear_login_failures(client_ip)
    token = create_access_token(user)
    scope = _get_user_scope(user["id"])
    return {
        "access_token": token,
        "token_type": "bearer",
        "user": {
            "id": user["id"],
            "username": user["username"],
            "name": user.get("name"),
            "role": user["role"],
            "extension": user.get("extension"),
            "monitor_modes": scope.get("monitor_modes") or ["listen"],
            "allowed_agent_extensions": scope.get("allowed_agent_extensions"),
            "allowed_queue_names": scope.get("allowed_queue_names"),
        },
    }


@app.get("/api/auth/me")
async def auth_me(current_user: dict = Depends(get_current_user)):
    """Return current user with role, extension, and filter scope (requires valid token)."""
    return current_user


@app.get("/api/webrtc/config")
async def webrtc_config(request: Request, current_user: dict = Depends(get_current_user)):
    """
    Return WebRTC softphone config for the current user: PBX WebSocket server URL (from settings),
    user extension and extension_secret (from DB). Used by the React softphone to register with SIP.js.
    """
    stored = (get_setting("WEBRTC_PBX_SERVER", os.getenv("WEBRTC_PBX_SERVER", "")) or "").strip()
    # When the stored value is empty or still the legacy direct-Asterisk default (port 8089),
    # compute the URL from the request host so it works on any hostname without reconfiguration.
    import re
    if not stored or re.match(r'^wss?://[^:/]+:8089/ws$', stored):
        host = request.headers.get("x-forwarded-host") or request.headers.get("host") or ""
        host = host.split(",")[0].strip()
        server = f"wss://{host}/sip-ws" if host else stored
    else:
        server = stored

    # If the resulting URL points at a raw IP but a domain is configured, rewrite the host to
    # the domain. The Let's Encrypt cert is issued for the domain only, so a wss:// connection to
    # the bare IP fails the TLS handshake (browser reports WebSocket close code 1015). Applying this
    # to the final URL fixes both auto-detected hosts and stale IP-based values saved in settings.
    domain = os.getenv("OPDESK_DOMAIN", "").strip()
    if domain and server:
        m = re.match(r'^(wss?://)\d{1,3}(?:\.\d{1,3}){3}(:\d+)?(/.*)?$', server)
        if m:
            scheme, port, path = m.group(1), m.group(2) or "", m.group(3) or "/sip-ws"
            server = f"{scheme}{domain}{port}{path}"
    creds = get_user_webrtc_credentials(current_user["id"])
    if not creds:
        return {"server": server, "extension": None, "extension_secret": None}
    ext = creds.get("extension")
    secret = get_extension_secret_from_db(ext) if ext else None
    return {"server": server, "extension": ext, "extension_secret": secret}


class DeviceTokenBody(BaseModel):
    token: str
    platform: str            # "ios" | "android"
    token_type: str = "alert"  # "voip" (iOS PushKit) | "alert" (regular APNs/FCM)
    app_version: Optional[str] = None


class DeleteDeviceTokenBody(BaseModel):
    token: str


@app.post("/api/device-tokens")
async def register_device_token_endpoint(body: DeviceTokenBody, current_user: dict = Depends(get_current_user)):
    """
    Register (or refresh) a mobile push token for the current user so the backend can wake the device
    for incoming calls and send missed-call alerts. iOS registers twice: its APNs alert token
    (token_type=alert) and its PushKit VoIP token (token_type=voip).
    Body: { token, platform: "ios"|"android", token_type: "voip"|"alert", app_version? }
    """
    token = (body.token or "").strip()
    platform = (body.platform or "").strip().lower()
    token_type = (body.token_type or "alert").strip().lower()
    # platform='web' carries a JSON Web Push subscription in `token`.
    if not token or platform not in ("ios", "android", "web") or token_type not in ("voip", "alert"):
        raise HTTPException(status_code=400, detail="Invalid token, platform, or token_type")
    ok = register_device_token(
        current_user["id"], current_user.get("extension"), platform, token_type, token, body.app_version
    )
    if not ok:
        raise HTTPException(status_code=500, detail="Failed to register device token")
    return {"status": "ok"}


@app.delete("/api/device-tokens")
async def delete_device_token_endpoint(body: DeleteDeviceTokenBody, current_user: dict = Depends(get_current_user)):
    """Unregister a mobile push token (call on logout). Body: { token }"""
    token = (body.token or "").strip()
    if not token:
        raise HTTPException(status_code=400, detail="token required")
    delete_device_token(token)
    return {"status": "ok"}


@app.get("/api/push/vapid-public-key")
async def get_vapid_public_key():
    """Public VAPID key for the browser to subscribe to Web Push. Unauthenticated so the
    service worker / PWA can fetch it early. Returns enabled=false when Web Push is off."""
    return {"enabled": push_service.web_push_enabled(), "public_key": push_service._vapid_public_key() or None}


@app.post("/api/push/web-resubscribe")
async def web_resubscribe(body: dict, current_user: dict = Depends(get_current_user)):
    """Re-register a rotated browser subscription. Body: { subscription: {...} }.
    Stored as a platform='web' device token whose `token` is the JSON subscription."""
    sub = body.get("subscription")
    if not sub:
        raise HTTPException(status_code=400, detail="subscription required")
    token = json.dumps(sub) if not isinstance(sub, str) else sub
    ok = register_device_token(current_user["id"], current_user.get("extension"), "web", "alert", token, None)
    if not ok:
        raise HTTPException(status_code=500, detail="Failed to store web push subscription")
    return {"status": "ok"}


client_log = logging.getLogger("opdesk.client")


@app.post("/api/client-log")
async def client_log_endpoint(request: Request):
    """
    Diagnostic sink for browser-side logs (esp. mobile, where devtools are not reachable).
    Intentionally UNAUTHENTICATED: the frontend ships logs via navigator.sendBeacon(), which
    cannot set an Authorization header and must work during pagehide/freeze — exactly the
    moment we need to capture. Entries are size-capped and only logged, never persisted to DB.
    Body: { session: str, entries: [{ t: <ms>, tag: str, msg: str, data?: any }, ...] }
    """
    try:
        raw = await request.body()
        if len(raw) > 64 * 1024:  # cap payload; drop anything abusive
            raw = raw[: 64 * 1024]
        payload = json.loads(raw or b"{}")
    except Exception:
        return PlainTextResponse("", status_code=204)
    session = str(payload.get("session", "?"))[:64]
    entries = payload.get("entries")
    if not isinstance(entries, list):
        entries = []
    for e in entries[:200]:
        tag = str(e.get("tag", ""))[:40]
        msg = str(e.get("msg", ""))[:1000]
        data = e.get("data")
        suffix = f" | {json.dumps(data)[:1000]}" if data not in (None, "", {}) else ""
        client_log.info(f"CLIENT[{session}] {tag}: {msg}{suffix}")
    return PlainTextResponse("", status_code=204)


@app.api_route("/api/internal/mobile-wake/{extension}", methods=["GET", "POST"])
async def internal_mobile_wake(extension: str, request: Request, caller: str = ""):
    """Called by the dialplan (CURL) BEFORE the extension is dialed, so the wake push is
    sent while the dialplan Wait() gives a killed/backgrounded app time to re-register
    with Asterisk and become dialable.

    Asterisk's CURL() dialplan function issues a GET, so this must accept GET (a POST-only
    route would fall through to the SPA catch-all and return index.html instead of "1").

    Restricted to loopback — no JWT required. Returns the plain body "1" when the
    extension has at least one registered mobile token (so the dialplan should Wait for
    it) or an empty body otherwise — letting non-mobile extensions ring with no added
    latency."""
    client_host = getattr(request.client, "host", "")
    if client_host not in ("127.0.0.1", "::1"):
        raise HTTPException(status_code=403, detail="Loopback only")
    tokens = await asyncio.to_thread(get_device_tokens_for_extension, extension)
    if not tokens:
        # No mobile device for this extension — tell the dialplan not to wait.
        return PlainTextResponse("")
    try:
        _pre_woken[extension] = asyncio.get_event_loop().time()
    except RuntimeError:
        pass
    # Enrich the wake with the caller's display name for internal callers, so the ring
    # card shows "Alice (101)" instead of a bare number.
    caller_num = caller.strip()
    display_name = None
    if caller_num and bridge is not None:
        display_name = getattr(bridge, "_extension_names", {}).get(caller_num) or None
    asyncio.create_task(push_service.send_call_wake(extension, caller_num, f"predial-{extension}", display_name))
    return PlainTextResponse("1")


def require_admin(current_user: dict = Depends(get_current_user)) -> dict:
    """Dependency: require admin role."""
    if current_user.get("role") != "admin":
        raise HTTPException(status_code=403, detail="Admin only")
    return current_user


# ---------------------------------------------------------------------------
# API key management (admin only)
# ---------------------------------------------------------------------------
# These routes are require_admin, i.e. JWT-only, so a key can never mint, inspect or
# escalate another key.
class ApiKeyCreateBody(BaseModel):
    name: str
    scopes: list
    expires_at: Optional[str] = None  # 'YYYY-MM-DD' or ISO; omit/empty => never expires


class ApiKeyUpdateBody(BaseModel):
    name: Optional[str] = None
    scopes: Optional[list] = None
    enabled: Optional[bool] = None
    expires_at: Optional[str] = None  # "" clears the expiry


def _validate_scopes(scopes: list) -> list:
    unknown = [s for s in scopes if s not in ALL_PERMISSIONS]
    if unknown:
        raise HTTPException(status_code=400, detail=f"Unknown scope(s): {', '.join(unknown)}")
    return list(scopes)


# Declared BEFORE /api/api-keys/{key_id} — otherwise "permissions" is parsed as the
# int path param and the route 422s.
@app.get("/api/api-keys/permissions")
async def api_list_permissions(current_user: dict = Depends(require_admin)):
    """The permission tokens a key can be granted (drives the Settings scope picker)."""
    return {"permissions": ALL_PERMISSIONS}


@app.get("/api/api-keys")
async def api_list_api_keys(current_user: dict = Depends(require_admin)):
    """List API keys. Metadata only — the plaintext is unrecoverable after creation."""
    keys = await asyncio.to_thread(list_api_keys)
    return {"api_keys": keys}


@app.post("/api/api-keys", status_code=201)
async def api_create_api_key(body: ApiKeyCreateBody, current_user: dict = Depends(require_admin)):
    """Create an API key. The response carries the plaintext `key` — shown exactly once."""
    name = (body.name or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="Name required")
    scopes = _validate_scopes(body.scopes or [])
    if not scopes:
        raise HTTPException(status_code=400, detail="At least one scope is required")
    result = await asyncio.to_thread(
        create_api_key, name, scopes, current_user.get("id"), body.expires_at)
    if not result:
        raise HTTPException(status_code=500, detail="Failed to create API key")
    log.info("API key created: %s (scopes=%s) by %s",
             name, ",".join(scopes), current_user.get("username"))
    return result


@app.patch("/api/api-keys/{key_id}")
async def api_update_api_key(key_id: int, body: ApiKeyUpdateBody,
                             current_user: dict = Depends(require_admin)):
    """Update an API key's name, scopes, enabled flag or expiry. Partial update."""
    existing = await asyncio.to_thread(get_api_key, key_id)
    if not existing:
        raise HTTPException(status_code=404, detail="API key not found")
    scopes = _validate_scopes(body.scopes) if body.scopes is not None else None
    result = await asyncio.to_thread(
        update_api_key, key_id, body.name, scopes, body.enabled, body.expires_at)
    if not result:
        raise HTTPException(status_code=500, detail="Failed to update API key")
    return result


@app.delete("/api/api-keys/{key_id}", status_code=204)
async def api_delete_api_key(key_id: int, current_user: dict = Depends(require_admin)):
    """Revoke (hard-delete) an API key. It stops authenticating immediately."""
    ok = await asyncio.to_thread(delete_api_key, key_id)
    if not ok:
        raise HTTPException(status_code=404, detail="API key not found")
    log.info("API key #%s revoked by %s", key_id, current_user.get("username"))
    return Response(status_code=204)


# ---------------------------------------------------------------------------
# Integration API (machine-to-machine)
# ---------------------------------------------------------------------------
class ClickToCallBody(BaseModel):
    """Ring `extension` first; when it answers, dial `number`."""
    extension: str
    number: str
    caller_id: Optional[str] = None
    timeout: Optional[int] = 30  # seconds, 5..120


@app.post("/api/integration/click-to-call", status_code=202)
async def api_click_to_call(body: ClickToCallBody,
                            current_user: dict = Depends(require_scope("calls:write"))):
    """Originate a call from an extension to a number.

    202, not 200: Asterisk acknowledges the Originate long before the call connects.
    Correlate the outcome via the returned action_id, the WebSocket feed, or the CDR.
    """
    if monitor is None or not getattr(monitor, 'connected', False):
        raise HTTPException(status_code=503, detail="AMI not connected")

    ext = str(body.extension or '').strip()
    if not ext:
        raise HTTPException(status_code=400, detail="extension is required")
    if ext not in monitor.monitored:
        # Checked before anything is passed to AMI — never let an unvalidated string
        # reach the Channel field.
        raise HTTPException(status_code=404, detail=f"Unknown extension: {ext}")

    # Authorisation. require_scope falls back to a JWT with NO role check, so without
    # this any logged-in agent could dial from a colleague's phone.
    if not current_user.get("api_key"):
        if current_user.get("role") != "admin":
            allowed = current_user.get("allowed_agent_extensions")
            own = str(current_user.get("extension") or '')
            if ext != own and not (allowed and ext in allowed):
                raise HTTPException(
                    status_code=403,
                    detail="Not permitted to originate calls from this extension")

    num = monitor.normalize_dial_number(body.number)
    if not num:
        raise HTTPException(
            status_code=400,
            detail="number must be 2-20 digits, optionally starting with '+' "
                   "(spaces, dashes, dots and brackets are stripped)")

    try:
        timeout_s = int(body.timeout or 30)
    except (TypeError, ValueError):
        timeout_s = 30
    if not 5 <= timeout_s <= 120:
        raise HTTPException(status_code=400, detail="timeout must be between 5 and 120 seconds")

    ctx = get_setting('CLICK_TO_CALL_CONTEXT', os.getenv('CLICK_TO_CALL_CONTEXT', 'from-internal'))
    ok, msg = await monitor.originate_call(
        ext, num, context=ctx, timeout_ms=timeout_s * 1000, caller_id=body.caller_id)
    if not ok:
        raise HTTPException(status_code=502, detail=f"Asterisk rejected the call: {msg}")

    log.info("Click-to-call accepted: %s -> %s (by %s)", ext, num, current_user.get("username"))
    return {"accepted": True, "action_id": msg, "extension": ext, "number": num}


# ---------------------------------------------------------------------------
# Logs (admin only): live AMI event stream + CRM webhook delivery log
# ---------------------------------------------------------------------------
# Admin-only and deliberately NOT require_scope: the delivery log holds raw CRM
# request bodies, so a cdr:read integration key must not be able to read them.
#
# Literal sub-paths are declared before any /api/logs/{param} route so they are not
# swallowed by a path parameter.
class AmiLogToggleBody(BaseModel):
    enabled: bool


@app.get("/api/logs")
async def api_get_logs(since: int = 0, event: str = "", q: str = "",
                       current_user: dict = Depends(require_admin)):
    """Live AMI events newer than `since`. The panel polls this with a seq cursor."""
    return {"lines": ami_event_buffer.snapshot(since=since, event=event, q=q)}


@app.get("/api/logs/events")
async def api_get_log_event_names(current_user: dict = Depends(require_admin)):
    """Distinct AMI event names currently buffered (drives the filter dropdown)."""
    return {"events": ami_event_buffer.event_names()}


@app.get("/api/logs/ami")
async def api_get_ami_logging(current_user: dict = Depends(require_admin)):
    """Whether AMI event buffering is currently on."""
    return {"enabled": ami_event_buffer.enabled}


@app.post("/api/logs/ami")
async def api_set_ami_logging(body: AmiLogToggleBody, current_user: dict = Depends(require_admin)):
    """Turn AMI event buffering on/off. Off by default — this is a debugging tool."""
    ami_event_buffer.enabled = bool(body.enabled)
    log.info("AMI event buffering %s by %s",
             "enabled" if body.enabled else "disabled", current_user.get("username"))
    return {"enabled": ami_event_buffer.enabled}


@app.get("/api/logs/siptrace")
async def api_get_sip_trace(current_user: dict = Depends(require_admin)):
    """Whether the raw SIP message trace is running, plus the last start failure."""
    return {"enabled": sip_tracer.enabled, "error": sip_tracer.last_error}


@app.post("/api/logs/siptrace")
async def api_set_sip_trace(body: AmiLogToggleBody, current_user: dict = Depends(require_admin)):
    """Turn the SIP message trace on/off.

    Two moving parts: Asterisk's PJSIP logger (so it writes SIP messages at all) and
    our log tailer (so they reach the panel). The tailer starts first — if it cannot
    read the log file there is no point enabling the logger.
    """
    if body.enabled:
        if not sip_tracer.start():
            raise HTTPException(status_code=500,
                                detail=sip_tracer.last_error or "Could not start SIP trace")
        await asyncio.to_thread(set_pjsip_logger, True)
    else:
        await asyncio.to_thread(set_pjsip_logger, False)
        sip_tracer.stop()
    log.info("SIP trace %s by %s",
             "enabled" if body.enabled else "disabled", current_user.get("username"))
    return {"enabled": sip_tracer.enabled, "error": sip_tracer.last_error}


@app.get("/api/logs/deliveries")
async def api_list_deliveries(
    success: Optional[bool] = None,
    call_id: Optional[str] = None,
    call_type: Optional[str] = None,
    search: Optional[str] = None,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    limit: int = 50,
    offset: int = 0,
    current_user: dict = Depends(require_admin),
):
    """Page through CRM webhook delivery attempts. Bodies omitted — see the detail route."""
    rows, total = await asyncio.to_thread(
        list_webhook_deliveries, success, call_id, call_type, search,
        date_from, date_to, limit, offset)
    return {"deliveries": rows, "total": total,
            "limit": max(1, min(int(limit or 50), 200)), "offset": max(0, int(offset or 0))}


@app.get("/api/logs/deliveries/{delivery_id}")
async def api_get_delivery(delivery_id: int, current_user: dict = Depends(require_admin)):
    """One delivery attempt in full, including the request and response bodies."""
    row = await asyncio.to_thread(get_webhook_delivery, delivery_id)
    if not row:
        raise HTTPException(status_code=404, detail="Delivery not found")
    return row


@app.post("/api/logs/deliveries/{delivery_id}/resend", status_code=202)
async def api_resend_delivery(delivery_id: int, current_user: dict = Depends(require_admin)):
    """Replay a delivery through the CURRENT connector configuration.

    The stored request body is replayed verbatim — build_crm_payload is deliberately
    NOT re-run. The body is the historical fact worth replaying, and a resend that
    sends different data than the UI is displaying is a debugging trap. The
    credentials and URL, by contrast, are re-read from current config: a wrong
    endpoint is usually why the original failed.
    """
    row = await asyncio.to_thread(get_webhook_delivery, delivery_id)
    if not row:
        raise HTTPException(status_code=404, detail="Delivery not found")
    if row.get('truncated'):
        raise HTTPException(
            status_code=400,
            detail="Request body was truncated when logged and cannot be replayed safely.")
    try:
        body = json.loads(row.get('request_body') or '')
    except (ValueError, TypeError):
        raise HTTPException(status_code=400, detail="Stored request body is not valid JSON")
    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail="Stored request body is not a JSON object")
    if crm_connector is None:
        raise HTTPException(status_code=503, detail="CRM connector is not configured")
    if monitor is None:
        raise HTTPException(status_code=503, detail="AMI monitor unavailable")

    cfg = load_crm_sync_config()
    meta = {
        'call_id': row.get('call_id'), 'uniqueid': row.get('uniqueid'),
        'caller': row.get('caller'), 'destination': row.get('destination'),
        'call_type': row.get('call_type'), 'call_status': row.get('call_status'),
        'attempt': int(row.get('attempt') or 1) + 1,
        'parent_id': delivery_id,
        'resent_by': current_user.get('id'),
    }
    asyncio.create_task(monitor._send_crm_data_async(
        body,
        method=(cfg.method if cfg else 'POST'),
        endpoint_path=(cfg.endpoint if cfg else None),
        meta=meta,
    ))
    log.info("Delivery #%s resent by %s", delivery_id, current_user.get("username"))
    return {"accepted": True, "delivery_id": delivery_id,
            "original_created_at": row.get('created_at')}


# ---------------------------------------------------------------------------
# Settings: User management (admin only), agents & queues for selection
# ---------------------------------------------------------------------------
class CreateUserBody(BaseModel):
    username: str
    password: str
    name: Optional[str] = None
    extension: Optional[str] = None
    role: str = "supervisor"
    monitor_mode: Optional[str] = None  # legacy single; use monitor_modes
    monitor_modes: Optional[list] = None  # list of 'listen','whisper','barge'
    group_ids: Optional[list] = None  # access via groups (replaces per-user agents/queues)


class UpdateUserBody(BaseModel):
    username: Optional[str] = None
    name: Optional[str] = None
    extension: Optional[str] = None
    role: Optional[str] = None
    is_active: Optional[bool] = None
    monitor_mode: Optional[str] = None
    monitor_modes: Optional[list] = None  # list of 'listen','whisper','barge'
    password: Optional[str] = None
    group_ids: Optional[list] = None  # access via groups


class TransferCallBody(BaseModel):
    """Body for agent softphone call transfer."""
    destination: str


@app.get("/api/settings/users")
async def api_list_users(
    current_user: dict = Depends(require_admin),
):
    """List all users (admin only)."""
    users = get_all_users()
    out = []
    for u in users:
        agents, queues = get_user_agents_and_queues(u["id"])
        group_ids = get_user_group_ids(u["id"])
        out.append({**u, "agent_extensions": agents, "queue_names": queues, "group_ids": group_ids})
    return {"users": out}


@app.get("/api/settings/users/{user_id}")
async def api_get_user(
    user_id: int,
    current_user: dict = Depends(require_admin),
):
    """Get one user with agents, queues, and group_ids (admin only)."""
    user = get_user_by_id(user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    agents, queues = get_user_agents_and_queues(user_id)
    group_ids = get_user_group_ids(user_id)
    return {**user, "agent_extensions": agents, "queue_names": queues, "group_ids": group_ids}


@app.post("/api/settings/users")
async def api_create_user(
    body: CreateUserBody,
    current_user: dict = Depends(require_admin),
):
    """Create user and optionally assign agents/queues (admin only)."""
    username = (body.username or "").strip()
    if not username:
        raise HTTPException(status_code=400, detail="Username required")
    if not (body.password or "").strip():
        raise HTTPException(status_code=400, detail="Password required")
    role = body.role or "supervisor"
    monitor_modes = body.monitor_modes if body.monitor_modes is not None else None
    if monitor_modes is None and body.monitor_mode:
        monitor_modes = [body.monitor_mode]
    if role == "admin":
        monitor_modes = ["listen", "whisper", "barge"]  # Admin: auto-fill full modes in DB
    user_id = db_create_user(
        username=username,
        password=body.password,
        name=body.name,
        extension=body.extension,
        role=role,
        monitor_mode=body.monitor_mode or "listen",
        monitor_modes=monitor_modes,
    )
    if not user_id:
        raise HTTPException(status_code=400, detail="Username or extension already in use")
    set_user_groups(user_id, group_ids=body.group_ids or [])
    if body.extension:
        pbx_changed = False
        if body.password:
            set_extension_secret_in_pbx(body.extension, body.password)
            pbx_changed = True
        if body.name:
            set_extension_name_in_pbx(body.extension, body.name)
            pbx_changed = True
        if pbx_changed:
            reload_asterisk_sip()
    user = get_user_by_id(user_id)
    agents, queues = get_user_agents_and_queues(user_id)
    group_ids = get_user_group_ids(user_id)
    return {**user, "agent_extensions": agents, "queue_names": queues, "group_ids": group_ids}


@app.put("/api/settings/users/{user_id}")
async def api_update_user(
    user_id: int,
    body: UpdateUserBody,
    current_user: dict = Depends(require_admin),
):
    """Update user and/or agents/queues (admin only)."""
    user = get_user_by_id(user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    effective_role = body.role if body.role is not None else user.get("role")
    monitor_modes = body.monitor_modes
    if effective_role == "admin":
        monitor_modes = ["listen", "whisper", "barge"]  # Admin: auto-fill full modes in DB
    db_update_user(
        user_id,
        username=body.username,
        name=body.name,
        extension=body.extension,
        role=body.role,
        is_active=body.is_active,
        monitor_mode=body.monitor_mode,
        monitor_modes=monitor_modes,
        password=body.password,
    )
    if body.group_ids is not None:
        set_user_groups(user_id, body.group_ids)
    ext = body.extension or user.get("extension")
    pbx_changed = False
    if ext:
        if body.password:
            set_extension_secret_in_pbx(ext, body.password)
            pbx_changed = True
        if body.name:
            set_extension_name_in_pbx(ext, body.name)
            pbx_changed = True
    if pbx_changed:
        reload_asterisk_sip()
    user = get_user_by_id(user_id)
    agents, queues = get_user_agents_and_queues(user_id)
    group_ids = get_user_group_ids(user_id)
    return {**user, "agent_extensions": agents, "queue_names": queues, "group_ids": group_ids}


@app.delete("/api/settings/users/{user_id}")
async def api_delete_user(
    user_id: int,
    current_user: dict = Depends(require_admin),
):
    """Delete user (admin only)."""
    if current_user.get("id") == user_id:
        raise HTTPException(status_code=400, detail="Cannot delete yourself")
    user = get_user_by_id(user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    if not db_delete_user(user_id):
        raise HTTPException(status_code=500, detail="Failed to delete user")
    return {"ok": True}


@app.get("/api/settings/agents")
async def api_list_agents(
    current_user: dict = Depends(get_current_user),
):
    """List extensions/agents for selection. Syncs from Asterisk if monitor available.

    Scoped by role like /api/settings/extensions/webrtc: admin sees all; agent sees only
    their own extension; supervisor sees their own + allowed_agent_extensions.
    """
    if monitor and getattr(monitor, "monitored", None):
        exts = list(monitor.monitored)
        names = get_extension_names_from_db()
        # prune against the live PBX set so agents deleted in FreePBX/Issabel drop
        # out of the selection lists (empty-list guard keeps a failed read safe).
        sync_agents_from_extensions(exts, names, prune=True)
    agents = get_agents_list()
    if not agents and monitor and getattr(monitor, "monitored", None):
        exts = list(monitor.monitored)
        names = get_extension_names_from_db()
        sync_agents_from_extensions(exts, names)
        agents = get_agents_list()

    role = current_user.get("role")
    if role == "admin":
        return {"agents": agents}

    # Non-admins are scoped to their own extension + any explicitly allowed extensions.
    allow_set = set()
    user_ext = current_user.get("extension")
    if user_ext:
        allow_set.add(str(user_ext))
    for e in (current_user.get("allowed_agent_extensions") or []):
        allow_set.add(str(e))
    return {"agents": [a for a in agents if str(a.get("extension")) in allow_set]}


@app.get("/api/settings/extensions/webrtc")
async def api_list_extensions_webrtc(
    current_user: dict = Depends(get_current_user),
):
    """List extensions with webrtc flag. Admin: all; agent: own extension; supervisor: own + allowed_agent_extensions."""
    all_exts = get_extensions_with_webrtc_from_users()
    role = current_user.get("role")
    user_ext = current_user.get("extension")
    allowed = current_user.get("allowed_agent_extensions") or []

    if role == "admin":
        return {"extensions": all_exts}
    allow_set = set()
    if user_ext:
        allow_set.add(str(user_ext))
    for e in allowed:
        allow_set.add(str(e))
    return {"extensions": [e for e in all_exts if e.get("extension") in allow_set]}


@app.get("/api/settings/extensions/{extension}/credentials")
async def api_get_extension_credentials(
    extension: str,
    current_user: dict = Depends(require_admin),
):
    """Return PBX SIP username, secret, display name, and WebRTC flag for an extension (admin only)."""
    secret = get_extension_secret_from_db(extension)
    names = get_extension_names_from_db()
    webrtc_list = get_extensions_with_webrtc_from_users()
    webrtc = next((e.get("webrtc", "no") for e in webrtc_list if str(e.get("extension")) == str(extension)), "no")
    return {"username": extension, "password": secret or "", "name": names.get(extension, ""), "webrtc": webrtc}


@app.put("/api/settings/extensions/{extension}/webrtc")
async def api_set_extension_webrtc(
    extension: str,
    enabled: bool = Body(..., embed=True),
    current_user: dict = Depends(get_current_user),
):
    """
    Enable/disable WebRTC (enable = all yes + dtls, disable = all no).
    Permissions:
      - admin: any extension
      - agent: only their own extension
      - supervisor: their own extension or extensions in allowed_agent_extensions
    """
    role = current_user.get("role")
    user_ext = current_user.get("extension")
    allowed_exts = current_user.get("allowed_agent_extensions") or []
    ext = str(extension)

    allowed = False
    if role == "admin":
        allowed = True
    elif role == "agent":
        allowed = bool(user_ext and str(user_ext) == ext)
    elif role == "supervisor":
        allowed = (user_ext and str(user_ext) == ext) or ext in [str(e) for e in allowed_exts]

    if not allowed:
        raise HTTPException(status_code=403, detail="Not allowed to change WebRTC for this extension")

    if not set_extension_webrtc(extension=ext, enabled=enabled,PBX=os.getenv('PBX')):
        raise HTTPException(status_code=404, detail="Extension not found in users")

    log.info(f"WebRTC enabled/disabled for extension: {ext} - {enabled}")
    return {"ok": True, "extension": ext}


@app.post("/api/extensions/{extension}/dnd")
async def api_set_extension_dnd(
    extension: str,
    enabled: bool = Body(..., embed=True),
    current_user: dict = Depends(get_current_user),
):
    """
    Enable/disable Do Not Disturb for an extension (AstDB DND flag).
    Permissions mirror the WebRTC toggle:
      - admin: any extension
      - agent: only their own extension
      - supervisor: their own extension or extensions in allowed_agent_extensions
    """
    role = current_user.get("role")
    user_ext = current_user.get("extension")
    allowed_exts = current_user.get("allowed_agent_extensions") or []
    ext = str(extension)

    allowed = False
    if role == "admin":
        allowed = True
    elif role == "agent":
        allowed = bool(user_ext and str(user_ext) == ext)
    elif role == "supervisor":
        allowed = (user_ext and str(user_ext) == ext) or ext in [str(e) for e in allowed_exts]

    if not allowed:
        raise HTTPException(status_code=403, detail="Not allowed to change DND for this extension")

    if monitor is None:
        raise HTTPException(status_code=503, detail="AMI monitor not available")

    ok = await monitor.set_dnd(ext, bool(enabled))
    if not ok:
        raise HTTPException(status_code=502, detail="Failed to set DND via AMI")

    # Push the new DND state to all connected clients immediately.
    if bridge is not None:
        await bridge.broadcast_state_now()

    log.info(f"DND {'enabled' if enabled else 'disabled'} for extension: {ext}")
    return {"ok": True, "extension": ext, "dnd": bool(enabled)}


# ── Not-Ready Codes (pause reasons) ──────────────────────────────────────────
@app.get("/api/pause-reasons")
async def api_list_pause_reasons(current_user: dict = Depends(get_current_user)):
    """List pause reasons. Admins see all; everyone else sees active codes only."""
    is_admin = current_user.get("role") == "admin"
    reasons = pause_reason_list(active_only=not is_admin, include_system=True)
    return {"reasons": reasons}


@app.post("/api/pause-reasons")
async def api_create_pause_reason(body: dict, current_user: dict = Depends(require_admin)):
    rid = pause_reason_create(
        code=body.get("code", ""),
        label=body.get("label", ""),
        productive=bool(body.get("productive", False)),
        color=body.get("color"),
        sort_order=body.get("sort_order", 100),
        is_active=bool(body.get("is_active", True)),
    )
    if not rid:
        raise HTTPException(status_code=400, detail="Invalid or duplicate pause reason (code + label required)")
    return {"ok": True, "id": rid}


@app.patch("/api/pause-reasons/{reason_id}")
async def api_update_pause_reason(reason_id: int, body: dict, current_user: dict = Depends(require_admin)):
    if not pause_reason_update(reason_id, body or {}):
        raise HTTPException(status_code=400, detail="Nothing to update or update failed")
    return {"ok": True}


@app.delete("/api/pause-reasons/{reason_id}")
async def api_delete_pause_reason(reason_id: int, current_user: dict = Depends(require_admin)):
    if not pause_reason_delete(reason_id):
        raise HTTPException(status_code=400, detail="Cannot delete (not found or system reason)")
    return {"ok": True}


# ── Agent queue Login / Logout / Ready-Not-Ready (softphone) ─────────────────
def _agent_login_queues(current_user: dict) -> list:
    """Queues the current user logs into. Resolved from the agent's *extension* group
    membership (group_agents → group_queues), like echo: drop a queue and an agent in
    the same group and that agent can log in/out of it. Falls back to the user account's
    own groups (user_groups) if the extension isn't a group member — covers supervisors
    whose access is granted via their account rather than their extension."""
    ext = current_user.get("extension")
    queues = get_agent_login_queues(str(ext)) if ext else []
    if not queues:
        _agents, queues = get_user_agents_and_queues(current_user.get("id"))
    return [str(q) for q in (queues or []) if q]


def _agent_live_queues(interface: str) -> list:
    """Queues the interface is *actually* a member of right now, read from the AMI
    live membership cache. Used on logout so we remove exactly what login added,
    even if the user's group→queue assignment has drifted since (echo parity)."""
    if monitor is None or not interface:
        return []
    return sorted({
        info.get("queue")
        for info in getattr(monitor, "queue_members", {}).values()
        if info.get("interface") == interface and info.get("queue")
    })


@app.post("/api/agent/login")
async def api_agent_login(body: dict = Body(default={}), current_user: dict = Depends(get_current_user)):
    """Log the current user's own extension into their assigned queues (queue_add).
    Optional body {ready: bool} controls whether they start Ready (unpaused) or Not-Ready."""
    ext = current_user.get("extension")
    if not ext:
        raise HTTPException(status_code=400, detail="Your account has no extension")
    if monitor is None:
        raise HTTPException(status_code=503, detail="AMI monitor not available")
    queues = _agent_login_queues(current_user)
    if not queues:
        raise HTTPException(status_code=400, detail="No queues are assigned to your account")
    interface = normalize_interface(str(ext))
    paused = not bool((body or {}).get("ready", True))
    ok_any = False
    for q in queues:
        success, _msg = await monitor.queue_add(q, interface, 0, str(ext), paused)
        ok_any = ok_any or success
    if ok_any and presence is not None:
        await presence.record_login(str(ext), ready=not paused)
    if bridge is not None:
        await bridge.broadcast_state_now()
    return {"ok": ok_any, "extension": ext, "queues": queues, "ready": not paused}


@app.post("/api/agent/logout")
async def api_agent_logout(current_user: dict = Depends(get_current_user)):
    """Log the current user's own extension out of their assigned queues (queue_remove)."""
    ext = current_user.get("extension")
    if not ext:
        raise HTTPException(status_code=400, detail="Your account has no extension")
    if monitor is None:
        raise HTTPException(status_code=503, detail="AMI monitor not available")
    interface = normalize_interface(str(ext))
    # Remove from the queues the agent is *actually* in (live AMI membership), so
    # assignment drift since login can't strand them. Fall back to their group
    # queues if the live cache has nothing (echo parity).
    queues = _agent_live_queues(interface) or _agent_login_queues(current_user)
    ok_any = False
    for q in queues:
        success, _msg = await monitor.queue_remove(q, interface)
        ok_any = ok_any or success
    # Clear DND so direct calls ring again after going offline (echo parity).
    await monitor.set_dnd(str(ext), False)
    if presence is not None:
        await presence.record_logout(str(ext))
    if bridge is not None:
        await bridge.broadcast_state_now()
    return {"ok": ok_any, "extension": ext, "queues": queues}


@app.post("/api/agent/status")
async def api_agent_status(body: dict, current_user: dict = Depends(get_current_user)):
    """Set Ready/Not-Ready for the current user's own extension across their queues.
    Body: {ready: bool, reason_code?: str}. Not-Ready → queue_pause with reason."""
    ext = current_user.get("extension")
    if not ext:
        raise HTTPException(status_code=400, detail="Your account has no extension")
    if monitor is None:
        raise HTTPException(status_code=503, detail="AMI monitor not available")
    ready = bool((body or {}).get("ready", True))
    reason = (body or {}).get("reason_code", "") or ""
    interface = normalize_interface(str(ext))
    queues = _agent_login_queues(current_user)
    ok_any = False
    for q in queues:
        if ready:
            success, _msg = await monitor.queue_unpause(q, interface)
        else:
            success, _msg = await monitor.queue_pause(q, interface, True, reason)
        ok_any = ok_any or success
    if ok_any and presence is not None:
        if ready:
            await presence.record_ready(str(ext))
        else:
            await presence.record_not_ready(str(ext), reason or None)
    if bridge is not None:
        await bridge.broadcast_state_now()
    return {"ok": ok_any, "extension": ext, "ready": ready, "reason_code": reason}


@app.get("/api/settings/queues")
async def api_list_queues(
    current_user: dict = Depends(get_current_user),
):
    """List all queues for selection. Syncs from Asterisk if monitor available, else from DB (like agents). Uses name_map from DB for display names."""
    name_map = get_queue_names_from_db()
    if monitor and getattr(monitor, "queues", None):
        # monitor.queues is now pruned by sync_queue_status, so this is the live
        # PBX set — prune the DB queues table to match (drops deleted queues).
        sync_queues_from_list(list(monitor.queues.keys()), name_map, prune=True)
    else:
        if name_map:
            sync_queues_from_list(list(name_map.keys()), name_map)
    queues = get_queues_list()
    if not queues and monitor and getattr(monitor, "queues", None):
        sync_queues_from_list(list(monitor.queues.keys()), name_map)
        queues = get_queues_list()
    if not queues and name_map:
        sync_queues_from_list(list(name_map.keys()), name_map)
        queues = get_queues_list()
    return {"queues": queues}


# ---------------------------------------------------------------------------
# Settings: Groups (admin only) – group name, agents, queues, users
# ---------------------------------------------------------------------------
class CreateGroupBody(BaseModel):
    name: str
    agent_extensions: Optional[list] = None
    queue_extensions: Optional[list] = None
    user_ids: Optional[list] = None


class UpdateGroupBody(BaseModel):
    name: Optional[str] = None
    agent_extensions: Optional[list] = None
    queue_extensions: Optional[list] = None
    user_ids: Optional[list] = None


@app.get("/api/settings/groups")
async def api_list_groups(
    current_user: dict = Depends(require_admin),
):
    """List all groups with agents, queues, and user ids (admin only)."""
    return {"groups": get_groups_list()}


@app.get("/api/settings/groups/{group_id}")
async def api_get_group(
    group_id: int,
    current_user: dict = Depends(require_admin),
):
    """Get one group (admin only)."""
    g = get_group(group_id)
    if not g:
        raise HTTPException(status_code=404, detail="Group not found")
    return g


@app.post("/api/settings/groups")
async def api_create_group(
    body: CreateGroupBody,
    current_user: dict = Depends(require_admin),
):
    """Create group with name, agents, queues, users (admin only)."""
    name = (body.name or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="Group name required")
    gid = create_group(name)
    if not gid:
        raise HTTPException(status_code=400, detail="Group name may already exist")
    if body.agent_extensions:
        set_group_agents(gid, body.agent_extensions)
    if body.queue_extensions:
        set_group_queues(gid, body.queue_extensions)
    if body.user_ids is not None:
        set_group_users(gid, body.user_ids)
    return get_group(gid)


@app.put("/api/settings/groups/{group_id}")
async def api_update_group(
    group_id: int,
    body: UpdateGroupBody,
    current_user: dict = Depends(require_admin),
):
    """Update group name, agents, queues, users (admin only)."""
    g = get_group(group_id)
    if not g:
        raise HTTPException(status_code=404, detail="Group not found")
    if body.name is not None:
        name = (body.name or "").strip()
        if name:
            update_group(group_id, name)
    if body.agent_extensions is not None:
        set_group_agents(group_id, body.agent_extensions)
    if body.queue_extensions is not None:
        set_group_queues(group_id, body.queue_extensions)
    if body.user_ids is not None:
        set_group_users(group_id, body.user_ids)
    return get_group(group_id)


@app.delete("/api/settings/groups/{group_id}")
async def api_delete_group(
    group_id: int,
    current_user: dict = Depends(require_admin),
):
    """Delete group (admin only)."""
    if not delete_group(group_id):
        raise HTTPException(status_code=404, detail="Group not found or cannot delete")
    return {"ok": True}


# ---------------------------------------------------------------------------
# WebSocket Endpoint
# ---------------------------------------------------------------------------
@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    """WebSocket endpoint for real-time updates. Auth via ?token=<JWT> or first message { \"token\": \"<JWT>\" }."""
    await websocket.accept()
    query_string = (websocket.scope.get("query_string") or b"").decode()
    token = None
    for part in query_string.split("&"):
        if part.startswith("token="):
            token = unquote(part[6:].strip())
            break
    if token and not decode_token(token):
        await websocket.close(code=4001)
        return
    if not token:
        try:
            data = await asyncio.wait_for(websocket.receive_text(), timeout=10.0)
            msg = json.loads(data)
            token = msg.get("token") or msg.get("auth_token")
            if not token or not decode_token(token):
                await websocket.close(code=4001)
                return
        except (asyncio.TimeoutError, json.JSONDecodeError, KeyError):
            await websocket.close(code=4001)
            return
    payload = decode_token(token)
    user_id = int(payload["sub"])
    user_scope = _get_user_scope(user_id)
    await manager.connect(websocket, user_scope=user_scope)
    
    try:
        # Send initial state filtered by user role/ext/queue
        if bridge:
            allow_ext = None if user_scope.get("role") == "admin" else (user_scope.get("allowed_agent_extensions") or [])
            allow_queues = None if user_scope.get("role") == "admin" else (user_scope.get("allowed_queue_names") or [])
            state = bridge.get_current_state(allow_extensions=allow_ext, allow_queues=allow_queues)
            await manager.send_personal(websocket, {
                "type": "initial_state",
                "data": state,
                "timestamp": datetime.now().isoformat()
            })
        
        # Listen for client messages
        while True:
            data = await websocket.receive_text()
            try:
                message = json.loads(data)
                # Ignore auth message if already authenticated
                if message.get("token") or message.get("action") == "auth":
                    continue
                await handle_client_message(websocket, message)
            except json.JSONDecodeError:
                await manager.send_personal(websocket, {
                    "type": "error",
                    "message": "Invalid JSON"
                })
    
    except WebSocketDisconnect:
        pass  # Normal disconnect
    except Exception as e:
        # Only log unexpected errors, not connection-related ones
        err_msg = str(e).lower()
        if 'close' not in err_msg and 'disconnect' not in err_msg and 'not connected' not in err_msg:
            log.error(f"WebSocket error: {e}")
    finally:
        await manager.disconnect(websocket)


def _scope_can_access_extension(scope: dict, ext: str) -> bool:
    """True if scope allows access to this extension (admin or ext in allowed list)."""
    if not scope or scope.get("role") == "admin":
        return True
    allowed = scope.get("allowed_agent_extensions") or []
    return str(ext).strip() in [str(e) for e in allowed]


def _scope_can_access_queue(scope: dict, queue: str) -> bool:
    """True if scope allows access to this queue (admin or queue in allowed list)."""
    if not scope or scope.get("role") == "admin":
        return True
    allowed = scope.get("allowed_queue_names") or []
    return str(queue).strip() in [str(q) for q in allowed]


async def handle_client_message(websocket: WebSocket, message: dict):
    """Handle incoming client messages (commands). Enforces role/ext/queue filter for supervisors."""
    global monitor
    
    if not monitor or not monitor.connected:
        await manager.send_personal(websocket, {
            "type": "error",
            "message": "Not connected to AMI"
        })
        return
    
    scope = manager.get_scope(websocket)
    action = message.get("action", "")
    
    try:
        if action == "get_state":
            if bridge:
                allow_ext = None if scope.get("role") == "admin" else (scope.get("allowed_agent_extensions") or [])
                allow_queues = None if scope.get("role") == "admin" else (scope.get("allowed_queue_names") or [])
                state = bridge.get_current_state(allow_extensions=allow_ext, allow_queues=allow_queues)
                await manager.send_personal(websocket, {
                    "type": "state_update",
                    "data": state,
                    "timestamp": datetime.now().isoformat()
                })
        
        elif action == "sync":
            # Full sync: reconcile extensions/queues with the PBX (prune removed ones,
            # refresh names every time), then resync live status/calls/queues.
            if monitor:
                extensions = get_extensions_from_db()
                # None == PBX read failed → keep current state, never prune. A real
                # (possibly empty) list is authoritative and safe to prune against.
                if extensions is not None:
                    names = get_extension_names_from_db()
                    monitor.monitored = set(str(e) for e in extensions)
                    # Refresh the bridge's name cache so newly added/renamed
                    # extensions show their display name in the broadcast state
                    # (get_current_state reads self._extension_names).
                    if bridge:
                        bridge._extension_names = names
                    # Refresh names on every sync (not only when the set changed) and
                    # prune agents that no longer exist in the PBX.
                    sync_agents_from_extensions(list(monitor.monitored), names, prune=True)
                await monitor.sync_extension_statuses()
                await monitor.sync_active_calls()
                await monitor.sync_queue_status()
                # Reconcile the queues table with the live queue set from the monitor.
                sync_queues_from_list(list(getattr(monitor, "queues", {}).keys()), get_queue_names_from_db(), prune=True)
            await manager.send_personal(websocket, {
                "type": "action_result",
                "action": "sync",
                "success": True,
                "message": "Full sync completed"
            })
        
        elif action == "sync_calls":
            await monitor.sync_active_calls()
            await manager.send_personal(websocket, {
                "type": "action_result",
                "action": "sync_calls",
                "success": True
            })
        
        elif action == "listen":
            supervisor = message.get("supervisor", "")
            target = message.get("target", "")
            if supervisor and target:
                if not _scope_can_access_extension(scope, target):
                    await manager.send_personal(websocket, {"type": "action_result", "action": "listen", "success": False, "message": "Not allowed to monitor this extension"})
                else:
                    result = await monitor.listen_to_call(supervisor, target)
                    await manager.send_personal(websocket, {
                        "type": "action_result",
                        "action": "listen",
                        "success": result,
                        "message": f"{'Started' if result else 'Failed to start'} listening to {target}"
                    })
        
        elif action == "whisper":
            supervisor = message.get("supervisor", "")
            target = message.get("target", "")
            if supervisor and target:
                if not _scope_can_access_extension(scope, target):
                    await manager.send_personal(websocket, {"type": "action_result", "action": "whisper", "success": False, "message": "Not allowed to monitor this extension"})
                else:
                    result = await monitor.whisper_to_call(supervisor, target)
                    await manager.send_personal(websocket, {
                        "type": "action_result",
                        "action": "whisper",
                        "success": result,
                        "message": f"{'Started' if result else 'Failed to start'} whispering to {target}"
                    })
        
        elif action == "barge":
            supervisor = message.get("supervisor", "")
            target = message.get("target", "")
            if supervisor and target:
                if not _scope_can_access_extension(scope, target):
                    await manager.send_personal(websocket, {"type": "action_result", "action": "barge", "success": False, "message": "Not allowed to monitor this extension"})
                else:
                    result = await monitor.barge_into_call(supervisor, target)
                    await manager.send_personal(websocket, {
                        "type": "action_result",
                        "action": "barge",
                        "success": result,
                        "message": f"{'Started' if result else 'Failed to start'} barging into {target}"
                    })

        elif action == "hangup":
            target = message.get("target", "")
            if target:
                if not _scope_can_access_extension(scope, target):
                    await manager.send_personal(websocket, {"type": "action_result", "action": "hangup", "success": False, "message": "Not allowed to control this extension"})
                else:
                    result = await monitor.hangup_call(target)
                    await manager.send_personal(websocket, {
                        "type": "action_result",
                        "action": "hangup",
                        "success": result,
                        "message": f"{'Hangup requested' if result else 'Failed to hang up'} for {target}"
                    })
                    if result and bridge:
                        await bridge.broadcast_state_now()

        elif action == "transfer":
            source = message.get("source", "")
            destination = message.get("destination", "")
            ctx = message.get("context")
            priority = str(message.get("priority", "1"))
            if source and destination:
                if not _scope_can_access_extension(scope, source):
                    await manager.send_personal(websocket, {"type": "action_result", "action": "transfer", "success": False, "message": "Not allowed to control this extension"})
                else:
                    result = await monitor.transfer_call(source, destination, ctx, priority)
                    await manager.send_personal(websocket, {
                        "type": "action_result",
                        "action": "transfer",
                        "success": result,
                        "message": f"{'Transfer requested' if result else 'Failed to transfer'} {source} to {destination}"
                    })
                    if result and bridge:
                        await bridge.broadcast_state_now()
            else:
                await manager.send_personal(websocket, {"type": "action_result", "action": "transfer", "success": False, "message": "Source and destination required"})

        elif action == "take_over":
            source = message.get("source", "")
            destination = (scope.get("extension") or "").strip()
            if not source:
                await manager.send_personal(websocket, {"type": "action_result", "action": "take_over", "success": False, "message": "Source required"})
            elif not destination:
                await manager.send_personal(websocket, {"type": "action_result", "action": "take_over", "success": False, "message": "No extension assigned to your user; cannot take over"})
            elif not _scope_can_access_extension(scope, source):
                await manager.send_personal(websocket, {"type": "action_result", "action": "take_over", "success": False, "message": "Not allowed to control this extension"})
            else:
                ctx = message.get("context")
                priority = str(message.get("priority", "1"))
                result = await monitor.transfer_call(source, destination, ctx, priority)
                await manager.send_personal(websocket, {
                    "type": "action_result",
                    "action": "take_over",
                    "success": result,
                    "message": f"{'Call transferred to you' if result else 'Failed to take over'} ({source} → {destination})"
                })
                if result and bridge:
                    await bridge.broadcast_state_now()

        elif action == "queue_add":
            queue = message.get("queue", "")
            interface = normalize_interface(message.get("interface", ""))
            penalty = message.get("penalty", 0)
            membername = message.get("membername", "")
            paused = message.get("paused", False)
            
            if queue and interface:
                if not _scope_can_access_queue(scope, queue):
                    await manager.send_personal(websocket, {"type": "action_result", "action": "queue_add", "success": False, "message": "Not allowed to manage this queue"})
                else:
                    success, msg = await monitor.queue_add(queue, interface, penalty, membername or None, paused)
                    await manager.send_personal(websocket, {
                        "type": "action_result",
                        "action": "queue_add",
                        "success": success,
                        "message": msg if success else f"Failed to add {interface} to {queue}: {msg}"
                    })
                    if success and bridge:
                        await bridge.broadcast_state_now()
        
        elif action == "queue_remove":
            queue = message.get("queue", "")
            interface = normalize_interface(message.get("interface", ""))
            
            if queue and interface:
                if not _scope_can_access_queue(scope, queue):
                    await manager.send_personal(websocket, {"type": "action_result", "action": "queue_remove", "success": False, "message": "Not allowed to manage this queue"})
                else:
                    success, msg = await monitor.queue_remove(queue, interface)
                    await manager.send_personal(websocket, {
                        "type": "action_result",
                        "action": "queue_remove",
                        "success": success,
                        "message": msg if success else f"Failed to remove {interface} from {queue}: {msg}"
                    })
                    if success and bridge:
                        await bridge.broadcast_state_now()
        
        elif action == "queue_pause":
            queue = message.get("queue", "")
            interface = normalize_interface(message.get("interface", ""))
            reason = message.get("reason", "")
            
            if queue and interface:
                if not _scope_can_access_queue(scope, queue):
                    await manager.send_personal(websocket, {"type": "action_result", "action": "queue_pause", "success": False, "message": "Not allowed to manage this queue"})
                else:
                    success, msg = await monitor.queue_pause(queue, interface, True, reason)
                    await manager.send_personal(websocket, {
                        "type": "action_result",
                        "action": "queue_pause",
                        "success": success,
                        "message": msg if success else f"Failed to pause {interface} in {queue}: {msg}"
                    })
                    if success and bridge:
                        await bridge.broadcast_state_now()
        
        elif action == "queue_unpause":
            queue = message.get("queue", "")
            interface = normalize_interface(message.get("interface", ""))
            
            if queue and interface:
                if not _scope_can_access_queue(scope, queue):
                    await manager.send_personal(websocket, {"type": "action_result", "action": "queue_unpause", "success": False, "message": "Not allowed to manage this queue"})
                else:
                    success, msg = await monitor.queue_unpause(queue, interface)
                    await manager.send_personal(websocket, {
                        "type": "action_result",
                        "action": "queue_unpause",
                        "success": success,
                        "message": msg if success else f"Failed to unpause {interface} in {queue}: {msg}"
                    })
                    if success and bridge:
                        await bridge.broadcast_state_now()
        
        elif action == "sync_queues":
            await monitor.sync_queue_status()
            await manager.send_personal(websocket, {
                "type": "action_result",
                "action": "sync_queues",
                "success": True
            })
        
        else:
            await manager.send_personal(websocket, {
                "type": "error",
                "message": f"Unknown action: {action}"
            })
    
    except Exception as e:
        log.error(f"Error handling action {action}: {e}")
        await manager.send_personal(websocket, {
            "type": "error",
            "message": str(e)
        })


# ---------------------------------------------------------------------------
# REST API Endpoints (protected)
# ---------------------------------------------------------------------------
@app.get("/api/extensions")
async def get_extensions(current_user: dict = Depends(require_scope("calls:read"))):
    """Get list of monitored extensions (filtered by user role/agents for supervisors)."""
    if not monitor:
        raise HTTPException(status_code=503, detail="AMI not connected")
    
    allowed = current_user.get("allowed_agent_extensions")
    monitored = monitor.monitored if allowed is None else (monitor.monitored & set(str(e) for e in (allowed or [])))
    
    extensions = []
    for ext in monitored:
        ext_data = monitor.extensions.get(ext, {})
        call_info = monitor.active_calls.get(ext, {})
        extensions.append({
            "extension": ext,
            "status": ext_data.get('Status', '-1'),
            "in_call": ext in monitor.active_calls,
            "call_info": call_info if call_info else None
        })
    
    return {"extensions": extensions}


@app.get("/api/calls")
async def get_active_calls(current_user: dict = Depends(require_scope("calls:read"))):
    """Get list of active calls (filtered by user allowed extensions for supervisors)."""
    if not monitor:
        raise HTTPException(status_code=503, detail="AMI not connected")
    
    await monitor.sync_active_calls()
    allowed = current_user.get("allowed_agent_extensions")
    if allowed is None:
        return {"calls": monitor.active_calls}
    ext_set = set(str(e) for e in (allowed or []))
    calls = {k: v for k, v in monitor.active_calls.items() if k in ext_set}
    return {"calls": calls}


@app.post("/api/calls/transfer")
async def api_transfer_call(
    body: TransferCallBody,
    current_user: dict = Depends(get_current_user),
):
    """
    Transfer the current call of the authenticated user's extension to another destination.

    Intended for use by the WebRTC softphone. Uses the user's own extension as the source.
    """
    if not monitor:
        raise HTTPException(status_code=503, detail="AMI not connected")

    # Prefer WebRTC extension mapping; fall back to user's primary extension
    creds = get_user_webrtc_credentials(current_user["id"])
    source_ext = (creds or {}).get("extension") or current_user.get("extension")
    if not source_ext:
        raise HTTPException(status_code=400, detail="No extension associated with current user")

    dest = (body.destination or "").strip()
    if not dest:
        raise HTTPException(status_code=400, detail="Destination is required")

    ok = await monitor.transfer_call(str(source_ext), dest)
    if not ok:
        raise HTTPException(status_code=500, detail="Failed to transfer call")

    # Let WebSocket bridge push updated state if available
    if bridge:
        await bridge.broadcast_state_now()

    return {"ok": True, "source": str(source_ext), "destination": dest}


@app.get("/api/queues")
async def get_queues(current_user: dict = Depends(require_scope("calls:read"))):
    """Get queue information (filtered by user allowed queues for supervisors). Default queue is hidden."""
    if not monitor:
        raise HTTPException(status_code=503, detail="AMI not connected")
    def _not_default(q: str) -> bool:
        return (q or "").strip().lower() != "default"
    allowed = current_user.get("allowed_queue_names")
    if allowed is None:
        return {
            "queues": {k: v for k, v in monitor.queues.items() if _not_default(k)},
            "members": {k: v for k, v in monitor.queue_members.items() if _not_default(v.get("queue", ""))},
            "entries": {k: v for k, v in monitor.queue_entries.items() if _not_default(v.get("queue", ""))},
        }
    q_set = set(str(q) for q in (allowed or []))
    queues = {k: v for k, v in monitor.queues.items() if k in q_set and _not_default(k)}
    members = {k: v for k, v in monitor.queue_members.items() if v.get("queue") in q_set and _not_default(v.get("queue", ""))}
    entries = {k: v for k, v in monitor.queue_entries.items() if v.get("queue") in q_set and _not_default(v.get("queue", ""))}
    return {"queues": queues, "members": members, "entries": entries}


@app.get("/api/status")
async def get_status(current_user: dict = Depends(require_scope("calls:read"))):
    """Get server status."""
    return {
        "connected": monitor.connected if monitor else False,
        "extensions_count": len(monitor.monitored) if monitor else 0,
        "active_calls": len(monitor.active_calls) if monitor else 0,
        "websocket_clients": len(manager.active_connections)
    }


@app.get("/api/qos/status")
async def get_qos_status(current_user: dict = Depends(get_current_user)):
    """Get current QoS configuration status from database."""
    qos_enabled_str = get_setting('QOS_ENABLED', os.getenv('QOS_ENABLED', ''))
    qos_enabled = qos_enabled_str.lower() in ('true', '1', 'yes')
    
    return {
        "enabled": qos_enabled,
        "pbx": get_setting('PBX', os.getenv('PBX', 'FreePBX'))
    }


@app.get("/api/crm/config")
async def get_crm_config(current_user: dict = Depends(require_admin)):
    """Get current CRM configuration from database."""
    # Build config from database (fallback to env)
    crm_enabled_str = get_setting('CRM_ENABLED', os.getenv('CRM_ENABLED', ''))
    config = {
        "enabled": crm_enabled_str.lower() in ('true', '1', 'yes'),
        "server_url": get_setting('CRM_SERVER_URL', os.getenv('CRM_SERVER_URL', '')),
        "auth_type": get_setting('CRM_AUTH_TYPE', os.getenv('CRM_AUTH_TYPE', 'api_key')).lower(),
        "endpoint_path": get_setting('CRM_ENDPOINT_PATH', os.getenv('CRM_ENDPOINT_PATH', '/api/calls')),
        "timeout": int(get_setting('CRM_TIMEOUT', os.getenv('CRM_TIMEOUT', '30'))),
        "verify_ssl": get_setting('CRM_VERIFY_SSL', os.getenv('CRM_VERIFY_SSL', 'true')).lower() in ('true', '1', 'yes'),
    }
    
    auth_type = config["auth_type"]
    
    # Add auth-specific fields (masked for security)
    if auth_type == 'api_key':
        api_key = get_setting('CRM_API_KEY', os.getenv('CRM_API_KEY', ''))
        config["api_key"] = "***" if api_key else ""
        config["api_key_header"] = get_setting('CRM_API_KEY_HEADER', os.getenv('CRM_API_KEY_HEADER', ''))
    elif auth_type == 'basic_auth':
        config["username"] = get_setting('CRM_USERNAME', os.getenv('CRM_USERNAME', ''))
        password = get_setting('CRM_PASSWORD', os.getenv('CRM_PASSWORD', ''))
        config["password"] = "***" if password else ""
    elif auth_type == 'bearer_token':
        bearer_token = get_setting('CRM_BEARER_TOKEN', os.getenv('CRM_BEARER_TOKEN', ''))
        config["bearer_token"] = "***" if bearer_token else ""
    elif auth_type == 'oauth2':
        config["oauth2_client_id"] = get_setting('CRM_OAUTH2_CLIENT_ID', os.getenv('CRM_OAUTH2_CLIENT_ID', ''))
        oauth2_secret = get_setting('CRM_OAUTH2_CLIENT_SECRET', os.getenv('CRM_OAUTH2_CLIENT_SECRET', ''))
        config["oauth2_client_secret"] = "***" if oauth2_secret else ""
        config["oauth2_token_url"] = get_setting('CRM_OAUTH2_TOKEN_URL', os.getenv('CRM_OAUTH2_TOKEN_URL', ''))
        config["oauth2_scope"] = get_setting('CRM_OAUTH2_SCOPE', os.getenv('CRM_OAUTH2_SCOPE', ''))

    # Call-data sync (push) configuration + the field catalog the UI renders as
    # checkboxes. Selecting which fields to push, per-direction filtering and the
    # POST/PUT method all live here.
    sync = load_crm_sync_config()
    if sync is not None:
        config["sync_enabled"] = sync.enabled
        config["sync_endpoint"] = get_setting('CRM_SYNC_ENDPOINT', '') or ''
        config["sync_method"] = sync.method
        config["sync_fields"] = sync.fields
        config["sync_dir_inbound"] = sync.dir_inbound
        config["sync_dir_outbound"] = sync.dir_outbound
        config["sync_dir_internal"] = sync.dir_internal
        config["block_private"] = sync.block_private
        config["sync_duration_format"] = sync.duration_format
        config["sync_status_map"] = sync.status_map
        config["sync_key_map"] = sync.key_map
    config["field_catalog"] = list(CRM_SYNC_FIELD_CATALOG)
    # Read-only, server-derived. The UI renders the rename grid and the outcome-map
    # editor from these, so it never hardcodes wire key names or outcome values.
    config["default_keys"] = default_outbound_keys() if default_outbound_keys else {}
    config["call_outcomes"] = list(CALL_OUTCOMES)

    # Contact lookup configuration (no secrets — reuses the connection auth)
    lookup = load_crm_lookup_config()
    if lookup is not None:
        config["lookup_enabled"] = lookup.enabled
        config["lookup_url"] = lookup.url_template
        config["lookup_name_template"] = lookup.name_template
        config["lookup_number_format"] = lookup.number_format
        config["lookup_match_digits"] = lookup.match_digits
        config["lookup_verify_path"] = lookup.verify_path
        config["lookup_ttl_hours"] = lookup.ttl_hours

    return config


def save_qos_status_to_db(enabled: bool):
    """Save QoS enabled status to database."""
    try:
        success = set_setting('QOS_ENABLED', 'true' if enabled else 'false')
        if success:
            log.info(f"QoS status saved to database: QOS_ENABLED={'true' if enabled else 'false'}")
        return success
    except Exception as e:
        log.error(f"Failed to save QoS status to database: {e}")
        return False


@app.post("/api/qos/enable")
async def enable_qos_endpoint(current_user: dict = Depends(require_admin)):
    """
    Enable QoS (Quality of Service) configuration.
    This will:
    1. Write macro-hangupcall override to the appropriate file based on PBX type
    2. Write sub-hangupcall-custom to extensions_custom.conf
    3. Reload Asterisk dialplan
    4. Save QOS_ENABLED=true to .env file
    """
    try:
        success = enable_qos()
        if success:
            # Save status to database
            save_qos_status_to_db(True)
            return {
                "success": True,
                "message": "QoS configuration enabled successfully. Asterisk dialplan reloaded."
            }
        else:
            raise HTTPException(status_code=500, detail="Failed to enable QoS configuration. Check server logs for details.")
    except Exception as e:
        log.error(f"Failed to enable QoS: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to enable QoS configuration: {str(e)}")


@app.post("/api/qos/disable")
async def disable_qos_endpoint(current_user: dict = Depends(require_admin)):
    """
    Disable QoS (Quality of Service) configuration.
    This will:
    1. Remove macro-hangupcall override from the appropriate file
    2. Remove sub-hangupcall-custom from extensions_custom.conf
    3. Reload Asterisk dialplan
    4. Save QOS_ENABLED=false to .env file
    """
    try:
        success = disable_qos()
        if success:
            # Save status to database
            save_qos_status_to_db(False)
            return {
                "success": True,
                "message": "QoS configuration disabled successfully. Asterisk dialplan reloaded."
            }
        else:
            raise HTTPException(status_code=500, detail="Failed to disable QoS configuration. Check server logs for details.")
    except Exception as e:
        log.error(f"Failed to disable QoS: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to disable QoS configuration: {str(e)}")


@app.get("/api/mobile-wake/status")
async def get_mobile_wake_status(current_user: dict = Depends(get_current_user)):
    """Get current mobile wake configuration."""
    enabled_str = get_setting('MOBILE_WAKE_ENABLED', os.getenv('MOBILE_WAKE_ENABLED', ''))
    wait_str = get_setting('MOBILE_WAKE_WAIT', os.getenv('MOBILE_WAKE_WAIT', '3'))
    return {
        "enabled": enabled_str.lower() in ('true', '1', 'yes'),
        "wait_seconds": int(wait_str) if wait_str.isdigit() else 4,
    }


class MobileWakeConfigBody(BaseModel):
    wait_seconds: int = 4


@app.post("/api/mobile-wake/enable")
async def enable_mobile_wake_endpoint(body: MobileWakeConfigBody = MobileWakeConfigBody(), current_user: dict = Depends(require_admin)):
    """Enable the mobile pre-dial wake dialplan. Optionally set wait_seconds."""
    try:
        wait = max(1, min(body.wait_seconds, 30))
        if enable_mobile_wake(wait_seconds=wait):
            set_setting('MOBILE_WAKE_ENABLED', 'true')
            set_setting('MOBILE_WAKE_WAIT', str(wait))
            return {"success": True, "message": f"Mobile wake enabled (wait={wait}s). Asterisk dialplan reloaded."}
        raise HTTPException(status_code=500, detail="Failed to enable mobile wake. Check server logs.")
    except HTTPException:
        raise
    except Exception as e:
        log.error(f"Failed to enable mobile wake: {e}")
        raise HTTPException(status_code=500, detail="Internal server error")


@app.post("/api/mobile-wake/disable")
async def disable_mobile_wake_endpoint(current_user: dict = Depends(require_admin)):
    """Disable the mobile pre-dial wake dialplan."""
    try:
        if disable_mobile_wake():
            set_setting('MOBILE_WAKE_ENABLED', 'false')
            return {"success": True, "message": "Mobile wake disabled. Asterisk dialplan reloaded."}
        raise HTTPException(status_code=500, detail="Failed to disable mobile wake. Check server logs.")
    except HTTPException:
        raise
    except Exception as e:
        log.error(f"Failed to disable mobile wake: {e}")
        raise HTTPException(status_code=500, detail="Internal server error")


@app.get("/api/recording/status")
async def get_recording_status(current_user: dict = Depends(get_current_user)):
    """Get current full-call recording configuration."""
    enabled_str = get_setting('RECORDING_ENABLED', os.getenv('RECORDING_ENABLED', ''))
    return {
        "enabled": enabled_str.lower() in ('true', '1', 'yes'),
        "format": get_setting('RECORDING_FORMAT', os.getenv('RECORDING_FORMAT', 'wav')),
        "mixed_dir": "/var/spool/asterisk/monitor",
        "single_dir": "/var/spool/asterisk/single",
    }


class RecordingConfigBody(BaseModel):
    format: str = "wav"


@app.post("/api/recording/enable")
async def enable_recording_endpoint(body: RecordingConfigBody = RecordingConfigBody(), current_user: dict = Depends(require_admin)):
    """Enable full-call MixMonitor recording (mixed file + separate sp1/sp2 legs)."""
    try:
        fmt = (body.format or "wav").strip().lower()
        if fmt not in ("wav", "wav49", "gsm", "g722", "ulaw", "alaw", "sln"):
            raise HTTPException(status_code=400, detail=f"Unsupported recording format: {fmt}")
        if enable_recording(mix_format=fmt):
            set_setting('RECORDING_ENABLED', 'true')
            set_setting('RECORDING_FORMAT', fmt)
            return {"success": True, "message": f"Call recording enabled (format={fmt}). Asterisk dialplan reloaded."}
        raise HTTPException(status_code=500, detail="Failed to enable call recording. Check server logs.")
    except HTTPException:
        raise
    except Exception as e:
        log.error(f"Failed to enable call recording: {e}")
        raise HTTPException(status_code=500, detail="Internal server error")


@app.post("/api/recording/disable")
async def disable_recording_endpoint(current_user: dict = Depends(require_admin)):
    """Disable full-call recording (resets the predial hooks to no-ops)."""
    try:
        if disable_recording():
            set_setting('RECORDING_ENABLED', 'false')
            return {"success": True, "message": "Call recording disabled. Asterisk dialplan reloaded."}
        raise HTTPException(status_code=500, detail="Failed to disable call recording. Check server logs.")
    except HTTPException:
        raise
    except Exception as e:
        log.error(f"Failed to disable call recording: {e}")
        raise HTTPException(status_code=500, detail="Internal server error")


@app.get("/api/sip-tls/status")
async def get_sip_tls_status(current_user: dict = Depends(get_current_user)):
    """Get current SIP TLS configuration status."""
    enabled = get_setting('SIP_TLS_ENABLED', 'false').lower() in ('true', '1', 'yes')
    domain = get_setting('OPDESK_DOMAIN', os.getenv('OPDESK_DOMAIN', ''))
    return {"enabled": enabled, "domain": domain, "port": 5061}


@app.post("/api/sip-tls/enable")
async def enable_sip_tls_endpoint(current_user: dict = Depends(require_admin)):
    """Enable SIP TLS on port 5061 using the Let's Encrypt cert."""
    domain = get_setting('OPDESK_DOMAIN', os.getenv('OPDESK_DOMAIN', ''))
    if not domain:
        raise HTTPException(status_code=400, detail="OPDESK_DOMAIN is not configured. Set it in your .env file.")
    try:
        success = enable_sip_tls(domain)
        if success:
            set_setting('SIP_TLS_ENABLED', 'true')
            return {"success": True, "message": f"SIP TLS enabled on port 5061 for {domain}"}
        raise HTTPException(status_code=500, detail="Failed to enable SIP TLS. Check server logs.")
    except HTTPException:
        raise
    except Exception as e:
        log.error(f"Failed to enable SIP TLS: {e}")
        raise HTTPException(status_code=500, detail="Internal server error")


@app.post("/api/sip-tls/disable")
async def disable_sip_tls_endpoint(current_user: dict = Depends(require_admin)):
    """Disable SIP TLS on port 5061."""
    try:
        success = disable_sip_tls()
        if success:
            set_setting('SIP_TLS_ENABLED', 'false')
            return {"success": True, "message": "SIP TLS disabled. Port 5061 closed."}
        raise HTTPException(status_code=500, detail="Failed to disable SIP TLS. Check server logs.")
    except HTTPException:
        raise
    except Exception as e:
        log.error(f"Failed to disable SIP TLS: {e}")
        raise HTTPException(status_code=500, detail="Internal server error")


@app.post("/api/crm/config")
async def save_crm_config(config_data: dict, current_user: dict = Depends(require_admin)):
    """
    Save CRM configuration to database and apply it live (no restart required).
    """
    # Reject an SSRF-unsafe server URL before persisting anything. Raised here
    # (outside the try) so it surfaces as a real 400, not a generic 500.
    server_url_in = (config_data.get('server_url') or '').strip()
    if config_data.get('enabled') and server_url_in and validate_crm_url is not None:
        bp = config_data.get('block_private')
        if bp is None:
            bp = (get_setting('CRM_BLOCK_PRIVATE', 'false') or 'false').lower() in ('true', '1', 'yes')
        try:
            validate_crm_url(server_url_in, block_private=bool(bp))
        except ValueError as e:
            # Log the reason — the 400 detail only reaches the browser, and a bare
            # "400 Bad Request" line in the journal is undiagnosable.
            log.warning(f"CRM config save rejected: invalid server URL ({e})")
            raise HTTPException(status_code=400, detail=f"Invalid CRM server URL: {e}")

    warnings = []
    try:
        # Get existing settings to preserve masked values
        existing_settings = get_all_settings()

        # Save basic CRM settings
        set_setting('CRM_ENABLED', 'true' if config_data.get('enabled') else 'false')
        set_setting('CRM_SERVER_URL', config_data.get('server_url', ''))
        set_setting('CRM_AUTH_TYPE', config_data.get('auth_type', 'api_key'))
        set_setting('CRM_ENDPOINT_PATH', config_data.get('endpoint_path', '/api/calls'))
        set_setting('CRM_TIMEOUT', str(config_data.get('timeout', 30)))
        set_setting('CRM_VERIFY_SSL', 'true' if config_data.get('verify_ssl', True) else 'false')
        
        # Handle auth-specific settings
        # For sensitive fields (password, api_key, bearer_token, oauth2_client_secret),
        # preserve existing value if new value is "***" (masked) or empty
        auth_type = config_data.get('auth_type', 'api_key')
        if auth_type == 'api_key':
            api_key = config_data.get('api_key', '')
            if api_key and api_key != '***':
                set_setting('CRM_API_KEY', api_key)
            elif 'CRM_API_KEY' in existing_settings:
                # Preserve existing API key
                pass  # Already in database
            if config_data.get('api_key_header'):
                set_setting('CRM_API_KEY_HEADER', config_data.get('api_key_header', ''))
        elif auth_type == 'basic_auth':
            if config_data.get('username'):
                set_setting('CRM_USERNAME', config_data.get('username', ''))
            password = config_data.get('password', '')
            if password and password != '***':
                set_setting('CRM_PASSWORD', password)
            elif 'CRM_PASSWORD' in existing_settings:
                # Preserve existing password
                pass  # Already in database
        elif auth_type == 'bearer_token':
            bearer_token = config_data.get('bearer_token', '')
            if bearer_token and bearer_token != '***':
                set_setting('CRM_BEARER_TOKEN', bearer_token)
            elif 'CRM_BEARER_TOKEN' in existing_settings:
                # Preserve existing bearer token
                pass  # Already in database
        elif auth_type == 'oauth2':
            if config_data.get('oauth2_client_id'):
                set_setting('CRM_OAUTH2_CLIENT_ID', config_data.get('oauth2_client_id', ''))
            oauth2_secret = config_data.get('oauth2_client_secret', '')
            if oauth2_secret and oauth2_secret != '***':
                set_setting('CRM_OAUTH2_CLIENT_SECRET', oauth2_secret)
            elif 'CRM_OAUTH2_CLIENT_SECRET' in existing_settings:
                # Preserve existing OAuth2 client secret
                pass  # Already in database
            if config_data.get('oauth2_token_url'):
                set_setting('CRM_OAUTH2_TOKEN_URL', config_data.get('oauth2_token_url', ''))
            if config_data.get('oauth2_scope'):
                set_setting('CRM_OAUTH2_SCOPE', config_data.get('oauth2_scope', ''))

        # ── Call-data sync (push) settings ──
        # Older clients may POST without these keys; default to "on / all" so the
        # legacy behaviour is preserved and nothing is silently disabled.
        set_setting('CRM_SYNC_ENABLED', 'true' if config_data.get('sync_enabled', True) else 'false')
        sync_method = str(config_data.get('sync_method', 'POST')).upper()
        set_setting('CRM_SYNC_METHOD', 'PUT' if sync_method == 'PUT' else 'POST')
        if 'sync_endpoint' in config_data:
            set_setting('CRM_SYNC_ENDPOINT', (config_data.get('sync_endpoint') or '').strip())
        if 'sync_fields' in config_data:
            cleaned = parse_sync_fields(config_data.get('sync_fields')) if parse_sync_fields else []
            # Never persist an empty selection — fall back to the compatible default,
            # but tell the operator we did so instead of silently reverting.
            if cleaned:
                set_setting('CRM_SYNC_FIELDS', ','.join(cleaned))
                # No field is forced into the body any more, so a selection with
                # neither identity field produces calls the CRM cannot attribute.
                if 'caller' not in cleaned and 'destination' not in cleaned:
                    warnings.append(
                        "Neither Caller nor Destination is selected — the CRM will "
                        "receive calls it cannot identify.")
            else:
                set_setting('CRM_SYNC_FIELDS', ','.join(DEFAULT_CRM_SYNC_FIELDS))
                warnings.append("No sync fields were selected — reverted to the default field set.")
        set_setting('CRM_SYNC_DIR_INBOUND', 'true' if config_data.get('sync_dir_inbound', True) else 'false')
        set_setting('CRM_SYNC_DIR_OUTBOUND', 'true' if config_data.get('sync_dir_outbound', True) else 'false')
        set_setting('CRM_SYNC_DIR_INTERNAL', 'true' if config_data.get('sync_dir_internal', True) else 'false')
        set_setting('CRM_BLOCK_PRIVATE', 'true' if config_data.get('block_private', False) else 'false')

        # ── Payload shaping: duration unit, outcome remap, outbound key rename ──
        # Validated before persisting rather than silently coerced: a dropped rename
        # or a bad unit is invisible in the payload, so the operator has to be told.
        if 'sync_duration_format' in config_data:
            fmt = str(config_data.get('sync_duration_format') or 'hms').strip().lower()
            if fmt not in ('hms', 'seconds'):
                raise HTTPException(
                    status_code=400,
                    detail="sync_duration_format must be 'hms' or 'seconds'")
            set_setting('CRM_SYNC_DURATION_FORMAT', fmt)

        if 'sync_key_map' in config_data and parse_key_map:
            raw_map = config_data.get('sync_key_map') or {}
            parsed = parse_key_map(raw_map)
            if isinstance(raw_map, dict):
                dropped = [k for k in raw_map if k not in parsed and str(raw_map.get(k) or '').strip()]
                if dropped:
                    warnings.append(
                        "Ignored key rename(s) for unknown outbound key(s): "
                        + ", ".join(sorted(dropped)))
            set_setting('CRM_SYNC_KEY_MAP', json.dumps(parsed))

        if 'sync_status_map' in config_data and parse_status_map:
            raw_map = config_data.get('sync_status_map') or {}
            parsed = parse_status_map(raw_map)
            unknown = [k for k in parsed if k not in CALL_OUTCOMES]
            if unknown:
                warnings.append(
                    "Outcome remap source(s) not produced by OpDesk (will never match): "
                    + ", ".join(sorted(unknown)))
            set_setting('CRM_SYNC_STATUS_MAP', json.dumps(parsed))

        # ── Contact lookup settings ──
        # The lookup URL is a *path template* appended to the already-SSRF-validated
        # server URL; refusing absolute URLs keeps that single validation surface.
        if 'lookup_enabled' in config_data:
            set_setting('CRM_LOOKUP_ENABLED', 'true' if config_data.get('lookup_enabled') else 'false')
        if 'lookup_url' in config_data:
            lookup_url = (config_data.get('lookup_url') or '').strip()
            if lookup_url and (not lookup_url.startswith('/') or '://' in lookup_url):
                log.warning(f"CRM config save rejected: lookup_url is not a path ({lookup_url[:80]!r})")
                raise HTTPException(
                    status_code=400,
                    detail="lookup_url must be a path starting with '/' (it is appended to the CRM server URL)")
            set_setting('CRM_LOOKUP_URL', lookup_url)
        if 'lookup_name_template' in config_data:
            set_setting('CRM_LOOKUP_NAME_TEMPLATE', (config_data.get('lookup_name_template') or '').strip())
        if 'lookup_number_format' in config_data:
            fmt = str(config_data.get('lookup_number_format') or 'digits').strip().lower()
            if fmt not in LOOKUP_NUMBER_FORMATS:
                raise HTTPException(
                    status_code=400,
                    detail=f"lookup_number_format must be one of: {', '.join(LOOKUP_NUMBER_FORMATS)}")
            set_setting('CRM_LOOKUP_NUMBER_FORMAT', fmt)
        if 'lookup_match_digits' in config_data:
            try:
                match_digits = int(config_data.get('lookup_match_digits') or 0)
            except (TypeError, ValueError):
                raise HTTPException(status_code=400, detail="lookup_match_digits must be an integer >= 0")
            if match_digits < 0:
                raise HTTPException(status_code=400, detail="lookup_match_digits must be an integer >= 0")
            set_setting('CRM_LOOKUP_MATCH_DIGITS', str(match_digits))
        if 'lookup_verify_path' in config_data:
            set_setting('CRM_LOOKUP_VERIFY_PATH', (config_data.get('lookup_verify_path') or '').strip())
        if 'lookup_ttl_hours' in config_data:
            try:
                ttl_hours = int(config_data.get('lookup_ttl_hours') or 24)
            except (TypeError, ValueError):
                raise HTTPException(status_code=400, detail="lookup_ttl_hours must be a positive integer")
            if ttl_hours < 1:
                raise HTTPException(status_code=400, detail="lookup_ttl_hours must be a positive integer")
            set_setting('CRM_LOOKUP_TTL_HOURS', str(ttl_hours))

        log.info("CRM configuration saved to database")

        # Apply immediately — rebuild the connector + sync config and hand them to
        # the live AMI monitor so changes take effect without a restart.
        global crm_connector, monitor
        reload_ok = True
        try:
            crm_connector = init_crm_connector()
            new_sync = load_crm_sync_config()
            if monitor is not None and hasattr(monitor, 'set_crm'):
                monitor.set_crm(crm_connector, new_sync)
            if contact_resolver is not None:
                contact_resolver.set_config(load_crm_lookup_config(), crm_connector)
            log.info("✅ CRM configuration reloaded live (no restart needed)")
        except Exception as e:
            reload_ok = False
            log.error(f"CRM config saved but live reload failed (restart to apply): {e}")
            warnings.append("Configuration saved, but applying it live failed — restart the server to apply.")

        return {
            "success": True,
            "reload_ok": reload_ok,
            "warnings": warnings,
            "message": "CRM configuration saved and applied." if reload_ok
                       else "CRM configuration saved (restart required to apply)."
        }

    except HTTPException as e:
        # The detail only reaches the browser; without this line a rejected save
        # is just an undiagnosable "400 Bad Request" in the journal.
        log.warning(f"CRM config save rejected ({e.status_code}): {e.detail}")
        raise
    except Exception as e:
        log.error(f"Failed to save CRM config: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to save CRM configuration: {str(e)}")


def _connector_from_request(config_data: dict) -> "CRMConnector":
    """
    Build a throwaway connector from posted config values, falling back to saved
    secrets when a field is masked ("***") or blank. Shared by the connection-test
    and lookup-test endpoints; persists nothing. Caller must close() it.
    """
    if CRMConnector is None or create_crm_connector is None:
        raise HTTPException(status_code=503, detail="CRM connector module not available")

    def _val(posted_key, setting_key, default=''):
        v = config_data.get(posted_key)
        if v is None or v == '':
            return get_setting(setting_key, os.getenv(setting_key, default))
        return v

    def _secret(posted_key, setting_key):
        v = config_data.get(posted_key)
        if v and v != '***':
            return v
        return get_setting(setting_key, os.getenv(setting_key, ''))

    server_url = (_val('server_url', 'CRM_SERVER_URL') or '').strip()
    if not server_url:
        raise HTTPException(status_code=400, detail="CRM server URL is required")
    auth_type = (_val('auth_type', 'CRM_AUTH_TYPE', 'api_key') or 'api_key').lower()

    # SSRF guard — same rules as save.
    bp = config_data.get('block_private')
    if bp is None:
        bp = (get_setting('CRM_BLOCK_PRIVATE', 'false') or 'false').lower() in ('true', '1', 'yes')
    if validate_crm_url is not None:
        try:
            validate_crm_url(server_url, block_private=bool(bp))
        except ValueError as e:
            raise HTTPException(status_code=400, detail=f"Invalid CRM server URL: {e}")

    cfg = {"server_url": server_url, "auth_type": auth_type,
           "endpoint_path": _val('endpoint_path', 'CRM_ENDPOINT_PATH', '/api/calls')}
    if isinstance(config_data.get('verify_ssl'), bool):
        cfg['verify_ssl'] = config_data['verify_ssl']
    else:
        cfg['verify_ssl'] = (get_setting('CRM_VERIFY_SSL', 'true') or 'true').lower() in ('true', '1', 'yes')
    try:
        cfg['timeout'] = int(config_data.get('timeout') or get_setting('CRM_TIMEOUT', '30') or 30)
    except (TypeError, ValueError):
        cfg['timeout'] = 30

    if auth_type == 'api_key':
        cfg['api_key'] = _secret('api_key', 'CRM_API_KEY')
        hdr = _val('api_key_header', 'CRM_API_KEY_HEADER', 'X-API-Key')
        if hdr:
            cfg['api_key_header'] = hdr
    elif auth_type == 'basic_auth':
        cfg['username'] = _val('username', 'CRM_USERNAME')
        cfg['password'] = _secret('password', 'CRM_PASSWORD')
    elif auth_type == 'bearer_token':
        cfg['bearer_token'] = _secret('bearer_token', 'CRM_BEARER_TOKEN')
    elif auth_type == 'oauth2':
        cfg['oauth2_client_id'] = _val('oauth2_client_id', 'CRM_OAUTH2_CLIENT_ID')
        cfg['oauth2_client_secret'] = _secret('oauth2_client_secret', 'CRM_OAUTH2_CLIENT_SECRET')
        cfg['oauth2_token_url'] = _val('oauth2_token_url', 'CRM_OAUTH2_TOKEN_URL')
        scope = _val('oauth2_scope', 'CRM_OAUTH2_SCOPE')
        if scope:
            cfg['oauth2_scope'] = scope

    try:
        return create_crm_connector(cfg)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/api/crm/test")
async def test_crm_connection(config_data: dict = None, current_user: dict = Depends(require_admin)):
    """
    Test connectivity to the CRM using the values in the request body, falling
    back to saved secrets when a field is masked ("***") or blank. Persists
    nothing, so the operator can verify credentials before saving.
    """
    config_data = config_data or {}
    connector = _connector_from_request(config_data)

    # Prefer testing the actual push endpoint when one is configured.
    sync_endpoint = (config_data.get('sync_endpoint') or get_setting('CRM_SYNC_ENDPOINT', '') or '').strip() or None
    try:
        result = await connector.test_connection(endpoint_path=sync_endpoint)
        return {
            "success": bool(result.get('success')),
            "status_code": result.get('status_code'),
            "message": result.get('message', ''),
            "method": result.get('method'),
        }
    except Exception as e:
        return {"success": False, "status_code": None, "message": f"Connection test failed: {e}"}
    finally:
        try:
            await connector.close()
        except Exception:
            pass


@app.get("/api/crm/contact")
async def get_crm_contact_endpoint(phone: str, current_user: dict = Depends(get_current_user)):
    """
    Resolve a phone number to a contact name (phonebook first, then a live CRM
    lookup if configured). Called by the softphone on ring and on dial, so it
    is available to every authenticated user, not just admins. Waits briefly
    for an in-flight CRM fetch; on timeout the background fetch continues and
    the client may simply retry.
    """
    phone = (phone or '').strip()[:64]
    if contact_resolver is None:
        return {"phone": phone, "name": None, "enabled": False}
    try:
        name = await asyncio.wait_for(
            contact_resolver.resolve(phone, monitor.monitored if monitor else None),
            timeout=5)
    except asyncio.TimeoutError:
        name = None
    return {"phone": phone, "name": name, "enabled": True}


# ---------------------------------------------------------------------------
# Contacts (system phonebook). Everyone can read (the same names are already
# shown on every dashboard); only admins can write. Writes reload the
# resolver's in-memory phonebook so the change wins on the next broadcast tick.
# ---------------------------------------------------------------------------
class ContactBody(BaseModel):
    name: str
    phone: str
    company: Optional[str] = None
    notes: Optional[str] = None


async def _reload_resolver_contacts() -> None:
    if contact_resolver is not None:
        contact_resolver.set_contacts(await asyncio.to_thread(get_contacts_for_resolver))


def _validated_contact(body: ContactBody) -> tuple:
    """Normalize + validate a contact payload -> (name, phone, phone_key)."""
    name = (body.name or '').strip()
    phone = (body.phone or '').strip()
    if not name:
        raise HTTPException(status_code=400, detail="Name is required")
    key = lookup_cache_key(phone, 0)
    if not key:
        raise HTTPException(status_code=400, detail="Phone must contain digits")
    return name, phone, key


@app.get("/api/contacts")
async def api_list_contacts(current_user: dict = Depends(get_current_user)):
    """All contacts (manual and crm-sourced)."""
    contacts = await asyncio.to_thread(list_contacts)
    return {"contacts": contacts}


@app.post("/api/contacts")
async def api_create_contact(body: ContactBody, current_user: dict = Depends(require_admin)):
    """Create a manual contact (admin only)."""
    name, phone, key = _validated_contact(body)
    contact_id = await asyncio.to_thread(
        create_contact, name, phone, key,
        (body.company or '').strip() or None, (body.notes or '').strip() or None)
    if contact_id is None:
        raise HTTPException(status_code=400, detail="A contact with this phone number already exists")
    await _reload_resolver_contacts()
    return {"id": contact_id}


@app.put("/api/contacts/{contact_id}")
async def api_update_contact(contact_id: int, body: ContactBody,
                             current_user: dict = Depends(require_admin)):
    """Update a contact (admin only). Editing a crm row makes it manual."""
    name, phone, key = _validated_contact(body)
    result = await asyncio.to_thread(
        update_contact, contact_id, name, phone, key,
        (body.company or '').strip() or None, (body.notes or '').strip() or None)
    if result is None:
        raise HTTPException(status_code=400, detail="A contact with this phone number already exists")
    if result is False:
        raise HTTPException(status_code=404, detail="Contact not found")
    await _reload_resolver_contacts()
    return {"status": "ok"}


@app.delete("/api/contacts/{contact_id}")
async def api_delete_contact(contact_id: int, current_user: dict = Depends(require_admin)):
    """Delete a contact (admin only). A crm-sourced row may reappear on the
    number's next call if the CRM still knows it."""
    if not await asyncio.to_thread(delete_contact, contact_id):
        raise HTTPException(status_code=404, detail="Contact not found")
    await _reload_resolver_contacts()
    return {"status": "ok"}


@app.post("/api/crm/lookup-test")
async def test_crm_lookup(config_data: dict = None, current_user: dict = Depends(require_admin)):
    """
    Run one contact lookup with the values in the request body (masked secrets
    fall back to saved ones), bypassing all caches and persisting nothing. Returns
    the resolved name plus a truncated raw-response excerpt so an operator can
    debug a wrong name template without curl.
    """
    if run_lookup_test is None or CRMLookupConfig is None:
        raise HTTPException(status_code=503, detail="CRM lookup module not available")
    config_data = config_data or {}

    phone = (config_data.get('phone') or '').strip()
    if not phone:
        raise HTTPException(status_code=400, detail="phone is required")

    lookup_url = (config_data.get('lookup_url') or get_setting('CRM_LOOKUP_URL', '') or '').strip()
    if not lookup_url or not lookup_url.startswith('/') or '://' in lookup_url:
        raise HTTPException(
            status_code=400,
            detail="lookup_url must be a path starting with '/' (it is appended to the CRM server URL)")
    name_template = (config_data.get('lookup_name_template')
                     or get_setting('CRM_LOOKUP_NAME_TEMPLATE', '') or '').strip()
    if not name_template:
        raise HTTPException(status_code=400, detail="lookup_name_template is required")

    number_format = str(config_data.get('lookup_number_format')
                        or get_setting('CRM_LOOKUP_NUMBER_FORMAT', 'digits') or 'digits').lower()
    if number_format not in LOOKUP_NUMBER_FORMATS:
        number_format = 'digits'
    try:
        match_digits = max(0, int(config_data.get('lookup_match_digits')
                                  if config_data.get('lookup_match_digits') is not None
                                  else get_setting('CRM_LOOKUP_MATCH_DIGITS', '0') or 0))
    except (TypeError, ValueError):
        match_digits = 0

    cfg = CRMLookupConfig(
        enabled=True,
        url_template=lookup_url,
        name_template=name_template,
        number_format=number_format,
        match_digits=match_digits,
        verify_path=(config_data.get('lookup_verify_path')
                     or get_setting('CRM_LOOKUP_VERIFY_PATH', '') or '').strip(),
    )

    connector = _connector_from_request(config_data)
    try:
        return await run_lookup_test(connector, cfg, phone)
    except Exception as e:
        log.error(f"CRM lookup test failed: {type(e).__name__}")
        return {"success": False, "status_code": None, "name": None, "matched": False,
                "verify_detail": "", "raw_excerpt": "", "error": str(e)[:300]}
    finally:
        try:
            await connector.close()
        except Exception:
            pass


# ---------------------------------------------------------------------------
# Call Log Endpoints
# ---------------------------------------------------------------------------
@app.get("/api/call-log")
async def get_call_log_endpoint(
    limit: int = 100, date: str = None,
    date_from: str = None, date_to: str = None,
    search: str = None,
    current_user: dict = Depends(require_scope("cdr:read")),
):
    """
    Get call log / CDR history.
    Admin: all calls. Supervisor/agent: only calls for their allowed extensions.
    Query params:
        limit: Maximum number of records (default 100)
        date: Filter by exact date in 'YYYY-MM-DD' format (optional)
        date_from: Filter from this date inclusive, 'YYYY-MM-DD' (optional)
        date_to: Filter up to this date inclusive, 'YYYY-MM-DD' (optional)

    Performance note: on large CDR tables (100 K+ rows, e.g. MariaDB 5.5) a
    full-table scan is very slow.  When no date filter is supplied we default
    to the last 30 days as a safety net so the query stays fast.  The frontend
    also sets this default, so normal usage is unaffected.
    """
    try:
        # Safety net: default to last 30 days when no date filter is provided.
        # Prevents accidental full-table scans on large CDR databases.
        if not date and not date_from and not date_to:
            date_from = (datetime.utcnow() - timedelta(days=30)).strftime('%Y-%m-%d')

        allowed_ext = None if current_user.get("role") == "admin" else (current_user.get("allowed_agent_extensions") or [])
        search_q = (search or "").strip() or None
        data = get_call_log(limit=limit, date=date,
                            date_from=date_from, date_to=date_to,
                            allowed_extensions=allowed_ext, search=search_q)
        total = get_call_log_count_from_db(date=date, date_from=date_from, date_to=date_to,
                                           allowed_extensions=allowed_ext, search=search_q)
        return {"calls": data, "total": total}
    except Exception as e:
        log.error(f"Error fetching call log: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to fetch call log: {str(e)}")


@app.get("/api/call-log/journey")
async def get_call_journey_endpoint(
    linkedid: str,
    current_user: dict = Depends(require_scope("cdr:read")),
):
    """
    Get call journey (event timeline) for a call by linkedid.
    Returns a list of events: INBOUND/OUTBOUND, QUEUE_ENTER, RING, ANSWER, TRANSFER, HANGUP, etc.
    """
    if not linkedid or linkedid.strip() == "":
        raise HTTPException(status_code=400, detail="linkedid is required")
    try:
        cdr_rows = get_cdr_by_linkedid(linkedid.strip())
        if not cdr_rows:
            return {"journey": []}
        journey = build_call_journey_from_cdr(cdr_rows)
        return {"journey": journey}
    except Exception as e:
        log.error(f"Error fetching call journey: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to fetch call journey: {str(e)}")


@app.get("/api/call-log/vad/{uniqueid}")
async def get_call_vad_endpoint(
    uniqueid: str,
    current_user: dict = Depends(require_scope("cdr:read")),
):
    """Get VAD (Voice Activity Detection) analysis for a call by uniqueid."""
    if not uniqueid or uniqueid.strip() == "":
        raise HTTPException(status_code=400, detail="uniqueid is required")
    try:
        data = get_call_vad_from_db(uniqueid.strip())
        if data is None:
            raise HTTPException(status_code=404, detail="No VAD data found for this call")
        # segments is stored as JSON string — parse it
        if isinstance(data.get("segments"), str):
            import json as _json
            try:
                data["segments"] = _json.loads(data["segments"])
            except Exception:
                data["segments"] = None
        # Remove non-serializable fields
        data.pop("created_at", None)
        return data
    except HTTPException:
        raise
    except Exception as e:
        log.error(f"Error fetching call VAD: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to fetch VAD data: {str(e)}")


# ---------------------------------------------------------------------------
# Call Notifications (read/archive)
# ---------------------------------------------------------------------------
@app.get("/api/call-notifications")
async def get_call_notifications_endpoint(
    extension: Optional[str] = None,
    status: Optional[str] = None,
    limit: int = 200,
    current_user: dict = Depends(get_current_user),
):
    """
    List call notifications. Agents see only their extension; admin/supervisor see all (optional ?extension= filter).
    status: new | read | archived (optional filter).
    """
    # Notifications: only show the logged-in user's own extension (so each user sees only their missed calls)
    user_ext = current_user.get("extension")
    if user_ext:
        extension = user_ext
    allowed = current_user.get("allowed_agent_extensions")
    if current_user.get("role") != "admin":
        if not allowed and current_user.get("role") == "agent" and user_ext:
            allowed = [user_ext]
        if not allowed:
            return {"notifications": [], "total": 0}
        if extension and extension not in allowed:
            raise HTTPException(status_code=403, detail="Not allowed to view this extension")
        if not extension and len(allowed) == 1:
            extension = allowed[0]
    if status and status not in ("new", "read", "archived"):
        raise HTTPException(status_code=400, detail="Invalid status")
    try:
        notifications = get_call_notifications_from_db(extension=extension, status_flag=status, limit=limit)
        if current_user.get("role") != "admin" and allowed and not extension:
            notifications = [n for n in notifications if n.get("extension") in allowed]
        return {"notifications": notifications, "total": len(notifications)}
    except Exception as e:
        log.error(f"Error fetching call notifications: {e}")
        raise HTTPException(status_code=500, detail="Failed to fetch call notifications")


class CallNotificationUpdate(BaseModel):
    status_flag: str


@app.patch("/api/call-notifications/{notification_id}")
async def update_call_notification_endpoint(
    notification_id: int,
    body: CallNotificationUpdate,
    current_user: dict = Depends(get_current_user),
):
    """Mark a notification as read or archived. Allowed only for notifications for the user's extension(s)."""
    if body.status_flag not in ("read", "archived"):
        raise HTTPException(status_code=400, detail="status_flag must be 'read' or 'archived'")
    notification = get_call_notification_by_id(notification_id)
    if not notification:
        raise HTTPException(status_code=404, detail="Notification not found")
    allowed = current_user.get("allowed_agent_extensions")
    if current_user.get("role") != "admin" and (not allowed or notification.get("extension") not in allowed):
        raise HTTPException(status_code=403, detail="Not allowed to update this notification")
    ok = update_call_notification_status(notification_id, body.status_flag)
    if not ok:
        raise HTTPException(status_code=500, detail="Update failed")
    return {"ok": True, "id": notification_id, "status_flag": body.status_flag}


@app.get("/api/recordings/{file_path:path}")
async def serve_recording(
    request: Request,
    file_path: str,
    token: Optional[str] = None,
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(security),
):
    """Serve a recording audio file.

    Auth is hand-rolled rather than require_scope("cdr:read") because this route must
    also accept a `?token=` query param — an <audio src> cannot set headers.
    """
    from fastapi.responses import FileResponse as AudioFileResponse
    import mimetypes

    # Validate auth: API key, Bearer header, or query token
    raw_key = _extract_api_key(request)
    if raw_key:
        meta = lookup_api_key(raw_key) if lookup_api_key else None
        if not meta:
            raise HTTPException(status_code=401, detail="Invalid or expired API key")
        if "cdr:read" not in (meta.get("scopes") or []):
            raise HTTPException(status_code=403,
                                detail="API key missing required scope: cdr:read")
    else:
        jwt_token = (credentials.credentials if credentials else None) or token
        if not jwt_token or not decode_token(jwt_token):
            raise HTTPException(status_code=401, detail="Not authenticated")

    # Security: only allow serving files from the recording root directory
    root_dir = os.getenv('ASTERISK_RECORDING_ROOT_DIR')
    
    # Normalize paths, resolving symlinks to prevent traversal
    if not os.path.isabs(file_path):
        file_path = os.path.join(root_dir, file_path)
    requested_path = os.path.realpath(file_path)
    root_real = os.path.realpath(root_dir)

    # Security check: ensure the resolved path is within the recording root
    if not requested_path.startswith(root_real + os.sep) and requested_path != root_real:
        raise HTTPException(status_code=403, detail="Access denied")
    
    if not os.path.exists(requested_path) or not os.path.isfile(requested_path):
        raise HTTPException(status_code=404, detail="Recording not found")
    
    # Determine content type
    content_type, _ = mimetypes.guess_type(requested_path)
    if not content_type:
        content_type = "audio/wav"
    
    return AudioFileResponse(
        requested_path,
        media_type=content_type,
        filename=os.path.basename(requested_path)
    )


# ---------------------------------------------------------------------------
# Settings Management Endpoints
# ---------------------------------------------------------------------------
@app.post("/api/settings")
async def save_settings(settings_data: dict, current_user: dict = Depends(require_admin)):
    """
    Save settings to database.
    Accepts a dictionary of key-value pairs to save.
    """
    try:
        saved_settings = []
        failed_settings = []
        
        for key, value in settings_data.items():
            # Convert value to string if it's not already
            value_str = str(value) if value is not None else ''
            if set_setting(key, value_str):
                saved_settings.append(key)
            else:
                failed_settings.append(key)
        
        if failed_settings:
            log.warning(f"Failed to save some settings: {failed_settings}")
        
        return {
            "success": len(failed_settings) == 0,
            "saved": saved_settings,
            "failed": failed_settings,
            "message": f"Saved {len(saved_settings)} setting(s)" + (f", {len(failed_settings)} failed" if failed_settings else "")
        }
    
    except Exception as e:
        log.error(f"Failed to save settings: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to save settings: {str(e)}")


@app.get("/api/settings")
async def get_settings(current_user: dict = Depends(require_admin)):
    """Get all settings from database."""
    try:
        settings = get_all_settings()
        return {
            "success": True,
            "settings": settings
        }
    except Exception as e:
        log.error(f"Failed to get settings: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to get settings: {str(e)}")


@app.get("/api/settings/{key}")
async def get_setting_by_key(key: str, current_user: dict = Depends(require_admin)):
    """Get a specific setting by key."""
    try:
        value = get_setting(key)
        return {
            "success": True,
            "key": key,
            "value": value
        }
    except Exception as e:
        log.error(f"Failed to get setting {key}: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to get setting: {str(e)}")


# ---------------------------------------------------------------------------
# Health check (public, no auth required)
# ---------------------------------------------------------------------------
# ---------------------------------------------------------------------------
# Analytics Endpoints
# ---------------------------------------------------------------------------

def _analytics_scope(current_user: dict):
    """Return (allowed_queues, allowed_agents) based on role."""
    role = current_user.get("role")
    if role == "agent":
        raise HTTPException(status_code=403, detail="Agents do not have access to analytics")
    if role == "admin":
        return None, None
    allowed_queues = current_user.get("allowed_queue_names") or []
    allowed_agents = current_user.get("allowed_agent_extensions") or []
    return allowed_queues, allowed_agents


@app.get("/api/analytics/overview")
async def analytics_overview(
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    current_user: dict = Depends(require_scope("analytics:read")),
):
    """
    Executive KPI overview: SLA%, FCR%, abandonment, AHT, volume with prev-period deltas.
    Roles: admin, supervisor.
    """
    try:
        allowed_queues, allowed_agents = _analytics_scope(current_user)
        thresholds = analytics_module.get_sla_thresholds()
        fcr_cfg = analytics_module.get_fcr_settings()
        return analytics_module.compute_executive_kpis(
            date_from, date_to, allowed_queues, allowed_agents, thresholds, fcr_cfg
        )
    except HTTPException:
        raise
    except Exception as e:
        log.error(f"analytics overview error: {e}")
        raise HTTPException(status_code=500, detail="Internal server error")


@app.get("/api/analytics/queue-performance")
async def analytics_queue_performance(
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    current_user: dict = Depends(require_scope("analytics:read")),
):
    """Per-queue KPI table. Roles: admin, supervisor."""
    try:
        allowed_queues, _ = _analytics_scope(current_user)
        thresholds = analytics_module.get_sla_thresholds()
        fcr_cfg = analytics_module.get_fcr_settings()
        return {"queues": analytics_module.compute_queue_performance(
            date_from, date_to, allowed_queues, thresholds, fcr_cfg
        )}
    except HTTPException:
        raise
    except Exception as e:
        log.error(f"analytics queue performance error: {e}")
        raise HTTPException(status_code=500, detail="Internal server error")


@app.get("/api/analytics/agent-performance")
async def analytics_agent_performance(
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    current_user: dict = Depends(require_scope("analytics:read")),
):
    """Per-agent KPI table with 7-day trend. Roles: admin, supervisor."""
    try:
        _, allowed_agents = _analytics_scope(current_user)
        thresholds = analytics_module.get_sla_thresholds()
        return {"agents": analytics_module.compute_agent_performance(
            date_from, date_to, allowed_agents, thresholds
        )}
    except HTTPException:
        raise
    except Exception as e:
        log.error(f"analytics agent performance error: {e}")
        raise HTTPException(status_code=500, detail="Internal server error")


@app.get("/api/analytics/agent-adherence")
async def analytics_agent_adherence(
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    current_user: dict = Depends(require_scope("analytics:read")),
):
    """Agent Adherence: Login/Logout/Logged-In/Ready/On-Call/Wrap-up/Not-Ready/Occupancy
    per agent for the selected period, from agent_activity presence segments. Scope-filtered.
    Roles: admin, supervisor."""
    try:
        _, allowed_agents = _analytics_scope(current_user)
        return analytics_module.compute_agent_adherence(date_from, date_to, allowed_agents)
    except HTTPException:
        raise
    except Exception as e:
        log.error(f"analytics agent adherence error: {e}")
        raise HTTPException(status_code=500, detail="Internal server error")


def _fmt_hms(secs) -> str:
    """Seconds -> H:MM:SS for spreadsheet readability. Blank on None/negative."""
    try:
        s = int(secs or 0)
    except (TypeError, ValueError):
        return ''
    if s < 0:
        s = 0
    h, rem = divmod(s, 3600)
    m, sec = divmod(rem, 60)
    return f"{h}:{m:02d}:{sec:02d}"


@app.get("/api/analytics/agent-adherence/export")
async def analytics_agent_adherence_export(
    format: str = "csv",
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    current_user: dict = Depends(require_scope("analytics:read")),
):
    """Export the Agent Adherence report as CSV or XLSX. Roles: admin, supervisor.
    Columns mirror the on-screen report plus a per-agent Not-Ready breakdown and a
    server-side 'Generated at' stamp (in the filename and a header line)."""
    from fastapi.responses import StreamingResponse
    from io import BytesIO, StringIO

    try:
        _, allowed_agents = _analytics_scope(current_user)
        result = analytics_module.compute_agent_adherence(date_from, date_to, allowed_agents)
        agents = result.get('agents', [])

        generated_at = datetime.now()
        gen_stamp = generated_at.strftime('%Y-%m-%d %H:%M:%S')
        gen_file = generated_at.strftime('%Y%m%d-%H%M%S')
        date_label = f"{date_from or 'all'}_{date_to or 'all'}"
        filename_base = f"agent_adherence_{date_label}_{gen_file}"

        headers_row = ['Agent', 'Name', 'Login', 'Logout', 'Still Logged In',
                       'Logged In', 'Ready', 'On Call', 'Wrap-up', 'Not Ready',
                       'Occupancy %', 'Not Ready Breakdown']

        def row_values(a):
            breakdown = '; '.join(
                f"{b.get('label', b.get('code'))}: {_fmt_hms(b.get('secs'))}"
                for b in a.get('not_ready_breakdown', [])
            )
            return [
                a.get('agent', ''),
                a.get('name', ''),
                a.get('login') or '',
                '' if a.get('logged_in') else (a.get('logout') or ''),
                'Yes' if a.get('logged_in') else 'No',
                _fmt_hms(a.get('logged_in_secs')),
                _fmt_hms(a.get('ready_secs')),
                _fmt_hms(a.get('on_call_secs')),
                _fmt_hms(a.get('wrap_secs')),
                _fmt_hms(a.get('not_ready_secs')),
                a.get('occupancy_pct', 0),
                breakdown,
            ]

        if format.lower() == 'xlsx':
            try:
                import openpyxl
                wb = openpyxl.Workbook()
                ws = wb.active
                ws.title = "Agent Adherence"
                ws.append([f"Generated at: {gen_stamp}"])
                ws.append([f"Period: {date_from or 'all'} to {date_to or 'all'}"])
                ws.append([])
                ws.append(headers_row)
                for a in agents:
                    ws.append(row_values(a))
                buf = BytesIO()
                wb.save(buf)
                buf.seek(0)
                return StreamingResponse(
                    buf,
                    media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                    headers={"Content-Disposition": f'attachment; filename="{filename_base}.xlsx"'}
                )
            except ImportError:
                raise HTTPException(status_code=500, detail="openpyxl not installed; use CSV export")
        else:
            # CSV with UTF-8 BOM for Excel compatibility
            buf = StringIO()
            buf.write('﻿')  # BOM
            buf.write(f'"Generated at: {gen_stamp}"\r\n')
            buf.write(f'"Period: {date_from or "all"} to {date_to or "all"}"\r\n')
            buf.write('\r\n')
            buf.write(','.join(f'"{h}"' for h in headers_row) + '\r\n')
            for a in agents:
                vals = [str(v).replace('"', '""') for v in row_values(a)]
                buf.write(','.join(f'"{v}"' for v in vals) + '\r\n')
            csv_bytes = buf.getvalue().encode('utf-8')
            return StreamingResponse(
                BytesIO(csv_bytes),
                media_type="text/csv; charset=utf-8",
                headers={"Content-Disposition": f'attachment; filename="{filename_base}.csv"'}
            )
    except HTTPException:
        raise
    except Exception as e:
        log.error(f"agent adherence export error: {e}")
        raise HTTPException(status_code=500, detail="Internal server error")


@app.get("/api/analytics/heatmap")
async def analytics_heatmap(
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    current_user: dict = Depends(require_scope("analytics:read")),
):
    """7×24 call volume heatmap matrix. Roles: admin, supervisor."""
    try:
        allowed_queues, _ = _analytics_scope(current_user)
        return analytics_module.compute_hourly_heatmap(date_from, date_to, allowed_queues)
    except HTTPException:
        raise
    except Exception as e:
        log.error(f"analytics heatmap error: {e}")
        raise HTTPException(status_code=500, detail="Internal server error")


@app.get("/api/analytics/trend")
async def analytics_trend(
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    current_user: dict = Depends(require_scope("analytics:read")),
):
    """Daily volume trend (total / answered / abandoned). Roles: admin, supervisor."""
    try:
        allowed_queues, allowed_agents = _analytics_scope(current_user)
        return {"trend": analytics_module.compute_volume_trend(date_from, date_to, allowed_queues, allowed_agents)}
    except HTTPException:
        raise
    except Exception as e:
        log.error(f"analytics trend error: {e}")
        raise HTTPException(status_code=500, detail="Internal server error")


@app.get("/api/analytics/drilldown")
async def analytics_drilldown(
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    queue: Optional[str] = None,
    agent: Optional[str] = None,
    direction: Optional[str] = None,
    disposition: Optional[str] = None,
    page: int = 1,
    page_size: int = 50,
    current_user: dict = Depends(require_scope("analytics:read")),
):
    """Paginated drilldown with analytics fields (wait_secs, sla_met). Roles: admin, supervisor."""
    try:
        allowed_queues, allowed_agents = _analytics_scope(current_user)
        thresholds = analytics_module.get_sla_thresholds()
        return analytics_module.compute_drilldown(
            date_from, date_to,
            queue_ext=queue,
            agent_ext=agent,
            direction=direction,
            disposition_filter=disposition,
            page=max(1, page),
            page_size=min(200, max(1, page_size)),
            allowed_queues=allowed_queues,
            allowed_agents=allowed_agents,
            sla_thresholds=thresholds,
        )
    except HTTPException:
        raise
    except Exception as e:
        log.error(f"analytics drilldown error: {e}")
        raise HTTPException(status_code=500, detail="Internal server error")


@app.get("/api/analytics/export")
async def analytics_export(
    format: str = "csv",
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    queue: Optional[str] = None,
    agent: Optional[str] = None,
    direction: Optional[str] = None,
    disposition: Optional[str] = None,
    current_user: dict = Depends(require_scope("analytics:read")),
):
    """Export drilldown data as CSV or XLSX. Roles: admin, supervisor."""
    from fastapi.responses import StreamingResponse
    from io import BytesIO, StringIO

    try:
        allowed_queues, allowed_agents = _analytics_scope(current_user)
        thresholds = analytics_module.get_sla_thresholds()
        result = analytics_module.compute_drilldown(
            date_from, date_to,
            queue_ext=queue,
            agent_ext=agent,
            direction=direction,
            disposition_filter=disposition,
            page=1,
            page_size=100000,
            allowed_queues=allowed_queues,
            allowed_agents=allowed_agents,
            sla_thresholds=thresholds,
        )
        calls = result.get('calls', [])
        date_label = f"{date_from or 'all'}_{date_to or 'all'}"

        headers_row = ['Date', 'Src', 'Queue', 'Agent', 'Duration(s)', 'Talk(s)',
                       'Wait(s)', 'Disposition', 'SLA Met']

        def row_values(r):
            return [
                r.get('calldate', ''),
                r.get('src', ''),
                r.get('queue_extension', ''),
                r.get('agent_extension', ''),
                r.get('duration', ''),
                r.get('talk', ''),
                r.get('wait_secs', ''),
                r.get('disposition', ''),
                'Yes' if r.get('sla_met') else 'No',
            ]

        if format.lower() == 'xlsx':
            try:
                import openpyxl
                wb = openpyxl.Workbook()
                ws = wb.active
                ws.title = "Analytics Export"
                ws.append(headers_row)
                for r in calls:
                    ws.append(row_values(r))
                buf = BytesIO()
                wb.save(buf)
                buf.seek(0)
                return StreamingResponse(
                    buf,
                    media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                    headers={"Content-Disposition": f'attachment; filename="analytics_{date_label}.xlsx"'}
                )
            except ImportError:
                raise HTTPException(status_code=500, detail="openpyxl not installed; use CSV export")
        else:
            # CSV with UTF-8 BOM for Excel compatibility
            buf = StringIO()
            buf.write('\ufeff')  # BOM
            buf.write(','.join(headers_row) + '\r\n')
            for r in calls:
                vals = [str(v).replace('"', '""') for v in row_values(r)]
                buf.write(','.join(f'"{v}"' for v in vals) + '\r\n')
            csv_bytes = buf.getvalue().encode('utf-8')
            return StreamingResponse(
                BytesIO(csv_bytes),
                media_type="text/csv; charset=utf-8",
                headers={"Content-Disposition": f'attachment; filename="analytics_{date_label}.csv"'}
            )
    except HTTPException:
        raise
    except Exception as e:
        log.error(f"analytics export error: {e}")
        raise HTTPException(status_code=500, detail="Internal server error")


@app.get("/api/analytics/settings")
async def get_analytics_settings(current_user: dict = Depends(get_current_user)):
    """Get SLA thresholds and FCR config. Roles: admin only."""
    if current_user.get("role") != "admin":
        raise HTTPException(status_code=403, detail="Admin only")
    return {
        "sla_thresholds": analytics_module.get_sla_thresholds(),
        "sla_default_secs": analytics_module.get_sla_default_secs(),
        "fcr_window_days": analytics_module.get_fcr_settings().get('window_days', 7),
        "short_abandon_secs": analytics_module.get_fcr_settings().get('short_abandon_secs', 5),
    }


@app.post("/api/analytics/settings")
async def save_analytics_settings(
    body: dict = Body(...),
    current_user: dict = Depends(get_current_user),
):
    """Save SLA thresholds and/or FCR config. Roles: admin only."""
    if current_user.get("role") != "admin":
        raise HTTPException(status_code=403, detail="Admin only")
    try:
        if 'sla_thresholds' in body:
            analytics_module.save_sla_thresholds(body['sla_thresholds'])
        if 'sla_default_secs' in body:
            from db_manager import set_setting as db_set_setting
            db_set_setting('SLA_DEFAULT_SECS', str(int(body['sla_default_secs'])))
        if 'fcr_window_days' in body or 'short_abandon_secs' in body:
            cur = analytics_module.get_fcr_settings()
            analytics_module.save_fcr_settings(
                window_days=int(body.get('fcr_window_days', cur['window_days'])),
                short_abandon_secs=int(body.get('short_abandon_secs', cur['short_abandon_secs'])),
            )
        return {"ok": True}
    except Exception as e:
        log.error(f"analytics settings save error: {e}")
        raise HTTPException(status_code=500, detail="Internal server error")


@app.get("/health")
async def health_check():
    """Public health endpoint for load balancers and monitoring."""
    return {"status": "ok", "ami_connected": bool(monitor and getattr(monitor, "connected", False))}


@app.get("/api/openapi.yaml", include_in_schema=False)
async def serve_openapi_spec():
    """Serve the hand-written OpenAPI 3.0 spec for the public integration API."""
    spec_path = os.path.abspath(
        os.path.join(os.path.dirname(__file__), "..", "docs", "api", "openapi.yaml"))
    if not os.path.exists(spec_path):
        raise HTTPException(status_code=404, detail="OpenAPI spec not found")
    return FileResponse(spec_path, media_type="application/yaml", filename="openapi.yaml")


# ---------------------------------------------------------------------------
# API fallback — must be declared AFTER every real /api route, BEFORE the SPA catch-all
# ---------------------------------------------------------------------------
# Without this, the GET-only SPA catch-all below FULL-matches any unmatched /api path
# and returns index.html with a 200: `GET /api/calls/transfer` (a POST-only route) and
# `GET /api/typo` both looked like a successful page load to an API client. Starlette
# prefers a FULL match over the PARTIAL match a method-mismatched route produces, so
# the honest answer has to be produced here rather than left to the default handling.
@app.api_route("/api/{rest:path}", include_in_schema=False,
               methods=["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"])
async def api_fallback(request: Request, rest: str):
    """404 for an unknown /api path; 405 (with Allow) when the path exists but the
    method does not."""
    # Only real /api routes count. Restricted to paths under /api and excluding this
    # fallback because the SPA catch-all ("/{full_path:path}") also regex-matches every
    # /api path — counting it would report Allow: GET for paths that do not exist and
    # turn every 404 into a 405.
    allowed = set()
    for r in app.routes:
        if (isinstance(r, APIRoute)
                and r.path.startswith("/api")
                and r.path != "/api/{rest:path}"
                and r.path_regex.match(request.url.path)):
            allowed |= set(r.methods or ())
    if allowed:
        raise HTTPException(status_code=405, detail="Method Not Allowed",
                            headers={"Allow": ", ".join(sorted(allowed))})
    raise HTTPException(status_code=404, detail="Not Found")


# ---------------------------------------------------------------------------
# Serve React Frontend (production)
# ---------------------------------------------------------------------------
# Check if frontend build exists (build lives in project root frontend/dist)
frontend_path = os.path.join(os.path.dirname(__file__), "..", "frontend", "dist")
frontend_path = os.path.abspath(frontend_path)
if os.path.exists(frontend_path):
    app.mount("/assets", StaticFiles(directory=os.path.join(frontend_path, "assets")), name="assets")

    @app.get("/{full_path:path}", include_in_schema=False)
    async def serve_frontend(full_path: str):
        """Serve the React SPA. Deep links (/call-log, /settings, …) all land here."""
        # Belt-and-braces: /api/* is handled by api_fallback above, but if route
        # ordering ever regresses an API client must still not receive HTML.
        if full_path == "api" or full_path.startswith("api/"):
            raise HTTPException(status_code=404, detail="Not Found")
        file_path = os.path.join(frontend_path, full_path)
        resolved = os.path.realpath(file_path)
        if not resolved.startswith(os.path.realpath(frontend_path)):
            raise HTTPException(status_code=403, detail="Forbidden")
        if os.path.exists(resolved) and os.path.isfile(resolved):
            return FileResponse(resolved)
        return FileResponse(os.path.join(frontend_path, "index.html"))


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def _get_ssl_paths():
    """Return (certfile, keyfile) for HTTPS if configured, else (None, None).
    Supports absolute paths (e.g. /opt/OpDesk/cert/opdesk_cert.pem) or paths relative to this file's directory.
    """
    cert = os.getenv("HTTPS_CERT", "").strip()
    key = os.getenv("HTTPS_KEY", "").strip()
    if not cert or not key:
        return None, None
    _dir = os.path.dirname(os.path.abspath(__file__))
    if not os.path.isabs(cert):
        cert = os.path.normpath(os.path.join(_dir, cert))
    if not os.path.isabs(key):
        key = os.path.normpath(os.path.join(_dir, key))
    if os.path.isfile(cert) and os.path.isfile(key):
        return cert, key
    return None, None


if __name__ == "__main__":
    ssl_cert, ssl_key = _get_ssl_paths()
    if ssl_cert and ssl_key:
        port = int(os.getenv("OPDESK_HTTPS_PORT", "8443"))
        log.info("Starting OpDesk over HTTPS on port %s (cert=%s)", port, ssl_cert)
        uvicorn.run(
            "server:app",
            host=os.getenv("OPDESK_BIND_HOST", "0.0.0.0"),
            port=port,
            ssl_certfile=ssl_cert,
            ssl_keyfile=ssl_key,
            reload=True,
            log_level="info",
        )
    else:
        port = int(os.getenv("PORT", "8765"))
        log.info("Starting OpDesk over HTTP on port %s (set HTTPS_CERT and HTTPS_KEY for HTTPS)", port)
        uvicorn.run(
            "server:app",
            host=os.getenv("OPDESK_BIND_HOST", "0.0.0.0"),
            port=port,
            reload=True,
            log_level="info",
        )

