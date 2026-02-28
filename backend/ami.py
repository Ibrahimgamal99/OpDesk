#!/usr/bin/env python3
"""
Asterisk AMI Extensions Monitor Library

Real-time extension monitoring, call tracking, queue management,
and supervisor features (listen/whisper/barge) via Asterisk Manager Interface.
"""

import logging
import os
import re
import asyncio
from typing import Dict, Optional, List, Set, Callable, Awaitable
from datetime import datetime, timedelta
from dotenv import load_dotenv
from enum import IntEnum

# Import CRM connector
try:
    from .crm import CRMConnector
except ImportError:
    # Fallback for direct execution
    try:
        from crm import CRMConnector
    except ImportError:
        CRMConnector = None

try:
    from db_manager import insert_call_notification
except ImportError:
    insert_call_notification = None

load_dotenv()
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------
__all__ = [
    'AMIExtensionsMonitor',
    'ExtensionStatus',
    'STATUS_MAP',
    'DIALPLAN_CTX',
    'normalize_interface',
    '_format_duration',
    '_meaningful',
]

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
AMI_RESPONSE_END = '\r\n\r\n'
AMI_TIMEOUT      = 5.0
EVENT_TIMEOUT    = 1.0
DIALPLAN_CTX     = {'s','h','i','t','o','a','e','start','hangup','invalid','timeout'}
DIALED_VARS      = {'EXTEN','DIALEDPEERNUMBER','DIALEDNUMBER','OUTNUM',
                    'DIAL_NUMBER','CALLEDNUM','FROM_DID'}

STATUS_MAP = {
    '-1':'Not Found', '0':'Idle', '1':'In Use', '2':'Busy',
    '4':'Unavailable', '8':'Ringing', '9':'In Use & Ringing',
    '16':'On Hold', '32':'On Hold'
}

# Queue member device status map (different from extension status!)
# See: https://wiki.asterisk.org/wiki/display/AST/Asterisk+11+ManagerEvent_QueueMemberStatus
QUEUE_MEMBER_STATUS_MAP = {
    '0': 'Unknown',
    '1': 'Not in use',  # Idle - should show GREEN
    '2': 'In use',      # In use - should show BLUE
    '3': 'Busy',
    '4': 'Invalid',
    '5': 'Unavailable',
    '6': 'Ringing',
    '7': 'Ring+In use',
    '8': 'On Hold',
}

def _queue_member_status(code: str) -> str:
    """Convert queue member device status code to human-readable string."""
    return QUEUE_MEMBER_STATUS_MAP.get(str(code), f'Unknown ({code})')

# Compiled regex patterns for better performance
_RE_EXT_FROM_CHANNEL = re.compile(r'/(\d+)-')
_RE_CHANNEL_TYPE = re.compile(r'/([^-]+)-')


class ExtensionStatus(IntEnum):
    NOT_FOUND=-1; IDLE=0; IN_USE=1; BUSY=2; UNAVAILABLE=4
    RINGING=8; IN_USE_RINGING=9; ON_HOLD=16; ON_HOLD_ALT=32


def _meaningful(value: str) -> bool:
    """Return True if *value* looks like a real phone/extension number or feature code."""
    if not value:
        return False
    v = str(value).strip()
    # Accept feature codes like *43, *72, etc.
    if v.startswith('*') and len(v) >= 2 and v[1:].isdigit():
        return True
    # Must be all digits for regular numbers
    if not v.isdigit():
        return False
    if v.lower() in DIALPLAN_CTX or len(v) <= 2:
        return False
    if len(v) == 4 and v.startswith('5'):   # dialplan priority artefact
        return False
    return True


def _ext_from_channel(channel: str) -> Optional[str]:
    """Extract extension from channel like PJSIP/110-0000001a -> '110'."""
    if not channel:
        return None
    m = _RE_EXT_FROM_CHANNEL.search(channel)
    return m.group(1) if m else None


def _parse(response: str) -> Dict[str, str]:
    """Parse AMI key: value response into a dict. Optimized for high-volume parsing."""
    out = {}
    # Pre-allocate dict size estimate (reduces rehashing)
    if len(response) > 100:
        out = {}
    
    lines = response.split('\r\n')
    for line in lines:
        if ':' in line:
            # Use partition for single split (slightly faster than split with maxsplit)
            k, _, v = line.partition(':')
            if k:  # Only process if key exists
                out[k.strip()] = v.strip()
    return out


def _format_duration(duration: timedelta) -> str:
    """Format timedelta to HH:MM:SS or MM:SS if less than an hour."""
    total_seconds = int(duration.total_seconds())
    hours = total_seconds // 3600
    minutes = (total_seconds % 3600) // 60
    seconds = total_seconds % 60
    
    if hours > 0:
        return f"{hours:02d}:{minutes:02d}:{seconds:02d}"
    else:
        return f"{minutes:02d}:{seconds:02d}"


# ---------------------------------------------------------------------------
# Core monitor
# ---------------------------------------------------------------------------
class AMIExtensionsMonitor:
    """
    Real-time Asterisk extension monitor with ChanSpy supervisor features.
    """

    def __init__(self, host=None, port=None, username=None, secret=None, context=None, crm_connector=None):
        self.host     = host     or os.getenv('AMI_HOST','127.0.0.1')
        self.port     = port     or int(os.getenv('AMI_PORT','5038'))
        self.username = username or os.getenv('AMI_USERNAME','')
        self.secret   = secret   or os.getenv('AMI_SECRET','')
        self.context  = context  or os.getenv('AMI_CONTEXT','ext-local')
        
        # Optional CRM connector - server will handle CRM configuration
        self.crm_connector = crm_connector

        # Async socket streams
        self.reader: Optional[asyncio.StreamReader] = None
        self.writer: Optional[asyncio.StreamWriter] = None
        self.connected = False
        self.running   = False
        self._event_task: Optional[asyncio.Task] = None
        self._read_buffer: str = ""  # Buffer for partial messages
        self._read_lock: asyncio.Lock = asyncio.Lock()  # Prevent concurrent reads

        # Live state
        self.extensions:   Dict[str, Dict] = {}   # ext -> last ExtensionStatus response
        self.active_calls: Dict[str, Dict] = {}   # ext -> call-info dict
        self.ch2ext:       Dict[str, str]  = {}   # channel -> ext
        self.ch_callerid:  Dict[str, str]  = {}   # channel -> callerid
        self.destch2ext:   Dict[str, str]  = {}   # dest channel -> caller ext (for tracking ringing)
        self.monitored:    Set[str]        = set()
        self._refresh_event: Optional[asyncio.Event] = None  # Signal for live monitor refresh
        self._event_callbacks: List[Callable[[Dict[str, str]], Awaitable[None]]] = []  # Event callbacks
        
        # Queue state
        self.queues:       Dict[str, Dict] = {}   # queue_name -> queue info (members, calls waiting, etc.)
        self.queue_members: Dict[str, Dict] = {}  # member_interface -> member info (queue, status, paused, etc.)
        self.queue_entries: Dict[str, Dict] = {}  # uniqueid -> queue entry info (queue, caller, position, etc.)
        self.dynamic_members: Set[str] = set()    # Track members added dynamically via AMI (can be removed)
        self.ch2uniqueid:  Dict[str, str] = {}    # channel -> uniqueid (for queue entry cleanup)
        self.ch2linkedid:  Dict[str, str] = {}    # channel -> linkedid (for tracking related channels)
        self.linkedid2channels: Dict[str, Set[str]] = {}  # linkedid -> set of active channels (to detect final hangup)
        self.linkedid_crm_sent: Set[str] = set()  # "linkedid:uniqueid" -> track which channel instances have already sent CRM data (prevent duplicates)
        self._call_notification_callback: Optional[Callable[[str], None]] = None  # optional: (extension) -> None, called when a call_notification row is inserted

    # ------------------------------------------------------------------
    # Connection
    # ------------------------------------------------------------------
    async def connect(self) -> bool:
        """Async connection to AMI server."""
        try:
            self.reader, self.writer = await asyncio.open_connection(self.host, self.port)
            self.connected = True
            
            # Read banner
            await self._read_async()
            
            # Login
            login_msg = f"Action: Login\r\nUsername: {self.username}\r\nSecret: {self.secret}\r\n\r\n"
            self.writer.write(login_msg.encode())
            await self.writer.drain()
            
            resp = await self._read_async()
            if 'Response: Success' in resp:
                log.info("Connected & authenticated to AMI at %s:%d", self.host, self.port)
                # Initial queue status sync
                try:
                    await self.sync_queue_status()
                except Exception as e:
                    log.warning("Failed to sync initial queue status: %s", e)
                return True
            log.error("Auth failed: %s", resp)
        except Exception as e:
            log.error("Connection error: %s", e)
        self.connected = False
        return False

    async def disconnect(self):
        """Async disconnect from AMI server."""
        self.running = False
        
        # Cancel event reading task
        if self._event_task and not self._event_task.done():
            self._event_task.cancel()
            try:
                await self._event_task
            except asyncio.CancelledError:
                pass
        
        if self.connected and self.writer:
            try:
                self.writer.write(b"Action: Logoff\r\n\r\n")
                await self.writer.drain()
                await asyncio.sleep(0.3)
            except Exception:
                pass
        
        if self.writer:
            try:
                self.writer.close()
                await self.writer.wait_closed()
            except Exception:
                pass
        
        self.connected = False
        self.reader = None
        self.writer = None

    async def __aenter__(self):
        await self.connect()
        return self

    async def __aexit__(self, *_):
        await self.disconnect()

    # ------------------------------------------------------------------
    # Low-level I/O (Async)
    # ------------------------------------------------------------------
    async def _read_async_unlocked(self, timeout: float = AMI_TIMEOUT) -> str:
        """Async read from AMI socket with timeout. Caller must hold _read_lock."""
        if not self.reader:
            return ""
        
        chunks = []
        try:
            while True:
                # Read with timeout
                try:
                    data = await asyncio.wait_for(self.reader.read(4096), timeout=timeout)
                except asyncio.TimeoutError:
                    break
                except asyncio.CancelledError:
                    # Re-raise cancellation to allow proper cleanup
                    raise
                
                if not data:
                    break
                
                decoded = data.decode('utf-8', errors='ignore')
                chunks.append(decoded)
                
                # Check if we have the end marker
                if decoded.endswith(AMI_RESPONSE_END):
                    break
                # For multi-chunk messages, check if combined ends with marker
                if len(chunks) > 1 and ''.join(chunks[-2:]).endswith(AMI_RESPONSE_END):
                    break
        except asyncio.CancelledError:
            # Re-raise cancellation
            raise
        except Exception as e:
            log.error("Read error: %s", e)
        
        return ''.join(chunks)

    async def _read_async(self, timeout: float = AMI_TIMEOUT) -> str:
        """Async read from AMI socket with timeout. Uses lock to prevent concurrent reads."""
        async with self._read_lock:
            return await self._read_async_unlocked(timeout)

    async def _send_async(self, action: str, params: Optional[Dict[str,str]] = None) -> Optional[str]:
        """Async send action to AMI and wait for response. Uses lock to prevent concurrent reads."""
        if not self.connected or not self.writer:
            return None
        
        parts = [f"Action: {action}\r\n"]
        if params:
            parts.extend(f"{k}: {v}\r\n" for k, v in params.items())
        parts.append("\r\n")
        cmd = ''.join(parts)
        
        async with self._read_lock:
            try:
                self.writer.write(cmd.encode())
                await self.writer.drain()
                return await self._read_async_unlocked()
            except Exception as e:
                log.error("Send %s failed: %s", action, e)
                return None
    
    async def _send_action_with_events(self, action: str, params: Optional[Dict[str,str]] = None, 
                                        complete_event: str = None, timeout: float = 10.0) -> Optional[str]:
        """
        Send AMI action and read response including follow-up events.
        Uses lock to prevent concurrent reads.
        
        Many AMI actions (QueueSummary, QueueStatus, Status, etc.) return:
        1. Initial "Response: Success" 
        2. Multiple events with data
        3. A "Complete" event (e.g., QueueSummaryComplete)
        
        This method reads until it sees the complete_event or timeout.
        """
        if not self.connected or not self.writer:
            return None
        
        parts = [f"Action: {action}\r\n"]
        if params:
            parts.extend(f"{k}: {v}\r\n" for k, v in params.items())
        parts.append("\r\n")
        cmd = ''.join(parts)
        
        # Auto-detect complete event name if not provided
        if not complete_event:
            complete_event = f"{action}Complete"
        
        async with self._read_lock:
            try:
                self.writer.write(cmd.encode())
                await self.writer.drain()
                
                # Read all chunks until we see the complete event
                chunks = []
                start_time = asyncio.get_event_loop().time()
                
                while True:
                    elapsed = asyncio.get_event_loop().time() - start_time
                    if elapsed >= timeout:
                        log.warning(f"{action}: Timeout waiting for {complete_event}")
                        break
                    
                    try:
                        data = await asyncio.wait_for(
                            self.reader.read(4096), 
                            timeout=min(2.0, timeout - elapsed)
                        )
                    except asyncio.TimeoutError:
                        # Check if we have the complete event in what we've read so far
                        full_response = ''.join(chunks)
                        if complete_event in full_response:
                            break
                        continue
                    
                    if not data:
                        break
                    
                    decoded = data.decode('utf-8', errors='ignore')
                    chunks.append(decoded)
                    
                    # Check if we have the complete event
                    full_response = ''.join(chunks)
                    if complete_event in full_response:
                        break
                
                return ''.join(chunks)
                
            except Exception as e:
                log.error("Send %s failed: %s", action, e)
                return None
    
    async def _read_events_async(self):
        """Event-driven async event reader - continuously reads events from AMI.
        Uses lock to prevent concurrent reads with command responses."""
        if not self.reader:
            return
        
        buffer = ""
        while self.running and self.connected:
            try:
                # Acquire lock before reading to prevent conflicts with _send_async/_read_async
                async with self._read_lock:
                    # Read data with a reasonable timeout
                    try:
                        data = await asyncio.wait_for(self.reader.read(4096), timeout=EVENT_TIMEOUT)
                    except asyncio.TimeoutError:
                        # Timeout is normal - continue reading (release lock first)
                        continue
                    
                    if not data:
                        # Connection closed
                        log.warning("AMI connection closed")
                        break
                    
                    decoded = data.decode('utf-8', errors='ignore')
                    buffer += decoded
                
                # Process complete messages outside the lock (dispatch doesn't need the lock)
                while AMI_RESPONSE_END in buffer:
                    event_data, buffer = buffer.split(AMI_RESPONSE_END, 1)
                    if event_data.strip():
                        await self._dispatch_async(event_data + AMI_RESPONSE_END)
                
            except asyncio.CancelledError:
                log.info("Event reading cancelled")
                break
            except Exception as e:
                if self.running:
                    log.error("Event read error: %s", e)
                break

    # ------------------------------------------------------------------
    # Call-info helpers
    # ------------------------------------------------------------------
    def _call_info(self, ext: str) -> Dict[str, str]:
        """Get or create the active_calls entry for *ext*."""
        return self.active_calls.setdefault(ext, {})

    def _resolve_ext(self, channel: str) -> Optional[str]:
        """Map channel -> ext, caching new mappings."""
        ext = self.ch2ext.get(channel)
        if not ext:
            ext = _ext_from_channel(channel)
            if ext:
                self.ch2ext[channel] = ext
        return ext

    def _display_number(self, info: Dict, ext: str) -> str:
        """Pick the best number to show for a call, in priority order."""
        # Cache the keys tuple to avoid recreation
        for key in ('original_destination', 'caller', 'destination', 'exten', 'callerid'):
            v = info.get(key)
            if v and v != ext and _meaningful(v):
                return v
        return 'Unknown'

    def _status_desc(self, code: str, ext: Optional[str] = None) -> str:
        if ext and ext in self.active_calls:
            info  = self.active_calls[ext]
            num   = self._display_number(info, ext)
            state = info.get('state', '')
            if state == 'Ringing':
                return f'Ringing with {num}'
            return f'In call with {num}' + (f' ({state})' if state not in ('Up','Ring','Ringing') else '')
        return STATUS_MAP.get(str(code).strip(), f'Unknown ({code})')

    def _cross_ref(self, caller: str, target: str):
        """Let *target* know it has an incoming call from *caller*."""
        if target == caller or not _meaningful(target):
            return
        # Only create entries for internal extensions (typically 3-4 digits)
        # Skip external numbers (more than 5 digits) to avoid stale entries
        if not target.isdigit() or len(target) > 5:
            return
        t = self._call_info(target)
        t['caller'] = caller  # Always set caller for incoming call detection
        if not t.get('original_destination'):
            t['original_destination'] = caller

    # ------------------------------------------------------------------
    # Extension status
    # ------------------------------------------------------------------
    async def get_extension_status(self, ext: str) -> Optional[Dict]:
        resp = await self._send_async('ExtensionState', {'Exten': ext, 'Context': self.context})
        if resp and 'Response: Success' in resp:
            parsed = _parse(resp)
            # Store in extensions dict so it's available for status display
            if parsed:
                self.extensions[ext] = parsed
            return parsed
        return None

    async def sync_extension_statuses(self):
        """Query and cache status for all monitored extensions."""
        if not self.connected or not self.monitored:
            return
        
        for ext in self.monitored:
            await self.get_extension_status(ext)

    # ------------------------------------------------------------------
    # Active-channel / sync
    # ------------------------------------------------------------------
    async def get_active_channel(self, ext: str) -> Optional[str]:
        # 1. local cache
        info = self.active_calls.get(ext)
        if info:
            ch = info.get('channel')
            if ch:
                return ch
        
        # Reverse lookup in ch2ext (more efficient than iterating all items)
        for ch, e in self.ch2ext.items():
            if e == ext:
                return ch

        # 2. live query (only if not found in cache)
        ext_prefix_pjsip = f'PJSIP/{ext}-'
        ext_prefix_sip = f'SIP/{ext}-'
        for action, complete_event in [('Status', 'StatusComplete'), ('CoreShowChannels', 'CoreShowChannelsComplete')]:
            resp = await self._send_action_with_events(action, complete_event=complete_event)
            if resp:
                lines = resp.split('\r\n')
                for line in lines:
                    if line.startswith('Channel:'):
                        ch = line[8:].strip()  # Faster than split
                        if ext_prefix_pjsip in ch or ext_prefix_sip in ch:
                            return ch
        return None

    async def sync_active_calls(self) -> Dict[str, Dict]:
        # Use _send_action_with_events to get all Status events until StatusComplete
        resp = await self._send_action_with_events('Status', complete_event='StatusComplete')
        if not resp:
            return self.active_calls

        # Build new state without clearing existing data first
        new_active_calls: Dict[str, Dict] = {}
        new_ch2ext: Dict[str, str] = {}
        new_ch_callerid: Dict[str, str] = {}

        current: Dict[str, str] = {}
        lines = resp.split('\r\n')
        flush_fields = ('Linkedid', 'Accountcode')
        down_states = ('down', '')
        down_channel_states = ('0', '')
        
        for line in lines:
            if ':' not in line:
                continue
            k, v = line.split(':', 1)
            k, v = k.strip(), v.strip()

            if k == 'Event':
                if v == 'StatusComplete':
                    break
                current = {} if v == 'Status' else current
                continue

            current[k] = v

            # Flush on a known "last field"
            if k in flush_fields:
                ch = current.get('Channel', '')
                if not ch:
                    current = {}
                    continue
                    
                ext = _ext_from_channel(ch)
                if not ext:
                    current = {}
                    continue
                    
                state = current.get('ChannelStateDesc', '').strip()
                channel_state = current.get('ChannelState', '').strip()
                
                # Only include channels that are actually active (not Down or hung up)
                # Active states: Up, Ringing, Ring, or numeric states > 0 (not 0=Down)
                # ChannelState: 0=Down, 4=Ring, 5=Ringing, 6=Up
                is_active = (
                    state and state.lower() not in down_states and 
                    channel_state not in down_channel_states
                )
                
                if is_active:
                    new_ch2ext[ch] = ext
                    callerid = current.get('CallerIDNum', '')
                    connected = current.get('ConnectedLineNum', '')
                    new_ch_callerid[ch] = callerid
                    
                    # Merge with existing info if available (avoid unnecessary copy if not needed)
                    existing_info = self.active_calls.get(ext)
                    if existing_info:
                        info = existing_info.copy()
                        # Preserve duration tracking fields - don't overwrite if they exist
                        # Only initialize if not already set
                        if 'start_time' not in info:
                            info['start_time'] = datetime.now()
                        if 'answer_time' not in info:
                            info['answer_time'] = None
                    else:
                        info = {}
                        # Initialize duration tracking for new calls discovered during sync
                        info['start_time'] = datetime.now()
                        info['answer_time'] = None
                    
                    info.update({
                        'channel': ch,
                        'callerid': callerid,
                        'state': state or 'Up',
                        'destination': connected,
                        'original_destination': connected if _meaningful(connected) else info.get('original_destination', '')
                    })
                    new_active_calls[ext] = info
                current = {}

        # Only replace state after successful parsing
        self.active_calls = new_active_calls
        self.ch2ext = new_ch2ext
        self.ch_callerid = new_ch_callerid
        # Keep destch2ext as it tracks ongoing dial attempts
        # Clean up destch2ext for channels that no longer exist (use set for O(1) lookup)
        new_ch2ext_set = set(new_ch2ext)
        new_active_exts = set(new_active_calls)
        self.destch2ext = {ch: ext for ch, ext in self.destch2ext.items() 
                          if ch in new_ch2ext_set or ext in new_active_exts}
        
        # Clean up queue entries and uniqueid mappings for channels that no longer exist
        new_ch2uniqueid = {}
        for ch, uniqueid in self.ch2uniqueid.items():
            if ch in new_ch2ext_set:
                new_ch2uniqueid[ch] = uniqueid
            elif uniqueid in self.queue_entries:
                # Channel is gone but queue entry exists - remove it
                entry = self.queue_entries.pop(uniqueid)
                queue = entry.get('queue', '')
                if queue in self.queues:
                    waiting_count = sum(1 for e in self.queue_entries.values() if e.get('queue') == queue)
                    self.queues[queue]['calls_waiting'] = waiting_count
        self.ch2uniqueid = new_ch2uniqueid

        log.info(f"✅ Synced: {len(self.active_calls)} active call(s)")
        return self.active_calls

    # ------------------------------------------------------------------
    # Event loop
    # ------------------------------------------------------------------
    WATCHED_EVENTS = frozenset({
        'ExtensionStatus','PeerStatus','DeviceStateChange',
        'Newchannel','Hangup','Dial','DialBegin','DialEnd',
        'Bridge','NewCallerid','Newstate','VarSet',
        'QueueMemberStatus','QueueMemberAdded','QueueMemberRemoved',
        'QueueEntry','QueueCallerJoin','QueueCallerLeave',
        'QueueMemberPause','QueueMemberPaused','QueueMemberUnpause',
        'QueueMemberRingInUse','QueueSummary',
        'AgentCalled','AgentConnect','AgentComplete'
    })

    async def _dispatch_async(self, raw: str):
        """Async event dispatcher - processes AMI events and calls handlers."""
        p = _parse(raw)
        ev = p.get('Event', '')
        if ev not in self.WATCHED_EVENTS:
            return
        
        handler = getattr(self, f'_ev_{ev}', None)
        if handler:
            # Only format timestamp if needed (for logging when extensions are monitored)
            ts = datetime.now().strftime('%H:%M:%S') if self.monitored else ''
            
            # Call handler (sync handlers are fine, but we support async too)
            if asyncio.iscoroutinefunction(handler):
                await handler(p, ts)
            else:
                handler(p, ts)
            
            # Call registered event callbacks
            for callback in self._event_callbacks:
                try:
                    if asyncio.iscoroutinefunction(callback):
                        await callback(p)
                    else:
                        callback(p)
                except Exception as e:
                    log.error("Event callback error: %s", e)
            
            # Signal refresh for live monitor if it's a call-related or queue-related event
            if ev in ('Newchannel', 'Hangup', 'Newstate', 'Dial', 'DialBegin', 'DialEnd', 'Bridge', 'NewCallerid', 'VarSet',
                     'QueueMemberStatus', 'QueueMemberAdded', 'QueueMemberRemoved', 'QueueEntry', 'QueueCallerJoin', 
                     'QueueCallerLeave', 'QueueMemberPaused', 'QueueMemberUnpause'):
                if self._refresh_event:
                    self._refresh_event.set()
    
    def register_event_callback(self, callback: Callable[[Dict[str, str]], None]):
        """Register a callback function to be called for each AMI event."""
        self._event_callbacks.append(callback)
    
    def unregister_event_callback(self, callback: Callable[[Dict[str, str]], None]):
        """Unregister an event callback."""
        if callback in self._event_callbacks:
            self._event_callbacks.remove(callback)

    def set_call_notification_callback(self, callback: Optional[Callable[[str], None]]):
        """Set callback invoked when a call_notification is inserted (extension str). Used by server to push WebSocket event."""
        self._call_notification_callback = callback

    # ------------------------------------------------------------------
    # Individual event handlers  (prefix: _ev_)
    # ------------------------------------------------------------------
    def _get_channel_type(self, channel: str) -> str:
        """Extract channel type like 'sbc' from PJSIP/sbc-000000a1, or 'Local' for internal extensions."""
        if not channel:
            return ''
        m = _RE_CHANNEL_TYPE.search(channel)
        if m:
            name = m.group(1)
            # If it's all digits, it's an internal extension -> Local
            if name.isdigit():
                return 'Local'
            return name
        return ''
    
    def map_cause_to_status(self, cause, dial_status=None):
        """
        Map Asterisk hangup cause code and dial status to CRM call status.
        
        Args:
            cause: Hangup cause code (string)
            dial_status: Dial status (optional, string)
        
        Returns:
            CRM call status string (e.g., 'completed', 'busy', 'noanswer', etc.)
        """
        cause_map = {
            '16': 'completed',
            '17': 'busy',
            '18': 'noanswer',
            '19': 'noanswer',
            '20': 'switched_off',
            '28': 'invalid_number',
            '34': 'invalid_number',
            '21': 'failed',
            '31': 'failed',
            '127': 'noanswer',
            '0': 'busy',
        }
        status = cause_map.get(cause, 'failed')
        
        if dial_status:
            dial_status = dial_status.upper()
            dial_overrides = {
                'CANCEL': 'noanswer',
                'BUSY': 'busy',
                'CONGESTION': 'failed',
                'CHANUNAVAIL': 'failed',
                'NOANSWER': 'noanswer'
            }
            status = dial_overrides.get(dial_status, status)
        
        return status

    def _should_notify_missed_or_busy(self, cause: str, call_info: Optional[Dict] = None) -> bool:
        """
        Return True only when the hangup is a missed call, busy, no answer, or similar
        (so we create a call_notification). Normal completed calls (cause 16) or answered
        calls do not create a notification.
        """
        if call_info and call_info.get('answer_time'):
            return False
        status = self.map_cause_to_status(cause, None)
        return status in ('busy', 'noanswer', 'switched_off', 'failed', 'invalid_number')

    async def _send_crm_data(self, ext: str, call_info: Dict, hangup_event: Dict, queue: Optional[str] = None):
        """
        Send call data to CRM after call ends.
        
        Args:
            ext: Extension number
            call_info: Call information dictionary from active_calls
            hangup_event: Hangup event dictionary
            queue: Optional queue name
        """
        if not self.crm_connector:
            log.info(f"⏸️ CRM connector not available - skipping CRM send for extension {ext}")
            return
        
        try:
            # Check if this is a queue call still waiting (caller in queue, no agent answered yet)
            # The queue_waiting flag is on the CALLER's call_info, not the agent's
            # So we need to check both the current call_info AND the caller's call_info if this is an agent
            queue_waiting = call_info.get('queue_waiting', False)
            queue_answered = call_info.get('queue_answered', False)
            queue_caller_channel = call_info.get('queue_caller_channel', '')
            hangup_channel = hangup_event.get('Channel', '')
            
            # If this is an agent's call_info, check the actual caller's queue_waiting status
            queue_caller = call_info.get('queue_caller', '') or call_info.get('caller', '')
            if queue_caller and queue_caller != ext:
                caller_call_info = self.active_calls.get(queue_caller)
                if caller_call_info:
                    # Use caller's queue_waiting and queue_answered status
                    queue_waiting = caller_call_info.get('queue_waiting', queue_waiting)
                    queue_answered = caller_call_info.get('queue_answered', queue_answered)
                    queue_caller_channel = caller_call_info.get('queue_caller_channel', queue_caller_channel)
                    log.debug(f"Using caller {queue_caller} queue status: waiting={queue_waiting}, answered={queue_answered}")
            
            # For queue calls that are still waiting (no agent answered):
            # Only send CRM if the caller hangs up (abandons the queue)
            # Don't send CRM when agents' ring attempts timeout
            if queue_waiting and not queue_answered:
                # Check if this hangup is from the caller's channel
                is_caller_hangup = (queue_caller_channel and hangup_channel == queue_caller_channel)
                
                # Also check if ext is an internal extension (agent) vs external caller
                is_agent_ext = ext and ext.isdigit() and 3 <= len(ext) <= 5
                
                if is_agent_ext and not is_caller_hangup:
                    # This is an agent's channel timing out while caller is still in queue
                    # Don't send CRM - wait for caller hangup or agent answer
                    log.info(f"⏸️ Queue call still waiting - skipping CRM for agent {ext} ring timeout (waiting for caller hangup or agent answer)")
                    return
                elif not is_caller_hangup:
                    # Unknown channel but not the caller - skip
                    log.debug(f"⏸️ Queue call still waiting - skipping CRM for {ext} (not caller channel)")
                    return
                else:
                    # This is the caller hanging up (abandoning the queue)
                    log.info(f"📤 Queue caller abandoned - sending CRM for caller {ext}")
            
            # Extract hangup cause and dial status
            cause = hangup_event.get('Cause', '')
            dial_status = call_info.get('dialstatus', '')
            
            # Map to CRM status
            call_status = self.map_cause_to_status(cause, dial_status)
            
            # Log if status seems incorrect (Cause=16 should be completed unless dial_status overrides)
            if cause == '16' and call_status == 'noanswer' and dial_status:
                log.debug(f"Status mapped to 'noanswer' for Cause=16 due to dial_status={dial_status}")
            
            # Get queue from parameter or from call_info (stored when call entered queue)
            if not queue:
                queue = call_info.get('queue')
            
            # Skip sending CRM data if this extension is the queue itself
            # We only want to send CRM data from the agent's perspective
            if queue and ext == queue:
                log.info(f"⏸️ Skipping CRM send for queue extension {ext} - will send from agent's perspective instead")
                return
            
            # Determine caller and destination
            caller = ext
            original_dest = call_info.get('original_destination') or call_info.get('destination') or call_info.get('exten') or ''
            
            # Check for queue call with external caller (from AgentConnect event)
            queue_caller = call_info.get('queue_caller', '')
            queue_answered = call_info.get('queue_answered', False)
            
            # Check if this is an incoming call
            # Priority order for detecting incoming caller:
            # 1. queue_caller (external caller from queue - set by AgentConnect)
            # 2. caller field (set by Newchannel or other events)
            # 3. callerid field (set by NewCallerid event for incoming calls)
            # 4. Check if ext is an external number
            incoming_caller = queue_caller or call_info.get('caller', '') or call_info.get('callerid', '')
            
            # If incoming_caller is an external number (>5 digits), this is an inbound call
            # Don't use internal extension numbers as incoming_caller
            if incoming_caller and incoming_caller.isdigit() and len(incoming_caller) <= 5:
                # This looks like an internal extension, not an external caller
                # Only keep it as incoming_caller if it's different from ext (internal transfer)
                if incoming_caller == ext:
                    incoming_caller = ''
            
            is_external_caller = ext and (not ext.isdigit() or len(ext) < 3 or len(ext) > 5)
            
            # For queue calls where agent answered: ext is the agent, incoming_caller is the external caller
            if queue and incoming_caller and incoming_caller != ext and (len(incoming_caller) > 5 or not incoming_caller.isdigit()):
                # This is a queue call with external caller
                # ext is the agent extension, incoming_caller is the external caller
                caller = incoming_caller
                destination = ext  # Agent extension
                log.debug(f"Queue call detected: caller={caller}, destination={destination}, queue={queue}")
            elif (incoming_caller and incoming_caller != ext) or is_external_caller:
                # This is an incoming call - swap caller/destination
                # For caller_ext path: ext is the caller's number, need to find the actual extension
                # For extension path: ext is the extension that handled the call
                if is_external_caller:
                    # ext is the external caller number, use it as caller
                    caller = ext
                    # Find the actual extension that answered - prefer ext if it's a valid extension, otherwise look in call_info
                    if ext and ext.isdigit() and 3 <= len(ext) <= 5:
                        # ext is actually an extension (from caller_ext path when channel has extension)
                        destination = ext
                    else:
                        # ext is external caller, find extension from call_info
                        destination = call_info.get('destination', '')
                        # If destination is a queue, we need to find the actual agent extension
                        if queue and destination == queue:
                            # Try to find from other fields or use the channel's extension if available
                            connected_dest = call_info.get('destination', '')
                            if connected_dest and connected_dest != queue and connected_dest.isdigit() and 3 <= len(connected_dest) <= 5:
                                destination = connected_dest
                else:
                    # Standard incoming call detection
                    caller = incoming_caller
                    destination = ext  # ext is the extension that handled the call
            else:
                # Outbound call - use original destination
                destination = original_dest
                # Handle queue calls: if destination matches queue, find the actual agent extension
                if queue and destination == queue:
                    # Destination is the queue, need to find the actual agent extension
                    # Try to find agent extension from call_info
                    connected_dest = call_info.get('destination', '')
                    if connected_dest and connected_dest != queue and connected_dest.isdigit() and 3 <= len(connected_dest) <= 5:
                        destination = connected_dest
                    # If destination still matches queue, we couldn't find the agent
                    # This might happen if the call didn't connect to an agent
                    # In this case, keep destination as queue (call didn't reach agent)
            
            # Override call_status if queue_answered is set (agent answered the queue call)
            if queue_answered and call_status in ('noanswer', 'failed'):
                call_status = 'completed'
                log.debug(f"Overriding call_status to 'completed' because queue_answered=True")
            
            # If destination is still the queue and we have answered_agent, use that instead
            answered_agent = call_info.get('answered_agent', '')
            if queue and destination == queue and _meaningful(answered_agent):
                destination = answered_agent
                log.debug(f"Using answered_agent {answered_agent} as destination instead of queue {queue}")
            
            # Skip if we don't have meaningful caller/destination
            if not _meaningful(caller) or not _meaningful(destination):
                log.info(f"⏸️ Skipping CRM send for extension {ext}: missing meaningful caller ({caller}) or destination ({destination})")
                log.debug(f"  call_info keys: {list(call_info.keys())}, original_dest={original_dest}, incoming_caller={incoming_caller}")
                return
            
            # Calculate duration
            duration_seconds = 0
            talk_seconds = 0
            datetime_str = datetime.now().isoformat()
            if 'start_time' in call_info:
                start_time = call_info['start_time']
                if isinstance(start_time, str):
                    # Parse if it's a string
                    try:
                        start_time = datetime.fromisoformat(start_time.replace('Z', '+00:00'))
                    except:
                        start_time = datetime.now()
                duration = datetime.now() - start_time
                duration_seconds = int(duration.total_seconds())
                datetime_str = start_time.isoformat()
            
            # Calculate talk time (time from answer to hangup)
            if 'answer_time' in call_info:
                answer_time = call_info['answer_time']
                if isinstance(answer_time, str):
                    try:
                        answer_time = datetime.fromisoformat(answer_time.replace('Z', '+00:00'))
                    except:
                        answer_time = None
                if answer_time:
                    talk_duration = datetime.now() - answer_time
                    talk_seconds = int(talk_duration.total_seconds())
            
            # Determine call type
            call_type = 'internal'
            if incoming_caller and incoming_caller != ext:
                # Has incoming caller field - inbound call
                call_type = 'inbound'
            elif destination and destination != ext:
                # Outgoing call
                # Check if destination is internal (3-5 digits) or external
                if destination.isdigit() and 3 <= len(destination) <= 5:
                    call_type = 'internal'
                else:
                    call_type = 'outbound'
            
            # Format call data for CRM
            if CRMConnector is None:
                log.warning("CRMConnector not available - cannot format call data")
                return
            
            call_data = CRMConnector.format_call_data_for_crm(
                caller=caller,
                destination=destination,
                duration=duration_seconds,
                datetime_str=datetime_str,
                call_status=call_status,
                queue=queue,  # Optional queue parameter
                call_type=call_type,
                talk_time=talk_seconds  # Talk time (time from answer to hangup)
            )
            
            log.info(f"📤 Preparing to send CRM data: {caller} -> {destination} (status: {call_status}, type: {call_type}, duration: {duration_seconds}s, talk: {talk_seconds}s, queue: {queue or 'N/A'})")
            
            # Send to CRM (fire and forget - don't block hangup processing)
            # Create async task to send CRM data (called from async dispatch context)
            try:
                loop = asyncio.get_running_loop()
                loop.create_task(self._send_crm_data_async(call_data))
            except RuntimeError:
                # No running event loop, try to get/create one
                try:
                    asyncio.ensure_future(self._send_crm_data_async(call_data))
                except Exception as e:
                    log.error(f"Could not schedule CRM send task: {e}")
            
        except Exception as e:
            log.error(f"Error preparing CRM data for call: {e}")
    
    async def _send_crm_data_async(self, call_data: Dict):
        """Async helper to send CRM data without blocking."""
        try:
            if self.crm_connector:
                caller = call_data.get('caller', 'unknown')
                destination = call_data.get('destination', 'unknown')
                log.info(f"📤 Sending call data to CRM: {caller} -> {destination}")
                result = await self.crm_connector.send_call_data(call_data)
                if result.get('success'):
                    log.info(f"✅ Successfully sent call data to CRM: {caller} -> {destination}")
                else:
                    error_msg = result.get('error', 'Unknown error')
                    status_code = result.get('status_code', 'N/A')
                    log.error(f"❌ Failed to send call data to CRM: {caller} -> {destination} (HTTP {status_code}): {error_msg}")
            else:
                log.warning(f"CRM connector not available when trying to send call data: {call_data.get('caller')} -> {call_data.get('destination')}")
        except Exception as e:
            log.error(f"❌ Error sending call data to CRM: {e}", exc_info=True)

    def _ev_ExtensionStatus(self, p, ts):
        ext  = p.get('Exten', '')
        code = p.get('Status', '-1')
        if not ext:
            return
        self.extensions[ext] = p
        # NOTE: Do NOT delete from active_calls here!
        # ExtensionStatus with code '0' (Idle) can arrive BEFORE the Hangup event.
        # Deleting here would cause "No ext_info found" in _ev_Hangup, preventing CRM data send.
        # Let _ev_Hangup handle all cleanup - it's the authoritative event for call completion.

    def _ev_PeerStatus(self, p, ts):
        pass  # Silent

    def _ev_DeviceStateChange(self, p, ts):
        device, state = p.get('Device',''), p.get('State','')
        ext = _ext_from_channel(device)
        if ext and ext in self.active_calls:
            self.active_calls[ext]['state'] = state

    def _ev_Newchannel(self, p, ts):
        ch = p.get('Channel', '')
        callerid = p.get('CallerIDNum') or p.get('CallerIDName', '')
        exten = p.get('Exten', '')
        uniqueid = p.get('Uniqueid', '')
        linkedid = p.get('Linkedid', '') or uniqueid  # Use Linkedid if available, fallback to uniqueid
        ext = _ext_from_channel(ch)
        
        # Track uniqueid for queue entry cleanup
        if uniqueid:
            self.ch2uniqueid[ch] = uniqueid
        
        # Track Linkedid to identify related channels (for detecting final hangup)
        if linkedid:
            self.ch2linkedid[ch] = linkedid
            if linkedid not in self.linkedid2channels:
                self.linkedid2channels[linkedid] = set()
            self.linkedid2channels[linkedid].add(ch)
            log.debug(f"🔗 Newchannel: Channel={ch}, Linkedid={linkedid}, ext={ext}")
        
        # Only use exten as fallback if it's a meaningful number (not dialplan context)
        if not ext and _meaningful(exten):
            ext = exten
        
        # Skip if no valid extension or if it's a dialplan context
        if not ext or ext.lower() in DIALPLAN_CTX:
            # Still track the channel for cleanup purposes
            self.ch2ext[ch] = callerid if _meaningful(callerid) else ''
            return

        self.ch2ext[ch] = ext
        info = self._call_info(ext)
        info['channel'] = ch
        info['callerid'] = callerid
        if _meaningful(exten):
            info['exten'] = exten
        elif 'exten' not in info:
            info['exten'] = ''
        info['context'] = p.get('Context', '')
        info['state'] = 'New'
        
        # Track call start time (if not already set)
        if 'start_time' not in info:
            info['start_time'] = datetime.now()
            info['answer_time'] = None
        
        # If callerid is different from ext, this is an incoming call
        # Set caller field for both internal extensions (≤5 digits) and external callers (>5 digits)
        if callerid and callerid != ext and callerid.isdigit():
            info['caller'] = callerid
            # For internal callers, also update the caller's entry
            if len(callerid) <= 5:
                caller_info = self.active_calls.get(callerid)
                if caller_info and 'original_destination' not in caller_info:
                    caller_info['original_destination'] = ext
                    caller_info['exten'] = ext
        
        if 'original_destination' not in info:
            if _meaningful(exten) and exten != ext:
                info['original_destination'] = exten
                self._cross_ref(ext, exten)
            else:
                conn = p.get('ConnectedLineNum', '')
                if _meaningful(conn):
                    info['original_destination'] = conn

    def _ev_Hangup(self, p, ts):
        ch = p.get('Channel', '')
        uniqueid = p.get('Uniqueid', '')
        cause = p.get('Cause', '')
        
        # Log all hangup events at INFO level to track if events are received
        log.info(f"🔔 Hangup event received: Channel={ch}, Uniqueid={uniqueid}, Cause={cause}")
        
        if not ch:
            log.debug("Hangup event ignored: no channel")
            return
        
        # Get uniqueid from event or channel mapping
        if not uniqueid:
            uniqueid = self.ch2uniqueid.get(ch, '')
        
        # Get queue name before cleaning up queue entries
        queue = None
        if uniqueid and uniqueid in self.queue_entries:
            entry = self.queue_entries.get(uniqueid)
            queue = entry.get('queue', '') if entry else None
        
        # Clean up queue entries for this uniqueid
        if uniqueid and uniqueid in self.queue_entries:
            entry = self.queue_entries.pop(uniqueid)
            queue = entry.get('queue', '')
            if queue in self.queues:
                # Recalculate waiting calls
                waiting_count = sum(1 for e in self.queue_entries.values() if e.get('queue') == queue)
                self.queues[queue]['calls_waiting'] = waiting_count
        
        # Clean up uniqueid mapping
        self.ch2uniqueid.pop(ch, None)
        
        # Get Linkedid from hangup event or from tracking
        # Hangup event might have Linkedid even if Newchannel didn't
        event_linkedid = p.get('Linkedid', '')
        tracked_linkedid = self.ch2linkedid.get(ch, '')
        linkedid = event_linkedid or tracked_linkedid
        
        # If we got Linkedid from event but channel wasn't tracked, add it now
        if event_linkedid and not tracked_linkedid:
            self.ch2linkedid[ch] = event_linkedid
            if event_linkedid not in self.linkedid2channels:
                self.linkedid2channels[event_linkedid] = set()
            self.linkedid2channels[event_linkedid].add(ch)
            log.info(f"🔍 Found Linkedid {event_linkedid} in hangup event for channel {ch}")
        
        is_final_hangup = False  # Default to False - only send CRM when we explicitly confirm final hangup
        
        if linkedid:
            # Check if there are other active channels with the same Linkedid BEFORE removing this one
            if linkedid in self.linkedid2channels:
                remaining_channels = self.linkedid2channels[linkedid]
                # Filter out channels that are no longer in ch2ext (already hung up) and exclude current channel
                # Also exclude system channels like "asterisk" which are not real call channels
                active_channels = {
                    ch_name for ch_name in remaining_channels 
                    if ch_name != ch 
                    and ch_name in self.ch2ext 
                    and not ch_name.startswith('PJSIP/asterisk-')  # Exclude system channels
                }
                if active_channels:
                    is_final_hangup = False
                    log.info(f"⏸️ Channel {ch} hung up but other channels still active with Linkedid {linkedid}: {active_channels} - skipping CRM send")
                else:
                    is_final_hangup = True
                    log.info(f"✅ Final channel hung up for Linkedid {linkedid} - will send CRM data")
            else:
                # Linkedid exists but no channel tracking - treat as final
                is_final_hangup = True
                log.info(f"✅ Final channel hung up for Linkedid {linkedid} (no channel tracking) - will send CRM data")
            # Remove this channel from Linkedid tracking
            self.linkedid2channels[linkedid].discard(ch)
            # Clean up empty Linkedid entry if no channels remain
            if not self.linkedid2channels[linkedid]:
                self.linkedid2channels.pop(linkedid, None)
                # Also clean up linkedid_crm_sent entries for this Linkedid (keys are "linkedid:uniqueid")
                # This handles the case where Asterisk reuses Linkedid for queue re-rings
                keys_to_remove = [k for k in self.linkedid_crm_sent if k.startswith(f"{linkedid}:")]
                for k in keys_to_remove:
                    self.linkedid_crm_sent.discard(k)
                if keys_to_remove:
                    log.debug(f"🧹 Cleaned up Linkedid {linkedid} tracking (all channels gone, removed {len(keys_to_remove)} CRM tracking keys)")
            # Clean up channel to Linkedid mapping
            self.ch2linkedid.pop(ch, None)
        else:
            # No Linkedid - skip CRM send (cannot determine if final)
            log.debug(f"⏸️ Channel {ch} hung up without Linkedid - skipping CRM send (cannot determine if final)")
        
        # Get extension from channel mapping or extract from channel name
        # Store original ext before popping (needed for finding actual extension in caller_ext path)
        original_ext = self.ch2ext.get(ch)
        ext = self.ch2ext.pop(ch, None)
        if not ext:
            ext = _ext_from_channel(ch)
            original_ext = ext
        
        # Clean up dest channel mapping
        caller_ext = self.destch2ext.pop(ch, None)
        ch_type = self._get_channel_type(ch)
        
        # Skip CRM sends for trunk/system channels (e.g., PJSIP/asterisk-*)
        # These are not actual call participants, just the connection to the external network
        is_trunk_channel = ch.startswith('PJSIP/asterisk-') or ch.startswith('SIP/asterisk-')
        if is_trunk_channel and is_final_hangup:
            log.debug(f"⏸️ Skipping CRM send for trunk channel {ch} - CRM should be sent from agent/extension perspective")
            is_final_hangup = False  # Prevent CRM send for trunk channels
        
        # Clean up caller's active call if this was a destination channel
        # (caller_ext is set when this channel was a destination for an outgoing call)
        # Skip this path if we already have extension info - extension path will handle it
        if caller_ext and not (ext and ext in self.active_calls):
            caller_info = self.active_calls.get(caller_ext)
            
            if caller_info:
                # Check if this channel matches the caller's destchannel or main channel
                destchannel_match = caller_info.get('destchannel') == ch
                channel_match = caller_info.get('channel') == ch
                
                if destchannel_match or channel_match:
                    # If caller_ext is an external number, store it in caller_info for CRM
                    # (caller_ext is the key in active_calls but might not be stored as a field)
                    if caller_ext and caller_ext.isdigit() and len(caller_ext) > 5:
                        # External caller - ensure caller number is stored in call_info
                        if not caller_info.get('callerid'):
                            caller_info['callerid'] = caller_ext
                        if not caller_info.get('caller'):
                            caller_info['caller'] = caller_ext
                    
                    # If it's final hangup, send CRM data (for outgoing calls)
                    if is_final_hangup:
                        # Use the actual extension from the channel (ext), not caller_ext
                        # This ensures we send CRM data with correct extension perspective
                        actual_ext = ext if (ext and ext.isdigit() and 3 <= len(ext) <= 5) else caller_ext
                        # Use linkedid:uniqueid as key to allow different ring cycles to send CRM
                        crm_key = f"{linkedid}:{uniqueid}" if (linkedid and uniqueid) else None
                        
                        # Check if CRM data has already been sent for this channel instance
                        if crm_key and crm_key in self.linkedid_crm_sent:
                            log.info(f"⏸️ CRM data already sent for {crm_key} - skipping duplicate send for caller {caller_ext}")
                        else:
                            log.info(f"📤 Hangup detected for caller {caller_ext}, attempting CRM send")
                            if crm_key:
                                self.linkedid_crm_sent.add(crm_key)
                            if self.crm_connector:
                                try:
                                    loop = asyncio.get_running_loop()
                                    loop.create_task(self._send_crm_data(actual_ext, caller_info, p, queue))
                                except RuntimeError:
                                    try:
                                        asyncio.ensure_future(self._send_crm_data(caller_ext, caller_info, p, queue))
                                    except Exception as e:
                                        log.error(f"Could not schedule CRM send task for caller {caller_ext}: {e}")
                            # Call notification only for missed/busy/no-answer (not normal completed)
                            if insert_call_notification and actual_ext and self._should_notify_missed_or_busy(cause, caller_info):
                                caller_val = caller_info.get('caller') or caller_info.get('callerid') or caller_ext or ''
                                queue_for_notif = queue or caller_info.get('queue')
                                insert_call_notification(extension=actual_ext, caller_from=caller_val or None, queue=queue_for_notif or None, call_id=uniqueid or None, reason=self.map_cause_to_status(cause, None))
                                if self._call_notification_callback:
                                    try:
                                        self._call_notification_callback(actual_ext)
                                    except Exception as e:
                                        log.debug("call_notification_callback error: %s", e)
                    
                    # This channel was part of the caller's call - log it
                    num = self._display_number(caller_info, caller_ext)
                    if caller_ext in self.monitored and num != 'Unknown':
                        duration_str = ""
                        if 'start_time' in caller_info:
                            duration = datetime.now() - caller_info['start_time']
                            duration_str = f" | Duration: {_format_duration(duration)}"
                            if caller_info.get('answer_time'):
                                talk_time = datetime.now() - caller_info['answer_time']
                                duration_str += f" | Talk: {_format_duration(talk_time)}"
                        log.info("[%s] 📴 %s: Hangup with %s (channel %s)%s", ts, caller_ext, num, ch_type or caller_ext, duration_str)
                    
                    # Only clean up caller's active_calls entry if this is the final hangup
                    # (i.e., caller's own channel has also hung up)
                    # Otherwise, leave it for when the caller's channel hangs up
                    if is_final_hangup:
                        self.active_calls.pop(caller_ext, None)
                    else:
                        # Just clear the destchannel reference since dest hung up
                        caller_info.pop('destchannel', None)
                        # Still notify the agent who missed the call (e.g. queue ring timeout for dest)
                        notif_ext = ext if (ext and ext.isdigit() and 3 <= len(ext) <= 5) else None
                        if insert_call_notification and notif_ext and self._should_notify_missed_or_busy(cause, caller_info):
                            caller_val = caller_info.get('caller') or caller_info.get('callerid') or caller_ext or ''
                            queue_for_notif = queue or caller_info.get('queue')
                            insert_call_notification(extension=notif_ext, caller_from=caller_val or None, queue=queue_for_notif or None, call_id=uniqueid or None, reason=self.map_cause_to_status(cause, None))
                            if self._call_notification_callback:
                                try:
                                    self._call_notification_callback(notif_ext)
                                except Exception as e:
                                    log.debug("call_notification_callback error: %s", e)
        
        # Clean up the extension's active call
        if ext:
            # Check if this channel matches the extension's channel
            ext_info = self.active_calls.get(ext)
            
            # Debug logging for hangup channel matching
            if ext_info:
                stored_channel = ext_info.get('channel', 'NOT SET')
                if stored_channel != ch:
                    log.debug(f"Channel mismatch for {ext}: stored={stored_channel}, hangup={ch}")
            else:
                log.debug(f"No ext_info found for extension {ext} in active_calls")
            
            if ext_info and ext_info.get('channel') == ch:
                # Only send CRM data if this is the final hangup (no other channels with same Linkedid)
                if is_final_hangup:
                    # Use linkedid:uniqueid as key to allow different ring cycles to send CRM
                    crm_key = f"{linkedid}:{uniqueid}" if (linkedid and uniqueid) else None
                    
                    # Check if CRM data has already been sent for this channel instance
                    if crm_key and crm_key in self.linkedid_crm_sent:
                        log.info(f"⏸️ CRM data already sent for {crm_key} - skipping duplicate send for extension {ext}")
                    else:
                        # Send CRM data before cleaning up (for incoming/internal calls)
                        log.info(f"📤 Hangup detected for extension {ext}, attempting CRM send")
                        if crm_key:
                            self.linkedid_crm_sent.add(crm_key)
                        if self.crm_connector:
                            try:
                                loop = asyncio.get_running_loop()
                                loop.create_task(self._send_crm_data(ext, ext_info, p, queue))
                            except RuntimeError:
                                try:
                                    asyncio.ensure_future(self._send_crm_data(ext, ext_info, p, queue))
                                except Exception as e:
                                    log.error(f"Could not schedule CRM send task for extension {ext}: {e}")
                        else:
                            log.warning(f"CRM connector not available - skipping CRM send for extension {ext}")
                        # Call notification only for missed/busy/no-answer (not normal completed)
                        if insert_call_notification and ext and self._should_notify_missed_or_busy(cause, ext_info):
                            caller_val = ext_info.get('caller') or ext_info.get('callerid') or self.ch_callerid.get(ch, '') or ''
                            queue_for_notif = queue or ext_info.get('queue')
                            insert_call_notification(extension=ext, caller_from=caller_val or None, queue=queue_for_notif or None, call_id=uniqueid or None, reason=self.map_cause_to_status(cause, None))
                            if self._call_notification_callback:
                                try:
                                    self._call_notification_callback(ext)
                                except Exception as e:
                                    log.debug("call_notification_callback error: %s", e)
                else:
                    log.info(f"⏸️ Skipping CRM send for extension {ext} - other channels still active (transfer in progress)")
                    # Still create notification for the agent who missed/was busy (e.g. queue ring timeout)
                    if insert_call_notification and ext and self._should_notify_missed_or_busy(cause, ext_info):
                        caller_val = ext_info.get('caller') or ext_info.get('callerid') or self.ch_callerid.get(ch, '') or ''
                        queue_for_notif = queue or ext_info.get('queue')
                        insert_call_notification(extension=ext, caller_from=caller_val or None, queue=queue_for_notif or None, call_id=uniqueid or None, reason=self.map_cause_to_status(cause, None))
                        if self._call_notification_callback:
                            try:
                                self._call_notification_callback(ext)
                            except Exception as e:
                                log.debug("call_notification_callback error: %s", e)
                
                # This is the main channel for this extension - log and clean up
                caller = ext_info.get('caller') or ext_info.get('callerid') or self.ch_callerid.get(ch, '')
                dialed_exten = ext_info.get('exten', '')
                has_dest_channel = bool(ext_info.get('destchannel'))
                
                if ext in self.monitored:
                    # Calculate duration
                    duration_str = ""
                    if 'start_time' in ext_info:
                        duration = datetime.now() - ext_info['start_time']
                        duration_str = f" | Duration: {_format_duration(duration)}"
                        
                        # Add talk time if answered
                        if ext_info.get('answer_time'):
                            talk_time = datetime.now() - ext_info['answer_time']
                            duration_str += f" | Talk: {_format_duration(talk_time)}"
                    
                    if _meaningful(dialed_exten) and dialed_exten != ext and not has_dest_channel:
                        # Feature code / application call hangup
                        log.info("[%s] 📴 %s: Hangup with %s (channel App)%s", ts, ext, dialed_exten, duration_str)
                    elif _meaningful(caller) and caller != ext:
                        log.info("[%s] 📴 %s: Hangup with %s (channel %s)%s", ts, ext, caller, ch_type or ext, duration_str)
                    else:
                        log.debug(f"Skipping hangup log for {ext}: caller={caller}, dialed_exten={dialed_exten} - conditions not met")
                
                # Remove the extension from active calls
                self.active_calls.pop(ext, None)
            elif ext_info and ext_info.get('destchannel') == ch:
                # This was a destination channel, just remove the reference
                ext_info.pop('destchannel', None)
            elif ext_info:
                # Channel doesn't match exactly, but if it's the final hangup and we have ext_info, still send CRM data
                if is_final_hangup:
                    # Use linkedid:uniqueid as key to allow different ring cycles to send CRM
                    crm_key = f"{linkedid}:{uniqueid}" if (linkedid and uniqueid) else None
                    
                    # Check if CRM data has already been sent for this channel instance
                    if crm_key and crm_key in self.linkedid_crm_sent:
                        log.info(f"⏸️ CRM data already sent for {crm_key} - skipping duplicate send for extension {ext}")
                    else:
                        log.info(f"📤 Final hangup detected for extension {ext} (channel mismatch), attempting CRM send")
                        if crm_key:
                            self.linkedid_crm_sent.add(crm_key)
                        if self.crm_connector:
                            try:
                                loop = asyncio.get_running_loop()
                                loop.create_task(self._send_crm_data(ext, ext_info, p, queue))
                            except RuntimeError:
                                try:
                                    asyncio.ensure_future(self._send_crm_data(ext, ext_info, p, queue))
                                except Exception as e:
                                    log.error(f"Could not schedule CRM send task for extension {ext}: {e}")
                        else:
                            log.warning(f"CRM connector not available - skipping CRM send for extension {ext}")
                        # Call notification only for missed/busy/no-answer
                        if insert_call_notification and ext and self._should_notify_missed_or_busy(cause, ext_info):
                            caller_val = ext_info.get('caller') or ext_info.get('callerid') or ''
                            queue_for_notif = queue or ext_info.get('queue')
                            insert_call_notification(extension=ext, caller_from=caller_val or None, queue=queue_for_notif or None, call_id=uniqueid or None, reason=self.map_cause_to_status(cause, None))
                            if self._call_notification_callback:
                                try:
                                    self._call_notification_callback(ext)
                                except Exception as e:
                                    log.debug("call_notification_callback error: %s", e)
        
        # Clean up any remaining channels in ch2ext that belong to this extension
        # (in case of multiple channels per extension)
        if ext:
            # Create list first to avoid modification during iteration
            channels_to_remove = [ch_name for ch_name, ext_name in list(self.ch2ext.items()) if ext_name == ext]
            for ch_name in channels_to_remove:
                self.ch2ext.pop(ch_name, None)
                self.ch_callerid.pop(ch_name, None)
                # Also clean up uniqueid mapping
                ch_uniqueid = self.ch2uniqueid.pop(ch_name, None)
                if ch_uniqueid and ch_uniqueid in self.queue_entries:
                    entry = self.queue_entries.pop(ch_uniqueid)
                    queue = entry.get('queue', '')
                    if queue in self.queues:
                        waiting_count = sum(1 for e in self.queue_entries.values() if e.get('queue') == queue)
                        self.queues[queue]['calls_waiting'] = waiting_count
        
        # Always clean up this channel's callerid mapping
        self.ch_callerid.pop(ch, None)
        
        # Also clean up any channels in destch2ext that point to this extension
        if ext:
            dest_channels_to_remove = [ch_name for ch_name, ext_name in list(self.destch2ext.items()) if ext_name == ext]
            for ch_name in dest_channels_to_remove:
                self.destch2ext.pop(ch_name, None)
        
        # Fallback: Clean up by checking active_calls channels directly
        # This catches cases where channel mapping might be lost
        if ch:
            for ext_name, info in list(self.active_calls.items()):
                if info.get('channel') == ch:
                    # This call's main channel hung up - remove the entry
                    self.active_calls.pop(ext_name, None)
                elif info.get('destchannel') == ch:
                    # This call's destination channel hung up - just clear destchannel reference
                    # Don't remove the entry - caller's own channel might still be active
                    info.pop('destchannel', None)

    def _ev_NewCallerid(self, p, ts):
        ch = p.get('Channel', '')
        callerid = p.get('CallerIDNum', '')
        exten = p.get('Exten', '')
        ext = self._resolve_ext(ch)
        
        if _meaningful(callerid):
            self.ch_callerid[ch] = callerid
        
        if ext:
            info = self._call_info(ext)
            if _meaningful(callerid):
                info['callerid'] = callerid
            if _meaningful(exten):
                info['exten'] = exten
                if 'original_destination' not in info:
                    info['original_destination'] = exten

    def _ev_Dial(self, p, ts):
        ch  = p.get('Channel','')
        ext = self._resolve_ext(ch)
        if ext:
            info = self._call_info(ext)
            info['destination'] = p.get('Destination','')
            info['dialstatus']  = p.get('DialStatus','')
            dialed = p.get('DialString', p.get('Dialstring','')) or p.get('DestExten','')
            if _meaningful(dialed):
                info.setdefault('original_destination', dialed)
                info['exten'] = dialed

    def _ev_DialBegin(self, p, ts):
        ch = p.get('Channel', '')
        ext = self._resolve_ext(ch)
        if not ext:
            return

        destexten = p.get('DestExten', '')
        dialstring = p.get('DialString', '')
        destch = p.get('DestChannel', '')

        # Always create/update the call info with channel
        info = self._call_info(ext)
        info['channel'] = ch  # Ensure channel is set!
        if 'state' not in info:
            info['state'] = 'Dialing'
        info['destchannel'] = destch
        self.ch2ext[ch] = ext
        
        # Track call start time (if not already set)
        if 'start_time' not in info:
            info['start_time'] = datetime.now()
            info['answer_time'] = None

        # Resolve the actual dialed number
        dialed = None
        if _meaningful(destexten):
            dialed = destexten
        elif dialstring:
            # Optimize: split once and check
            parts = dialstring.split('@', 1)
            candidate = parts[0].split('/', 1)[0].strip()
            if _meaningful(candidate):
                dialed = candidate

        if dialed:
            info['exten'] = dialed
            if 'original_destination' not in info:
                info['original_destination'] = dialed
            if dialed != ext:
                self._cross_ref(ext, dialed)
        
        # Also track the destination extension's channel (only for internal extensions)
        dest_ext = _ext_from_channel(destch) if destch else None
        if dest_ext and dest_ext not in DIALPLAN_CTX:
            dest_info = self._call_info(dest_ext)
            dest_info['channel'] = destch
            if 'state' not in dest_info:
                dest_info['state'] = 'Ringing'
            dest_info['caller'] = ext
            self.ch2ext[destch] = dest_ext
        
        # Track dest channel -> caller ext for ringing detection
        if destch:
            self.destch2ext[destch] = ext

    def _ev_DialEnd(self, p, ts):
        ch = p.get('Channel', '')
        ext = self._resolve_ext(ch)
        destexten = p.get('DestExten', '')
        destch = p.get('DestChannel', '')
        dialstatus = p.get('DialStatus', '')
        
        # Update caller's entry
        if ext:
            info = self.active_calls.get(ext)
            if info:
                # Only update dialstatus if:
                # 1. New status is ANSWER (always wins - call was connected)
                # 2. OR current status is not already ANSWER (don't let CANCEL overwrite ANSWER)
                # 3. OR no status is set yet
                current_status = info.get('dialstatus', '').upper()
                new_status = dialstatus.upper() if dialstatus else ''
                if new_status == 'ANSWER' or current_status != 'ANSWER':
                    info['dialstatus'] = dialstatus
                if _meaningful(destexten):
                    if 'original_destination' not in info:
                        info['original_destination'] = destexten
                    info['exten'] = destexten
        
        # Also update destination's entry if it exists
        dest_ext = _ext_from_channel(destch) if destch else None
        if not dest_ext and _meaningful(destexten) and destexten.isdigit() and len(destexten) <= 5:
            dest_ext = destexten
        
        if dest_ext:
            dest_info = self.active_calls.get(dest_ext)
            if dest_info:
                if destch:
                    dest_info['channel'] = destch
                    self.ch2ext[destch] = dest_ext
                if 'caller' not in dest_info and ext:
                    dest_info['caller'] = ext
                # For destination, also update dialstatus with same priority logic
                dest_current_status = dest_info.get('dialstatus', '').upper()
                new_status = dialstatus.upper() if dialstatus else ''
                if new_status == 'ANSWER' or dest_current_status != 'ANSWER':
                    dest_info['dialstatus'] = dialstatus

    def _ev_Bridge(self, p, ts):
        ch1, ch2 = p.get('Channel1',''), p.get('Channel2','')
        ext1, ext2 = self._resolve_ext(ch1), self._resolve_ext(ch2)
        
        # Get Linkedid from bridge event - channels being bridged should share the same Linkedid
        linkedid1 = p.get('Linkedid', '') or self.ch2linkedid.get(ch1, '')
        linkedid2 = p.get('Linkedid', '') or self.ch2linkedid.get(ch2, '')
        
        # Use the Linkedid from the event if available, otherwise use the first channel's Linkedid
        bridge_linkedid = p.get('Linkedid', '') or linkedid1 or linkedid2
        
        # If we have a Linkedid, ensure both channels are tracked with it
        if bridge_linkedid:
            # Update Linkedid tracking for both channels
            if ch1 and ch1 not in self.ch2linkedid:
                self.ch2linkedid[ch1] = bridge_linkedid
            elif ch1 and self.ch2linkedid.get(ch1) != bridge_linkedid:
                # Update existing Linkedid - move channel to new Linkedid group
                old_linkedid = self.ch2linkedid[ch1]
                if old_linkedid in self.linkedid2channels:
                    self.linkedid2channels[old_linkedid].discard(ch1)
                    if not self.linkedid2channels[old_linkedid]:
                        self.linkedid2channels.pop(old_linkedid, None)
                self.ch2linkedid[ch1] = bridge_linkedid
            
            if ch2 and ch2 not in self.ch2linkedid:
                self.ch2linkedid[ch2] = bridge_linkedid
            elif ch2 and self.ch2linkedid.get(ch2) != bridge_linkedid:
                # Update existing Linkedid - move channel to new Linkedid group
                old_linkedid = self.ch2linkedid[ch2]
                if old_linkedid in self.linkedid2channels:
                    self.linkedid2channels[old_linkedid].discard(ch2)
                    if not self.linkedid2channels[old_linkedid]:
                        self.linkedid2channels.pop(old_linkedid, None)
                self.ch2linkedid[ch2] = bridge_linkedid
            
            # Add both channels to the Linkedid group
            if bridge_linkedid not in self.linkedid2channels:
                self.linkedid2channels[bridge_linkedid] = set()
            self.linkedid2channels[bridge_linkedid].add(ch1)
            self.linkedid2channels[bridge_linkedid].add(ch2)
            
            log.debug(f"Bridge event: Linked channels {ch1} and {ch2} with Linkedid {bridge_linkedid}")

        # Gather callerids from all available sources
        def _cid(ch, ext):
            if ext and ext in self.active_calls:
                return self.active_calls[ext].get('callerid', self.ch_callerid.get(ch,''))
            return self.ch_callerid.get(ch,'')

        cid1, cid2 = _cid(ch1, ext1), _cid(ch2, ext2)

        # Get call info for both extensions
        info1 = self._call_info(ext1) if ext1 else None
        info2 = self._call_info(ext2) if ext2 else None

        if info1:
            info1['destination'] = cid2 if (cid2 and cid2 != ext1) else (ext2 or '')
            # If ext2 has queue info, copy it to ext1 (for agent receiving queue call)
            if info2 and 'queue' in info2 and 'queue' not in info1:
                info1['queue'] = info2['queue']
        
        if info2:
            info2['destination'] = cid1 if (cid1 and cid1 != ext2) else (ext1 or '')
            # If ext1 has queue info, copy it to ext2 (for agent receiving queue call)
            if info1 and 'queue' in info1 and 'queue' not in info2:
                info2['queue'] = info1['queue']

    def _ev_Newstate(self, p, ts):
        ch = p.get('Channel', '')
        ext = self._resolve_ext(ch)
        state = p.get('ChannelStateDesc') or p.get('ChannelState', '')
        
        # ALWAYS update state for any extension we're tracking
        if ext:
            info = self._call_info(ext)
            info['state'] = state
            
            # Track answer time when call goes to 'Up' state
            if state == 'Up' and 'answer_time' in info and info['answer_time'] is None:
                info['answer_time'] = datetime.now()
            # Also ensure start_time is set if not already
            if 'start_time' not in info:
                info['start_time'] = datetime.now()
                info['answer_time'] = None
        
        # Check if this is a destination channel (e.g., sbc or local ext) and get the caller ext
        caller_ext = self.destch2ext.get(ch)
        
        # Update caller's dest_state for outbound calls (so we can show proper state)
        if caller_ext:
            caller_info = self.active_calls.get(caller_ext)
            if caller_info:
                caller_info['dest_state'] = state
        
        if caller_ext and caller_ext in self.monitored:
            # Outgoing call perspective (caller sees destination ringing/answered)
            info = self.active_calls.get(caller_ext)
            if info:
                num = self._display_number(info, caller_ext)
                if num != 'Unknown':
                    ch_type = self._get_channel_type(ch) or caller_ext
                    if state == 'Ringing':
                        log.info("[%s] 🔔 %s: Ringing %s (channel %s)", ts, caller_ext, num, ch_type)
                    elif state == 'Up':
                        log.info("[%s] 📞 %s: In call with %s (channel %s)", ts, caller_ext, num, ch_type)
        
        # Incoming call perspective (callee receives call) OR application/feature code call
        if ext and ext in self.monitored:
            info = self.active_calls.get(ext)
            if info:
                # Get caller info from callerid or caller field
                caller = info.get('caller') or info.get('callerid') or self.ch_callerid.get(ch, '')
                # Get dialed exten for feature codes (e.g., *43)
                dialed_exten = info.get('exten', '')
                
                if state == 'Ringing' and _meaningful(caller) and caller != ext:
                    ch_type = self._get_channel_type(ch) or ext
                    log.info("[%s] 📳 %s: Incoming from %s (channel %s)", ts, ext, caller, ch_type)
                elif state == 'Up':
                    # Check if this is an application/feature code call (no destination channel)
                    has_dest_channel = bool(info.get('destchannel'))
                    if _meaningful(dialed_exten) and dialed_exten != ext and not has_dest_channel:
                        # Feature code / application call (e.g., *43 echo test)
                        log.info("[%s] 📞 %s: In call with %s (channel App)", ts, ext, dialed_exten)
                    elif _meaningful(caller) and caller != ext:
                        # Incoming call answered
                        if ch not in self.destch2ext:
                            ch_type = self._get_channel_type(ch) or ext
                            log.info("[%s] 📞 %s: In call with %s (channel %s)", ts, ext, caller, ch_type)

    def _ev_VarSet(self, p, ts):
        ch, var, val = p.get('Channel',''), p.get('Variable',''), p.get('Value','')
        if var.upper() not in DIALED_VARS:
            return
        ext = self._resolve_ext(ch)
        if ext and val and val != ext and _meaningful(val):
            info = self._call_info(ext)
            if not info.get('original_destination'):
                info['original_destination'] = val
                info['exten'] = val

    # ------------------------------------------------------------------
    # Queue event handlers
    # ------------------------------------------------------------------
    def _ev_QueueMemberStatus(self, p, ts):
        """Handle QueueMemberStatus event - member status change."""
        queue = p.get('Queue', '')
        member = p.get('Interface', '')
        membername = p.get('MemberName', member)
        status_code = p.get('Status', '')
        status = _queue_member_status(status_code)
        paused = p.get('Paused', '0') == '1'
        
        if queue and member:
            member_key = f"{queue}:{member}"
            # Preserve dynamic flag if it exists
            is_dynamic = member_key in self.dynamic_members
            self.queue_members[member_key] = {
                'queue': queue,
                'interface': member,
                'membername': membername,
                'status': status,
                'paused': paused,
                'dynamic': is_dynamic,
                'last_update': datetime.now()
            }
            
            # Update queue info
            if queue not in self.queues:
                self.queues[queue] = {'members': {}, 'calls_waiting': 0}
            self.queues[queue]['members'][member] = {
                'status': status,
                'paused': paused,
                'membername': membername,
                'dynamic': is_dynamic
            }

    def _ev_QueueMemberAdded(self, p, ts):
        """Handle QueueMemberAdded event."""
        queue = p.get('Queue', '')
        member = p.get('Interface', '')
        membername = p.get('MemberName', member)
        paused = p.get('Paused', '0') == '1'
        
        if queue and member:
            member_key = f"{queue}:{member}"
            # Mark as dynamic - this event is only fired when members are added via AMI
            self.dynamic_members.add(member_key)
            self.queue_members[member_key] = {
                'queue': queue,
                'interface': member,
                'membername': membername,
                'status': 'Not in use',
                'paused': paused,
                'dynamic': True,  # Mark as dynamically added
                'last_update': datetime.now()
            }
            
            if queue not in self.queues:
                self.queues[queue] = {'members': {}, 'calls_waiting': 0}
            self.queues[queue]['members'][member] = {
                'status': 'Not in use',
                'paused': paused,
                'membername': membername,
                'dynamic': True
            }
            
            if queue in self.monitored or member in self.monitored:
                log.info("[%s] ➕ Queue %s: Member %s (%s) added", ts, queue, membername, member)

    def _ev_QueueMemberRemoved(self, p, ts):
        """Handle QueueMemberRemoved event."""
        queue = p.get('Queue', '')
        member = p.get('Interface', '')
        
        if queue and member:
            member_key = f"{queue}:{member}"
            self.queue_members.pop(member_key, None)
            self.dynamic_members.discard(member_key)  # Remove from dynamic set
            
            if queue in self.queues and member in self.queues[queue].get('members', {}):
                del self.queues[queue]['members'][member]
            
            if queue in self.monitored or member in self.monitored:
                log.info("[%s] ➖ Queue %s: Member %s removed", ts, queue, member)

    def _ev_QueueMemberPaused(self, p, ts):
        """Handle QueueMemberPaused event."""
        queue = p.get('Queue', '')
        member = p.get('Interface', '')
        paused = p.get('Paused', '0') == '1'
        reason = p.get('Reason', '')
        
        if queue and member:
            member_key = f"{queue}:{member}"
            if member_key in self.queue_members:
                self.queue_members[member_key]['paused'] = paused
                if reason:
                    self.queue_members[member_key]['pause_reason'] = reason
            
            if queue in self.queues and member in self.queues[queue].get('members', {}):
                self.queues[queue]['members'][member]['paused'] = paused
            
            if queue in self.monitored or member in self.monitored:
                status = "paused" if paused else "unpaused"
                log.info("[%s] ⏸️  Queue %s: Member %s %s%s", ts, queue, member, status, f" ({reason})" if reason else "")

    def _ev_QueueMemberUnpause(self, p, ts):
        """Handle QueueMemberUnpause event (same as unpaused in QueueMemberPaused)."""
        self._ev_QueueMemberPaused(p, ts)

    def _ev_QueueEntry(self, p, ts):
        """Handle QueueEntry event - caller enters queue."""
        queue = p.get('Queue', '')
        uniqueid = p.get('Uniqueid', '')
        callerid = p.get('CallerIDNum', p.get('CallerID', 'Unknown'))
        position = p.get('Position', '0')
        channel = p.get('Channel', '')
        linkedid = p.get('Linkedid', '')
        
        if queue and uniqueid:
            self.queue_entries[uniqueid] = {
                'queue': queue,
                'callerid': callerid,
                'position': int(position) if position.isdigit() else 0,
                'entry_time': datetime.now()
            }
            
            # Track uniqueid for this channel if available
            if channel and uniqueid:
                self.ch2uniqueid[channel] = uniqueid
            
            # Store queue in call_info for the caller's channel so we can retrieve it later
            # Also mark as queue_waiting - CRM should not be sent until caller hangs up OR agent answers
            if channel:
                caller_ext = self.ch2ext.get(channel)
                if caller_ext:
                    call_info = self.active_calls.get(caller_ext)
                    if call_info:
                        call_info['queue'] = queue
                        call_info['queue_waiting'] = True  # Don't send CRM until caller hangup or agent answer
                        call_info['queue_caller_channel'] = channel  # Track the caller's channel
                        log.debug(f"📥 Queue call {queue}: Marked caller {caller_ext} as queue_waiting=True")
            
            # Also create/update call_info for the external caller (callerid) if it's meaningful
            # This ensures we have proper tracking for external callers entering the queue
            if _meaningful(callerid) and callerid != 'Unknown':
                caller_info = self._call_info(callerid)
                caller_info['queue'] = queue
                caller_info['queue_waiting'] = True  # Don't send CRM until caller hangup or agent answer
                caller_info['queue_caller_channel'] = channel
                caller_info['callerid'] = callerid
                if 'start_time' not in caller_info:
                    caller_info['start_time'] = datetime.now()
                if linkedid:
                    caller_info['linkedid'] = linkedid
                log.debug(f"📥 Queue call {queue}: Created/updated call_info for external caller {callerid}, queue_waiting=True")
            
            if queue not in self.queues:
                self.queues[queue] = {'members': {}, 'calls_waiting': 0}
            # Recalculate waiting calls
            waiting_count = sum(1 for e in self.queue_entries.values() if e.get('queue') == queue)
            self.queues[queue]['calls_waiting'] = waiting_count
            
            if queue in self.monitored:
                log.info("[%s] 📥 Queue %s: Caller %s entered (position %s)", ts, queue, callerid, position)

    def _ev_QueueCallerJoin(self, p, ts):
        """Handle QueueCallerJoin event."""
        queue = p.get('Queue', '')
        uniqueid = p.get('Uniqueid', '')
        callerid = p.get('CallerIDNum', p.get('CallerID', 'Unknown'))
        position = p.get('Position', '0')
        channel = p.get('Channel', '')
        linkedid = p.get('Linkedid', '')
        
        if queue and uniqueid:
            self.queue_entries[uniqueid] = {
                'queue': queue,
                'callerid': callerid,
                'position': int(position) if position.isdigit() else 0,
                'entry_time': datetime.now()
            }
            
            # Track uniqueid for this channel if available
            if channel and uniqueid:
                self.ch2uniqueid[channel] = uniqueid
            
            # Store queue in call_info for the caller's channel so we can retrieve it later
            # Also mark as queue_waiting - CRM should not be sent until caller hangs up OR agent answers
            if channel:
                caller_ext = self.ch2ext.get(channel)
                if caller_ext:
                    call_info = self.active_calls.get(caller_ext)
                    if call_info:
                        call_info['queue'] = queue
                        call_info['queue_waiting'] = True  # Don't send CRM until caller hangup or agent answer
                        call_info['queue_caller_channel'] = channel  # Track the caller's channel
                        log.debug(f"📥 Queue call {queue}: Marked caller {caller_ext} as queue_waiting=True")
            
            # Also create/update call_info for the external caller (callerid) if it's meaningful
            # This ensures we have proper tracking for external callers entering the queue
            if _meaningful(callerid) and callerid != 'Unknown':
                caller_info = self._call_info(callerid)
                caller_info['queue'] = queue
                caller_info['queue_waiting'] = True  # Don't send CRM until caller hangup or agent answer
                caller_info['queue_caller_channel'] = channel
                caller_info['callerid'] = callerid
                caller_info['start_time'] = datetime.now()
                if linkedid:
                    caller_info['linkedid'] = linkedid
                log.debug(f"📥 Queue call {queue}: Created/updated call_info for external caller {callerid}, queue_waiting=True")
            
            if queue not in self.queues:
                self.queues[queue] = {'members': {}, 'calls_waiting': 0}
            # Count waiting calls
            waiting_count = sum(1 for e in self.queue_entries.values() if e.get('queue') == queue)
            self.queues[queue]['calls_waiting'] = waiting_count
            
            if queue in self.monitored:
                log.info("[%s] 📥 Queue %s: Caller %s joined (position %s)", ts, queue, callerid, position)

    def _ev_QueueCallerLeave(self, p, ts):
        """Handle QueueCallerLeave event."""
        queue = p.get('Queue', '')
        uniqueid = p.get('Uniqueid', '')
        callerid = p.get('CallerIDNum', p.get('CallerID', 'Unknown'))
        
        if uniqueid in self.queue_entries:
            entry = self.queue_entries.pop(uniqueid)
            queue = entry.get('queue', queue)
            
            if queue in self.queues:
                # Recalculate waiting calls
                waiting_count = sum(1 for e in self.queue_entries.values() if e.get('queue') == queue)
                self.queues[queue]['calls_waiting'] = waiting_count
            
            if queue in self.monitored:
                log.info("[%s] 📤 Queue %s: Caller %s left", ts, queue, callerid)

    def _ev_AgentCalled(self, p, ts):
        """Handle AgentCalled event - agent starts ringing for a queue call."""
        queue = p.get('Queue', '')
        agent_channel = p.get('DestChannel', p.get('AgentChannel', ''))
        agent_member = p.get('Interface', '')
        callerid = p.get('CallerIDNum', p.get('CallerID', ''))
        channel = p.get('Channel', '')  # Caller's channel
        uniqueid = p.get('Uniqueid', '')
        linkedid = p.get('Linkedid', '')
        
        # Get agent extension from member interface or channel
        agent_ext = None
        if agent_member and '/' in agent_member:
            # Interface like PJSIP/1001 or SIP/1001
            agent_ext = agent_member.split('/')[-1]
        if not agent_ext and agent_channel:
            agent_ext = _ext_from_channel(agent_channel)
        
        if agent_ext:
            agent_info = self._call_info(agent_ext)
            # Store the external caller for this queue call
            if _meaningful(callerid):
                agent_info['caller'] = callerid
                agent_info['queue_caller'] = callerid
            if queue:
                agent_info['queue'] = queue
            if linkedid:
                agent_info['linkedid'] = linkedid
            
            # Propagate queue_waiting from caller's call_info to agent's call_info
            # This ensures we can check queue_waiting when agent's channel hangs up
            if _meaningful(callerid):
                caller_info = self.active_calls.get(callerid)
                if caller_info:
                    agent_info['queue_waiting'] = caller_info.get('queue_waiting', False)
                    agent_info['queue_caller_channel'] = caller_info.get('queue_caller_channel', '')
            
            log.debug(f"🔔 AgentCalled: Queue {queue}, Agent {agent_ext}, Caller {callerid}, queue_waiting={agent_info.get('queue_waiting', False)}")

    def _ev_AgentConnect(self, p, ts):
        """Handle AgentConnect event - agent answered a queue call."""
        queue = p.get('Queue', '')
        agent_channel = p.get('MemberChannel', p.get('Channel', ''))
        agent_member = p.get('Interface', p.get('Member', ''))
        callerid = p.get('CallerIDNum', p.get('CallerID', ''))
        uniqueid = p.get('Uniqueid', '')
        linkedid = p.get('Linkedid', '')
        caller_channel = p.get('Channel', '')  # The caller's channel
        
        # Get agent extension
        agent_ext = None
        if agent_member and '/' in agent_member:
            agent_ext = agent_member.split('/')[-1]
        if not agent_ext and agent_channel:
            agent_ext = _ext_from_channel(agent_channel)
        
        if agent_ext:
            agent_info = self.active_calls.get(agent_ext)
            if agent_info:
                # Mark call as answered
                agent_info['dialstatus'] = 'ANSWER'
                agent_info['queue_answered'] = True
                agent_info['queue_waiting'] = False  # Agent answered - no longer waiting in queue
                agent_info['answered_agent'] = agent_ext  # Store which agent answered
                if _meaningful(callerid):
                    agent_info['caller'] = callerid
                    agent_info['queue_caller'] = callerid
                if queue:
                    agent_info['queue'] = queue
                if linkedid:
                    agent_info['linkedid'] = linkedid
                # Set answer time if not already set
                if agent_info.get('answer_time') is None:
                    agent_info['answer_time'] = datetime.now()
            
            log.info(f"[{ts}] ✅ Queue {queue}: Agent {agent_ext} connected to caller {callerid}")
        
        # Also update the external caller's call_info
        # This is important because _send_crm_data may use the caller's info
        # Create caller_info if it doesn't exist (external callers might be stored under channel name)
        if _meaningful(callerid):
            caller_info = self.active_calls.get(callerid)
            if not caller_info:
                # Create call_info for external caller - this ensures CRM has the right info
                caller_info = self._call_info(callerid)
                caller_info['callerid'] = callerid
                log.debug(f"Created call_info for external caller {callerid}")
            
            caller_info['dialstatus'] = 'ANSWER'
            caller_info['queue_answered'] = True
            caller_info['queue_waiting'] = False  # Agent answered - no longer waiting in queue
            caller_info['answered_agent'] = agent_ext  # Store which agent answered
            caller_info['destination'] = agent_ext  # The actual destination is the agent
            if queue:
                caller_info['queue'] = queue
            if linkedid:
                caller_info['linkedid'] = linkedid
            log.info(f"✅ Queue call answered: caller {callerid}, agent {agent_ext}, queue_waiting=False")
        
        # Also update based on linkedid - find all channels with same linkedid and update caller info
        if linkedid:
            for ext, info in self.active_calls.items():
                if info.get('linkedid') == linkedid or (ext.isdigit() and 3 <= len(ext) <= 5):
                    ch = info.get('channel', '')
                    ch_linkedid = self.ch2linkedid.get(ch, '')
                    if ch_linkedid == linkedid:
                        # This extension is part of the same call
                        if _meaningful(callerid):
                            info['caller'] = callerid
                            info['queue_caller'] = callerid
                        if queue:
                            info['queue'] = queue
                        info['dialstatus'] = 'ANSWER'
                        info['queue_answered'] = True
                        info['queue_waiting'] = False  # Agent answered - no longer waiting in queue
                        info['answered_agent'] = agent_ext

    def _ev_AgentComplete(self, p, ts):
        """Handle AgentComplete event - queue call completed."""
        queue = p.get('Queue', '')
        agent_member = p.get('Interface', p.get('Member', ''))
        callerid = p.get('CallerIDNum', p.get('CallerID', ''))
        talktime = p.get('TalkTime', '0')
        reason = p.get('Reason', '')  # agent, caller, transfer
        
        agent_ext = None
        if agent_member and '/' in agent_member:
            agent_ext = agent_member.split('/')[-1]
        
        if queue in self.monitored or (agent_ext and agent_ext in self.monitored):
            log.info(f"[{ts}] 📞 Queue {queue}: Agent {agent_ext} completed call with {callerid} (talk: {talktime}s, reason: {reason})")

    # ------------------------------------------------------------------
    # Queue management methods
    # ------------------------------------------------------------------
    async def get_queue_status(self, queue: str) -> Optional[Dict]:
        """Get detailed status of a queue."""
        resp = await self._send_action_with_events('QueueStatus', {'Queue': queue}, 'QueueStatusComplete')
        if resp and 'Response: Success' in resp:
            return _parse(resp)
        return None

    async def get_queue_summary(self) -> Dict[str, Dict]:
        """Get summary of all queues."""
        # Use _send_action_with_events to read all events until QueueSummaryComplete
        resp = await self._send_action_with_events('QueueSummary', complete_event='QueueSummaryComplete')
        
        if not resp:
            log.warning("QueueSummary: No response from AMI")
            return {}
        
        if 'Response: Success' not in resp:
            log.warning(f"QueueSummary: AMI returned error")
            return {}
        
        queues_summary = {}
        lines = resp.split('\r\n')
        current_queue = None
        
        for line in lines:
            if ':' not in line:
                continue
            k, v = line.split(':', 1)
            k, v = k.strip(), v.strip()
            
            if k == 'Queue':
                current_queue = v
                if current_queue not in queues_summary:
                    queues_summary[current_queue] = {}
            elif current_queue and k in ('Available', 'LoggedIn', 'Callers', 'HoldTime', 'TalkTime', 'LongestHoldTime'):
                queues_summary[current_queue][k] = v
        
        return queues_summary

    async def list_queues(self, queue: str = None) -> Dict[str, Dict]:
        """List queues with their status. If queue is None, list all queues."""
        summary = await self.get_queue_summary()
        
        # Filter to specific queue if requested
        if queue:
            if queue in summary:
                summary = {queue: summary[queue]}
            else:
                log.info(f"\nQueue '{queue}' not found")
                log.info("-" * 80)
                return {}
        
        log.info(f"\n{'Queue':<20} {'Members':<12} {'Available':<12} {'Calls Waiting':<15} {'Longest Hold':<15}")
        log.info("-" * 80)
        
        if not summary:
            log.info("  No queues found")
        else:
            for queue_name, info in sorted(summary.items()):
                members = info.get('LoggedIn', '0')
                available = info.get('Available', '0')
                callers = info.get('Callers', '0')
                longest_hold = info.get('LongestHoldTime', '0')
                log.info(f"{queue_name:<20} {members:<12} {available:<12} {callers:<15} {longest_hold:<15}")
        
        log.info("-" * 80)
        return summary

    async def list_queue_members(self, queue: str = None) -> Dict[str, Dict]:
        """List queue members. If queue is None, list all members."""
        if not queue:
            # List all queue members
            log.info(f"\n{'Queue':<20} {'Member':<30} {'Status':<15} {'Paused':<10} {'Member Name':<20}")
            log.info("-" * 100)
            
            if not self.queue_members:
                log.info("  No queue members found")
            else:
                for member_key, info in sorted(self.queue_members.items()):
                    queue_name = info.get('queue', '')
                    interface = info.get('interface', '')
                    status = info.get('status', 'Unknown')
                    paused = 'Yes' if info.get('paused', False) else 'No'
                    membername = info.get('membername', interface)
                    log.info(f"{queue_name:<20} {interface:<30} {status:<15} {paused:<10} {membername:<20}")
        else:
            # List members of specific queue
            log.info(f"\nQueue: {queue}")
            log.info(f"{'Member':<30} {'Status':<15} {'Paused':<10} {'Member Name':<20}")
            log.info("-" * 80)
            
            found = False
            for member_key, info in sorted(self.queue_members.items()):
                if info.get('queue') == queue:
                    found = True
                    interface = info.get('interface', '')
                    status = info.get('status', 'Unknown')
                    paused = 'Yes' if info.get('paused', False) else 'No'
                    membername = info.get('membername', interface)
                    log.info(f"{interface:<30} {status:<15} {paused:<10} {membername:<20}")
            
            if not found:
                log.info("  No members found in this queue")
        
        log.info("-" * 100)
        return self.queue_members.copy()

    async def queue_add(self, queue: str, interface: str, penalty: int = 0, membername: str = None, paused: bool = False) -> tuple[bool, str]:
        """Add a member to a queue. Returns (success, message)."""
        params = {
            'Queue': queue,
            'Interface': interface
        }
        if penalty > 0:
            params['Penalty'] = str(penalty)
        if membername:
            params['MemberName'] = membername
        if paused:
            params['Paused'] = '1'
        
        resp = await self._send_async('QueueAdd', params)
        if resp and 'Response: Success' in resp:
            # Mark as dynamic member (can be removed)
            member_key = f"{queue}:{interface}"
            self.dynamic_members.add(member_key)
            
            # Optimistically update state immediately (AMI event will confirm later)
            self.queue_members[member_key] = {
                'queue': queue,
                'interface': interface,
                'membername': membername or interface,
                'status': 'Not in use',
                'paused': paused,
                'dynamic': True,
                'last_update': datetime.now()
            }
            
            # Update queue info
            if queue not in self.queues:
                self.queues[queue] = {'members': {}, 'calls_waiting': 0}
            self.queues[queue]['members'][interface] = {
                'status': 'Not in use',
                'paused': paused,
                'membername': membername or interface,
                'dynamic': True
            }
            
            msg = f"Added {interface} to queue {queue}"
            log.info(f"✅ {msg}")
            return True, msg
        err = _parse(resp or '').get('Message', 'Unknown error')
        log.error(f"❌ Failed to add {interface} to {queue}: {err}")
        return False, err

    async def queue_remove(self, queue: str, interface: str) -> tuple[bool, str]:
        """Remove a member from a queue. Returns (success, message)."""
        member_key = f"{queue}:{interface}"
        
        # Check if member exists
        if member_key not in self.queue_members:
            msg = f"Member {interface} not found in queue {queue}"
            log.error(f"❌ {msg}")
            return False, msg
        
        # Try to remove - let Asterisk tell us if it's static or dynamic
        resp = await self._send_async('QueueRemove', {
            'Queue': queue,
            'Interface': interface
        })
        if resp and 'Response: Success' in resp:
            # Success - remove from state immediately
            self.queue_members.pop(member_key, None)
            self.dynamic_members.discard(member_key)
            
            if queue in self.queues and interface in self.queues[queue].get('members', {}):
                del self.queues[queue]['members'][interface]
            
            msg = f"Removed {interface} from queue {queue}"
            log.info(f"✅ {msg}")
            return True, msg
        
        # Failed - check error and mark as static if needed
        err = _parse(resp or '').get('Message', 'Unknown error')
        
        # If Asterisk says "not dynamic", mark member as static in our state
        if 'not dynamic' in err.lower() or 'member not dynamic' in err.lower():
            # Mark as static so UI can disable remove button
            if member_key in self.queue_members:
                self.queue_members[member_key]['dynamic'] = False
            if queue in self.queues and interface in self.queues[queue].get('members', {}):
                self.queues[queue]['members'][interface]['dynamic'] = False
            
            err = f"Member is statically configured in queues.conf and cannot be removed via AMI. Edit queues.conf and reload Asterisk to remove static members."
        
        log.error(f"❌ Failed to remove {interface} from {queue}: {err}")
        return False, err

    async def queue_pause(self, queue: str, interface: str, paused: bool = True, reason: str = '') -> tuple[bool, str]:
        """Pause or unpause a queue member. Returns (success, message)."""
        member_key = f"{queue}:{interface}"
        
        params = {
            'Queue': queue,
            'Interface': interface,
            'Paused': '1' if paused else '0'
        }
        if reason:
            params['Reason'] = reason
        
        resp = await self._send_async('QueuePause', params)
        if resp and 'Response: Success' in resp:
            # Optimistically update state immediately (AMI event will confirm later)
            if member_key in self.queue_members:
                self.queue_members[member_key]['paused'] = paused
                if reason:
                    self.queue_members[member_key]['pause_reason'] = reason
                elif 'pause_reason' in self.queue_members[member_key] and not paused:
                    # Remove reason when unpausing
                    self.queue_members[member_key].pop('pause_reason', None)
            
            if queue in self.queues and interface in self.queues[queue].get('members', {}):
                self.queues[queue]['members'][interface]['paused'] = paused
            
            action = "paused" if paused else "unpaused"
            msg = f"{interface} {action} in queue {queue}"
            log.info(f"✅ {msg}")
            return True, msg
        err = _parse(resp or '').get('Message', 'Unknown error')
        action = "pause" if paused else "unpause"
        log.error(f"❌ Failed to {action} {interface} in {queue}: {err}")
        return False, err

    async def queue_unpause(self, queue: str, interface: str) -> tuple[bool, str]:
        """Unpause a queue member. Returns (success, message)."""
        return await self.queue_pause(queue, interface, paused=False)

    async def sync_queue_status(self):
        """Sync queue status by querying AMI - populates self.queues, self.queue_members, and self.queue_entries."""
        # Get queue summary first
        summary = await self.get_queue_summary()
        
        # Clear old queue entries before syncing to avoid stale entries
        # We'll repopulate from the sync, so clear everything first
        old_entries = self.queue_entries.copy()
        self.queue_entries.clear()
        
        # Update queue waiting counts for queues that had entries
        for queue_name in set(e.get('queue', '') for e in old_entries.values() if e.get('queue')):
            if queue_name in self.queues:
                self.queues[queue_name]['calls_waiting'] = 0
        
        # Initialize queues from summary
        for queue_name, queue_stats in summary.items():
            self.queues[queue_name] = {
                'members': {},
                'calls_waiting': int(queue_stats.get('Callers', '0')),
                'available': int(queue_stats.get('Available', '0')),
                'logged_in': int(queue_stats.get('LoggedIn', '0')),
                'hold_time': queue_stats.get('HoldTime', '0'),
                'talk_time': queue_stats.get('TalkTime', '0'),
            }
        
        # Get detailed queue status with members and entries for each queue
        for queue_name in summary.keys():
            resp = await self._send_action_with_events('QueueStatus', {'Queue': queue_name}, 'QueueStatusComplete')
            if resp and 'Response: Success' in resp:
                lines = resp.split('\r\n')
                current_item = {}
                current_event = None
                
                for line in lines:
                    if ':' not in line:
                        continue
                    k, v = line.split(':', 1)
                    k, v = k.strip(), v.strip()
                    
                    if k == 'Event':
                        # Save previous item if complete
                        if current_event == 'QueueMember' and 'queue' in current_item and 'interface' in current_item:
                            self._add_queue_member(current_item)
                        elif current_event == 'QueueEntry' and 'queue' in current_item and 'uniqueid' in current_item:
                            self._add_queue_entry(current_item)
                        
                        current_event = v
                        current_item = {}
                        
                        if v == 'QueueStatusComplete':
                            break
                        continue
                    
                    # Collect fields for current event
                    if current_event == 'QueueMember':
                        if k == 'Queue':
                            current_item['queue'] = v
                        elif k == 'Name':
                            current_item['membername'] = v
                        elif k == 'Location':
                            current_item['interface'] = v
                        elif k == 'Status':
                            current_item['status'] = v
                        elif k == 'Paused':
                            current_item['paused'] = v == '1'
                        elif k == 'Membership':
                            # Membership: 'static', 'dynamic', or 'realtime'
                            # Only 'dynamic' members can be removed via AMI
                            current_item['membership'] = v.lower()
                        # Log unknown fields for debugging (first time only)
                        elif k not in ['Event'] and k.lower() not in current_item:
                            # Only log if we haven't seen this field before for this member
                            log.debug(f"QueueMember field: {k} = {v}")
                    
                    elif current_event == 'QueueEntry':
                        if k == 'Queue':
                            current_item['queue'] = v
                        elif k == 'Position':
                            current_item['position'] = int(v) if v.isdigit() else 0
                        elif k == 'CallerIDNum':
                            current_item['callerid'] = v
                        elif k == 'Uniqueid':
                            current_item['uniqueid'] = v
                        elif k == 'Wait':
                            current_item['wait'] = int(v) if v.isdigit() else 0
                
                # Handle last item
                if current_event == 'QueueMember' and 'queue' in current_item and 'interface' in current_item:
                    self._add_queue_member(current_item)
                elif current_event == 'QueueEntry' and 'queue' in current_item and 'uniqueid' in current_item:
                    self._add_queue_entry(current_item)
        
        log.info(f"Synced {len(self.queues)} queues, {len(self.queue_members)} members, {len(self.queue_entries)} waiting callers")
    
    def _add_queue_member(self, item: dict):
        """Helper to add a queue member from sync data."""
        q_name = item['queue']
        interface = item['interface']
        membername = item.get('membername', interface)
        status_raw = item.get('status', 'Unknown')
        # Convert numeric status code to human-readable string
        status = _queue_member_status(status_raw) if str(status_raw).isdigit() else status_raw
        paused = item.get('paused', False)
        
        # Determine if member is dynamic based on Membership field from Asterisk
        membership = item.get('membership', '').lower()
        member_key = f"{q_name}:{interface}"
        
        if membership == 'dynamic':
            # Explicitly dynamic member from Asterisk
            is_dynamic = True
            self.dynamic_members.add(member_key)  # Track it
        elif membership == 'static' or membership == 'realtime':
            # Explicitly static or realtime member
            is_dynamic = False
            self.dynamic_members.discard(member_key)  # Remove if was tracked
        else:
            # No membership info - preserve existing dynamic flag if exists, otherwise assume static
            is_dynamic = member_key in self.dynamic_members
        
        self.queue_members[member_key] = {
            'queue': q_name,
            'interface': interface,
            'membername': membername,
            'status': status,
            'paused': paused,
            'dynamic': is_dynamic,
            'last_update': datetime.now()
        }
        
        # Also add to queues[queue_name]['members']
        if q_name in self.queues:
            self.queues[q_name]['members'][interface] = {
                'membername': membername,
                'status': status,
                'paused': paused,
                'dynamic': is_dynamic
            }
    
    def _add_queue_entry(self, item: dict):
        """Helper to add a queue entry (waiting caller) from sync data."""
        q_name = item['queue']
        uniqueid = item['uniqueid']
        
        # Calculate entry_time from wait seconds (if provided)
        wait_seconds = item.get('wait', 0)
        entry_time = datetime.now() - timedelta(seconds=wait_seconds) if wait_seconds else datetime.now()
        
        self.queue_entries[uniqueid] = {
            'queue': q_name,
            'callerid': item.get('callerid', 'Unknown'),
            'position': item.get('position', 0),
            'entry_time': entry_time
        }
        
        # Update queue calls_waiting count
        if q_name in self.queues:
            waiting_count = sum(1 for e in self.queue_entries.values() if e.get('queue') == q_name)
            self.queues[q_name]['calls_waiting'] = waiting_count

    async def list_queue_entries(self, queue: str = None) -> Dict[str, Dict]:
        """List callers waiting in queues. If queue is None, list all queue entries."""
        if not queue:
            log.info(f"\n{'Queue':<20} {'Caller ID':<20} {'Position':<12} {'Wait Time':<15}")
            log.info("-" * 70)
            
            if not self.queue_entries:
                log.info("  No callers waiting in queues")
            else:
                for uniqueid, entry in sorted(self.queue_entries.items(), key=lambda x: (x[1].get('queue', ''), x[1].get('position', 0))):
                    queue_name = entry.get('queue', '')
                    callerid = entry.get('callerid', 'Unknown')
                    position = entry.get('position', 0)
                    entry_time = entry.get('entry_time')
                    wait_time = "---"
                    if entry_time:
                        wait_duration = datetime.now() - entry_time
                        wait_time = _format_duration(wait_duration)
                    log.info(f"{queue_name:<20} {callerid:<20} {position:<12} {wait_time:<15}")
        else:
            # List entries for specific queue
            log.info(f"\nQueue: {queue}")
            log.info(f"{'Caller ID':<20} {'Position':<12} {'Wait Time':<15}")
            log.info("-" * 50)
            
            found = False
            for uniqueid, entry in sorted(self.queue_entries.items(), key=lambda x: x[1].get('position', 0)):
                if entry.get('queue') == queue:
                    found = True
                    callerid = entry.get('callerid', 'Unknown')
                    position = entry.get('position', 0)
                    entry_time = entry.get('entry_time')
                    wait_time = "---"
                    if entry_time:
                        wait_duration = datetime.now() - entry_time
                        wait_time = _format_duration(wait_duration)
                    log.info(f"{callerid:<20} {position:<12} {wait_time:<15}")
            
            if not found:
                log.info("  No callers waiting in this queue")
        
        log.info("-" * 70)
        return self.queue_entries.copy()

    # ------------------------------------------------------------------
    # Monitor entry-points
    # ------------------------------------------------------------------
    async def monitor_extensions(self, extensions: list):
        """Async monitor extensions with event-driven updates."""
        if not self.connected:
            return
        self.monitored = set(str(e) for e in extensions)

        log.info(f"\n{'Extension':<15} {'Status':<30}")
        log.info("-" * 50)
        for ext in extensions:
            status = await self.get_extension_status(ext)
            code   = status.get('Status','-1') if status else '-1'
            log.info(f"{ext:<15} {self._status_desc(code, ext):<30}")
        log.info("-" * 50)
        log.info("\n🔴 Listening for real-time events... (Ctrl+C to stop)\n")

        await self._send_async('Events', {'EventMask': 'on'})
        self.running = True
        
        # Start event reading task
        self._event_task = asyncio.create_task(self._read_events_async())
        
        try:
            # Keep running until interrupted
            while self.running:
                try:
                    await asyncio.sleep(0.5)
                except asyncio.CancelledError:
                    self.running = False
                    break
        except KeyboardInterrupt:
            self.running = False
        except asyncio.CancelledError:
            self.running = False

    # ------------------------------------------------------------------
    # Call control: transfer / hangup / music on hold
    # ------------------------------------------------------------------
    async def hangup_call(self, ext: str) -> bool:
        """Hang up the current call on the given extension."""
        if not self.connected:
            log.error("❌ Not connected to AMI")
            return False

        await self.sync_active_calls()
        ch = await self.get_active_channel(ext)
        if not ch:
            log.error(f"❌ No active call on extension {ext}")
            return False

        resp = await self._send_async('Hangup', {'Channel': ch})
        if resp and 'Response: Success' in resp:
            log.info(f"📴 Hangup requested for extension {ext} (channel {ch})")
            return True

        err = _parse(resp or '').get('Message', 'Unknown error')
        log.error(f"❌ Hangup failed for {ext}: {err}")
        return False

    def _channel_for_transfer_source(self, source: str) -> Optional[str]:
        """
        Resolve the Asterisk channel to use for Redirect when the supervisor selects
        a transfer source. Source can be:
        - An extension (e.g. 1001): use that extension's active channel.
        - The "talking to" number (e.g. phone number): use the other leg's channel
          in the same bridge (via linkedid2channels from Bridge events).
        """
        source = (source or "").strip()
        if not source:
            return None
        # 1) Direct: source is an extension we have in active_calls
        ch = self.active_calls.get(source, {}).get("channel")
        if ch:
            return ch
        ch = self.get_active_channel_sync(source)
        if ch:
            return ch
        # 2) Other leg: find a call where the "other party" is source, then get bridge peer channel
        def _num_match(a: str, b: str) -> bool:
            if a == b:
                return True
            if not a or not b:
                return False
            return a.lstrip("0") == b.lstrip("0")

        for ext, info in self.active_calls.items():
            talking_to = self._display_number(info, ext)
            if not talking_to or talking_to == "Unknown":
                continue
            if not _num_match(source, talking_to):
                continue
            agent_ch = info.get("channel")
            if not agent_ch:
                continue
            linkedid = self.ch2linkedid.get(agent_ch)
            if not linkedid:
                continue
            peers = self.linkedid2channels.get(linkedid, set()) - {agent_ch}
            if len(peers) == 1:
                return next(iter(peers))
            if peers:
                return next(iter(peers))
        return None

    def get_active_channel_sync(self, ext: str) -> Optional[str]:
        """Synchronous channel lookup from cache only (no AMI query)."""
        info = self.active_calls.get(ext)
        if info:
            ch = info.get("channel")
            if ch:
                return ch
        for ch, e in self.ch2ext.items():
            if e == ext:
                return ch
        return None

    async def transfer_call(self, ext: str, destination: str, context: Optional[str] = None, priority: str = '1') -> bool:
        """
        Blind transfer the current call on *ext* to *destination*.

        *ext* can be an extension (e.g. 1001) or the "talking to" number (other leg).
        Uses AMI Redirect to send the channel into the specified context/exten/priority.
        """
        if not self.connected:
            log.error("❌ Not connected to AMI")
            return False

        if not destination:
            log.error("❌ No destination provided for transfer")
            return False

        await self.sync_active_calls()
        ch = self._channel_for_transfer_source(ext)
        if not ch:
            log.error(f"❌ No active call on extension/number {ext}")
            return False

        ctx = context or self.context or 'default'
        resp = await self._send_async('Redirect', {
            'Channel':  ch,
            'Exten':    destination,
            'Context':  ctx,
            'Priority': priority,
        })

        if resp and 'Response: Success' in resp:
            log.info(f"🔁 Transfer requested: {ext} -> {destination} in {ctx} (channel {ch})")
            return True

        err = _parse(resp or '').get('Message', 'Unknown error')
        log.error(f"❌ Transfer failed for {ext} -> {destination}: {err}")
        return False

    # ------------------------------------------------------------------
    # Supervisor: listen / whisper / barge
    # ------------------------------------------------------------------
    async def _chanspy(self, supervisor: str, target: str, options: str, label: str) -> bool:
        if not self.connected:
            return False
        await self.sync_active_calls()
        ch = await self.get_active_channel(target)
        if not ch:
            log.error(f"❌ No active call on extension {target}")
            return False

        base = ch.rsplit('-', 1)[0]
        resp = await self._send_async('Originate', {
            'Channel':     f'PJSIP/{supervisor}',
            'Application': 'ChanSpy',
            'Data':        f'{base},{options}',
            'CallerID':    f'{label} <{target}>',
            'Timeout':     '30000'
        })
        if resp and 'Response: Success' in resp:
            log.info(f"✅ {supervisor} is now {label.lower()}ing {target}'s call")
            return True
        err = _parse(resp or '').get('Message','Unknown error')
        log.error(f"❌ {label} failed: {err}")
        return False

    async def listen_to_call(self, supervisor: str, target: str) -> bool:
        return await self._chanspy(supervisor, target, 'qsE',  'Listen')

    async def whisper_to_call(self, supervisor: str, target: str) -> bool:
        ok = await self._chanspy(supervisor, target, 'qwsE', 'Whisper')
        if ok:
            log.info("   (Agent hears you; caller does not)")
        return ok

    async def barge_into_call(self, supervisor: str, target: str) -> bool:
        ok = await self._chanspy(supervisor, target, 'qBsE', 'Barge')
        if ok:
            log.info("   (Both parties can hear you)")
        return ok

    # ------------------------------------------------------------------
    # Display helpers
    # ------------------------------------------------------------------
    async def list_active_calls(self, sync=True) -> Dict[str,Dict]:
        if sync:
            await self.sync_active_calls()
        log.info(f"\n{'Ext':<10} {'State':<12} {'Talking To':<20} {'Duration':<12} {'Talk Time':<12} {'Channel':<30}")
        log.info("-" * 110)
        if not self.active_calls:
            log.info("  No active calls")
        for ext, info in self.active_calls.items():
            # Calculate duration
            duration_str = "---"
            talk_time_str = "---"
            if 'start_time' in info:
                duration = datetime.now() - info['start_time']
                duration_str = _format_duration(duration)
                
                if info.get('answer_time'):
                    talk_time = datetime.now() - info['answer_time']
                    talk_time_str = _format_duration(talk_time)
            
            log.info(f"{ext:<10} {info.get('state','?'):<12} "
                  f"{self._display_number(info, ext):<20} {duration_str:<12} {talk_time_str:<12} {info.get('channel','')[:30]:<30}")
        log.info("-" * 110)
        return self.active_calls.copy()

    async def monitor_active_calls_live(self):
        """Continuously monitor and display active calls in real-time. Updates only when events occur."""
        if not self.connected:
            log.error("❌ Not connected to AMI")
            return
        
        # First, list current active calls to get precise state
        log.info("\n🔄 Getting current active calls...")
        await self.list_active_calls(sync=True)
        
        
        # Enable event monitoring and start event task if not already running
        await self._send_async('Events', {'EventMask': 'on'})
        was_running = self.running
        if not self.running or not (self._event_task and not self._event_task.done()):
            self.running = True
            self._event_task = asyncio.create_task(self._read_events_async())
        
        # Create refresh event for real-time updates
        self._refresh_event = asyncio.Event()
        
        # Sync again to ensure we have the latest state before going live
        await self.sync_active_calls()
        
        log.info("\n" + "=" * 80)
        log.info("  LIVE ACTIVE CALLS MONITOR  (Ctrl+C to stop)")
        log.info("=" * 80)
        
        last_count = -1
        monitor_running = True
        
        def _display():
            """Display the current active calls."""
            # Clear screen (ANSI escape sequence)
            log.info("\033[2J\033[H", end='')
            
            # Use event-driven state directly (don't sync - it overwrites event data)
            # Filter to show only valid extensions with channels (exclude dialplan contexts, trunks, external numbers)
            # Also hide the callee side of internal calls (show only caller's perspective)
            active = {}
            callees = set()  # Track who is a callee to filter them out
            
            # First pass: identify callees - only extensions that have 'caller' set are callees
            # (The 'caller' field is set in Newchannel when receiving an incoming call)
            for ext, info in self.active_calls.items():
                caller = info.get('caller', '')
                # Only mark as callee if caller is an internal extension
                if caller and caller.isdigit() and len(caller) <= 5:
                    callees.add(ext)
            
            # Second pass: build active list excluding callees and hung-up calls
            for ext, info in self.active_calls.items():
                if not info.get('channel') or not ext.isdigit() or ext in DIALPLAN_CTX:
                    continue
                # Skip if this extension is a callee (has 'caller' field set)
                if ext in callees:
                    continue
                # Skip hung-up calls (state is Down)
                state = info.get('state', '').strip()
                if state and state.lower() == 'down':
                    continue
                active[ext] = info
            count = len(active)
            
            # Header
            log.info("=" * 110)
            log.info(f"  LIVE ACTIVE CALLS MONITOR  |  {count} active call(s)  |  {datetime.now().strftime('%H:%M:%S')}")
            log.info("=" * 110)
            log.info(f"\n{'Ext':<10} {'State':<12} {'Talking To':<20} {'Duration':<12} {'Talk Time':<12} {'Channel':<30}")
            log.info("-" * 110)
            
            if not active:
                log.info("  No active calls")
            else:
                for ext, info in sorted(active.items()):
                    state = info.get('state', '?')
                    talking_to = self._display_number(info, ext)
                    channel = info.get('channel', '')[:30]
                    
                    # Calculate duration
                    duration_str = "---"
                    talk_time_str = "---"
                    if 'start_time' in info:
                        duration = datetime.now() - info['start_time']
                        duration_str = _format_duration(duration)
                        
                        if info.get('answer_time'):
                            talk_time = datetime.now() - info['answer_time']
                            talk_time_str = _format_duration(talk_time)
                    
                    # For outgoing calls, use dest_state (from destination channel) for better display
                    dest_state = info.get('dest_state', '')
                    if dest_state:
                        if dest_state in ('Ringing', 'Ring'):
                            state = 'Ringing'
                        elif dest_state == 'Up':
                            state = 'Up'
                    else:
                        # Fallback: check internal destination's state
                        dest_ext = info.get('exten') or info.get('original_destination', '')
                        if dest_ext and dest_ext in self.active_calls:
                            ds = self.active_calls[dest_ext].get('state', '')
                            if ds == 'Ringing':
                                state = 'Ringing'
                            elif ds == 'Up' and state != 'Up':
                                state = 'Up'
                    
                    log.info(f"{ext:<10} {state:<12} {talking_to:<20} {duration_str:<12} {talk_time_str:<12} {channel:<30}")
            
            log.info("-" * 110)
            
            log.info(f"\nLast updated: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
            log.info("Press Ctrl+C to stop...")
            
            # Show change notification
            nonlocal last_count
            if last_count != count and last_count != -1:
                if count > last_count:
                    log.info(f"\n🔔 New call detected! ({last_count} → {count})")
                elif count < last_count:
                    log.info(f"\n📴 Call ended! ({last_count} → {count})")
            last_count = count
        
        # Initial display
        _display()
        
        try:
            while monitor_running and self.running:
                # Wait for event signal with a timeout for periodic refresh
                # Use shorter timeout (1 second) to update duration counter smoothly
                self._refresh_event.clear()
                try:
                    event_triggered = await asyncio.wait_for(self._refresh_event.wait(), timeout=1.0)
                except asyncio.TimeoutError:
                    # Timeout is normal - refresh display to update duration
                    event_triggered = False
                except asyncio.CancelledError:
                    # Task was cancelled (e.g., by Ctrl+C)
                    break
                
                # Event occurred - add small delay to let AMI state settle
                if event_triggered and monitor_running and self.running:
                    try:
                        await asyncio.sleep(0.3)  # Debounce: wait for AMI state to stabilize
                    except asyncio.CancelledError:
                        break
                    # Drain any additional events that occurred during the delay
                    self._refresh_event.clear()
                
                # Refresh display (both on events and periodic timeout for duration updates)
                if monitor_running and self.running:
                    _display()
                
        except KeyboardInterrupt:
            log.info("\n\n🛑 Stopping live monitor...")
            monitor_running = False
            # Only stop the event task if we started it
            if not was_running:
                self.running = False
        except asyncio.CancelledError:
            # Handle cancellation gracefully
            log.info("\n\n🛑 Stopping live monitor...")
            monitor_running = False
            if not was_running:
                self.running = False
        finally:
            # Clean up refresh event
            self._refresh_event = None

    async def list_extensions_status(self, extensions: List[str]):
        log.info(f"\n{'Extension':<15} {'Status':<30} {'Context':<15}")
        log.info("-" * 65)
        for ext in extensions:
            status = await self.get_extension_status(ext)
            if status:
                log.info(f"{ext:<15} {self._status_desc(status.get('Status','-1'), ext):<30} {self.context:<15}")
            elif ext in self.active_calls:
                info = self.active_calls[ext]
                log.info(f"{ext:<15} {'In call with '+self._display_number(info, ext):<30} {self.context:<15}")
            else:
                log.info(f"{ext:<15} {'Not Found':<30} {self.context:<15}")


# ---------------------------------------------------------------------------
# Utility function
# ---------------------------------------------------------------------------
def normalize_interface(interface: str) -> str:
    """
    Normalize interface input - if just a number, prepend PJSIP/
    
    Examples:
        '100' -> 'PJSIP/100'
        'PJSIP/100' -> 'PJSIP/100'
        'SIP/100' -> 'SIP/100'
    """
    if not interface:
        return interface
    interface = interface.strip()
    if interface.isdigit():
        return f"PJSIP/{interface}"
    if '/' in interface:
        return interface
    return f"PJSIP/{interface}"