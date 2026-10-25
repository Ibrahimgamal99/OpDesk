# API overview

Conventions shared by every OpDesk endpoint. For the endpoint list see
[endpoints.md](endpoints.md); for the outgoing CRM push see [webhooks.md](webhooks.md).

## Base URL

```
https://<your-opdesk-host>/api
```

OpDesk serves the API and the web UI from the same origin. The backend is a NestJS
(Node.js 24) process listening on `127.0.0.1:8765`; the bundled nginx config publishes it
over HTTPS, on `443` or, when the PBX's Apache already holds 443, on the port the
installer chose (default `8443`).

---

## Authentication

Two mechanisms, for two different kinds of caller.

### 1. JWT bearer tokens (people)

Obtained by logging in. Carries the user's identity and role; the rows a request returns
depend on who asked (see [Visibility](#visibility)).

```
Authorization: Bearer <jwt>
```

Get one with:

```bash
curl -X POST https://opdesk.example.com/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"login": "admin", "password": "…"}'
```

```json
{
  "access_token": "eyJhbGciOi…",
  "token_type": "bearer",
  "user": {
    "id": 1, "username": "admin", "name": "Ada Lovelace",
    "role": "admin", "extension": "1001",
    "monitor_modes": ["listen", "whisper", "barge"],
    "allowed_agent_extensions": null, "allowed_queue_names": null,
    "is_agent": false
  }
}
```

`login` accepts either a username or an extension. Tokens are HS256, expire after 24
hours, and carry the user id as `sub`; a token whose `sub` is not a user id is rejected
with `401`. Login is rate-limited per IP: 10 failures in 5 minutes triggers a 10-minute
lockout with a `429` and a `Retry-After` header.

A JWT is sent in the `Authorization` header only. The one exception is the WebSocket
handshake (`/ws?token=`), because a browser cannot set headers on it. Recordings in
particular are **not** reachable with `?token=`; see
[`GET /api/recordings/{path}`](endpoints.md#get-apirecordingspath).

### 2. API keys (machines)

Long-lived credentials created by an admin under **Settings → API Keys**. Each key is
scoped to an explicit permission list chosen at creation. The plaintext — prefixed
`opd_` — is shown **exactly once**; only its SHA-256 hash is stored, so a lost key must
be revoked and replaced rather than recovered.

```
X-API-Key: opd_9f2c…
```

Also accepted on the shared Authorization header, where the `opd_` prefix is what
distinguishes a key from a JWT:

```
Authorization: Bearer opd_9f2c…
```

A key is rejected once it is disabled or past its expiry; both are enforced in the
database, not in application code. Every successful use stamps `last_used_at`, which the
Settings table displays.

#### Keys are fail-closed

A key is accepted **only** on the endpoints listed below, and within that set each route
enforces one specific scope. Everything else — user management, all of `/api/settings*`,
`/api/crm/*`, `/api/api-keys*`, `/api/logs*`, `/api/audit-log`, the WebSocket — is
JWT-only and returns `401` to a key. The admin surface is never reachable with a machine
credential.

| Surface | Endpoints | Required scope |
|---|---|---|
| Live state | `GET /api/extensions`, `/api/calls`, `/api/queues`, `/api/status` | `calls:read` |
| Call origination | `POST /api/integration/click-to-call` | `calls:write` |
| Call history | `GET /api/call-log`, `/api/call-log/export`, `/api/call-log/journey`, `/api/call-log/vad/{uniqueid}` | `cdr:read` |
| Recordings | `GET /api/recordings/{path}` | `cdr:read` |
| Analytics | `GET /api/analytics/{overview,queue-performance,agent-performance,agent-adherence,agent-adherence/timeline,agent-adherence/export,heatmap,trend,drilldown,export,export/{report}}` | `analytics:read` |
| SIP account lookup | `POST /api/extension-config/lookup` (**API key only**: a JWT is refused) | `extension-config:read` |
| Contacts (read) | `GET /api/contacts`, `/api/contacts/{id}` | `contacts:read` |
| Contacts (push in) | `POST /api/contacts`, `/api/contacts/bulk` (upsert; never edit or delete) | `contacts:write` |

Those seven tokens are the complete set — `GET /api/api-keys/permissions` returns them,
and the Settings scope picker is rendered from that response. OpDesk deliberately does
not advertise scopes that gate nothing.

---

## Role levels

| Role | Sees |
|---|---|
| `admin` | Everything, plus configuration, user management, logs, the audit log and API keys. |
| `supervisor` | Live state, history and analytics for the agents and queues in their groups. Cannot manage users, groups, or API keys. |
| `agent` | Their own call history; live state for their own extension and for the agents and queues of their groups. No analytics. |

An API key authenticates as a **system** principal: unrestricted rows (no group
filtering), bounded by its scopes rather than by a role.

### Visibility

OpDesk applies two scopes to every principal. **History** governs call history, the
CSV export, recordings, Call Journey, VAD, notifications and analytics. **Live** governs
the extensions, active-calls and queues panels, the matching REST routes and the
WebSocket frames.

| Principal | History scope | Live scope |
|---|---|---|
| admin, API key | everything | everything |
| supervisor | the agent extensions and queues of the groups they belong to | the same |
| agent | **their own extension only** | their own extension, plus every agent extension and queue of every group they belong to |

A request for a single call outside the caller's history scope — a journey, a VAD
analysis, a recording — returns `403` with `Not allowed to view this call`, not an empty
result. Lists are filtered silently.

---

## Request format

`POST`, `PUT` and `PATCH` bodies are JSON:

```
Content-Type: application/json
```

Filters, paging and date ranges are query-string parameters on `GET`.

## Response format

Success responses are JSON objects. Collections are wrapped in a named key rather than
returned as a bare array, so a response can grow additional metadata without breaking
clients:

```json
{ "calls": [ … ], "total": 412 }
```

A few routes use a `data` envelope instead, with cursor paging under `page`:

```json
{ "data": [ … ], "page": { "cursor": null, "next_cursor": "eyJpZCI6MTIzfQ", "limit": 50 } }
```

Pass `next_cursor` back as `cursor` to fetch the next page; `null` means there is none.
A cursor is opaque. A malformed one returns `400` with `request.cursor.invalid`.

CSV exports (`…/export` routes) return `text/csv; charset=utf-8` with a UTF-8 BOM, so
spreadsheet applications open non-ASCII names correctly, and a
`Content-Disposition: attachment` filename.

Settings values that are secrets — `JWT_SECRET`, CRM passwords, secrets and tokens, the
VAPID private key, APNs and FCM keys — are returned as `"********"`. Posting that mask
back leaves the stored value unchanged, so a settings form can round-trip without
knowing the secret.

## Errors

Every error body has the same shape, whatever the route:

```json
{
  "error": {
    "code": "auth.api_key.scope_missing",
    "message": "API key missing required scope: cdr:read",
    "severity": "error",
    "retryable": false,
    "trace_id": "4f1c2b7e9a0d4e3f8b6c5a1d2e3f4a5b",
    "params": {},
    "fields": [],
    "details": {}
  }
}
```

- `code` is stable and machine-readable (`domain.resource.condition`); branch on it, not
  on `message`.
- `fields` lists per-field validation failures (`path`, `code`, `message`) on a
  `400 request.body.invalid`.
- Every response, success or error, carries an `X-Trace-Id` header with the same value as
  `trace_id`. Send your own `X-Trace-Id` (8–64 characters of `A-Za-z0-9._-`) to correlate
  a request with the server log.
- A `500` never contains exception text: its message is a fixed "Something went wrong on
  our side" sentence, and the trace id is what to quote.

| Code | Meaning |
|---|---|
| `200` | OK |
| `201` | Created (a new API key) |
| `202` | Accepted — the work was queued, not completed (click-to-call, delivery resend) |
| `204` | No content (API key revoked) |
| `206` | Partial content — a ranged recording request |
| `400` | Malformed request or a failed validation rule |
| `401` | Missing, invalid, disabled or expired credential |
| `403` | Authenticated, but not permitted (wrong role, a key without the scope, or a call outside your scope) |
| `404` | No such resource — or no such endpoint |
| `405` | The path exists but not for that method; the `Allow` header lists what is valid |
| `409` | Conflict — a username, extension or group name already in use |
| `429` | Login rate limit; see `Retry-After` |
| `502` | An upstream (Asterisk, the CRM) refused the request |
| `503` | A dependency is unavailable — usually AMI is disconnected |
| `500` | Unhandled server error |

Common auth failures:

| Status | `code` | `message` |
|---|---|---|
| `401` | `auth.token.missing` | Not authenticated |
| `401` | `auth.token.invalid` | Invalid or expired token |
| `401` | `auth.api_key.invalid` | Invalid or expired API key |
| `403` | `auth.api_key.scope_missing` | API key missing required scope: cdr:read |
| `403` | `access.role.admin_required` | Admin only |
| `403` | `access.role.forbidden` | Not allowed to view this call |

> A request to an `/api/…` path always produces one of these JSON bodies. It never
> returns the SPA's HTML, including for a wrong method or an unknown path.

---

## WebSocket

```
wss://<host>/ws?token=<jwt>
```

Or connect without the query and send `{"token": "<jwt>"}` as the first frame within
10 seconds. An invalid token closes the socket with code `4001`. **JWT only** — API keys
are not accepted on the WebSocket.

Server frames:

| `type` | Payload |
|---|---|
| `initial_state`, `state_update` | `data`: `extensions`, `active_calls`, `queues`, `queue_members`, `queue_entries`, `stats` and `agent_states`, filtered by the connection's live scope |
| `call_notification_new` | `extension` — a missed-call notification was recorded |
| `action_result` | `action`, `success`, `message` — the reply to a client action |
| `error` | `message` |

`agent_states` maps each agent extension to its presence:

```json
{
  "1001": {
    "extension": "1001", "state": "not_ready", "reason_code": "BREAK",
    "since": "2026-07-27T09:30:00", "duration_secs": 312,
    "linkedid": null, "queue": null, "is_agent": true
  }
}
```

`state` is one of `ready`, `not_ready`, `on_call`, `wrap_up`, `dnd`, `available`,
`logged_out`. There is no label: resolve `reason_code` through
`GET /api/pause-reasons`.

Client actions are JSON frames with an `action` key: `get_state`, `sync`, `sync_calls`,
`sync_queues`, `listen` / `whisper` / `barge` (`supervisor`, `target`), `hangup`,
`transfer`, `take_over`, `queue_add`, `queue_remove`, `queue_pause`, `queue_unpause`,
and the agent-presence actions:

| Action | Fields | Effect |
|---|---|---|
| `agent_login` | `agent`? | Log the agent into their queues |
| `agent_logout` | `agent`? | Log the agent out of their queues |
| `agent_set_status` | `status` (`ready`, `not_ready`, `dnd`, `available`), `reason_code` (required for `not_ready`), `agent`? | Change presence |
| `agent_wrapup_done` | `agent`? | End wrap-up early |

`agent` defaults to the caller's own extension. An agent can act only on their own
extension (`Not allowed to control this agent` otherwise), and the queue-member actions
(`queue_pause`, `queue_unpause`, …) are refused for the agent role.

---

## Pagination

Endpoints that can return unbounded collections take `limit` and either `offset` or
`cursor` (see [Response format](#response-format)):

```
GET /api/logs/deliveries?limit=50&cursor=eyJpZCI6MTIzfQ
```

`limit` defaults to 50 and is clamped to 200 unless the route says otherwise.

## Dates and times

- Timestamps in responses are ISO 8601 in the server's local time, without an offset
  (`2026-07-27T09:30:00`). That includes Call Journey event times.
- `date_from` / `date_to` query parameters take `YYYY-MM-DD`. `date_to` is inclusive of
  the whole day.
- Durations are integer seconds unless the field name says otherwise.
