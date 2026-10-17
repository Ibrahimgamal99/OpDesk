#!/usr/bin/env python3
"""
RFC 8599 push gateway for Asterisk.

RFC 8599 has the softphone, not an app-side API, tell the registrar how to wake it: the
REGISTER Contact URI carries

    pn-provider   fcm | apns | apns-sandbox
    pn-prid       the device's push token (FCM registration token / PushKit VoIP token)
    pn-param      FCM: the Firebase project ID; APNs: "<Team ID>.<topic>" (optional)

and the proxy, on an INVITE for that binding, sends a push, holds the INVITE until the
device re-registers, then forwards it. Asterisk does not do this itself, so OpDesk does it
next to it:

  * Bindings are learned from Asterisk's PJSIP contacts over AMI (ContactStatus events,
    plus a full PJSIPShowContacts sync at startup and every few minutes) and kept in the
    sip_push_bindings table after the registration itself has expired.
  * The [from-internal-custom] hook (dialplan.write_mobile_wake_conf) asks wake() before
    the extension is dialed. With a binding, wake() snapshots the extension's contacts,
    sends a "call" push and returns "1"; the dialplan then polls ready() every 0.5 s for
    up to the hold time, waits the settle window, and lets FreePBX dial as usual.
  * ready() is true once a mobile contact registered after the push: a new contact, or a
    refreshed one (later expiration). A mobile contact is one whose URI has pn-* params or
    whose User-Agent contains the mobile client marker.
  * If the caller hangs up during the hold, or the hold runs out, cancel() sends a
    "cancel" push so the phone stops ringing (FCM only; see push_service.send_rfc8599).

Push payload (the Medut-SDK contract): type ("call" | "cancel"), caller_uri, caller_name,
aor. There is deliberately no call_id: Asterisk picks the INVITE's Call-ID itself, and the
app turns away an INVITE whose Call-ID differs from the one its push named.

The AMI connection here is separate from the call monitor's: polling contacts on the
monitor's connection would swallow call events that arrive while a reply is awaited.
"""

import asyncio
import itertools
import logging
import os
import time
from typing import Callable, Dict, List, Optional
from urllib.parse import unquote, urlparse

import push_service
from db_manager import (
    get_device_tokens_for_extension, get_setting, list_sip_push_bindings, upsert_sip_push_binding,
)

log = logging.getLogger(__name__)

SYNC_INTERVAL = 600          # full contact sync, seconds
PENDING_TTL = 90             # forget a wake the dialplan never closed, seconds
DEFAULT_HOLD = 10
DEFAULT_SETTLE = 3
DEFAULT_MARKER = "Medut"     # Medut's User-Agent is "Medut/<version> (android|ios)"


# =============================================================================
# RFC 8599 Contact parameters
# =============================================================================

def parse_pn_params(uri: str) -> Optional[Dict[str, str]]:
    """The pn-provider / pn-prid / pn-param of a Contact URI, or None when it has no
    pn-provider and pn-prid. Parameter names are case-insensitive, values percent-decoded."""
    if not uri:
        return None
    body = uri.strip()
    if body.startswith("<"):
        body = body[1:body.find(">")] if ">" in body else body[1:]
    body = body.split("?", 1)[0]
    params: Dict[str, str] = {}
    for part in body.split(";")[1:]:
        name, _, value = part.partition("=")
        name = name.strip().lower()
        if name.startswith("pn-"):
            params[name] = unquote(value.strip())
    provider = params.get("pn-provider", "").lower()
    prid = params.get("pn-prid", "")
    if not provider or not prid:
        return None
    return {"provider": provider, "prid": prid, "param": params.get("pn-param", "")}


# =============================================================================
# AMI client (actions keyed by ActionID + 'system' events)
# =============================================================================

class _AMIClient:
    """Minimal AMI client: one reader task routes replies to the action that asked by
    ActionID, and hands ContactStatus events to `on_event`. Reconnects on its own."""

    def __init__(self, on_event: Callable[[Dict[str, str]], None]):
        self.host = os.getenv("AMI_HOST", "127.0.0.1")
        self.port = int(os.getenv("AMI_PORT", "5038"))
        self.username = os.getenv("AMI_USERNAME", "")
        self.secret = os.getenv("AMI_SECRET", "")
        self.on_event = on_event
        self.connected = asyncio.Event()
        self._writer: Optional[asyncio.StreamWriter] = None
        self._pending: Dict[str, dict] = {}
        self._ids = itertools.count(1)
        self._task: Optional[asyncio.Task] = None

    def start(self) -> None:
        if self._task is None or self._task.done():
            self._task = asyncio.create_task(self._run())

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        self._close()

    def _close(self) -> None:
        self.connected.clear()
        if self._writer:
            try:
                self._writer.close()
            except Exception:
                pass
        self._writer = None
        for p in self._pending.values():
            if not p["future"].done():
                p["future"].set_result(None)
        self._pending.clear()

    @staticmethod
    def _parse(raw: bytes) -> Dict[str, object]:
        msg: Dict[str, object] = {}
        output: List[str] = []
        for line in raw.decode("utf-8", errors="ignore").split("\r\n"):
            key, sep, value = line.partition(":")
            if not sep:
                continue
            key, value = key.strip(), value.strip()
            if key == "Output":
                output.append(value)
            elif key not in msg:
                msg[key] = value
        if output:
            msg["Output"] = output
        return msg

    async def _run(self) -> None:
        delay = 2
        while True:
            try:
                reader, self._writer = await asyncio.open_connection(self.host, self.port, limit=1 << 20)
                await reader.readline()  # banner
                login_id = f"opdesk-pn-{next(self._ids)}"
                self._writer.write(
                    f"Action: Login\r\nUsername: {self.username}\r\nSecret: {self.secret}\r\n"
                    f"Events: system\r\nActionID: {login_id}\r\n\r\n".encode()
                )
                await self._writer.drain()
                while True:
                    msg = self._parse(await reader.readuntil(b"\r\n\r\n"))
                    if msg.get("ActionID") == login_id:
                        break
                if msg.get("Response") != "Success":
                    log.warning("RFC 8599 AMI login failed: %s", msg.get("Message", ""))
                    raise ConnectionError("login failed")
                self.connected.set()
                delay = 2
                log.info("RFC 8599 push gateway connected to AMI")
                while True:
                    self._route(self._parse(await reader.readuntil(b"\r\n\r\n")))
            except asyncio.CancelledError:
                raise
            except Exception as e:
                if self.connected.is_set():
                    log.warning("RFC 8599 AMI connection lost: %s", e)
            self._close()
            await asyncio.sleep(delay)
            delay = min(delay * 2, 60)

    def _route(self, msg: Dict[str, object]) -> None:
        pending = self._pending.get(str(msg.get("ActionID", "")))
        if pending is None:
            if msg.get("Event") == "ContactStatus":
                try:
                    self.on_event(msg)
                except Exception as e:
                    log.debug("ContactStatus handler error: %s", e)
            return
        if "Response" in msg:
            pending["response"] = msg
            done = msg["Response"] != "Success" or str(msg.get("EventList", "")).lower() != "start"
        else:
            pending["events"].append(msg)
            done = str(msg.get("EventList", "")).lower() == "complete"
        if done and not pending["future"].done():
            pending["future"].set_result(pending)

    async def action(self, name: str, params: Optional[Dict[str, str]] = None, timeout: float = 3.0) -> Optional[dict]:
        """Run one action; returns {"response": msg, "events": [msgs]} or None when AMI is
        unreachable or the reply is late."""
        if not self.connected.is_set() or self._writer is None:
            return None
        action_id = f"opdesk-pn-{next(self._ids)}"
        future = asyncio.get_running_loop().create_future()
        self._pending[action_id] = {"future": future, "response": None, "events": []}
        lines = [f"Action: {name}", f"ActionID: {action_id}"]
        lines += [f"{k}: {v}" for k, v in (params or {}).items()]
        try:
            self._writer.write(("\r\n".join(lines) + "\r\n\r\n").encode())
            await self._writer.drain()
            return await asyncio.wait_for(future, timeout)
        except Exception:
            return None
        finally:
            self._pending.pop(action_id, None)


# =============================================================================
# Gateway state
# =============================================================================

_ami: Optional[_AMIClient] = None
_sync_task: Optional[asyncio.Task] = None
_bindings: Dict[str, List[dict]] = {}       # extension -> bindings (cache of the DB table)
_pending: Dict[str, dict] = {}              # dialplan UNIQUEID -> wake in progress
_registered_at: Dict[str, float] = {}       # extension -> time a mobile contact was last Created
_settings = {"marker": DEFAULT_MARKER, "enabled": False}


def configure(marker: Optional[str] = None, enabled: Optional[bool] = None) -> None:
    """Apply the Mobile Wake settings that matter at run time (the dialplan holds the rest)."""
    if marker is not None:
        _settings["marker"] = marker.strip()
    if enabled is not None:
        _settings["enabled"] = bool(enabled)


def is_enabled() -> bool:
    return _settings["enabled"]


def _is_mobile(uri: str, user_agent: str) -> bool:
    marker = _settings["marker"].lower()
    return bool(parse_pn_params(uri)) or bool(marker and marker in (user_agent or "").lower())


def public_host() -> str:
    """The host phones use for this PBX: OPDESK_DOMAIN, else the WebRTC server's host."""
    domain = os.getenv("OPDESK_DOMAIN", "").strip()
    if domain:
        return domain
    try:
        return urlparse(get_setting("WEBRTC_PBX_SERVER", "") or "").hostname or ""
    except Exception:
        return ""


async def start(enabled: bool, marker: str) -> None:
    """Load the stored bindings, connect to AMI and start the periodic contact sync."""
    global _ami, _sync_task
    configure(marker=marker, enabled=enabled)
    await asyncio.to_thread(reload_bindings)
    _ami = _AMIClient(_on_contact_status)
    _ami.start()
    _sync_task = asyncio.create_task(_sync_loop())


async def stop() -> None:
    if _sync_task:
        _sync_task.cancel()
    if _ami:
        await _ami.stop()


def reload_bindings() -> None:
    # Runs in a worker thread: build a new dict and swap it in, so the event loop never
    # sees a half-filled cache.
    global _bindings
    fresh: Dict[str, List[dict]] = {}
    for row in list_sip_push_bindings():
        fresh.setdefault(row["extension"], []).append(row)
    _bindings = fresh


def _remember(extension: str, pn: Dict[str, str], uri: str, user_agent: str = "") -> None:
    """Store a binding seen in a Contact (blocking: run in a thread)."""
    upsert_sip_push_binding(extension, pn["provider"], pn["prid"], pn["param"], uri, user_agent or None)
    reload_bindings()


def _on_contact_status(ev: Dict[str, str]) -> None:
    status = ev.get("ContactStatus", "")
    uri = ev.get("URI", "")
    extension = ev.get("AOR") or ev.get("EndpointName") or ""
    if status not in ("Created", "Reachable") or not extension:
        return
    pn = parse_pn_params(uri)
    if status == "Created" and _is_mobile(uri, ""):
        _registered_at[extension] = time.monotonic()
    if pn:
        asyncio.get_running_loop().run_in_executor(None, _remember, extension, pn, uri, "")


async def _sync_loop() -> None:
    while True:
        try:
            if _ami and await _wait_connected(10):
                await sync_contacts()
        except asyncio.CancelledError:
            raise
        except Exception as e:
            log.debug("RFC 8599 contact sync error: %s", e)
        await asyncio.sleep(SYNC_INTERVAL)


async def _wait_connected(timeout: float) -> bool:
    try:
        await asyncio.wait_for(_ami.connected.wait(), timeout)
        return True
    except asyncio.TimeoutError:
        return False


async def sync_contacts() -> int:
    """Learn the bindings of every currently registered contact. Returns how many it saw."""
    if not _ami:
        return 0
    res = await _ami.action("PJSIPShowContacts", timeout=10)
    seen = 0
    for ev in (res or {}).get("events", []):
        if ev.get("Event") != "ContactList":
            continue
        uri = str(ev.get("Uri", ""))
        pn = parse_pn_params(uri)
        extension = str(ev.get("Aor") or ev.get("Endpoint") or "")
        if pn and extension:
            await asyncio.to_thread(_remember, extension, pn, uri, str(ev.get("UserAgent", "")))
            seen += 1
    return seen


async def _contacts(extension: str) -> Optional[List[dict]]:
    """The extension's registered contacts as {id, uri, user_agent, expires}; None when AMI
    could not answer (as opposed to [] for no contacts)."""
    if not _ami:
        return None
    res = await _ami.action("PJSIPShowEndpoint", {"Endpoint": extension}, timeout=2.5)
    if res is None:
        return None
    contacts = []
    for ev in res.get("events", []):
        if ev.get("Event") != "ContactStatusDetail":
            continue
        try:
            expires = int(ev.get("RegExpire") or 0)
        except ValueError:
            expires = 0
        contacts.append({
            "id": str(ev.get("ID") or ev.get("URI") or ""),
            "uri": str(ev.get("URI", "")),
            "user_agent": str(ev.get("UserAgent", "")),
            "expires": expires,
        })
    return contacts


def _expire_pending() -> None:
    now = time.monotonic()
    for uid in [u for u, p in _pending.items() if now - p["started"] > PENDING_TTL]:
        _pending.pop(uid, None)


def has_bindings(extension: str) -> bool:
    return bool(_bindings.get(extension))


def bindings_for(extension: str) -> List[dict]:
    return list(_bindings.get(extension, []))


def _call_data(extension: str, caller: str, caller_name: str, host: str) -> dict:
    return {
        "type": "call",
        "caller_uri": f"sip:{caller}@{host}" if caller and host else caller,
        "caller_name": caller_name or caller,
        "aor": f"sip:{extension}@{host}" if host else extension,
    }


async def wake(extension: str, uid: str, caller: str, caller_name: str, hold_seconds: int) -> bool:
    """Pre-dial wake. True means a push went out and the dialplan should hold the call
    and poll ready(); false (no binding, or no provider configured for it) lets the call
    ring at once. Legacy app-registered tokens (POST /api/device-tokens) are woken too,
    through push_service.send_call_wake."""
    _expire_pending()
    bindings = bindings_for(extension)
    legacy = await asyncio.to_thread(get_device_tokens_for_extension, extension)
    if not push_service.can_wake(bindings, legacy):
        return False

    contacts = await _contacts(extension)
    pending = {
        "extension": extension,
        "started": time.monotonic(),
        "baseline": {c["id"]: c["expires"] for c in contacts or []},
        "baseline_known": contacts is not None,
        "bindings": bindings,
        "any_contact": not bindings,   # legacy-only: any (re-)registration counts
    }
    _pending[uid or f"{extension}-{time.monotonic()}"] = pending

    host = await asyncio.to_thread(public_host)
    if bindings:
        asyncio.create_task(push_service.send_rfc8599(
            bindings, _call_data(extension, caller, caller_name, host),
            ttl_seconds=hold_seconds, collapse_id=uid or None,
        ))
    if legacy:
        asyncio.create_task(push_service.send_call_wake(extension, caller, f"predial-{extension}", caller_name or None))
    return True


async def ready(uid: str) -> bool:
    """Has a mobile contact registered since the wake's push? Unknown uid: true, so a
    call is never held for a wake OpDesk no longer knows about."""
    p = _pending.get(uid)
    if p is None:
        return True
    extension = p["extension"]
    if _registered_at.get(extension, 0.0) > p["started"]:
        return True
    contacts = await _contacts(extension)
    for c in contacts or []:
        if not (p["any_contact"] or _is_mobile(c["uri"], c["user_agent"])):
            continue
        before = p["baseline"].get(c["id"])
        if not p["baseline_known"] or before is None or c["expires"] > before:
            pn = parse_pn_params(c["uri"])
            if pn:
                asyncio.get_running_loop().run_in_executor(None, _remember, extension, pn, c["uri"], c["user_agent"])
            return True
    return False


def done(uid: str) -> None:
    """The call was released to the dialplan: nothing to cancel."""
    _pending.pop(uid, None)


async def cancel(uid: str) -> None:
    """The caller hung up during the hold, or the hold ran out: stop the phone ringing."""
    p = _pending.pop(uid, None)
    if not p or not p["bindings"]:
        return
    host = await asyncio.to_thread(public_host)
    extension = p["extension"]
    await push_service.send_rfc8599(
        p["bindings"], {"type": "cancel", "aor": f"sip:{extension}@{host}" if host else extension},
    )


async def ring(extension: str, caller: str, caller_name: str) -> None:
    """DialBegin fallback for a call that did not pass the pre-dial hook (an inbound route
    straight to the extension): push so a backgrounded app answers the INVITE that is
    already on its way."""
    bindings = bindings_for(extension)
    if not bindings or not is_enabled():
        return
    host = await asyncio.to_thread(public_host)
    await push_service.send_rfc8599(bindings, _call_data(extension, caller, caller_name, host), ttl_seconds=20)
