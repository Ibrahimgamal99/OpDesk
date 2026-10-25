#!/bin/bash
# OpDesk start script.
#
#   ./start.sh            production (default): build whatever changed, then exec the backend
#   ./start.sh -d         development: tsc --watch + node --watch backend, Vite dev server
#
# Production is what opdesk.service runs. The backend (NestJS, backend/dist/main.js) serves the
# built frontend (frontend/dist) and the API on OPDESK_BIND_HOST:PORT (127.0.0.1:8765 behind nginx).
# `exec` makes node the unit's main process, so systemd's SIGTERM reaches Nest directly and its
# shutdown hooks close AMI, the DB pools and the WebSockets cleanly.

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'

NODE_MAJOR=24

usage() {
  out "Usage: $0 [-p|--production] | [-d|--dev]"
  out "  -p, --production  build what changed, then run the backend (serves frontend/dist) (default)"
  out "  -d, --dev         tsc --watch + node --watch backend, Vite dev server with hot reload"
}

MODE=production
while [ $# -gt 0 ]; do
  case "$1" in
    -d|--dev) MODE=dev ;;
    -p|--production|--prod) MODE=production ;;
    -h|--help) usage; exit 0 ;;
    *) usage; exit 1 ;;
  esac
  shift
done

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FE="$PROJECT_ROOT/frontend"
BE="$PROJECT_ROOT/backend"
cd "$PROJECT_ROOT" || exit 1

# Output helpers: say interprets backslash escapes (colors, \n), out prints its arguments verbatim.
say() { printf '%b\n' "$*"; }
out() { printf '%s\n' "$*"; }
log()  { say "${GREEN}[OpDesk]${NC} $*"; }
warn() { say "${YELLOW}[OpDesk]${NC} $*"; }
fail() { say "${RED}[OpDesk] $*${NC}" >&2; }

# Node comes from nvm (installed by install.sh, pinned to 24: Node 27+ needs glibc 2.34, which
# EL8-based PBXs such as Issabel 5 do not have). A system node is accepted when nvm is absent.
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh"
  nvm use --silent "$NODE_MAJOR" >/dev/null 2>&1 || warn "nvm has no Node $NODE_MAJOR; using $(command -v node 2>/dev/null || out 'no node')"
fi
command -v node >/dev/null 2>&1 || { fail "node not found (run install.sh, or install Node $NODE_MAJOR via nvm)"; exit 1; }
_node_major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null)
[ "$_node_major" = "$NODE_MAJOR" ] || warn "running on Node $(node -v); OpDesk is built and tested on Node $NODE_MAJOR"

# Small PBX boxes (1-2 GB RAM): cap the V8 heap of the build tools so tsc/vite do not get OOM-killed.
_mem_kb=$(awk '/^MemTotal:/{print $2}' /proc/meminfo 2>/dev/null)
if [ -n "$_mem_kb" ] && [ "$_mem_kb" -lt 3000000 ] && [ -z "${NODE_OPTIONS:-}" ]; then
  BUILD_NODE_OPTIONS="--max-old-space-size=1024"
else
  BUILD_NODE_OPTIONS="${NODE_OPTIONS:-}"
fi

# deps <dir>: `npm ci` when node_modules is missing or older than package-lock.json (npm rewrites
# node_modules/.package-lock.json on every install, so a `git pull` that changes the lockfile
# triggers a reinstall). --include=dev: tsc and vite are devDependencies, and an inherited
# NODE_ENV=production would otherwise skip them.
deps() {
  local dir="$1"
  if [ -f "$dir/node_modules/.package-lock.json" ] && \
     { [ ! -f "$dir/package-lock.json" ] || [ ! "$dir/package-lock.json" -nt "$dir/node_modules/.package-lock.json" ]; }; then
    return 0
  fi
  log "installing dependencies in ${dir#"$PROJECT_ROOT"/}"
  if [ -f "$dir/package-lock.json" ]; then
    (cd "$dir" && npm ci --include=dev --no-audit --no-fund)
  else
    (cd "$dir" && npm install --include=dev --no-audit --no-fund)
  fi
}

# build_if_changed <dir> <stamp> <paths...>
# Rebuild <dir> when <stamp> (relative to <dir>) is missing or any of <paths> is newer than it.
# The previous dist/ is kept aside during the build and put back if the build fails, so a bad
# commit leaves the last good build running instead of a broken half-written one.
build_if_changed() {
  local dir="$1" stamp="$2" name
  shift 2
  name="${dir#"$PROJECT_ROOT"/}"
  if [ -f "$dir/$stamp" ] && [ -z "$(cd "$dir" && find "$@" -newer "$stamp" 2>/dev/null | head -1)" ]; then
    log "$name is up to date"
    return 0
  fi
  log "building $name"
  if [ -d "$dir/dist" ]; then
    rm -rf "$dir/dist.prev" && cp -a "$dir/dist" "$dir/dist.prev"
  fi
  if deps "$dir" && (cd "$dir" && NODE_OPTIONS="$BUILD_NODE_OPTIONS" npm run build); then
    rm -rf "$dir/dist.prev"
    # An incremental tsc may leave an unchanged main.js untouched; bump the stamp so the next
    # start does not rebuild again.
    [ -f "$dir/$stamp" ] && touch "$dir/$stamp"
    log "$name built"
    return 0
  fi
  if [ -d "$dir/dist.prev" ]; then
    rm -rf "$dir/dist" && mv "$dir/dist.prev" "$dir/dist"
    fail "build of $name failed; starting the previous build (see the errors above)"
    return 0
  fi
  fail "build of $name failed and there is no previous build"
  return 1
}

if [ "$MODE" = production ]; then
  # Vite bakes VITE_* from .env files into the bundle, so they count as sources too.
  build_if_changed "$FE" dist/index.html \
    src public index.html package.json package-lock.json vite.config.* tsconfig*.json .env .env.production \
    || warn "the frontend is not built; the API still starts but the web UI will not load"
  build_if_changed "$BE" dist/main.js \
    src package.json package-lock.json tsconfig*.json \
    || exit 1

  cd "$BE" || exit 1
  export NODE_ENV="${NODE_ENV:-production}"
  say "${BLUE}[OpDesk]${NC} starting backend: node backend/dist/main.js ($(node -v))"
  exec node dist/main.js
fi

# --- development -----------------------------------------------------------------------------
deps "$FE" || exit 1
deps "$BE" || exit 1

PIDS=()
cleanup() {
  trap - INT TERM EXIT
  say "\n${YELLOW}[OpDesk]${NC} stopping dev processes..."
  for pid in "${PIDS[@]}"; do
    pkill -TERM -P "$pid" 2>/dev/null
    kill -TERM "$pid" 2>/dev/null
  done
  wait 2>/dev/null
  exit 0
}
trap cleanup INT TERM EXIT

(cd "$BE" && exec npx tsc -p tsconfig.build.json --watch --preserveWatchOutput) &
PIDS+=($!)

# Wait for the first emit, then let node restart itself on every rebuild of dist/.
for _ in $(seq 1 180); do
  [ -f "$BE/dist/main.js" ] && break
  sleep 1
done
[ -f "$BE/dist/main.js" ] || { fail "tsc produced no backend/dist/main.js"; exit 1; }
(cd "$BE" && exec node --watch-path=dist dist/main.js) &
PIDS+=($!)

(cd "$FE" && exec npm run dev -- --host) &
PIDS+=($!)

log "dev mode: tsc=${PIDS[0]} backend=${PIDS[1]} vite=${PIDS[2]}"
warn "press Ctrl+C to stop all three"
wait
