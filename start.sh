#!/bin/bash

# OpDesk start script: -d dev (backend + Vite dev server) | -p production (backend only, serves built frontend)
# Usage: ./start.sh [-d|--dev]   or   ./start.sh [-p|--production]
# Default: dev

# UI Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'

MODE="dev"
while [[ $# -gt 0 ]]; do
  case "$1" in
    -d|--dev)
      MODE="dev"
      shift
      ;;
    -p|--production|--prod)
      MODE="production"
      shift
      ;;
    *)
      echo -e "${RED}Usage: $0 [-d|--dev] | [-p|--production]${NC}"
      echo "  -d, --dev         Development: backend + Vite dev server (default)"
      echo "  -p, --production  Production: backend only (serves built frontend)"
      exit 1
      ;;
  esac
done

# Auto-detect project root (directory where this script is located)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$SCRIPT_DIR"

# Ensure we're in the project root
cd "$PROJECT_ROOT" || { echo -e "${RED}Error: Cannot access $PROJECT_ROOT${NC}"; exit 1; }

# Load NVM for frontend (dev mode)
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"

if [[ "$MODE" == "production" ]]; then
  echo -e "${GREEN}[OpDesk]${NC} Production mode: building frontend first..."
  cd "$PROJECT_ROOT/frontend" || { echo -e "${RED}Error: Frontend directory not found${NC}"; exit 1; }
  npm run build || { echo -e "${RED}Error: Frontend build failed${NC}"; exit 1; }
  echo -e "${GREEN}[OpDesk]${NC} Frontend built (frontend/dist). Starting backend..."
fi

echo -e "${BLUE}[OpDesk]${NC} Starting Backend..."
cd "$PROJECT_ROOT/backend" || { echo -e "${RED}Error: Backend directory not found${NC}"; exit 1; }
python server.py &
BACKEND_PID=$!

if [[ "$MODE" == "production" ]]; then
  echo -e "${GREEN}[OpDesk]${NC} Backend serving from frontend/dist."
  echo -e "${YELLOW}Press Ctrl+C to stop${NC}"
  trap "echo -e \"\n${YELLOW}[OpDesk]${NC} Stopping backend...\"; kill $BACKEND_PID 2>/dev/null; exit" SIGINT SIGTERM
  wait $BACKEND_PID
else
  echo -e "${BLUE}[OpDesk]${NC} Development mode: starting Vite dev server..."
  cd "$PROJECT_ROOT/frontend" || { echo -e "${RED}Error: Frontend directory not found${NC}"; kill $BACKEND_PID 2>/dev/null; exit 1; }
  npm run dev -- --host &
  FRONTEND_PID=$!
  echo -e "${GREEN}[OpDesk]${NC} Backend PID: $BACKEND_PID, Frontend PID: $FRONTEND_PID"
  echo -e "${YELLOW}Press Ctrl+C to stop both services${NC}"
  trap "echo -e \"\n${YELLOW}[OpDesk]${NC} Stopping services...\"; kill $BACKEND_PID $FRONTEND_PID 2>/dev/null; exit" SIGINT SIGTERM
  wait
fi
