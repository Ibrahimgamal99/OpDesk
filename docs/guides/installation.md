# Installation and operations

Installing OpDesk on an Issabel or FreePBX server, running it, and keeping it up to date.
The short version is in the [README](../../README.md#install); this guide has the details.

## Prerequisites

| Requirement | Notes |
|---|---|
| **Issabel or FreePBX** | Asterisk with **AMI** enabled. The installer creates OpDesk's own AMI user. |
| **Asterisk HTTP / WebSocket** | Plain WebSocket on `127.0.0.1:8088`. The installer checks for it. |
| **MySQL / MariaDB** | The PBX's own database (`asterisk`, `asteriskcdrdb`). OpDesk adds its own database next to them. |
| **OS** | Debian 12+, Ubuntu, or a RHEL family (CentOS, Rocky): whatever the PBX runs on. |
| **Tools** | `sudo` and `curl`. The installer adds git, lsof, openssl, Python 3.11+, Node.js (via nvm) and Nginx if they are missing. |
| **Browser** | Any current Chrome, Edge, Firefox or Safari. The softphone needs HTTPS, which Nginx provides. |
| **Public install only** | A DNS name pointing at the server, and port 80 reachable for the Let's Encrypt challenge. |

### Ports

| Port | Who | Purpose |
|---|---|---|
| `443/tcp` (or your choice) | Nginx | OpDesk over HTTPS, the app WebSocket `/ws`, and SIP over WebSocket `/sip-ws`. |
| `80/tcp` | Nginx | Redirects to HTTPS; Let's Encrypt challenges. |
| `127.0.0.1:8765` | uvicorn | The FastAPI backend. Loopback only. |
| `127.0.0.1:8088` | Asterisk | Plain WebSocket that Nginx proxies `/sip-ws` to. |
| `127.0.0.1:5038` | Asterisk | AMI. |

**FreePBX and Issabel already run Apache on 80 and 443.** The installer detects this and
asks what to do:

1. **Serve OpDesk on another port.** It suggests `8443`. OpDesk is then at
   `https://<server>:8443`, and the PBX admin UI stays where it was.
2. **Move Apache** to `4443` (and `8080` for HTTP) so OpDesk gets 443. The installer edits
   the `httpd` config, updates SELinux and restarts Apache.
3. **Cancel** and resolve it yourself.

Re-running the installer keeps the port you chose last time.

## Option A: native install (`install.sh`)

```bash
# LAN, self-signed certificate
curl -k -O https://raw.githubusercontent.com/Ibrahimgamal99/OpDesk/main/install.sh
chmod +x install.sh && sudo ./install.sh

# Public internet, Let's Encrypt (DNS must already point here)
sudo OPDESK_DOMAIN=opdesk.example.com OPDESK_LE_EMAIL=admin@example.com ./install.sh
```

The installer:

1. Detects the OS and installs any missing tools.
2. Clones the repository to `/opt/OpDesk` (or pulls, if it is already there).
3. Installs the Python and Node.js dependencies.
4. Detects Issabel or FreePBX, creates OpDesk's database and AMI user.
5. Asks for the HTTPS port and resolves any conflict (see [Ports](#ports)).
6. Obtains a certificate: Let's Encrypt when `OPDESK_DOMAIN` is set, otherwise self-signed.
7. Writes the Nginx site, `backend/.env` and the `opdesk` systemd unit, and starts it.
   On start, `start.sh` builds the frontend whenever its sources are newer than the last build.

When it finishes, open **`https://<server-ip>`** or **`https://<your-domain>`**, adding
`:<port>` if you did not use 443. Sign in as **`admin`** with the password the installer
printed, then change it from the profile menu (**Change password**).

With a self-signed certificate the browser warns once. Accept it, or the softphone cannot
connect.

## Option B: Docker

```bash
git clone https://github.com/Ibrahimgamal99/OpDesk.git && cd OpDesk
cp .env.example .env && nano .env      # DB_*, AMI_*, JWT_SECRET, OPDESK_DOMAIN
mkdir -p cert && openssl req -x509 -newkey rsa:4096 \
  -keyout cert/opdesk_key.pem -out cert/opdesk_cert.pem -days 365 -nodes -subj "/CN=localhost"
docker compose up --build -d
```

- The container uses `network_mode: host`, so `127.0.0.1` in `.env` reaches the PBX's MariaDB
  and AMI just like a native install. You do not need to add Docker subnets to `manager.conf`.
- uvicorn serves plain HTTP on `127.0.0.1:8765`. **Nginx on the host** terminates TLS. Use
  [`nginx/opdesk.conf`](../../nginx/opdesk.conf) as the site file.
- Two-stage build: `node:22-bookworm-slim` builds the frontend, `python:3.11-slim` runs it.
- Health check: `curl -fsS http://localhost:8765/` every 30 s.

## Running

The installer enables `opdesk.service`, so OpDesk starts on boot and restarts on failure.

| Action | Command |
|---|---|
| Start / stop / restart | `sudo systemctl {start,stop,restart} opdesk` |
| Status | `sudo systemctl status opdesk` |
| Live logs | `sudo journalctl -u opdesk -f` |
| Enable / disable on boot | `sudo systemctl {enable,disable} opdesk` |

To run it by hand:

```bash
./start.sh          # production: backend serves the built frontend
./start.sh -d       # development: backend + Vite dev server with hot reload, no Nginx
```

## Updating

Re-run the installer:

```bash
cd /opt/OpDesk && sudo ./install.sh
```

It pulls the latest code, regenerates the Nginx config with the
same port and LAN/public mode, keeps your `backend/.env` values, and restarts the service
(which rebuilds the frontend if it changed).

To switch an existing LAN install to a public domain, run it once with the domain set:

```bash
sudo OPDESK_DOMAIN=opdesk.example.com OPDESK_LE_EMAIL=admin@example.com ./install.sh
```

For Docker: `git pull && docker compose up --build -d`.

## Troubleshooting

| Symptom | Check |
|---|---|
| Nginx will not start | Something else holds the port: `sudo ss -ltnp | grep -E ':(80|443) '`. Re-run the installer and pick another port, or move Apache. |
| Page loads but shows no extensions | AMI is not connected. `sudo journalctl -u opdesk -f` shows the AMI login error; check `AMI_*` in `backend/.env` against `/etc/asterisk/manager_custom.conf`. |
| Softphone stays "connecting" | The certificate is not trusted (open the site once and accept it), or Asterisk's HTTP server is off: `asterisk -rx "http show status"` should list port 8088. |
| Let's Encrypt fails | DNS must resolve to this server and port 80 must be reachable from the internet. |

For browser-side issues, open OpDesk once with `?debug=1`: the frontend then sends its
lifecycle and SIP events to the backend log as `CLIENT[session]` lines.
