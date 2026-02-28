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
import socket
from datetime import datetime, timedelta
from urllib.parse import unquote
from typing import Dict, Set, Optional
from contextlib import asynccontextmanager
from dotenv import load_dotenv

import jwt
from pydantic import BaseModel
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException, Depends, Body
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
import uvicorn

from ami import AMIExtensionsMonitor, _format_duration, DIALPLAN_CTX, normalize_interface
from db_manager import (
    get_extensions_from_db, get_extension_names_from_db, get_queue_names_from_db, init_settings_table,
    get_setting, set_setting, get_all_settings, authenticate_user, get_call_log_count_from_db, get_call_notifications_from_db, get_call_notification_by_id, update_call_notification_status,
    get_all_users, get_user_by_id, get_user_webrtc_credentials, create_user as db_create_user, update_user as db_update_user,
    delete_user as db_delete_user, get_user_agents_and_queues,get_user_group_ids, set_user_groups,get_groups_list, get_group, 
    create_group, update_group, set_group_agents, set_group_queues, set_group_users, delete_group,
    get_agents_list, get_queues_list, sync_agents_from_extensions, sync_queues_from_list,
    set_extension_webrtc, get_extensions_with_webrtc_from_users,get_extension_secret_from_db
)
from dialplan import enable_qos, disable_qos
from call_log import call_log as get_call_log

# Load environment variables
load_dotenv()

# Import CRM connector
try:
    from crm import CRMConnector, create_crm_connector, AuthType
except ImportError:
    CRMConnector = None
    create_crm_connector = None
    AuthType = None

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
        self._state_queue: asyncio.Queue = asyncio.Queue()
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
        # Queue state update
        await self._state_queue.put(event)
    
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
        
        return {
            "extension": ext,
            "state": info.get('state', ''),
            "talking_to": talking_to,
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


# ---------------------------------------------------------------------------
# Global instances
# ---------------------------------------------------------------------------
manager = ConnectionManager()
monitor: Optional[AMIExtensionsMonitor] = None
bridge: Optional[AMIEventBridge] = None
crm_connector: Optional[CRMConnector] = None


# ---------------------------------------------------------------------------
# FastAPI App
# ---------------------------------------------------------------------------
@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan - setup and teardown."""
    global monitor, bridge, crm_connector
    
    # Startup
    log.info("Starting Asterisk Operator Panel Server...")
    
    # Initialize settings table
    init_settings_table()


    # Detect local IP for WebRTC default (can be overridden via settings/UI)
    local_ip = detect_local_ip()

    # Initialize default settings if they don't exist
    default_settings = {
        'QOS_ENABLED': 'false',
        'CRM_ENABLED': 'false',
        'CRM_AUTH_TYPE': 'api_key',
        'CRM_ENDPOINT_PATH': '/api/calls',
        'CRM_TIMEOUT': '30',
        'CRM_VERIFY_SSL': 'true',
        'WEBRTC_PBX_SERVER': f'wss://{local_ip}:8089/ws',
    }
    
    for key, default_value in default_settings.items():
        current_value = get_setting(key)
        if current_value is None or current_value == '':
            set_setting(key, default_value)
            log.info(f"Initialized default setting: {key}={default_value}")
    
    # Initialize CRM connector if configured
    crm_connector = init_crm_connector()
    
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
    
    # Create AMI monitor with CRM connector
    monitor = AMIExtensionsMonitor(crm_connector=crm_connector)
    
    if await monitor.connect():
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
            except RuntimeError:
                pass
        monitor.set_call_notification_callback(_on_call_notification_new)

        # Start event bridge
        bridge = AMIEventBridge(manager, monitor)
        await bridge.start()
        
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


app = FastAPI(
    title="Asterisk Operator Panel",
    description="Real-time extension monitoring and call management",
    version="1.2.0",
    lifespan=lifespan
)

# CORS for React development
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
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
        "exp": datetime.utcnow() + timedelta(hours=JWT_EXPIRE_HOURS),
        "iat": datetime.utcnow(),
    }
    return jwt.encode(payload, _get_jwt_secret(), algorithm=JWT_ALGORITHM)


def decode_token(token: str) -> Optional[dict]:
    try:
        return jwt.decode(token, _get_jwt_secret(), algorithms=[JWT_ALGORITHM])
    except Exception:
        return None


security = HTTPBearer(auto_error=False)


def _get_user_scope(user_id: int) -> dict:
    """Load user extension, monitor_modes (list), and allowed agents/queues. Admin gets None for allowed_* (see all). Agent sees only their extension."""
    user = get_user_by_id(user_id)
    if not user:
        return {"role": "supervisor", "extension": None, "monitor_modes": ["listen"], "allowed_agent_extensions": [], "allowed_queue_names": []}
    role = user.get("role") or "supervisor"
    extension = user.get("extension")
    monitor_modes = user.get("monitor_modes") or ["listen"]
    if role == "admin":
        return {"role": "admin", "extension": extension, "monitor_modes": monitor_modes, "allowed_agent_extensions": None, "allowed_queue_names": None}
    if role == "agent":
        # Agent sees only their own extension and no queues
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


async def get_current_user(
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(security),
) -> dict:
    """Dependency: require valid JWT. Returns user with id, username, role, extension, allowed_agent_extensions, allowed_queue_names."""
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


# ---------------------------------------------------------------------------
# Auth API (public)
# ---------------------------------------------------------------------------
class LoginBody(BaseModel):
    login: str
    password: str


@app.post("/api/auth/login")
async def auth_login(body: LoginBody):
    """
    Login with extension or username and password.
    Body: { "login": "ext_or_username", "password": "..." }
    Returns: { "access_token": "...", "token_type": "bearer", "user": { id, username, name, role } }
    """
    login = (body.login or "").strip()
    password = body.password or ""
    if not login or not password:
        raise HTTPException(status_code=400, detail="Login and password required")
    user = authenticate_user(login, password)
    if not user:
        raise HTTPException(status_code=401, detail="Invalid extension/username or password")
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
async def webrtc_config(current_user: dict = Depends(get_current_user)):
    """
    Return WebRTC softphone config for the current user: PBX WebSocket server URL (from settings),
    user extension and extension_secret (from DB). Used by the React softphone to register with SIP.js.
    """
    server = (get_setting("WEBRTC_PBX_SERVER", os.getenv("WEBRTC_PBX_SERVER", "")) or "").strip()
    creds = get_user_webrtc_credentials(current_user["id"])
    if not creds:
        return {"server": server, "extension": None, "extension_secret": None}
    ext = creds.get("extension")
    secret = creds.get("extension_secret")
    return {"server": server, "extension": ext, "extension_secret": secret}


def require_admin(current_user: dict = Depends(get_current_user)) -> dict:
    """Dependency: require admin role."""
    if current_user.get("role") != "admin":
        raise HTTPException(status_code=403, detail="Admin only")
    return current_user


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
    monitor_modes = body.monitor_modes if body.monitor_modes is not None else None
    if monitor_modes is None and body.monitor_mode:
        monitor_modes = [body.monitor_mode]
    user_id = db_create_user(
        username=username,
        password=body.password,
        name=body.name,
        extension=body.extension,
        role=body.role or "supervisor",
        monitor_mode=body.monitor_mode or "listen",
        monitor_modes=monitor_modes,
    )
    if not user_id:
        raise HTTPException(status_code=400, detail="Username or extension already in use")
    set_user_groups(user_id, group_ids=body.group_ids or [])
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
    db_update_user(
        user_id,
        name=body.name,
        extension=body.extension,
        role=body.role,
        is_active=body.is_active,
        monitor_mode=body.monitor_mode,
        monitor_modes=body.monitor_modes,
        password=body.password,
    )
    if body.group_ids is not None:
        set_user_groups(user_id, body.group_ids)
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
    """List all extensions/agents for selection. Syncs from Asterisk if monitor available."""
    if monitor and getattr(monitor, "monitored", None):
        exts = list(monitor.monitored)
        names = get_extension_names_from_db()
        sync_agents_from_extensions(exts, names)
    agents = get_agents_list()
    if not agents and monitor and getattr(monitor, "monitored", None):
        exts = list(monitor.monitored)
        names = get_extension_names_from_db()
        sync_agents_from_extensions(exts, names)
        agents = get_agents_list()
    return {"agents": agents}


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

    extension_secret = get_extension_secret_from_db(ext)
    db_update_user(extension=ext, extension_secret=extension_secret)
    log.info(f"WebRTC enabled/disabled for extension: {ext} - {enabled} and secrets set")
    return {"ok": True, "extension": ext}


@app.get("/api/settings/queues")
async def api_list_queues(
    current_user: dict = Depends(get_current_user),
):
    """List all queues for selection. Syncs from Asterisk if monitor available, else from DB (like agents). Uses name_map from DB for display names."""
    name_map = get_queue_names_from_db()
    if monitor and getattr(monitor, "queues", None):
        sync_queues_from_list(list(monitor.queues.keys()), name_map)
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
            # Full sync: reload extensions from Asterisk DB only if the set changed (new/removed), then sync status/calls/queues
            if monitor:
                extensions = get_extensions_from_db()
                if extensions:
                    new_set = set(str(e) for e in extensions)
                    if new_set != getattr(monitor, "monitored", set()):
                        monitor.monitored = new_set
                        names = get_extension_names_from_db()
                        sync_agents_from_extensions(list(monitor.monitored), names)
                await monitor.sync_extension_statuses()
                await monitor.sync_active_calls()
                await monitor.sync_queue_status()
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
async def get_extensions(current_user: dict = Depends(get_current_user)):
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
async def get_active_calls(current_user: dict = Depends(get_current_user)):
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
async def get_queues(current_user: dict = Depends(get_current_user)):
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
async def get_status(current_user: dict = Depends(get_current_user)):
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
async def get_crm_config(current_user: dict = Depends(get_current_user)):
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
async def enable_qos_endpoint(current_user: dict = Depends(get_current_user)):
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
async def disable_qos_endpoint(current_user: dict = Depends(get_current_user)):
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


@app.post("/api/crm/config")
async def save_crm_config(config_data: dict, current_user: dict = Depends(get_current_user)):
    """
    Save CRM configuration to database.
    Note: This requires server restart to take effect.
    """
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
        
        log.info("CRM configuration saved to database")
        
        return {
            "success": True,
            "message": "CRM configuration saved. Server restart required to apply changes."
        }
    
    except Exception as e:
        log.error(f"Failed to save CRM config: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to save CRM configuration: {str(e)}")


# ---------------------------------------------------------------------------
# Call Log Endpoints
# ---------------------------------------------------------------------------
@app.get("/api/call-log")
async def get_call_log_endpoint(
    limit: int = 100, date: str = None,
    date_from: str = None, date_to: str = None,
    current_user: dict = Depends(get_current_user),
):
    """
    Get call log / CDR history.
    Admin: all calls. Supervisor/agent: only calls for their allowed extensions.
    Query params:
        limit: Maximum number of records (default 100)
        date: Filter by exact date in 'YYYY-MM-DD' format (optional)
        date_from: Filter from this date inclusive, 'YYYY-MM-DD' (optional)
        date_to: Filter up to this date inclusive, 'YYYY-MM-DD' (optional)
    """
    try:
        allowed_ext = None if current_user.get("role") == "admin" else (current_user.get("allowed_agent_extensions") or [])
        data = get_call_log(limit=limit, date=date,
                            date_from=date_from, date_to=date_to,
                            allowed_extensions=allowed_ext)
        total = get_call_log_count_from_db(date=date, date_from=date_from, date_to=date_to,
                                           allowed_extensions=allowed_ext)
        return {"calls": data, "total": total}
    except Exception as e:
        log.error(f"Error fetching call log: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to fetch call log: {str(e)}")


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
    file_path: str,
    token: Optional[str] = None,
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(security),
):
    """Serve a recording audio file. Auth via Bearer header or ?token= query (for audio src)."""
    from fastapi.responses import FileResponse as AudioFileResponse
    import mimetypes

    # Validate auth: Bearer header or query token
    jwt_token = (credentials.credentials if credentials else None) or token
    if not jwt_token or not decode_token(jwt_token):
        raise HTTPException(status_code=401, detail="Not authenticated")

    # Security: only allow serving files from the recording root directory
    root_dir = os.getenv('ASTERISK_RECORDING_ROOT_DIR')
    
    # Normalize paths
    requested_path = os.path.normpath(file_path)
    root_normalized = os.path.normpath(root_dir)
    
    # If file_path is not absolute, treat as relative to root_dir
    if not os.path.isabs(requested_path):
        requested_path = os.path.normpath(os.path.join(root_dir, requested_path))
    
    # Security check: ensure the path is within the recording root
    if not requested_path.startswith(root_normalized):
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
async def save_settings(settings_data: dict, current_user: dict = Depends(get_current_user)):
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
async def get_settings(current_user: dict = Depends(get_current_user)):
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
async def get_setting_by_key(key: str, current_user: dict = Depends(get_current_user)):
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
# Serve React Frontend (production)
# ---------------------------------------------------------------------------
# Check if frontend build exists (build lives in project root frontend/dist)
frontend_path = os.path.join(os.path.dirname(__file__), "..", "frontend", "dist")
frontend_path = os.path.abspath(frontend_path)
if os.path.exists(frontend_path):
    app.mount("/assets", StaticFiles(directory=os.path.join(frontend_path, "assets")), name="assets")
    
    @app.get("/{full_path:path}")
    async def serve_frontend(full_path: str):
        """Serve React frontend."""
        file_path = os.path.join(frontend_path, full_path)
        if os.path.exists(file_path) and os.path.isfile(file_path):
            return FileResponse(file_path)
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
            host="0.0.0.0",
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
            host="0.0.0.0",
            port=port,
            reload=True,
            log_level="info",
        )

