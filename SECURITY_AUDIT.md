# OpDesk Security & Stability Audit

> Audit date: 2026-04-14

---

## Critical Security

### 1. Hardcoded / Weak JWT Secret

| | |
|---|---|
| **File** | `install.sh:596`, `backend/server.py:707-710` |
| **Risk** | Token forgery — full admin access without credentials |

`install.sh` writes `JWT_SECRET=OpDesk` into `.env`. The fallback in `server.py` is `"opdesk-dev-secret-change-in-production"`. Both values are publicly visible in the GitHub repository. Anyone can forge a valid admin JWT.

**Fix:** Generate a random secret during install:

```bash
JWT_SECRET=$(openssl rand -hex 32)
```

---

### 2. Settings Endpoints Lack Admin Authorization

| | |
|---|---|
| **File** | `backend/server.py:1981, 2014, 2028` |
| **Risk** | Any authenticated user can read and overwrite all settings, including secrets |

`POST /api/settings`, `GET /api/settings`, and `GET /api/settings/{key}` use `Depends(get_current_user)` instead of `Depends(require_admin)`. An agent-role user can:

- Read all CRM secrets (API keys, OAuth client secrets, passwords) stored in the settings table.
- Overwrite `JWT_SECRET`, `CRM_*`, `QOS_ENABLED`, or any other setting.

**Fix:** Change to `Depends(require_admin)` on all three endpoints.

---

### 3. QoS and CRM Config Endpoints Lack Admin Authorization

| | |
|---|---|
| **File** | `backend/server.py:1690, 1716, 1640, 1742` |
| **Risk** | Any authenticated user can toggle QoS (runs sudo commands) and read/write CRM credentials |

Affected endpoints:

- `POST /api/qos/enable` — executes `sudo asterisk -rx 'dialplan reload'`
- `POST /api/qos/disable` — same
- `GET /api/crm/config` — returns CRM credentials (masked, but combined with #2 gives cleartext)
- `POST /api/crm/config` — overwrites CRM integration settings

**Fix:** Change to `Depends(require_admin)` on all four endpoints.

---

### 4. Database User Granted Superuser Privileges

| | |
|---|---|
| **File** | `install.sh:388, 391, 394, 442, 445` |
| **Risk** | Application DB user can read, write, or drop every database on the server |

```sql
GRANT ALL PRIVILEGES ON *.* TO 'OpDesk'@'localhost' WITH GRANT OPTION;
```

The OpDesk user only needs access to `asterisk`, `asteriskcdrdb`, and `OpDesk`.

**Fix:**

```sql
GRANT SELECT ON asterisk.* TO 'OpDesk'@'localhost';
GRANT SELECT ON asteriskcdrdb.* TO 'OpDesk'@'localhost';
GRANT ALL PRIVILEGES ON OpDesk.* TO 'OpDesk'@'localhost';
```

---

### 5. CORS Wildcard with Credentials

| | |
|---|---|
| **File** | `backend/server.py:694-698` |
| **Risk** | Cross-site request forgery from any origin |

```python
allow_origins=["*"],
allow_credentials=True,
```

Any website can make credentialed cross-origin requests to the OpDesk API.

**Fix:** Restrict `allow_origins` to the actual frontend origin (e.g., `https://<server-ip>:8443`), or at minimum remove `allow_credentials=True` when using the wildcard.

---

### 6. Install Script Prints Secrets to Terminal

| | |
|---|---|
| **File** | `install.sh:665, 673` |
| **Risk** | Credentials in terminal scrollback, systemd journal, CI logs |

```bash
echo -e "  Password:      $DB_PASS"
echo -e "  Secret:        $AMI_SECRET"
```

**Fix:** Mask the output or write credentials to a protected file instead of stdout.

---

### 7. No Brute-Force Protection on Login

| | |
|---|---|
| **File** | `backend/server.py:788` |
| **Risk** | Unlimited password guessing |

`POST /api/auth/login` has no rate limiting, account lockout, or progressive delay. An attacker can attempt unlimited passwords.

**Fix:** Add rate limiting (e.g., `slowapi` or a simple in-memory counter) and optional account lockout after N failures.

---

## High Security

### 8. `serve_frontend` Path Traversal

| | |
|---|---|
| **File** | `backend/server.py:2054-2056` |
| **Risk** | Arbitrary file read from the server |

```python
file_path = os.path.join(frontend_path, full_path)
if os.path.exists(file_path) and os.path.isfile(file_path):
    return FileResponse(file_path)
```

Unlike the recording endpoint (which validates the resolved path stays within a root directory), this has no containment check.

**Fix:** Add a path containment check:

```python
resolved = os.path.realpath(file_path)
if not resolved.startswith(os.path.realpath(frontend_path)):
    raise HTTPException(status_code=403)
```

---

### 9. Recording Endpoint Symlink Bypass

| | |
|---|---|
| **File** | `backend/server.py:1951-1959` |
| **Risk** | File read outside recording directory via symlinks |

`os.path.normpath` is used but not `os.path.realpath`. A symlink inside the recording directory pointing to `/etc/passwd` or `.env` would pass the containment check.

**Fix:** Use `os.path.realpath()` to resolve symlinks before the directory check.

---

### 10. SIP Extension Secret Returned via API

| | |
|---|---|
| **File** | `backend/server.py:836-838` |
| **Risk** | Compromised JWT grants SIP registration ability |

`GET /api/webrtc/config` returns the raw SIP extension secret (`extension_secret`). A stolen JWT token immediately yields SIP credentials for the user's extension.

**Fix:** Consider returning a short-lived SIP token or requiring re-authentication before revealing the secret.

---

## Bugs

### 11. `get_extension_secret_from_db` — `UnboundLocalError`

| | |
|---|---|
| **File** | `backend/db_manager.py:153-174` |
| **Impact** | Server crash (500) when querying a non-existent extension or on DB failure |

If the database connection fails at the outer `try`, or the inner query returns no rows / raises an exception, the variable `secret` is never assigned — but `return secret` on line 174 executes unconditionally.

```python
def get_extension_secret_from_db(extension):
    config = get_db_config(...)
    try:
        conn = mysql.connector.connect(**config)
        cursor = conn.cursor(dictionary=True)
        try:
            cursor.execute("SELECT data FROM sip WHERE id = %s and keyword = 'secret'", (extension,))
            secret = cursor.fetchall()       # only assigned here
            secret = secret[0]['data']        # IndexError if empty
        except Error as e:
            log.debug(...)
            # 'secret' never assigned
        cursor.close()
        conn.close()
    except Error as e:
        log.warning(...)
        # 'secret' never assigned
    return secret  # UnboundLocalError
```

**Fix:** Initialize `secret = None` at the top of the function.

---

### 12. `update_user` WHERE Clause Uses `OR` — Updates Wrong Users

| | |
|---|---|
| **File** | `backend/db_manager.py:1109` |
| **Impact** | Unintended user records modified |

```python
cursor.execute(
    "UPDATE users SET " + ", ".join(updates) + " WHERE " + " OR ".join(where_clauses),
    tuple(params),
)
```

When both `user_id` and `extension` are provided, the WHERE becomes `WHERE id = %s OR extension = %s`. If another user shares the same extension value, they get updated too.

**Fix:** Use `AND` instead of `OR`, or always prefer `id` when available:

```python
if user_id is not None:
    cursor.execute("UPDATE users SET ... WHERE id = %s", ...)
```

---

### 13. `_meaningful` Blocks Valid Extensions Starting with '5'

| | |
|---|---|
| **File** | `backend/ami.py:107-108` |
| **Impact** | Extensions 5000-5999 are silently ignored in call tracking |

```python
if len(v) == 4 and v.startswith('5'):   # dialplan priority artefact
    return False
```

This filter was intended to suppress Asterisk dialplan priority artifacts but incorrectly blocks all 4-digit extensions in the 5xxx range, which are common in PBX deployments.

**Fix:** Use a more precise check, e.g., exclude only known dialplan priority values or check against the monitored extensions set.

---

### 14. SQL LIMIT via f-string Instead of Parameter

| | |
|---|---|
| **File** | `backend/db_manager.py:461` |
| **Impact** | Low-risk SQL injection (input is validated as int, but pattern is fragile) |

```python
query += f" LIMIT {limit}"
```

All other query values use parameterized `%s`. This one uses string interpolation.

**Fix:**

```python
query += " LIMIT %s"
params.append(limit)
```

---

### 15. `get_recording_path` Full Directory Scan

| | |
|---|---|
| **File** | `backend/call_log.py:98-105` |
| **Impact** | Call log endpoint extremely slow with large recording archives |

```python
def get_recording_path(file_wav):
    root_dir = Path(os.getenv('ASTERISK_RECORDING_ROOT_DIR', ...))
    for path in root_dir.glob('**/*'):
        if path.is_file():
            if str(file_wav) in cont:
                return path
    return None
```

Every recording lookup iterates the entire directory tree. With thousands of recordings, this makes each call log request take seconds.

**Fix:** Use a direct path construction or an indexed lookup instead of full glob traversal.

---

### 16. `datetime.utcnow()` Deprecated

| | |
|---|---|
| **File** | `backend/server.py:719` |
| **Impact** | Deprecation warning in Python 3.12+; potential timezone bugs |

```python
"exp": datetime.utcnow() + timedelta(hours=JWT_EXPIRE_HOURS),
"iat": datetime.utcnow(),
```

**Fix:**

```python
from datetime import timezone
"exp": datetime.now(timezone.utc) + timedelta(hours=JWT_EXPIRE_HOURS),
"iat": datetime.now(timezone.utc),
```

---

## Availability

### 17. No AMI Reconnection Logic

| | |
|---|---|
| **File** | `backend/ami.py`, `backend/server.py:631-669` |
| **Impact** | Permanent disconnection after any Asterisk restart or network blip |

If the AMI TCP connection drops, `monitor.connected` becomes `False` and stays that way. All WebSocket clients receive "Not connected to AMI" until the entire OpDesk service is restarted.

**Fix:** Add an auto-reconnect loop with exponential backoff (e.g., retry every 5s, 10s, 20s, ... up to 60s).

---

### 18. No Database Connection Pooling

| | |
|---|---|
| **File** | `backend/db_manager.py` (all functions) |
| **Impact** | Connection exhaustion under load |

Every database function opens a new MySQL connection and closes it immediately. Under concurrent requests this creates connection storms and can hit MySQL's `max_connections` limit.

**Fix:** Use `mysql.connector.pooling.MySQLConnectionPool` or switch to an async driver with built-in pooling.

---

### 19. Unbounded Event Queue

| | |
|---|---|
| **File** | `backend/server.py:184` |
| **Impact** | Memory exhaustion during event bursts |

```python
self._state_queue: asyncio.Queue = asyncio.Queue()
```

No `maxsize` is set. During high call volume, the queue grows without limit.

**Fix:** Set a reasonable `maxsize` (e.g., `asyncio.Queue(maxsize=1000)`) and drop stale events when full.

---

### 20. Frontend Rebuild on Every Production Start

| | |
|---|---|
| **File** | `start.sh:48` |
| **Impact** | Slow service recovery; build failure blocks startup |

```bash
npm run build || { echo -e "${RED}Error: Frontend build failed${NC}"; exit 1; }
```

Every service start (including crash recovery) runs a full webpack build. If node_modules is stale or npm has issues, the service cannot start at all.

**Fix:** Build during install/update only. In `start.sh` production mode, only serve the existing `dist/` directory.

---

### 21. No Unauthenticated Health Check

| | |
|---|---|
| **File** | `backend/server.py` |
| **Impact** | Load balancers and monitoring tools cannot verify service health |

`/api/status` requires JWT authentication. There is no public health endpoint.

**Fix:** Add a simple unauthenticated `GET /health` that returns `{"status": "ok"}` and AMI connection state.

---

## Summary

| Priority | Count | Key Items |
|----------|-------|-----------|
| **Critical** | 7 | JWT secret, settings/QoS/CRM auth bypass, DB privileges, CORS, credential leaks, brute-force |
| **High** | 3 | Path traversal, symlink bypass, SIP secret exposure |
| **Bugs** | 6 | UnboundLocalError, wrong-user UPDATE, extension filter, SQL injection, slow search, deprecated API |
| **Availability** | 5 | No AMI reconnect, no connection pool, unbounded queue, rebuild on start, no health check |

### Most Urgent

1. **#2 + #1 combined**: Any user can read all secrets via `GET /api/settings`, and with the known JWT secret an attacker needs zero valid credentials.
2. **#4**: The DB user can drop every database on the server.
3. **#11**: `UnboundLocalError` crashes the server on any WebRTC config request for an extension without a SIP secret.
