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
  Absolute URLs are rejected — the host always comes from the (SSRF-validated) server URL.
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
page in the app. It has two kinds of rows (`source` column): `manual` rows are created and
edited by admins in the UI; `crm` rows are added automatically the first time a number
resolves via the CRM lookup. A lookup **never overwrites an existing contact**, so manual
data always wins, and editing a `crm` row flips it to `manual` (it is curated from then
on). Deleting a `crm` row lets the next call re-resolve it from the CRM.

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
| `GET /api/contacts` | any authenticated user | List the phonebook (both `manual` and `crm` rows). |
| `POST /api/contacts` | admin | Create a manual contact: `{name, phone, company?, notes?}`. 400 when the number (digits) already exists. |
| `PUT /api/contacts/{id}` | admin | Update a contact (flips `crm` rows to `manual`). |
| `DELETE /api/contacts/{id}` | admin | Delete a contact. |
| `GET /api/crm/contact?phone=…` | any authenticated user | Phonebook-first name resolution; used by the softphone on ring/dial. Falls back to a live CRM lookup, waiting up to 5 s, then returns `{"phone", "name", "enabled"}` (`name: null` when unknown). |
| `POST /api/crm/lookup-test` | admin | Runs one lookup with the posted (possibly unsaved) settings, bypassing the phonebook. Returns the resolved name, verification detail and a truncated raw-response excerpt for debugging templates. |

Configuration is part of `GET`/`POST /api/crm/config` (`lookup_enabled`, `lookup_url`,
`lookup_name_template`, `lookup_number_format`, `lookup_match_digits`,
`lookup_verify_path`, `lookup_ttl_hours` — the in-memory "no match" retention) and
reloads live — no restart. Contact edits also apply live: the resolver reloads its
in-memory phonebook on every change.

**Privacy.** Contact rows hold customer phone numbers and names (typed in or pulled from
your CRM), so the table inherits your database's backup and retention posture. Response
bodies are not logged (except at DEBUG level, truncated); the lookup-test raw excerpt is
admin-only.
