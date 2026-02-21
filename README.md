# Operator Panel Desk (OpDesk)

A modern, real-time operator panel for Asterisk PBX systems, similar to FOP2 but built with modern technologies.
 
## Features

- **Authentication & User Management**: Login by username or extension with password; JWT-based auth; admin and supervisor roles
- **Role-based Access**: Admins see all extensions and queues; supervisors see only their assigned extensions and queues (filter by role, extension, and queue)
- **Monitor Modes (multi-select)**: Per-user selection of Listen, Whisper, and/or Barge; only allowed actions are shown in the UI
- **Real-time Extension Monitoring**: Live status updates for extensions (filtered by user scope)
- **Active Call Tracking**: See who's talking to whom with duration and talk time tracking
- **Call Duration & Talk Time**: Track total call duration and actual conversation time separately
- **Call Log/CDR History**: View historical call records with filtering and search capabilities
- **Call Recording Playback**: Listen to recorded calls directly from the web interface
- **Queue Management**: Monitor and manage call queues (filtered by user scope for supervisors)
- **Supervisor Features**: Listen, whisper, and barge into calls (according to each user’s allowed monitor modes)
- **CRM Integration**: Send call data to external CRM systems with support for multiple authentication methods (API Key, Basic Auth, Bearer Token, OAuth2)
- **QoS Data**: View Quality of Service metrics for calls
- **WebSocket-based**: Event-driven architecture for instant updates; state is filtered per user (admin vs supervisor scope)

## Screenshots

### Main Dashboard
![Main Dashboard](screenshots/extensions_dashboard.png)
*Real-time extension monitoring and active call tracking*

### Active Calls Panel
![Active Calls](screenshots/active_calls.png)
*View active calls with duration and talk time tracking*

### Call Log/CDR History
![Call Log](screenshots/call_history.png)
*Historical call records with filtering and search capabilities*

### Queue Management
![Queue Management](screenshots/queue.png)
*Monitor and manage call queues in real-time*

### QoS Data
![QoS Data](screenshots/qos.png)
*View Quality of Service metrics for calls*

**Note:** QoS functionality has been tested and verified on FreePBX systems.

### Settings
![Settings](screenshots/setting.png)
*Configure CRM integration and application settings*

## Authentication & User Management

- **Login**: Use extension or username plus password. Tokens are JWT; the frontend stores the token and user info (role, extension, monitor modes, assigned scope).
- **Roles**:
  - **Admin**: Full access; sees all extensions, queues, and calls; can manage users (Settings → Users).
  - **Supervisor**: Sees only extensions and queues assigned to them; can use only the monitor actions (Listen / Whisper / Barge) enabled for their account.
- **User scope**: Admins assign each supervisor a set of **extensions (agents)** and **queues**. The panel and API return only data within that scope.
- **Monitor modes**: Each user can have one or more of **Listen**, **Whisper**, and **Barge**. Only those options appear as actions in the Extensions and Active Calls panels. Configured in Settings → Users (admin only).
- **Default account**: After install, log in with username `admin` and the password set by the installer (e.g. `OpDesk@2026`). Change the password after first login.

## Architecture

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  React Frontend │◄───►│  FastAPI Server  │◄───►│  Asterisk AMI   │
│  (WebSocket)    │     │  (WebSocket)     │     │                 │
└─────────────────┘     └──────────────────┘     └─────────────────┘
```

## Prerequisites

- Linux system (Debian/Ubuntu, CentOS/RHEL/Fedora, or Arch Linux)
- Issabel or FreePBX system installed
- Asterisk PBX with AMI enabled
- MySQL/MariaDB (for FreePBX extension list)
- sudo access (for installing system packages)
- **curl** (required for downloading nvm during installation)

**Note:** The installation script will automatically install:
- Python 3.11+ and pip
- Node.js 24+ (via nvm)
- git, lsof, and curl (if not already installed)

## Installation

### Automated Installation (Recommended)

Use the provided installation script for a complete automated setup:

**One-liner (download and run):**
```bash
curl -k -O https://raw.githubusercontent.com/Ibrahimgamal99/OpDesk/main/install.sh && chmod +x install.sh && ./install.sh
```

**Or if you already have the repository:**
```bash
chmod +x install.sh
./install.sh
```

The script will:
1. Detect your OS and install git, lsof, and curl (if not already installed)
2. Clone the repository to `/opt/OpDesk` (if not already present)
3. Install nvm (Node Version Manager) and Node.js 24
4. Install Python 3.11+ and pip
5. Auto-detect Issabel or FreePBX installation
6. Auto-configure database credentials:
   - **Issabel**: Retrieves MySQL root password from `/etc/issabel.conf`
   - **FreePBX**: Creates database user `OpDesk` with auto-generated password
7. Auto-configure AMI user `OpDesk` with random secret in `/etc/asterisk/manager.conf`
8. Create `backend/.env` file with all settings
9. Install Python dependencies (with `--break-system-packages` on Debian/Ubuntu)
10. Install Node.js dependencies
11. Display installation summary report

**Note:** The script automatically configures:
- Database connection (auto-detects credentials for Issabel/FreePBX)
- AMI user and secret (auto-generated and added to Asterisk config)
- CDR database name (`asteriskcdrdb`)
- Recording root directory (`/var/spool/asterisk/monitor/`)

### Manual Installation

If you prefer manual installation:

#### Backend

1. Install Python dependencies (system-wide, no virtual environment required):

```bash
cd backend
pip3 install --break-system-packages -r requirements.txt
```

**Note:** This project does not use a virtual environment. Dependencies are installed directly to your Python environment. The `--break-system-packages` flag is required for newer pip versions when installing system-wide.

2. Configure environment variables in `backend/.env`:

```env
# Operating System
OS=debian

# PBX System
PBX=FreePBX

# Database Configuration (for extensions list and CDR)
DB_HOST=localhost
DB_PORT=3306
DB_USER=asteriskuser
DB_PASSWORD=your_db_password
DB_NAME=asterisk
DB_CDR=asteriskcdrdb

# Asterisk Recording Root Directory
ASTERISK_RECORDING_ROOT_DIR=/var/spool/asterisk/monitor/

# AMI Configuration
AMI_HOST=127.0.0.1
AMI_PORT=5038
AMI_USERNAME=OpDesk
AMI_SECRET=your_ami_secret
```

**Note:** The installation script automatically creates this file with appropriate values for your system.

#### Frontend

1. Install Node.js 24 (if not already installed):

```bash
# Install nvm
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
source ~/.nvm/nvm.sh
nvm install 24
nvm use 24
```

2. Install Node.js dependencies:

```bash
cd frontend
npm install
```

## Running

### Quick Start (Recommended)

After running the installation script (`./install.sh`), start the application:

```bash
./start.sh
```

This will start both backend and frontend services with logging. Press `Ctrl+C` to stop.

**Default login:** Username `admin` with the password configured during installation (e.g. `OpDesk@2026`). Change it after first login.

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

All API access (except login) requires a valid JWT in the `Authorization: Bearer <token>` header. Responses for extensions, calls, and queues are filtered by the current user’s role and assigned scope (supervisors see only their extensions and queues).

### Auth (no token required)

- `POST /api/auth/login` - Login with `{ "login": "username_or_extension", "password": "..." }`; returns `access_token` and `user` (id, username, role, extension, monitor_modes, allowed_agent_extensions, allowed_queue_names)
- `GET /api/auth/me` - Return current user (requires valid token)

### REST API (token required)

- `GET /api/extensions` - List monitored extensions (filtered by user scope)
- `GET /api/calls` - Active calls (filtered by user scope)
- `GET /api/queues` - Queue information (filtered by user scope)
- `GET /api/status` - Server status
- `GET /api/call-log` - Call log/CDR history (supports `limit`, `date`, `date_from`, `date_to`)
- `GET /api/recordings/{file_path}` - Serve call recording audio files
- `GET /api/settings` - Application settings
- `POST /api/settings` - Update application settings
- **User management (admin only):** `GET/POST /api/settings/users`, `GET/PUT/DELETE /api/settings/users/{id}` - List, create, update, delete users and assign extensions, queues, and monitor modes

Supervisor actions (listen, whisper, barge) are sent via WebSocket messages; the server enforces the user’s allowed monitor modes and scope.

### WebSocket

Connect to `ws://localhost:8765/ws?token=<JWT>` (or send `{ "token": "<JWT>" }` in the first message) for real-time updates.

The WebSocket connection provides:
- **Per-user filtered state**: Each client receives only the extensions, calls, and queues they are allowed to see (admin = full; supervisor = assigned agents and queues only)
- Real-time extension status updates
- Active call events
- Queue status changes
- System notifications
- Client can send actions: `get_state`, `sync`, `listen`, `whisper`, `barge`, `queue_add`, `queue_remove`, `queue_pause`, `queue_unpause`, etc.


## CRM Integration

OpDesk supports integration with external CRM systems to automatically send call data after each call ends.

### Supported Authentication Methods

- **API Key**: Custom header authentication
- **Basic Auth**: Username/password authentication
- **Bearer Token**: Token-based authentication
- **OAuth2**: OAuth2 flow with client credentials

### Configuration

CRM integration can be configured through the web interface (Settings → CRM Settings) or via the database settings table:

- `CRM_ENABLED`: Set to `true` or `1` to enable
- `CRM_SERVER_URL`: Your CRM server URL
- `CRM_AUTH_TYPE`: `api_key`, `basic_auth`, `bearer_token`, or `oauth2`
- Additional fields based on selected authentication type


## Technology Stack

### Backend
- **Python 3.11+**
- **FastAPI** - Modern async web framework
- **WebSockets** - Real-time communication
- **asyncio** - Async I/O for AMI communication
- **MySQL/MariaDB** - Database for extensions and CDR

### Frontend
- **React 24** - UI framework
- **TypeScript** - Type safety
- **Vite** - Build tool
- **Framer Motion** - Animations
- **Lucide React** - Icons

## Contact

For questions, issues, or contributions, please contact:

- **Email**: ib.gamal.a@gmail.com
- **LinkedIn**: [Ibrahim Gamal](https://www.linkedin.com/in/ibrahim-gamal99)
- **GitHub**: [Ibrahimgamal99](https://github.com/Ibrahimgamal99)

## Development Note

This project was entirely developed by Ibrahim Gamal, with AI tools assisting in generating repetitive code (boilerplate) and speeding up development.

## License

This project is open source and available under the MIT License.

## Support

OpDesk is free and open source. If you find it useful, please consider:

- ⭐ **Starring this repository** – it helps with visibility
- 🐛 **Reporting bugs or suggesting features** via [Issues](https://github.com/Ibrahimgamal99/OpDesk/issues)
- 💬 **Contributing** to the project

