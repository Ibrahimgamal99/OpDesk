#!/usr/bin/env python3
"""
Push notification dispatch for the OpDesk mobile softphone integration.

Two delivery paths, both backend-initiated:

  send_call_wake(...)  Incoming-call wake. Time-critical. Wakes a backgrounded/killed app so it can
                       show the native call UI (CallKit / ConnectionService) and register SIP-over-WSS
                       to take the call. iOS -> APNs VoIP push (PushKit token, apns-push-type: voip).
                       Android -> high-priority data-only FCM message.

  send_alert(...)      Missed-call / general banner. Best-effort. iOS -> APNs alert push.
                       Android -> FCM notification message.

Providers: FCM HTTP v1 (Android) and direct APNs HTTP/2 with token-based auth (iOS).

This module is a NO-OP when its env vars are unset or its optional dependencies are missing, so
web-only / dev deployments are unaffected. A push failure is logged and never propagates to the
caller (the AMI/WebSocket path must not break because a phone is unreachable).

Config (.env):
    FCM_PROJECT_ID, FCM_SERVICE_ACCOUNT_FILE
    APNS_AUTH_KEY_FILE, APNS_KEY_ID, APNS_TEAM_ID, APNS_BUNDLE_ID, APNS_USE_SANDBOX
"""

import asyncio
import json
import logging
import os
import time
from typing import Optional

import httpx

from db_manager import get_device_tokens_for_extension, delete_device_token

log = logging.getLogger(__name__)

# --- Optional dependencies (import lazily / defensively) ---------------------
try:
    import jwt as _pyjwt  # PyJWT — already a core dependency
except ImportError:  # pragma: no cover
    _pyjwt = None

try:
    from google.oauth2 import service_account as _gsa
    from google.auth.transport.requests import Request as _GoogleAuthRequest
except ImportError:  # pragma: no cover
    _gsa = None
    _GoogleAuthRequest = None


# =============================================================================
# Configuration helpers
# =============================================================================

_FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging"


def _fcm_project_id() -> str:
    return (os.getenv("FCM_PROJECT_ID", "") or "").strip()


def _fcm_service_account_file() -> str:
    return (os.getenv("FCM_SERVICE_ACCOUNT_FILE", "") or "").strip()


def fcm_enabled() -> bool:
    return bool(_fcm_project_id() and _fcm_service_account_file() and _gsa is not None)


def apns_enabled() -> bool:
    return bool(
        (os.getenv("APNS_AUTH_KEY_FILE", "") or "").strip()
        and (os.getenv("APNS_KEY_ID", "") or "").strip()
        and (os.getenv("APNS_TEAM_ID", "") or "").strip()
        and (os.getenv("APNS_BUNDLE_ID", "") or "").strip()
        and _pyjwt is not None
    )


def _apns_host() -> str:
    sandbox = (os.getenv("APNS_USE_SANDBOX", "false") or "").strip().lower() in ("1", "true", "yes")
    return "https://api.sandbox.push.apple.com" if sandbox else "https://api.push.apple.com"


# =============================================================================
# Cached credentials
# =============================================================================

_fcm_credentials = None            # google.oauth2.service_account.Credentials
_apns_jwt_cache = {"token": None, "exp": 0.0}
_apns_key_content: Optional[str] = None   # Cached .p8 key — read once, never again
_http_client: Optional[httpx.AsyncClient] = None  # HTTP/2 client shared by FCM + APNs


def _get_http_client() -> httpx.AsyncClient:
    global _http_client
    if _http_client is None or _http_client.is_closed:
        _http_client = httpx.AsyncClient(http2=True, timeout=10.0)
    return _http_client


async def close() -> None:
    """Close the shared HTTP client (call on app shutdown)."""
    global _http_client
    if _http_client is not None and not _http_client.is_closed:
        await _http_client.aclose()
    _http_client = None


def _refresh_fcm_credentials_sync() -> Optional[str]:
    """Blocking FCM credential fetch/refresh — called via asyncio.to_thread() to avoid blocking the loop."""
    global _fcm_credentials
    if not fcm_enabled():
        return None
    try:
        if _fcm_credentials is None:
            _fcm_credentials = _gsa.Credentials.from_service_account_file(
                _fcm_service_account_file(), scopes=[_FCM_SCOPE]
            )
        if not _fcm_credentials.valid:
            _fcm_credentials.refresh(_GoogleAuthRequest())
        return _fcm_credentials.token
    except Exception as e:
        log.warning(f"⚠️  FCM access token error: {e}")
        return None


async def _get_fcm_access_token() -> Optional[str]:
    """Return a cached OAuth2 access token for FCM HTTP v1 (non-blocking)."""
    return await asyncio.to_thread(_refresh_fcm_credentials_sync)


def _get_apns_jwt() -> Optional[str]:
    """Return a cached ES256 provider JWT for APNs token-based auth (valid ~1h, refreshed at 50m)."""
    global _apns_key_content
    if not apns_enabled():
        return None
    now = time.time()
    if _apns_jwt_cache["token"] and now < _apns_jwt_cache["exp"]:
        return _apns_jwt_cache["token"]
    try:
        if _apns_key_content is None:
            key_file = (os.getenv("APNS_AUTH_KEY_FILE", "") or "").strip()
            with open(key_file, "r") as f:
                _apns_key_content = f.read()
        token = _pyjwt.encode(
            {"iss": os.getenv("APNS_TEAM_ID", "").strip(), "iat": int(now)},
            _apns_key_content,
            algorithm="ES256",
            headers={"alg": "ES256", "kid": os.getenv("APNS_KEY_ID", "").strip()},
        )
        _apns_jwt_cache["token"] = token
        _apns_jwt_cache["exp"] = now + 50 * 60
        return token
    except Exception as e:
        log.warning(f"⚠️  APNs JWT signing error: {e}")
        return None


# =============================================================================
# Low-level senders
# =============================================================================

async def _send_fcm(token: str, message: dict) -> None:
    """Send one FCM HTTP v1 message. `message` is the inner object (without the 'token' field)."""
    access_token = await _get_fcm_access_token()
    if not access_token:
        return
    url = f"https://fcm.googleapis.com/v1/projects/{_fcm_project_id()}/messages:send"
    payload = {"message": {"token": token, **message}}
    try:
        resp = await _get_http_client().post(
            url,
            headers={"Authorization": f"Bearer {access_token}", "Content-Type": "application/json"},
            json=payload,
        )
        if resp.status_code == 200:
            return
        body = resp.text or ""
        # Only prune on UNREGISTERED or 404 — INVALID_ARGUMENT also covers malformed payloads
        # and should not be treated as a dead-token signal.
        if "UNREGISTERED" in body or resp.status_code == 404:
            log.info("Pruning stale FCM token")
            await asyncio.to_thread(delete_device_token, token)
        log.warning(f"⚠️  FCM send failed ({resp.status_code}): {body[:300]}")
    except Exception as e:
        log.warning(f"⚠️  FCM send error: {e}")


async def _send_apns(
    token: str,
    payload: dict,
    push_type: str,
    topic: str,
    collapse_id: Optional[str] = None,
) -> None:
    """Send one APNs HTTP/2 request. push_type: 'voip' | 'alert'."""
    provider_jwt = _get_apns_jwt()
    if not provider_jwt:
        return
    url = f"{_apns_host()}/3/device/{token}"
    is_voip = push_type == "voip"
    headers = {
        "authorization": f"bearer {provider_jwt}",
        "apns-topic": topic,
        "apns-push-type": push_type,
        # voip: immediate; background: 5 (Apple rejects priority 10 for background);
        # alert: energy-efficient 5.
        "apns-priority": "10" if is_voip else "5",
        # voip + background: expire immediately — a stale wake or phantom call UI is
        # worse than a missed push.  Alert banners: 24-hour delivery window.
        "apns-expiration": "0" if (is_voip or push_type == "background") else str(int(time.time()) + 86400),
    }
    if collapse_id:
        # Collapse duplicate wakes for the same call so only the latest is delivered.
        headers["apns-collapse-id"] = collapse_id
    try:
        resp = await _get_http_client().post(url, headers=headers, content=json.dumps(payload))
        if resp.status_code == 200:
            return
        # 410 Gone / 400 BadDeviceToken => token is dead, prune it.
        reason = ""
        try:
            reason = (resp.json() or {}).get("reason", "")
        except Exception:
            reason = resp.text or ""
        if resp.status_code == 410 or reason in ("BadDeviceToken", "Unregistered"):
            log.info("Pruning stale APNs token")
            await asyncio.to_thread(delete_device_token, token)
        log.warning(f"⚠️  APNs send failed ({resp.status_code}): {reason}")
    except Exception as e:
        log.warning(f"⚠️  APNs send error: {e}")


# =============================================================================
# Public API
# =============================================================================

async def send_pre_wake(extension: str, caller: str) -> None:
    """
    Silent background push that wakes a killed/backgrounded app so it can
    re-register SIP BEFORE the real VoIP push arrives.

    Critically, this must NOT create a CallKit / ConnectionService call UI:
      iOS  — APNs background push (content-available:1, priority 5) sent on the
             *alert* token using the plain bundle-id topic.  The VoIP/PushKit
             path is intentionally avoided: PushKit pushes mandate CallKit
             reporting, and a second reportNewIncomingCall() on a different UUID
             would give the user two call screens — and, worse, misroute the
             end-call event so no SIP BYE is ever sent.
      Android — FCM high-priority data message with type=pre_wake.  The app
             should register SIP on receipt but must not present
             ConnectionService UI until the follow-up type=incoming_call push.
    """
    if not fcm_enabled() and not apns_enabled():
        return
    all_tokens = await asyncio.to_thread(get_device_tokens_for_extension, extension)
    if not all_tokens:
        return

    data = {"type": "pre_wake", "extension": str(extension), "caller": str(caller or "")}
    bundle_id = (os.getenv("APNS_BUNDLE_ID", "") or "").strip()

    tasks = []
    seen_tokens: set = set()
    for row in all_tokens:
        platform = row.get("platform")
        token_type = row.get("token_type")
        token = row.get("token")
        if not token or token in seen_tokens:
            continue
        seen_tokens.add(token)
        if platform == "android" and fcm_enabled():
            tasks.append(_send_fcm(token, {"data": data, "android": {"priority": "high", "ttl": "0s"}}))
        elif platform == "ios" and token_type == "alert" and apns_enabled():
            # Use the regular alert token + bundle topic (NOT the VoIP topic).
            # content-available:1 wakes the app in the background; no CallKit call is created.
            payload = {"aps": {"content-available": 1}, **data}
            tasks.append(_send_apns(token, payload, push_type="background", topic=bundle_id))

    if tasks:
        await asyncio.gather(*tasks, return_exceptions=True)


async def send_call_wake(
    extension: str,
    caller: str,
    call_id: str,
    display_name: Optional[str] = None,
) -> None:
    """
    Wake the device(s) registered to `extension` for an incoming call. Uses VoIP/high-priority push
    so a backgrounded or killed app can present CallKit/ConnectionService and register SIP to answer.

    iOS: APNs VoIP push sent only to tokens with token_type='voip' (PushKit requirement).
    Android: high-priority FCM sent to any registered token — Android has no PushKit distinction,
    so the FCM token registered as 'alert' is equally valid for call wakes.
    """
    if not fcm_enabled() and not apns_enabled():
        return
    # Fetch all tokens for the extension; we filter by platform + token_type below.
    all_tokens = await asyncio.to_thread(get_device_tokens_for_extension, extension)
    if not all_tokens:
        return

    data = {
        "type": "incoming_call",
        "extension": str(extension),
        "caller": str(caller or ""),
        "call_id": str(call_id or ""),
        "display_name": str(display_name or caller or ""),
    }
    bundle_id = (os.getenv("APNS_BUNDLE_ID", "") or "").strip()

    tasks = []
    seen_tokens: set = set()
    for row in all_tokens:
        platform = row.get("platform")
        token_type = row.get("token_type")
        token = row.get("token")
        if not token or token in seen_tokens:
            continue
        seen_tokens.add(token)
        if platform == "android" and fcm_enabled():
            # TTL=0: discard if device is offline — avoid a phantom incoming-call UI after hang-up.
            tasks.append(_send_fcm(token, {"data": data, "android": {"priority": "high", "ttl": "0s"}}))
        elif platform == "ios" and token_type == "voip" and apns_enabled():
            # PushKit VoIP topic; collapse-id deduplicates retries for the same call.
            tasks.append(_send_apns(
                token, data, push_type="voip", topic=f"{bundle_id}.voip", collapse_id=call_id
            ))

    if tasks:
        await asyncio.gather(*tasks, return_exceptions=True)


async def send_alert(extension: str, title: str, body: str, data: dict) -> None:
    """Send a normal banner notification (e.g. missed call) to the device(s) for `extension`."""
    if not fcm_enabled() and not apns_enabled():
        return
    tokens = await asyncio.to_thread(get_device_tokens_for_extension, extension, "alert")
    if not tokens:
        return

    # FCM data values must be strings.
    str_data = {k: str(v) for k, v in (data or {}).items()}
    bundle_id = (os.getenv("APNS_BUNDLE_ID", "") or "").strip()

    tasks = []
    for row in tokens:
        platform = row.get("platform")
        token = row.get("token")
        if not token:
            continue
        if platform == "android" and fcm_enabled():
            tasks.append(_send_fcm(token, {"notification": {"title": title, "body": body}, "data": str_data}))
        elif platform == "ios" and apns_enabled():
            payload = {"aps": {"alert": {"title": title, "body": body}, "sound": "default"}, **str_data}
            tasks.append(_send_apns(token, payload, push_type="alert", topic=bundle_id))

    if tasks:
        await asyncio.gather(*tasks, return_exceptions=True)
