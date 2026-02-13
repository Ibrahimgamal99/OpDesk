#!/bin/bash

# UI Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'

# Auto-detect project root (directory where this script is located)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$SCRIPT_DIR"

# Ensure we're in the project root
cd "$PROJECT_ROOT" || { echo -e "${RED}Error: Cannot access $PROJECT_ROOT${NC}"; exit 1; }

# Load NVM
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"

echo -e "${BLUE}[OpDesk]${NC} Starting Backend..."
cd "$PROJECT_ROOT/backend" || { echo -e "${RED}Error: Backend directory not found${NC}"; exit 1; }
python server.py &
BACKEND_PID=$!

echo -e "${BLUE}[OpDesk]${NC} Starting Frontend..."
cd "$PROJECT_ROOT/frontend" || { echo -e "${RED}Error: Frontend directory not found${NC}"; exit 1; }
npm run dev -- --host &
FRONTEND_PID=$!

echo -e "${GREEN}[OpDesk]${NC} Both services started. Backend PID: $BACKEND_PID, Frontend PID: $FRONTEND_PID"
echo -e "${YELLOW}Press Ctrl+C to stop both services${NC}"

trap "echo -e \"\n${YELLOW}[OpDesk]${NC} Stopping services...\"; kill $BACKEND_PID $FRONTEND_PID 2>/dev/null; exit" SIGINT SIGTERM

wait