"""Universal response envelopes and cursor pagination (Rule 5.1).

    Single resource:  {"data": {...}}
    Collection:       {"data": [...], "page": {cursor, next_cursor, limit, total}}
    Error:            {"error": {...}}      <- rendered by api.middleware

One shape, always. A bare array is never returned and `data` is never omitted
on success. There is deliberately no `success` boolean: Rule 5.1 forbids
triple-encoding one fact across `success`, `error` and the HTTP status.
"""
from __future__ import annotations

import base64
import binascii
import json
from dataclasses import dataclass
from typing import Any, Optional, Sequence

from .errors import AppError, codes

# Rule 5.1: `limit` is bounded server-side. A client asking for 100_000 rows is
# a mistake or an attack, not a request to honour.
DEFAULT_LIMIT = 50
MAX_LIMIT = 200


def respond(data: Any) -> dict[str, Any]:
    """Single-resource envelope. `None` is a legitimate payload (Rule 5.1:
    null means absent — never `{}` or `""`)."""
    return {"data": data}


def respond_list(
    items: Sequence[Any],
    *,
    limit: int = DEFAULT_LIMIT,
    cursor: Optional[str] = None,
    next_cursor: Optional[str] = None,
    total: Optional[int] = None,
) -> dict[str, Any]:
    """Collection envelope.

    `total` is optional on purpose (Rule 5.1: "expose `total` only where it is
    cheap; make it optional in the contract so callers cannot depend on it").
    Omit it rather than paying for a COUNT(*) on every request.
    """
    page: dict[str, Any] = {
        "cursor": cursor,
        "next_cursor": next_cursor,
        "limit": limit,
    }
    if total is not None:
        page["total"] = int(total)
    return {"data": list(items), "page": page}


# ---------------------------------------------------------------------------
# Cursors
# ---------------------------------------------------------------------------
# Rule 5.1 requires cursor pagination, not offset: `OFFSET 40000` scans and
# discards 40 000 rows, and offset silently skips or repeats rows when the table
# is written to mid-traversal.
#
# A cursor is an opaque base64 token. Opaque is the contract — clients must not
# parse it — which is what lets the keyset columns change without a version bump.


def encode_cursor(payload: dict[str, Any]) -> str:
    raw = json.dumps(payload, separators=(",", ":"), sort_keys=True, default=str)
    return base64.urlsafe_b64encode(raw.encode()).decode().rstrip("=")


def decode_cursor(cursor: Optional[str]) -> dict[str, Any]:
    """Decode a cursor, or raise a coded 400. Never raises a bare ValueError:
    a malformed cursor is a client error and must reach the user as one."""
    if not cursor:
        return {}
    try:
        pad = "=" * (-len(cursor) % 4)
        data = json.loads(base64.urlsafe_b64decode(cursor + pad).decode())
        if not isinstance(data, dict):
            raise ValueError("cursor payload is not an object")
        return data
    except (ValueError, binascii.Error, UnicodeDecodeError) as e:
        raise AppError(
            codes.REQUEST_CURSOR_INVALID,
            "That page link is no longer valid. Reload the list to continue.",
            details={"reason": str(e)},
        ) from e


@dataclass(frozen=True)
class PageParams:
    """Normalised `?cursor=&limit=` for any collection endpoint (Rule 5.3:
    identical parameter names on every collection, so one client hook serves
    all of them)."""

    limit: int
    cursor: Optional[str]
    keyset: dict[str, Any]

    @classmethod
    def parse(cls, cursor: Optional[str] = None, limit: Optional[int] = None) -> "PageParams":
        eff = DEFAULT_LIMIT if limit is None else int(limit)
        eff = max(1, min(MAX_LIMIT, eff))
        return cls(limit=eff, cursor=cursor or None, keyset=decode_cursor(cursor))

    def slice_with_lookahead(self, rows: Sequence[Any]) -> tuple[list[Any], bool]:
        """Given `limit + 1` fetched rows, return (page, has_more).

        Fetching one extra row is how `next_cursor` is decided without a second
        COUNT query: if the extra row exists there is another page.
        """
        rows = list(rows)
        if len(rows) > self.limit:
            return rows[: self.limit], True
        return rows, False
