# OpDesk ← CRM contact lookup

When a call rings or is dialed, OpDesk can query your CRM for the remote number and show
the matched contact's name — on the agent's softphone (ringing and in-call screens) and on
the Active Calls / Extensions panels (`Name (number)` instead of the bare number). This is
the *reverse* direction of the [call-data push](webhooks.md): a `GET` from OpDesk to your
CRM, using the same connection and credentials configured under
**Settings → Integrations / CRM**.

The design follows 3CX's server-side CRM templates: a URL template with a `[Number]`
placeholder, a name template of JSON paths, number-prefix handling, and optional
phone-match verification.

## The request

```
GET {server_url}{lookup_url with [Number] substituted}
```

- **Lookup URL** is a path appended to the CRM server URL, e.g.
  `/api/v2/contacts?phone=[Number]`. `[Number]` is replaced with the caller's number,
  URL-encoded. If the template has no placeholder, `?phone=[Number]` is appended.
  It must start with `/` and may not contain `@`, `://`, a backslash or spaces — the host
  always comes from the (SSRF-validated) server URL. Saving an enabled lookup without a
  name template is refused.
- **Number sent** is controlled by the number format setting:
  `digits` (default, `+20 100…` → `20100…`), `as_is`, `plus` (`0020…` → `+20…`), or
  `zeros` (`+20…` → `0020…`).
- Authentication headers are the same as the push (API key / Basic / Bearer / OAuth2).

## The response

- **Name template** extracts the contact name from the JSON response. Each `[path]` token
  is a dot/index path (`data.0.first_name` reads `response.data[0].name`-style); multiple
  tokens are joined with the literal text between them, and empty tokens collapse:
  `[data.0.first_name] [data.0.last_name]` → `Jane Doe`. A bare path without brackets is
  treated as a single token. No token resolving ⇒ no match.
- **Verify phone path** (optional) points at the returned record's phone field. The result
  only counts when that value matches the searched number — this is how 3CX guards against
  a fuzzy CRM search returning the wrong contact. Empty ⇒ the first result is trusted.
- **Match last N digits** makes both caching and verification compare only the last N
  digits, so `+20 100 555 1234`, `0020…` and `0100 555 1234` resolve to the same contact.
  `0` compares the full digit string.

## The contacts phonebook

Names resolve from the `contacts` table — the system phonebook shown on the **Contacts**
page in the app. Rows arrive from three places, and the `source` column records which:

| `source` | Written by | Notes |
|---|---|---|
| `manual` | An admin, on the Contacts page | Highest precedence. Nothing overwrites it. |
| `api` | An external system, over an API key | See [Pushing contacts in](#pushing-contacts-in). |
| `crm` | OpDesk itself, the first time a number resolved via the CRM lookup | Lowest precedence. |

**Precedence is `manual > api > crm`, enforced at the data layer.** A write from a lower
source over a higher-source row is declined, not applied — so a nightly sync can never
undo a correction an admin typed. Editing any row in the UI promotes it to `manual`.
Deleting a `crm` row lets the next call from that number re-resolve it from the CRM.

Every row is keyed by its digits reduced to the last *N* (the **Match last N digits**
setting), so `+20 100 555 1234` and `0100 555 1234` are one contact at N = 10 and a
second write of the same number updates (or is declined), rather than duplicating it.

There is no separate cache table and no TTL refresh: once a number is in the phonebook it
resolves locally, forever, until an admin edits or deletes it. "No match" answers are
remembered in memory for the configured TTL (default 24 h), so unknown numbers don't
re-query the CRM on every ring; transport errors back off for 60 s. Both resets on
restart or config save.

Lookups are fire-and-forget and never block call handling: numbers that look like
internal extensions (≤ 5 digits) or belong to monitored extensions are skipped, a queue
call ringing several agents produces exactly one CRM request, and if the CRM is down the
UI simply shows the number.

## Endpoints

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET /api/contacts` | any signed-in user, or an API key with `contacts:read` | A page of the phonebook, alphabetical: `{"contacts": [...], "next_cursor"}`. `?search=` matches name, company or number (in any prefix form); `?limit=` (default 200, max 500); pass `next_cursor` back as `?cursor=` for the next page (`null` on the last). |
| `GET /api/contacts/{id}` | as above | One contact. |
| `POST /api/contacts` | admin, or an API key with `contacts:write` | From an admin: create a manual contact, 400 when the number already exists. From a key: upsert (see below). |
| `POST /api/contacts/bulk` | admin, or an API key with `contacts:write` | Upsert up to 500 contacts (see below). |
| `PUT /api/contacts/{id}` | admin | Update a contact (it becomes `manual`). |
| `DELETE /api/contacts/{id}` | admin | Delete a contact. |
| `GET /api/crm/contact?phone=…` | any signed-in user | Phonebook-first name resolution; used by the softphone on ring/dial. Falls back to a live CRM lookup, waiting up to 5 s, then returns `{"phone", "name", "enabled"}` (`name: null` when unknown; `enabled` says whether a live CRM lookup can run). |
| `POST /api/crm/lookup-test` | admin | Runs one lookup with the posted (possibly unsaved) settings, bypassing the phonebook. Returns the resolved name, verification detail and a truncated raw-response excerpt for debugging templates. |

A contact in a response:

```json
{
  "id": 12, "name": "Jane Doe", "phone": "+20 100 555 1234", "phone_key": "1005551234",
  "company": "Acme", "notes": null, "source": "api",
  "external_id": "c-981", "source_system": "hubspot",
  "created_at": "2026-10-25T10:00:00", "updated_at": "2026-10-25T10:00:00"
}
```

### Pushing contacts in

Mint an API key with `contacts:write` under **Settings → API keys**, then:

```http
POST /api/contacts/bulk
X-API-Key: opd_…
Content-Type: application/json

{"contacts": [
  {"name": "Jane Doe", "phone": "+20 100 555 1234", "company": "Acme",
   "external_id": "c-981", "source_system": "hubspot"},
  {"name": "Omar", "phone": "0100 555 9999"}
]}
```

```json
{"results": [
   {"index": 0, "id": 12, "action": "created", "reason": null},
   {"index": 1, "id": 7, "action": "skipped", "reason": "existing contact is source 'manual'"}
 ],
 "counts": {"created": 1, "updated": 0, "skipped": 1}}
```

- Each item is `{name, phone, company?, notes?, external_id?, source_system?}`; a missing
  `name` or `phone` field rejects the request (400, the field named), while an empty name or a phone without
  digits skips just that item with a `reason`.
- A contact is matched first by `(source_system, external_id)` when both are given — so a
  contact whose number changed in your system updates its row — then by number.
- A match that is `crm` or `api` is updated; a `manual` match is **skipped**, not failed:
  declining to overwrite a curated contact is the feature working, and a sync must not
  treat it as an error to retry. A number that belongs to another contact is skipped too.
- More than 500 items is a 400 — page your sync. `POST /api/contacts` with one contact
  answers `{"id", "action", "reason"}` the same way.
- Keys never edit or delete: `PUT` and `DELETE` are admin-only.

Configuration is part of `GET`/`POST /api/crm/config` (`lookup_enabled`, `lookup_url`,
`lookup_name_template`, `lookup_number_format`, `lookup_match_digits`,
`lookup_verify_path`, `lookup_ttl_hours` — the in-memory "no match" retention) and
reloads live — no restart. Contact edits also apply live: the resolver reloads its
in-memory phonebook on every change.

**Privacy.** Contact rows hold customer phone numbers and names (typed in or pulled from
your CRM), so the table inherits your database's backup and retention posture. Response
bodies are not logged (except at DEBUG level, truncated); the lookup-test raw excerpt is
admin-only.
