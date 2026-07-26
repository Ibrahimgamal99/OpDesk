#!/usr/bin/env python3
"""
Agent presence recorder — the data source for the Agent Adherence report.

OpDesk's /api/agent/login|logout|status endpoints already do the queue work
(queue_add / queue_remove / queue_pause / queue_unpause). This module sits
alongside them and records every presence transition as an append-only SEGMENT
in agent_activity (db_manager.agent_activity_transition), so the report is a plain
GROUP BY — no reliance on Asterisk's queue_log.

Unlike echo's AgentStateManager, the recorder never manipulates queues itself. It
only observes:

  * the endpoints call record_login / record_logout / record_ready / record_not_ready
  * an AMI callback reconciles live call flow and feature-code actions:
      AgentConnect         -> on_call
      AgentComplete        -> ready (agent returns to the queue after the call)
      QueueMemberPause     -> not_ready (with reason) / wrap_up (__WRAPUP)
      QueueMemberUnpause   -> ready
      QueueMemberRemoved   -> logged out (once no queue membership remains)
      QueueMemberAdded     -> ready / not_ready (feature-code login outside the UI)

All writes go through _apply(), which is idempotent: the AMI echo of an action the
endpoint already recorded is a no-op, so a login never produces a duplicate segment.
"""

import asyncio
import logging
from datetime import datetime
from typing import Dict, List, Optional

import db_manager as dbm
from ami import normalize_interface

log = logging.getLogger(__name__)

# Presence states (mirror agent_activity.state)
READY = "ready"
NOT_READY = "not_ready"
ON_CALL = "on_call"
WRAP_UP = "wrap_up"

WRAPUP_REASON = "__WRAPUP"  # system pause reason marking after-call work, if ever used

_AMI_EVENTS = {
    "AgentConnect", "AgentComplete",
    "QueueMemberPaused", "QueueMemberPause", "QueueMemberUnpause",
    "QueueMemberAdded", "QueueMemberRemoved",
}


def _ext_from_interface(interface: str) -> str:
    """'PJSIP/1001' -> '1001', 'Local/1001@from-queue/n' -> '1001', 'SIP/1001' -> '1001'."""
    if not interface:
        return ""
    tail = interface.split("/", 1)[1] if "/" in interface else interface
    return tail.split("@", 1)[0].split("/", 1)[0].strip()


class PresenceRecorder:
    def __init__(self, monitor):
        self.monitor = monitor
        # agent_ext -> {state, since(datetime), reason_code, linkedid, queue}
        self.states: Dict[str, dict] = {}
        self._lock = asyncio.Lock()

    def _interface(self, agent_ext: str) -> str:
        return normalize_interface(str(agent_ext).strip())

    def _monitored(self) -> set:
        return getattr(self.monitor, "monitored", set()) or set()

    # ------------------------------------------------------------------
    # Core: apply a transition (idempotent) -> persist segment + memory
    # ------------------------------------------------------------------
    def _apply(self, agent_ext: str, state: Optional[str], *, reason_code: Optional[str] = None,
               linkedid: Optional[str] = None, queue: Optional[str] = None,
               source: str = "ui", force: bool = False) -> bool:
        """Persist + record a transition. Returns True if the state actually changed.
        state=None => logged out (close the open segment, drop from memory)."""
        ext = str(agent_ext or "").strip()
        if not ext:
            return False
        cur = self.states.get(ext)

        if not force:
            if state is None and not cur:
                return False
            if cur and cur.get("state") == state and cur.get("reason_code") == reason_code \
                    and (state != ON_CALL or cur.get("linkedid") == linkedid):
                return False

        dbm.agent_activity_transition(ext, state, reason_code=reason_code, queue=queue,
                                      linkedid=linkedid, source=source)
        if state is None:
            self.states.pop(ext, None)
            return True
        self.states[ext] = {
            "state": state,
            "since": datetime.now(),
            "reason_code": reason_code,
            "linkedid": linkedid,
            "queue": queue,
        }
        return True

    # ------------------------------------------------------------------
    # Endpoint-driven records (the endpoint has already done the queue work)
    # ------------------------------------------------------------------
    async def record_login(self, agent_ext: str, ready: bool = True, source: str = "ui"):
        async with self._lock:
            if ready:
                self._apply(agent_ext, READY, source=source, force=True)
            else:
                self._apply(agent_ext, NOT_READY, source=source, force=True)

    async def record_logout(self, agent_ext: str, source: str = "ui"):
        async with self._lock:
            self._apply(agent_ext, None, source=source, force=True)

    async def record_ready(self, agent_ext: str, source: str = "ui"):
        async with self._lock:
            self._apply(agent_ext, READY, source=source, force=True)

    async def record_not_ready(self, agent_ext: str, reason_code: Optional[str], source: str = "ui"):
        async with self._lock:
            state = WRAP_UP if reason_code == WRAPUP_REASON else NOT_READY
            self._apply(agent_ext, state, reason_code=reason_code or None, source=source, force=True)

    # ------------------------------------------------------------------
    # AMI-event driven reconciliation (call flow + external feature codes)
    # ------------------------------------------------------------------
    async def handle_ami_event(self, p: dict):
        """Registered as an AMI event callback. Keeps presence correct even when a call
        connects or a feature code is used outside the UI. Only touches monitored
        extensions."""
        try:
            ev = p.get("Event", "")
            if ev not in _AMI_EVENTS:
                return
            interface = p.get("Interface", p.get("Member", ""))
            ext = _ext_from_interface(interface)
            if not ext or ext not in self._monitored():
                return
            queue = p.get("Queue", "")
            linkedid = p.get("Linkedid", p.get("DestLinkedid", ""))

            async with self._lock:
                if ev == "AgentConnect":
                    self._apply(ext, ON_CALL, linkedid=linkedid, queue=queue, source="ami")
                    return

                if ev == "AgentComplete":
                    # Call finished; the member is available in the queue again.
                    if ext in self.states:
                        self._apply(ext, READY, source="ami")
                    return

                if ev == "QueueMemberAdded":
                    # Feature-code login outside the UI — start a session if we have none.
                    if ext not in self.states:
                        paused = p.get("Paused", "0") == "1"
                        reason = (p.get("Reason") or "").strip()
                        if paused:
                            state = WRAP_UP if reason == WRAPUP_REASON else NOT_READY
                            self._apply(ext, state, reason_code=reason or None, source="ami", force=True)
                        else:
                            self._apply(ext, READY, source="ami", force=True)
                    return

                if ev == "QueueMemberRemoved":
                    # Removed from a queue. Log out once no membership remains anywhere.
                    if ext in self.states and not self._still_member(ext):
                        self._apply(ext, None, source="ami", force=True)
                    return

                # QueueMemberPaused / QueueMemberPause / QueueMemberUnpause
                if ext not in self.states:
                    return
                paused = p.get("Paused", "0") == "1"
                reason = (p.get("Reason") or "").strip()
                if not paused:
                    # Unpaused externally -> Ready (a live call isn't paused, so don't clobber on_call).
                    if self.states[ext].get("state") in (NOT_READY, WRAP_UP):
                        self._apply(ext, READY, source="ami")
                else:
                    state = WRAP_UP if reason == WRAPUP_REASON else NOT_READY
                    self._apply(ext, state, reason_code=reason or None, source="ami")
        except Exception as e:  # noqa: BLE001
            log.warning(f"presence handle_ami_event error: {e}")

    def _still_member(self, agent_ext: str) -> bool:
        interface = self._interface(agent_ext)
        for m in self.monitor.queue_members.values():
            if m.get("interface") == interface:
                return True
        return False

    # ------------------------------------------------------------------
    # Startup hydration
    # ------------------------------------------------------------------
    async def hydrate(self):
        """Rebuild in-memory presence from the live queue state after a (re)start.
        Closes stale open segments first so time while the backend was down is not
        counted, then opens a fresh segment per live dynamic member."""
        try:
            dbm.agent_activity_close_all_open(source="system")
        except Exception as e:  # noqa: BLE001
            log.warning(f"presence hydrate close_all_open: {e}")

        monitored = self._monitored()
        by_ext: Dict[str, dict] = {}
        for m in self.monitor.queue_members.values():
            if not m.get("dynamic"):
                continue  # static members aren't tracked (no login/logout lifecycle)
            ext = _ext_from_interface(m.get("interface", ""))
            if not ext or ext not in monitored:
                continue
            entry = by_ext.setdefault(ext, {"queues": [], "paused": False, "reason": ""})
            q = m.get("queue", "")
            if q and q not in entry["queues"]:
                entry["queues"].append(q)
            if m.get("paused"):
                entry["paused"] = True
                if m.get("pause_reason"):
                    entry["reason"] = m.get("pause_reason")

        async with self._lock:
            for ext, entry in by_ext.items():
                if entry["paused"]:
                    state = WRAP_UP if entry["reason"] == WRAPUP_REASON else NOT_READY
                    self._apply(ext, state, reason_code=entry["reason"] or None, source="system", force=True)
                else:
                    self._apply(ext, READY, source="system", force=True)
        if by_ext:
            log.info(f"Agent presence hydrated: {len(by_ext)} logged-in agent(s)")
