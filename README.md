# OpDesk — Operator Panel for Asterisk

A real-time operator panel for **Asterisk PBX** (Issabel / FreePBX), similar to **FOP2** but built with a modern React + FastAPI stack. Monitor extensions and queues, manage active calls, view CDR and recordings, and use a built-in WebRTC softphone—all in one web app.

[![Python](https://img.shields.io/badge/Python-3.11%2B-blue.svg)](https://www.python.org/)
[![Node.js](https://img.shields.io/badge/Node.js-24%2B-43853d.svg)](https://nodejs.org/)
[![React](https://img.shields.io/badge/React-24%2B-61dafb.svg)](https://reactjs.org/)
[![OS](https://img.shields.io/badge/OS-Debian%2012%2B%20%7C%20Linux-orange.svg)](https://www.debian.org/)
[![License](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

[Features](#-features) • [Screenshots](#screenshots) • [Installation](#installation) • [Docker](#-docker-installation-recommended) • [Running](#running) • [Architecture](#architecture) • [Community](#community--support)

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
- **Multi-language UI**: Built-in i18n with support for English, Arabic (RTL), Spanish, and Portuguese — switchable from the UI without any restart.

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
- **WSS (WebSocket Secure)** enabled on FreePBX/Issabel for the WebRTC softphone
- MySQL/MariaDB (for FreePBX extension list)
- `sudo` and `curl` (for the installer)

The installer can install Python 3.11+, Node.js 24 (via nvm), git, lsof, and curl if missing.

---

## Installation

**One-liner:**

```bash
curl -k -O https://raw.githubusercontent.com/Ibrahimgamal99/OpDesk/main/install.sh && chmod +x install.sh && ./install.sh
```

**From repo:**

```bash
chmod +x install.sh && ./install.sh
```

The script clones to `/opt/OpDesk`, installs dependencies, detects Issabel/FreePBX, configures DB and AMI user `OpDesk`, creates `backend/.env`, and prints a summary.

**Default login after install:** Username **admin**, password as shown by the installer (e.g. `OpDesk@2026`). Change the password after your first login.

---

## 🐳 Docker Installation (Recommended)

For the most reliable and consistent deployment, especially on systems like Sangoma 7 / CentOS 7, it is highly recommended to use the official Docker container. This method avoids host system dependency issues.

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

    Open your web browser and navigate to `https://<your-server-ip>:8443`.

### Dockerfile overview

The `Dockerfile` uses a **two-stage build** to keep the final image lean:

| Stage | Base image | Purpose |
|-------|-----------|---------|
| `frontend_builder` | `node:22-bookworm-slim` | Installs npm dependencies and runs `vite build`, producing a static `dist/` bundle. |
| `runtime` | `python:3.11-slim` | Copies the built frontend assets and the FastAPI backend, installs Python dependencies, and starts `server.py`. |

Key details:
- **Port**: `8443` is exposed (HTTPS). Override via `OPDESK_HTTPS_PORT` in `backend/.env`.
- **Health check**: `curl -kfsS https://localhost:8443/` every 30 s (3 retries, 10 s timeout, 10 s start period).
- **Entry point**: `python server.py` from `/opt/opdesk/backend/`.
- **SSL cert**: mount your cert files into the container (see step 3 above); a self-signed cert works for testing.

To build the image manually (without Compose):

```bash
docker build -t opdesk:latest .
docker run -d \
  --env-file .env \
  -v "$(pwd)/cert:/opt/opdesk/cert:ro" \
  -p 8443:8443 \
  opdesk:latest
```

---

## Running

### Manual

```bash
./start.sh
```

- Serves API + frontend at **https://&lt;server-ip&gt;:8443** (HTTPS). Change the port via **OPDESK_HTTPS_PORT** in `backend/.env`.
- Dev mode with hot reload: `./start.sh -d`.

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

> **Update flow**: when you re-run `install.sh` on an existing installation the script pulls the latest code and restarts the service automatically.

---

## Quick reference

| Topic | Summary |
|-------|--------|
| **Auth** | Username or extension + password; JWT. Admin sees all; Supervisor sees only assigned extensions/queues. |
| **Softphone** | Enable **WSS** in FreePBX/Issabel. Requires HTTPS. `WEBRTC_PBX_SERVER` is set automatically (e.g. `wss://<server-ip>:8089/ws`); adjust in Settings if needed. |
| **Call Journey** | In Call Log: open the journey button (route icon) on a row to see the event timeline (queue, ring, answer, transfer, etc.). |
| **Call notifications** | Stored in `call_notifications`; MySQL event cleans read notifications after 7 days. |
| **CRM** | Settings → CRM Settings; configure URL and auth (API Key, Basic, Bearer, OAuth2). |

---

## Architecture

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  React Frontend │◄───►│  FastAPI Server  │◄───►│  Asterisk AMI   │
│  (WebSocket)    │     │  (WebSocket)     │     │                 │
└─────────────────┘     └──────────────────┘     └─────────────────┘
                                ▲
                                │ SQL (read/write)
                                │
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

- **Database (MySQL / MariaDB)**:
  - Stores:
    - User accounts, roles, and assignments (which extensions/queues a supervisor can see).
    - Cached **extension / queue** metadata (synced from FreePBX/Issabel).
    - CDR snapshots and **Call Journey** timelines.
    - **Notifications** (`call_notifications` table with auto‑cleanup via MySQL event).
    - CRM configuration and audit fields.

- **Asterisk / PBX integration**:
  - Uses **AMI** for signaling, monitoring, and call control (originate, spy/whisper/barge, transfers).
  - Uses **WSS** (`wss://<server-ip>:8089/ws`) for WebRTC media when the built‑in softphone is enabled.
  - OpDesk does **not** replace the PBX dialplan; it observes and controls calls through AMI while FreePBX/Issabel continues to own dialplan logic.

---

## Tech stack

- **Backend**: Python 3.11+, FastAPI, WebSockets, asyncio, MySQL/MariaDB  
- **Frontend**: React 24, TypeScript, Vite, Framer Motion, Lucide React  

---

## Community & support

- **Mailing list**: [opdesk-dev@googlegroups.com](mailto:opdesk-dev@googlegroups.com)
- **Telegram**: [t.me/+i1OVDDPgGLo0MGZh](https://t.me/+i1OVDDPgGLo0MGZh)
- **Issues & contributions**: [GitHub Issues](https://github.com/Ibrahimgamal99/OpDesk/issues)
- **Author**: [Ibrahim Gamal](https://github.com/Ibrahimgamal99) — [LinkedIn](https://www.linkedin.com/in/ibrahim-gamal99) · ib.gamal.a@gmail.com

If OpDesk is useful to you: star the repo, report bugs, or contribute. The project is **MIT** licensed; developed by Ibrahim Gamal with AI-assisted tooling for boilerplate and acceleration.
