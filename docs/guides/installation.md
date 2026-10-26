# Installation and operations

How to install OpDesk on an Issabel or FreePBX server, run it, and keep it up to date.
The short version is in the [README](../../README.md#install). This guide has the details.

## Supported systems

| PBX | OS | Native install | Notes |
|---|---|---|---|
| **Issabel 5** | Rocky Linux 8 (glibc 2.28) | Yes | Asterisk 16, 18 or 20. Apache keeps ports 80 and 443, so OpDesk is served on **8443**. |
| **FreePBX 17** | Debian 12 | Yes | Apache serves the FreePBX UI on 80, and on 443 if HTTPS is set up there. In that case OpDesk defaults to **8443**. |
| **FreePBX 16** | Debian 10/11, Rocky/Alma 8 | Yes | Same port rules as FreePBX 17. |
| **FreePBX 16** | Sangoma Linux 7 / CentOS 7 (glibc 2.17) | **Docker only** | Node.js 24 needs glibc 2.28 or newer. The installer stops with a message on these systems. |
| Plain Asterisk | Debian 11+, Ubuntu 20.04+, RHEL family 8+ | Yes | Needs AMI and the Asterisk HTTP server. |

Node.js is pinned to **24**. Node 27 and later need glibc 2.34, which EL8-based systems such as Issabel 5 do not have.

## Prerequisites

| Requirement | Notes |
|---|---|
| **Asterisk with AMI** | The installer creates OpDesk's own AMI user. It creates `manager_custom.conf` first if the file is missing. |
| **Asterisk HTTP / WebSocket** | Plain WebSocket on `127.0.0.1:8088`. Nginx proxies the softphone's `/sip-ws` to it. The installer warns if it is off. |
| **MySQL / MariaDB** | The PBX's own server (`asterisk`, `asteriskcdrdb`). OpDesk adds an `OpDesk` database and an `OpDesk` user. The installer needs a privileged login; see [Database access](#database-access). |
| **Root** | Run the installer as root (`sudo ./install.sh`). It adds git, curl, lsof, openssl, nginx, Node.js 24 (through nvm), a Python venv for voice-activity analysis, and certbot when a domain is used. |
| **Resources** | About 1 GB of free RAM and 1.5 GB of disk for the first build. On 1–2 GB machines the build caps Node's heap at 1 GB; add swap if the build is killed. |
| **Browser** | Any current Chrome, Edge, Firefox or Safari. The softphone needs HTTPS, which nginx provides. |
| **Public install only** | A DNS name pointing at the server, with port 80 reachable for the Let's Encrypt challenge. |

### Ports

| Port | Who | Purpose |
|---|---|---|
| `443/tcp`, or `8443` next to Apache | nginx | OpDesk over HTTPS, the app WebSocket `/ws`, and SIP over WebSocket `/sip-ws`. |
| `80/tcp` (only if free) | nginx | Redirects to HTTPS and answers Let's Encrypt challenges. |
| `127.0.0.1:8765` | Node.js | The OpDesk backend (NestJS). Loopback only. |
| `127.0.0.1:8088` | Asterisk | Plain WebSocket that nginx proxies `/sip-ws` to. |
| `127.0.0.1:5038` | Asterisk | AMI. |

**Apache on the PBX.** FreePBX and Issabel run Apache for their own web UI. The installer handles it as follows:

- **HTTPS port.** Port 443 is used if it is free. If Apache holds it, the installer suggests **8443** and OpDesk is at `https://<server>:8443`. The PBX UI stays where it was. On FreePBX and plain Asterisk it also offers to move Apache from 443 to 4443. On **Issabel it never moves Apache**: Issabel's UI, its HTTPS rewrite, its certbot module and the Asterisk certificate all assume Apache on 80/443.
- **Port 80.** OpDesk adds an HTTP→HTTPS redirect only when port 80 is free. Apache keeps port 80 on FreePBX and Issabel, so there is no redirect there.
- **Re-runs.** The installer keeps the port you chose last time.

## Option A: native install (`install.sh`)

```bash
# LAN, self-signed certificate
curl -fsSLO https://raw.githubusercontent.com/Ibrahimgamal99/OpDesk/main/install.sh
chmod +x install.sh && sudo ./install.sh

# Public internet, Let's Encrypt (DNS must already point here)
sudo OPDESK_DOMAIN=opdesk.example.com OPDESK_LE_EMAIL=admin@example.com ./install.sh
```

All questions are asked first: the domain, the HTTPS port, and the `admin` password on a fresh install. After that the installer runs unattended:

1. **OS.** Detects the OS (Debian/Ubuntu or the RHEL family, including Rocky 8 under Issabel) and installs missing tools. It stops if glibc is older than 2.28.
2. **Code.** Clones the repository to `/opt/OpDesk`, or pulls if it is already there. If the pull changed `install.sh`, it continues with the new version.
3. **Node.js 24.** Installs it through nvm into `/root/.nvm` and pins it as the default.
4. **Voice-activity analysis.** Creates a Python venv at `backend/vad/.venv` with `numpy`, `webrtcvad-wheels` and `onnxruntime`. It uses `python3.12`/`python3.11` from AppStream on Issabel and EL8, and the system `python3` on Debian 12. Nothing goes into the system Python. If this step fails, OpDesk runs without talk/silence analysis.
5. **Database.** Detects Issabel or FreePBX and logs in to MySQL with a privileged account. It then:
   - creates or repairs the `OpDesk` user, with the same grants as always: `SELECT, INSERT, UPDATE, DELETE` on `asterisk`, `SELECT` on `asteriskcdrdb`, `ALL` on `OpDesk`;
   - applies `backend/schema.sql`, which is idempotent;
   - turns the MariaDB `event_scheduler` on, both live and in a config drop-in.
6. **AMI.** Adds an `[OpDesk]` user to `/etc/asterisk/manager_custom.conf` with a 32-character secret, permitted from `127.0.0.1` only. Existing users keep their secret. A short secret left by an older installer is replaced.
7. **TLS.** Creates a self-signed certificate in `/opt/OpDesk/cert/`, unless one is already there.
8. **nginx.** Installs nginx if needed: `apt` on Debian, or the `nginx:1.24` module stream on EL8. It then:
   - writes the site and runs `nginx -t`, keeping the previous site if the test fails;
   - with a domain, gets a Let's Encrypt certificate and adds a renewal hook that reloads nginx;
   - opens the HTTPS port in firewalld or ufw, or tells you where to open it (see [Firewall](#firewall)).
9. **Config.** Writes `backend/.env` (mode `600`). Existing values are kept, variables the installer does not manage are carried over, and the previous file is saved as `.env.bak`.
10. **Build.** Runs `npm ci` and `npm run build` for `backend/` and `frontend/`.
11. **Admin password.** Fresh install only. Hashes the password with bcrypt and stores it. If you pressed Enter at the question, the default password `OpDesk@2026` is kept and printed in the final report.
12. **Service.** Writes `/etc/systemd/system/opdesk.service` on every run and (re)starts it.

When it finishes, open the URL from the report, for example `https://<server-ip>:8443`. Sign in as **`admin`**, then change the password from the profile menu (**Change password**). With a self-signed certificate the browser warns once. Accept the warning, or the softphone cannot connect.

### Options

| Option / variable | Effect |
|---|---|
| `--yes` | No questions. The domain comes from `OPDESK_DOMAIN` or `.env`, the port is the previous one, 443, or 8443 when 443 is taken, and the admin password comes from `OPDESK_ADMIN_PASSWORD` or is the default `OpDesk@2026`. |
| `--no-pull` | Install the code already in `/opt/OpDesk` without `git pull`. |
| `--update` | Update an existing install without asking "update or uninstall". |
| `--uninstall` | Remove OpDesk from the server. See [Uninstalling](#uninstalling). |
| `OPDESK_DOMAIN`, `OPDESK_LE_EMAIL` | Public name and Let's Encrypt contact address. |
| `OPDESK_PUBLIC_HTTPS_PORT` | HTTPS port to use (mostly with `--yes`). |
| `OPDESK_ADMIN_PASSWORD` | Admin password for a fresh install. |
| `MYSQL_ROOT_PASSWORD` | Root password, when root cannot log in through the socket. |

### What the installer does on each OS

| | Debian 12 / Ubuntu (FreePBX 17) | Rocky 8 / EL8 (Issabel 5, FreePBX on EL) |
|---|---|---|
| nginx package | `apt-get install nginx` | `dnf module enable nginx:1.24`, then `dnf install nginx` (the default 1.14 is too old) |
| nginx site | `/etc/nginx/sites-enabled/opdesk` → `/opt/OpDesk/nginx/opdesk.conf` (symlink) | `/etc/nginx/conf.d/opdesk.conf` (copy). The stock `server { listen 80 default_server; }` in `nginx.conf` is commented out (`#opdesk#`), and a backup is kept in `nginx.conf.opdesk-orig`. |
| HTTP/2 and IPv6 | `listen … ssl http2` (nginx < 1.25.1), or `http2 on;` on newer nginx. IPv6 `listen` lines only when the kernel has IPv6. | same |
| Python for VAD | system `python3` (3.11) + `python3-venv` | `python3.12` (or `python3.11`) from AppStream; the system `python3` is 3.6 |
| MariaDB root login | unix socket as root | Issabel: `mysqlrootpwd=` from `/etc/issabel.conf`. Otherwise the socket, or `MYSQL_ROOT_PASSWORD`. |
| `event_scheduler` drop-in | `/etc/mysql/mariadb.conf.d/90-opdesk.cnf` | `/etc/my.cnf.d/opdesk.cnf` |
| Let's Encrypt | webroot through OpDesk's port-80 server, or Apache's `/var/www/html` when Apache holds 80 | certbot from EPEL. On Issabel, webroot `/var/www/html` (Apache serves the challenge). |
| Firewall | ufw if active | firewalld if active; otherwise the Issabel firewall (see [Firewall](#firewall)) |

### Database access

The installer needs a MySQL account that can create users and databases. It tries these in order:

1. `MYSQL_ROOT_PASSWORD` from the environment.
2. `mysqlrootpwd=` in `/etc/issabel.conf` (Issabel).
3. `root` through the unix socket, or with no password. This works on FreePBX and Debian, and on a fresh Issabel netinstall.
4. The PBX's own account from `/etc/freepbx.conf`, `/etc/issabelpbx.conf` or `/etc/amportal.conf`.
5. A typed root password (interactive runs only).

Passwords go through a temporary `0600` option file, never on the command line. If nothing works, the installer prints the SQL to run by hand.

### Firewall

- **firewalld** or **ufw** active: the installer opens the HTTPS port itself.
- **Issabel**: its firewall (iptables rules kept in `/var/www/db/iptables.db`) rewrites iptables on every apply, so the installer does not add raw rules. Add **TCP 8443** (or your port) under **Security → Firewall → Firewall Rules**.
- **FreePBX firewall module**: add the port under **Connectivity → Firewall → Services → Custom Services**.

The softphone also needs the Asterisk WebSocket and RTP ports. OpDesk proxies the WebSocket through nginx, so only RTP (usually `10000–20000/udp`) must be reachable. PBX firewalls allow it by default.

## Option B: Docker

Docker is also the way to run OpDesk next to FreePBX 16 on Sangoma 7 / CentOS 7.

```bash
git clone https://github.com/Ibrahimgamal99/OpDesk.git && cd OpDesk
cp .env.example .env && nano .env      # DB_*, AMI_*, JWT_SECRET, OPDESK_DOMAIN, CORS_ALLOWED_ORIGINS
docker compose up --build -d
```

Before the first start, do these on the host:

1. **Create the OpDesk database user and schema** as MySQL root. Use the same password as `DB_PASSWORD` in `.env`:
   ```sql
   CREATE USER 'OpDesk'@'localhost' IDENTIFIED BY '<DB_PASSWORD>';
   GRANT SELECT, INSERT, UPDATE, DELETE ON asterisk.* TO 'OpDesk'@'localhost';
   GRANT SELECT ON asteriskcdrdb.* TO 'OpDesk'@'localhost';
   GRANT ALL PRIVILEGES ON OpDesk.* TO 'OpDesk'@'localhost';
   ```
   then `mysql < backend/schema.sql`.
2. **Add the AMI user** to `/etc/asterisk/manager_custom.conf` (same secret as `AMI_SECRET`, `permit=127.0.0.1/255.255.255.255`), then run `asterisk -rx "manager reload"`.
3. **Put nginx in front.** Copy [`nginx/opdesk.conf.example`](../../nginx/opdesk.conf.example) to `/etc/nginx/conf.d/opdesk.conf` (or `sites-enabled/`) and adjust the port, `server_name` and certificate.

Container details:

- `network_mode: host`: `127.0.0.1` in `.env` reaches MariaDB and AMI as in a native install.
- **Image.** Three stages: the frontend build and the backend build both run on `node:24-bookworm-slim`. The runtime image has Node 24 and a Python venv for voice-activity analysis.
- **Mounts.** `/var/spool/asterisk/monitor` is mounted for recordings (playback and retention), and `./secrets` for push credentials.
- **Limits.** The container has no Asterisk CLI and no `/etc/asterisk`. Features that write Asterisk config or run `asterisk -rx` (dialplan install, recording policy, SIP TLS setup) need the native install.
- **Health check.** An HTTP GET on the backend port every 30 s.

## Running

The installer enables `opdesk.service`, so OpDesk starts on boot and restarts on failure.

| Action | Command |
|---|---|
| Start / stop / restart | `sudo systemctl {start,stop,restart} opdesk` |
| Status | `sudo systemctl status opdesk` |
| Live logs | `sudo journalctl -u opdesk -f` |
| Enable / disable on boot | `sudo systemctl {enable,disable} opdesk` |

The unit runs `start.sh`, which:

1. **Rebuilds what changed.** It rebuilds the frontend when anything in `frontend/src`, `public/`, `package*.json`, the Vite/TypeScript config or `frontend/.env*` is newer than `frontend/dist/index.html`. It rebuilds the backend when `backend/src`, `package*.json` or `tsconfig*.json` is newer than `backend/dist/main.js`.
2. **Installs dependencies when needed.** It runs `npm ci --include=dev` only when `package-lock.json` is newer than the installed `node_modules`.
3. **Keeps the last good build.** If a build fails, the previous `dist/` is restored and started, so a bad update does not take OpDesk down.
4. **Starts Node.** It `exec`s `node backend/dist/main.js`, so Node is the service's main process. `systemctl stop` sends it SIGTERM and it shuts down cleanly. The unit uses `KillMode=mixed` and `TimeoutStopSec=30`.

To run it by hand:

```bash
./start.sh          # production: build what changed, then run the backend (serves frontend/dist)
./start.sh -d       # development: tsc --watch + node --watch backend, Vite dev server with hot reload
```

## Updating

Re-run the installer:

```bash
cd /opt/OpDesk && sudo ./install.sh
```

On an existing install it first asks **1) update 2) uninstall**. Enter (and `--yes`) means update. When `backend/.env` or the OpDesk database is missing, it runs as a fresh install instead, admin password question included. It pulls the latest code, keeps `backend/.env`, `cert/`, the HTTPS port and the domain, regenerates the nginx site and the systemd unit, rebuilds, and restarts the service.

To switch an existing LAN install to a public domain, run it once with the domain set:

```bash
sudo OPDESK_DOMAIN=opdesk.example.com OPDESK_LE_EMAIL=admin@example.com ./install.sh
```

For Docker: `git pull && docker compose up --build -d`.

### Upgrading from the Python backend (OpDesk 1.x)

OpDesk 2 replaces the Python/FastAPI backend with a Node.js (NestJS) one. The database is reused as it is. API changes (mainly the 10-value call status, see [webhooks.md](../api/webhooks.md)) are listed in the [API reference](../api/endpoints.md). Older installers run `git pull` themselves and break on the new layout, so update in this order:

```bash
cd /opt/OpDesk
git checkout -- nginx/opdesk.conf 2>/dev/null   # a generated file older releases kept in git
git pull
sudo ./install.sh --no-pull
```

The new installer:

- stops the running Python backend before building;
- keeps `backend/.env`, `cert/` and the HTTPS port;
- adds `VAD_PYTHON`;
- applies the schema;
- re-applies the database grants;
- replaces an 8-character AMI secret with a 32-character one;
- rewrites `opdesk.service` (now `node backend/dist/main.js`).

It also removes the `/usr/local/bin/python` symlink and `/usr/local/bin/pip` wrapper that the old installer created, but only when the wrapper is exactly the one it wrote. The Python packages it installed system-wide (fastapi, uvicorn, …) are no longer used, and you can remove them with pip.

## Uninstalling

```bash
cd /opt/OpDesk && sudo ./install.sh --uninstall
```

Or run `sudo ./install.sh` and choose **2) uninstall**. It lists what goes, asks you to type `uninstall`, and asks whether to delete the code in `/opt/OpDesk` too. The code is always kept when it has uncommitted changes. `--yes` skips both questions and keeps the code. Then it removes everything the installer set up:

- `opdesk.service`;
- the OpDesk nginx site, the certbot reload hook, the Let's Encrypt certificate for `OPDESK_DOMAIN` and `/var/www/letsencrypt`. Each is kept if another config still uses it;
- the stock port-80 server the installer commented out in an EL `nginx.conf`, which is re-enabled when nothing else holds port 80;
- the firewalld/ufw rule for the HTTPS port, once nothing listens on that port;
- the OpDesk database. Its MySQL user is dropped too if that user has no grants other than OpDesk's;
- the `event_scheduler` MySQL drop-in, unless other databases have EVENTs that need it;
- the OpDesk AMI user, and the `#include manager_custom.conf` the installer added to `manager.conf` once no AMI users are left in that file;
- `/etc/asterisk/keys/opdesk_*.pem`, unless the Asterisk config uses them;
- `backend/.env`, `cert/`, `node_modules`, the builds, the VAD venv and its model cache.

Backups of the database dump, `.env`, the certificates and every file it edits go to `/var/backups/opdesk-uninstall-<date>`. It never touches the PBX databases, nginx, Node.js or certbot themselves, since other software may use them. If the code is kept, `sudo ./install.sh` installs OpDesk fresh again.

## Troubleshooting

| Symptom | Check |
|---|---|
| nginx does not start | Something else holds the port: `sudo ss -ltnp \| grep -E ':(80\|443\|8443) '`. On EL, check that the stock port-80 server in `/etc/nginx/nginx.conf` is commented out (`#opdesk#`). Run `sudo nginx -t` for the exact error. |
| Service restarts in a loop | `sudo journalctl -u opdesk -n 200`. "build of backend failed and there is no previous build" means a TypeScript error after an update. Fix it, or check out the previous commit. |
| Page loads but shows no extensions | AMI is not connected. The log shows the AMI login error. Check `AMI_*` in `backend/.env` against `/etc/asterisk/manager_custom.conf`, then run `asterisk -rx "manager show users"`. |
| Softphone stays "connecting" | The certificate is not trusted (open the site once and accept it), or Asterisk's HTTP server is off. `asterisk -rx "http show status"` should list port 8088. |
| Let's Encrypt fails | DNS must resolve to this server, and port 80 must be reachable from the internet. When Apache holds port 80, the challenge is served from `/var/www/html`. |
| No talk/silence analysis on calls | `VAD_PYTHON` in `backend/.env` must point to a working venv. Check with `$VAD_PYTHON -c "import numpy, webrtcvad"`. To rebuild the venv, re-run `sudo ./install.sh --no-pull`. |
| Build killed on a small box | The kernel's OOM killer stopped `tsc` or `vite`. Add swap (`fallocate -l 2G /swapfile && mkswap /swapfile && swapon /swapfile`) and restart the service. |

For browser-side issues, open OpDesk once with `?debug=1`. The frontend then sends its lifecycle and SIP events to the backend log as `CLIENT[session]` lines.
