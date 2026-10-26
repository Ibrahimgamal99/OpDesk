# Endpoint reference

Conventions and authentication are described in [overview.md](overview.md). Each entry
below is marked:

- **Auth: JWT (role)** — requires a bearer token from a user with that role or higher.
- **Key: `scope`** — additionally reachable with an API key holding that scope.

An endpoint with no **Key:** line is JWT-only and returns `401` to an API key.

Rows are always filtered by the caller's history or live scope; see
[Visibility](overview.md#visibility).

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
**Auth:** JWT (any). Returns the caller's own profile and effective scope: `id`,
`username`, `name`, `role`, `extension`, `monitor_modes`, `allowed_agent_extensions`,
`allowed_queue_names`, `is_agent`.

---

## Live calls, extensions and queues

These return the caller's **live** scope: an agent sees their own extension and the
agents and queues of their groups.

### `GET /api/extensions`
**Auth:** JWT (any) · **Key:** `calls:read`

`{"extensions": [...]}` — every monitored extension with its current status, whether it
is in a call, and the call's details.

### `GET /api/calls`
**Auth:** JWT (any) · **Key:** `calls:read`

`{"calls": {"<ext>": {...}}}` — calls in progress right now: caller, destination,
queue, start and answer time.

### `GET /api/queues`
**Auth:** JWT (any) · **Key:** `calls:read`

`{"queues", "members", "entries"}` — queues with their members, member pause state and
reason, and the callers waiting.

### `GET /api/status`
**Auth:** JWT (any) · **Key:** `calls:read`

`{"connected", "extensions_count", "active_calls", "websocket_clients"}` — server and
AMI connection health.

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

### `GET /api/extension-config`
**Auth:** JWT (any)

Everything a softphone needs to register the signed-in user's extension: SIP
credentials, the transports a client outside the network can register on, the
extension's media settings and the ICE servers.

Query `transports`: `active` (default) lists only the transport(s) this extension is set
up for — its explicit PJSIP transport, else WSS for a WebRTC (DTLS) extension and
TLS/TCP/UDP for a plain one; `all` lists every transport the server offers.

```json
{
  "extension": "1001",
  "auth_username": "1001",
  "secret": "s3cr3t",
  "display_name": "Ahmed Ali",
  "domain": "pbx.example.com",
  "transports": [
    { "type": "wss", "uri": "wss://pbx.example.com:8443", "host": "pbx.example.com", "port": 8443, "path": "/" },
    { "type": "tls", "uri": "sip:pbx.example.com:5061;transport=tls", "host": "pbx.example.com", "port": 5061, "path": null }
  ],
  "media": { "encryption": "dtls", "ice": true, "avpf": true, "rtcp_mux": true, "codecs": ["opus", "ulaw"] },
  "ice_servers": [ { "urls": "stun:stun.l.google.com:19302", "username": null, "credential": null } ],
  "dial_strings_enabled": false
}
```

A user with no extension gets `extension`, `auth_username` and `secret` as `null`, an
empty `transports` list and `media: null`. `503` (`extension_config.unavailable`) when the
PBX database cannot be read: keep the credentials you already have and retry.

### `POST /api/extension-config/lookup`
**Key:** `extension-config:read` only — a user JWT is refused, whatever its role.

The same answer for any active OpDesk user, for a backend that hands its own app the
signed-in agent's SIP account. The user is named in the body, never in the URL:

```json
{ "username": "ahmed" }
```

or

```json
{ "extension": "1001" }
```

Exactly one of the two. `transports` works as above. `404`
(`extension_config.user_not_found`) when no active user matches.

---

## Call history and recordings

All of these apply the caller's **history** scope: an agent sees only calls on their own
extension, a supervisor the agents and queues of their groups.

### `GET /api/call-log`
**Auth:** JWT (any) · **Key:** `cdr:read`

Query: `date`, `date_from`, `date_to`, `search`, `limit` (default 100, must be positive),
`cursor` (the previous page's `next_cursor`), `order` (`desc` default, or `asc`), the table filters `status`,
`call_type` (`IN`/`OUT`/`INTERNAL`), `app` (`queue`/`ivr`/`direct`) and `route` (a route, or
its side `inbound`/`outbound`/`internal`), each a comma list, and `include_supervision`
(default `true`; supervisors' Listen/Whisper/Barge calls are never returned to an agent).
With no date and no search the last 30 days are returned; a `search` reaches all history.
`search` matches a Call ID, a number or caller-ID name on any leg of the call, or the name
of an agent or a phonebook contact.

Returns `{"calls": [...], "total": n, "next_cursor": "..." | null}`: `total` counts every
matching call, the same set the pages hold (`"capped": true` when a filtered page stopped scanning at 50,000 calls).
Each record carries:

| Field | Notes |
|---|---|
| `status` | The canonical outcome, one of the 10 [outcome values](webhooks.md#outcome-values); `canonical_status` repeats it for older mobile clients |
| `disposition` | The raw CDR disposition, kept alongside |
| `ended_by` | `agent`, `customer`, `system`, or `null` when Asterisk did not say |
| `ended_by_agent` | The agent's extension when `ended_by` is `agent`, else `null` |
| `duration`, `talk` | Wall-clock seconds of the whole call, and the talk time of the leg that was answered |
| `call_type` | `IN`, `OUT` or `INTERNAL` |
| `route` | `inbound_queue`, `inbound_ivr`, `inbound_direct`, `outbound_direct`, `internal_extension`, `internal_feature` or `internal_supervision` |
| `extension`, `agent_name` | The answering agent's extension and name |
| `phone_number`, `customer_name` | The external party, named by caller ID on inbound calls or the phonebook |
| `recording_file`, `recording_path` | Found on whichever leg of the call was recorded |
| `linkedid`, `uniqueid` | Cross-references into the journey, VAD and the CRM push |
| `call_journey_count` | Number of legs; at least 2 for a supervised call |
| `is_supervision`, `supervision`, `supervision_count` | Listen/whisper/barge on this call (`supervision_count` only on supervised calls) |

The outcome comes from the Asterisk hangup cause and dial status (read from CEL), not
only from the CDR disposition, so a caller who gave up (`MISSED`), an unregistered phone
(`UNREACHABLE`) and a carrier fault (`NETWORK_ERROR`) are told apart. A call with several
legs takes its outcome, talk time and agent from the last leg someone answered (a call
answered and then transferred to nobody is still `ANSWERED`), and a queue caller who hung
up while waiting is `ABANDONED`.

### `GET /api/call-log/export`
**Auth:** JWT (any) · **Key:** `cdr:read`

The same query parameters and the same scope as `GET /api/call-log`, as a CSV file with
one row per call (at most 50,000 rows; `limit` is ignored). Columns follow the call-log
record fields above.

### `GET /api/call-log/journey`
**Auth:** JWT (any) · **Key:** `cdr:read`

Query: `linkedid` (required). The per-leg timeline for one call, derived on demand from
CDR and CEL. `403` (`Not allowed to view this call`) when the call is outside the
caller's history scope, or the linkedid is unknown to a scoped user.

```json
{
  "journey": [
    { "event": "INBOUND", "time": "2026-07-27T09:30:00", "from_number": "+201001234567", "to_number": "200" },
    { "event": "IVR", "time": "2026-07-27T09:30:01", "duration": 9 },
    { "event": "QUEUE_ENTER", "time": "2026-07-27T09:30:10", "queue": "200", "duration": 12 },
    { "event": "RING", "time": "2026-07-27T09:30:10", "agent": "1001" },
    { "event": "ANSWER", "time": "2026-07-27T09:30:22", "agent": "1001", "duration": 251 },
    { "event": "LISTEN", "time": "2026-07-27T09:31:05", "supervisor": "1005", "target": "1001" },
    { "event": "HANGUP", "time": "2026-07-27T09:34:33", "reason": "16", "ended_by": "customer" }
  ]
}
```

| Event | Meaning and extra fields |
|---|---|
| `INBOUND`, `OUTBOUND` | Start of the call; `from_number`, `to_number` |
| `IVR` | The call passed through an IVR menu |
| `QUEUE_ENTER` | Entered a queue; `queue` |
| `RING` | An agent's phone rang; `agent` |
| `ANSWER` | An agent answered; `agent`. Not emitted for busy or unanswered legs |
| `UNANSWERED` | A ring that was not picked up; `agent` |
| `TRANSFER` | Transferred; `agent`, `to_number` |
| `LISTEN`, `WHISPER`, `BARGE` | Supervision; `supervisor`, `target` |
| `HANGUP` | End; `reason` (Q.850 cause), `ended_by`, `ended_by_agent` (only when `ended_by` is `agent`) |

`time` is ISO 8601 server-local time. `duration` (seconds) is how long the step lasted
and is omitted on the last step. `agent` is always a real extension, including for agents
reached through a `Local/` channel; it is omitted when there is none.

### `GET /api/call-log/vad/{uniqueid}`
**Auth:** JWT (any) · **Key:** `cdr:read`

Talk/silence analysis for a recorded call, when VAD is enabled: per-speaker talk
seconds, overlap and segments. Resolves through the call's other legs when the
requested one was not analysed. `403` out of scope, `404` when there is no analysis.

### `GET /api/recordings/{path}`
**Auth:** JWT (any) · **Key:** `cdr:read`

Streams the audio file. The credential goes in a header — `Authorization: Bearer <jwt>`
or `X-API-Key` — **never** in the URL: `?token=` is not accepted. A browser player
fetches the file with the header and plays the result as a blob.

`path` is the call-log `recording_path`, a path relative to the recording directory, or
a bare file name, which is looked up across the dated subdirectories. Paths are resolved
and confined to the recording directory; anything outside it is `403`, and so is a
recording of a call outside the caller's history scope. `Range` requests are honoured
(`206 Partial Content`), so players can seek.

The recording directory is where the recorder writes, `/var/spool/asterisk/monitor`, or
`ASTERISK_RECORDING_ROOT_DIR` when the deployment mounts the spool elsewhere. It is shown
under Settings → Recording but cannot be changed there.

### Recording management
**Auth:** JWT (admin) unless noted. None are key-reachable.

| Endpoint | Purpose |
|---|---|
| `GET /api/recording/status` | (any JWT) `{enabled, format, engine, mixed_dir}` |
| `POST /api/recording/enable` | `{format?}` (`wav` default, `wav49`, `gsm`, `g722`, `ulaw`, `alaw`, `sln`) — turn recording on |
| `POST /api/recording/disable` | Turn recording off |
| `GET /api/recording/policy` | `{engine, enabled, format, mixed_dir, directions: {inbound, outbound, internal}, extensions: [{extension, name, recording}]}` |
| `POST /api/recording/direction/{direction}` | `{enabled}` — record `inbound`, `outbound` or `internal` calls or not |
| `POST /api/recording/extension/{ext}` | `{recording}` — record calls involving one extension or not |
| `POST /api/recording/extensions/bulk` | `{recording, extensions?}` — many extensions at once (all when omitted); returns `{updated: [...]}` |
| `GET /api/recording/retention` | `{local_days, local_max_bytes, vad_delete_legs, root_dir}` |
| `POST /api/recording/retention` | Any of the same keys; `root_dir` is read-only (sending another directory is a 400) |
| `POST /api/recording/retention/run` | Run the daily clean-up now; returns what it deleted |
| `GET /api/recording/storage-stats` | `{total_recordings, local: {used_bytes, max_bytes, disk_free_bytes, disk_total_bytes, retention_days}}` |
| `GET /api/recordings` | `?limit=25&cursor=&search=&date_from=&date_to=` — `{recordings: [{calldate, src, dst, duration, billsec, recordingfile, uniqueid, linkedid, recording_path, size_bytes}], total, next_cursor}`; pass `next_cursor` as `cursor` for the next page |
| `DELETE /api/recordings/{uniqueid}` | Delete the recording file of one call (the CDR row stays); `{deleted, deleted_legs}` |

Recordings are kept on the PBX's disk only. The recorder keeps both directions of a call
in one file, and the ring-only files of legs that were never answered are removed.

### `GET /api/call-notifications`
**Auth:** JWT (any)

The missed-call bell: `{notifications, total}`, where `total` counts every match, not just
the page. An agent reads their own extension's notifications, a supervisor those of the
agents in their groups and their own, an admin their own unless `extension` names another.
Query `extension`, `status` (`new`, `read`, `archived`), `limit`.
Each notification's `reason` is a canonical [outcome value](webhooks.md#outcome-values)
(`BUSY`, `UNANSWERED`, `MISSED`, `UNREACHABLE`, `FAILURE`, `NETWORK_ERROR`); rows stored
by older versions in other spellings are converted on read.
`PATCH /api/call-notifications/{id}` with `{"status_flag": "read" | "archived"}`.

---

## Analytics

All of these are **Auth:** JWT (supervisor+) · **Key:** `analytics:read`, and accept
`date_from` / `date_to` (default: the last 30 days, today included). Agents get `403`. A
supervisor sees the queues and agents of their groups. A database error is a `500`, never
an empty report.

| Endpoint | Returns |
|---|---|
| `GET /api/analytics/overview` | Headline KPI cards for the period and the previous one (`prev_period` is `null` past 31 days) |
| `GET /api/analytics/queue-performance` | Per-queue volumes, answer rate, SLA, abandons, per-day series and wait buckets |
| `GET /api/analytics/agent-performance` | Per-agent handled calls, talk time, SLA contribution, internal calls |
| `GET /api/analytics/agent-calls` | One agent's calls by direction, with the call list (`?agent=`) |
| `GET /api/analytics/agent-adherence` | Logged-in, ready, on-call, wrap-up, break and DND time per agent |
| `GET /api/analytics/agent-adherence/timeline` | One agent's sessions and state changes (`?agent=`) |
| `GET /api/analytics/agent-adherence/export` | The adherence report as CSV/XLSX |
| `GET /api/analytics/heatmap` | Call volume by hour and weekday (`?queue=` narrows within scope) |
| `GET /api/analytics/trend` | Daily totals over the period, and calls by hour of day |
| `GET /api/analytics/drilldown` | The individual calls behind a KPI |
| `GET /api/analytics/export` | The drill-down rows as CSV/XLSX |
| `GET /api/analytics/export/{report}` | One report tab as CSV |

`GET|POST /api/analytics/settings` (SLA thresholds, FCR window, callback window) is
**admin JWT only** — it is configuration, not reporting. A value outside its range
(`sla_default_secs` and per-queue thresholds 1–600, `fcr_window_days` 0–90,
`short_abandon_secs` 0–120, `callback_window_hours` 0–168) is a `400` and nothing is
saved; a per-queue threshold of `null` removes that queue's override.

### `GET /api/analytics/overview`

`current` (and `prev_period`) carry the queue's own quality figures at the top level —
`total_calls`, `answered_calls`, `abandoned_calls`, `sla_pct`, `abandonment_rate`,
`short_abandon_rate`, `avg_wait_secs`, `aht_secs`, from the queue CDR exactly as
`/queue-performance` counts them — plus FCR (`fcr_pct`, `fcr_callers`,
`fcr_repeat_callers`, `fcr_provisional`), abandoned-caller recovery
(`abandoned_callers`, `recovered_callers`, `recovery_rate`, `net_abandonment_rate`) and
the call-history volume blocks `inbound`, `inbound_direct`, `outbound`, `internal` and
`combined`. `settings` repeats the thresholds the figures were computed against.

### `GET /api/analytics/drilldown`

Query: `queue`, `agent`, `direction`, `disposition`, `page` (from 1), `page_size`
(1–200, default 50), `facets`. `queue` and `agent` match exactly: the queue a queue call
entered, and the extension a call is credited to.

`disposition` names a call **status** — one of the 10
[outcome values](webhooks.md#outcome-values); raw CDR spellings such as `NO ANSWER` are
still accepted — and filters on the row's `status`. Each row carries `status` and the
raw `disposition`.

With `facets=1` the response adds counts under the same filters, for building the filter
menus:

```json
{
  "calls": [ … ], "total": 312, "page": 1, "page_size": 50,
  "facets": {
    "direction": { "IN": 250, "OUT": 62 },
    "status": { "ANSWERED": 270, "MISSED": 21, "ABANDONED": 12, "BUSY": 9 },
    "queue": { "800": 180, "801": 40 },
    "agent": { "1001": 120, "1002": 98 }
  }
}
```

`GET /api/analytics/export` writes the same rows (Status as the table shows it, and
Direction) up to 100,000; a cut file ends with a line saying so and carries an
`X-Export-Truncated: <total>` header.

### `GET /api/analytics/agent-adherence`

`{"agents": [...], "reasons": [...]}`. Each agent row has `login` / `logout` (the first
session's login and the last session's logout, `null` while still logged in, cut at the
shift reset), `logged_in`, `sessions`, `logged_in_secs` (DND included), `ready_secs`,
`on_call_secs`, `wrap_secs`, `not_ready_secs`, `productive_not_ready_secs`, `break_secs`,
`dnd_secs`, `occupancy_pct` and a `not_ready_breakdown` per reason code. The export adds
Sessions, Break and DND columns.

### `GET /api/analytics/agent-adherence/timeline`

Query: `agent` (required) plus the date range. `403` when the agent is outside the
caller's scope.

```json
{
  "agent": "1001", "name": "Ahmed Ali",
  "sessions": [
    {
      "login": "2026-07-27T09:00:00", "logout": "2026-07-27T17:02:10",
      "open": false, "closed_by": "agent", "duration_secs": 28930,
      "entries": [
        {
          "id": 812, "state": "not_ready", "reason_code": "LUNCH", "reason_label": "Lunch",
          "queue": null, "source": "softphone",
          "started_at": "2026-07-27T13:00:00", "ended_at": "2026-07-27T13:30:00",
          "open": false, "duration_secs": 1800
        }
      ]
    }
  ]
}
```

### `GET /api/analytics/export/{report}`

`report` is one of `overview`, `queues`, `agents`, `heatmap`, `trend`: a CSV of what
that tab shows, taking the same query parameters as its JSON route
(`/overview`, `/queue-performance`, `/agent-performance`, `/heatmap`, `/trend`).
Any other value is `404`.

---

## Not-Ready codes and agent presence

### `GET /api/pause-reasons`
**Auth:** JWT (any)

`{"reasons": [{id, code, label, productive, color, sort_order, is_active, is_system}]}`.

| Query | Default | Notes |
|---|---|---|
| `active_only` | `false` | Only active codes |
| `include_system` | `false` | Include system reasons such as `__WRAPUP` |

For non-admins both are forced: active, non-system codes only.

`POST /api/pause-reasons`, `PATCH|DELETE /api/pause-reasons/{id}` are admin only. A code
may not start with `__` (reserved for system reasons), and system reasons cannot be
edited or deleted.

### `POST /api/agent/login`, `POST /api/agent/logout`
**Auth:** JWT (any) — the caller's own extension.

Log the agent into or out of the queues assigned to them. `login` takes `{ready?}`
(default `true`).

### `POST /api/agent/status`
**Auth:** JWT (any) — the caller's own extension.

`{"ready": false, "reason_code": "LUNCH"}` pauses the agent in every queue they are a
member of, with that reason; `{"ready": true}` unpauses them. A Not-Ready request with a
missing, unknown, inactive or system `reason_code` is `400`
(`A valid Not-Ready reason is required`). The reason survives the phone's device-state
changes and is cleared on unpause. Agents cannot change another agent's status.

### `GET /api/agent/status`
**Auth:** JWT (any)

The caller's own presence, for bootstrapping a softphone bar:

```json
{ "extension": "1001", "state": "not_ready", "presence": { "state": "not_ready", "reason_code": "LUNCH", "since": "2026-07-27T13:00:00", "duration_secs": 95 } }
```

`state` is `ready`, `not_ready`, `on_call`, `wrap_up`, `dnd`, `available` or
`logged_out`; `presence` is `null` when logged out.

### `GET|POST /api/agents/wrapup-config`
**Auth:** GET any JWT, POST admin.

`{"max_secs": 30, "min_secs": 0, "max_secs_limit": 1800}` — how long an agent stays in
wrap-up after a call before returning to Ready (`0` = until they end it). POST
`{"max_secs": n}`; the value is clamped to the bounds and applies from the next call.

### `GET|POST /api/agents/shift-reset`
**Auth:** GET any JWT, POST admin.

`{"time": "04:00"}` — the time of day at which every signed-in agent is logged out of
their queues, so a shift left open does not run into the next one. `""` turns it off.
`400` unless `HH:MM` (24-hour) or empty.

---

## API key management

Admin JWT only. A key can never mint, inspect or escalate another key.

### `GET /api/api-keys/permissions`
The scope tokens available to grant.

```json
{ "permissions": ["calls:read", "calls:write", "cdr:read", "analytics:read", "extension-config:read", "contacts:read", "contacts:write"] }
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
| `GET /api/logs/deliveries` | Page through CRM pushes, with totals per status |
| `GET /api/logs/deliveries/{id}` | One delivery in full, with request and response bodies |
| `POST /api/logs/deliveries/{id}/retry` | Send a pending / failed / abandoned delivery again now |
| `POST /api/logs/deliveries/{id}/resend` | Replay a delivery as a new one — `202` |

`GET /api/logs/deliveries` accepts `status` (`pending`, `delivered`, `failed`,
`abandoned`, or `unresolved` for the first, third and fourth together; anything else is a
`400`), `success` (`true`/`false`), `call_id`, `call_type`, `search` (matches caller,
destination, call ID, uniqueid), `date_from`, `date_to`, `limit` (default 50, max 200),
`cursor`, and `facets=1`, newest first. Next to the page come `counts` (every status's
total) and, with `facets=1`, `facets`: how many rows each status and each `call_type` has
under the other filters (each facet ignores its own filter):

```json
{
  "data": [
    {
      "id": 1041, "created_at": "2026-07-27T09:31:02",
      "call_id": "1753600000.42", "uniqueid": "1753600000.43",
      "caller": "+201001234567", "destination": "1001",
      "call_type": "inbound", "call_status": "ANSWERED",
      "method": "POST", "url": "https://crm.example.com/api/calls",
      "status_code": 200, "success": true, "error": null,
      "duration_ms": 148, "attempt": 1, "parent_id": null,
      "resent_by": null, "truncated": false,
      "status": "delivered", "attempts": 1, "max_attempts": 5,
      "next_attempt_at": null, "delivered_at": "2026-07-27T09:31:02",
      "trigger_kind": "hangup", "endpoint_path": null,
      "delivery_uuid": "6f1c2a4e-0b7d-4c55-9a51-2f7e1b1f3d10"
    }
  ],
  "page": { "cursor": null, "next_cursor": "eyJpZCI6MTA0MX0", "limit": 50 },
  "counts": { "pending": 2, "delivered": 1032, "failed": 5, "abandoned": 1 },
  "facets": { "status": { "delivered": 40, "failed": 2 }, "call_type": { "inbound": 30, "outbound": 12 } }
}
```

`status` is the delivery's state in the retry queue (see
[webhooks.md → Retries](webhooks.md#retries)): `attempts` of `max_attempts` were made, and
a `pending` row is sent again at `next_attempt_at`. `delivery_uuid` is the
`Idempotency-Key` every attempt of it carried.

Bodies are omitted from the list and served only by the detail route.

Retry makes the **same** delivery due now (giving it up to 3 more attempts when its
budget is spent), sends it at once with its existing idempotency key, and answers
`{"ok": true, "delivery": {...}}` with the row as it stands after the attempt. `404` when
the delivery does not exist, was already delivered, or its body was truncated.

Resend replays the **stored request body** through the **current** CRM configuration —
the body is the historical fact worth replaying, while the credentials and endpoint are
re-read because a wrong endpoint is usually why the original failed. It is a new
delivery, with a new idempotency key and `parent_id` pointing at the original. `400` if
the stored body was truncated when logged, `503` if no CRM connector is configured.

### `GET /api/audit-log`
**Auth:** JWT (admin)

Who changed what. Every successful `POST`, `PUT`, `PATCH` and `DELETE` under `/api` is
recorded — except sign-in, browser log relay, the log-capture toggles, the loopback
hooks and device-token and push-subscription refreshes, which are noise. Request bodies
are never stored as they are: a route records what the change carried in `detail`, built
from an explicit field list, with every secret-named field (`password`, `api_key`,
`*_SECRET`, `*_PASS`, …) replaced by `"********"` — the row says a secret changed, never
what to.

| Query | Notes |
|---|---|
| `action` | `create`, `update`, `delete`, … |
| `entity_type` | What was changed: `user`, `group`, `settings`, `api_key`, … |
| `actor` | The acting user's name, username or extension |
| `from`, `to` | `YYYY-MM-DD`, inclusive |
| `limit`, `cursor` | Cursor paging, newest first; pass the previous page's `next_cursor` |
| `facets` | `1` adds per-action and per-entity-type counts under the same filters |

```json
{
  "entries": [
    {
      "id": 77, "created_at": "2026-07-27T10:02:11", "actor": "Sara Ali",
      "actor_ext": "1000", "actor_user_id": 1, "action": "update",
      "entity_type": "user", "entity_id": "12", "summary": "PUT /api/settings/users/12",
      "ip": "10.0.0.15",
      "detail": {
        "before": { "username": "sara", "extension": "1000", "role": "supervisor" },
        "changed": { "role": "admin", "password": "********" }
      }
    }
  ],
  "next_cursor": "eyJiZWZvcmVfaWQiOjc3fQ",
  "facets": {
    "action": { "update": 40, "create": 9, "delete": 2 },
    "entity_type": { "user": 21, "settings": 30 }
  }
}
```

`next_cursor` is `null` on the last page. `detail` is `null` for a route that records
none.

---

## Other JWT-only surfaces

Configuration and operational endpoints, all requiring a JWT and (except where noted)
the admin role. None are key-reachable.

| Area | Paths |
|---|---|
| Users, groups, agents, queues | `/api/settings/users*`, `/api/settings/groups*`, `/api/settings/agents`, `/api/settings/queues`. A username, extension or group name already in use is `409`. A user's `password` (8+ characters) is the OpDesk sign-in password only and never changes the extension's SIP secret; that is `PUT /api/settings/extensions/{extension}/credentials`. Unlinking or moving a user off an extension, deactivating them, or deleting them gives that extension a fresh random SIP secret (its phones sign out), so the person can no longer register with the one they knew. A save that landed in OpDesk but not in the PBX (name, secret or reload) is a `502` that says what did not apply. |
| Contacts phonebook | `GET /api/contacts?search=&limit=&cursor=`, `GET /api/contacts/{id}` (any role; key: `contacts:read`), `POST /api/contacts`, `POST /api/contacts/bulk` (admin; key: `contacts:write`, upsert with precedence manual > api > crm, max 500 per request), `PUT|DELETE /api/contacts/{id}` (admin) — see [contact-lookup.md](contact-lookup.md) |
| Raw settings key/value store | `GET|POST /api/settings`, `GET /api/settings/{key}` — secrets read back as `"********"`, and posting the mask keeps the stored value |
| WebRTC provisioning | `GET /api/webrtc/config`, `GET /api/settings/extensions/webrtc`, `GET /api/settings/extensions/{extension}/credentials` (admin; includes `max_contacts`, `null` when the PBX database cannot be read), `PUT /api/settings/extensions/{extension}/webrtc` |
| Extension SIP secret | `PUT /api/settings/extensions/{extension}/credentials` (admin): `{"regenerate": true}` for a random 16-character secret, or `{"password": "<8+ characters>"}` for an exact one. Separate from the user's OpDesk sign-in password; applies the PBX config and answers the same shape as the `GET`. `404` unknown extension, `503` PBX database unreachable, `502` write failed |
| Multi-device registration | `PUT /api/settings/extensions/{extension}/max-contacts` `{"enabled": bool}` (admin, or the extension's own user / a supervisor allowed on it): PJSIP `max_contacts` 2 (browser and phone at once) or 1. A value above 2 set by hand in the PBX is left alone when enabling. Answers `{ok, extension, max_contacts}` |
| Audio codecs | `GET|PUT /api/codecs` (admin, FreePBX only — `404` on Issabel, which keeps codecs per peer): `{codecs: [...], available: [...]}`, first = preferred. `PUT {"codecs": [...]}` accepts only codecs from `available`, rejects an empty or repeated list (`400`), and reloads the PBX unless the list is unchanged (`502` when the reload fails) |
| CRM configuration | `GET|POST /api/crm/config`, `POST /api/crm/test` — `call_outcomes` lists the 10 outcome values. The save validates the whole body first and writes it in one transaction (a `400` changes nothing); it refuses an enabled CRM it cannot build, any `endpoint_path` / `sync_endpoint` / `lookup_url` that is not a plain path (no `@`, `://`, backslash or spaces), an SSRF-unsafe server or OAuth2 token URL, and an enabled lookup without a name template. Answers `{success, reload_ok, active, warnings, message}`; `active: false` means it saved but is not live. Push timing and retries: `sync_trigger` (`hangup` / `wrapup`), `sync_wrapup_timeout`, `sync_retry_enabled`, `sync_retry_max_attempts`, `sync_retry_delays` — see [webhooks.md](webhooks.md) |
| Telephony features | `/api/qos/*`, `/api/sip-tls/*`, `/api/mobile-wake/*`. `GET /api/sip-tls/status` also carries `udp_tcp_public`, the `SIP_UDP_TCP_PUBLIC` setting (default off, written through `POST /api/settings`): whether plain 5060 UDP/TCP is reachable from outside and may be offered to apps by `/api/extension-config` |
| Extension control | `POST /api/extensions/{extension}/dnd` |
| Notifications and push | `/api/call-notifications*`, `/api/device-tokens`, `/api/push/*` |
| Browser log relay | `POST /api/client-log` (unauthenticated by design — `sendBeacon` cannot set headers) |

### Loopback-only internal hooks

`GET|POST /api/internal/mobile-wake/{extension}?uid=&caller=&name=` is called by the
Asterisk dialplan to send the RFC 8599 wake push before contact resolution; it answers
`1` when the call should be held. While holding, the dialplan calls
`/api/internal/mobile-wake/{extension}/ready?uid=` (`1` once the phone has re-registered),
then `/done`, or `/cancel` when the hold runs out or the caller hangs up. These take **no
credential** and are instead restricted to callers on `127.0.0.1` / `::1` — anything else
gets `403`. `X-Forwarded-For` is trusted only from a loopback peer, so the bundled nginx
proxy cannot be used to reach them from outside. They accept `GET` because Asterisk's
`CURL()` dialplan function issues one. Do not expose these paths through a reverse proxy.

### Mobile softphone (admin UI)

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET /api/push/config` | admin | Mobile Wake settings, FCM / APNs / VAPID status (secrets as present/absent only), RFC 8599 bindings |
| `PUT /api/push/config` | admin | Save them, all or nothing. Every field is optional and one left out keeps its stored value; key files are sent as their contents (`null` keeps, `""` removes). An empty `client_marker` is stored as empty (only RFC 8599 contacts then count as mobile). Invalid input is one `422` `push.config.invalid` whose `fields` lists every wrong field (`hold_seconds`, `settle_seconds`, `fcm_project_id`, `fcm_service_account`, `apns_key_id`, `apns_team_id`, `apns_bundle_id`, `apns_auth_key`); nothing is written then. A failed write is a `500` with nothing changed |
| `POST /api/push/vapid/rotate` | admin | New VAPID key pair; deletes every browser subscription in the same transaction (a `500` changes nothing, subscriptions included) |
| `DELETE /api/push/bindings/{id}` | admin | Forget one RFC 8599 binding |
| `GET /api/mobile-setup` | JWT | The caller's own QR data: extension, SIP password, host, and `account`, the full Medut account JSON (transport, `server_url`, `media_enc`, `ice_enabled`, STUN/TURN, `verify_tls`) built from the extension's PBX settings |
| `POST /api/me/password` | JWT | Change the caller's OpDesk sign-in password: `{current_password, new_password}` |
| `POST /api/me/sip-password` | JWT | Change the SIP secret of the caller's extension (same body; reloads Asterisk) |
| `GET /api/settings/users/{id}/mobile-setup` | admin | The same for any user |

---

## Health and specification

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET /health` | public | `{"status": "ok", "ami_connected": true}` |
| `GET /api/openapi.yaml` | public | The OpenAPI 3.0 spec in this repo |
| `GET /docs`, `GET /redoc`, `GET /openapi.json` | public | Interactive documentation of every route the server exposes |
