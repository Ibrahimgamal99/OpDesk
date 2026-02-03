# Asterisk Operator Panel (AOP)

A modern, real-time operator panel for Asterisk PBX systems, similar to FOP2 but built with modern technologies.

## Features

- **Real-time Extension Monitoring**: Live status updates for all extensions
- **Active Call Tracking**: See who's talking to whom with duration and talk time tracking
- **Call Duration & Talk Time**: Track total call duration and actual conversation time separately
- **Queue Management**: Monitor and manage call queues
- **Supervisor Features**: Listen, whisper, and barge into calls
- **WebSocket-based**: Event-driven architecture for instant updates

## Architecture

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  React Frontend │◄───►│  FastAPI Server  │◄───►│  Asterisk AMI   │
│  (WebSocket)    │     │  (WebSocket)     │     │                 │
└─────────────────┘     └──────────────────┘     └─────────────────┘
```

## Prerequisites

- Python 3.8+
- Node.js 18+
- Asterisk PBX with AMI enabled
- MySQL/MariaDB (for FreePBX extension list)

## Installation

### Backend

1. Install Python dependencies (system-wide, no virtual environment required):

```bash
cd backend
pip install -r requirements.txt
```

**Note:** This project does not use a virtual environment. Dependencies are installed directly to your Python environment.

2. Configure environment variables in `backend/.env`:

```env
# AMI Configuration
AMI_HOST=127.0.0.1
AMI_PORT=5038
AMI_USERNAME=admin
AMI_SECRET=your_ami_secret
AMI_CONTEXT=ext-local

# Database Configuration (for extensions list)
DB_HOST=localhost
DB_PORT=3306
DB_USER=asteriskuser
DB_PASSWORD=your_db_password
DB_NAME=asterisk
```

### Frontend

1. Install Node.js dependencies:

```bash
cd frontend
npm install
```

## Running

### Quick Start (Recommended)

Use the provided start script to run both backend and frontend:

```bash
./start.sh
```

This will start both services with logging. Press `Ctrl+C` to stop.

### Development Mode

#### Option 1: Using the start script (recommended)

```bash
./start.sh
```

#### Option 2: Manual start

Start the backend server:

```bash
cd backend
python server.py
```

The server will run on `http://localhost:8765`

Start the frontend development server (in a separate terminal):

```bash
cd frontend
npm run dev
```

The frontend will run on `http://localhost:5173` with hot reload.

### Production Mode

1. Build the frontend:

```bash
cd frontend
npm run build
```

2. Start the server (serves both API and frontend):

```bash
cd backend
python server.py
```

Access the application at `http://localhost:8765`

## API Endpoints

### REST API

- `GET /api/extensions` - Get list of monitored extensions
- `GET /api/calls` - Get active calls
- `GET /api/queues` - Get queue information
- `GET /api/status` - Get server status

### WebSocket

Connect to `ws://localhost:8765/ws` for real-time updates.

#### Messages from Server

```json
{
  "type": "state_update",
  "data": {
    "extensions": {...},
    "active_calls": {...},
    "queues": {...},
    "queue_members": {...},
    "queue_entries": {...},
    "stats": {...}
  },
  "timestamp": "2024-01-01T12:00:00"
}
```

#### Actions to Server

```json
// Supervisor actions
{"action": "listen", "supervisor": "200", "target": "100"}
{"action": "whisper", "supervisor": "200", "target": "100"}
{"action": "barge", "supervisor": "200", "target": "100"}

// Queue management
{"action": "queue_add", "queue": "support", "interface": "100"}
{"action": "queue_remove", "queue": "support", "interface": "100"}
{"action": "queue_pause", "queue": "support", "interface": "100", "reason": "Break"}
{"action": "queue_unpause", "queue": "support", "interface": "100"}

// Sync
{"action": "sync_calls"}
{"action": "sync_queues"}
```

## Technology Stack

### Backend
- **Python 3.8+**
- **FastAPI** - Modern async web framework
- **WebSockets** - Real-time communication
- **asyncio** - Async I/O for AMI communication

### Frontend
- **React 18** - UI framework
- **TypeScript** - Type safety
- **Vite** - Build tool
- **Framer Motion** - Animations
- **Lucide React** - Icons

## License

MIT

