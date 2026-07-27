# Endpoint reference

Conventions and authentication are described in [overview.md](overview.md). Each entry
below is marked:

- **Auth: JWT (role)** — requires a bearer token from a user with that role or higher.
- **Key: `scope`** — additionally reachable with an API key holding that scope.

An endpoint with no **Key:** line is JWT-only and returns `401` to an API key.

---

## Authentication

### `POST /api/auth/login`
Public. Exchange credentials for a JWT.

```bash
curl -X POST https://opdesk.example.com/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"login": "1001", "password": "…"}'
```

`login` is a username **or** an extension. Returns `{access_token, token_type, user}`.
`401` on bad credentials, `429` after 10 failures from one IP within 5 minutes.

### `GET /api/auth/me`
**Auth:** JWT (any). Returns the caller's own profile and effective scope.

---

## Live calls, extensions and queues

### `GET /api/extensions`
**Auth:** JWT (any) · **Key:** `calls:read`

Every monitored extension with its current status, active call and DND state.

### `GET /api/calls`
**Auth:** JWT (any) · **Key:** `calls:read`

Calls in progress right now — caller, destination, direction, queue, duration so far.

### `GET /api/queues`
**Auth:** JWT (supervisor+) · **Key:** `calls:read`

Queues with members, waiting callers and per-queue counters.

### `GET /api/status`
**Auth:** JWT (any) · **Key:** `calls:read`

Server and AMI connection health.

### `POST /api/calls/transfer`
**Auth:** JWT (any)

Transfers the caller's own active softphone call. **Not key-reachable** — it resolves the
source extension from the calling *user's* WebRTC credentials, which a machine principal
does not have.

---

## Integration

### `POST /api/integration/click-to-call`
**Auth:** JWT (see below) · **Key:** `calls:write`

Rings `extension`; when it answers, dials `number`.

**Request**

```json
{
  "extension": "1001",
  "number": "+201001234567",
  "caller_id": "Sales <2000>",
  "timeout": 30
}
```

| Field | Required | Notes |
|---|---|---|
| `extension` | yes | Must be a monitored extension. Rung first. |
| `number` | yes | Dialled once the extension answers. Spaces, dashes, dots and brackets are stripped; the result must match `\+?[0-9*#]{2,20}`. |
| `caller_id` | no | Caller ID presented on the outbound leg. Defaults to the extension. |
| `timeout` | no | Seconds to ring, 5–120. Default 30. |

**Response — `202 Accepted`**

```json
{
  "accepted": true,
  "action_id": "c2c-1001-1753600000123",
  "extension": "1001",
  "number": "+201001234567"
}
```

`202`, not `200`: Asterisk acknowledges the origination long before the call connects.
Correlate the outcome via `action_id`, the WebSocket stream, or the CDR.

**Example**

```bash
curl -X POST https://opdesk.example.com/api/integration/click-to-call \
  -H 'X-API-Key: opd_9f2c…' \
  -H 'Content-Type: application/json' \
  -d '{"extension": "1001", "number": "+201001234567"}'
```

**Errors**

| Code | Cause |
|---|---|
| `400` | `extension` missing; `number` malformed or empty; `timeout` outside 5–120 |
| `401` | Missing/invalid credential |
| `403` | Key lacks `calls:write`; or a non-admin user tried to dial from an extension that is not theirs |
| `404` | `Unknown extension: 1001` — not a monitored extension |
| `502` | Asterisk rejected the origination (the AMI `Message` is included) |
| `503` | AMI is not connected |

> **Authorisation note.** A JWT is accepted as a fallback, so the route adds its own
> check on top of the scope: admins may originate from any extension, everyone else only
> from their own or one in their assigned groups. An API key may use any monitored
> extension.

---

## Call history and recordings

### `GET /api/call-log`
**Auth:** JWT (any, row-scoped) · **Key:** `cdr:read`

Query: `date_from`, `date_to`, `search`, `limit`.

Each record carries `status` — the canonical outcome (see
[webhooks.md](webhooks.md#outcome-values)) — alongside the raw CDR `disposition`,
`duration` (wall-clock seconds), `talk` (billed seconds), `call_type`, `extension`,
`recording_path` and `linkedid`.

### `GET /api/call-log/journey`
**Auth:** JWT (any) · **Key:** `cdr:read`

Query: `linkedid`. The per-leg timeline for one call, derived on demand from the CDR.

### `GET /api/call-log/vad/{uniqueid}`
**Auth:** JWT (any) · **Key:** `cdr:read`

Talk/silence analysis for a recorded call, when VAD is enabled.

### `GET /api/recordings/{path}`
**Auth:** JWT (any) · **Key:** `cdr:read`

Streams the audio file. Also accepts `?token=<jwt>` because an `<audio src>` cannot set
headers. Paths are resolved and confined to the recording root; anything outside it is
`403`.

---

## Analytics

All of these are **Auth:** JWT (supervisor+) · **Key:** `analytics:read`, and accept
`date_from` / `date_to`.

| Endpoint | Returns |
|---|---|
| `GET /api/analytics/overview` | Headline KPI cards for the period |
| `GET /api/analytics/queue-performance` | Per-queue volumes, answer rate, SLA, abandons |
| `GET /api/analytics/agent-performance` | Per-agent handled calls, talk time, availability |
| `GET /api/analytics/agent-adherence` | Scheduled vs actual presence per agent |
| `GET /api/analytics/agent-adherence/export` | The same, as CSV/XLSX |
| `GET /api/analytics/heatmap` | Call volume by hour and weekday |
| `GET /api/analytics/trend` | A KPI over time |
| `GET /api/analytics/drilldown` | The individual calls behind a KPI |
| `GET /api/analytics/export` | Full period export (CSV/XLSX) |

`GET|POST /api/analytics/settings` (SLA thresholds, FCR window) is **admin JWT only** —
it is configuration, not reporting.

---

## API key management

Admin JWT only. A key can never mint, inspect or escalate another key.

### `GET /api/api-keys/permissions`
The scope tokens available to grant.

```json
{ "permissions": ["calls:read", "calls:write", "cdr:read", "analytics:read"] }
```

### `GET /api/api-keys`
All keys, metadata only — the plaintext is unrecoverable after creation.

```json
{
  "api_keys": [
    {
      "id": 3, "name": "Reporting integration", "key_prefix": "opd_9f2c1a4b",
      "scopes": ["cdr:read", "analytics:read"], "enabled": true,
      "created_by": 1, "last_used_at": "2026-07-27T08:12:44",
      "expires_at": null, "created_at": "2026-06-01T10:00:00"
    }
  ]
}
```

### `POST /api/api-keys` → `201`

```json
{ "name": "Reporting integration", "scopes": ["cdr:read", "analytics:read"], "expires_at": "2027-01-01" }
```

The response is the key's metadata **plus a one-time `key` field**:

```json
{
  "id": 3, "name": "Reporting integration", "key_prefix": "opd_9f2c1a4b",
  "scopes": ["cdr:read", "analytics:read"], "enabled": true,
  "expires_at": "2027-01-01T00:00:00",
  "key": "opd_9f2c1a4b7e3d5c8a1f6b2e9d4c7a0f3b6e1d8c5a"
}
```

Store it now — it is never returned again.

`expires_at` accepts `YYYY-MM-DD` or ISO 8601; omit it for a key that never expires.
`400` on a blank name, an empty scope list, or `Unknown scope(s): …`.

### `PATCH /api/api-keys/{id}`
Partial update of `name`, `scopes`, `enabled` or `expires_at`. An `expires_at` of `""`
clears the expiry. `404` if the key does not exist.

### `DELETE /api/api-keys/{id}` → `204`
Revokes the key. It stops authenticating immediately.

---

## Logs

Admin JWT only, and deliberately **not** key-reachable: the delivery log contains raw CRM
request bodies, so a `cdr:read` integration must not be able to read them.

| Endpoint | Purpose |
|---|---|
| `GET /api/logs?since=&event=&q=` | Buffered AMI events newer than the `since` cursor |
| `GET /api/logs/events` | Distinct event names currently buffered |
| `GET /api/logs/ami` | Whether event capture is on |
| `POST /api/logs/ami` | `{"enabled": true\|false}` — toggle capture (off by default) |
| `GET /api/logs/deliveries` | Page through CRM push attempts |
| `GET /api/logs/deliveries/{id}` | One attempt in full, with request and response bodies |
| `POST /api/logs/deliveries/{id}/resend` | Replay a delivery — `202` |

`GET /api/logs/deliveries` accepts `success` (`true`/`false`), `call_id`, `call_type`,
`search` (matches caller, destination, call ID, uniqueid), `date_from`, `date_to`,
`limit`, `offset`.

```json
{
  "deliveries": [
    {
      "id": 1041, "created_at": "2026-07-27T09:31:02",
      "call_id": "1753600000.42", "uniqueid": "1753600000.43",
      "caller": "+201001234567", "destination": "1001",
      "call_type": "inbound", "call_status": "ANSWERED",
      "method": "POST", "url": "https://crm.example.com/api/calls",
      "status_code": 200, "success": true, "error": null,
      "duration_ms": 148, "attempt": 1, "parent_id": null,
      "resent_by": null, "truncated": false
    }
  ],
  "total": 412, "limit": 50, "offset": 0
}
```

Bodies are omitted from the list and served only by the detail route.

Resend replays the **stored request body** through the **current** CRM configuration —
the body is the historical fact worth replaying, while the credentials and endpoint are
re-read because a wrong endpoint is usually why the original failed. The new attempt is
inserted as its own row with `parent_id` pointing at the original. `400` if the stored
body was truncated when logged, `503` if no CRM connector is configured.

---

## Other JWT-only surfaces

Configuration and operational endpoints, all requiring a JWT and (except where noted)
the admin role. None are key-reachable.

| Area | Paths |
|---|---|
| Users, groups, agents, queues | `/api/settings/users*`, `/api/settings/groups*`, `/api/settings/agents`, `/api/settings/queues` |
| Raw settings key/value store | `GET|POST /api/settings`, `GET /api/settings/{key}` |
| WebRTC provisioning | `GET /api/webrtc/config`, `GET /api/settings/extensions/webrtc`, `GET /api/settings/extensions/{extension}/credentials`, `PUT /api/settings/extensions/{extension}/webrtc` |
| CRM configuration | `GET|POST /api/crm/config`, `POST /api/crm/test` |
| Telephony features | `/api/qos/*`, `/api/sip-tls/*`, `/api/recording/*`, `/api/mobile-wake/*` |
| Extension control | `POST /api/extensions/{extension}/dnd` |
| Not-ready codes | `/api/pause-reasons*` |
| Agent self-service | `POST /api/agent/{login,logout,status}` (agent role, own data) |
| Notifications and push | `/api/call-notifications*`, `/api/device-tokens`, `/api/push/*` |
| Browser log relay | `POST /api/client-log` (unauthenticated by design — `sendBeacon` cannot set headers) |

### Loopback-only internal hooks

`GET|POST /api/internal/mobile-wake/{extension}` is called by the Asterisk dialplan to
wake a mobile softphone before contact resolution. It takes **no credential** and is
instead restricted to callers on `127.0.0.1` / `::1` — anything else gets `403`. It
accepts `GET` because Asterisk's `CURL()` dialplan function issues one. Do not expose
this path through a reverse proxy.

---

## Health and specification

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET /health` | public | `{"status": "ok", "ami_connected": true}` |
| `GET /api/openapi.yaml` | public | The OpenAPI 3.0 spec in this repo |
| `GET /docs`, `GET /redoc` | public | FastAPI's generated interactive documentation |
