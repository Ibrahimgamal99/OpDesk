#!/bin/bash
# ============================================================================
# Asterisk Operator Panel - Start Script
# Runs both backend (FastAPI) and frontend (Vite) with logging
# ============================================================================

set -e

# Colors for terminal output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Project root directory
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="$PROJECT_DIR/logs"
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")

# Log files
BACKEND_LOG="$LOG_DIR/backend_$TIMESTAMP.log"
FRONTEND_LOG="$LOG_DIR/frontend_$TIMESTAMP.log"

# PID files for cleanup
BACKEND_PID=""
FRONTEND_PID=""

# Create logs directory
mkdir -p "$LOG_DIR"

# Cleanup function
cleanup() {
    echo -e "\n${YELLOW}[$(date '+%H:%M:%S')]${NC} Shutting down services..."
    
    if [ -n "$BACKEND_PID" ] && kill -0 "$BACKEND_PID" 2>/dev/null; then
        echo -e "${CYAN}[$(date '+%H:%M:%S')]${NC} Stopping backend (PID: $BACKEND_PID)..."
        kill "$BACKEND_PID" 2>/dev/null || true
        wait "$BACKEND_PID" 2>/dev/null || true
    fi
    
    if [ -n "$FRONTEND_PID" ] && kill -0 "$FRONTEND_PID" 2>/dev/null; then
        echo -e "${CYAN}[$(date '+%H:%M:%S')]${NC} Stopping frontend (PID: $FRONTEND_PID)..."
        kill "$FRONTEND_PID" 2>/dev/null || true
        wait "$FRONTEND_PID" 2>/dev/null || true
    fi
    
    echo -e "${GREEN}[$(date '+%H:%M:%S')]${NC} All services stopped."
    echo -e "${BLUE}Logs saved to:${NC}"
    echo -e "  Backend:  $BACKEND_LOG"
    echo -e "  Frontend: $FRONTEND_LOG"
    exit 0
}

# Trap signals for cleanup
trap cleanup SIGINT SIGTERM EXIT

# Header
echo -e "${CYAN}"
echo "=============================================="
echo "   Asterisk Operator Panel - Starting..."
echo "=============================================="
echo -e "${NC}"
echo -e "${BLUE}[$(date '+%H:%M:%S')]${NC} Project directory: $PROJECT_DIR"
echo -e "${BLUE}[$(date '+%H:%M:%S')]${NC} Log directory: $LOG_DIR"
echo ""

# ============================================================================
# Start Backend
# ============================================================================
echo -e "${YELLOW}[$(date '+%H:%M:%S')]${NC} Starting backend server..."

cd "$PROJECT_DIR"

# Check if virtual environment exists and activate it
if [ -d "venv" ]; then
    source venv/bin/activate
    echo -e "${GREEN}[$(date '+%H:%M:%S')]${NC} Activated virtual environment"
elif [ -d ".venv" ]; then
    source .venv/bin/activate
    echo -e "${GREEN}[$(date '+%H:%M:%S')]${NC} Activated virtual environment"
fi

# Start backend with logging
cd "$PROJECT_DIR/backend"
python -u server.py 2>&1 | tee -a "$BACKEND_LOG" | grep --line-buffered -v "change detected" | while read line; do
    echo -e "${GREEN}[BACKEND]${NC} $line"
done &
BACKEND_PID=$!

echo -e "${GREEN}[$(date '+%H:%M:%S')]${NC} Backend started (PID: $BACKEND_PID)"
echo -e "${GREEN}[$(date '+%H:%M:%S')]${NC} Backend URL: http://localhost:8765"

# Give backend a moment to start
sleep 2

# ============================================================================
# Start Frontend
# ============================================================================
echo -e "${YELLOW}[$(date '+%H:%M:%S')]${NC} Starting frontend dev server..."

cd "$PROJECT_DIR/frontend"

# Check if node_modules exists
if [ ! -d "node_modules" ]; then
    echo -e "${YELLOW}[$(date '+%H:%M:%S')]${NC} Installing frontend dependencies..."
    npm install 2>&1 | tee -a "$FRONTEND_LOG"
fi

# Start frontend with logging (--host exposes on all network interfaces)
npm run dev -- --host 2>&1 | stdbuf -oL tee -a "$FRONTEND_LOG" | while read line; do
    echo -e "${BLUE}[FRONTEND]${NC} $line"
done &
FRONTEND_PID=$!

echo -e "${GREEN}[$(date '+%H:%M:%S')]${NC} Frontend started (PID: $FRONTEND_PID)"

# ============================================================================
# Wait and show status
# ============================================================================
sleep 3
echo ""
echo -e "${CYAN}=============================================="
echo -e "   Services Running"
echo -e "==============================================${NC}"
echo -e "${GREEN}✓${NC} Backend:  http://0.0.0.0:8765"
echo -e "${GREEN}✓${NC} Frontend: http://0.0.0.0:5173"
echo ""
echo -e "${YELLOW}Press Ctrl+C to stop all services${NC}"
echo ""
echo -e "${BLUE}Logs:${NC}"
echo -e "  Backend:  $BACKEND_LOG"
echo -e "  Frontend: $FRONTEND_LOG"
echo ""

# Keep script running and wait for both processes
wait

