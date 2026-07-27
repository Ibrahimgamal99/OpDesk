# OpDesk → CRM call-data push

After every call ends, OpDesk can POST a summary of it to your CRM. This document is the
contract for that outgoing request. For the *incoming* API see
[endpoints.md](endpoints.md).

Configure it under **Settings → Integrations / CRM**.

> ### ⚠️ Breaking change for existing integrations
>
> The payload now uses **camelCase wire keys** (`talkTime`, `status`, `startTime`,
> `agentExt`, …). Earlier versions sent the raw internal names (`talk_time`,
> `call_status`, `datetime`, `agent`).
>
> The `call_status` and `disposition` **values** also changed, from
> `completed`/`noanswer`/`switched_off`/`invalid_number` and `ANSWERED`/`NO ANSWER` to a
> single canonical enum — see [Outcome values](#outcome-values).
>
> If your receiver parses the old names, either update it or use the
> [key map](#renaming-keys) and [outcome map](#remapping-outcome-values) to reproduce the
> previous wire format without changing your CRM.

---

## When it fires

On hangup, from the AMI monitor. It is fire-and-forget and never blocks call processing.

A call is skipped when:

- call-data sync is disabled;
- the call's direction (`inbound` / `outbound` / `internal`) is de-selected;
- no CRM connector is configured — this is still recorded in the delivery log, so a
  misconfigured connector does not look like "no calls".

There is **no automatic retry.** A failed delivery is recorded and can be replayed by
hand from **Logs → CRM Deliveries** (see [Delivery log](#delivery-log)).

## Transport

```
{server_url}{sync_endpoint or endpoint_path}
```

`POST` (default) or `PUT`, JSON body, configurable timeout and TLS verification.

The URL is SSRF-checked before it is saved or used. Loopback, link-local (including the
`169.254.169.254` cloud metadata address), multicast, reserved and unspecified addresses
are **always** blocked. RFC-1918 private ranges are **allowed by default**, because an
on-prem CRM on the LAN is a first-class deployment; tick *Block private addresses* for a
stricter posture.

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
only a coarse disposition, so letting it win would erase `CANCELED`, `DROPPED`,
`OUT_OF_REACH` and `ABANDONED`.

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

`status` and `disposition` both carry OpDesk's canonical outcome enum. It is the same
vocabulary the Call History page and the analytics drilldown use.

| Value | Meaning | Typically produced by |
|---|---|---|
| `ANSWERED` | Connected and had talk time | Any answered call |
| `NO_ANSWER` | Rang, nobody picked up | Cause 18, 19, 127; DialStatus `NOANSWER` |
| `BUSY` | Called party busy | Cause 17, 0; DialStatus `BUSY` |
| `FAILURE` | Rejected, invalid number, congestion, channel unavailable | Cause 21, 28, 31, 34; DialStatus `CONGESTION`/`CHANUNAVAIL` |
| `ABANDONED` | Caller left the queue before an agent answered | Queue abandon |
| `CANCELED` | Caller hung up before it rang out | Cause 16 with no answer |
| `DROPPED` | Answered, then torn down abnormally | Cause 38, 41, 44 after answer |
| `OUT_OF_REACH` | Subscriber absent, device switched off | Cause 20 |

Precedence: answered (→ `DROPPED` if the cause says the call collapsed) → queue abandon →
DialStatus → hangup cause → CDR disposition → `FAILURE`.

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
{ "BUSY": "NO_ANSWER", "CANCELED": "NO_ANSWER", "DROPPED": "ANSWERED" }
```

The remap is applied to both `status` and `disposition`, before the key rename.

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

Every attempt is recorded in the `webhook_deliveries` table and shown under
**Logs → CRM Deliveries**: timestamp, direction, caller and destination, endpoint, HTTP
status, latency, error, and the full request and response bodies on row expand.

Failed deliveries can be replayed with **Resend**. The stored request body is replayed
verbatim through the CRM configuration currently in effect — the body is the historical
fact, while the credentials and endpoint are re-read because a wrong endpoint is usually
the reason the original failed. Each resend is a new row linked to the original.

**Privacy.** These rows hold call metadata (phone numbers, caller and agent names,
extensions) and the complete request body, so the table inherits your database's backup
and retention posture. Request *headers* are never stored — that is where the CRM
credentials are. The stored URL has its query string and any embedded credentials
stripped. Bodies are truncated at 8 KB. Access is admin-only; an API key cannot read the
delivery log at all.

Rows are pruned daily, `WEBHOOK_LOG_RETENTION_DAYS` days after creation (default 30).

---

## Testing

**Settings → Integrations → Test connection** performs a `HEAD` (falling back to a small
`POST`) against the configured endpoint and reports the result without saving anything.

For an end-to-end check, `echo/crm_test.py` is a dependency-free fake CRM that listens on
port 8099, enforces its own `X-API-Key`, and pretty-prints whatever it receives. Point
OpDesk at your host's **LAN address** rather than `127.0.0.1` — the SSRF guard blocks
loopback.
