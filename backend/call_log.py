import os
import re
import time
import threading
from pathlib import Path
from db_manager import (
    get_call_log_from_db, get_cdr_by_linkedid, get_supervision_by_spy_keys,
    get_agent_name_by_extension,
)
from datetime import datetime, timedelta


# ===========================================================================
# Canonical call-outcome vocabulary
# ===========================================================================
# ONE outcome enum used across the whole product — call history, the CRM push
# (call_status/disposition) and the analytics drilldown — so a call reads the same
# everywhere. It replaces three mutually inconsistent vocabularies that used to
# coexist: the AMI lowercase set (completed/noanswer/switched_off/invalid_number),
# an ad-hoc CDR-style disposition map (ANSWERED/NO ANSWER/BUSY/FAILED), and the
# call-history mapping that spelled no-answer `no_answer`.
#
# Values are derived from Asterisk's Q.850 hangup cause + Dialstatus + whether the
# call was answered (see map_call_outcome). Cause meanings per the Q.850 reference:
# 16 normal clearing, 17 busy, 18/19 no answer, 20 subscriber absent (phone off),
# 21 rejected, 28 invalid number format, 34 no circuit available.
#
# NOTE: the missed-call notification bell deliberately does NOT use this enum —
# see AMIExtensionsMonitor._notify_reason in ami.py.
ANSWERED     = 'ANSWERED'       # the call connected and had talk time
NO_ANSWER    = 'NO_ANSWER'      # rang, nobody picked up
BUSY         = 'BUSY'           # called party busy
FAILURE      = 'FAILURE'        # rejected / invalid number / congestion / channel unavailable
ABANDONED    = 'ABANDONED'      # caller left the queue before an agent answered
CANCELED     = 'CANCELED'       # caller hung up before the callee picked up (never rang out)
DROPPED      = 'DROPPED'        # call was answered, then torn down abnormally (network drop)
OUT_OF_REACH = 'OUT_OF_REACH'   # subscriber absent / device switched off / not addressable

CALL_OUTCOMES = (ANSWERED, NO_ANSWER, BUSY, FAILURE, ABANDONED, CANCELED, DROPPED, OUT_OF_REACH)

# Q.850 cause -> outcome for legs that did NOT answer. '16' (normal clearing) with no
# answer means the caller cleared before pickup => CANCELED.
_CAUSE_OUTCOME = {
    '16': CANCELED,
    '17': BUSY,   '0': BUSY,
    '18': NO_ANSWER, '19': NO_ANSWER, '127': NO_ANSWER,
    '20': OUT_OF_REACH,
    '21': FAILURE, '28': FAILURE, '31': FAILURE, '34': FAILURE,
}
# Dialstatus overrides (most specific signal for an unanswered leg).
_DIALSTATUS_OUTCOME = {
    'ANSWERED': ANSWERED, 'BUSY': BUSY, 'NOANSWER': NO_ANSWER,
    'CANCEL': CANCELED, 'CONGESTION': FAILURE, 'CHANUNAVAIL': FAILURE,
}
# CDR disposition -> outcome (the only signal available on the call-history path).
_DISPOSITION_OUTCOME = {
    'ANSWERED': ANSWERED, 'NO ANSWER': NO_ANSWER, 'BUSY': BUSY,
    'FAILED': FAILURE, 'CONGESTION': FAILURE,
}
# Causes that mean an *already-answered* call was torn down abnormally => DROPPED.
_DROPPED_CAUSES = {'38', '41', '44'}


def map_call_outcome(cause=None, dial_status=None, answered=False,
                     disposition=None, abandoned=False):
    """Return the canonical call outcome (one of CALL_OUTCOMES).

    Signals, richest first:
      answered     -- the call had answer/talk time (or an agent answered a queue call)
      cause        -- Asterisk Q.850 hangup cause code (str/int)
      dial_status  -- Dialstatus (ANSWERED/BUSY/NOANSWER/CANCEL/CONGESTION/CHANUNAVAIL)
      disposition  -- CDR disposition, used as a fallback when no live signal exists
      abandoned    -- caller left the queue before an agent answered

    The call-history / CDR path only has (disposition, answered): it yields the four
    coarse outcomes. The live AMI path has cause + dial_status + abandoned and yields
    the full set (ABANDONED / CANCELED / DROPPED / OUT_OF_REACH included). This is why
    a CDR-derived outcome must never overwrite a live one — see
    crm_identity_from_cdr's contract.
    """
    ds = (dial_status or '').strip().upper()
    c = str(cause).strip() if cause is not None else ''
    disp = (disposition or '').strip().upper()

    # An answered call is ANSWERED unless it dropped abnormally after pickup.
    if answered or ds == 'ANSWERED':
        return DROPPED if c in _DROPPED_CAUSES else ANSWERED

    # Unanswered: a queue abandon is its own outcome.
    if abandoned:
        return ABANDONED

    if ds in _DIALSTATUS_OUTCOME:
        return _DIALSTATUS_OUTCOME[ds]
    if c in _CAUSE_OUTCOME:
        return _CAUSE_OUTCOME[c]
    if disp in _DISPOSITION_OUTCOME:
        return _DISPOSITION_OUTCOME[disp]
    return FAILURE


# Get root directory for Asterisk recordings from environment variable


def classify_cdr_direction(cdr: dict) -> str:
    """
    Classify call direction (IN/OUT/INTERNAL) using weighted voting.
    """
    # Extract and clean fields
    src = str(cdr.get("src", "")).strip()
    dst = str(cdr.get("dst", "")).strip()
    dcontext = str(cdr.get("dcontext", "")).lower()
    channel = str(cdr.get("channel", "")).lower()
    dstchannel = str(cdr.get("dstchannel", "")).lower()
    
    votes = {"IN": 0, "OUT": 0, "INTERNAL": 0}
    
    # Patterns
    is_ext = lambda n: bool(re.match(r"^[1-9]\d{1,4}$", n))
    is_pstn = lambda n: bool(re.match(r"^\+?\d{7,15}$", n))
    is_feature = lambda n: bool(re.match(r"^\*\d+$", n))
    
    src_ext, dst_ext = is_ext(src), is_ext(dst)
    src_pstn, dst_pstn = is_pstn(src), is_pstn(dst)
    
    # Vote 1: Context (weight 4)
    # Convert to lowercase for case-insensitive matching
    dcontext_lower = dcontext.lower()
    
    # Incoming keywords (including any IVR)
    incoming_keywords = ["from-trunk", "from-pstn", "incoming", "ext-did", "ivr","queue"]
    
    # Outgoing keywords
    outgoing_keywords = ["from-internal", "outbound", "dialout"]
    
    # Check all incoming keywords
    if any(keyword in dcontext_lower for keyword in incoming_keywords):
        votes["IN"] += 4
    
    # Check all outgoing keywords
    if any(keyword in dcontext_lower for keyword in outgoing_keywords):
        votes["OUT"] += 2
    
    # Vote 2: Number patterns (weight 3-5)
    if src_ext and dst_pstn:
        votes["OUT"] += 3
    elif src_pstn and dst_ext:
        votes["IN"] += 3
    elif src_ext and dst_ext:
        votes["INTERNAL"] += 5
    elif src_ext and is_feature(dst):
        # Extension dialing a feature code (*43, *97, etc.) — treated as OUT
        votes["OUT"] += 3
    
    # Vote 3: Channels (weight 2)
    trunk_indicators = ["trunk", "gw", "provider", "peer", "dahdi"]
    if any(x in channel for x in trunk_indicators):
        votes["IN"] += 2
    if any(x in dstchannel for x in trunk_indicators):
        votes["OUT"] += 2
    
    # Vote 4: Last app (weight 3-2)
    lastapp = str(cdr.get("lastapp", "")).lower()
    if lastapp == "queue" or lastapp == "ivr" or lastapp == "stasis":
        votes["IN"] += 2
    elif lastapp == "page" or lastapp == "chanspy" or lastapp == "echo":
        votes["INTERNAL"] += 3
    elif lastapp == "background":
        if src_ext:
            votes["INTERNAL"] += 3        
    # Return max votes
    max_votes = max(votes.values())
    if max_votes == 0:
        # Feature codes from extensions → OUT
        if src_ext and (is_feature(dst) or dst_ext is False):
            return "OUT"
        return "INTERNAL" if src_ext else "UNKNOWN"
    
    # Tie breaker: IN vs OUT
    if votes["IN"] == votes["OUT"] == max_votes:
        return "IN" if src_pstn else "OUT"
    
    return max(votes, key=votes.get)


def convert_channel_to_extension(dstchannel,channel):
    try:
        temp_ext = dstchannel.split('-')[0].split('/')[1]
        if temp_ext.isdigit():
            extension = temp_ext
        else:
            temp_ext = channel.split('-')[0].split('/')[1]
            extension = temp_ext
    except IndexError:
        extension = None
    return extension

# ---------------------------------------------------------------------------
# Recording path resolution
#
# The recording filename stored in the CDR is only a basename; the actual file
# lives somewhere under ASTERISK_RECORDING_ROOT_DIR (FreePBX nests them under
# YYYY/MM/DD/). Resolving it used to mean a full recursive glob of the whole
# recordings tree PER CALL — so one call-history page (100 rows) or an analytics
# period (thousands of rows) triggered that many complete directory walks, which
# dominated the load time and got worse as recordings accumulated.
#
# Instead we build a single {basename -> absolute path} index and cache it. Hits
# are O(1) dict lookups, and the tree is walked at most once per TTL regardless
# of how many calls are on the page. A cache miss (a recording that landed after
# the last build) triggers at most one throttled rebuild so brand-new recordings
# are still found without hammering the disk.
# ---------------------------------------------------------------------------
_REC_INDEX: dict = {}
_REC_INDEX_BUILT_AT: float = 0.0      # monotonic timestamp of last successful build
_REC_INDEX_TTL = 120.0                # seconds a built index is trusted before refresh
_REC_MISS_REBUILD_INTERVAL = 15.0     # min seconds between miss-triggered rebuilds
_REC_INDEX_LOCK = threading.Lock()


def _recording_root() -> Path:
    return Path(os.getenv('ASTERISK_RECORDING_ROOT_DIR', '/home/ibrahim/pyc/voip/'))


def _build_recording_index() -> dict:
    """Walk the recordings tree once and map each file's basename to its path."""
    index: dict = {}
    try:
        for path in _recording_root().glob('**/*'):
            if path.is_file():
                # Last write wins if two dirs hold the same basename; recording
                # filenames are unique in practice (they embed the uniqueid).
                index[path.name] = path
    except OSError:
        # Recordings dir missing / unreadable — return whatever we have (maybe {}).
        pass
    return index


def _get_recording_index(force: bool = False) -> dict:
    """Return the cached basename->path index, rebuilding when stale or forced."""
    global _REC_INDEX, _REC_INDEX_BUILT_AT
    now = time.monotonic()
    if not force and _REC_INDEX_BUILT_AT and (now - _REC_INDEX_BUILT_AT) < _REC_INDEX_TTL:
        return _REC_INDEX
    with _REC_INDEX_LOCK:
        # Re-check inside the lock: another thread may have just rebuilt it.
        now = time.monotonic()
        if not force and _REC_INDEX_BUILT_AT and (now - _REC_INDEX_BUILT_AT) < _REC_INDEX_TTL:
            return _REC_INDEX
        _REC_INDEX = _build_recording_index()
        _REC_INDEX_BUILT_AT = time.monotonic()
        return _REC_INDEX


def get_recording_path(file_wav):
    """Resolve a CDR recording filename to its on-disk Path via the cached index.

    O(1) after the index is warm. Falls back to a throttled rebuild (so recently
    finished calls are found) and finally a substring scan of the in-memory index
    (no disk I/O) to preserve the old partial-match behaviour."""
    if not file_wav:
        return None
    name = os.path.basename(str(file_wav))
    index = _get_recording_index()

    hit = index.get(name)
    if hit is not None:
        return hit

    # Miss: the recording may have landed after the last build. Rebuild at most
    # once per interval to pick it up without triggering a walk on every miss.
    global _REC_INDEX_BUILT_AT
    if (time.monotonic() - _REC_INDEX_BUILT_AT) >= _REC_MISS_REBUILD_INTERVAL:
        index = _get_recording_index(force=True)
        hit = index.get(name)
        if hit is not None:
            return hit

    # Preserve the legacy substring semantics (recordingfile stored as a partial),
    # but over the in-memory index only — no filesystem walk.
    needle = str(file_wav)
    for basename, path in index.items():
        if needle in basename or needle in str(path):
            return path
    return None


def crm_identity_from_cdr(linkedid: str) -> dict:
    """
    Build CRM identity fields from the finalized CDR — the SAME source and
    normalization the call history uses — so the CRM push matches the call log
    exactly (correct direction, external destination, agent, talk time) instead of
    the digit-length heuristics the live AMI path applies at hangup.

    Returns {} if no CDR row exists yet; blank fields are omitted so they never
    overwrite good live values. Keys use the CRM catalog convention.

    IMPORTANT — the caller must NOT let the returned `call_status`/`disposition`
    overwrite a live cause-derived outcome. The CDR carries only the coarse
    disposition, so this can only produce ANSWERED/NO_ANSWER/BUSY/FAILURE; letting
    it win would erase CANCELED / DROPPED / OUT_OF_REACH / ABANDONED. See
    ami._send_crm_data, which restores the live values after merging.
    """
    rows = get_cdr_by_linkedid(linkedid)
    if not rows:
        return {}

    # get_cdr_by_linkedid returns raw per-leg rows with no ordering, so collapse them
    # the SAME way the call history does: identity from the first leg (min sequence =
    # origin), outcome from the last leg (max sequence = final). Without this a single
    # arbitrary leg is used and multi-leg calls report the wrong party.
    legs = sorted(rows, key=lambda r: (r.get('sequence') or 0))
    first, last = legs[0], legs[-1]
    cdr = {
        'calldate': first.get('calldate'),
        'src': first.get('src'),
        'dst': first.get('dst'),
        'dcontext': first.get('dcontext'),
        'channel': first.get('channel'),
        'dstchannel': last.get('dstchannel'),
        'lastapp': last.get('lastapp'),
        'disposition': last.get('disposition'),
        'billsec': last.get('billsec'),
        'duration': last.get('duration'),
    }
    direction = classify_cdr_direction(cdr)
    ext = convert_channel_to_extension(cdr.get('dstchannel'), cdr.get('channel'))

    dirmap = {'IN': 'inbound', 'OUT': 'outbound', 'INTERNAL': 'internal'}
    disp = str(cdr.get('disposition', '')).upper()
    outcome = map_call_outcome(disposition=disp, answered=bool(cdr.get('billsec')))

    def _hms(secs):
        try:
            s = int(secs or 0)
        except (TypeError, ValueError):
            return None
        return f"{s // 3600:02d}:{(s % 3600) // 60:02d}:{s % 60:02d}"

    out = {
        'caller': str(cdr.get('src') or ''),
        'destination': str(cdr.get('dst') or ''),
        'call_type': dirmap.get(direction, ''),
        'call_status': outcome,
        'disposition': outcome,
        'duration': _hms(cdr.get('duration')),
        'talk_time': _hms(cdr.get('billsec')),
    }
    cd = cdr.get('calldate')
    if cd:
        out['datetime'] = cd.isoformat() if hasattr(cd, 'isoformat') else str(cd)
    if ext:
        out['agent'] = ext
        if direction in ('IN', 'INTERNAL'):
            out['answered_extension'] = ext
        # For outbound, the meaningful "caller" for a CRM is the agent who placed
        # the call — not the outbound caller-ID number Asterisk recorded as src.
        if direction == 'OUT':
            out['caller'] = ext
        name = get_agent_name_by_extension(ext)
        if name:
            out['agent_name'] = name

    # Cross-reference key for the CRM: call_id is the linkedid, which identifies the
    # whole call-log row and is what call-history search matches.
    out['call_id'] = str(first.get('linkedid') or linkedid or '')
    return {k: v for k, v in out.items() if v not in (None, '')}


def call_log(limit=None, date=None, date_from=None, date_to=None, allowed_extensions=None,
             search=None, enrich=True):
    """Build normalized call-history rows from the CDR.

    enrich=True (Call History UI) resolves each row's recording path and flags
    supervision (ChanSpy) legs. Analytics reuses this data source but only needs
    direction/disposition/duration/talk, so it passes enrich=False to skip the
    recording lookup and the supervision query — real savings when scanning a
    whole period with no row limit.
    """
    call_log = get_call_log_from_db(limit=limit, date=date,
                                     date_from=date_from, date_to=date_to,
                                     allowed_extensions=allowed_extensions,
                                     search=search)
    
    result = []
    for cdr in call_log:
        cdr['call_type'] = classify_cdr_direction(cdr)
        cdr['extension'] = convert_channel_to_extension(cdr['dstchannel'],cdr['channel'])        
        if enrich and cdr.get('recordingfile'):
            cdr['recording_path'] = get_recording_path(cdr['recordingfile'])
        else:
            cdr['recording_path'] = None
        
        # Determine phone number (external party) based on call direction
        call_type = cdr.get('call_type', '')
        if call_type == 'IN':
            phone_number = cdr.get('src', '')
        elif call_type == 'OUT':
            phone_number = cdr.get('dst', '')
        else:
            phone_number = cdr.get('dst', '') or cdr.get('src', '')
        
        # Canonical outcome. Computed on read from the CDR disposition, never stored,
        # so the whole history re-renders under this vocabulary with no backfill.
        # `disposition` below stays the RAW CDR value — analytics keys off it.
        disposition = str(cdr.get('disposition', '')).upper()
        status = map_call_outcome(disposition=disposition,
                                  answered=bool(cdr.get('billsec')))

        # Create a new dict with only the fields you want
        filtered_cdr = {
            'calldate': cdr.get('calldate'),
            'src': cdr.get('src'),
            'dst': cdr.get('dst'),
            'phone_number': phone_number,
            'customer_name': cdr.get('cnam') or None,
            'duration': cdr.get('duration'),
            'talk': cdr.get('billsec'),  # billsec renamed to talk
            'disposition': disposition,
            'status': status,
            'QoS': cdr.get('userfield'),
            'extension': cdr.get('extension'),
            'call_type': cdr.get('call_type'),
            'recording_path': str(cdr['recording_path']) if cdr.get('recording_path') else None,
            'recording_file': cdr.get('recordingfile') or None,
            'app': cdr.get('call_app'),  
            'call_journey_count':cdr.get('call_journey_count'),
            'linkedid':cdr.get('linkedid'),
            'uniqueid':cdr.get('uniqueid'),
            # Supervision (listen/whisper/barge). Enriched below; a standalone ChanSpy
            # leg is flagged here so the UI can hide it behind a "supervision" filter.
            'is_supervision': False,
            'supervision': None,
        }

        result.append(filtered_cdr)

    # Flag ChanSpy legs (listen/whisper/barge) so the call log can hide them by default.
    # A supervision row is its own CDR call whose linkedid/uniqueid we recorded when the
    # spy channel was originated (see AMI _chanspy + call_supervision table).
    keys = []
    if enrich:
        keys = [str(r['linkedid']) for r in result if r.get('linkedid')]
        keys += [str(r['uniqueid']) for r in result if r.get('uniqueid')]
    spy_by_key = get_supervision_by_spy_keys(keys) if keys else {}
    if spy_by_key:
        for r in result:
            spy = spy_by_key.get(str(r.get('linkedid'))) or spy_by_key.get(str(r.get('uniqueid')))
            if spy:
                r['is_supervision'] = True
                r['supervision'] = {
                    'mode': spy.get('mode'),
                    'supervisor_extension': spy.get('supervisor_extension'),
                    'target_extension': spy.get('target_extension'),
                    'target_linkedid': spy.get('target_linkedid'),
                }

    return result


def build_call_journey_from_cdr(cdr_rows: list) -> list:
    """
    Build call journey from queue-based CDR rows
    """

    if not cdr_rows:
        return []

    # Always sort by time
    cdr_rows = sorted(cdr_rows, key=lambda x: x["calldate"])

    journey = []
    def get_answer_time(row):
        """
        Calculate answer time from FreePBX CDR row
        """
        if row["billsec"] and row["billsec"] > 0:
            return row["calldate"] + timedelta(
                seconds=(row["duration"] - row["billsec"])
            )
        return None
    
    def add(event, time: datetime, **data):
        e = {
            "event": event,
            "time": time.strftime("%H:%M:%S"),
            "_dt": time,  # kept for duration calculation
        }
        e.update(data)
        journey.append(e)

    first = cdr_rows[0]
    last = cdr_rows[-1]

    def add_transfers_and_hangup():
        """Block 2 tail: TRANSFER events for cdr_rows[1:] then HANGUP. Reused by Dial and callable from Queue."""
        for row in cdr_rows[1:]:
            agent = convert_channel_to_extension(
                row.get("dstchannel"), row.get("channel")
            )
            if not agent:
                continue
            add("TRANSFER", row["calldate"], agent=agent)
        add(
            "HANGUP",
            last["calldate"] + timedelta(seconds=last["duration"]),
            reason=last.get("disposition"),
        )

    def build_dial_block():
        """Block 2: full Dial flow (ANSWER + transfers + HANGUP). Call this from Block 1 when you want Dial logic."""
        first_agent = convert_channel_to_extension(
            first.get("dstchannel"), first.get("channel")
        )
        answer_time = get_answer_time(first) or first["calldate"]
        add("ANSWER", answer_time, agent=first_agent)
        add_transfers_and_hangup()

    # 1️⃣ INBOUND (common)
    if classify_cdr_direction(first) == "IN":
        add(
            "INBOUND",
            first["calldate"],
            from_number=first["src"],
        )
    else:
        add(
            "OUTBOUND",
            first["calldate"],
            to_number=first["dst"],
        )

    # ——— Block 1: Queue ———
    if first["lastapp"] == "Queue":
        add("QUEUE_ENTER", first["calldate"], queue=first["dst"])

        for i, row in enumerate(cdr_rows):
            agent = convert_channel_to_extension(
                row.get("dstchannel"), row.get("channel")
            )
            if not agent:
                continue
            # TRANSFER before RING for each leg after the first
            if i > 0:
                add("TRANSFER", row["calldate"], agent=agent)
            add("RING", row["calldate"], agent=agent)

            if row["disposition"] == "NO ANSWER":
                add(
                    "NO_ANSWER",
                    row["calldate"] + timedelta(seconds=row["duration"]),
                    agent=agent,
                )
            elif row["disposition"] == "ANSWERED":
                answer_time = get_answer_time(row)
                if answer_time:
                    add("ANSWER", answer_time, agent=agent)

        add(
            "HANGUP",
            last["calldate"] + timedelta(seconds=last["duration"]),
            reason=last.get("disposition"),
        )

    # ——— Block 2: Dial ———
    elif first["lastapp"] == "Dial":
        build_dial_block()

    # Sort by time, then by logical event order for same-second events
    _event_order = {
        "INBOUND": 0,
        "QUEUE_ENTER": 1,
        "TRANSFER": 2,
        "RING": 3,
        "ANSWER": 4,
        "NO_ANSWER": 4,
        "HANGUP": 5,
    }
    journey.sort(key=lambda e: (e["time"], _event_order.get(e["event"], 99)))

    # Add duration (seconds) for each event: time until next event; last event = 0
    for i, e in enumerate(journey):
        if i + 1 < len(journey):
            secs = round(
                (journey[i + 1]["_dt"] - e["_dt"]).total_seconds(), 1
            )
            if secs != 0:
                e["duration"] = secs
        del e["_dt"]

    return journey
if __name__ == "__main__":
    linkedid = 1772366689.422
    data = get_cdr_by_linkedid(linkedid)
    print(build_call_journey_from_cdr(data))