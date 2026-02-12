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
from datetime import datetime
from typing import Dict, Set, Optional
from contextlib import asynccontextmanager
from dotenv import load_dotenv

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
import uvicorn

from ami import AMIExtensionsMonitor, _format_duration, _meaningful, DIALPLAN_CTX, normalize_interface
from db_manager import get_extensions_from_db, get_extension_names_from_db, init_settings_table, get_setting, set_setting, get_all_settings
from qos import enable_qos, disable_qos
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
    """Manages WebSocket connections and broadcasts."""
    
    def __init__(self):
        self.active_connections: Set[WebSocket] = set()
        self._lock = asyncio.Lock()
    
    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        async with self._lock:
            self.active_connections.add(websocket)
        log.info(f"Client connected. Total connections: {len(self.active_connections)}")
    
    async def disconnect(self, websocket: WebSocket):
        async with self._lock:
            self.active_connections.discard(websocket)
        log.info(f"Client disconnected. Total connections: {len(self.active_connections)}")
    
    async def broadcast(self, message: dict):
        """Broadcast message to all connected clients."""
        if not self.active_connections:
            return
        
        data = json.dumps(message, default=str)
        disconnected = set()
        
        # Copy connections to avoid modification during iteration
        async with self._lock:
            connections = list(self.active_connections)
        
        for connection in connections:
            try:
                await connection.send_text(data)
            except Exception:
                disconnected.add(connection)
        
        # Clean up disconnected clients
        if disconnected:
            async with self._lock:
                self.active_connections -= disconnected
    
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
        """Broadcast current state to all clients."""
        state = self.get_current_state()
        await self.manager.broadcast({
            "type": "state_update",
            "data": state,
            "timestamp": datetime.now().isoformat()
        })
    
    async def broadcast_state_now(self):
        """Trigger immediate state broadcast (public method)."""
        await self._broadcast_current_state()
    
    def get_current_state(self) -> dict:
        """Get current state for broadcast."""
        # Build extensions status
        extensions = {}
        for ext in self.monitor.monitored:
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
        
        # Build active calls (caller perspective only)
        active_calls = {}
        callees = set()
        
        # First pass: identify callees
        for ext, info in self.monitor.active_calls.items():
            caller = info.get('caller', '')
            if caller and caller.isdigit() and len(caller) <= 5:
                callees.add(ext)
        
        # Second pass: build active list
        for ext, info in self.monitor.active_calls.items():
            if not info.get('channel') or not ext.isdigit() or ext in DIALPLAN_CTX:
                continue
            if ext in callees:
                continue
            state = info.get('state', '').strip()
            if state and state.lower() == 'down':
                continue
            
            active_calls[ext] = self._format_call_info(ext, info)
        
        # Build queue info
        queues = {}
        for queue_name, queue_info in self.monitor.queues.items():
            queues[queue_name] = {
                "name": queue_name,
                "members": queue_info.get('members', {}),
                "calls_waiting": queue_info.get('calls_waiting', 0)
            }
        
        queue_members = {}
        for member_key, member_info in self.monitor.queue_members.items():
            queue_members[member_key] = {
                "queue": member_info.get('queue', ''),
                "interface": member_info.get('interface', ''),
                "membername": member_info.get('membername', ''),
                "status": member_info.get('status', ''),
                "paused": member_info.get('paused', False),
                "dynamic": member_info.get('dynamic', False)  # True if added via AMI, False if static
            }
        
        queue_entries = {}
        for uniqueid, entry in self.monitor.queue_entries.items():
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
    
    # Initialize default settings if they don't exist
    default_settings = {
        'QOS_ENABLED': 'true',
        'CRM_ENABLED': 'false',
        'CRM_AUTH_TYPE': 'api_key',
        'CRM_ENDPOINT_PATH': '/api/calls',
        'CRM_TIMEOUT': '30',
        'CRM_VERIFY_SSL': 'true',
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


# ---------------------------------------------------------------------------
# WebSocket Endpoint
# ---------------------------------------------------------------------------
@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    """WebSocket endpoint for real-time updates."""
    await manager.connect(websocket)
    
    try:
        # Send initial state
        if bridge:
            await manager.send_personal(websocket, {
                "type": "initial_state",
                "data": bridge.get_current_state(),
                "timestamp": datetime.now().isoformat()
            })
        
        # Listen for client messages
        while True:
            data = await websocket.receive_text()
            try:
                message = json.loads(data)
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


async def handle_client_message(websocket: WebSocket, message: dict):
    """Handle incoming client messages (commands)."""
    global monitor
    
    if not monitor or not monitor.connected:
        await manager.send_personal(websocket, {
            "type": "error",
            "message": "Not connected to AMI"
        })
        return
    
    action = message.get("action", "")
    
    try:
        if action == "get_state":
            if bridge:
                await manager.send_personal(websocket, {
                    "type": "state_update",
                    "data": bridge.get_current_state(),
                    "timestamp": datetime.now().isoformat()
                })
        
        elif action == "sync":
            # Full sync like on server start - extensions, calls, and queues
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
                result = await monitor.barge_into_call(supervisor, target)
                await manager.send_personal(websocket, {
                    "type": "action_result",
                    "action": "barge",
                    "success": result,
                    "message": f"{'Started' if result else 'Failed to start'} barging into {target}"
                })
        
        elif action == "queue_add":
            queue = message.get("queue", "")
            interface = normalize_interface(message.get("interface", ""))
            penalty = message.get("penalty", 0)
            membername = message.get("membername", "")
            paused = message.get("paused", False)
            
            if queue and interface:
                success, msg = await monitor.queue_add(queue, interface, penalty, membername or None, paused)
                await manager.send_personal(websocket, {
                    "type": "action_result",
                    "action": "queue_add",
                    "success": success,
                    "message": msg if success else f"Failed to add {interface} to {queue}: {msg}"
                })
                # Trigger immediate state broadcast on success
                if success and bridge:
                    await bridge.broadcast_state_now()
        
        elif action == "queue_remove":
            queue = message.get("queue", "")
            interface = normalize_interface(message.get("interface", ""))
            
            if queue and interface:
                success, msg = await monitor.queue_remove(queue, interface)
                await manager.send_personal(websocket, {
                    "type": "action_result",
                    "action": "queue_remove",
                    "success": success,
                    "message": msg if success else f"Failed to remove {interface} from {queue}: {msg}"
                })
                # Trigger immediate state broadcast on success
                if success and bridge:
                    await bridge.broadcast_state_now()
        
        elif action == "queue_pause":
            queue = message.get("queue", "")
            interface = normalize_interface(message.get("interface", ""))
            reason = message.get("reason", "")
            
            if queue and interface:
                success, msg = await monitor.queue_pause(queue, interface, True, reason)
                await manager.send_personal(websocket, {
                    "type": "action_result",
                    "action": "queue_pause",
                    "success": success,
                    "message": msg if success else f"Failed to pause {interface} in {queue}: {msg}"
                })
                # Trigger immediate state broadcast on success
                if success and bridge:
                    await bridge.broadcast_state_now()
        
        elif action == "queue_unpause":
            queue = message.get("queue", "")
            interface = normalize_interface(message.get("interface", ""))
            
            if queue and interface:
                success, msg = await monitor.queue_unpause(queue, interface)
                await manager.send_personal(websocket, {
                    "type": "action_result",
                    "action": "queue_unpause",
                    "success": success,
                    "message": msg if success else f"Failed to unpause {interface} in {queue}: {msg}"
                })
                # Trigger immediate state broadcast on success
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
# REST API Endpoints
# ---------------------------------------------------------------------------
@app.get("/api/extensions")
async def get_extensions():
    """Get list of monitored extensions."""
    if not monitor:
        raise HTTPException(status_code=503, detail="AMI not connected")
    
    extensions = []
    for ext in monitor.monitored:
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
async def get_active_calls():
    """Get list of active calls."""
    if not monitor:
        raise HTTPException(status_code=503, detail="AMI not connected")
    
    await monitor.sync_active_calls()
    return {"calls": monitor.active_calls}


@app.get("/api/queues")
async def get_queues():
    """Get queue information."""
    if not monitor:
        raise HTTPException(status_code=503, detail="AMI not connected")
    
    return {
        "queues": monitor.queues,
        "members": monitor.queue_members,
        "entries": monitor.queue_entries
    }


@app.get("/api/status")
async def get_status():
    """Get server status."""
    return {
        "connected": monitor.connected if monitor else False,
        "extensions_count": len(monitor.monitored) if monitor else 0,
        "active_calls": len(monitor.active_calls) if monitor else 0,
        "websocket_clients": len(manager.active_connections)
    }


@app.get("/api/qos/status")
async def get_qos_status():
    """Get current QoS configuration status from database."""
    qos_enabled_str = get_setting('QOS_ENABLED', os.getenv('QOS_ENABLED', ''))
    qos_enabled = qos_enabled_str.lower() in ('true', '1', 'yes')
    
    return {
        "enabled": qos_enabled,
        "pbx": get_setting('PBX', os.getenv('PBX', 'FreePBX'))
    }


@app.get("/api/crm/config")
async def get_crm_config():
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
async def enable_qos_endpoint():
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
async def disable_qos_endpoint():
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
async def save_crm_config(config_data: dict):
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
async def get_call_log_endpoint(limit: int = 100, date: str = None,
                                date_from: str = None, date_to: str = None):
    """
    Get call log / CDR history.
    
    Query params:
        limit: Maximum number of records (default 100)
        date: Filter by exact date in 'YYYY-MM-DD' format (optional)
        date_from: Filter from this date inclusive, 'YYYY-MM-DD' (optional)
        date_to: Filter up to this date inclusive, 'YYYY-MM-DD' (optional)
    """
    try:
        data = get_call_log(limit=limit, date=date,
                            date_from=date_from, date_to=date_to)
        return {"calls": data, "total": len(data)}
    except Exception as e:
        log.error(f"Error fetching call log: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to fetch call log: {str(e)}")


@app.get("/api/recordings/{file_path:path}")
async def serve_recording(file_path: str):
    """
    Serve a recording audio file.
    The file_path should be the full absolute path to the recording.
    """
    from fastapi.responses import FileResponse as AudioFileResponse
    import mimetypes
    
    # Security: only allow serving files from the recording root directory
    root_dir = os.getenv('ASTERISK_RECORDING_ROOT_DIR', '/home/ibrahim/pyc/voip/')
    
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
async def save_settings(settings_data: dict):
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
async def get_settings():
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
async def get_setting_by_key(key: str):
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
# Check if frontend build exists
frontend_path = os.path.join(os.path.dirname(__file__), "frontend", "dist")
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
if __name__ == "__main__":
    uvicorn.run(
        "server:app",
        host="0.0.0.0",
        port=8765,
        reload=True,
        log_level="info"
    )

