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
from db_manager import get_extensions_from_db

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
    
    async def start(self):
        """Start the event bridge."""
        if self._running:
            return
        
        self._running = True
        
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
    Initialize CRM connector from environment variables.
    
    Environment variables:
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
    
    # Check if CRM is enabled
    crm_enabled = os.getenv('CRM_ENABLED', '').lower() in ('true', '1', 'yes')
    if not crm_enabled:
        log.info("CRM is disabled (set CRM_ENABLED=true to enable)")
        return None
    
    # Get required configuration
    server_url = os.getenv('CRM_SERVER_URL', '').strip()
    auth_type_str = os.getenv('CRM_AUTH_TYPE', '').strip().lower()
    
    if not server_url:
        log.warning("CRM_ENABLED is true but CRM_SERVER_URL is not set - CRM disabled")
        return None
    
    if not auth_type_str:
        log.warning("CRM_ENABLED is true but CRM_AUTH_TYPE is not set - CRM disabled")
        return None
    
    # Build configuration dictionary
    config = {
        "server_url": server_url,
        "auth_type": auth_type_str,
        "endpoint_path": os.getenv('CRM_ENDPOINT_PATH', '/api/calls'),
        "timeout": int(os.getenv('CRM_TIMEOUT', '30')),
        "verify_ssl": os.getenv('CRM_VERIFY_SSL', 'true').lower() in ('true', '1', 'yes')
    }
    
    # Add auth-specific configuration
    if auth_type_str == 'api_key':
        api_key = os.getenv('CRM_API_KEY', '').strip()
        if not api_key:
            log.warning("CRM_AUTH_TYPE is 'api_key' but CRM_API_KEY is not set - CRM disabled")
            return None
        config["api_key"] = api_key
        api_key_header = os.getenv('CRM_API_KEY_HEADER', '').strip()
        if api_key_header:
            config["api_key_header"] = api_key_header
    
    elif auth_type_str == 'basic_auth':
        username = os.getenv('CRM_USERNAME', '').strip()
        password = os.getenv('CRM_PASSWORD', '').strip()
        if not username or not password:
            log.warning("CRM_AUTH_TYPE is 'basic_auth' but CRM_USERNAME or CRM_PASSWORD is not set - CRM disabled")
            return None
        config["username"] = username
        config["password"] = password
    
    elif auth_type_str == 'bearer_token':
        bearer_token = os.getenv('CRM_BEARER_TOKEN', '').strip()
        if not bearer_token:
            log.warning("CRM_AUTH_TYPE is 'bearer_token' but CRM_BEARER_TOKEN is not set - CRM disabled")
            return None
        config["bearer_token"] = bearer_token
    
    elif auth_type_str == 'oauth2':
        client_id = os.getenv('CRM_OAUTH2_CLIENT_ID', '').strip()
        client_secret = os.getenv('CRM_OAUTH2_CLIENT_SECRET', '').strip()
        token_url = os.getenv('CRM_OAUTH2_TOKEN_URL', '').strip()
        if not client_id or not client_secret:
            log.warning("CRM_AUTH_TYPE is 'oauth2' but CRM_OAUTH2_CLIENT_ID or CRM_OAUTH2_CLIENT_SECRET is not set - CRM disabled")
            return None
        config["oauth2_client_id"] = client_id
        config["oauth2_client_secret"] = client_secret
        if token_url:
            config["oauth2_token_url"] = token_url
        oauth2_scope = os.getenv('CRM_OAUTH2_SCOPE', '').strip()
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
    
    # Initialize CRM connector if configured
    crm_connector = init_crm_connector()
    
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
    version="1.0.0",
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


@app.get("/api/crm/config")
async def get_crm_config():
    """Get current CRM configuration from environment variables."""
    # Build config from environment variables
    config = {
        "enabled": os.getenv('CRM_ENABLED', '').lower() in ('true', '1', 'yes'),
        "server_url": os.getenv('CRM_SERVER_URL', ''),
        "auth_type": os.getenv('CRM_AUTH_TYPE', 'api_key').lower(),
        "endpoint_path": os.getenv('CRM_ENDPOINT_PATH', '/api/calls'),
        "timeout": int(os.getenv('CRM_TIMEOUT', '30')),
        "verify_ssl": os.getenv('CRM_VERIFY_SSL', 'true').lower() in ('true', '1', 'yes'),
    }
    
    auth_type = config["auth_type"]
    
    # Add auth-specific fields (masked for security)
    if auth_type == 'api_key':
        config["api_key"] = "***" if os.getenv('CRM_API_KEY') else ""
        config["api_key_header"] = os.getenv('CRM_API_KEY_HEADER', '')
    elif auth_type == 'basic_auth':
        config["username"] = os.getenv('CRM_USERNAME', '')
        config["password"] = "***" if os.getenv('CRM_PASSWORD') else ""
    elif auth_type == 'bearer_token':
        config["bearer_token"] = "***" if os.getenv('CRM_BEARER_TOKEN') else ""
    elif auth_type == 'oauth2':
        config["oauth2_client_id"] = os.getenv('CRM_OAUTH2_CLIENT_ID', '')
        config["oauth2_client_secret"] = "***" if os.getenv('CRM_OAUTH2_CLIENT_SECRET') else ""
        config["oauth2_token_url"] = os.getenv('CRM_OAUTH2_TOKEN_URL', '')
        config["oauth2_scope"] = os.getenv('CRM_OAUTH2_SCOPE', '')
    
    return config


@app.post("/api/crm/config")
async def save_crm_config(config_data: dict):
    """
    Save CRM configuration to .env file.
    Note: This requires server restart to take effect.
    """
    try:
        import re
        from pathlib import Path
        
        # Get .env file path
        env_file = Path(__file__).parent / '.env'
        
        # Read existing .env file
        env_content = ""
        if env_file.exists():
            env_content = env_file.read_text()
        
        # Prepare new CRM config entries
        crm_vars = {
            'CRM_ENABLED': 'true' if config_data.get('enabled') else 'false',
            'CRM_SERVER_URL': config_data.get('server_url', ''),
            'CRM_AUTH_TYPE': config_data.get('auth_type', 'api_key'),
            'CRM_ENDPOINT_PATH': config_data.get('endpoint_path', '/api/calls'),
            'CRM_TIMEOUT': str(config_data.get('timeout', 30)),
            'CRM_VERIFY_SSL': 'true' if config_data.get('verify_ssl', True) else 'false',
        }
        
        # Add auth-specific variables
        auth_type = config_data.get('auth_type', 'api_key')
        if auth_type == 'api_key':
            if config_data.get('api_key'):
                crm_vars['CRM_API_KEY'] = config_data.get('api_key', '')
            if config_data.get('api_key_header'):
                crm_vars['CRM_API_KEY_HEADER'] = config_data.get('api_key_header', '')
        elif auth_type == 'basic_auth':
            if config_data.get('username'):
                crm_vars['CRM_USERNAME'] = config_data.get('username', '')
            if config_data.get('password'):
                crm_vars['CRM_PASSWORD'] = config_data.get('password', '')
        elif auth_type == 'bearer_token':
            if config_data.get('bearer_token'):
                crm_vars['CRM_BEARER_TOKEN'] = config_data.get('bearer_token', '')
        elif auth_type == 'oauth2':
            if config_data.get('oauth2_client_id'):
                crm_vars['CRM_OAUTH2_CLIENT_ID'] = config_data.get('oauth2_client_id', '')
            if config_data.get('oauth2_client_secret'):
                crm_vars['CRM_OAUTH2_CLIENT_SECRET'] = config_data.get('oauth2_client_secret', '')
            if config_data.get('oauth2_token_url'):
                crm_vars['CRM_OAUTH2_TOKEN_URL'] = config_data.get('oauth2_token_url', '')
            if config_data.get('oauth2_scope'):
                crm_vars['CRM_OAUTH2_SCOPE'] = config_data.get('oauth2_scope', '')
        
        # Remove old CRM variables from env_content
        lines = env_content.split('\n')
        filtered_lines = []
        crm_var_prefixes = ['CRM_ENABLED', 'CRM_SERVER_URL', 'CRM_AUTH_TYPE', 'CRM_API_KEY', 
                           'CRM_API_KEY_HEADER', 'CRM_USERNAME', 'CRM_PASSWORD', 'CRM_BEARER_TOKEN',
                           'CRM_OAUTH2_CLIENT_ID', 'CRM_OAUTH2_CLIENT_SECRET', 'CRM_OAUTH2_TOKEN_URL',
                           'CRM_OAUTH2_SCOPE', 'CRM_ENDPOINT_PATH', 'CRM_TIMEOUT', 'CRM_VERIFY_SSL']
        
        for line in lines:
            # Skip lines that start with CRM_ variables (we'll add them fresh)
            if any(line.strip().startswith(prefix + '=') for prefix in crm_var_prefixes):
                continue
            filtered_lines.append(line)
        
        # Add new CRM configuration
        if filtered_lines and filtered_lines[-1].strip():
            filtered_lines.append('')
        filtered_lines.append('# CRM Configuration')
        for key, value in crm_vars.items():
            if value:  # Only add non-empty values
                filtered_lines.append(f"{key}={value}")
        
        # Write back to .env file
        env_file.write_text('\n'.join(filtered_lines))
        
        log.info("CRM configuration saved to .env file")
        
        return {
            "success": True,
            "message": "CRM configuration saved. Server restart required to apply changes."
        }
    
    except Exception as e:
        log.error(f"Failed to save CRM config: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to save CRM configuration: {str(e)}")


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

