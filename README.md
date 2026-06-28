# OpDesk — Operator Panel for Asterisk

A real-time operator panel for **Asterisk PBX** (Issabel / FreePBX), similar to **FOP2** but built with a modern React + FastAPI stack. Monitor extensions and queues, manage active calls, view CDR and recordings, use a built-in WebRTC softphone, and analyse call-center performance with a full KPI analytics suite—all in one web app.

[![Python](https://img.shields.io/badge/Python-3.11%2B-blue.svg)](https://www.python.org/)
[![Node.js](https://img.shields.io/badge/Node.js-24%2B-43853d.svg)](https://nodejs.org/)
[![React](https://img.shields.io/badge/React-24%2B-61dafb.svg)](https://reactjs.org/)
[![OS](https://img.shields.io/badge/OS-Debian%2012%2B%20%7C%20Linux-orange.svg)](https://www.debian.org/)
[![License](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

[Features](#-features) • [Analytics](#-analytics) • [Screenshots](#screenshots) • [Installation](#installation) • [Docker](#-docker-installation-recommended) • [Running](#running) • [Architecture](#architecture) • [Community](#community--support)

Works with **Issabel** and **FreePBX** running Asterisk with AMI and WSS enabled.

---

## 🚀 Features

### Core functionality

- **Roles**: Admin (full access) and Supervisor (scoped to assigned extensions/queues).
- **Real-time**: Extension status, active calls, queue state, and call notifications via WebSocket.
- **Supervision**: Listen, Whisper, Barge (per-user configurable).
- **Call management**: CDR/call log, filtering, search, recording playback, QoS, **Call Journey** (timeline for multi-leg calls in the call log).
- **Web softphone**: Make/receive calls in the browser (WebRTC); hold, mute, transfer.
- **Notifications**: Missed/busy calls in a header bell; per-extension; mark read/archive; 7-day auto-cleanup of read items.
- **CRM**: Push call data to external CRMs (API Key, Basic Auth, Bearer, OAuth2).
- **Analytics**: Full KPI analytics suite — **12-card overview** (SLA, FCR, Abandonment, Short Abandon, Avg Wait, AHT, Inbound Answer Rate, Total Calls, Outbound Volume, Outbound Answer Rate, Outbound AHT) with delta vs. prior period, volume trend chart, per-queue and per-agent breakdowns, 7×24 heatmap, and paginated call drilldown with CSV / XLSX export.
- **Call recording**: Full-call recording via MixMonitor — writes a mixed file (FreePBX CDR-compatible location) plus two separate single-leg WAVs (`-sp1` caller, `-sp2` callee) for every inbound, outbound, and internal call. Format and enable/disable are configurable from Settings.
- **Voice Activity Detection (VAD)**: Automatic post-call analysis of the two recording legs. Primary engine: **Silero VAD** (ONNX runtime, neural, robust on telephony audio); fallback: **WebRTC VAD** with sliding-window smoothing. Stores per-leg talk time, simultaneous-speech overlap, and the full segment timeline in the DB. Results are visible in the Call Log — click the waveform icon on any recording to open the VAD timeline visualization showing caller vs. callee speech side-by-side.
- **Multi-language UI**: Built-in i18n with support for English, Arabic (RTL), Spanish, and Portuguese — switchable from the UI without any restart.
- **Mobile push notifications**: Wake a Flutter/native iOS/Android softphone for incoming calls via APNs VoIP (PushKit + CallKit) and high-priority FCM — no background socket required.
- **Service worker**: Enables incoming-call notifications while the browser tab is backgrounded (tab alive, no Web Push/VAPID required). Notification tap focuses an existing app tab or opens one.
- **Mobile diagnostic logging**: Optional remote log sink (`?debug=1` URL flag, persisted to localStorage). The frontend batches entries and ships them via `navigator.sendBeacon()` — survives `pagehide`/freeze so SIP teardown events at call drop are captured. Lands in the backend log under `CLIENT[session]`; never stored to DB.

---
## Screenshots

| Active calls | Call Journey | Call log | Dashboard | Notifications | QoS |
|--------------|--------------|----------|-----------|---------------|-----|
| [![Active calls](screenshots/active_calls.png)](screenshots/active_calls.png) | [![Call Journey](screenshots/call_journey.png)](screenshots/call_journey.png) | [![Call log](screenshots/call_history.png)](screenshots/call_history.png) | [![Dashboard](screenshots/extensions_dashboard.png)](screenshots/extensions_dashboard.png) | [![Notifications](screenshots/notfication.png)](screenshots/notfication.png) | [![QoS](screenshots/qos.png)](screenshots/qos.png) |

| Queue | Softphone | Softphone (in-call) | Softphone (ringing) |
|-------|-----------|---------------------|---------------------|
| [![Queue](screenshots/queue.png)](screenshots/queue.png) | [![Softphone](screenshots/softphone.png)](screenshots/softphone.png) | [![Softphone in-call](screenshots/softphone_incall.png)](screenshots/softphone_incall.png) | [![Softphone ringing](screenshots/softphone_rining.png)](screenshots/softphone_rining.png) |

*QoS verified on FreePBX.*

---

## Prerequisites

- Issabel or FreePBX with Asterisk and **AMI** enabled
- Asterisk plain WebSocket (port 8088) enabled — the installer checks for this automatically
- MySQL/MariaDB (for FreePBX extension list)
- `sudo` and `curl` (for the installer)

The installer can install Python 3.11+, Node.js 24 (via nvm), git, lsof, curl, and Nginx if missing.

---

## Installation (Option A — Native)

**One-liner (LAN / self-signed cert):**

```bash
curl -k -O https://raw.githubusercontent.com/Ibrahimgamal99/OpDesk/main/install.sh && chmod +x install.sh && sudo ./install.sh
```

**Public internet (Let's Encrypt — DNS must already point to this server):**

```bash
sudo OPDESK_DOMAIN=opdesk.example.com OPDESK_LE_EMAIL=admin@example.com ./install.sh
```

**From repo:**

```bash
chmod +x install.sh && sudo ./install.sh
```

The script clones to `/opt/OpDesk`, installs dependencies, detects Issabel/FreePBX, configures DB and AMI user `OpDesk`, installs and configures **Nginx** as a TLS-terminating reverse proxy on port **443**, obtains a **Let's Encrypt** certificate when `OPDESK_DOMAIN` is set (falls back to self-signed otherwise), and creates `backend/.env`.

OpDesk is then accessible at **`https://<server-ip>`** (LAN) or **`https://<your-domain>`** (public).

> ⚠️ **FreePBX / Issabel use ports 80 and 443 by default.**
> Both run Apache on ports 80 and 443 for their admin web UI. If you install OpDesk on the same machine, you must move Apache to different ports **before** running `install.sh`, otherwise Nginx will fail to start.
>
> **FreePBX** — change the HTTP and HTTPS ports:
> ```bash
> # HTTP: change port 80 → 8080
> sudo sed -i 's/\bListen 80\b/Listen 8080/' /etc/httpd/conf/httpd.conf
> sudo sed -i 's/:80>/:8080>/g' /etc/httpd/conf.d/*.conf
>
> # HTTPS: change port 443 → 4443
> sudo sed -i 's/:443>/:4443>/g; s/^Listen 443/Listen 4443/' /etc/httpd/conf.d/ssl.conf
> sudo systemctl restart httpd
> ```
>
> **Issabel** — same Apache config:
> ```bash
> sudo sed -i 's/\bListen 80\b/Listen 8080/' /etc/httpd/conf/httpd.conf
> sudo sed -i 's/:80>/:8080>/g' /etc/httpd/conf.d/*.conf
> sudo sed -i 's/:443>/:4443>/g; s/^Listen 443/Listen 4443/' /etc/httpd/conf.d/ssl.conf
> sudo systemctl restart httpd
> ```
**Default login after install:** Username **admin**, password as shown by the installer (e.g. `OpDesk@2026`). Change the password after your first login.

---

## Two deployment options

### Option A — Native install (`install.sh`)
Nginx runs on the host as a TLS-terminating reverse proxy on port **443**. Uvicorn and Asterisk bind to loopback only. Supports Let's Encrypt for public domains.

```
Browser → Nginx :443 → uvicorn 127.0.0.1:8765
                      → Asterisk WS 127.0.0.1:8088 (at /sip-ws)
```

### Option B — Docker (`docker compose`)
The container runs with `network_mode: host`. Uvicorn runs plain HTTP on `127.0.0.1:8765` inside the container. Nginx on the host terminates TLS on port **443** and proxies to it — same result as the native install.

```
Browser → Nginx :443 (host) → uvicorn 127.0.0.1:8765 (container, plain HTTP)
                             → Asterisk WS 127.0.0.1:8088 (at /sip-ws)
```

| | Native | Docker |
|---|---|---|
| **Port** | 443 (Nginx) | 443 (Nginx on host → container :8765) |
| **SIP WebSocket** | `wss://<host>/sip-ws` via Nginx | `wss://<host>/sip-ws` via Nginx |
| **TLS cert** | Auto (self-signed or Let's Encrypt) | Auto (self-signed or Let's Encrypt) |
| **Apache port conflict** | Must move Apache off 443 first | Must move Apache off 443 first |

---

## 🐳 Docker Installation (Option B)

### Prerequisites

- **Docker**: [Install Docker](https://docs.docker.com/engine/install/)
- **Docker Compose**: [Install Docker Compose](https://docs.docker.com/compose/install/)

### Quick Start

1.  **Clone the Repository**

    ```bash
    git clone https://github.com/Ibrahimgamal99/OpDesk.git
    cd OpDesk
    ```

2.  **Configure Environment**

    Copy the example environment file and edit it with your PBX details.

    ```bash
    cp .env.example .env
    nano .env
    ```

    **Important**: If your PBX (Asterisk, MySQL) is running on the same machine as Docker, set `DB_HOST` and `AMI_HOST` to `host.docker.internal`.

3.  **Generate SSL Certificate**

    The application requires an SSL certificate. If you don't have one, you can generate a self-signed certificate for testing:

    ```bash
    mkdir -p cert
    openssl req -x509 -newkey rsa:4096 -keyout cert/opdesk_key.pem -out cert/opdesk_cert.pem -days 365 -nodes -subj "/CN=localhost"
    ```

4.  **Build and Run**

    Use Docker Compose to build and start the OpDesk container in the background.

    ```bash
    docker compose up --build -d
    ```

5.  **Access OpDesk**

    Open your web browser and navigate to `https://<your-server-ip>` (port 443 via Nginx).

### Dockerfile overview

The `Dockerfile` uses a **two-stage build** to keep the final image lean:

| Stage | Base image | Purpose |
|-------|-----------|---------|
| `frontend_builder` | `node:22-bookworm-slim` | Installs npm dependencies and runs `vite build`, producing a static `dist/` bundle. |
| `runtime` | `python:3.11-slim` | Copies the built frontend assets and the FastAPI backend, installs Python dependencies, and starts `server.py`. |

Key details:
- **Port**: `8765` (plain HTTP on loopback) — Nginx on the host terminates TLS and serves on port **443**. `HTTPS_CERT` and `HTTPS_KEY` are cleared by `docker-compose.yml` so uvicorn runs without TLS.
- **Health check**: `curl -kfsS https://localhost:8443/` every 30 s (3 retries, 10 s timeout, 10 s start period).
- **Entry point**: `python server.py` from `/opt/opdesk/backend/`.
- **SSL cert**: mount your cert files into the container (see step 3 above); a self-signed cert works for testing.

To build the image manually (without Compose):

```bash
docker build -t opdesk:latest .
docker run -d \
  --network host \
  --env-file .env \
  -v "$(pwd)/cert:/opt/opdesk/cert:ro" \
  opdesk:latest
```

---

## Running

### Manual

```bash
./start.sh
```

- Serves API + frontend at **https://&lt;server-ip&gt;** via Nginx on port **443**.
- Dev mode with hot reload (no Nginx, direct uvicorn): `./start.sh -d`.

### systemd service (installed automatically)

The installer creates and enables `/etc/systemd/system/opdesk.service` so OpDesk starts automatically on every boot. No extra configuration is needed.

| Action | Command |
|--------|---------|
| Start | `sudo systemctl start opdesk` |
| Stop | `sudo systemctl stop opdesk` |
| Restart | `sudo systemctl restart opdesk` |
| Status | `sudo systemctl status opdesk` |
| Live logs | `sudo journalctl -u opdesk -f` |
| Enable on boot | `sudo systemctl enable opdesk` |
| Disable on boot | `sudo systemctl disable opdesk` |

The service runs as the user who executed the installer, restarts automatically on failure (10 s delay), and forwards all output to the system journal (`journalctl`).

> **Update flow**: when you re-run `install.sh` on an existing installation the script pulls the latest code, regenerates the Nginx config (preserving LAN/public mode), and restarts the service automatically.
>
> **Switch to public domain**: `sudo OPDESK_DOMAIN=opdesk.example.com bash install.sh` — certbot obtains the cert and Nginx is reconfigured in one step.

---

## Quick reference

| Topic | Summary |
|-------|--------|
| **Auth** | Username or extension + password; JWT. Admin sees all; Supervisor sees only assigned extensions/queues. |
| **Softphone** | Requires HTTPS (granted automatically by the Nginx setup). `WEBRTC_PBX_SERVER` is computed dynamically from the request host — no manual configuration needed. SIP WebSocket is proxied at `wss://<host>/sip-ws` → Asterisk plain WS on `127.0.0.1:8088`. SIP clients that include `Sec-WebSocket-Protocol: sip` when connecting to the root path (`wss://<host>/`) are automatically detected and routed to Asterisk — no explicit `/sip-ws` path required. |
| **Call Journey** | In Call Log: open the journey button (route icon) on a row to see the event timeline (queue, ring, answer, transfer, etc.). |
| **Call notifications** | Stored in `call_notifications`; MySQL event cleans read notifications after 7 days. |
| **CRM** | Settings → CRM Settings; configure URL and auth (API Key, Basic, Bearer, OAuth2). |
| **Analytics** | Available to Admin and Supervisor roles. 12 overview KPI cards: SLA, FCR, Abandonment, Short Abandon, Avg Wait, AHT, Inbound Answer Rate, Total Calls, Outbound Volume, Outbound Answer Rate, Outbound AHT, Market Talk Time. All KPI math is in `backend/analytics.py`. Settings under Settings → Analytics. |
| **Analytics export** | Drilldown tab → Export CSV / Export XLSX (requires `openpyxl`; falls back to CSV if not installed). |
| **SLA per queue** | In the DB: `INSERT INTO analytics_sla_settings (queue_extension, threshold_secs) VALUES ('200', 30);` or via the Settings UI. |
| **Call recording** | Enable under Settings → Recording. Format: `wav` (default) or `sln`. Mixed file lands in `/var/spool/asterisk/monitor/YYYY/MM/DD/`; single-leg files in `/var/spool/asterisk/single/YYYY/MM/DD/`. CDR `recordingfile` field is set so recordings appear in FreePBX CDR reports. |
| **VAD analysis** | Runs automatically after each call when recording is enabled. Requires `onnxruntime` + `numpy` for Silero (recommended) or `webrtcvad` for the fallback. The Silero model is downloaded on first use to `~/.cache/opdesk/silero_vad.onnx`. Results stored in the `call_vad` DB table. View the timeline in Call Log → click the waveform icon on a row with a recording. |
| **Mobile debug log** | Open the app with `?debug=1` once (or run `localStorage.opdesk_debug='1'` in devtools and reload). Logs page-lifecycle events, SIP events, and errors; ships them via `sendBeacon` to `/api/client-log`; visible in `journalctl -u opdesk` as `CLIENT[session]` lines. Disable with `?debug=0`. |

---

## Architecture

```
                        ┌──────────────────────────────────────────────────────────┐
         443/tcp        │   Nginx (TLS terminate)                                  │
  Browser ────────────► │  /        → 127.0.0.1:8765 uvicorn                       │
        (HTTPS/WSS)     │  /        (Sec-WebSocket-Protocol: sip) → 127.0.0.1:8088 │
                        │  /ws      → 127.0.0.1:8765 uvicorn                       │
                        │  /sip-ws  → 127.0.0.1:8088 Asterisk WS                  │
                        └──────────┬───────────────────────────────────────────────┘
                                   │ plain HTTP (loopback)
                    ┌──────────────▼───────────────┐      ┌─────────────────┐
                    │  FastAPI Server (uvicorn)     │◄───►│  Asterisk AMI   │
                    │  127.0.0.1:8765               │     │  localhost:5038 │
                    └──────────────┬────────────────┘     └─────────────────┘
                                   │ SQL (read/write)
                                   ▼
                        ┌────────────────────────┐
                        │   MySQL / MariaDB DB   │
                        └────────────────────────┘
```

**High level:**

- **React frontend (Vite + TS)**:
  - Renders the operator panel UI (extensions, queues, dashboards, softphone).
  - Opens a **WebSocket** to the FastAPI backend for real‑time updates (extension presence, active calls, queue stats, notifications).
  - Uses **REST APIs** for slower‑changing data (user profile, configuration, historical CDR, CRM settings).

- **FastAPI backend**:
  - Maintains a long‑lived **AMI connection** to Asterisk.
  - Subscribes to AMI events (Newchannel, QueueMemberStatus, AgentConnect, Hangup, etc.) and normalizes them into:
    - **Presence events** (extension ringing / in‑call / idle).
    - **Queue events** (agents logged in, waiting calls, SLAs).
    - **Call Journey events** (legs, transfers, queue hops).
  - Pushes those events over **WebSocket** to all connected browser clients with the correct permissions (Admin vs Supervisor).
  - Exposes REST endpoints for:
    - CDR / call log queries and filtering.
    - Recordings and QoS information.
    - CRM webhooks / outbound HTTP calls.
    - Authentication and authorization (JWT).
    - **Analytics** — `/api/analytics/overview`, `/queue-performance`, `/agent-performance`, `/heatmap`, `/trend`, `/drilldown`, `/export`, `/settings`.

- **Database (MySQL / MariaDB)**:
  - Stores:
    - User accounts, roles, and assignments (which extensions/queues a supervisor can see).
    - Cached **extension / queue** metadata (synced from FreePBX/Issabel).
    - CDR snapshots and **Call Journey** timelines.
    - **Notifications** (`call_notifications` table with auto‑cleanup via MySQL event).
    - CRM configuration and audit fields.
    - **Analytics aggregation** tables (`analytics_hourly`, `analytics_daily`, `analytics_agent_daily`) refreshed every 15 minutes by a background asyncio task; SLA and FCR settings in `analytics_sla_settings` and `analytics_fcr_settings`.

- **Nginx (reverse proxy)**:
  - Terminates TLS on port **443** — the browser always sees HTTPS/WSS, which is required for microphone access (`getUserMedia`).
  - Proxies `/ws` to the FastAPI backend for real-time events and `/sip-ws` to Asterisk's plain WebSocket (`127.0.0.1:8088`) for SIP signaling.
  - **SIP auto-detection**: inspects the `Sec-WebSocket-Protocol` header on every connection at `/`. If the header value is `sip`, Nginx routes the connection directly to Asterisk (`127.0.0.1:8088`) without requiring the client to target `/sip-ws` explicitly. This allows standard SIP stacks (JsSIP, SIP.js, etc.) that advertise the `sip` sub-protocol to connect to the root WebSocket endpoint and still reach Asterisk automatically.
  - Self-signed cert for LAN use; **Let's Encrypt** obtained automatically when `OPDESK_DOMAIN` is set in the installer.

- **Asterisk / PBX integration**:
  - Uses **AMI** for signaling, monitoring, and call control (originate, spy/whisper/barge, transfers).
  - Uses plain WebSocket on `127.0.0.1:8088` for SIP-over-WebSocket; Nginx adds TLS at `/sip-ws` so the browser connects over WSS.
  - OpDesk does **not** replace the PBX dialplan; it observes and controls calls through AMI while FreePBX/Issabel continues to own dialplan logic.

## 📊 Analytics

### KPIs tracked

The Overview tab shows **12 KPI cards** (6 per row) grouped into inbound quality, inbound volume, outbound, and market engagement:

| Metric | Description |
|--------|-------------|
| **SLA %** | Percentage of answered calls picked up within the configured threshold (default: 20 s). Per-queue overrides are configurable. |
| **FCR %** | First Contact Resolution — callers who did *not* call back within the FCR window (default: 7 days). |
| **Abandonment rate** | Percentage of total inbound calls that were not answered. |
| **Short Abandon** | Calls dropped before the short-abandon threshold (default: 5 s) — accidental hangups excluded from actionable abandonment. |
| **Avg Wait Time** | Mean queue wait time across all calls (answered and abandoned). |
| **AHT** | Average Handle Time — mean talk duration for answered inbound calls. |
| **Inbound Answer Rate** | Percentage of inbound calls that were answered by an agent. |
| **Total Calls** | Combined (inbound + outbound) total, answered, and abandoned counts. |
| **Outbound Calls** | Total outbound call volume with answered count. |
| **Outbound Answer Rate** | Percentage of outbound calls answered by the prospect. |
| **Outbound AHT** | Average Handle Time for outbound calls. |
| **Market Talk Time** | Total outbound billable talk time — measures market engagement effort. Displayed as `Xh Ym`. |

All KPIs are computed for the selected period **and** the equivalent previous period, so every card shows a delta (▲/▼) vs. prior period.

### Tabs

| Tab | What you see |
|-----|-------------|
| **Overview** | **12 KPI cards** across two rows of 6 — inbound quality (SLA, FCR, Abandonment, Short Abandon, Avg Wait, AHT), inbound volume (Answer Rate, Total Calls), outbound (Volume, Answer Rate, AHT), and market engagement (Market Talk Time) — each with a delta vs. prior period. Interactive stacked bar + answer-rate line chart below. |
| **Queue Performance** | Sortable table — one row per queue — with total, answered, abandoned, SLA %, AHT, avg wait, peak hour, and inline progress bars. Includes a **7 × 24 heatmap** of call volume by day-of-week and hour. |
| **Agent Performance** | Sortable ranked table per agent — answered calls, AHT, SLA contribution % (with inline progress bar), and a 7-day sparkline trend. |
| **Drilldown** | Paginated call-level records with queue, agent, duration, talk time, wait, disposition, and SLA-met flag. Filterable by queue extension, agent extension, direction, and disposition. Exportable as **CSV** or **XLSX**. |

### Settings

Admins can tune analytics behaviour under **Settings → Analytics**:

| Setting | Default | Description |
|---------|---------|-------------|
| SLA default threshold | 20 s | Global threshold; overridden per queue in `analytics_sla_settings`. |
| FCR callback window | 7 days | How many days after the first answered call a repeat call counts as a callback (not resolved). |
| Short-abandon threshold | 5 s | Calls abandoned faster than this are treated as accidental hangups and excluded from actionable abandonment. |

### Architecture

```
analytics.py  (single source of truth — all KPI math lives here)
     │
     ├── CDR queries  → asterisk DB  (via DB_CDR env var)
     ├── Settings     → OpDesk DB    (analytics_sla_settings, analytics_fcr_settings)
     ├── Aggregation  → OpDesk DB    (analytics_hourly, analytics_daily, analytics_agent_daily)
     │
     └── Background loop (asyncio, every 15 min)
           refreshes current + previous hour/day buckets
```

The analytics engine reads directly from the Asterisk **CDR table** using a two-leg join (`first_leg` = queue entry, `last_leg` = answered/agent leg) to accurately compute wait time, talk time, and agent attribution. All formula logic is in `analytics.py`; `server.py` only calls the public functions and the frontend never duplicates calculations.

---

## Mobile push notifications (softphone integration)

OpDesk can wake a mobile softphone (Flutter / native iOS / Android) for incoming calls without
keeping a background socket alive. Two push paths cover both app states:

- **App killed** — a dialplan hook fires *before* SIP contact resolution, CURLs
  `/api/internal/mobile-wake/<ext>` to send the wake push, waits for the app to re-register,
  then hands the call back to FreePBX normally.
- **App backgrounded** — Asterisk emits `DialBegin` as usual; the AMI handler calls
  `push_service.send_call_wake()` which sends a high-priority FCM data message (Android /
  `flutter_callkit_incoming`) or an APNs VoIP push via PushKit (iOS / CallKit). On missed call,
  `send_alert()` delivers a standard notification banner on both platforms.

The mobile client registers tokens with `POST /api/device-tokens` after login (iOS posts twice:
an `alert` token and a `voip` PushKit token) and removes them with `DELETE /api/device-tokens`
on logout. Payload on wake: `{ type, extension, caller, call_id, display_name }`.

### Firebase setup (Android + iOS alert push)

1. Create a project at [console.firebase.google.com](https://console.firebase.google.com), add Android and iOS apps.
2. Download `google-services.json` → `android/app/` and `GoogleService-Info.plist` → `ios/Runner/`.
3. Project Settings → **Service accounts** → **Generate new private key** → save to `/opt/OpDesk/secrets/fcm-service-account.json`. Note your **Project ID**.

### APNs setup (iOS VoIP + CallKit)

1. [developer.apple.com → Certificates, IDs & Profiles → Keys](https://developer.apple.com/account/resources/authkeys/list) → **+** → check **Apple Push Notifications service** → Download.
2. File is named `AuthKey_XXXXXXXXXX.p8` — the 10-char suffix is your **Key ID**. **Team ID** is top-right on the portal.
3. Place the file at `/opt/OpDesk/secrets/AuthKey_XXXXXXXXXX.p8`.

> APNs is called directly from the server — the iOS app never touches the key. The VoIP topic is `<APNS_BUNDLE_ID>.voip` automatically.

### Fill in `.env`

The installer already writes all push variables into `backend/.env` (empty). Just fill in the values:

| Variable | What to put |
|----------|-------------|
| `FCM_PROJECT_ID` | Firebase Project ID (Project Settings page) |
| `FCM_SERVICE_ACCOUNT_FILE` | `/opt/OpDesk/secrets/fcm-service-account.json` (already set) |
| `APNS_AUTH_KEY_FILE` | `/opt/OpDesk/secrets/AuthKey_XXXXXXXXXX.p8` (rename to match) |
| `APNS_KEY_ID` | 10-char suffix from the `.p8` filename |
| `APNS_TEAM_ID` | Apple Developer Team ID (top-right on the portal) |
| `APNS_BUNDLE_ID` | Your app's bundle ID |
| `APNS_USE_SANDBOX` | `true` for dev/TestFlight, `false` for App Store |

Then restart: `systemctl restart opdesk`.

## Tech stack

- **Backend**: Python 3.11+, FastAPI, WebSockets, asyncio, MySQL/MariaDB, openpyxl (optional, for XLSX export)
- **Frontend**: React 24, TypeScript, Vite, Recharts (analytics charts), Framer Motion, Lucide React

---

## Community & support

- **Mailing list**: [opdesk-dev@googlegroups.com](mailto:opdesk-dev@googlegroups.com)
- **Telegram**: [t.me/+i1OVDDPgGLo0MGZh](https://t.me/+i1OVDDPgGLo0MGZh)
- **Issues & contributions**: [GitHub Issues](https://github.com/Ibrahimgamal99/OpDesk/issues)
- **Author**: [Ibrahim Gamal](https://github.com/Ibrahimgamal99) — [LinkedIn](https://www.linkedin.com/in/ibrahim-gamal99) · ib.gamal.a@gmail.com

If OpDesk is useful to you: star the repo, report bugs, or contribute. The project is **MIT** licensed; developed by Ibrahim Gamal with AI-assisted tooling for boilerplate and acceleration.