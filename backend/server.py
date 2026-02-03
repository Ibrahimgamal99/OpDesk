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

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
import uvicorn

from ami import AMIExtensionsMonitor, _format_duration, _meaningful, DIALPLAN_CTX, normalize_interface
from db_manager import get_extensions_from_db

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
# Global instances
# ---------------------------------------------------------------------------
manager = ConnectionManager()
monitor: Optional[AMIExtensionsMonitor] = None
bridge: Optional[AMIEventBridge] = None


# ---------------------------------------------------------------------------
# FastAPI App
# ---------------------------------------------------------------------------
@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan - setup and teardown."""
    global monitor, bridge
    
    # Startup
    log.info("Starting Asterisk Operator Panel Server...")
    
    monitor = AMIExtensionsMonitor()
    
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

