#!/usr/bin/env python3
"""
Contact-name resolution.

ContactResolver resolves a caller number to a contact name from the contacts
table (loaded into an in-memory dict — resolution runs on every broadcast tick
and must never touch the DB). On a miss it does one live GET to the CRM (via
the shared CRMConnector) and, if the CRM knows the number, saves it as a
source='crm' contact so it is a normal phonebook row from then on. A lookup
never overwrites an existing contact, so manual (admin-edited) data always
wins. Lookups are modeled on 3CX's server-side CRM integration: a [Number] URL
template, a name template of JSON paths, prefix/last-N-digits number handling
and optional phone-match verification.

Consumers:
  - AMIEventBridge._format_call_info() calls resolve_cached() on every state
    broadcast (dashboards).
  - GET /api/crm/contact awaits resolve() (softphone ring / dial).
"""

import asyncio
import logging
import re
import time
from typing import Any, Dict, Optional, Set

import db_manager
from crm import (
    CRMConnector,
    CRMLookupConfig,
    extract_json_path,
    lookup_cache_key,
    render_lookup_url,
    render_name_template,
)

log = logging.getLogger(__name__)

# Transport/HTTP-5xx failures back off shorter so a down CRM recovers quickly.
_ERROR_RETRY_SECS = 60.0
# Leak guard for the miss set; the working set (unknown numbers currently on
# calls) is tiny, so this should essentially never trigger.
_MISS_CAP = 5000


def _skip_number(raw_number: str, monitored: Optional[Set[str]] = None) -> bool:
    """Numbers we never look up: blank, internal-extension-sized, or a monitored ext."""
    raw = (raw_number or "").strip()
    if not raw:
        return True
    if monitored and raw in monitored:
        return True
    digits = re.sub(r"\D", "", raw)
    # Same heuristic ami.py uses to tell internal extensions from real numbers.
    return len(digits) <= 5


class ContactResolver:
    """Contact-name resolver. Single-event-loop use; no locks needed."""

    def __init__(self) -> None:
        self._cfg: Optional[CRMLookupConfig] = None
        self._connector: Optional[CRMConnector] = None
        # Raw (phone_key, name) rows from the contacts table, and the same
        # rekeyed per the current match_digits so a hit is one dict lookup.
        self._pairs: list = []
        self._contacts: Dict[str, str] = {}
        # key -> monotonic deadline before which we won't re-ask the CRM.
        self._miss_until: Dict[str, float] = {}
        self._tasks: Dict[str, asyncio.Task] = {}

    def set_config(self, cfg: Optional[CRMLookupConfig], connector: Optional[CRMConnector]) -> None:
        """Swap config + connector (live reload). Contacts are rekeyed so a
        changed match_digits takes effect immediately."""
        self._cfg = cfg
        self._connector = connector
        self._miss_until.clear()
        self._rebuild()

    def set_contacts(self, pairs: list) -> None:
        """Replace the contact set with (phone_key, name) rows from the DB;
        called at startup and after every contacts CRUD so edits win on the
        next broadcast tick."""
        self._pairs = list(pairs or [])
        self._rebuild()

    def _rebuild(self) -> None:
        """Re-key contacts for the current match_digits (keys must reduce the
        same way lookup keys do, or prefix variants would miss)."""
        md = self._cfg.match_digits if self._cfg else 0
        rebuilt: Dict[str, str] = {}
        for phone_key, name in self._pairs:
            key = lookup_cache_key(phone_key or "", md)
            if key and name:
                rebuilt[key] = str(name)
        self._contacts = rebuilt

    def usable(self) -> bool:
        """Whether live CRM lookups can run (contacts resolve regardless)."""
        return bool(self._cfg and self._cfg.usable() and self._connector)

    def _key(self, raw_number: str) -> str:
        return lookup_cache_key(raw_number, self._cfg.match_digits if self._cfg else 0)

    def resolve_cached(self, raw_number: str, monitored: Optional[Set[str]] = None) -> Optional[str]:
        """Memory-only resolution. INVARIANT: this runs per call-row per WS client
        per broadcast tick (<=500ms) — it must stay a dict lookup and must never
        touch the DB or HTTP. An unknown number schedules one background CRM
        fetch (deduped via self._tasks) and returns None for now."""
        if _skip_number(raw_number, monitored):
            return None
        key = self._key(raw_number)
        if not key:
            return None
        name = self._contacts.get(key)
        if name:
            return name
        if self.usable() and key not in self._tasks and self._miss_until.get(key, 0.0) <= time.monotonic():
            try:
                self._tasks[key] = asyncio.get_running_loop().create_task(self._fetch(key, raw_number))
            except RuntimeError:
                pass
        return None

    async def resolve(self, raw_number: str, monitored: Optional[Set[str]] = None) -> Optional[str]:
        """Awaitable resolution for the REST endpoint: joins the in-flight fetch
        (or starts one) instead of waiting for the next broadcast tick."""
        if _skip_number(raw_number, monitored):
            return None
        key = self._key(raw_number)
        if not key:
            return None
        name = self._contacts.get(key)
        if name:
            return name
        if not self.usable() or self._miss_until.get(key, 0.0) > time.monotonic():
            return None
        task = self._tasks.get(key)
        if task is None:
            task = asyncio.get_running_loop().create_task(self._fetch(key, raw_number))
            self._tasks[key] = task
        await asyncio.shield(task)
        return self._contacts.get(key)

    async def _fetch(self, key: str, raw_number: str) -> None:
        """One live CRM lookup; a hit becomes a source='crm' contact. Never raises."""
        cfg, connector = self._cfg, self._connector
        try:
            # How long a "no match" answer suppresses re-asking about a number.
            # Misses are not persisted (only real contacts are), so this is the
            # only guard against re-querying an unknown caller on every tick.
            miss_secs = max(1, int(cfg.ttl_hours)) * 3600
            path = render_lookup_url(cfg.url_template, raw_number, cfg.number_format)
            result = await connector.get_json(path)

            if result.get("success"):
                name = render_name_template(result.get("data"), cfg.name_template)
                if name and cfg.verify_path:
                    record_phone = extract_json_path(result.get("data"), cfg.verify_path)
                    if lookup_cache_key(record_phone or "", cfg.match_digits) != key:
                        log.info("CRM lookup: verification failed for %s (record phone mismatch)", key)
                        name = None
                if name:
                    await asyncio.to_thread(db_manager.add_crm_contact_if_new, raw_number, key, name)
                    self._contacts[key] = name
                else:
                    self._remember_miss(key, miss_secs)
            elif result.get("status_code") == 404:
                # The CRM answered "no such contact".
                self._remember_miss(key, miss_secs)
            else:
                # Transport error / 5xx: back off briefly.
                self._remember_miss(key, _ERROR_RETRY_SECS)
        except Exception as e:
            log.warning("CRM lookup failed for %s: %s", key, type(e).__name__)
            self._remember_miss(key, _ERROR_RETRY_SECS)
        finally:
            self._tasks.pop(key, None)

    def _remember_miss(self, key: str, ttl_secs: float) -> None:
        if len(self._miss_until) >= _MISS_CAP:
            # Evict the ~10% closest to expiry; effectively never runs in practice.
            for old_key, _ in sorted(self._miss_until.items(), key=lambda kv: kv[1])[: _MISS_CAP // 10]:
                self._miss_until.pop(old_key, None)
        self._miss_until[key] = time.monotonic() + max(1.0, ttl_secs)


async def run_lookup_test(connector: CRMConnector, cfg: CRMLookupConfig, raw_phone: str) -> Dict[str, Any]:
    """Run the full lookup pipeline once, bypassing the contact set. Used by
    POST /api/crm/lookup-test so an admin can debug templates without curl."""
    path = render_lookup_url(cfg.url_template, raw_phone, cfg.number_format)
    result = await connector.get_json(path)

    raw_excerpt = ""
    data = result.get("data")
    if data is not None:
        try:
            import json as _json
            raw_excerpt = _json.dumps(data, ensure_ascii=False)[:500]
        except (TypeError, ValueError):
            raw_excerpt = str(data)[:500]

    if not result.get("success"):
        return {
            "success": False,
            "status_code": result.get("status_code"),
            "name": None,
            "matched": False,
            "verify_detail": "",
            "raw_excerpt": raw_excerpt,
            "error": str(result.get("error") or "")[:300],
        }

    name = render_name_template(data, cfg.name_template)
    matched = bool(name)
    verify_detail = ""
    if name and cfg.verify_path:
        record_phone = extract_json_path(data, cfg.verify_path)
        searched_key = lookup_cache_key(raw_phone, cfg.match_digits)
        if lookup_cache_key(record_phone or "", cfg.match_digits) != searched_key:
            matched = False
            verify_detail = f"record phone {record_phone or '(empty)'} does not match searched {searched_key}"

    return {
        "success": True,
        "status_code": result.get("status_code"),
        "name": name if matched else None,
        "matched": matched,
        "verify_detail": verify_detail,
        "raw_excerpt": raw_excerpt,
        "error": None,
    }
