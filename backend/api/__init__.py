"""HTTP contract layer — Rules 4 and 5 of the UI & API Standards.

Everything a handler needs to produce a standards-compliant response lives
here, and handlers are expected to use *only* this:

    from api import AppError, codes, respond, respond_list

    # success, single resource            -> {"data": {...}}
    return respond(user)

    # success, collection                 -> {"data": [...], "page": {...}}
    return respond_list(rows, cursor=c, limit=50)

    # failure                             -> {"error": {...}}
    raise AppError(codes.USER_NOT_FOUND, "User not found.")

No handler builds an envelope by hand and no handler writes to the response
stream directly (Rule 5.4). Errors are *raised*; the middleware renders them.
"""
from .errors import AppError, FieldError, Severity, codes, status_for
from .envelope import respond, respond_list, encode_cursor, decode_cursor, PageParams
from .middleware import install_contract

__all__ = [
    "AppError", "FieldError", "Severity", "codes", "status_for",
    "respond", "respond_list", "encode_cursor", "decode_cursor", "PageParams",
    "install_contract",
]
