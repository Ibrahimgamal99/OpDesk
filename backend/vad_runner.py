#!/usr/bin/env python3
"""
In-process post-call VAD analysis, driven by the AMI monitor.

The [opdesk-record] dialplan fires a `UserEvent(OpDeskRecording,Recbase: <base>)` at call
start; the AMI monitor remembers that base by the channel's Uniqueid and, when the matching
Hangup arrives, calls schedule()/analyze_and_store() here. We wait for MixMonitor to finish
flushing the two single-leg WAVs (<base>-sp1.* / <base>-sp2.*), run WebRTC VAD on each leg,
and upsert the result into the OpDesk DB (call_vad table) keyed by Uniqueid.

Everything runs inside the backend process (the AMI monitor's event loop), so there is no
AGI, no loopback HTTP, and DB access uses db_manager directly.
"""

import asyncio
import concurrent.futures
import json
import logging
import os
import time

log = logging.getLogger(__name__)

SETTLE_TIMEOUT_S = 30.0    # max wait for the WAV legs to finish flushing after hangup
POLL_INTERVAL_S = 0.5

# Isolated executor so long-running WAV-settle polls never crowd out the default
# executor that handles DB queries, push notifications, and other server I/O.
_vad_executor = concurrent.futures.ThreadPoolExecutor(
    max_workers=4, thread_name_prefix='opdesk-vad'
)


def _overlap_seconds(sp1_segs, sp2_segs):
    """Total time both legs speak simultaneously (interval intersection)."""
    if not sp1_segs or not sp2_segs:
        return 0.0
    a = sorted((s["start"], s["end"]) for s in sp1_segs)
    b = sorted((s["start"], s["end"]) for s in sp2_segs)
    i = j = 0
    total = 0.0
    while i < len(a) and j < len(b):
        lo = max(a[i][0], b[j][0])
        hi = min(a[i][1], b[j][1])
        if hi > lo:
            total += hi - lo
        if a[i][1] < b[j][1]:
            i += 1
        else:
            j += 1
    return round(total, 3)


def _talk(segs):
    return round(sum(max(0.0, s.get("end", 0) - s.get("start", 0)) for s in segs), 3) if segs else 0.0


def _wait_and_analyze(base):
    """Blocking: wait for both legs to settle, then run VAD. Returns analyze_pair() dict or None."""
    from call_vad_analysis import pair_from_base, analyze_pair

    deadline = time.time() + SETTLE_TIMEOUT_S
    last_sizes = None
    while time.time() < deadline:
        sp1, sp2 = pair_from_base(base)
        if sp1 and sp2:
            try:
                sizes = (os.path.getsize(sp1), os.path.getsize(sp2))
            except OSError:
                sizes = None
            # stable size across two polls and past the WAV header → fully flushed
            if sizes and sizes[0] > 44 and sizes[1] > 44 and sizes == last_sizes:
                return analyze_pair(sp1, sp2)
            last_sizes = sizes
        time.sleep(POLL_INTERVAL_S)

    sp1, sp2 = pair_from_base(base)
    if sp1 or sp2:
        return analyze_pair(sp1, sp2)
    return None


async def analyze_and_store(base: str, uniqueid: str):
    """Wait for the recording legs, run VAD, and store the result in the OpDesk DB."""
    if not base or not uniqueid:
        return
    try:
        loop = asyncio.get_running_loop()
        result = await loop.run_in_executor(_vad_executor, _wait_and_analyze, base)
    except Exception as e:
        log.warning("VAD analyze failed (%s): %s", uniqueid, e)
        return
    if not result:
        log.info("VAD: no recording legs found for %s (base=%s)", uniqueid, base)
        return

    speakers = result.get("speakers") or {}
    sp1 = speakers.get("sp1") if isinstance(speakers.get("sp1"), list) else []
    sp2 = speakers.get("sp2") if isinstance(speakers.get("sp2"), list) else []

    try:
        from db_manager import upsert_call_vad
        await asyncio.to_thread(
            upsert_call_vad,
            uniqueid=uniqueid,
            base=str(result.get("base") or "")[:255] or None,
            duration=result.get("duration"),
            sp1_talk_seconds=_talk(sp1),
            sp2_talk_seconds=_talk(sp2),
            overlap_seconds=_overlap_seconds(sp1, sp2),
            sp1_segments=len(sp1),
            sp2_segments=len(sp2),
            segments_json=json.dumps(speakers)[:16_000_000],
        )
        log.info("VAD stored for %s: sp1=%dseg sp2=%dseg dur=%s",
                 uniqueid, len(sp1), len(sp2), result.get("duration"))
    except Exception as e:
        log.warning("VAD store failed (%s): %s", uniqueid, e)


def schedule(base: str, uniqueid: str):
    """Fire-and-forget the analysis on the running event loop (safe to call from sync code)."""
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return
    loop.create_task(analyze_and_store(base, uniqueid))
