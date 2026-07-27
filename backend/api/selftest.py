"""Executable check for the contract layer. Runs without a DB or Asterisk.

    python3 -m api.selftest

Exercises every path the middleware renders: AppError, legacy HTTPException,
pydantic validation -> fields array, unhandled exception, envelopes, cursors,
and the code->status table. Prints a pass/fail table and exits non-zero on
failure, so it can be wired into CI as-is.
"""
from __future__ import annotations

import logging
import sys

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from pydantic import BaseModel, Field

from .envelope import (DEFAULT_LIMIT, MAX_LIMIT, PageParams, decode_cursor,
                       encode_cursor, respond, respond_list)
from .errors import AppError, FieldError, Severity, codes, registered_codes, status_for
from .middleware import TRACE_HEADER, install_contract

_results: list[tuple[bool, str, str]] = []


class ItemIn(BaseModel):
    """Module-level on purpose: see the note in build_app()."""
    name: str = Field(min_length=2)
    quantity: int = Field(le=500)


def check(name: str, cond: bool, note: str = "") -> None:
    _results.append((bool(cond), name, note))


def build_app() -> FastAPI:
    app = FastAPI()
    install_contract(app)

    @app.get("/ok")
    async def ok():
        return respond({"id": "1", "name": "x"})

    @app.get("/list")
    async def lst(cursor: str | None = None, limit: int | None = None):
        p = PageParams.parse(cursor, limit)
        rows = [{"id": str(i)} for i in range(p.limit + 1)]
        page, more = p.slice_with_lookahead(rows)
        return respond_list(
            page, limit=p.limit, cursor=p.cursor,
            next_cursor=encode_cursor({"id": page[-1]["id"]}) if more else None,
        )

    @app.get("/app-error")
    async def app_error():
        raise AppError(codes.CONTACT_RECORD_NOT_FOUND, "Contact not found.")

    @app.get("/app-error-fields")
    async def app_error_fields():
        raise AppError(
            codes.REQUEST_FIELD_INVALID, "Some fields need attention.",
            fields=[FieldError("items[2].quantity", "value.above_max",
                               "Quantity cannot exceed 500.", {"max": 500})],
            severity=Severity.WARNING,
        )

    @app.get("/legacy-404")
    async def legacy_404():
        raise HTTPException(status_code=404, detail="Contact not found")

    @app.get("/legacy-503")
    async def legacy_503():
        raise HTTPException(status_code=503, detail="AMI not connected")

    @app.get("/legacy-500-leaky")
    async def legacy_500_leaky():
        raise HTTPException(status_code=500,
                            detail="Internal server error: SELECT * FROM users AT db-prod-07")

    @app.post("/validate")
    async def validate(item: ItemIn):
        return respond({"ok": True})

    @app.get("/boom")
    async def boom():
        return {}[  # noqa: B018 - deliberate KeyError
            "missing"]

    @app.get("/bad-cursor")
    async def bad_cursor(cursor: str):
        return respond(decode_cursor(cursor))

    return app


def main() -> int:
    # The /boom route raises on purpose; its traceback is not a failure.
    logging.getLogger('api.middleware').setLevel(logging.CRITICAL)
    logging.getLogger('uvicorn.error').setLevel(logging.CRITICAL)
    app = build_app()
    c = TestClient(app, raise_server_exceptions=False)

    # ---- envelopes -------------------------------------------------------
    r = c.get("/ok")
    check("single resource -> {data}", r.status_code == 200 and set(r.json()) == {"data"})
    check("trace id header present", bool(r.headers.get(TRACE_HEADER)))

    r = c.get("/list?limit=3")
    j = r.json()
    check("collection -> {data,page}", set(j) == {"data", "page"})
    check("page has cursor/next_cursor/limit",
          set(j["page"]) == {"cursor", "next_cursor", "limit"})
    check("total omitted when not cheap", "total" not in j["page"])
    check("limit honoured", len(j["data"]) == 3, f"got {len(j['data'])}")
    check("next_cursor set when more rows", bool(j["page"]["next_cursor"]))
    check("no success boolean anywhere", "success" not in r.text)

    check("limit clamped to MAX_LIMIT",
          c.get(f"/list?limit={MAX_LIMIT + 500}").json()["page"]["limit"] == MAX_LIMIT)
    check("limit floor is 1", c.get("/list?limit=0").json()["page"]["limit"] == 1)
    check("default limit applied", c.get("/list").json()["page"]["limit"] == DEFAULT_LIMIT)

    # ---- cursors ---------------------------------------------------------
    payload = {"id": "42", "at": "2026-07-27T00:00:00Z"}
    check("cursor round-trips", decode_cursor(encode_cursor(payload)) == payload)
    check("empty cursor -> {}", decode_cursor(None) == {} and decode_cursor("") == {})
    check("cursor is opaque (no plain id)", "42" not in encode_cursor(payload))
    r = c.get("/bad-cursor?cursor=!!!not-base64!!!")
    check("malformed cursor -> coded 400",
          r.status_code == 400
          and r.json()["error"]["code"] == codes.REQUEST_CURSOR_INVALID,
          f"{r.status_code} {r.json().get('error', {}).get('code')}")

    # ---- AppError --------------------------------------------------------
    r = c.get("/app-error")
    e = r.json()["error"]
    check("AppError status from code table", r.status_code == 404, str(r.status_code))
    check("error envelope keys complete",
          set(e) == {"code", "message", "severity", "retryable",
                     "trace_id", "params", "fields", "details"}, str(sorted(e)))
    check("code is dotted", e["code"].count(".") >= 2, e["code"])
    check("trace_id in body matches header", e["trace_id"] == r.headers[TRACE_HEADER])
    check("no `detail` key (legacy shape gone)", "detail" not in r.json())

    r = c.get("/app-error-fields")
    f = r.json()["error"]["fields"][0]
    check("fields is an array", isinstance(r.json()["error"]["fields"], list))
    check("field path supports index+nesting", f["path"] == "items[2].quantity", f["path"])
    check("field carries own code", f["code"] == "value.above_max")
    check("field params localizable", f["params"] == {"max": 500})
    check("severity warning honoured", r.json()["error"]["severity"] == "warning")

    # ---- legacy HTTPException -> compliant envelope -----------------------
    r = c.get("/legacy-404")
    e = r.json()["error"]
    check("legacy 404 mapped to real code",
          e["code"] == codes.CONTACT_RECORD_NOT_FOUND, e["code"])
    check("legacy error still enveloped", set(r.json()) == {"error"})

    r = c.get("/legacy-503")
    e = r.json()["error"]
    check("AMI 503 -> retryable", e["retryable"] is True)
    check("AMI 503 -> critical", e["severity"] == "critical", e["severity"])

    r = c.get("/legacy-500-leaky")
    body = r.text
    check("500 leaks no SQL", "SELECT" not in body)
    check("500 leaks no hostname", "db-prod-07" not in body)
    check("500 still carries trace_id", bool(r.json()["error"]["trace_id"]))
    check("500 is retryable", r.json()["error"]["retryable"] is True)

    # ---- validation -> fields --------------------------------------------
    r = c.post("/validate", json={"name": "a", "quantity": 900})
    e = r.json()["error"]
    check("validation -> 400", r.status_code == 400, str(r.status_code))
    check("validation produced 2 field errors", len(e["fields"]) == 2, str(len(e["fields"])))
    paths = {f["path"] for f in e["fields"]}
    check("validation paths match control names", paths == {"name", "quantity"}, str(paths))
    kinds = {f["code"] for f in e["fields"]}
    check("validation codes mapped", kinds == {"value.too_short", "value.above_max"}, str(kinds))

    r = c.post("/validate", json={})
    check("missing fields -> value.required",
          all(f["code"] == "value.required" for f in r.json()["error"]["fields"]))

    # ---- unhandled -------------------------------------------------------
    r = c.get("/boom")
    e = r.json()["error"]
    check("unhandled -> 500 envelope", r.status_code == 500 and set(r.json()) == {"error"})
    check("unhandled -> internal code", e["code"] == codes.INTERNAL_UNEXPECTED, e["code"])
    check("unhandled leaks no KeyError", "KeyError" not in r.text and "missing" not in r.text)

    # ---- status table ----------------------------------------------------
    cases = [
        (codes.AUTH_TOKEN_MISSING, 401), (codes.AUTH_TOKEN_INVALID, 401),
        (codes.AUTH_APIKEY_SCOPE_MISSING, 403), (codes.ACCESS_ADMIN_REQUIRED, 403),
        (codes.USER_RECORD_NOT_FOUND, 404), (codes.USER_RECORD_CONFLICT, 409),
        (codes.CONTACT_PHONE_CONFLICT, 409), (codes.REQUEST_BODY_INVALID, 400),
        (codes.REQUEST_METHOD_NOT_ALLOWED, 405), (codes.TELEPHONY_AMI_UNAVAILABLE, 503),
        (codes.TELEPHONY_CALL_REJECTED, 502), (codes.INTERNAL_UNEXPECTED, 500),
        (codes.SETTINGS_SAVE_FAILED, 500), (codes.CRM_TIMEOUT_INVALID, 400),
    ]
    bad = [(c_, want, status_for(c_)) for c_, want in cases if status_for(c_) != want]
    check("code->status table correct", not bad, str(bad))

    # every registered code must resolve to a sane status
    weird = [c_ for c_ in registered_codes() if not (400 <= status_for(c_) <= 599)]
    check("all codes map into 4xx/5xx", not weird, str(weird))

    # ---- report ----------------------------------------------------------
    width = max(len(n) for _, n, _ in _results)
    failed = 0
    for ok, name, note in _results:
        if ok:
            print(f"  \033[32mPASS\033[0m  {name.ljust(width)}")
        else:
            failed += 1
            print(f"  \033[31mFAIL\033[0m  {name.ljust(width)}  {note}")
    print(f"\n  {len(_results) - failed}/{len(_results)} passed")
    print(f"  {len(tuple(registered_codes()))} error codes registered")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
