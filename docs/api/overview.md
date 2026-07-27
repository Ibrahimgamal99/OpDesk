# API overview

Conventions shared by every OpDesk endpoint. For the endpoint list see
[endpoints.md](endpoints.md); for the outgoing CRM push see [webhooks.md](webhooks.md).

## Base URL

```
https://<your-opdesk-host>/api
```

OpDesk serves the API and the web UI from the same origin. In a default install that is
port `8443` (HTTPS) or `8765` (HTTP); behind the bundled nginx config it is `443`.

---

## Authentication

Two mechanisms, for two different kinds of caller.

### 1. JWT bearer tokens (people)

Obtained by logging in. Carries the user's identity, role and group scoping, so the rows
a request returns depend on who asked.

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
    "monitor_modes": ["listen", "whisper", "barge"]
  }
}
```

`login` accepts either a username or an extension. Tokens expire after `JWT_EXPIRE_HOURS`
(default 24). Login is rate-limited per IP: 10 failures in 5 minutes triggers a 10-minute
lockout with a `429` and a `Retry-After` header.

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
`/api/crm/*`, `/api/api-keys*`, `/api/logs*`, the WebSocket — is JWT-only and returns
`401` to a key. The admin surface is never reachable with a machine credential.

| Surface | Endpoints | Required scope |
|---|---|---|
| Live state | `GET /api/extensions`, `/api/calls`, `/api/queues`, `/api/status` | `calls:read` |
| Call origination | `POST /api/integration/click-to-call` | `calls:write` |
| Call history | `GET /api/call-log`, `/api/call-log/journey`, `/api/call-log/vad/{uniqueid}` | `cdr:read` |
| Recordings | `GET /api/recordings/{path}` | `cdr:read` |
| Analytics | `GET /api/analytics/{overview,queue-performance,agent-performance,agent-adherence,agent-adherence/export,heatmap,trend,drilldown,export}` | `analytics:read` |

Those four tokens are the complete set — `GET /api/api-keys/permissions` returns them,
and the Settings scope picker is rendered from that response. OpDesk deliberately does
not advertise scopes that gate nothing.

---

## Role levels

| Role | Sees |
|---|---|
| `admin` | Everything, plus configuration, user management, logs and API keys. |
| `supervisor` | Live state, history and analytics for the agents and queues in their assigned groups. Cannot manage users, groups, or API keys. |
| `agent` | Their own dashboard, extensions, active calls and call history. |

An API key authenticates as a **system** principal: unrestricted rows (no group
filtering), bounded by its scopes rather than by a role.

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
{ "deliveries": [ … ], "total": 412, "limit": 50, "offset": 0 }
```

## Errors

Every error body has the same shape:

```json
{ "detail": "Human-readable explanation" }
```

| Code | Meaning |
|---|---|
| `200` | OK |
| `201` | Created (a new API key) |
| `202` | Accepted — the work was queued, not completed (click-to-call, delivery resend) |
| `204` | No content (API key revoked) |
| `400` | Malformed request or a failed validation rule |
| `401` | Missing, invalid, disabled or expired credential |
| `403` | Authenticated, but not permitted (wrong role, or a key without the scope) |
| `404` | No such resource — or no such endpoint |
| `405` | The path exists but not for that method; the `Allow` header lists what is valid |
| `429` | Login rate limit; see `Retry-After` |
| `502` | An upstream (Asterisk, the CRM) refused the request |
| `503` | A dependency is unavailable — usually AMI is disconnected |
| `500` | Unhandled server error |

Concrete auth failures:

```json
// 401 — missing, unknown, disabled or expired key
{ "detail": "Invalid or expired API key" }

// 403 — valid key, but it lacks the scope this endpoint requires
{ "detail": "API key missing required scope: cdr:read" }

// 403 — valid JWT, insufficient role
{ "detail": "Admin only" }
```

> A request to an `/api/…` path always produces one of these JSON bodies. It never
> returns the SPA's HTML, including for a wrong method or an unknown path.

---

## WebSocket

```
wss://<host>/ws?token=<jwt>
```

Pushes live extension, call and queue state. **JWT only** — API keys are not accepted on
the WebSocket, and the stream is scoped by the connecting user's role.

---

## Pagination

Endpoints that can return unbounded collections take `limit` and `offset` and report the
unfiltered total:

```
GET /api/logs/deliveries?limit=50&offset=100
```

`limit` defaults to 50 and is clamped to 200.

## Dates and times

- Timestamps in responses are ISO 8601 (`2026-07-27T09:30:00`).
- `date_from` / `date_to` query parameters take `YYYY-MM-DD`. `date_to` is inclusive of
  the whole day.
- Durations are integer seconds unless the field name says otherwise.
