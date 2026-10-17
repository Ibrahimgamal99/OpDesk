# Configuration

OpDesk is configured in two places. The `backend/.env` file holds what the server needs
before it can start. The web UI's **Settings** page holds everything an operator changes
day to day.

## `backend/.env`

The installer writes this file and keeps your values when you re-run it.
[`.env.example`](../../.env.example) is the annotated list. The main groups:

| Variables | Purpose |
|---|---|
| `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD` | MySQL/MariaDB connection. |
| `DB_NAME`, `DB_CDR`, `DB_OpDesk` | The PBX config database (`asterisk`), the CDR database (`asteriskcdrdb`) and OpDesk's own. |
| `AMI_HOST`, `AMI_PORT`, `AMI_USERNAME`, `AMI_SECRET`, `AMI_CONTEXT` | The Asterisk Manager connection, and the dialplan context used for originated calls. |
| `ASTERISK_RECORDING_ROOT_DIR` | Where Asterisk writes recordings (default `/var/spool/asterisk/monitor/`). |
| `PORT`, `OPDESK_BIND_HOST` | Where uvicorn listens (default `127.0.0.1:8765`). |
| `NGINX_HTTPS_PORT` | The public HTTPS port. Put into the URLs OpDesk hands out (softphone `wss://`) when it is not 443. |
| `OPDESK_DOMAIN`, `CORS_ALLOWED_ORIGINS` | The public hostname and the browser origins allowed to call the API. |
| `JWT_SECRET` | Signs sign-in tokens. Use a long random string; changing it signs everyone out. |
| `HTTPS_CERT`, `HTTPS_KEY` | Only for serving TLS from uvicorn directly. Leave empty behind Nginx. |
| `FCM_*`, `APNS_*`, `MOBILE_WAKE_*` | Mobile push. **Settings → Mobile Wake** overrides them; see [mobile-push.md](mobile-push.md). |

Restart after editing: `sudo systemctl restart opdesk`.

## Settings page

**Settings** in the sidebar (admins and supervisors; **API Keys** is admin-only) has these sub-tabs:

| Sub-tab | What it configures |
|---|---|
| **Integrations / CRM** | CRM URL and credentials (API key, Basic, Bearer or OAuth2), which call fields to push, wire key names, outcome remapping, duration format, direction filters, contact lookup, and a connection test. See [webhooks.md](../api/webhooks.md) and [contact-lookup.md](../api/contact-lookup.md). |
| **API Keys** | Machine-to-machine credentials and their scopes. See [overview.md](../api/overview.md#2-api-keys-machines). |
| **QoS** | RTP quality reporting into the CDR `userfield`. |
| **Analytics** | SLA thresholds, FCR window, short-abandon threshold. See [analytics.md](analytics.md). |
| **SIP TLS** | TLS transport for SIP endpoints. |
| **Mobile Wake** | RFC 8599 wake-up (hold time, settle window, mobile client marker), the Firebase service account and APNs `.p8` key, the Web Push (VAPID) keys, and the registered devices. See [mobile-push.md](mobile-push.md). |
| **Recording** | Turn recording on and pick the format: `wav`, `wav49`, `gsm`, `g722`, `ulaw`, `alaw` or `sln`. |
| **Not-Ready Codes** | The pause reasons agents choose from when they go Not Ready. |

Settings changes apply **live**, with no restart.

## Users, roles and groups

| Role | Sees and does |
|---|---|
| **Admin** | Everything, including Users, Groups, Logs and API keys. |
| **Supervisor** | The agents and queues in their assigned groups: live panels, queues, call log, analytics, settings, and listen / whisper / barge if allowed. |
| **Agent** | Dashboard, extensions, their own calls and call history, the contacts phonebook, and the softphone. |

Admins create users under **Users** (link a user to an extension to give them a softphone)
and build agent and queue scopes under **Groups**. Every user can change their own sign-in
password and SIP password from the profile menu.

## Debugging

- **Logs page** (admins): a live AMI event console, off by default (turn on capture when you
  need it), a SIP trace, and a searchable log of every CRM delivery with request and response
  bodies and a manual resend.
- **Server logs:** `sudo journalctl -u opdesk -f`.
- **Browser:** open OpDesk once with `?debug=1`. The frontend then sends its lifecycle and SIP
  events to the server log as `CLIENT[session]` lines.
