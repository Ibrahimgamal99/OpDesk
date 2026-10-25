# OpDesk → CRM call-data push

After every call ends, OpDesk can POST a summary of it to your CRM. This document is the
contract for that outgoing request. For the *incoming* API see
[endpoints.md](endpoints.md).

Configure it under **Settings → Integrations / CRM**.

> ### ⚠️ Breaking change for existing integrations
>
> The payload uses **camelCase wire keys** (`talkTime`, `status`, `startTime`,
> `agentExt`, …). Earlier versions sent the raw internal names (`talk_time`,
> `call_status`, `datetime`, `agent`).
>
> The `call_status` and `disposition` **values** are now the 10-value outcome
> vocabulary — see [Outcome values](#outcome-values). The old words are gone:
> `NO_ANSWER` is `UNANSWERED`, `CANCELED` is `MISSED` (or `UNANSWERED` on an outbound
> call), `OUT_OF_REACH` is `UNREACHABLE`, and network faults that used to read `FAILURE`
> are `NETWORK_ERROR`. Older still, `completed`/`noanswer`/`switched_off`/`invalid_number`
> map the same way.
>
> If your receiver parses the old names or values, either update it or use the
> [key map](#renaming-keys) and [outcome map](#remapping-outcome-values) to reproduce the
> previous wire format without changing your CRM.

---

## When it fires

From the AMI monitor, never blocking call processing. **When to push**
(`sync_trigger`) picks the moment:

- **At hangup** (`hangup`, default) — as soon as the call ends.
- **After wrap-up** (`wrapup`) — once the agent who took the call has finished wrap-up,
  so the record matches the final call log (the finalized CDR's identity is laid over the
  payload again). A call nobody answered has no wrap-up and goes out on the next sweep
  (within ~15 s). `sync_wrapup_timeout` (seconds, default 600, 5–86400) is the longest
  wait: past it the push goes out anyway.

A call is skipped when:

- call-data sync is disabled;
- the call's direction (`inbound` / `outbound` / `internal`) is de-selected.

When CRM is **enabled but its connector cannot be built** (no server URL, a missing
credential), every call is recorded in the delivery log as a failed delivery naming what
is missing, so a misconfigured connector does not look like "no calls". Saving such a
configuration is refused with a 400; a configuration that saves but does not come up
live answers `active: false` with a warning.

## Retries

Every push is written to the delivery log **before** its first attempt, so a CRM that is
down, 502-ing or slower than the timeout costs a retry rather than the call. A
background worker re-sends due deliveries every 15 s.

| Failure | Retried? |
|---|---|
| No response (refused, DNS, TLS, timeout) | yes |
| `5xx` | yes |
| `408`, `423`, `425`, `429` | yes |
| any other `4xx` (the CRM rejected this payload), or a target the SSRF guard refuses | no — marked **failed** |

Settings (`GET`/`POST /api/crm/config`):

- `sync_retry_enabled` (default on) — off means one attempt per call;
- `sync_retry_max_attempts` (default 5, 1–20) — attempts per call, the first included;
- `sync_retry_delays` (default `30,120,600,1800` seconds) — the wait before attempt 2, 3,
  …; the last value repeats.

A `Retry-After` header (seconds or an HTTP date, capped at 24 h) wins when it asks for
**more** time than the ladder, never less, so `Retry-After: 0` cannot cause a hot loop.
A delivery whose budget is spent on transient failures is marked **abandoned**.

### Idempotency

Every attempt of one delivery carries the same key in two headers:

```
Idempotency-Key: 6f1c2a4e-…
X-OpDesk-Delivery-Id: 6f1c2a4e-…
```

When a first attempt reached your CRM but its response was lost, the retry carries the
same key: store it and ignore a repeat to avoid a duplicate call record. A manual
**Resend** is a deliberate new delivery and gets a new key; **Retry now** re-sends the
same delivery with its existing key.

## Transport

```
{server_url}{sync_endpoint or endpoint_path}
```

`POST` (default) or `PUT`, JSON body, configurable timeout and TLS verification.

The URL is SSRF-checked when it is saved **and again before every request** (what the
host resolves to then, not only at save time). Loopback, link-local (including the
`169.254.169.254` cloud metadata address), multicast, reserved and unspecified addresses
are **always** blocked. RFC-1918 private ranges are **allowed by default**, because an
on-prem CRM on the LAN is a first-class deployment; tick *Block private addresses* for a
stricter posture.

- `endpoint_path`, `sync_endpoint` and the lookup URL are paths appended to the server
  URL: they must start with `/` and may not contain `@`, `://`, a backslash or spaces
  (`https://crm.example.com` + `@169.254.169.254/x` would otherwise be a request to the
  metadata service). A request whose final URL leaves the configured host is refused.
- The OAuth2 token URL is checked the same way as the server URL.
- The push never follows redirects (a `3xx` is a failed delivery). The connection test
  follows at most 5, vetting each hop before requesting it.

## Authentication

Four modes. Every request also carries `Content-Type: application/json` and
`User-Agent: OpDesk-CRM-Connector/1.0`.

### API key

```http
POST /api/calls HTTP/1.1
Host: crm.example.com
Content-Type: application/json
User-Agent: OpDesk-CRM-Connector/1.0
X-API-Key: <your key>
```

The header name is configurable; it defaults to `X-API-Key`.

### Basic auth

```http
Authorization: Basic base64(username:password)
```

### Bearer token

```http
Authorization: Bearer <token>
```

### OAuth2 (client credentials)

OpDesk POSTs `client_id`, `client_secret` and `scope` to your token URL, caches the token
until 60 s before it expires, refreshes it under a lock, and sends:

```http
Authorization: Bearer <fetched access_token>
```

---

## Field catalog

Every field is opt-in — pick them under *Fields to send*. A field is omitted from the
body when its value is absent or empty (numeric `0` is kept, and counts as present).

| Wire key | Internal name | Type | Example | Notes |
|---|---|---|---|---|
| `caller` | `caller` | string | `"+201001234567"` | Calling party |
| `destination` | `destination` | string | `"1001"` | Called party |
| `duration` | `duration` | string \| int | `"00:05:23"` / `323` | Total call time. Key and type depend on [duration format](#duration-format) |
| `talkTime` | `talk_time` | string \| int | `"00:04:11"` / `251` | Answer → hangup. Same |
| `startTime` | `datetime` | string | `"2026-07-27T09:30:00"` | Call start, ISO 8601 |
| `status` | `call_status` | enum | `"ANSWERED"` | See [outcome values](#outcome-values) |
| `callType` | `call_type` | enum | `"inbound"` | `inbound` \| `outbound` \| `internal` |
| `queue` | `queue` | string | `"200"` | Queue calls only |
| `callerName` | `caller_name` | string | `"Ahmed Ali"` | Best-effort, from CallerID |
| `callId` | `call_id` | string | `"1753600000.42"` | Asterisk Linkedid — the cross-reference handle into OpDesk's call log |
| `uniqueId` | `uniqueid` | string | `"1753600000.43"` | Per-leg id; use it to de-duplicate |
| `disposition` | `disposition` | enum | `"ANSWERED"` | Same value as `status`, under the key CRMs commonly expect |
| `hangupCause` | `hangup_cause` | string | `"16"` | Raw Q.850 cause code |
| `agentExt` | `agent` | **int** | `1001` | Answering agent's extension. Always sent as a number |
| `agentName` | `agent_name` | string | `"Ahmed Ali"` | Display name, when resolvable |
| `answeredExtension` | `answered_extension` | string | `"1001"` | Extension that answered |
| `queueWaitTime` | `queue_wait_time` | int | `12` | Seconds waiting in queue before answer |

The default selection is `caller`, `destination`, `duration`, `talk_time`, `datetime`,
`call_status`, `call_type`, `queue`.

> Nothing is forced into the body — including `caller` and `destination`. Deselecting
> both produces calls your CRM cannot attribute; the Settings page warns when you save
> such a selection, but it will honour it.

### Where the values come from

Identity fields (`caller`, `destination`, `callType`, `agentExt`, `talkTime`) are taken
from the finalized CDR whenever it is already written — the same source the Call History
page renders, so the CRM and the UI agree about direction and about which party is the
destination. When the CDR row is not yet available at hangup, live AMI values are used
instead.

The **outcome** is always the live cause-derived value, never the CDR's. The CDR carries
only a coarse disposition, so letting it win would erase `MISSED`, `UNREACHABLE`,
`NETWORK_ERROR`, `VOICEMAIL`, `DROPPED` and `ABANDONED`. Call History derives the same
value after the fact from the hangup facts Asterisk writes to CEL, so the CRM and the
Call History page agree.

---

## Duration format

| Mode | `duration` | `talk_time` |
|---|---|---|
| `hms` (default) | `"duration": "00:05:23"` | `"talkTime": "00:04:11"` |
| `seconds` | `"durationInSeconds": 323` | `"talkTimeInSeconds": 251` |

The unit is encoded in the key name, so a receiver cannot silently misread seconds as
minutes. Switching the mode changes both the key and the type.

---

## Outcome values

`status` and `disposition` both carry OpDesk's canonical outcome enum, always upper
case. It is the same vocabulary Call History, Call Journey, the missed-call bell, the
analytics drill-down and the WebSocket use, and `GET /api/crm/config` lists it as
`call_outcomes`.

| Value | Meaning | Typically produced by |
|---|---|---|
| `ANSWERED` | A person picked up and there was talk time | Any answered call |
| `UNANSWERED` | The callee never picked up: it rang out, or our agent ended an **outbound** call before the customer answered | DialStatus `NOANSWER`; cause 18, 19, 26, 127; cause 16 on an outbound call |
| `BUSY` | The callee refused the call: line busy or declined | Cause 17, 21; DialStatus `BUSY` |
| `MISSED` | Someone calling **us** gave up while it rang | Cause 16 / DialStatus `CANCEL` on an inbound or internal call |
| `VOICEMAIL` | Voicemail answered instead of a person | Last application `VoiceMail` |
| `UNREACHABLE` | The number is right, the phone is not there (off, out of coverage, unregistered) | Cause 20, 27; DialStatus `CHANUNAVAIL` |
| `FAILURE` | The number is wrong (unallocated, invalid format), or nothing better is known | Cause 1, 28, 31 |
| `NETWORK_ERROR` | Number and phone are fine; the network failed | Cause 3, 34, 38, 41, 42, 44, 58; DialStatus `CONGESTION` |
| `ABANDONED` | The caller left the queue before an agent answered | Queue abandon |
| `DROPPED` | Answered, then torn down abnormally | Cause 38, 41, 44 after answer |

Precedence: voicemail → answered (→ `DROPPED` if the cause says the call collapsed) →
queue abandon → DialStatus → caller hung up (`MISSED` / `UNANSWERED` by direction) →
hangup cause → CDR disposition → `FAILURE`. A hangup cause of `0` means Asterisk reported
none, so it falls through to the disposition rather than reading as `BUSY`.

`MISSED` and `UNANSWERED` differ only in whose call it was. Who actually hung up is not
part of the status: Call History and Call Journey report it separately as `ended_by`.

---

## Renaming keys

*Settings → Integrations → Outbound key names* maps any default wire key to whatever your
CRM expects:

```json
{ "agentExt": "agentId", "talkTime": "talkDuration" }
```

Only known default keys may be used as a source, so a stale configuration cannot inject
arbitrary keys. In `seconds` mode a rename keyed on `duration`/`talkTime` is applied to
the active `durationInSeconds`/`talkTimeInSeconds` key automatically.

**Collisions are refused, not resolved.** If a rename would land on a key another field
already occupies, the rename is dropped, a warning is logged, and the source field keeps
its default key. No value is ever silently overwritten. The Settings UI flags the
collision as you type.

## Remapping outcome values

*Settings → Integrations → Outcome values* translates the enum into your CRM's
vocabulary. Matching is case-insensitive on the source; unmapped values pass through
unchanged.

```json
{ "BUSY": "UNANSWERED", "MISSED": "UNANSWERED", "DROPPED": "ANSWERED" }
```

The remap is applied to both `status` and `disposition`, before the key rename.

A remap saved against an old spelling keeps working: a `CANCELED` key also applies to
`MISSED`, and a `NO_ANSWER` key to `UNANSWERED`, unless the new value has a mapping of
its own. Other old keys (`OUT_OF_REACH`) no longer match anything. To send the old
words to a CRM that expects them, map the new values back, e.g.
`{"UNANSWERED": "NO_ANSWER", "MISSED": "CANCELED", "UNREACHABLE": "OUT_OF_REACH", "NETWORK_ERROR": "FAILURE"}`.

---

## Worked example

A 5m23s inbound call answered by extension 1001, with the default field selection plus
`call_id`, `agent` and `agent_name`.

### Default — `hms`, no renaming

```http
POST /api/calls HTTP/1.1
Host: crm.example.com
Content-Type: application/json
User-Agent: OpDesk-CRM-Connector/1.0
X-API-Key: sk_live_…
```

```json
{
  "caller": "+201001234567",
  "destination": "1001",
  "duration": "00:05:23",
  "talkTime": "00:04:11",
  "startTime": "2026-07-27T09:30:00",
  "status": "ANSWERED",
  "callType": "inbound",
  "queue": "200",
  "callId": "1753600000.42",
  "agentExt": 1001,
  "agentName": "Ahmed Ali"
}
```

### The same call with `duration_format: seconds`, a key map and an outcome map

Key map `{"talkTime": "talkDuration", "agentExt": "agentId"}`, outcome map
`{"ANSWERED": "COMPLETED"}`:

```json
{
  "caller": "+201001234567",
  "destination": "1001",
  "durationInSeconds": 323,
  "talkDuration": 251,
  "startTime": "2026-07-27T09:30:00",
  "status": "COMPLETED",
  "callType": "inbound",
  "queue": "200",
  "callId": "1753600000.42",
  "agentId": 1001,
  "agentName": "Ahmed Ali"
}
```

Note `talkTime` → `talkDuration` was keyed on the HH:MM:SS name but correctly applied to
the seconds variant.

### Expected response

Any `2xx` is treated as success. The status code and response body are recorded in the
delivery log; nothing about the body is required or parsed.

---

## Delivery log

Every push is a row in the `webhook_deliveries` table, shown under
**Logs → CRM Deliveries**: timestamp, direction, caller and destination, endpoint, status,
the last HTTP status, latency, error, attempts, and the full request and response bodies on
row expand. Its `status` is one of:

| Status | Meaning |
|---|---|
| `pending` | not delivered yet; the worker sends it again at `next_attempt_at` |
| `delivered` | the CRM answered `2xx` |
| `failed` | the CRM rejected it (a non-retryable `4xx`), or retries are off |
| `abandoned` | retryable failures used up the attempt budget |

The list shows the totals per status, and its status and direction filters show how many
rows each value has under the other filters.

- **Retry now** makes a pending, failed or abandoned delivery due at once (with up to
  3 more attempts if its budget is spent) and sends it immediately, with the same
  idempotency key. A delivered row is never retried.
- **Resend** replays the stored request body verbatim through the CRM configuration
  currently in effect — the body is the historical fact, while the credentials and
  endpoint are re-read because a wrong endpoint is usually the reason the original failed.
  Each resend is a new delivery linked to the original.

**Privacy.** These rows hold call metadata (phone numbers, caller and agent names,
extensions) and the complete request body, so the table inherits your database's backup
and retention posture. Request *headers* are never stored — that is where the CRM
credentials are. The stored URL has its query string and any embedded credentials
stripped. Bodies are truncated at 8 KB. Access is admin-only; an API key cannot read the
delivery log at all.

Rows are pruned daily, `WEBHOOK_LOG_RETENTION_DAYS` days after creation (default 30). A
`pending` row is never pruned.

---

## Testing

**Settings → Integrations → Test connection** performs a `HEAD` (falling back to a small
`POST`) against the configured endpoint and reports the result without saving anything.

For an end-to-end check, point OpDesk at any small HTTP listener on another machine that
prints the requests it receives, and make a test call. Use that host's **LAN address**
rather than `127.0.0.1` — the SSRF guard blocks loopback. Every attempt, with the body
OpDesk sent and the response it got, also appears under **Logs → CRM Deliveries**.
