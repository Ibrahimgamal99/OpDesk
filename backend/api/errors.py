"""One application error type, one code registry, one status mapping (Rule 4).

Rule 4.1 requires every failure to carry a stable machine-readable `code`, a
human `message`, a `severity`, a `retryable` flag, a `trace_id`, and — for
validation failures — a `fields` array. Handlers raise `AppError`; the
middleware in api.middleware renders it. Handlers never choose a status code.

The codes below were derived from the 153 `raise HTTPException(...)` sites that
existed before this layer, so the vocabulary matches what the app actually
reports rather than an invented ideal.
"""
from __future__ import annotations

import re
from enum import Enum
from typing import Any, Iterable, Optional


class Severity(str, Enum):
    """Rule 4.1: severity maps to a UI `tone` through one lookup table."""
    INFO = "info"
    WARNING = "warning"
    ERROR = "error"
    CRITICAL = "critical"


class FieldError:
    """One entry in the Rule 4.1 `fields` array.

    `path` must match the `name` of the form control that produced it, so the
    frontend binds errors by matching instead of per-form mapping code. It is a
    JSON-ish path, so nested and indexed targets work: `items[2].quantity`.
    """

    __slots__ = ("path", "code", "message", "params")

    def __init__(self, path: str, code: str, message: str,
                 params: Optional[dict[str, Any]] = None):
        self.path = path
        self.code = code
        self.message = message
        self.params = params or {}

    def to_dict(self) -> dict[str, Any]:
        return {"path": self.path, "code": self.code,
                "message": self.message, "params": self.params}


# ---------------------------------------------------------------------------
# Code registry
# ---------------------------------------------------------------------------
# Format is `domain.resource.condition` (Rule 4.1). Codes are STABLE: clients
# switch on them, so renaming one is a breaking change. Add, don't rename.
#
# Each entry is (code, default_severity, retryable). `retryable` is the
# backend's decision, not the screen's — it drives whether a Retry button
# renders at all.
_REGISTRY: dict[str, tuple[Severity, bool]] = {}


def _reg(code: str, severity: Severity = Severity.ERROR, retryable: bool = False) -> str:
    if code in _REGISTRY:
        raise RuntimeError(f"duplicate error code: {code}")
    if not re.fullmatch(r"[a-z0-9]+(?:_[a-z0-9]+)*(?:\.[a-z0-9]+(?:_[a-z0-9]+)*){2,}", code):
        raise RuntimeError(f"code must be dotted domain.resource.condition: {code}")
    _REGISTRY[code] = (severity, retryable)
    return code


class codes:  # noqa: N801 — used as a namespace, not instantiated
    """Every error code the API can emit."""

    # -- auth ---------------------------------------------------------------
    AUTH_CREDENTIALS_INVALID = _reg("auth.credentials.invalid")
    AUTH_TOKEN_INVALID       = _reg("auth.token.invalid")
    AUTH_TOKEN_MISSING       = _reg("auth.token.missing")
    AUTH_APIKEY_INVALID      = _reg("auth.api_key.invalid")
    AUTH_APIKEY_SCOPE_MISSING = _reg("auth.api_key.scope_missing")

    # -- authorization ------------------------------------------------------
    ACCESS_ROLE_FORBIDDEN     = _reg("access.role.forbidden")
    ACCESS_ADMIN_REQUIRED     = _reg("access.role.admin_required")
    ACCESS_EXTENSION_FORBIDDEN = _reg("access.extension.forbidden")
    ACCESS_LOOPBACK_REQUIRED  = _reg("access.origin.loopback_required")

    # -- request shape -----------------------------------------------------
    REQUEST_BODY_INVALID   = _reg("request.body.invalid")
    REQUEST_FIELD_REQUIRED = _reg("request.field.required")
    REQUEST_FIELD_INVALID  = _reg("request.field.invalid")
    REQUEST_ROUTE_NOT_FOUND = _reg("request.route.not_found")
    REQUEST_METHOD_NOT_ALLOWED = _reg("request.method.not_allowed")
    REQUEST_CURSOR_INVALID = _reg("request.cursor.invalid")

    # -- user / group ------------------------------------------------------
    USER_RECORD_NOT_FOUND   = _reg("user.record.not_found")
    USER_RECORD_CONFLICT    = _reg("user.record.conflict")
    USER_EXTENSION_MISSING  = _reg("user.extension.missing")
    USER_UPDATE_FAILED      = _reg("user.record.update_failed")
    USER_DELETE_FAILED      = _reg("user.record.delete_failed")
    GROUP_RECORD_NOT_FOUND  = _reg("group.record.not_found")
    GROUP_RECORD_CONFLICT   = _reg("group.record.conflict")

    # -- contacts ----------------------------------------------------------
    CONTACT_RECORD_NOT_FOUND = _reg("contact.record.not_found")
    CONTACT_PHONE_CONFLICT   = _reg("contact.phone.conflict")
    CONTACT_PHONE_INVALID    = _reg("contact.phone.invalid")

    # -- telephony ---------------------------------------------------------
    TELEPHONY_AMI_UNAVAILABLE  = _reg("telephony.ami.unavailable", Severity.CRITICAL, True)
    TELEPHONY_MONITOR_UNAVAILABLE = _reg("telephony.monitor.unavailable", Severity.WARNING, True)
    TELEPHONY_CALL_REJECTED    = _reg("telephony.call.rejected")
    TELEPHONY_TRANSFER_FAILED  = _reg("telephony.transfer.failed", Severity.ERROR, True)
    TELEPHONY_DND_FAILED       = _reg("telephony.dnd.update_failed", Severity.ERROR, True)
    TELEPHONY_EXTENSION_NOT_FOUND = _reg("telephony.extension.not_found")
    TELEPHONY_QUEUE_UNASSIGNED = _reg("telephony.queue.unassigned")

    # -- recordings --------------------------------------------------------
    RECORDING_FILE_NOT_FOUND = _reg("recording.file.not_found")
    RECORDING_FORMAT_UNSUPPORTED = _reg("recording.format.unsupported")
    RECORDING_TOGGLE_FAILED  = _reg("recording.config.update_failed")

    # -- notifications / push ---------------------------------------------
    NOTIFICATION_RECORD_NOT_FOUND = _reg("notification.record.not_found")
    NOTIFICATION_STATUS_INVALID   = _reg("notification.status.invalid")
    NOTIFICATION_FETCH_FAILED     = _reg("notification.list.fetch_failed", Severity.ERROR, True)
    PUSH_TOKEN_INVALID       = _reg("push.device_token.invalid")
    PUSH_TOKEN_STORE_FAILED  = _reg("push.device_token.store_failed", Severity.ERROR, True)
    PUSH_SUBSCRIPTION_REQUIRED = _reg("push.subscription.required")
    PUSH_SUBSCRIPTION_STORE_FAILED = _reg("push.subscription.store_failed", Severity.ERROR, True)

    # -- pause reasons -----------------------------------------------------
    PAUSE_REASON_INVALID    = _reg("pause_reason.record.invalid")
    PAUSE_REASON_UNDELETABLE = _reg("pause_reason.record.undeletable")

    # -- CRM ---------------------------------------------------------------
    CRM_SERVER_URL_INVALID  = _reg("crm.server_url.invalid")
    CRM_CONFIG_SAVE_FAILED  = _reg("crm.config.save_failed", Severity.ERROR, True)
    CRM_LOOKUP_UNAVAILABLE  = _reg("crm.lookup.unavailable", Severity.WARNING, True)
    CRM_LOOKUP_CONFIG_INVALID = _reg("crm.lookup.config_invalid")
    CRM_TIMEOUT_INVALID     = _reg("crm.timeout.invalid")

    # -- settings / config -------------------------------------------------
    SETTINGS_READ_FAILED    = _reg("settings.record.read_failed", Severity.ERROR, True)
    SETTINGS_SAVE_FAILED    = _reg("settings.record.save_failed", Severity.ERROR, True)
    CONFIG_DOMAIN_MISSING   = _reg("config.domain.missing", Severity.CRITICAL)
    CONFIG_QOS_FAILED       = _reg("config.qos.update_failed")
    CONFIG_TLS_FAILED       = _reg("config.tls.update_failed")
    CONFIG_MOBILE_WAKE_FAILED = _reg("config.mobile_wake.update_failed")

    # -- analytics / reporting --------------------------------------------
    ANALYTICS_QUERY_FAILED  = _reg("analytics.query.failed", Severity.ERROR, True)
    ANALYTICS_EXPORT_UNAVAILABLE = _reg("analytics.export.unavailable")
    CALL_LOG_FETCH_FAILED   = _reg("call_log.list.fetch_failed", Severity.ERROR, True)
    CALL_JOURNEY_FETCH_FAILED = _reg("call_log.journey.fetch_failed", Severity.ERROR, True)
    CALL_VAD_FETCH_FAILED   = _reg("call_log.vad.fetch_failed", Severity.ERROR, True)

    # -- api keys ----------------------------------------------------------
    APIKEY_RECORD_NOT_FOUND = _reg("api_key.record.not_found")
    APIKEY_SCOPE_UNKNOWN    = _reg("api_key.scope.unknown")

    # -- webhook deliveries -----------------------------------------------
    DELIVERY_RECORD_NOT_FOUND = _reg("delivery.record.not_found")

    # -- catch-all ---------------------------------------------------------
    # Retryable: an unexpected server fault is usually transient, and the
    # frontend showing Retry is better than a dead end.
    INTERNAL_UNEXPECTED = _reg("internal.server.unexpected", Severity.CRITICAL, True)
    UPSTREAM_UNAVAILABLE = _reg("internal.upstream.unavailable", Severity.ERROR, True)


# ---------------------------------------------------------------------------
# Central code -> HTTP status mapping (Rule 5.4: ONE table)
# ---------------------------------------------------------------------------
# Matched most-specific-prefix-first, so a new code in a known domain gets a
# sane status without touching this table.
_STATUS_BY_PREFIX: tuple[tuple[str, int], ...] = (
    ("auth.token.missing", 401),
    ("auth.token.", 401),
    ("auth.credentials.", 401),
    ("auth.api_key.scope_missing", 403),
    ("auth.api_key.", 401),
    ("access.", 403),
    ("request.route.not_found", 404),
    ("request.method.not_allowed", 405),
    ("request.", 400),
    (".not_found", 404),
    (".conflict", 409),
    ("telephony.ami.unavailable", 503),
    ("telephony.monitor.unavailable", 503),
    ("telephony.call.rejected", 502),
    ("telephony.dnd.update_failed", 502),
    ("crm.lookup.unavailable", 503),
    ("internal.upstream.unavailable", 502),
    ("internal.server.", 500),
)

_SUFFIX_STATUS: tuple[tuple[str, int], ...] = (
    ("_not_found", 404),
    (".not_found", 404),
    (".conflict", 409),
    ("_failed", 500),
    (".invalid", 400),
    (".required", 400),
    (".missing", 400),
    (".unsupported", 400),
    (".undeletable", 400),
    (".unknown", 400),
    (".unavailable", 503),
    (".config_invalid", 400),
)


def status_for(code: str) -> int:
    """Map an error code to an HTTP status. The single source of truth."""
    for prefix, status in _STATUS_BY_PREFIX:
        if code.startswith(prefix) or (prefix.startswith(".") and code.endswith(prefix)):
            return status
    for suffix, status in _SUFFIX_STATUS:
        if code.endswith(suffix):
            return status
    return 400


def meta_for(code: str) -> tuple[Severity, bool]:
    """Registered (severity, retryable) for a code; unregistered -> error/False."""
    return _REGISTRY.get(code, (Severity.ERROR, False))


def registered_codes() -> Iterable[str]:
    return tuple(_REGISTRY)


class AppError(Exception):
    """The only error type handlers raise.

    Carries everything Rule 4.1 needs. Status, severity and retryability are
    derived from `code` unless explicitly overridden, so a handler cannot
    accidentally report the same condition two different ways.
    """

    def __init__(
        self,
        code: str,
        message: str,
        *,
        fields: Optional[list[FieldError]] = None,
        severity: Optional[Severity] = None,
        retryable: Optional[bool] = None,
        status: Optional[int] = None,
        details: Optional[dict[str, Any]] = None,
        params: Optional[dict[str, Any]] = None,
        cause: Optional[BaseException] = None,
    ):
        super().__init__(message)
        reg_sev, reg_retry = meta_for(code)
        self.code = code
        self.message = message
        self.fields = fields or []
        self.severity = severity or reg_sev
        self.retryable = reg_retry if retryable is None else retryable
        self.status = status or status_for(code)
        self.details = details or {}
        # Rule 4.1: `code` + `params` are the localizable form; `message` is the
        # fallback. Both ship so multi-locale support stays possible later.
        self.params = params or {}
        self.cause = cause

    def to_envelope(self, trace_id: str) -> dict[str, Any]:
        return {
            "error": {
                "code": self.code,
                "message": self.message,
                "severity": self.severity.value,
                "retryable": self.retryable,
                "trace_id": trace_id,
                "params": self.params,
                "fields": [f.to_dict() for f in self.fields],
                "details": self.details,
            }
        }

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f"AppError({self.code!r}, status={self.status}, fields={len(self.fields)})"
