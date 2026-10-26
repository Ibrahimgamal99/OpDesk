# Configuration

OpDesk is configured in two places. The `backend/.env` file holds what the server needs
before it can start. The web UI's **Settings** page holds everything an operator changes
day to day.

## `backend/.env`

The installer writes this file (mode `600`) and keeps your values when you re-run it, including
variables it does not manage itself. The previous version is saved as `backend/.env.bak`.
[`.env.example`](../../.env.example) is the annotated list. The main groups:

| Variables | Purpose |
|---|---|
| `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD` | MySQL/MariaDB connection. |
| `DB_NAME`, `DB_CDR`, `DB_OpDesk` | The PBX config database (`asterisk`), the CDR database (`asteriskcdrdb`) and OpDesk's own. |
| `AMI_HOST`, `AMI_PORT`, `AMI_USERNAME`, `AMI_SECRET`, `AMI_CONTEXT` | The Asterisk Manager connection, and the dialplan context used for originated calls. |
| `ASTERISK_RECORDING_ROOT_DIR` | Where the recordings directory is mounted, when not at `/var/spool/asterisk/monitor/` (the directory the recorder writes to). Playback, the Recordings page and retention all use it; Settings → Recording only shows it. |
| `PORT`, `OPDESK_BIND_HOST` | Where the backend (Node.js) listens (default `127.0.0.1:8765`). |
| `OPDESK_LISTEN_PORT` | Optional. Overrides the listen port, for example to run a second instance next to the live one. |
| `OPDESK_SHADOW` | Optional, for that second instance. `1` makes it watch-only towards the PBX: read-only AMI actions, no Asterisk config writes or reloads, no recording deletes. It still writes its own database, so point `DB_OpDesk` at a copy. |
| `NGINX_HTTPS_PORT` | The public HTTPS port. Put into the URLs OpDesk hands out (softphone `wss://`) when it is not 443. |
| `OPDESK_DOMAIN`, `CORS_ALLOWED_ORIGINS` | The public hostname and the browser origins allowed to call the API. |
| `JWT_SECRET` | Signs sign-in tokens. Use a long random string; changing it signs everyone out. |
| `HTTPS_CERT`, `HTTPS_KEY`, `OPDESK_HTTPS_PORT` | Only for serving TLS from the backend directly. Leave the paths empty behind nginx. |
| `VAD_PYTHON` | The Python of the voice-activity venv (`backend/vad/.venv/bin/python`, set by the installer). Empty turns talk/silence analysis off. |
| `LOG_LEVEL` | `DEBUG`, `INFO` (default), `WARNING` or `ERROR`. |
| `OPDESK_ADMIN_PASSWORD` | Optional. Sets the `admin` password on every start while it is set. |
| `FCM_*`, `APNS_*`, `MOBILE_WAKE_*` | Mobile push. **Settings → Mobile Wake** overrides them; see [mobile-push.md](mobile-push.md). |

Restart after editing: `sudo systemctl restart opdesk`.

Secrets stored through the Settings page (CRM passwords and tokens, API secrets, push keys) are
returned masked as `********`. Saving the form with the mask unchanged keeps the stored value.

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
| **Recording** | Turn recording on and pick the format: `wav`, `wav49`, `gsm`, `g722`, `ulaw`, `alaw` or `sln`. Set the recording root, which directions and extensions are recorded, and the retention period. Shows the storage used. |
| **Not-Ready Codes** | The pause reasons agents choose from when they go Not Ready, the after-call wrap-up time, and the daily shift reset. |
| **Audit log** (admins) | Who changed what, and when: every create, update and delete made through the API, filterable by action, entity, user and date. |

Settings changes apply **live**, with no restart.

## Users, roles and groups

| Role | Sees and does |
|---|---|
| **Admin** | Everything, including Users, Groups, Logs and API keys. |
| **Supervisor** | The agents and queues in their assigned groups: live panels, queues, call log, recordings, analytics, settings, and listen / whisper / barge if allowed. |
| **Agent** | Live panels for their own extension plus the agents and queues of the groups they belong to. History (call log, recordings, call journey) is limited to their **own** extension. They also get the contacts phonebook and the softphone. |

Admins create users under **Users** (link a user to an extension to give them a softphone)
and build agent and queue scopes under **Groups**. The sign-in password and the extension's
SIP password are separate: a user's password signs in to OpDesk only, and the SIP password
(what phones register with) is set in its own field on the user form, or kept as the PBX has
it. Unlinking a user from their extension, deactivating or deleting them gives that extension a
new random SIP password, so their phones sign out and the old password stops working. Every
user can change their own sign-in password and SIP password from their profile (click your
name in the top-right menu).

## Debugging

- **Logs page** (admins): a live AMI event console, off by default (turn on capture when you
  need it), a SIP trace, and a searchable log of every CRM delivery with request and response
  bodies and a manual resend.
- **Server logs:** `sudo journalctl -u opdesk -f`.
- **Browser:** open OpDesk once with `?debug=1`. The frontend then sends its lifecycle and SIP
  events to the server log as `CLIENT[session]` lines.
