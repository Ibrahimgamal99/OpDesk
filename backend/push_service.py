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

  send_rfc8599(...)    RFC 8599 push to the pn-provider / pn-prid / pn-param a softphone put in its
                       REGISTER Contact (see sip_push.py). The provider, the APNs host and topic
                       come from the binding itself, not from an app-side token API.

Providers: FCM HTTP v1 (Android) and direct APNs HTTP/2 with token-based auth (iOS).

This module is a NO-OP when its settings are unset or its optional dependencies are missing, so
web-only / dev deployments are unaffected. A push failure is logged and never propagates to the
caller (the AMI/WebSocket path must not break because a phone is unreachable).

Config: Settings -> Mobile Wake (OpDesk DB), falling back to the .env variables
    FCM_PROJECT_ID, FCM_SERVICE_ACCOUNT_FILE
    APNS_AUTH_KEY_FILE, APNS_KEY_ID, APNS_TEAM_ID, APNS_BUNDLE_ID, APNS_USE_SANDBOX
    VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT
"""

import asyncio
import json
import logging
import os
import time
from typing import Any, Callable, Optional

import httpx

from db_manager import (
    get_device_tokens_for_extension, delete_device_token, delete_sip_push_bindings_by_prid,
    get_setting as _get_setting,
)

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

try:
    from pywebpush import webpush as _webpush, WebPushException as _WebPushException
except ImportError:  # pragma: no cover
    _webpush = None
    _WebPushException = Exception


# =============================================================================
# Configuration
# =============================================================================
# Settings → Mobile Wake writes these to the OpDesk DB, so keys can be uploaded from the UI.
# Each falls back to the older .env variable, so existing installs keep working untouched.
# The service-account JSON and the .p8 key are stored as their contents, not as paths, so a
# Docker rebuild does not lose them.

_FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging"
_APNS_HOSTS = {False: "https://api.push.apple.com", True: "https://api.sandbox.push.apple.com"}

_config: Optional[dict] = None


def _setting(key: str, env: str = "", default: str = "") -> str:
    value = None
    if key and _get_setting is not None:
        try:
            value = _get_setting(key, None)
        except Exception:
            value = None
    if value in (None, ""):
        value = os.getenv(env, default) if env else default
    return (value or "").strip()


def _read_file(path: str) -> str:
    if not path:
        return ""
    try:
        with open(path, "r") as f:
            return f.read()
    except FileNotFoundError:
        # The installer writes placeholder paths into .env; a missing file just means unset.
        log.info(f"Push key file {path} not found; that provider stays off unless set in Settings")
        return ""
    except OSError as e:
        log.warning(f"⚠️  Push key file {path} unreadable: {e}")
        return ""


def _truthy(value: str) -> bool:
    return value.strip().lower() in ("1", "true", "yes", "on")


def _load_config() -> dict:
    sa_text = _setting("PUSH_FCM_SERVICE_ACCOUNT")
    sa_source = "ui" if sa_text else None
    if not sa_text:
        sa_text = _read_file(_setting("", "FCM_SERVICE_ACCOUNT_FILE"))
        sa_source = "env" if sa_text else None
    try:
        sa_info = parse_service_account(sa_text) if sa_text else None
    except ValueError as e:
        log.warning(f"⚠️  FCM service account ignored: {e}")
        sa_info, sa_source = None, None

    p8 = _setting("PUSH_APNS_AUTH_KEY")
    p8_source = "ui" if p8 else None
    if not p8:
        p8 = _read_file(_setting("", "APNS_AUTH_KEY_FILE")).strip()
        p8_source = "env" if p8 else None

    return {
        "fcm_project_id": _setting("PUSH_FCM_PROJECT_ID", "FCM_PROJECT_ID") or (sa_info or {}).get("project_id", ""),
        "fcm_sa_info": sa_info,
        "fcm_sa_source": sa_source,
        "apns_key_id": _setting("PUSH_APNS_KEY_ID", "APNS_KEY_ID"),
        "apns_team_id": _setting("PUSH_APNS_TEAM_ID", "APNS_TEAM_ID"),
        "apns_bundle_id": _setting("PUSH_APNS_BUNDLE_ID", "APNS_BUNDLE_ID"),
        "apns_key_pem": p8,
        "apns_key_source": p8_source,
        "apns_sandbox": _truthy(_setting("PUSH_APNS_SANDBOX", "APNS_USE_SANDBOX", "false")),
        "vapid_public": _setting("PUSH_VAPID_PUBLIC_KEY", "VAPID_PUBLIC_KEY"),
        "vapid_private": _setting("PUSH_VAPID_PRIVATE_KEY", "VAPID_PRIVATE_KEY"),
        "vapid_subject": _setting("PUSH_VAPID_SUBJECT", "VAPID_SUBJECT") or "mailto:admin@opdesk.local",
    }


def _cfg() -> dict:
    global _config
    if _config is None:
        _config = _load_config()
    return _config


def reload_config() -> None:
    """Re-read the push settings and drop every cached credential. Blocking (DB reads):
    call it via asyncio.to_thread() from async code, after the settings were saved."""
    global _config, _fcm_credentials, _apns_key_content
    _config = _load_config()
    _fcm_credentials = None
    _apns_key_content = None
    _apns_jwt_cache.update(token=None, exp=0.0)


def parse_service_account(text: str) -> dict:
    """Validate a Firebase service-account key file; raises ValueError with the reason."""
    try:
        info = json.loads(text)
    except (ValueError, TypeError):
        raise ValueError("not valid JSON")
    if not isinstance(info, dict) or info.get("type") != "service_account":
        raise ValueError('not a service-account key ("type" must be "service_account")')
    missing = [k for k in ("project_id", "private_key", "client_email") if not info.get(k)]
    if missing:
        raise ValueError(f"missing {', '.join(missing)}")
    return info


def validate_apns_key(text: str) -> str:
    """Validate an APNs .p8 auth key (PEM, EC P-256); returns it trimmed or raises ValueError."""
    pem = (text or "").strip()
    if "BEGIN PRIVATE KEY" not in pem:
        raise ValueError("not a .p8 key (no BEGIN PRIVATE KEY block)")
    try:
        from cryptography.hazmat.primitives.serialization import load_pem_private_key
        from cryptography.hazmat.primitives.asymmetric import ec
        key = load_pem_private_key(pem.encode(), password=None)
    except Exception:
        raise ValueError("the key could not be read")
    if not isinstance(key, ec.EllipticCurvePrivateKey) or key.curve.name != "secp256r1":
        raise ValueError("APNs keys are EC P-256; this is a different kind of key")
    return pem


def config_status() -> dict:
    """What the admin UI shows: identifiers and whether each secret is present, never the secrets."""
    c = _cfg()
    sa = c["fcm_sa_info"] or {}
    return {
        "fcm": {
            "project_id": c["fcm_project_id"],
            "has_service_account": bool(sa),
            "service_account_email": sa.get("client_email", ""),
            "service_account_project": sa.get("project_id", ""),
            "source": c["fcm_sa_source"],
            "ready": fcm_enabled(),
        },
        "apns": {
            "key_id": c["apns_key_id"],
            "team_id": c["apns_team_id"],
            "bundle_id": c["apns_bundle_id"],
            "has_auth_key": bool(c["apns_key_pem"]),
            "source": c["apns_key_source"],
            "sandbox": c["apns_sandbox"],
            "ready": apns_enabled(),
        },
        "web": {
            "public_key": c["vapid_public"],
            "ready": web_push_enabled(),
            "library_installed": _webpush is not None,
        },
    }


def generate_vapid_keys() -> tuple:
    """New VAPID P-256 key pair as (public, private), both base64url: the public key is the
    uncompressed point (the browser's applicationServerKey), the private key the raw scalar."""
    import base64
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import ec

    def b64url(data: bytes) -> str:
        return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")

    key = ec.generate_private_key(ec.SECP256R1())
    private = b64url(key.private_numbers().private_value.to_bytes(32, "big"))
    public = b64url(key.public_key().public_bytes(
        serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint))
    return public, private


# --- Web Push (VAPID) --------------------------------------------------------
def _vapid_public_key() -> str:
    return _cfg()["vapid_public"]


def _vapid_private_key() -> str:
    return _cfg()["vapid_private"]


def _vapid_subject() -> str:
    return _cfg()["vapid_subject"]


def web_push_enabled() -> bool:
    """Web Push is available only when pywebpush is installed and VAPID keys are set.
    Everything degrades to a no-op otherwise, so the feature is opt-in and safe."""
    return bool(_webpush is not None and _vapid_public_key() and _vapid_private_key())


def _send_web_push(subscription_json: str, payload: dict) -> bool:
    """Send one Web Push message to a stored browser subscription (JSON string).
    Returns True on success. Deletes the stored token on a 404/410 (expired sub)."""
    if not web_push_enabled():
        return False
    try:
        subscription = json.loads(subscription_json)
    except (ValueError, TypeError):
        return False
    try:
        _webpush(
            subscription_info=subscription,
            data=json.dumps(payload),
            vapid_private_key=_vapid_private_key(),
            vapid_claims={"sub": _vapid_subject()},
            ttl=30,
        )
        return True
    except _WebPushException as e:  # pragma: no cover - network dependent
        status = getattr(getattr(e, "response", None), "status_code", None)
        if status in (404, 410):
            # Subscription is gone — drop it so we stop trying.
            try:
                delete_device_token(subscription_json)
            except Exception:
                pass
        else:
            log.warning(f"Web push failed: {type(e).__name__}")
        return False
    except Exception as e:  # pragma: no cover
        log.warning(f"Web push error: {type(e).__name__}")
        return False


def fcm_enabled() -> bool:
    c = _cfg()
    return bool(c["fcm_project_id"] and c["fcm_sa_info"] and _gsa is not None)


def apns_enabled() -> bool:
    c = _cfg()
    return bool(
        c["apns_key_pem"] and c["apns_key_id"] and c["apns_team_id"] and c["apns_bundle_id"]
        and _pyjwt is not None
    )


def _apns_host(sandbox: Optional[bool] = None) -> str:
    return _APNS_HOSTS[_cfg()["apns_sandbox"] if sandbox is None else sandbox]


# =============================================================================
# Cached credentials
# =============================================================================

_fcm_credentials = None            # google.oauth2.service_account.Credentials
_apns_jwt_cache = {"token": None, "exp": 0.0}
_apns_key_content: Optional[str] = None   # Cached .p8 key — read once per config load
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
            _fcm_credentials = _gsa.Credentials.from_service_account_info(
                _cfg()["fcm_sa_info"], scopes=[_FCM_SCOPE]
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
        c = _cfg()
        if _apns_key_content is None:
            _apns_key_content = c["apns_key_pem"]
        token = _pyjwt.encode(
            {"iss": c["apns_team_id"], "iat": int(now)},
            _apns_key_content,
            algorithm="ES256",
            headers={"alg": "ES256", "kid": c["apns_key_id"]},
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

async def _send_fcm(token: str, message: dict, on_dead: Optional[Callable[[str], Any]] = None) -> None:
    """Send one FCM HTTP v1 message. `message` is the inner object (without the 'token' field).
    `on_dead(token)` runs when FCM says the token is gone (default: drop it from device_tokens)."""
    access_token = await _get_fcm_access_token()
    if not access_token:
        return
    url = f"https://fcm.googleapis.com/v1/projects/{_cfg()['fcm_project_id']}/messages:send"
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
            await asyncio.to_thread(on_dead or delete_device_token, token)
        log.warning(f"⚠️  FCM send failed ({resp.status_code}): {body[:300]}")
    except Exception as e:
        log.warning(f"⚠️  FCM send error: {e}")


async def _send_apns(
    token: str,
    payload: dict,
    push_type: str,
    topic: str,
    collapse_id: Optional[str] = None,
    sandbox: Optional[bool] = None,
    on_dead: Optional[Callable[[str], Any]] = None,
) -> None:
    """Send one APNs HTTP/2 request. push_type: 'voip' | 'alert' | 'background'.
    `sandbox` overrides the configured APNs host; `on_dead(token)` runs when Apple says the
    token is gone (default: drop it from device_tokens)."""
    provider_jwt = _get_apns_jwt()
    if not provider_jwt:
        return
    url = f"{_apns_host(sandbox)}/3/device/{token}"
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
            await asyncio.to_thread(on_dead or delete_device_token, token)
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
    bundle_id = _cfg()["apns_bundle_id"]

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
    if not fcm_enabled() and not apns_enabled() and not web_push_enabled():
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
    bundle_id = _cfg()["apns_bundle_id"]

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
        elif platform == "web" and web_push_enabled():
            # Browser Web Push (the `token` holds the JSON subscription).
            tasks.append(asyncio.to_thread(_send_web_push, token, data))

    if tasks:
        await asyncio.gather(*tasks, return_exceptions=True)


async def send_alert(extension: str, title: str, body: str, data: dict) -> None:
    """Send a normal banner notification (e.g. missed call) to the device(s) for `extension`."""
    if not fcm_enabled() and not apns_enabled() and not web_push_enabled():
        return
    tokens = await asyncio.to_thread(get_device_tokens_for_extension, extension, "alert")
    if not tokens:
        return

    # FCM data values must be strings.
    str_data = {k: str(v) for k, v in (data or {}).items()}
    bundle_id = _cfg()["apns_bundle_id"]

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
        elif platform == "web" and web_push_enabled():
            tasks.append(asyncio.to_thread(_send_web_push, token, {"type": "alert", "title": title, "body": body, **str_data}))

    if tasks:
        await asyncio.gather(*tasks, return_exceptions=True)


# =============================================================================
# RFC 8599 (push for SIP bindings)
# =============================================================================

def _apns_topic(pn_param: Optional[str]) -> str:
    """RFC 8599 §9.3: an APNs pn-param is "<Team ID>.<topic>", e.g.
    DEF123GHIJ.com.example.app.voip. Without one, the topic is <bundle id>.voip."""
    param = (pn_param or "").strip()
    if param:
        team, _, topic = param.partition(".")
        if topic and len(team) == 10 and team.isalnum():
            return topic
        return param
    return f"{_cfg()['apns_bundle_id']}.voip"


def _rfc8599_sendable(row: dict) -> bool:
    """Whether a "call" push to this binding can go out with the current configuration."""
    provider = (row.get("pn_provider") or "").strip().lower()
    if provider == "fcm":
        param = (row.get("pn_param") or "").strip()
        return fcm_enabled() and (not param or param == _cfg()["fcm_project_id"])
    return provider in ("apns", "apns-sandbox") and apns_enabled()


def can_wake(bindings: list, legacy_tokens: list) -> bool:
    """True when at least one call push could actually be sent, so holding a call for the
    phone to wake up is worth it. With no provider configured the call rings at once."""
    if any(_rfc8599_sendable(b) for b in bindings):
        return True
    for row in legacy_tokens:
        platform, token_type = row.get("platform"), row.get("token_type")
        if ((platform == "android" and fcm_enabled())
                or (platform == "ios" and token_type == "voip" and apns_enabled())
                or (platform == "web" and web_push_enabled())):
            return True
    return False


def _drop_binding(provider: str) -> Callable[[str], Any]:
    def drop(prid: str) -> None:
        if delete_sip_push_bindings_by_prid(provider, prid):
            log.info(f"Dropped RFC 8599 binding(s) for a dead {provider} token")
    return drop


async def send_rfc8599(bindings: list, data: dict, ttl_seconds: int = 0, collapse_id: Optional[str] = None) -> int:
    """
    Push `data` to RFC 8599 bindings (rows of {pn_provider, pn_prid, pn_param}). `data["type"]`
    is "call" or "cancel". Returns how many pushes were sent.

      fcm           high-priority data-only message (a notification message would not run the
                    app's code); pn-param is the Firebase project ID and must be ours.
      apns          VoIP push on the production host (the sandbox host while "Use APNs sandbox"
                    is on); topic from pn-param, else <bundle id>.voip.
      apns-sandbox  the same on the sandbox host: a sandbox token fails silently anywhere else.

    A "cancel" is never sent over APNs: iOS kills an app that gets a VoIP push without
    reporting a CallKit call, and the iOS SDK does not take cancel pushes yet.
    """
    kind = data.get("type")
    str_data = {k: str(v) for k, v in data.items() if v is not None}
    tasks = []
    seen = set()
    for row in bindings:
        provider = (row.get("pn_provider") or "").strip().lower()
        prid = (row.get("pn_prid") or "").strip()
        param = (row.get("pn_param") or "").strip()
        if not provider or not prid or (provider, prid) in seen:
            continue
        seen.add((provider, prid))
        if provider == "fcm":
            if not fcm_enabled():
                continue
            if not _rfc8599_sendable(row):
                log.warning(f"⚠️  FCM binding is for project {param!r}, OpDesk sends as "
                            f"{_cfg()['fcm_project_id']!r}: skipped")
                continue
            tasks.append(_send_fcm(
                prid,
                {"data": str_data, "android": {"priority": "high", "ttl": f"{max(0, int(ttl_seconds))}s"}},
                on_dead=_drop_binding(provider),
            ))
        elif provider in ("apns", "apns-sandbox"):
            if not apns_enabled() or kind != "call":
                continue
            tasks.append(_send_apns(
                prid, dict(str_data), push_type="voip", topic=_apns_topic(param),
                collapse_id=collapse_id,
                sandbox=True if provider == "apns-sandbox" else None,
                on_dead=_drop_binding(provider),
            ))
        else:
            log.debug(f"RFC 8599 provider {provider!r} not supported; binding skipped")
    if tasks:
        await asyncio.gather(*tasks, return_exceptions=True)
    return len(tasks)
