#!/bin/bash
# =================================================================================================
# OpDesk installer and updater
#
#   sudo ./install.sh              install, or update an existing /opt/OpDesk
#   sudo ./install.sh --yes        non-interactive: accept every default (see --help)
#   sudo ./install.sh --no-pull    use the code already in /opt/OpDesk (skip `git pull`)
#
# Supported: Issabel 5 (Rocky Linux 8), FreePBX 16/17 (Sangoma Linux 7, Debian 12) and plain
# Asterisk on Debian/Ubuntu or a RHEL-family OS.
#
# What it sets up: Node.js 24 (nvm) and the NestJS backend + React frontend builds, a Python venv
# for the voice-activity analysis only, the OpDesk database user/schema, an AMI user, nginx in
# front of the backend (TLS: Let's Encrypt or self-signed), backend/.env and opdesk.service.
#
# Everything is idempotent: re-running keeps backend/.env values, cert/, the chosen HTTPS port and
# the domain, and rewrites the generated files (nginx site, systemd unit).
#
# The whole script is parsed before anything runs (main is called on the last line), so a
# `git pull` that replaces this file mid-run cannot make bash execute half-old, half-new code.
# =================================================================================================

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'

PROJECT_ROOT="${OPDESK_ROOT:-/opt/OpDesk}"
REPO_URL="${OPDESK_REPO_URL:-https://github.com/Ibrahimgamal99/OpDesk.git}"
NODE_MAJOR=24
NVM_VERSION="v0.40.3"
ENV_FILE="$PROJECT_ROOT/backend/.env"
UNIT_FILE="/etc/systemd/system/opdesk.service"
ACME_WEBROOT="/var/www/letsencrypt"

# Paths read during detection; overridable so the detection helpers can be tested on sample files.
ISSABEL_CONF="${ISSABEL_CONF:-/etc/issabel.conf}"
FREEPBX_CONF="${FREEPBX_CONF:-/etc/freepbx.conf}"
ISSABELPBX_CONF="${ISSABELPBX_CONF:-/etc/issabelpbx.conf}"
AMPORTAL_CONF="${AMPORTAL_CONF:-/etc/amportal.conf}"
ISSABEL_DIR="${ISSABEL_DIR:-/usr/share/issabel}"
ASTERISK_ETC="${ASTERISK_ETC:-/etc/asterisk}"

ASSUME_YES="${OPDESK_ASSUME_YES:-0}"
DO_PULL=1

# Output helpers: say interprets backslash escapes (colors, \n), out prints its arguments verbatim.
say() { printf '%b\n' "$*"; }
out() { printf '%s\n' "$*"; }
info()  { say "${GREEN}$*${NC}"; }
warn()  { say "${YELLOW}$*${NC}"; }
err()   { say "${RED}$*${NC}" >&2; }
note()  { say "${BLUE}$*${NC}"; }
step()  { say "\n${YELLOW}== $* ==${NC}"; }
die()   { err "Error: $*"; exit 1; }
command_exists() { command -v "$1" >/dev/null 2>&1; }

usage() {
    cat <<'EOF'
Usage: sudo ./install.sh [--yes] [--no-pull]

  -y, --yes       Non-interactive. Defaults are used for every question:
                    domain        OPDESK_DOMAIN (env) or the one in backend/.env, else none (self-signed)
                    HTTPS port    OPDESK_PUBLIC_HTTPS_PORT (env), the previous port, 443, or 8443 when 443 is taken
                    admin pass    OPDESK_ADMIN_PASSWORD (env), else a random one (printed at the end)
      --no-pull   Do not `git pull`; install the code that is already in /opt/OpDesk.
  -h, --help      This help.

Environment: OPDESK_DOMAIN, OPDESK_LE_EMAIL, OPDESK_PUBLIC_HTTPS_PORT, OPDESK_ADMIN_PASSWORD,
             MYSQL_ROOT_PASSWORD (when root cannot log in through the socket), OPDESK_ROOT (default /opt/OpDesk).
EOF
}

# --- small helpers (pure; safe to source and test) ------------------------------------------------

# env_get <file> <KEY>: value of KEY= in a dotenv file, surrounding quotes removed; empty if absent.
env_get() {
    [ -f "$1" ] || return 0
    grep -E "^$2=" "$1" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '\r' \
        | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'\$/\1/"
}

# ver_ge <a> <b>: true when version a >= version b.
ver_ge() { [ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -1)" = "$2" ]; }

# ask <prompt> <default>: read a line, or return the default in --yes mode / without a terminal.
ask() {
    local prompt="$1" default="$2" val=""
    if [ "$ASSUME_YES" = "1" ] || [ ! -t 0 ]; then
        out "$default"; return
    fi
    read -r -p "$prompt" val
    out "${val:-$default}"
}

# detect_os: sets OS (os-release ID), OS_FAMILY (debian|el|unknown) and OS_PRETTY.
# shellcheck disable=SC1091
detect_os() {
    OS="unknown"; OS_FAMILY="unknown"; OS_PRETTY="unknown"
    local id_like=""
    if [ -f /etc/os-release ]; then
        OS=$(. /etc/os-release; out "${ID:-unknown}")
        id_like=$(. /etc/os-release; out "${ID_LIKE:-}")
        OS_PRETTY=$(. /etc/os-release; out "${PRETTY_NAME:-$OS}")
    fi
    case " $OS $id_like " in
        *" debian "*|*" ubuntu "*) OS_FAMILY="debian" ;;
        *" rhel "*|*" centos "*|*" rocky "*|*" almalinux "*|*" ol "*|*" fedora "*|*" sangoma "*) OS_FAMILY="el" ;;
    esac
}

# detect_pbx: prints Issabel | FreePBX | Generic. Issabel is checked first: it ships an
# IssabelPBX (FreePBX 2.11 fork) and some of FreePBX's files.
detect_pbx() {
    if [ -d "$ISSABEL_DIR" ] || [ -f "$ISSABEL_CONF" ] || [ -f "$ISSABELPBX_CONF" ]; then
        out "Issabel"
    elif [ -f "$FREEPBX_CONF" ] || command_exists fwconsole; then
        out "FreePBX"
    else
        out "Generic"
    fi
}

# issabel_root_password [file]: MySQL root password from /etc/issabel.conf (`mysqlrootpwd=...`),
# read the way Issabel's own scripts do. Everything after the first '=' is the password, so
# passwords that contain '=' survive. Empty when the file or the key is missing (a fresh
# netinstall before first boot has an empty root password and no file).
issabel_root_password() {
    local f="${1:-$ISSABEL_CONF}"
    [ -f "$f" ] || return 0
    sed -n 's/^[[:space:]]*mysqlrootpwd[[:space:]]*=[[:space:]]*//p' "$f" | head -1 | tr -d '\r' \
        | sed -e 's/[[:space:]]*$//' -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'\$/\1/"
}

# php_conf_value <file> <KEY>: $amp_conf['KEY'] = 'value'; from /etc/freepbx.conf or /etc/issabelpbx.conf.
php_conf_value() {
    [ -f "$1" ] || return 0
    sed -n "s/^[[:space:]]*\$amp_conf\[[\"']$2[\"']\][[:space:]]*=[[:space:]]*[\"']\(.*\)[\"'][[:space:]]*;.*/\1/p" "$1" | head -1
}

# pbx_db_credentials: sets PBX_DB_USER / PBX_DB_PASS from the PBX's own config (the user the GUI
# connects with): /etc/freepbx.conf or /etc/issabelpbx.conf, else /etc/amportal.conf.
pbx_db_credentials() {
    PBX_DB_USER=""; PBX_DB_PASS=""
    local f
    for f in "$FREEPBX_CONF" "$ISSABELPBX_CONF"; do
        PBX_DB_USER=$(php_conf_value "$f" AMPDBUSER)
        PBX_DB_PASS=$(php_conf_value "$f" AMPDBPASS)
        [ -n "$PBX_DB_USER" ] && return 0
    done
    PBX_DB_USER=$(env_get "$AMPORTAL_CONF" AMPDBUSER)
    PBX_DB_PASS=$(env_get "$AMPORTAL_CONF" AMPDBPASS)
}

# ami_section_secret <file> <section>: the secret= of [section] in a manager config, empty if none.
ami_section_secret() {
    [ -f "$1" ] || return 0
    awk -v sec="[$2]" '
        { line=$0; sub(/[[:space:]]*;.*/, "", line); gsub(/^[[:space:]]+|[[:space:]]+$/, "", line) }
        line ~ /^\[/ { insec = (line == sec || index(line, sec "(") == 1); next }
        insec && line ~ /^secret[[:space:]]*=/ { sub(/^secret[[:space:]]*=[[:space:]]*/, "", line); print line; exit }
    ' "$1"
}

# listening_comm <port>: name of the process listening on TCP <port>, empty when the port is free.
listening_comm() {
    local port="$1" comm pid
    comm=$(ss -ltnpH "sport = :$port" 2>/dev/null | grep -oP 'users:\(\("\K[^"]+' | head -1)
    if [ -z "$comm" ]; then
        pid=$(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null | head -1)
        [ -n "$pid" ] && comm=$(ps -p "$pid" -o comm= 2>/dev/null)
    fi
    out "$comm"
}

# nginx_other_site <port>: first enabled nginx site file, other than OpDesk's, that listens on <port>.
nginx_other_site() {
    local port="$1" f ours
    ours=$(readlink -f "$PROJECT_ROOT/nginx/opdesk.conf" 2>/dev/null)
    for f in /etc/nginx/sites-enabled/* /etc/nginx/conf.d/*.conf; do
        [ -f "$f" ] || continue
        [ "$(readlink -f "$f")" = "$ours" ] && continue
        case "$(basename "$f")" in opdesk|opdesk.conf) continue ;; esac
        if grep -qE "^[[:space:]]*listen[[:space:]]+([^;]*:)?$port([^0-9]|\$)" "$f" 2>/dev/null; then
            out "$f"; return
        fi
    done
}

# port_owner <port>: "" (free), "ours" (nginx with no other site on it), else the owner's name.
port_owner() {
    local comm other
    comm=$(listening_comm "$1")
    [ -z "$comm" ] && return 0
    if [ "$comm" = "nginx" ]; then
        other=$(nginx_other_site "$1")
        if [ -z "$other" ]; then out "ours"; else out "nginx ($other)"; fi
        return 0
    fi
    out "$comm"
}

# nginx_version: "1.24.0" (empty when nginx is not installed).
nginx_version() { nginx -v 2>&1 | grep -oE '[0-9]+\.[0-9]+(\.[0-9]+)?' | head -1; }

# ipv6_enabled: the kernel has IPv6 addresses (a `listen [::]:port` fails `nginx -t` otherwise).
ipv6_enabled() { grep -q . /proc/net/if_inet6 2>/dev/null; }

# render_nginx_conf <out>: write the OpDesk nginx site. Inputs (globals): PORT, ASTERISK_HTTP_PORT,
# NGINX_HTTPS_PORT, NGINX_HTTP_PORT (empty = no :80 redirect server), NGINX_SERVER_NAME,
# NGINX_SSL_CERT, NGINX_SSL_KEY, NGINX_VERSION, NGINX_IPV6 (1/0), ACME_WEBROOT.
render_nginx_conf() {
    local out="$1" http2_listen="" http2_on="" v6_https="" v6_http="" redirect="" https_suffix=""
    # `listen ... http2` is deprecated from nginx 1.25.1 in favour of `http2 on;`.
    if [ -n "$NGINX_VERSION" ] && ver_ge "$NGINX_VERSION" "1.25.1"; then
        http2_on="    http2 on;"
    else
        http2_listen=" http2"
    fi
    if [ "${NGINX_IPV6:-0}" = "1" ]; then
        v6_https="    listen [::]:$NGINX_HTTPS_PORT ssl$http2_listen;"
        v6_http="    listen [::]:$NGINX_HTTP_PORT;"
    fi
    [ "$NGINX_HTTPS_PORT" != "443" ] && https_suffix=":$NGINX_HTTPS_PORT"
    if [ -n "$NGINX_HTTP_PORT" ]; then
        redirect="
# Port $NGINX_HTTP_PORT: Let's Encrypt HTTP-01 challenges (webroot renewals), everything else to HTTPS.
server {
    listen $NGINX_HTTP_PORT;
$v6_http
    server_name $NGINX_SERVER_NAME;

    location /.well-known/acme-challenge/ { root $ACME_WEBROOT; }
    location / { return 301 https://\$host$https_suffix\$request_uri; }
}"
    fi
    cat > "$out" <<NGINXEOF
# OpDesk reverse proxy. Generated by install.sh; edits are overwritten on the next install.
# upstream/map/zone names are opdesk_-prefixed: nginx's http{} namespace is shared with every
# other site on the box, and a duplicate name fails the whole configuration.

upstream opdesk_app { server 127.0.0.1:$PORT; keepalive 32; }
# No keepalive here: this upstream only carries WebSocket upgrades, which take the connection
# over, and pooled sockets go stale across an Asterisk reload (spurious 400s).
upstream opdesk_asterisk_ws { server 127.0.0.1:$ASTERISK_HTTP_PORT; }

map \$http_upgrade \$opdesk_connection_upgrade {
    default upgrade;
    ''      close;
}

# SIP over WebSocket (Sec-WebSocket-Protocol: sip) on / or /ws goes to Asterisk; everything else
# to OpDesk. A map instead of "if" inside a location, which can silently mis-route.
map \$http_sec_websocket_protocol \$opdesk_root_proxy {
    "sip"   "http://opdesk_asterisk_ws/ws";
    default "http://opdesk_app";
}

server {
    listen $NGINX_HTTPS_PORT ssl$http2_listen;
$v6_https
$http2_on
    server_name $NGINX_SERVER_NAME;

    ssl_certificate     $NGINX_SSL_CERT;
    ssl_certificate_key $NGINX_SSL_KEY;
    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_ciphers         HIGH:!aNULL:!MD5;
    ssl_session_cache   shared:opdesk_ssl:10m;
    ssl_session_timeout 10m;

    # Plain directives are inherited by every location below.
    proxy_http_version 1.1;
    proxy_read_timeout 3600s;

    # proxy_set_header is NOT inherited by a location that sets any proxy_set_header itself, so
    # each location repeats the full list.

    # The app WebSocket. It authenticates with a token (query string or first message), never
    # with cookies, and Asterisk's HTTP server rejects oversized headers, so cookies are dropped.
    # No access log: the ?token= query string must not land in log files.
    location = /ws {
        proxy_pass         \$opdesk_root_proxy;
        proxy_set_header   Upgrade           \$http_upgrade;
        proxy_set_header   Connection        \$opdesk_connection_upgrade;
        proxy_set_header   Host              \$host;
        proxy_set_header   X-Real-IP         \$remote_addr;
        proxy_set_header   X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto \$scheme;
        proxy_set_header   X-Forwarded-Host  \$http_host;
        proxy_set_header   Cookie            "";
        access_log off;
    }

    # The softphone's SIP over WebSocket, straight to Asterisk's HTTP server.
    location = /sip-ws {
        proxy_pass         http://opdesk_asterisk_ws/ws;
        proxy_set_header   Upgrade           \$http_upgrade;
        proxy_set_header   Connection        \$opdesk_connection_upgrade;
        proxy_set_header   Host              \$host;
        proxy_set_header   X-Real-IP         \$remote_addr;
        proxy_set_header   X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto \$scheme;
        proxy_set_header   X-Forwarded-Host  \$http_host;
        proxy_set_header   Cookie            "";
    }

    location / {
        proxy_pass         \$opdesk_root_proxy;
        proxy_set_header   Upgrade           \$http_upgrade;
        proxy_set_header   Connection        \$opdesk_connection_upgrade;
        proxy_set_header   Host              \$host;
        proxy_set_header   X-Real-IP         \$remote_addr;
        proxy_set_header   X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto \$scheme;
        # \$http_host keeps the :port, which the backend needs when OpDesk is not on 443.
        proxy_set_header   X-Forwarded-Host  \$http_host;
        client_max_body_size 25m;
    }
}
$redirect
NGINXEOF
    # Drop the blank lines left by optional directives that were not emitted.
    sed -i '/^$/N;/^\n$/D' "$out"
}

# disable_stock_server_block <nginx.conf>: comment out (prefix "#opdesk# ") the first server{}
# block written directly in nginx.conf that listens on port 80. EL/Rocky ship one as the default
# site; next to Apache on :80 it stops nginx from starting, and otherwise it shadows OpDesk's
# redirect. Blocks that do not listen on 80 are left alone. Idempotent.
disable_stock_server_block() {
    local conf="$1" tmp
    [ -f "$conf" ] || return 0
    tmp=$(mktemp) || return 1
    awk '
        function flush(commentit,   i) {
            for (i = 1; i <= n; i++) print (commentit ? "#opdesk# " buf[i] : buf[i])
            n = 0
        }
        {
            if (!inblk && !done && $0 ~ /^[[:space:]]*server[[:space:]]*\{/) { inblk = 1; depth = 0; n = 0; l80 = 0 }
            if (inblk) {
                buf[++n] = $0
                s = $0; sub(/#.*/, "", s)
                if (s ~ /^[[:space:]]*listen[[:space:]]+([^;]*:)?80([^0-9]|$)/) l80 = 1
                o = gsub(/\{/, "{", s); c = gsub(/\}/, "}", s); depth += o - c
                if (depth <= 0) { flush(l80); inblk = 0; if (l80) done = 1 }
                next
            }
            print
        }
        END { if (inblk) flush(0) }
    ' "$conf" > "$tmp" && { cmp -s "$tmp" "$conf" || cat "$tmp" > "$conf"; }
    rm -f "$tmp"
}

# --- privileged MySQL access ----------------------------------------------------------------------
# The installer needs a MySQL account that can create users and databases. Candidates, in order:
#   1. MYSQL_ROOT_PASSWORD from the environment
#   2. Issabel: mysqlrootpwd= in /etc/issabel.conf
#   3. root through the unix socket / with no password (FreePBX distro, Debian, Issabel netinstall)
#   4. the PBX's own DB account from /etc/freepbx.conf, /etc/issabelpbx.conf or /etc/amportal.conf
#   5. a typed root password (interactive runs only)
# Passwords go through a 0600 option file, never through argv (where `ps` shows them).
MYSQL_ROOT_CNF=""
MYSQL_ROOT_DESC=""

_mysql_cnf() {  # <file> <user> [password]
    umask 077
    {
        out "[client]"
        out "user=$2"
        if [ -n "${3:-}" ]; then
            local p="${3//\\/\\\\}"; p="${p//\"/\\\"}"
            out "password=\"$p\""
        fi
    } > "$1"
}

resolve_mysql_root() {
    command_exists mysql || return 1
    local cnf="$TMPD/root.cnf" pw
    _try() { _mysql_cnf "$cnf" "$1" "${2:-}"; mysql --defaults-extra-file="$cnf" -N -e "SELECT 1" >/dev/null 2>&1; }
    if [ -n "${MYSQL_ROOT_PASSWORD:-}" ] && _try root "$MYSQL_ROOT_PASSWORD"; then
        MYSQL_ROOT_DESC="root (MYSQL_ROOT_PASSWORD)"
    elif pw=$(issabel_root_password "$ISSABEL_CONF") && [ -n "$pw" ] && _try root "$pw"; then
        MYSQL_ROOT_DESC="root (password from $ISSABEL_CONF)"
    elif _try root ""; then
        MYSQL_ROOT_DESC="root (unix socket)"
    elif pbx_db_credentials && [ -n "$PBX_DB_USER" ] && _try "$PBX_DB_USER" "$PBX_DB_PASS"; then
        MYSQL_ROOT_DESC="$PBX_DB_USER (PBX config)"
    elif [ "$ASSUME_YES" != "1" ] && [ -t 0 ]; then
        read -r -s -p "MySQL/MariaDB root password: " pw; out ""
        if [ -n "$pw" ] && _try root "$pw"; then MYSQL_ROOT_DESC="root (typed)"; else return 1; fi
    else
        return 1
    fi
    MYSQL_ROOT_CNF="$cnf"
}

mysql_root() { mysql --defaults-extra-file="$MYSQL_ROOT_CNF" "$@"; }

# db_login_ok <user> <pass>: the app account can log in with these credentials.
db_login_ok() {
    local cnf="$TMPD/app.cnf"
    _mysql_cnf "$cnf" "$1" "$2"
    mysql --defaults-extra-file="$cnf" -h "$DB_HOST" -P "$DB_PORT" -N -e "SELECT 1" >/dev/null 2>&1
}

# =================================================================================================
# Steps
# =================================================================================================

step_preflight() {
    [ "$(id -u)" -eq 0 ] || die "run the installer as root: sudo ./install.sh"
    TMPD=$(mktemp -d) || die "mktemp failed"
    trap 'rm -rf "$TMPD"' EXIT

    if [ -e "$PROJECT_ROOT/.git" ]; then IS_UPDATE=true; else IS_UPDATE=false; fi

    clear 2>/dev/null || true
    note "================================================================="
    note "                       OpDesk setup"
    note "================================================================="
    if [ "$IS_UPDATE" = "true" ]; then
        say "  Mode:    ${YELLOW}UPDATE${NC} (existing installation in $PROJECT_ROOT)"
    else
        say "  Mode:    ${GREEN}FRESH INSTALL${NC} into $PROJECT_ROOT"
    fi
    note "================================================================="

    # Service account: keep the User= of an existing unit, otherwise root. The backend runs
    # `asterisk -rx`, writes /etc/asterisk/*_custom.conf and reloads the PBX, so root is the default.
    SERVICE_USER=$(sed -n 's/^User=//p' "$UNIT_FILE" 2>/dev/null | head -1)
    SERVICE_USER="${SERVICE_USER:-root}"
    SERVICE_HOME=$(getent passwd "$SERVICE_USER" | cut -d: -f6)
    SERVICE_HOME="${SERVICE_HOME:-/root}"
    export HOME="$SERVICE_HOME"
    export NVM_DIR="$SERVICE_HOME/.nvm"
}

step_os() {
    step "Step 1: operating system"
    detect_os
    info "Detected: $OS_PRETTY (family: $OS_FAMILY)"
    [ "$OS_FAMILY" = "unknown" ] && warn "Unknown OS family; package installs are skipped, install missing tools by hand."

    # Node 24's official binaries need glibc >= 2.28 (RHEL 8 / Debian 10). Node 27+ needs 2.34,
    # which is why the version is pinned to 24 and never to "lts" or "node".
    GLIBC_VERSION=$(ldd --version 2>/dev/null | head -1 | grep -oE '[0-9]+\.[0-9]+$')
    if [ -n "$GLIBC_VERSION" ] && ! ver_ge "$GLIBC_VERSION" "2.28"; then
        die "glibc $GLIBC_VERSION is too old for Node.js $NODE_MAJOR (needs 2.28+). Sangoma 7 / CentOS 7 boxes need an OS upgrade or the Docker install."
    fi

    local pkgs_missing=()
    local t
    for t in git curl openssl lsof tar ss; do command_exists "$t" || pkgs_missing+=("$t"); done
    if [ ${#pkgs_missing[@]} -eq 0 ]; then
        info "Required tools present."
    elif [ "$OS_FAMILY" = "debian" ]; then
        apt-get update -qq && apt-get install -y git curl openssl lsof tar iproute2 ca-certificates
    elif [ "$OS_FAMILY" = "el" ]; then
        dnf install -y git curl openssl lsof tar iproute ca-certificates \
            || yum install -y git curl openssl lsof tar iproute ca-certificates
    fi
}

step_repo() {
    step "Step 2: OpDesk code"
    if [ "$IS_UPDATE" = "true" ]; then
        cd "$PROJECT_ROOT" || die "cannot cd to $PROJECT_ROOT"
        if [ "$DO_PULL" != "1" ]; then
            info "--no-pull: using the code in $PROJECT_ROOT ($(git rev-parse --short HEAD 2>/dev/null))"
            return
        fi
        # nginx/opdesk.conf is generated by this script. Older releases tracked it in git, so a
        # locally regenerated copy would block the pull; it is rewritten below anyway.
        if git ls-files --error-unmatch nginx/opdesk.conf >/dev/null 2>&1; then
            cp -f nginx/opdesk.conf "$TMPD/opdesk.conf.prev" 2>/dev/null
            git checkout -- nginx/opdesk.conf 2>/dev/null || true
        fi
        local before after self_before
        before=$(git rev-parse HEAD)
        self_before=$(sha256sum "$PROJECT_ROOT/install.sh" 2>/dev/null | cut -d' ' -f1)
        git pull --ff-only origin "$(git rev-parse --abbrev-ref HEAD)" \
            || die "git pull failed. Resolve local changes (git status) or re-run with --no-pull."
        after=$(git rev-parse HEAD)
        [ -f "$TMPD/opdesk.conf.prev" ] && [ ! -f nginx/opdesk.conf ] && cp -f "$TMPD/opdesk.conf.prev" nginx/opdesk.conf
        if [ "$before" != "$after" ]; then info "Updated $before -> $after"; else info "Already up to date."; fi
        # A pulled installer may differ from the one running: hand over to it.
        if [ "$self_before" != "$(sha256sum "$PROJECT_ROOT/install.sh" | cut -d' ' -f1)" ]; then
            warn "install.sh changed; continuing with the new version."
            rm -rf "$TMPD"
            local args=(--no-pull)
            [ "$ASSUME_YES" = "1" ] && args+=(--yes)
            exec bash "$PROJECT_ROOT/install.sh" "${args[@]}"
        fi
    else
        if [ -d "$PROJECT_ROOT" ] && [ -n "$(ls -A "$PROJECT_ROOT" 2>/dev/null)" ]; then
            die "$PROJECT_ROOT exists but is not a git checkout. Move it away and re-run."
        fi
        mkdir -p "$(dirname "$PROJECT_ROOT")"
        git clone "$REPO_URL" "$PROJECT_ROOT" || die "git clone $REPO_URL failed"
        cd "$PROJECT_ROOT" || die "cannot cd to $PROJECT_ROOT"
    fi
}

# Upgrades from the Python/FastAPI backend: stop the old process before the build (it hot-reloads
# from files the pull just deleted), and drop what the old installer put on the system.
step_migrate_legacy() {
    if systemctl is-active --quiet opdesk 2>/dev/null \
       && { [ -f "$PROJECT_ROOT/backend/server.py" ] || pgrep -f "python[0-9.]* .*server\.py" >/dev/null 2>&1; }; then
        warn "Stopping the running Python backend (opdesk.service) for the upgrade to the Node.js backend..."
        systemctl stop opdesk 2>/dev/null || true
    fi
    rm -rf "$PROJECT_ROOT/backend/__pycache__" "$PROJECT_ROOT/backend/api/__pycache__" 2>/dev/null
    # The old installer symlinked /usr/local/bin/python and wrote a /usr/local/bin/pip wrapper,
    # which shadow the distro's python for every PBX script that runs `env python`. Remove them
    # only when the wrapper is byte-for-byte the one it wrote (proof that the installer made them).
    local wrapper=$'#!/bin/bash\npython -m pip "$@"'
    if [ -f /usr/local/bin/pip ] && [ "$(cat /usr/local/bin/pip 2>/dev/null)" = "$wrapper" ]; then
        rm -f /usr/local/bin/pip
        if [ -L /usr/local/bin/python ] && readlink /usr/local/bin/python | grep -qE '^/usr/(local/)?bin/python3(\.[0-9]+)?$'; then
            rm -f /usr/local/bin/python
        fi
        info "Removed the /usr/local/bin/python and pip shims left by the previous installer."
        note "  Python packages it installed system-wide (fastapi, uvicorn, ...) are no longer used;"
        note "  they can be removed with pip at your convenience."
    fi
}

step_node() {
    step "Step 3: Node.js $NODE_MAJOR (nvm)"
    if [ ! -s "$NVM_DIR/nvm.sh" ]; then
        info "Installing nvm $NVM_VERSION into $NVM_DIR..."
        mkdir -p "$NVM_DIR"
        curl -fsSL "https://raw.githubusercontent.com/nvm-sh/nvm/$NVM_VERSION/install.sh" | NVM_DIR="$NVM_DIR" bash \
            || die "nvm install failed"
    fi
    # shellcheck disable=SC1091
    . "$NVM_DIR/nvm.sh" || die "cannot load nvm"
    if nvm ls "$NODE_MAJOR" >/dev/null 2>&1; then
        nvm use --silent "$NODE_MAJOR" >/dev/null
    else
        nvm install "$NODE_MAJOR" || die "nvm install $NODE_MAJOR failed"
    fi
    nvm alias default "$NODE_MAJOR" >/dev/null
    nvm use --silent "$NODE_MAJOR" >/dev/null
    [ "$(node -p 'process.versions.node.split(".")[0]')" = "$NODE_MAJOR" ] || die "node $NODE_MAJOR is not active ($(node -v 2>&1))"
    info "Node $(node -v), npm $(npm -v)"
    if [ "$SERVICE_USER" != "root" ]; then chown -R "$SERVICE_USER": "$NVM_DIR" 2>/dev/null || true; fi
}

# Voice-activity analysis is the only Python left: backend/vad/call_vad_analysis.py, run by the
# backend with VAD_PYTHON. It lives in its own venv, so nothing is installed into the system
# Python. Optional: when this fails, OpDesk runs without talk/silence analysis.
step_python_vad() {
    step "Step 4: Python venv for voice-activity analysis (optional)"
    VAD_PYTHON=""
    local venv="$PROJECT_ROOT/backend/vad/.venv" req="$PROJECT_ROOT/backend/vad/requirements.txt" py="" v
    _pick() {
        local c
        for c in python3.13 python3.12 python3.11; do command_exists "$c" && { command -v "$c"; return; }; done
        if command_exists python3 && python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)' 2>/dev/null; then
            command -v python3
        fi
    }
    py=$(_pick)
    if [ "$OS_FAMILY" = "el" ] && [ -z "$py" ]; then
        # Rocky 8 / Issabel 5: python3 is 3.6; AppStream has 3.11 and 3.12.
        dnf install -y python3.12 python3.12-pip >/dev/null 2>&1 || dnf install -y python3.11 python3.11-pip >/dev/null 2>&1 || true
        py=$(_pick)
    fi
    if [ "$OS_FAMILY" = "debian" ] && [ -n "$py" ]; then
        # Debian splits venv/ensurepip out of the interpreter package.
        v=$("$py" -c 'import sys; print(f"{sys.version_info[0]}.{sys.version_info[1]}")')
        "$py" -c 'import ensurepip' >/dev/null 2>&1 \
            || apt-get install -y "python${v}-venv" >/dev/null 2>&1 || apt-get install -y python3-venv >/dev/null 2>&1 || true
    fi
    if [ -z "$py" ]; then
        warn "No Python 3.9+ found; voice-activity analysis stays off."
        return
    fi
    if [ -x "$venv/bin/python" ] && ! "$venv/bin/python" -c 'import sys' >/dev/null 2>&1; then
        rm -rf "$venv"   # interpreter it was built from is gone
    fi
    [ -x "$venv/bin/python" ] || "$py" -m venv "$venv" || { warn "python -m venv failed; voice-activity analysis stays off."; return; }
    "$venv/bin/python" -m pip install -q --disable-pip-version-check -U pip >/dev/null 2>&1 || true
    if [ -f "$req" ]; then
        "$venv/bin/python" -m pip install -q --disable-pip-version-check -r "$req" \
            || "$venv/bin/python" -m pip install -q --disable-pip-version-check numpy webrtcvad-wheels \
            || true
    else
        "$venv/bin/python" -m pip install -q --disable-pip-version-check numpy webrtcvad-wheels onnxruntime || true
    fi
    if "$venv/bin/python" -c 'import numpy, webrtcvad' >/dev/null 2>&1; then
        VAD_PYTHON="$venv/bin/python"
        info "VAD venv ready: $("$VAD_PYTHON" --version 2>&1) at $venv"
        # Prefetch the Silero model (onnxruntime path), so analysis works without outbound HTTPS.
        if "$VAD_PYTHON" -c 'import onnxruntime' >/dev/null 2>&1; then
            local model="$SERVICE_HOME/.cache/opdesk/silero_vad.onnx"
            if [ ! -s "$model" ]; then
                mkdir -p "$(dirname "$model")"
                if curl -fsSL -o "$model.tmp" "https://github.com/snakers4/silero-vad/raw/v5.1.2/src/silero_vad/data/silero_vad.onnx"; then
                    mv -f "$model.tmp" "$model"
                else
                    rm -f "$model.tmp"
                    warn "Could not prefetch the Silero model; it is downloaded on first use."
                fi
            fi
        else
            note "onnxruntime is not available for this Python; the analysis uses WebRTC VAD only."
        fi
    else
        warn "VAD dependencies did not install; voice-activity analysis stays off."
    fi
}

step_database() {
    step "Step 5: PBX and database"
    PBX=$(detect_pbx)
    local prev_pbx; prev_pbx=$(env_get "$ENV_FILE" PBX)
    [ "$PBX" = "Generic" ] && [ -n "$prev_pbx" ] && PBX="$prev_pbx"
    info "PBX: $PBX"
    ASTERISK_VERSION=$(asterisk -V 2>/dev/null | grep -oE '[0-9]+(\.[0-9]+)+' | head -1)
    [ -n "$ASTERISK_VERSION" ] && info "Asterisk: $ASTERISK_VERSION"

    DB_HOST=$(env_get "$ENV_FILE" DB_HOST); DB_HOST="${DB_HOST:-localhost}"
    DB_PORT=$(env_get "$ENV_FILE" DB_PORT); DB_PORT="${DB_PORT:-3306}"
    DB_NAME=$(env_get "$ENV_FILE" DB_NAME); DB_NAME="${DB_NAME:-asterisk}"
    DB_CDR=$(env_get "$ENV_FILE" DB_CDR); DB_CDR="${DB_CDR:-asteriskcdrdb}"
    DB_APP=$(env_get "$ENV_FILE" DB_OpDesk); DB_APP="${DB_APP:-OpDesk}"
    DB_USER=$(env_get "$ENV_FILE" DB_USER)
    DB_PASS=$(env_get "$ENV_FILE" DB_PASSWORD)
    # Old Generic installs ran as MySQL root; OpDesk gets its own account now.
    if [ -z "$DB_USER" ] || [ "$DB_USER" = "root" ]; then DB_USER="OpDesk"; DB_PASS=""; fi
    [[ "$DB_USER" =~ ^[A-Za-z0-9_]+$ ]] || die "DB_USER '$DB_USER' in $ENV_FILE has unsupported characters"
    [[ "$DB_APP" =~ ^[A-Za-z0-9_]+$ ]] || die "DB_OpDesk '$DB_APP' in $ENV_FILE has unsupported characters"
    DB_STATUS="not checked"

    if command_exists systemctl && ! systemctl is-active --quiet mariadb && ! systemctl is-active --quiet mysqld \
       && ! systemctl is-active --quiet mysql; then
        systemctl start mariadb 2>/dev/null || systemctl start mysqld 2>/dev/null || systemctl start mysql 2>/dev/null || true
    fi

    local grants="GRANT SELECT, INSERT, UPDATE, DELETE ON \`$DB_NAME\`.* TO '$DB_USER'@'localhost'; GRANT SELECT ON \`$DB_CDR\`.* TO '$DB_USER'@'localhost'; GRANT ALL PRIVILEGES ON \`$DB_APP\`.* TO '$DB_USER'@'localhost'; FLUSH PRIVILEGES;"

    if ! resolve_mysql_root; then
        [ -z "$DB_PASS" ] && DB_PASS=$(openssl rand -hex 16)
        warn "No privileged MySQL login worked (tried MYSQL_ROOT_PASSWORD, $ISSABEL_CONF, the root socket and the PBX config)."
        warn "Create the OpDesk account and schema by hand, as MySQL root:"
        out "  CREATE USER '$DB_USER'@'localhost' IDENTIFIED BY '<DB_PASSWORD from $ENV_FILE>';"
        out "  $grants"
        out "  mysql < $PROJECT_ROOT/backend/schema.sql"
        DB_STATUS="manual setup needed"
        return
    fi
    info "Privileged MySQL login: $MYSQL_ROOT_DESC"

    local exists
    exists=$(mysql_root -N -e "SELECT COUNT(*) FROM mysql.user WHERE User='$DB_USER' AND Host='localhost'" 2>/dev/null)
    if [ "${exists:-0}" = "0" ]; then
        DB_PASS=$(openssl rand -hex 16)
        # Plain CREATE USER (no IF NOT EXISTS): works from MariaDB 5.5 (Sangoma 7) to 11.x.
        if mysql_root -e "CREATE USER '$DB_USER'@'localhost' IDENTIFIED BY '$DB_PASS';"; then
            info "Created database user '$DB_USER'"
        else
            warn "Could not create database user '$DB_USER'"
        fi
    elif [ -z "$DB_PASS" ] || ! db_login_ok "$DB_USER" "$DB_PASS"; then
        DB_PASS=$(openssl rand -hex 16)
        # ALTER USER needs MariaDB 10.2+; SET PASSWORD ... PASSWORD() covers 5.5.
        if mysql_root -e "ALTER USER '$DB_USER'@'localhost' IDENTIFIED BY '$DB_PASS';" 2>/dev/null \
           || mysql_root -e "SET PASSWORD FOR '$DB_USER'@'localhost' = PASSWORD('$DB_PASS');"; then
            warn "Database user '$DB_USER' existed with an unknown password; it was reset."
        else
            warn "Could not reset the password of database user '$DB_USER'"
        fi
    else
        info "Using existing database user '$DB_USER'"
    fi
    # Same grants as every earlier release; re-applied each run (idempotent).
    mysql_root -e "$grants" || warn "GRANT statements failed for '$DB_USER'"

    # The schema is applied here, as a privileged user: the OpDesk account cannot CREATE DATABASE.
    # schema.sql is idempotent (CREATE ... IF NOT EXISTS, INSERT IGNORE); the backend adds any
    # newer columns/tables itself at startup.
    if [ -f "$PROJECT_ROOT/backend/schema.sql" ]; then
        if mysql_root < "$PROJECT_ROOT/backend/schema.sql"; then
            info "Schema applied (database $DB_APP)"
        else
            warn "schema.sql failed; run it by hand as root: mysql < $PROJECT_ROOT/backend/schema.sql"
        fi
    fi

    # The schema's housekeeping EVENTs only run with the event scheduler on (it is off by default).
    mysql_root -e "SET GLOBAL event_scheduler = ON;" 2>/dev/null || warn "Could not enable event_scheduler (needs SUPER)."
    local dropin=""
    if [ -d /etc/mysql/mariadb.conf.d ]; then dropin=/etc/mysql/mariadb.conf.d/90-opdesk.cnf
    elif [ -d /etc/my.cnf.d ]; then dropin=/etc/my.cnf.d/opdesk.cnf
    elif [ -d /etc/mysql/conf.d ]; then dropin=/etc/mysql/conf.d/90-opdesk.cnf
    fi
    if [ -n "$dropin" ] && ! grep -qs '^event_scheduler' "$dropin"; then
        printf '%s\n' "# Written by the OpDesk installer: OpDesk's schema uses EVENTs for housekeeping." \
            "[mysqld]" "event_scheduler = ON" > "$dropin"
        info "event_scheduler persisted in $dropin"
    fi

    if db_login_ok "$DB_USER" "$DB_PASS"; then DB_STATUS="connected"; else DB_STATUS="login FAILED"; fi
    info "Database user $DB_USER@$DB_HOST:$DB_PORT: $DB_STATUS"
}

step_ami() {
    step "Step 6: Asterisk AMI user"
    AMI_HOST=$(env_get "$ENV_FILE" AMI_HOST)
    # Node may resolve "localhost" to ::1 first, while AMI listens on 127.0.0.1 and the user is
    # permitted from 127.0.0.1 only.
    [ -z "$AMI_HOST" ] || [ "$AMI_HOST" = "localhost" ] && AMI_HOST="127.0.0.1"
    AMI_PORT=$(env_get "$ENV_FILE" AMI_PORT); AMI_PORT="${AMI_PORT:-5038}"
    AMI_USER=$(env_get "$ENV_FILE" AMI_USERNAME); AMI_USER="${AMI_USER:-OpDesk}"
    AMI_SECRET=""
    AMI_STATUS=""
    local custom="$ASTERISK_ETC/manager_custom.conf" main="$ASTERISK_ETC/manager.conf"
    if [ ! -d "$ASTERISK_ETC" ]; then
        warn "$ASTERISK_ETC not found: is Asterisk installed? Set AMI_* in $ENV_FILE by hand."
        AMI_SECRET=$(env_get "$ENV_FILE" AMI_SECRET)
        AMI_STATUS="no Asterisk config"
        return
    fi
    # Issabel and plain Asterisk may have no manager_custom.conf yet; FreePBX and Issabel include it
    # from manager.conf. Create it, and add the include where it is missing (plain Asterisk).
    if [ ! -f "$custom" ]; then
        touch "$custom"
        chown asterisk:asterisk "$custom" 2>/dev/null || true
        chmod 640 "$custom"
        info "Created $custom"
    fi
    if [ -f "$main" ] && ! grep -qE '^[[:space:]]*#(try)?include[[:space:]]+"?manager_custom\.conf"?' "$main"; then
        printf '\n; Added by the OpDesk installer\n#include manager_custom.conf\n' >> "$main"
        warn "Added '#include manager_custom.conf' to $main"
    fi

    AMI_SECRET=$(ami_section_secret "$custom" "$AMI_USER")
    if [ -n "$AMI_SECRET" ] && [ ${#AMI_SECRET} -ge 16 ]; then
        info "Using existing AMI user [$AMI_USER]"
        AMI_STATUS="existing"
    elif [ -n "$AMI_SECRET" ]; then
        # Older installers wrote 8-character secrets; AMI can bind 0.0.0.0 (Issabel), so rotate.
        local new; new=$(openssl rand -hex 16)
        awk -v sec="[$AMI_USER]" -v new="$new" '
            { t=$0; gsub(/^[[:space:]]+|[[:space:]]+$/, "", t) }
            t ~ /^\[/ { insec = (t == sec || index(t, sec "(") == 1) }
            insec && t ~ /^secret[[:space:]]*=/ { print "secret = " new; next }
            { print }' "$custom" > "$TMPD/manager_custom.conf" \
            && cat "$TMPD/manager_custom.conf" > "$custom"
        AMI_SECRET="$new"
        info "Rotated the weak secret of AMI user [$AMI_USER]"
        AMI_STATUS="secret rotated"
    else
        AMI_SECRET=$(openssl rand -hex 16)
        cat >> "$custom" <<EOF

; OpDesk operator panel (written by install.sh)
[$AMI_USER]
secret = $AMI_SECRET
deny = 0.0.0.0/0.0.0.0
permit = 127.0.0.1/255.255.255.255
read = all
write = all
writetimeout = 5000
EOF
        info "Created AMI user [$AMI_USER] in $custom"
        AMI_STATUS="created"
    fi
    if command_exists asterisk && asterisk -rx "core show version" >/dev/null 2>&1; then
        asterisk -rx "manager reload" >/dev/null 2>&1 || true
        if ! asterisk -rx "http show status" 2>/dev/null | grep -qiE 'enabled and bound|bound to'; then
            warn "Asterisk's HTTP server looks disabled; the softphone needs it (/sip-ws -> 127.0.0.1:8088/ws)."
        fi
    else
        warn "Asterisk is not running; the AMI user takes effect at its next start."
    fi
}

step_certificate() {
    step "Step 7: TLS certificate"
    CERT_DIR="$PROJECT_ROOT/cert"
    SELF_CERT="$CERT_DIR/opdesk_cert.pem"
    SELF_KEY="$CERT_DIR/opdesk_key.pem"
    mkdir -p "$CERT_DIR"
    if [ -f "$SELF_CERT" ] && [ -f "$SELF_KEY" ]; then
        info "Reusing the certificate in $CERT_DIR"
        return
    fi
    local ip cn
    ip=$(hostname -I 2>/dev/null | awk '{print $1}')
    cn="${ip:-localhost}"
    # subjectAltName needs OpenSSL 1.1.1+ (-addext); older OpenSSL gets a CN-only certificate.
    openssl req -x509 -newkey rsa:2048 -sha256 -days 825 -nodes -keyout "$SELF_KEY" -out "$SELF_CERT" \
        -subj "/CN=$cn" -addext "subjectAltName=IP:${ip:-127.0.0.1},DNS:$(hostname -f 2>/dev/null || hostname),DNS:localhost" 2>/dev/null \
    || openssl req -x509 -newkey rsa:2048 -sha256 -days 825 -nodes -keyout "$SELF_KEY" -out "$SELF_CERT" -subj "/CN=$cn" \
    || die "openssl could not create a certificate"
    chmod 600 "$SELF_KEY"; chmod 644 "$SELF_CERT"
    info "Created a self-signed certificate (CN=$cn) in $CERT_DIR"
    # Same pair for Asterisk's TLS/WSS listener, if the admin wants to use it.
    if [ -d "$ASTERISK_ETC/keys" ]; then
        cp "$SELF_CERT" "$ASTERISK_ETC/keys/opdesk_cert.pem"
        cp "$SELF_KEY" "$ASTERISK_ETC/keys/opdesk_key.pem"
        chown asterisk:asterisk "$ASTERISK_ETC/keys/opdesk_cert.pem" "$ASTERISK_ETC/keys/opdesk_key.pem" 2>/dev/null || true
        chmod 600 "$ASTERISK_ETC/keys/opdesk_key.pem"
    fi
}

step_questions() {
    step "Questions: domain, HTTPS port, admin password"
    PBX=$(detect_pbx)
    OPDESK_DOMAIN="${OPDESK_DOMAIN:-$(env_get "$ENV_FILE" OPDESK_DOMAIN)}"
    FORCE_RENEW=0
    if [ "$ASSUME_YES" != "1" ] && [ -t 0 ]; then
        if [ -n "$OPDESK_DOMAIN" ]; then
            note "Current domain: $OPDESK_DOMAIN"
            out "  1) keep it   2) change it   3) keep it and force-renew its certificate"
            case "$(ask 'Choose [1/2/3] (default 1): ' 1)" in
                2) OPDESK_DOMAIN=$(ask "New domain (empty = none, self-signed): " "") ;;
                3) FORCE_RENEW=1 ;;
            esac
        else
            note "A public domain name gives a trusted Let's Encrypt certificate."
            OPDESK_DOMAIN=$(ask "Domain (e.g. opdesk.example.com), or Enter for self-signed: " "")
        fi
    fi
    OPDESK_DOMAIN=$(out "$OPDESK_DOMAIN" | tr -d '[:space:]')

    # HTTPS port: the previous one, else 443, else 8443 when 443 belongs to something else
    # (Apache on FreePBX and Issabel).
    local prev default owner
    prev=$(env_get "$ENV_FILE" NGINX_HTTPS_PORT)
    [ -z "$prev" ] && prev=$(grep -oP '^\s*listen\s+\K[0-9]+(?=\s+ssl)' "$PROJECT_ROOT/nginx/opdesk.conf" 2>/dev/null | head -1)
    if [ -n "${OPDESK_PUBLIC_HTTPS_PORT:-}" ]; then default="$OPDESK_PUBLIC_HTTPS_PORT"
    elif [ -n "$prev" ]; then default="$prev"
    else
        owner=$(port_owner 443)
        if [ -z "$owner" ] || [ "$owner" = "ours" ]; then default=443; else default=8443; fi
    fi
    while true; do
        NGINX_HTTPS_PORT=$(ask "HTTPS port for OpDesk [$default]: " "$default")
        [[ "$NGINX_HTTPS_PORT" =~ ^[0-9]+$ ]] && [ "$NGINX_HTTPS_PORT" -ge 1 ] && [ "$NGINX_HTTPS_PORT" -le 65535 ] && break
        err "Invalid port."
        [ "$ASSUME_YES" = "1" ] && die "invalid HTTPS port $NGINX_HTTPS_PORT"
    done
    resolve_https_conflict

    # Admin password: fresh installs only. Enter = a random one, printed in the summary.
    ADMIN_PASSWORD=""; ADMIN_PASSWORD_GENERATED=0
    if [ "$IS_UPDATE" != "true" ]; then
        ADMIN_PASSWORD="${OPDESK_ADMIN_PASSWORD:-}"
        if [ -z "$ADMIN_PASSWORD" ] && [ "$ASSUME_YES" != "1" ] && [ -t 0 ]; then
            local p1 p2
            while true; do
                read -r -s -p "Password for the 'admin' user (Enter = generate one): " p1; out ""
                [ -z "$p1" ] && break
                [ ${#p1} -ge 8 ] || { err "Use at least 8 characters."; continue; }
                read -r -s -p "Confirm: " p2; out ""
                [ "$p1" = "$p2" ] && { ADMIN_PASSWORD="$p1"; break; }
                err "Passwords do not match."
            done
        fi
        if [ -z "$ADMIN_PASSWORD" ]; then
            ADMIN_PASSWORD=$(openssl rand -base64 18 | tr -dc 'A-Za-z0-9' | head -c 16)
            ADMIN_PASSWORD_GENERATED=1
        fi
    fi
}

# Apache on FreePBX/Issabel commonly owns 443. Options: another port for OpDesk (default), move
# Apache to 4443 (FreePBX/plain Asterisk only: Issabel's GUI, certbot module and HTTPS rewrite all
# assume Apache on 80/443, so it is never moved there), or stop.
resolve_https_conflict() {
    local owner choice
    owner=$(port_owner "$NGINX_HTTPS_PORT")
    [ -z "$owner" ] || [ "$owner" = "ours" ] && return 0
    err "Port $NGINX_HTTPS_PORT is in use by '$owner'."
    if [ "$ASSUME_YES" = "1" ] || [ ! -t 0 ]; then
        die "port $NGINX_HTTPS_PORT is taken; set OPDESK_PUBLIC_HTTPS_PORT to a free port (e.g. 8443)"
    fi
    out "  1) use another port for OpDesk (suggested: 8443)"
    if [[ "$owner" =~ ^(apache2|httpd)$ ]] && [ "$PBX" != "Issabel" ]; then
        out "  2) move $owner from $NGINX_HTTPS_PORT to 4443 (the PBX web UI moves to https://<server>:4443)"
    fi
    out "  3) cancel"
    choice=$(ask "Choose: " 1)
    case "$choice" in
        2)
            if [[ "$owner" =~ ^(apache2|httpd)$ ]] && [ "$PBX" != "Issabel" ]; then
                move_apache_port "$NGINX_HTTPS_PORT" 4443
                sleep 2
                owner=$(port_owner "$NGINX_HTTPS_PORT")
                [ -z "$owner" ] || [ "$owner" = "ours" ] && return 0
                err "Port $NGINX_HTTPS_PORT is still taken by '$owner'."
            fi
            ;;
        3) die "cancelled; free port $NGINX_HTTPS_PORT or pick another, then re-run" ;;
    esac
    while true; do
        NGINX_HTTPS_PORT=$(ask "HTTPS port for OpDesk [8443]: " 8443)
        owner=$(port_owner "$NGINX_HTTPS_PORT")
        [[ "$NGINX_HTTPS_PORT" =~ ^[0-9]+$ ]] && { [ -z "$owner" ] || [ "$owner" = "ours" ]; } && return 0
        err "Port $NGINX_HTTPS_PORT is invalid or in use${owner:+ by $owner}."
    done
}

move_apache_port() {
    local from="$1" to="$2" f changed=0
    if [ -f /etc/apache2/ports.conf ]; then
        sed -i "s/\bListen $from\b/Listen $to/g" /etc/apache2/ports.conf && changed=1
        for f in /etc/apache2/sites-enabled/*; do
            [ -f "$f" ] && sed -i -e "s/<VirtualHost \*:$from>/<VirtualHost *:$to>/g" \
                -e "s/<VirtualHost _default_:$from>/<VirtualHost _default_:$to>/g" "$f"
        done
        [ "$changed" = 1 ] && systemctl restart apache2 2>/dev/null
    fi
    if [ -d /etc/httpd ]; then
        for f in /etc/httpd/conf/httpd.conf /etc/httpd/conf.d/*.conf; do
            [ -f "$f" ] || continue
            if grep -qE "\bListen $from\b|<VirtualHost [^>]*:$from>" "$f"; then
                sed -i -e "s/\bListen $from\b/Listen $to/g" -e "s/<VirtualHost \*:$from>/<VirtualHost *:$to>/g" \
                    -e "s/<VirtualHost _default_:$from>/<VirtualHost _default_:$to>/g" "$f" && changed=1
            fi
        done
        if [ "$changed" = 1 ]; then
            command_exists semanage && { semanage port -a -t http_port_t -p tcp "$to" 2>/dev/null || semanage port -m -t http_port_t -p tcp "$to" 2>/dev/null || true; }
            systemctl restart httpd 2>/dev/null
        fi
    fi
}

install_nginx() {
    if command_exists nginx; then return 0; fi
    info "Installing nginx..."
    if [ "$OS_FAMILY" = "debian" ]; then
        apt-get update -qq && apt-get install -y nginx
    elif [ "$OS_FAMILY" = "el" ]; then
        # EL8's default nginx module stream is 1.14; 1.24 is the newest one in AppStream.
        if dnf module list nginx >/dev/null 2>&1; then
            dnf module reset -y nginx >/dev/null 2>&1
            dnf module enable -y nginx:1.24 >/dev/null 2>&1 || dnf module enable -y nginx:1.22 >/dev/null 2>&1 || true
        fi
        dnf install -y nginx || yum install -y nginx
    fi
    command_exists nginx || die "nginx is not installed and could not be installed"
}

# Where the site goes: Debian's sites-enabled when nginx.conf includes it, conf.d everywhere else
# (EL/Rocky/Issabel nginx.conf only includes conf.d/*.conf).
install_nginx_site() {
    local generated="$PROJECT_ROOT/nginx/opdesk.conf"
    if [ -d /etc/nginx/sites-enabled ] && grep -qE '^[[:space:]]*include[[:space:]]+/etc/nginx/sites-enabled/' /etc/nginx/nginx.conf 2>/dev/null; then
        NGINX_SITE_PATH="/etc/nginx/sites-enabled/opdesk"
        mkdir -p /etc/nginx/sites-available
        ln -sfn "$generated" /etc/nginx/sites-available/opdesk
        ln -sfn /etc/nginx/sites-available/opdesk /etc/nginx/sites-enabled/opdesk
        # Debian's stock site listens on :80 as default_server and would shadow the redirect.
        if [ -L /etc/nginx/sites-enabled/default ] && [ "$(readlink -f /etc/nginx/sites-enabled/default)" = "/etc/nginx/sites-available/default" ]; then
            rm -f /etc/nginx/sites-enabled/default
        fi
    else
        NGINX_SITE_PATH="/etc/nginx/conf.d/opdesk.conf"
        # A copy, not a symlink: SELinux labels files under /opt differently from /etc/nginx.
        install -m 644 "$generated" "$NGINX_SITE_PATH"
    fi
    # EL's nginx.conf carries its own `server { listen 80 default_server; }`.
    if grep -qE '^[[:space:]]*server[[:space:]]*\{' /etc/nginx/nginx.conf 2>/dev/null; then
        [ -f /etc/nginx/nginx.conf.opdesk-orig ] || cp -p /etc/nginx/nginx.conf /etc/nginx/nginx.conf.opdesk-orig
        disable_stock_server_block /etc/nginx/nginx.conf
        grep -q '^#opdesk# ' /etc/nginx/nginx.conf && info "Disabled the stock port-80 server in /etc/nginx/nginx.conf (backup: nginx.conf.opdesk-orig)"
    fi
}

# write_and_test_nginx: render, install, `nginx -t`; on failure restore the previous site.
write_and_test_nginx() {
    local generated="$PROJECT_ROOT/nginx/opdesk.conf"
    mkdir -p "$PROJECT_ROOT/nginx"
    [ -f "$generated" ] && cp -f "$generated" "$TMPD/opdesk.conf.last"
    render_nginx_conf "$generated"
    install_nginx_site
    if nginx -t >/dev/null 2>&1; then
        if systemctl is-active --quiet nginx; then systemctl reload nginx; else systemctl enable --now nginx; fi
        return 0
    fi
    err "nginx -t failed with the new OpDesk site:"
    nginx -t 2>&1 | tail -5 >&2
    if [ -f "$TMPD/opdesk.conf.last" ]; then
        cp -f "$TMPD/opdesk.conf.last" "$generated"
        install_nginx_site
        warn "Restored the previous OpDesk site; nginx keeps running with it."
    fi
    return 1
}

obtain_le_certificate() {
    local domain="$1" webroot="" owner80 email live
    live="/etc/letsencrypt/live/$domain"
    if [ -f "$live/fullchain.pem" ] && [ "$FORCE_RENEW" != "1" ]; then return 0; fi
    owner80=$(port_owner 80)
    if [ -n "$NGINX_HTTP_PORT" ]; then
        webroot="$ACME_WEBROOT"           # nginx's :80 server serves the challenge
    elif [[ "$owner80" =~ ^(apache2|httpd)$ ]] && [ -d /var/www/html ]; then
        webroot="/var/www/html"           # FreePBX/Issabel Apache serves the challenge from its docroot
    else
        warn "Port 80 is served by '${owner80:-nothing}', so the HTTP-01 challenge cannot be answered; keeping the self-signed certificate."
        return 1
    fi
    if ! command_exists certbot; then
        info "Installing certbot..."
        if [ "$OS_FAMILY" = "debian" ]; then
            apt-get install -y certbot
        elif [ "$OS_FAMILY" = "el" ]; then
            dnf install -y certbot 2>/dev/null || { dnf install -y epel-release && dnf install -y certbot; }
        fi
        command_exists certbot || { warn "certbot could not be installed"; return 1; }
    fi
    mkdir -p "$webroot/.well-known/acme-challenge"
    email="${OPDESK_LE_EMAIL:-admin@$domain}"
    local extra=()
    [ "$FORCE_RENEW" = "1" ] && extra+=(--force-renewal)
    info "Requesting a Let's Encrypt certificate for $domain (webroot $webroot)..."
    if certbot certonly --webroot -w "$webroot" -d "$domain" --non-interactive --agree-tos -m "$email" \
        --keep-until-expiring "${extra[@]}"; then
        # Older OpDesk installs used --standalone, whose renewals fail once nginx holds :80.
        if grep -qs '^authenticator = standalone' "/etc/letsencrypt/renewal/$domain.conf"; then
            certbot reconfigure --cert-name "$domain" --webroot -w "$webroot" >/dev/null 2>&1 \
                || warn "Renewal for $domain is still set to 'standalone'; run: certbot reconfigure --cert-name $domain --webroot -w $webroot"
        fi
    else
        warn "Let's Encrypt failed (DNS must point here and port 80 must be reachable)."
        return 1
    fi
    # Renewals run from certbot's timer/cron; reload nginx after each so it serves the new cert.
    mkdir -p /etc/letsencrypt/renewal-hooks/deploy
    printf '#!/bin/sh\n# Installed by the OpDesk installer: serve renewed certificates.\nsystemctl reload nginx\n' \
        > /etc/letsencrypt/renewal-hooks/deploy/opdesk-nginx.sh
    chmod 755 /etc/letsencrypt/renewal-hooks/deploy/opdesk-nginx.sh
    [ -f "$live/fullchain.pem" ]
}

open_firewall_port() {
    local port="$1"
    FIREWALL_NOTE=""
    if systemctl is-active --quiet firewalld 2>/dev/null; then
        firewall-cmd --permanent --add-port="$port/tcp" >/dev/null && firewall-cmd --reload >/dev/null \
            && info "firewalld: opened $port/tcp"
    elif command_exists ufw && ufw status 2>/dev/null | grep -q '^Status: active'; then
        ufw allow "$port/tcp" >/dev/null && info "ufw: opened $port/tcp"
    elif [ "$PBX" = "Issabel" ] && command_exists iptables && iptables -S INPUT 2>/dev/null | grep -q -- '-j'; then
        # The Issabel firewall keeps its rules in /var/www/db/iptables.db and rewrites iptables on
        # every apply, so a raw iptables rule would be lost.
        FIREWALL_NOTE="Issabel firewall is active: add TCP $port under Security > Firewall > Firewall Rules."
    elif command_exists iptables && iptables -S INPUT 2>/dev/null | grep -qE -- '-P INPUT (DROP|REJECT)|-j (DROP|REJECT)'; then
        FIREWALL_NOTE="iptables filters INPUT: allow TCP $port in your firewall (FreePBX: Connectivity > Firewall > Services > Custom Services)."
    fi
    [ -n "$FIREWALL_NOTE" ] && warn "$FIREWALL_NOTE"
}

selinux_setup() {
    command_exists getenforce || return 0
    [ "$(getenforce 2>/dev/null)" = "Enforcing" ] || return 0
    setsebool -P httpd_can_network_connect 1 2>/dev/null || true
    if command_exists semanage && ! semanage port -l 2>/dev/null | grep -E '^http_port_t' | grep -qw "$NGINX_HTTPS_PORT"; then
        semanage port -a -t http_port_t -p tcp "$NGINX_HTTPS_PORT" 2>/dev/null || true
    fi
    chcon -R -t cert_t "$PROJECT_ROOT/cert" 2>/dev/null || true
    chcon -R -t httpd_sys_content_t "$ACME_WEBROOT" 2>/dev/null || true
    info "SELinux: allowed nginx to proxy to 127.0.0.1 and bind $NGINX_HTTPS_PORT"
}

step_nginx() {
    step "Step 8: nginx reverse proxy"
    install_nginx
    NGINX_VERSION=$(nginx_version)
    NGINX_IPV6=0; ipv6_enabled && NGINX_IPV6=1
    PORT=$(env_get "$ENV_FILE" PORT); PORT="${PORT:-8765}"
    ASTERISK_HTTP_PORT="${ASTERISK_HTTP_PORT:-8088}"

    # The :80 redirect/ACME server only when :80 is free or already OpDesk's. Apache keeps :80 on
    # FreePBX and Issabel (their GUI and certbot modules depend on it).
    local owner80; owner80=$(port_owner 80)
    if [ -z "$owner80" ] || [ "$owner80" = "ours" ]; then
        NGINX_HTTP_PORT=80
    else
        NGINX_HTTP_PORT=""
        info "Port 80 belongs to '$owner80'; OpDesk adds no HTTP->HTTPS redirect."
    fi
    mkdir -p "$ACME_WEBROOT"

    NGINX_SERVER_NAME="_"
    NGINX_SSL_CERT="$SELF_CERT"
    NGINX_SSL_KEY="$SELF_KEY"
    TLS_MODE="self-signed"
    if [ -n "$OPDESK_DOMAIN" ]; then
        NGINX_SERVER_NAME="$OPDESK_DOMAIN"
        local live="/etc/letsencrypt/live/$OPDESK_DOMAIN"
        if [ -f "$live/fullchain.pem" ]; then
            NGINX_SSL_CERT="$live/fullchain.pem"; NGINX_SSL_KEY="$live/privkey.pem"
            if [ "$FORCE_RENEW" = "1" ]; then
                write_and_test_nginx || true
                obtain_le_certificate "$OPDESK_DOMAIN" || true
            fi
        else
            # Serve the challenge first (self-signed for now), then switch to the issued cert.
            write_and_test_nginx || true
            if obtain_le_certificate "$OPDESK_DOMAIN"; then
                NGINX_SSL_CERT="$live/fullchain.pem"; NGINX_SSL_KEY="$live/privkey.pem"
            fi
        fi
        [ "$NGINX_SSL_CERT" != "$SELF_CERT" ] && TLS_MODE="Let's Encrypt ($OPDESK_DOMAIN)"
    fi

    selinux_setup
    if write_and_test_nginx; then
        info "nginx serves OpDesk on :$NGINX_HTTPS_PORT (site: $NGINX_SITE_PATH -> $PROJECT_ROOT/nginx/opdesk.conf)"
        NGINX_STATUS="running"
    else
        NGINX_STATUS="config test FAILED"
    fi
    systemctl enable nginx >/dev/null 2>&1 || true
    open_firewall_port "$NGINX_HTTPS_PORT"
}

step_env() {
    step "Step 9: backend/.env"
    local ip origin_port origins old
    ip=$(hostname -I 2>/dev/null | awk '{print $1}')
    [ "$NGINX_HTTPS_PORT" != "443" ] && origin_port=":$NGINX_HTTPS_PORT"
    # Browsers send the port in Origin when it is not 443, so the origins carry it too.
    origins="https://${ip:-localhost}${origin_port:-}"
    [ -n "$OPDESK_DOMAIN" ] && origins="https://$OPDESK_DOMAIN${origin_port:-},$origins"
    # Keep extra origins an admin added by hand.
    old=$(env_get "$ENV_FILE" CORS_ALLOWED_ORIGINS)
    local o
    IFS=',' read -r -a _olds <<< "$old"
    for o in "${_olds[@]}"; do
        o=$(out "$o" | tr -d '[:space:]')
        [ -n "$o" ] && [[ ",$origins," != *",$o,"* ]] && origins="$origins,$o"
    done

    JWT_SECRET=$(env_get "$ENV_FILE" JWT_SECRET)
    [ -z "$JWT_SECRET" ] && JWT_SECRET=$(openssl rand -hex 32)

    p() { local v; v=$(env_get "$ENV_FILE" "$1"); out "${v:-$2}"; }
    local recording_root; recording_root=$(p ASTERISK_RECORDING_ROOT_DIR /var/spool/asterisk/monitor/)

    local tmp="$TMPD/env.new"
    umask 077
    cat > "$tmp" <<EOF
# OpDesk backend configuration. Written by install.sh: values are kept on re-run, and variables
# the installer does not manage are carried over at the end of the file.
OS=$OS
PBX=$PBX
DB_HOST=$DB_HOST
DB_PORT=$DB_PORT
DB_USER=$DB_USER
DB_PASSWORD=$DB_PASS
DB_NAME=$DB_NAME
DB_CDR=$DB_CDR
DB_OpDesk=$DB_APP

ASTERISK_RECORDING_ROOT_DIR=$recording_root
AMI_HOST=$AMI_HOST
AMI_PORT=$AMI_PORT
AMI_USERNAME=$AMI_USER
AMI_SECRET=$AMI_SECRET
AMI_CONTEXT=$(p AMI_CONTEXT ext-local)

# The backend listens on OPDESK_BIND_HOST:PORT (plain HTTP, loopback); nginx terminates TLS.
PORT=$PORT
OPDESK_BIND_HOST=$(p OPDESK_BIND_HOST 127.0.0.1)
OPDESK_HTTPS_PORT=$(p OPDESK_HTTPS_PORT 8443)
# Public HTTPS port nginx serves OpDesk on; put into the URLs the backend hands out
# (e.g. the softphone's wss://<host>:<port>/sip-ws) when it is not 443.
NGINX_HTTPS_PORT=$NGINX_HTTPS_PORT
JWT_SECRET=$JWT_SECRET
OPDESK_DOMAIN=$OPDESK_DOMAIN
CORS_ALLOWED_ORIGINS=$origins

# Only for serving TLS from the backend itself; leave empty behind nginx.
HTTPS_CERT=$(p HTTPS_CERT "")
HTTPS_KEY=$(p HTTPS_KEY "")

# Python interpreter for the voice-activity analysis (backend/vad). Empty = analysis off.
VAD_PYTHON=$VAD_PYTHON

# --- Mobile push (optional). A provider is skipped unless all of its vars are set. ---
FCM_PROJECT_ID=$(p FCM_PROJECT_ID "")
FCM_SERVICE_ACCOUNT_FILE=$(p FCM_SERVICE_ACCOUNT_FILE "$PROJECT_ROOT/secrets/fcm-service-account.json")
APNS_AUTH_KEY_FILE=$(p APNS_AUTH_KEY_FILE "$PROJECT_ROOT/secrets/AuthKey_XXXX.p8")
APNS_KEY_ID=$(p APNS_KEY_ID "")
APNS_TEAM_ID=$(p APNS_TEAM_ID "")
APNS_BUNDLE_ID=$(p APNS_BUNDLE_ID "")
APNS_USE_SANDBOX=$(p APNS_USE_SANDBOX false)
# Settings > Mobile Wake overrides these. Hold time (8-30 s) and settle window (0-10 s).
MOBILE_WAKE_WAIT=$(p MOBILE_WAKE_WAIT 10)
MOBILE_WAKE_SETTLE=$(p MOBILE_WAKE_SETTLE 3)
EOF
    # Carry over every other variable of the previous file (LOG_LEVEL, CRM_*, OPDESK_LISTEN_PORT, ...).
    if [ -f "$ENV_FILE" ]; then
        local managed extra key
        managed=" $(grep -oE '^[A-Za-z_][A-Za-z0-9_]*=' "$tmp" | tr -d '=' | tr '\n' ' ') "
        extra=""
        while IFS= read -r line; do
            key="${line%%=*}"
            [[ "$line" =~ ^[A-Za-z_][A-Za-z0-9_]*= ]] || continue
            [[ "$managed" == *" $key "* ]] && continue
            extra+="$line"$'\n'
        done < "$ENV_FILE"
        [ -n "$extra" ] && printf '\n# Kept from the previous .env\n%s' "$extra" >> "$tmp"
        cp -p "$ENV_FILE" "$ENV_FILE.bak" 2>/dev/null && chmod 600 "$ENV_FILE.bak"
    fi
    install -m 600 "$tmp" "$ENV_FILE"
    if [ "$SERVICE_USER" != "root" ]; then chown "$SERVICE_USER": "$ENV_FILE" "$ENV_FILE.bak" 2>/dev/null; fi
    umask 022
    info "Wrote $ENV_FILE (mode 600; previous copy in .env.bak)"
}

step_build() {
    step "Step 10: build backend and frontend"
    BUILD_STATUS="ok"
    local mem_kb; mem_kb=$(awk '/^MemTotal:/{print $2}' /proc/meminfo)
    local nopts="${NODE_OPTIONS:-}"
    [ -z "$nopts" ] && [ "${mem_kb:-0}" -lt 3000000 ] && nopts="--max-old-space-size=1024"
    local d
    for d in backend frontend; do
        info "npm ci + build: $d"
        if (cd "$PROJECT_ROOT/$d" && { if [ -f package-lock.json ]; then npm ci --include=dev --no-audit --no-fund; else npm install --include=dev --no-audit --no-fund; fi; } \
            && NODE_OPTIONS="$nopts" npm run build); then
            info "$d built"
        else
            err "$d build failed (see the npm output above)."
            BUILD_STATUS="FAILED ($d)"
        fi
    done
    [ -f "$PROJECT_ROOT/backend/dist/main.js" ] || BUILD_STATUS="FAILED (no backend/dist/main.js)"
    if [ "$SERVICE_USER" != "root" ]; then chown -R "$SERVICE_USER": "$PROJECT_ROOT" 2>/dev/null; fi
}

# Hash with the backend's own bcrypt dependency (Python is VAD-only now) and store it directly.
# The seed admin row exists once schema.sql ran. Without a privileged DB login, the hash goes to
# backend/.admin_init_hash, which the backend applies once at startup and deletes.
step_admin_password() {
    ADMIN_STATUS="unchanged"
    [ -n "$ADMIN_PASSWORD" ] || return 0
    local hash
    hash=$(cd "$PROJECT_ROOT/backend" && OPDESK_PW="$ADMIN_PASSWORD" node -e '
        let b; try { b = require("bcryptjs"); } catch { b = require("bcrypt"); }
        process.stdout.write(b.hashSync(process.env.OPDESK_PW, 12));' 2>/dev/null)
    if ! [[ "$hash" =~ ^\$2[aby]\$[0-9]{2}\$[./A-Za-z0-9]{53}$ ]]; then
        warn "Could not hash the admin password (backend dependencies missing?); set it later in the UI."
        ADMIN_STATUS="NOT set (hashing failed)"
        ADMIN_PASSWORD_GENERATED=0
        return
    fi
    if [ -n "$MYSQL_ROOT_CNF" ] && mysql_root -e "UPDATE \`$DB_APP\`.users SET password_hash='$hash' WHERE username='admin';" 2>/dev/null; then
        ADMIN_STATUS="set"
    else
        (umask 077; out "$hash" > "$PROJECT_ROOT/backend/.admin_init_hash")
        ADMIN_STATUS="set at first start"
    fi
}

step_systemd() {
    step "Step 11: opdesk.service"
    local new="$TMPD/opdesk.service"
    cat > "$new" <<EOF
[Unit]
Description=OpDesk - operator panel for Asterisk
Documentation=https://github.com/Ibrahimgamal99/OpDesk
After=network-online.target mariadb.service mysqld.service mysql.service asterisk.service
Wants=network-online.target

[Service]
Type=simple
User=$SERVICE_USER
WorkingDirectory=$PROJECT_ROOT
Environment=HOME=$SERVICE_HOME
Environment=NVM_DIR=$NVM_DIR
# start.sh builds whatever changed, then execs \`node backend/dist/main.js\`: node is the main PID.
ExecStart=/bin/bash $PROJECT_ROOT/start.sh
Restart=on-failure
RestartSec=5
# SIGTERM goes to node only; Nest's shutdown hooks close AMI, DB pools and WebSockets, then
# whatever is left in the cgroup is killed.
KillMode=mixed
TimeoutStopSec=30
LimitNOFILE=65536
StandardOutput=journal
StandardError=journal
SyslogIdentifier=opdesk

[Install]
WantedBy=multi-user.target
EOF
    if ! cmp -s "$new" "$UNIT_FILE"; then
        install -m 644 "$new" "$UNIT_FILE"
        systemctl daemon-reload
        info "Wrote $UNIT_FILE"
    else
        info "$UNIT_FILE is up to date"
    fi
    systemctl enable opdesk.service >/dev/null 2>&1
    SERVICE_STATUS="not started"
    if [ "$BUILD_STATUS" != "ok" ] && [ ! -f "$PROJECT_ROOT/backend/dist/main.js" ]; then
        warn "Not starting opdesk: the backend is not built."
        return
    fi
    systemctl restart opdesk.service
    sleep 3
    if systemctl is-active --quiet opdesk.service; then SERVICE_STATUS="running"; else SERVICE_STATUS="FAILED (journalctl -u opdesk -n 100)"; fi
}

step_summary() {
    local url_port="" host
    [ "$NGINX_HTTPS_PORT" != "443" ] && url_port=":$NGINX_HTTPS_PORT"
    host="${OPDESK_DOMAIN:-$(hostname -I 2>/dev/null | awk '{print $1}')}"
    out ""
    say "${GREEN}=================================================================${NC}"
    say "${GREEN}                  OpDesk installation report${NC}"
    say "${GREEN}=================================================================${NC}"
    note "SYSTEM"
    out "  Location:       $PROJECT_ROOT"
    out "  OS:             $OS_PRETTY"
    out "  PBX:            $PBX${ASTERISK_VERSION:+ (Asterisk $ASTERISK_VERSION)}"
    out "  Node.js:        $(node -v 2>/dev/null) (nvm, $NVM_DIR)"
    out "  VAD Python:     ${VAD_PYTHON:-off}"
    note "DATABASE"
    out "  User:           $DB_USER@$DB_HOST:$DB_PORT ($DB_STATUS)"
    out "  Databases:      $DB_NAME (PBX), $DB_CDR (CDR), $DB_APP (OpDesk)"
    note "ASTERISK AMI"
    out "  User:           $AMI_USER@$AMI_HOST:$AMI_PORT (${AMI_STATUS:-?}); secret in backend/.env"
    note "WEB"
    out "  URL:            https://$host$url_port"
    out "  TLS:            $TLS_MODE"
    out "  nginx:          ${NGINX_STATUS:-?} ($NGINX_SITE_PATH)"
    [ -n "${FIREWALL_NOTE:-}" ] && out "  Firewall:       $FIREWALL_NOTE"
    note "SERVICE"
    out "  Build:          $BUILD_STATUS"
    out "  opdesk.service: $SERVICE_STATUS"
    out "  Logs:           journalctl -u opdesk -f"
    out "  Restart:        systemctl restart opdesk"
    note "ADMIN"
    out "  Username:       admin"
    if [ "$ADMIN_PASSWORD_GENERATED" = "1" ] && [[ "$ADMIN_STATUS" == set* ]]; then
        say "  Password:       ${YELLOW}$ADMIN_PASSWORD${NC}  (generated; change it after signing in)"
    elif [[ "$ADMIN_STATUS" == set* ]]; then
        out "  Password:       as entered ($ADMIN_STATUS)"
    else
        out "  Password:       $ADMIN_STATUS"
    fi
    say "${GREEN}=================================================================${NC}"
    [ "$TLS_MODE" = "self-signed" ] && note "The certificate is self-signed: open the URL once and accept it, or the softphone cannot connect."
}

main() {
    while [ $# -gt 0 ]; do
        case "$1" in
            -y|--yes) ASSUME_YES=1 ;;
            --no-pull) DO_PULL=0 ;;
            -h|--help) usage; exit 0 ;;
            *) usage; exit 1 ;;
        esac
        shift
    done
    step_preflight
    step_os
    step_repo
    step_migrate_legacy
    step_questions          # every question up front; the rest runs unattended
    step_node
    step_python_vad
    step_database
    step_ami
    step_certificate
    step_nginx
    step_env
    step_build
    step_admin_password
    step_systemd
    step_summary
}

# Run only when executed, so the helpers above can be sourced by tests.
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
    main "$@"
fi
