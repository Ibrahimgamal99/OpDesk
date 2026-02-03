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

    def __init__(self, host=None, port=None, username=None, secret=None, context=None):
        self.host     = host     or os.getenv('AMI_HOST','127.0.0.1')
        self.port     = port     or int(os.getenv('AMI_PORT','5038'))
        self.username = username or os.getenv('AMI_USERNAME','')
        self.secret   = secret   or os.getenv('AMI_SECRET','')
        self.context  = context  or os.getenv('AMI_CONTEXT','ext-local')

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
        'QueueMemberRingInUse','QueueSummary'
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

    def _ev_ExtensionStatus(self, p, ts):
        ext  = p.get('Exten', '')
        code = p.get('Status', '-1')
        if not ext:
            return
        self.extensions[ext] = p
        if code == '0' and ext in self.active_calls:
            del self.active_calls[ext]
            # Hangup logged in _ev_Hangup

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
        ext = _ext_from_channel(ch)
        
        # Track uniqueid for queue entry cleanup
        if uniqueid:
            self.ch2uniqueid[ch] = uniqueid
        
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
        
        # If callerid is an internal extension and different from ext, this is an incoming call
        if callerid and callerid != ext and callerid.isdigit() and len(callerid) <= 5:
            info['caller'] = callerid
            # Also update the caller's entry to know who they're calling
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
        if not ch:
            return
        
        # Get uniqueid from event or channel mapping
        if not uniqueid:
            uniqueid = self.ch2uniqueid.get(ch, '')
        
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
        
        # Get extension from channel mapping or extract from channel name
        ext = self.ch2ext.pop(ch, None)
        if not ext:
            ext = _ext_from_channel(ch)
        
        # Clean up dest channel mapping
        caller_ext = self.destch2ext.pop(ch, None)
        ch_type = self._get_channel_type(ch)
        
        # Clean up caller's active call if this was a destination channel
        # (caller_ext is set when this channel was a destination for an outgoing call)
        if caller_ext:
            caller_info = self.active_calls.get(caller_ext)
            if caller_info:
                # Check if this channel matches the caller's destchannel or main channel
                if caller_info.get('destchannel') == ch or caller_info.get('channel') == ch:
                    # This channel was part of the caller's call - clean up
                    if caller_ext in self.monitored:
                        num = self._display_number(caller_info, caller_ext)
                        if num != 'Unknown':
                            # Calculate duration
                            duration_str = ""
                            if 'start_time' in caller_info:
                                duration = datetime.now() - caller_info['start_time']
                                duration_str = f" | Duration: {_format_duration(duration)}"
                                
                                # Add talk time if answered
                                if caller_info.get('answer_time'):
                                    talk_time = datetime.now() - caller_info['answer_time']
                                    duration_str += f" | Talk: {_format_duration(talk_time)}"
                            
                            log.info("[%s] 📴 %s: Hangup with %s (channel %s)%s", ts, caller_ext, num, ch_type or caller_ext, duration_str)
                    self.active_calls.pop(caller_ext, None)
        
        # Clean up the extension's active call
        if ext:
            # Check if this channel matches the extension's channel
            ext_info = self.active_calls.get(ext)
            if ext_info and ext_info.get('channel') == ch:
                # This is the main channel for this extension - log and clean up
                if ext in self.monitored:
                    caller = ext_info.get('caller') or ext_info.get('callerid') or self.ch_callerid.get(ch, '')
                    dialed_exten = ext_info.get('exten', '')
                    has_dest_channel = bool(ext_info.get('destchannel'))
                    
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
                
                # Remove the extension from active calls
                self.active_calls.pop(ext, None)
            elif ext_info and ext_info.get('destchannel') == ch:
                # This was a destination channel, just remove the reference
                ext_info.pop('destchannel', None)
        
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
                if info.get('channel') == ch or info.get('destchannel') == ch:
                    # This call's channel hung up - remove it
                    self.active_calls.pop(ext_name, None)

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

    def _ev_Bridge(self, p, ts):
        ch1, ch2 = p.get('Channel1',''), p.get('Channel2','')
        ext1, ext2 = self._resolve_ext(ch1), self._resolve_ext(ch2)

        # Gather callerids from all available sources
        def _cid(ch, ext):
            if ext and ext in self.active_calls:
                return self.active_calls[ext].get('callerid', self.ch_callerid.get(ch,''))
            return self.ch_callerid.get(ch,'')

        cid1, cid2 = _cid(ch1, ext1), _cid(ch2, ext2)

        if ext1:
            self._call_info(ext1)['destination'] = cid2 if (cid2 and cid2 != ext1) else (ext2 or '')
        if ext2:
            self._call_info(ext2)['destination'] = cid1 if (cid1 and cid1 != ext2) else (ext1 or '')

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
        
        log.info(f"QueueSummary found {len(queues_summary)} queues: {list(queues_summary.keys())}")
        return queues_summary

    async def list_queues(self) -> Dict[str, Dict]:
        """List all queues with their status."""
        summary = await self.get_queue_summary()
        
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