"""trace_id propagation and the central error renderer (Rules 4.1, 5.4).

`install_contract(app)` is the single wiring point. After it runs:

  * every response carries `X-Trace-Id`, and every error body repeats it in
    `error.trace_id` so a support ticket is solvable (Rule 4.1);
  * `AppError` renders through one path;
  * FastAPI's `RequestValidationError` becomes a Rule 4.1 `fields` array
    automatically, so handlers never hand-assemble field errors (Rule 5.4);
  * legacy `HTTPException(detail="...")` raises still produce a compliant
    envelope, mapped onto a code — so the taxonomy can be adopted
    incrementally instead of in one 153-site commit;
  * unhandled exceptions become `internal.server.unexpected` with the raw
    detail kept in the log behind the trace_id, never in the response
    (Rule 4.3: never expose stack traces, SQL or internal hostnames).
"""
from __future__ import annotations

import logging
import re
import uuid
from contextvars import ContextVar
from typing import Any, Optional

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from .errors import AppError, FieldError, Severity, codes, meta_for

log = logging.getLogger(__name__)

TRACE_HEADER = "X-Trace-Id"
_trace_id: ContextVar[str] = ContextVar("trace_id", default="")


def current_trace_id() -> str:
    """The active request's trace id. Log records should include this."""
    return _trace_id.get() or "-"


def _new_trace_id() -> str:
    # Hex, not the dashed form: it survives copy-paste out of a UI intact.
    return uuid.uuid4().hex


# ---------------------------------------------------------------------------
# Legacy HTTPException -> code mapping
# ---------------------------------------------------------------------------
# Rule 4.1 says never parse `message`. That applies to CLIENTS. Here we are the
# server translating our own pre-standards raises exactly once, at the boundary,
# so the wire contract is compliant today and each raise site can migrate to
# `AppError` on its own schedule. Ordered: first match wins.
_LEGACY_PATTERNS: tuple[tuple[str, str], ...] = (
    (r"not authenticated",                      codes.AUTH_TOKEN_MISSING),
    (r"invalid or expired token",               codes.AUTH_TOKEN_INVALID),
    (r"invalid or expired api key",             codes.AUTH_APIKEY_INVALID),
    (r"api key missing required scope",         codes.AUTH_APIKEY_SCOPE_MISSING),
    (r"invalid extension/username or password", codes.AUTH_CREDENTIALS_INVALID),
    (r"admin only",                             codes.ACCESS_ADMIN_REQUIRED),
    (r"loopback only",                          codes.ACCESS_LOOPBACK_REQUIRED),
    (r"^(access denied|forbidden)$",            codes.ACCESS_ROLE_FORBIDDEN),
    (r"not allowed to|not permitted to",        codes.ACCESS_EXTENSION_FORBIDDEN),
    (r"ami not connected",                      codes.TELEPHONY_AMI_UNAVAILABLE),
    (r"ami monitor not available",              codes.TELEPHONY_MONITOR_UNAVAILABLE),
    (r"asterisk rejected the call",             codes.TELEPHONY_CALL_REJECTED),
    (r"failed to transfer call",                codes.TELEPHONY_TRANSFER_FAILED),
    (r"failed to set dnd",                      codes.TELEPHONY_DND_FAILED),
    (r"crm lookup module not available",        codes.CRM_LOOKUP_UNAVAILABLE),
    (r"invalid crm server url",                 codes.CRM_SERVER_URL_INVALID),
    (r"failed to save crm configuration",       codes.CRM_CONFIG_SAVE_FAILED),
    (r"^lookup_",                               codes.CRM_LOOKUP_CONFIG_INVALID),
    (r"timeout must be between",                codes.CRM_TIMEOUT_INVALID),
    (r"contact with this phone number already exists", codes.CONTACT_PHONE_CONFLICT),
    (r"contact not found",                      codes.CONTACT_RECORD_NOT_FOUND),
    (r"phone must contain digits|^phone is required", codes.CONTACT_PHONE_INVALID),
    (r"user not found",                         codes.USER_RECORD_NOT_FOUND),
    (r"failed to delete user",                  codes.USER_DELETE_FAILED),
    (r"username or extension already in use",   codes.USER_RECORD_CONFLICT),
    (r"(your account has no extension|no extension associated)", codes.USER_EXTENSION_MISSING),
    (r"extension not found in users",           codes.TELEPHONY_EXTENSION_NOT_FOUND),
    (r"no queues are assigned",                 codes.TELEPHONY_QUEUE_UNASSIGNED),
    (r"group name may already exist",           codes.GROUP_RECORD_CONFLICT),
    (r"group not found",                        codes.GROUP_RECORD_NOT_FOUND),
    (r"recording not found",                    codes.RECORDING_FILE_NOT_FOUND),
    (r"unsupported recording format",           codes.RECORDING_FORMAT_UNSUPPORTED),
    (r"failed to (enable|disable) call recording", codes.RECORDING_TOGGLE_FAILED),
    (r"failed to (enable|disable) qos",         codes.CONFIG_QOS_FAILED),
    (r"failed to (enable|disable) sip tls",     codes.CONFIG_TLS_FAILED),
    (r"failed to (enable|disable) mobile wake", codes.CONFIG_MOBILE_WAKE_FAILED),
    (r"opdesk_domain is not configured",        codes.CONFIG_DOMAIN_MISSING),
    (r"notification not found",                 codes.NOTIFICATION_RECORD_NOT_FOUND),
    (r"status_flag must be",                    codes.NOTIFICATION_STATUS_INVALID),
    (r"failed to fetch call notifications",     codes.NOTIFICATION_FETCH_FAILED),
    (r"invalid token, platform, or token_type", codes.PUSH_TOKEN_INVALID),
    (r"failed to register device token",        codes.PUSH_TOKEN_STORE_FAILED),
    (r"^subscription required",                 codes.PUSH_SUBSCRIPTION_REQUIRED),
    (r"failed to store web push subscription",  codes.PUSH_SUBSCRIPTION_STORE_FAILED),
    (r"invalid or duplicate pause reason",      codes.PAUSE_REASON_INVALID),
    (r"cannot delete \(not found or system reason\)", codes.PAUSE_REASON_UNDELETABLE),
    (r"api key not found",                      codes.APIKEY_RECORD_NOT_FOUND),
    (r"unknown scope",                          codes.APIKEY_SCOPE_UNKNOWN),
    (r"delivery not found",                     codes.DELIVERY_RECORD_NOT_FOUND),
    (r"openpyxl not installed",                 codes.ANALYTICS_EXPORT_UNAVAILABLE),
    (r"failed to fetch call log",               codes.CALL_LOG_FETCH_FAILED),
    (r"failed to fetch call journey",           codes.CALL_JOURNEY_FETCH_FAILED),
    (r"failed to fetch vad data",               codes.CALL_VAD_FETCH_FAILED),
    (r"failed to get setting",                  codes.SETTINGS_READ_FAILED),
    (r"failed to save settings",                codes.SETTINGS_SAVE_FAILED),
    (r"openapi spec not found|^not found$",     codes.REQUEST_ROUTE_NOT_FOUND),
    (r"method not allowed",                     codes.REQUEST_METHOD_NOT_ALLOWED),
    (r"^internal server error$",                codes.INTERNAL_UNEXPECTED),
)

_COMPILED = tuple((re.compile(p, re.I), c) for p, c in _LEGACY_PATTERNS)

# Status -> code, when no message pattern matched.
_STATUS_FALLBACK: dict[int, str] = {
    400: codes.REQUEST_BODY_INVALID,
    401: codes.AUTH_TOKEN_INVALID,
    403: codes.ACCESS_ROLE_FORBIDDEN,
    404: codes.REQUEST_ROUTE_NOT_FOUND,
    405: codes.REQUEST_METHOD_NOT_ALLOWED,
    500: codes.INTERNAL_UNEXPECTED,
    502: codes.UPSTREAM_UNAVAILABLE,
    503: codes.TELEPHONY_AMI_UNAVAILABLE,
}


def code_for_legacy(status: int, detail: str) -> str:
    text = (detail or "").strip()
    for rx, code in _COMPILED:
        if rx.search(text):
            return code
    return _STATUS_FALLBACK.get(status, codes.REQUEST_BODY_INVALID)


# Rule 4.3: errors state what happened and what to do next; no apologies, no
# exclamation marks, sentence case. Server-fault details stay in the log.
_SAFE_MESSAGE: dict[str, str] = {
    codes.INTERNAL_UNEXPECTED:
        "Something went wrong on our side. Try again, and quote the trace id if it persists.",
    codes.UPSTREAM_UNAVAILABLE:
        "An upstream service did not respond. Try again shortly.",
}


def _public_message(code: str, detail: str, status: int) -> str:
    if code in _SAFE_MESSAGE:
        return _SAFE_MESSAGE[code]
    if status >= 500 and not detail:
        return _SAFE_MESSAGE[codes.INTERNAL_UNEXPECTED]
    return detail or _SAFE_MESSAGE[codes.INTERNAL_UNEXPECTED]


def _render(err: AppError, trace_id: str,
            extra_headers: Optional[dict[str, str]] = None) -> JSONResponse:
    headers = {TRACE_HEADER: trace_id}
    # Preserve protocol-significant headers from the original raise — notably
    # `Allow` on a 405, which is required by RFC 9110 and is the only way a
    # client learns which methods the path does support.
    if extra_headers:
        headers.update(extra_headers)
    return JSONResponse(
        status_code=err.status,
        content=err.to_envelope(trace_id),
        headers=headers,
    )


# ---------------------------------------------------------------------------
# Validation -> fields array
# ---------------------------------------------------------------------------
def _loc_to_path(loc: tuple[Any, ...]) -> str:
    """Pydantic `loc` -> a form-control path.

    `("body", "items", 2, "quantity")` -> `items[2].quantity`, which matches the
    `name` a frontend control would carry (Rule 4.1).
    """
    parts = [p for p in loc if p not in ("body", "query", "path", "header", "cookie")]
    out = ""
    for p in parts:
        if isinstance(p, int):
            out += f"[{p}]"
        else:
            out = f"{out}.{p}" if out else str(p)
    return out or "_"


_PYDANTIC_CODE_MAP = {
    "missing": "value.required",
    "string_too_short": "value.too_short",
    "string_too_long": "value.too_long",
    "greater_than": "value.below_min",
    "greater_than_equal": "value.below_min",
    "less_than": "value.above_max",
    "less_than_equal": "value.above_max",
    "int_parsing": "value.not_an_integer",
    "float_parsing": "value.not_a_number",
    "bool_parsing": "value.not_a_boolean",
    "value_error": "value.invalid",
    "enum": "value.not_allowed",
}


def _fields_from_validation(exc: RequestValidationError) -> list[FieldError]:
    out: list[FieldError] = []
    for e in exc.errors():
        etype = str(e.get("type", "value_error"))
        params = {k: v for k, v in (e.get("ctx") or {}).items()
                  if isinstance(v, (str, int, float, bool))}
        out.append(FieldError(
            path=_loc_to_path(tuple(e.get("loc") or ())),
            code=_PYDANTIC_CODE_MAP.get(etype, f"value.{etype}"),
            message=str(e.get("msg") or "This value is not valid."),
            params=params,
        ))
    return out


# ---------------------------------------------------------------------------
def install_contract(app: FastAPI) -> None:
    """Wire trace ids and the error renderer onto `app`. Call once, after the
    FastAPI() constructor and before routes are served."""

    @app.middleware("http")
    async def _trace(request: Request, call_next):  # type: ignore[no-untyped-def]
        # Honour an inbound id so a trace survives across services, but only if
        # it looks like one — an unbounded client string would poison the logs.
        inbound = (request.headers.get(TRACE_HEADER) or "").strip()
        tid = inbound if re.fullmatch(r"[A-Za-z0-9._-]{8,64}", inbound) else _new_trace_id()
        token = _trace_id.set(tid)
        try:
            response = await call_next(request)
        finally:
            _trace_id.reset(token)
        response.headers[TRACE_HEADER] = tid
        return response

    @app.exception_handler(AppError)
    async def _app_error(request: Request, exc: AppError):  # type: ignore[no-untyped-def]
        tid = current_trace_id()
        if exc.status >= 500:
            log.error("[%s] %s %s -> %s: %s", tid, request.method,
                      request.url.path, exc.code, exc.message, exc_info=exc.cause)
        else:
            log.info("[%s] %s %s -> %s", tid, request.method, request.url.path, exc.code)
        return _render(exc, tid)

    @app.exception_handler(RequestValidationError)
    async def _validation(request: Request, exc: RequestValidationError):  # type: ignore[no-untyped-def]
        tid = current_trace_id()
        fields = _fields_from_validation(exc)
        err = AppError(
            codes.REQUEST_BODY_INVALID,
            "Some fields need attention." if fields else "The request body is not valid.",
            fields=fields,
            severity=Severity.WARNING,
        )
        log.info("[%s] %s %s -> %s (%d field errors)", tid, request.method,
                 request.url.path, err.code, len(fields))
        return _render(err, tid)

    @app.exception_handler(StarletteHTTPException)
    async def _http_exc(request: Request, exc: StarletteHTTPException):  # type: ignore[no-untyped-def]
        tid = current_trace_id()
        detail = exc.detail if isinstance(exc.detail, str) else ""
        code = code_for_legacy(exc.status_code, detail)
        sev, retry = meta_for(code)
        err = AppError(
            code,
            _public_message(code, detail, exc.status_code),
            severity=sev,
            retryable=retry,
            status=exc.status_code,
        )
        if exc.status_code >= 500:
            # The raw detail may name internal hosts or SQL — log it, do not ship it.
            log.error("[%s] %s %s -> %s (detail=%r)", tid, request.method,
                      request.url.path, code, detail)
        return _render(err, tid, getattr(exc, "headers", None))

    @app.exception_handler(Exception)
    async def _unhandled(request: Request, exc: Exception):  # type: ignore[no-untyped-def]
        tid = current_trace_id()
        log.exception("[%s] unhandled on %s %s", tid, request.method, request.url.path)
        err = AppError(codes.INTERNAL_UNEXPECTED,
                       _SAFE_MESSAGE[codes.INTERNAL_UNEXPECTED], cause=exc)
        return _render(err, tid)
