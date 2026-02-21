#!/usr/bin/env python3
"""
List all Asterisk/FreePBX users from the database.

Configuration (via .env):
    DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME
"""

import logging
import os
from typing import Optional, List
from dotenv import load_dotenv

load_dotenv()
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
log = logging.getLogger(__name__)

try:
    import mysql.connector
    from mysql.connector import Error
except ImportError:
    log.error("❌ mysql-connector-python not installed.")
    log.error("   Run: pip install mysql-connector-python")
    exit(1)


def get_db_config(password,database):
    """Get database configuration from environment variables."""
    return {
        'host': os.getenv('DB_HOST', 'localhost'),
        'port': int(os.getenv('DB_PORT', '3306')),
        'user': os.getenv('DB_USER', 'root'),
        'password':password,
        'database': database
    }



def get_extensions_from_db() -> list:
    """Get list of extension numbers from the database."""
    config = get_db_config(os.getenv('DB_PASSWORD', ''),os.getenv('DB_NAME', 'asterisk'))
    extensions = []

    try:
        conn = mysql.connector.connect(**config)
        cursor = conn.cursor(dictionary=True)

        # Try FreePBX users table first
        try:
            cursor.execute("SELECT extension FROM users ORDER BY extension")
            users = cursor.fetchall()
            extensions = [str(u['extension']) for u in users if u['extension']]
        except Error:
            pass

        # If no extensions found, try PJSIP endpoints
        if not extensions:
            try:
                cursor.execute("SELECT id FROM ps_endpoints WHERE id REGEXP '^[0-9]+$' ORDER BY CAST(id AS UNSIGNED)")
                endpoints = cursor.fetchall()
                extensions = [str(e['id']) for e in endpoints if e['id']]
            except Error:
                pass

        cursor.close()
        conn.close()

    except Error as e:
        log.warning(f"⚠️  Database error getting extensions: {e}")

    return extensions

def get_extension_names_from_db() -> dict:
    """Get extension names mapping (extension -> name) from the database."""
    config = get_db_config(os.getenv('DB_PASSWORD', ''),os.getenv('DB_NAME', 'asterisk'))
    extension_names = {}

    try:
        conn = mysql.connector.connect(**config)
        cursor = conn.cursor(dictionary=True)

        # Try FreePBX users table first (name field)
        try:
            cursor.execute("SELECT extension, name FROM users WHERE extension IS NOT NULL ORDER BY extension")
            users = cursor.fetchall()
            for u in users:
                if u['extension']:
                    ext = str(u['extension'])
                    name = u.get('name', '') or ''
                    if name:
                        extension_names[ext] = name
        except Error as e:
            log.debug(f"Could not get names from users table: {e}")

        # If no names found, try PJSIP endpoints (description field)
        if not extension_names:
            try:
                cursor.execute("SELECT id, description FROM ps_endpoints WHERE id REGEXP '^[0-9]+$' ORDER BY CAST(id AS UNSIGNED)")
                endpoints = cursor.fetchall()
                for e in endpoints:
                    if e['id']:
                        ext = str(e['id'])
                        name = e.get('description', '') or ''
                        if name:
                            extension_names[ext] = name
            except Error as e:
                log.debug(f"Could not get names from ps_endpoints table: {e}")

        cursor.close()
        conn.close()

    except Error as e:
        log.warning(f"⚠️  Database error getting extension names: {e}")

    return extension_names

def get_call_log_from_db(limit: int = None, date: str = None,
                         date_from: str = None, date_to: str = None,
                         allowed_extensions: Optional[List[str]] = None) -> list:
    """
    Get call log data from the database.
    
    Args:
        limit: Maximum number of records to return (optional)
        date: Filter by exact date in format 'YYYY-MM-DD' (optional, legacy)
        date_from: Filter from this date inclusive, format 'YYYY-MM-DD' (optional)
        date_to: Filter up to this date inclusive, format 'YYYY-MM-DD' (optional)
        allowed_extensions: If set, only return calls where destination agent (from dstchannel) is in this list.
    
    Returns:
        List of CDR records as dictionaries
    """
    config = get_db_config(os.getenv('DB_PASSWORD', ''),os.getenv('DB_CDR', ''))
    data = []

    try:
        conn = mysql.connector.connect(**config)
        cursor = conn.cursor(dictionary=True)

        # Build the base query
        query = """
            SELECT 
                c.calldate, c.src, c.dst, c.dcontext, c.channel,
                c.dstchannel, c.lastapp, c.duration, c.billsec,
                c.disposition, c.recordingfile,
                c.cnam, c.linkedid, c.userfield
            FROM cdr c
            JOIN (
                SELECT linkedid, MAX(sequence) AS max_seq
                FROM cdr
                GROUP BY linkedid
            ) x
              ON c.linkedid = x.linkedid
             AND c.sequence = x.max_seq
        """
        
        # Build WHERE conditions
        conditions = []
        params = []
        
        if date:
            conditions.append("DATE(c.calldate) = %s")
            params.append(date)
        if date_from:
            conditions.append("DATE(c.calldate) >= %s")
            params.append(date_from)
        if date_to:
            conditions.append("DATE(c.calldate) <= %s")
            params.append(date_to)
        # Filter by agent extension (from dstchannel: part after '/' and before '-', e.g. SIP/1001-xxx -> 1001)
        if allowed_extensions is not None:
            if not allowed_extensions:
                conditions.append("1 = 0")
            else:
                placeholders = ", ".join(["%s"] * len(allowed_extensions))
                conditions.append(
                    "SUBSTRING_INDEX(SUBSTRING_INDEX(c.dstchannel, '-', 1), '/', -1) IN (" + placeholders + ")"
                )
                params.extend(allowed_extensions)
        
        if conditions:
            query += " WHERE " + " AND ".join(conditions)
        
        # Add ordering by calldate (most recent first)
        query += " ORDER BY c.calldate DESC"
        
        # Add limit if provided (validate it's a positive integer)
        if limit:
            if not isinstance(limit, int) or limit <= 0:
                raise ValueError("limit must be a positive integer")
            query += f" LIMIT {limit}"

        # Execute query with parameters
        cursor.execute(query, tuple(params) if params else None)
        
        data = cursor.fetchall()

        cursor.close()
        conn.close()

    except Error as e:
        log.warning(f"⚠️  Database error getting call log: {e}")

    return data


def get_call_log_count_from_db(date: str = None,
                                date_from: str = None, date_to: str = None,
                                allowed_extensions: Optional[List[str]] = None) -> int:
    """
    Get total count of call log rows with the same filters as get_call_log_from_db
    (same JOIN/WHERE, no limit). Used so UI can show total calls beyond the fetch limit.
    """
    config = get_db_config(os.getenv('DB_PASSWORD', ''), os.getenv('DB_CDR', ''))
    try:
        conn = mysql.connector.connect(**config)
        cursor = conn.cursor(dictionary=True)

        query = """
            SELECT COUNT(*) AS cnt
            FROM cdr c
            JOIN (
                SELECT linkedid, MAX(sequence) AS max_seq
                FROM cdr
                GROUP BY linkedid
            ) x
              ON c.linkedid = x.linkedid
             AND c.sequence = x.max_seq
        """
        conditions = []
        params = []
        if date:
            conditions.append("DATE(c.calldate) = %s")
            params.append(date)
        if date_from:
            conditions.append("DATE(c.calldate) >= %s")
            params.append(date_from)
        if date_to:
            conditions.append("DATE(c.calldate) <= %s")
            params.append(date_to)
        if allowed_extensions is not None:
            if not allowed_extensions:
                conditions.append("1 = 0")
            else:
                placeholders = ", ".join(["%s"] * len(allowed_extensions))
                conditions.append(
                    "SUBSTRING_INDEX(SUBSTRING_INDEX(c.dstchannel, '-', 1), '/', -1) IN (" + placeholders + ")"
                )
                params.extend(allowed_extensions)
        if conditions:
            query += " WHERE " + " AND ".join(conditions)

        cursor.execute(query, tuple(params) if params else None)
        row = cursor.fetchone()
        cursor.close()
        conn.close()
        return (row or {}).get("cnt", 0) or 0
    except Error as e:
        log.warning(f"⚠️  Database error getting call log count: {e}")
        return 0


def check_database_exists(db_name: str) -> bool:
    """Check if a database exists."""
    config_no_db = get_db_config(os.getenv('DB_PASSWORD'),'OpDesk').copy()
    config_no_db.pop('database')
    
    try:
        conn = mysql.connector.connect(**config_no_db)
        cursor = conn.cursor()
        cursor.execute("SHOW DATABASES LIKE %s", (db_name,))
        result = cursor.fetchone()
        cursor.close()
        conn.close()
        return result is not None
    except Error as e:
        log.error(f"❌ Failed to check if database exists: {e}")
        return False


def execute_sql_file(sql_file_path: str) -> bool:
    """Execute SQL commands from a file."""
    config_no_db = get_db_config(os.getenv('DB_PASSWORD'),'OpDesk').copy()
    config_no_db.pop('database')
    
    try:
        # Read SQL file
        with open(sql_file_path, 'r', encoding='utf-8') as f:
            sql_content = f.read()
        
        # Connect without database specified
        conn = mysql.connector.connect(**config_no_db)
        cursor = conn.cursor()
        
        # Split SQL content by semicolons and execute each statement
        # Filter out empty statements, comments, and blank lines
        statements = []
        for line in sql_content.split('\n'):
            line = line.strip()
            # Skip empty lines and full-line comments
            if not line or line.startswith('--'):
                continue
            statements.append(line)
        
        # Join statements and split by semicolon
        full_sql = ' '.join(statements)
        sql_statements = [s.strip() for s in full_sql.split(';') if s.strip()]
        
        for statement in sql_statements:
            if statement:
                try:
                    cursor.execute(statement)
                except Error as e:
                    log.warning(f"⚠️  SQL execution warning for statement '{statement[:50]}...': {e}")
        
        conn.commit()
        cursor.close()
        conn.close()
        
        return True
        
    except FileNotFoundError:
        log.error(f"❌ SQL file not found: {sql_file_path}")
        return False
    except Error as e:
        log.error(f"❌ Failed to execute SQL file: {e}")
        return False
    except Exception as e:
        log.error(f"❌ Unexpected error executing SQL file: {e}")
        return False


def init_settings_table():
    """Check if OpDesk database exists, and if not, create it from schema.sql."""
    # Check if OpDesk database exists
    if check_database_exists('OpDesk'):
        log.info("✅ OpDesk database already exists")
        # Verify table exists, create if missing
        try:
            config = get_db_config(os.getenv('DB_PASSWORD'),'OpDesk')
            conn = mysql.connector.connect(**config)
            cursor = conn.cursor()
            cursor.execute("SHOW TABLES LIKE 'OpDesk_settings'")
            if not cursor.fetchone():
                log.info("📋 Creating OpDesk_settings table...")
                cursor.execute("""
                    CREATE TABLE IF NOT EXISTS OpDesk_settings (
                        setting_key VARCHAR(255) PRIMARY KEY,
                        setting_value TEXT,
                        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
                    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
                """)
                conn.commit()
                log.info("✅ OpDesk_settings table created")
            cursor.close()
            conn.close()
        except Error as e:
            log.warning(f"⚠️  Error checking/creating table: {e}")
        return True
    
    # Database doesn't exist, create it from schema.sql
    log.info("📋 OpDesk database not found. Creating from schema.sql...")
    
    # Get path to schema.sql file
    schema_path = os.path.join(os.path.dirname(__file__), 'schema.sql')
    
    if not os.path.exists(schema_path):
        log.error(f"❌ Schema file not found: {schema_path}")
        return False
    
    # Execute schema.sql to create database and tables
    if execute_sql_file(schema_path):
        # After creating database, connect to it and create table
        try:
            config = get_db_config(os.getenv('DB_PASSWORD'),'OpDesk')
            conn = mysql.connector.connect(**config)
            cursor = conn.cursor()
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS OpDesk_settings (
                    setting_key VARCHAR(255) PRIMARY KEY,
                    setting_value TEXT,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
            """)
            conn.commit()
            cursor.close()
            conn.close()
            log.info("✅ OpDesk database and tables created successfully from schema.sql")
            return True
        except Error as e:
            log.error(f"❌ Failed to create table after database creation: {e}")
            return False
    else:
        log.error("❌ Failed to create OpDesk database from schema.sql")
        return False


def get_setting(key: str, default: str = None) -> str:
    """
    Get a setting value from the OpDesk database.
    
    Args:
        key: Setting key name
        default: Default value if setting doesn't exist
    
    Returns:
        Setting value or default
    """
    config = get_db_config(os.getenv('DB_PASSWORD'),'OpDesk')
    
    try:
        conn = mysql.connector.connect(**config)
        cursor = conn.cursor(dictionary=True)
        
        cursor.execute("SELECT setting_value FROM OpDesk_settings WHERE setting_key = %s", (key,))
        result = cursor.fetchone()
        
        cursor.close()
        conn.close()
        
        if result:
            return result['setting_value'] or default
        return default
        
    except Error as e:
        log.warning(f"⚠️  Database error getting setting {key}: {e}")
        return default


def set_setting(key: str, value: str) -> bool:
    """
    Set a setting value in the OpDesk database.
    
    Args:
        key: Setting key name
        value: Setting value
    
    Returns:
        True if successful, False otherwise
    """
    config = get_db_config(os.getenv('DB_PASSWORD', ''),'OpDesk')
    
    try:
        # Ensure database and table exist
        init_settings_table()
        
        conn = mysql.connector.connect(**config)
        cursor = conn.cursor()
        
        cursor.execute("""
            INSERT INTO OpDesk_settings (setting_key, setting_value)
            VALUES (%s, %s)
            ON DUPLICATE KEY UPDATE setting_value = %s, updated_at = CURRENT_TIMESTAMP
        """, (key, value, value))
        
        conn.commit()
        cursor.close()
        conn.close()
        
        return True
        
    except Error as e:
        log.error(f"❌ Failed to set setting {key}: {e}")
        return False


def get_all_settings() -> dict:
    """
    Get all settings from the OpDesk database.

    Returns:
        Dictionary of all settings
    """
    config = get_db_config(os.getenv('DB_PASSWORD', ''),'OpDesk')
    settings = {}

    try:
        conn = mysql.connector.connect(**config)
        cursor = conn.cursor(dictionary=True)

        cursor.execute("SELECT setting_key, setting_value FROM OpDesk_settings")
        results = cursor.fetchall()

        for row in results:
            settings[row['setting_key']] = row['setting_value']

        cursor.close()
        conn.close()

    except Error as e:
        log.warning(f"⚠️  Database error getting all settings: {e}")

    return settings


# ---------------------------------------------------------------------------
# Authentication (users table in OpDesk)
# ---------------------------------------------------------------------------

def ensure_users_extension_column():
    """Add extension column to users table if missing (migration for existing DBs)."""
    config = get_db_config(os.getenv('DB_PASSWORD', ''), 'OpDesk')
    try:
        conn = mysql.connector.connect(**config)
        cursor = conn.cursor()
        cursor.execute("""
            ALTER TABLE users
            ADD COLUMN extension VARCHAR(20) UNIQUE NULL AFTER username
        """)
        conn.commit()
        cursor.close()
        conn.close()
        log.info("Added extension column to users table")
    except Error as e:
        if "Duplicate column name" in str(e):
            pass  # Column already exists
        else:
            log.warning(f"⚠️  Migration users.extension: {e}")
    except Exception as e:
        log.warning(f"⚠️  Migration users.extension: {e}")


def get_user_by_username(username: str) -> dict:
    """Get user by username. Returns dict with id, username, extension, name, role, password_hash, is_active or None."""
    config = get_db_config(os.getenv('DB_PASSWORD', ''), 'OpDesk')
    try:
        conn = mysql.connector.connect(**config)
        cursor = conn.cursor(dictionary=True)
        cursor.execute(
            "SELECT id, username, extension, name, role, password_hash, is_active FROM users WHERE username = %s",
            (username,)
        )
        row = cursor.fetchone()
        cursor.close()
        conn.close()
        return row
    except Error as e:
        log.warning(f"⚠️  Database error get_user_by_username: {e}")
        return None


def get_user_by_extension(extension: str) -> dict:
    """Get user by extension. Returns dict with id, username, extension, name, role, password_hash, is_active or None."""
    if not extension or not str(extension).strip():
        return None
    config = get_db_config(os.getenv('DB_PASSWORD', ''), 'OpDesk')
    try:
        conn = mysql.connector.connect(**config)
        cursor = conn.cursor(dictionary=True)
        cursor.execute(
            "SELECT id, username, extension, name, role, password_hash, is_active FROM users WHERE extension = %s",
            (str(extension).strip(),)
        )
        row = cursor.fetchone()
        cursor.close()
        conn.close()
        return row
    except Error as e:
        log.warning(f"⚠️  Database error get_user_by_extension: {e}")
        return None


def verify_user_password(password_hash: str, password: str) -> bool:
    """Verify plain password against bcrypt hash."""
    if not password_hash or not password:
        return False
    try:
        import bcrypt
        return bcrypt.checkpw(password.encode('utf-8'), password_hash.encode('utf-8'))
    except Exception as e:
        log.debug(f"Password verify failed: {e}")
        return False


def update_last_login(user_id: int) -> None:
    """Update last_login_at for user."""
    config = get_db_config(os.getenv('DB_PASSWORD', ''), 'OpDesk')
    try:
        conn = mysql.connector.connect(**config)
        cursor = conn.cursor()
        cursor.execute("UPDATE users SET last_login_at = NOW() WHERE id = %s", (user_id,))
        conn.commit()
        cursor.close()
        conn.close()
    except Error as e:
        log.warning(f"⚠️  Database error update_last_login: {e}")


def authenticate_user(login: str, password: str) -> dict:
    """
    Authenticate by username or extension and password.
    login: username or extension (string).
    Returns user dict (id, username, extension, name, role, no password_hash) or None.
    """
    if not login or not password:
        return None
    login = str(login).strip()
    user = get_user_by_username(login)
    if not user:
        user = get_user_by_extension(login)
    if not user:
        return None
    if not user.get('is_active', 1):
        return None
    if not verify_user_password(user.get('password_hash') or '', password):
        return None
    update_last_login(user['id'])
    return {
        'id': user['id'],
        'username': user['username'],
        'extension': user.get('extension'),
        'name': user.get('name'),
        'role': user['role'],
    }


# ---------------------------------------------------------------------------
# User management (admin): list, create, update, delete, agents/queues
# ---------------------------------------------------------------------------

def get_all_users() -> list:
    """Get all users (id, username, extension, name, role, is_active, monitor_modes). No password_hash."""
    config = get_db_config(os.getenv('DB_PASSWORD', ''), 'OpDesk')
    try:
        conn = mysql.connector.connect(**config)
        cursor = conn.cursor(dictionary=True)
        cursor.execute(
            "SELECT id, username, extension, name, role, is_active FROM users ORDER BY username"
        )
        rows = cursor.fetchall()
        cursor.close()
        conn.close()
        out = []
        for r in rows:
            d = dict(r)
            d['monitor_modes'] = get_user_monitor_modes(d['id'])
            out.append(d)
        return out
    except Error as e:
        log.warning(f"⚠️  Database error get_all_users: {e}")
        return []


def create_user(username: str, password: str, name: str = None, extension: str = None,
                role: str = 'supervisor', monitor_mode: str = 'listen',
                monitor_modes: list = None) -> Optional[int]:
    """Create user. Returns new user id or None on error/duplicate. monitor_modes: optional list ['listen','whisper','barge']."""
    if not username or not username.strip():
        return None
    username = username.strip()
    if get_user_by_username(username):
        return None
    if extension is not None and str(extension).strip():
        ext = str(extension).strip()
        if get_user_by_extension(ext):
            return None
    try:
        import bcrypt
        password_hash = bcrypt.hashpw((password or '').encode('utf-8'), bcrypt.gensalt()).decode('utf-8')
    except Exception as e:
        log.warning(f"Password hash failed: {e}")
        return None
    config = get_db_config(os.getenv('DB_PASSWORD', ''), 'OpDesk')
    try:
        conn = mysql.connector.connect(**config)
        cursor = conn.cursor()
        cursor.execute(
            "INSERT INTO users (username, extension, password_hash, name, role) "
            "VALUES (%s, %s, %s, %s, %s)",
            (username, (extension or '').strip() or None, password_hash, (name or '').strip() or None,
             role if role in ('admin', 'supervisor') else 'supervisor')
        )
        user_id = cursor.lastrowid
        conn.commit()
        cursor.close()
        conn.close()
        if monitor_modes is not None:
            set_user_monitor_modes(user_id, monitor_modes)
        else:
            mode_col = monitor_mode or 'listen'
            set_user_monitor_modes(user_id, list(VALID_MONITOR_MODES) if mode_col == 'full' else [mode_col])
        return user_id
    except Error as e:
        log.warning(f"⚠️  Database error create_user: {e}")
        return None


def update_user(user_id: int, name: str = None, extension: str = None, role: str = None,
                is_active: bool = None, monitor_mode: str = None, monitor_modes: list = None,
                password: str = None) -> bool:
    """Update user. password optional (new hash). monitor_modes: optional list to set multiple modes. Returns True on success."""
    config = get_db_config(os.getenv('DB_PASSWORD', ''), 'OpDesk')
    try:
        conn = mysql.connector.connect(**config)
        cursor = conn.cursor(dictionary=True)
        cursor.execute("SELECT id FROM users WHERE id = %s", (user_id,))
        if not cursor.fetchone():
            cursor.close()
            conn.close()
            return False
        updates = []
        params = []
        if name is not None:
            updates.append("name = %s")
            params.append((name or '').strip() or None)
        if extension is not None:
            updates.append("extension = %s")
            params.append((str(extension).strip() or None))
        if role is not None and role in ('admin', 'supervisor'):
            updates.append("role = %s")
            params.append(role)
        if is_active is not None:
            updates.append("is_active = %s")
            params.append(1 if is_active else 0)
        if password is not None and password:
            try:
                import bcrypt
                password_hash = bcrypt.hashpw(password.encode('utf-8'), bcrypt.gensalt()).decode('utf-8')
                updates.append("password_hash = %s")
                params.append(password_hash)
            except Exception:
                pass
        if updates:
            params.append(user_id)
            cursor.execute("UPDATE users SET " + ", ".join(updates) + " WHERE id = %s", tuple(params))
            conn.commit()
        if monitor_modes is not None:
            set_user_monitor_modes(user_id, monitor_modes)
        cursor.close()
        conn.close()
        return True
    except Error as e:
        log.warning(f"⚠️  Database error update_user: {e}")
        return False


def delete_user(user_id: int) -> bool:
    """Delete user and their group assignments and monitor modes. Returns True on success."""
    config = get_db_config(os.getenv('DB_PASSWORD', ''), 'OpDesk')
    try:
        conn = mysql.connector.connect(**config)
        cursor = conn.cursor()
        cursor.execute("DELETE FROM user_groups WHERE user_id = %s", (user_id,))
        try:
            cursor.execute("DELETE FROM user_monitor_modes WHERE user_id = %s", (user_id,))
        except Error:
            pass
        cursor.execute("DELETE FROM users WHERE id = %s", (user_id,))
        conn.commit()
        cursor.close()
        conn.close()
        return True
    except Error as e:
        log.warning(f"⚠️  Database error delete_user: {e}")
        return False


VALID_MONITOR_MODES = ('listen', 'whisper', 'barge')


def ensure_user_monitor_modes_table():
    """Create user_monitor_modes table if missing and backfill users that have no modes (by role)."""
    config = get_db_config(os.getenv('DB_PASSWORD', ''), 'OpDesk')
    try:
        conn = mysql.connector.connect(**config)
        cursor = conn.cursor()
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS user_monitor_modes (
                user_id INT NOT NULL,
                mode VARCHAR(20) NOT NULL,
                PRIMARY KEY (user_id, mode),
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
                INDEX idx_user (user_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        """)
        conn.commit()
        # Backfill: users with no rows get default modes (admin = all three, others = listen)
        cursor.execute("SELECT id, role FROM users")
        users = cursor.fetchall()
        for (uid, role) in users:
            cursor.execute("SELECT 1 FROM user_monitor_modes WHERE user_id = %s LIMIT 1", (uid,))
            if cursor.fetchone():
                continue
            modes = list(VALID_MONITOR_MODES) if role == 'admin' else ['listen']
            for m in modes:
                try:
                    cursor.execute("INSERT IGNORE INTO user_monitor_modes (user_id, mode) VALUES (%s, %s)", (uid, m))
                except Error:
                    pass
        conn.commit()
        cursor.close()
        conn.close()
    except Error as e:
        log.warning(f"⚠️  ensure_user_monitor_modes_table: {e}")


def get_user_monitor_modes(user_id: int) -> list:
    """Return list of monitor modes for user (from user_monitor_modes). Default ['listen'] if none set."""
    config = get_db_config(os.getenv('DB_PASSWORD', ''), 'OpDesk')
    try:
        conn = mysql.connector.connect(**config)
        cursor = conn.cursor(dictionary=True)
        try:
            cursor.execute("SELECT mode FROM user_monitor_modes WHERE user_id = %s ORDER BY mode", (user_id,))
            rows = cursor.fetchall()
            modes = [r['mode'] for r in rows if r.get('mode') in VALID_MONITOR_MODES]
        except Error:
            modes = []
        cursor.close()
        conn.close()
        return modes if modes else ['listen']
    except Error as e:
        log.warning(f"⚠️  Database error get_user_monitor_modes: {e}")
        return ['listen']


def set_user_monitor_modes(user_id: int, modes: list) -> bool:
    """Set monitor modes for user. modes: list of 'listen', 'whisper', 'barge'."""
    if not user_id:
        return False
    valid = [m for m in (modes or []) if m in VALID_MONITOR_MODES]
    if not valid:
        valid = ['listen']
    config = get_db_config(os.getenv('DB_PASSWORD', ''), 'OpDesk')
    try:
        conn = mysql.connector.connect(**config)
        cursor = conn.cursor()
        try:
            cursor.execute("DELETE FROM user_monitor_modes WHERE user_id = %s", (user_id,))
            for m in valid:
                cursor.execute("INSERT INTO user_monitor_modes (user_id, mode) VALUES (%s, %s)", (user_id, m))
        except Error as e:
            log.warning(f"⚠️  set_user_monitor_modes: {e}")
            cursor.close()
            conn.close()
            return False
        conn.commit()
        cursor.close()
        conn.close()
        return True
    except Error as e:
        log.warning(f"⚠️  Database error set_user_monitor_modes: {e}")
        return False


def get_user_by_id(user_id: int) -> Optional[dict]:
    """Get user by id (no password_hash). Includes monitor_modes (list)."""
    config = get_db_config(os.getenv('DB_PASSWORD', ''), 'OpDesk')
    try:
        conn = mysql.connector.connect(**config)
        cursor = conn.cursor(dictionary=True)
        cursor.execute(
            "SELECT id, username, extension, name, role, is_active FROM users WHERE id = %s",
            (user_id,)
        )
        row = cursor.fetchone()
        if not row:
            cursor.close()
            conn.close()
            return None
        row = dict(row)
        row['monitor_modes'] = get_user_monitor_modes(user_id)
        cursor.close()
        conn.close()
        return row
    except Error as e:
        log.warning(f"⚠️  Database error get_user_by_id: {e}")
        return None


def get_user_agents_and_queues(user_id: int) -> tuple:
    """Return (list of agent extensions, list of queue names) for user via their groups."""
    config = get_db_config(os.getenv('DB_PASSWORD', ''), 'OpDesk')
    agents = []
    queues = []
    try:
        conn = mysql.connector.connect(**config)
        cursor = conn.cursor(dictionary=True)
        cursor.execute("SELECT group_id FROM user_groups WHERE user_id = %s", (user_id,))
        group_ids = [r['group_id'] for r in cursor.fetchall()]
        if not group_ids:
            cursor.close()
            conn.close()
            return agents, queues
        placeholders = ",".join(["%s"] * len(group_ids))
        cursor.execute(
            "SELECT DISTINCT agent_ext FROM group_agents WHERE group_id IN (" + placeholders + ")",
            tuple(group_ids)
        )
        agents = [r['agent_ext'] for r in cursor.fetchall() if r.get('agent_ext')]
        cursor.execute(
            "SELECT q.queue_name FROM group_queues gq JOIN queues q ON gq.queue_id = q.id "
            "WHERE gq.group_id IN (" + placeholders + ")",
            tuple(group_ids)
        )
        queues = [r['queue_name'] for r in cursor.fetchall() if r.get('queue_name')]
        cursor.close()
        conn.close()
    except Error as e:
        log.warning(f"⚠️  Database error get_user_agents_and_queues: {e}")
    return agents, queues


def set_user_agents_and_queues(user_id: int, agent_extensions: list, queue_names: list) -> bool:
    """
    Set which agents (extensions) and queues a user can access.
    Uses a single group per user (name 'user_<user_id>'). Creates group if needed.
    Ensures agents and queues exist in OpDesk tables (inserts by name/extension).
    """
    if not user_id:
        return False
    config = get_db_config(os.getenv('DB_PASSWORD', ''), 'OpDesk')
    try:
        conn = mysql.connector.connect(**config)
        cursor = conn.cursor(dictionary=True)
        group_name = f"user_{user_id}"
        cursor.execute("SELECT id FROM groups WHERE name = %s", (group_name,))
        row = cursor.fetchone()
        if row:
            group_id = row['id']
        else:
            cursor.execute("INSERT INTO groups (name) VALUES (%s)", (group_name,))
            group_id = cursor.lastrowid
            conn.commit()
        cursor.execute("DELETE FROM user_groups WHERE user_id = %s", (user_id,))
        cursor.execute("INSERT INTO user_groups (user_id, group_id) VALUES (%s, %s)", (user_id, group_id))
        cursor.execute("DELETE FROM group_agents WHERE group_id = %s", (group_id,))
        cursor.execute("DELETE FROM group_queues WHERE group_id = %s", (group_id,))
        for ext in (agent_extensions or []):
            ext = str(ext).strip()
            if not ext:
                continue
            try:
                cursor.execute("INSERT IGNORE INTO agents (extension, name) VALUES (%s, %s)", (ext, ext))
                cursor.execute("INSERT INTO group_agents (group_id, agent_ext) VALUES (%s, %s)", (group_id, ext))
            except Error:
                pass
        for qname in (queue_names or []):
            qname = (qname or '').strip()
            if not qname:
                continue
            try:
                cursor.execute("INSERT INTO queues (queue_name) VALUES (%s) ON DUPLICATE KEY UPDATE queue_name = queue_name", (qname,))
                cursor.execute("SELECT id FROM queues WHERE queue_name = %s", (qname,))
                qrow = cursor.fetchone()
                if qrow:
                    cursor.execute("INSERT INTO group_queues (group_id, queue_id) VALUES (%s, %s)", (group_id, qrow['id']))
            except Error:
                pass
        conn.commit()
        cursor.close()
        conn.close()
        return True
    except Error as e:
        log.warning(f"⚠️  Database error set_user_agents_and_queues: {e}")
        return False


def get_agents_list() -> list:
    """Get list of agents from OpDesk agents table: [{ extension, name }, ...]."""
    config = get_db_config(os.getenv('DB_PASSWORD', ''), 'OpDesk')
    try:
        conn = mysql.connector.connect(**config)
        cursor = conn.cursor(dictionary=True)
        cursor.execute("SELECT extension, name FROM agents ORDER BY extension")
        rows = cursor.fetchall()
        cursor.close()
        conn.close()
        return [{"extension": r["extension"], "name": r.get("name") or r["extension"]} for r in rows]
    except Error as e:
        log.warning(f"⚠️  Database error get_agents_list: {e}")
        return []


def get_queues_list() -> list:
    """Get list of queues from OpDesk queues table: [{ id, queue_name }, ...]."""
    config = get_db_config(os.getenv('DB_PASSWORD', ''), 'OpDesk')
    try:
        conn = mysql.connector.connect(**config)
        cursor = conn.cursor(dictionary=True)
        cursor.execute("SELECT id, queue_name FROM queues ORDER BY queue_name")
        rows = cursor.fetchall()
        cursor.close()
        conn.close()
        return [{"id": r["id"], "queue_name": r["queue_name"]} for r in rows]
    except Error as e:
        log.warning(f"⚠️  Database error get_queues_list: {e}")
        return []


def sync_agents_from_extensions(extension_list: list, name_map: dict) -> None:
    """Ensure OpDesk agents table has entries for given extensions (from Asterisk/FreePBX)."""
    if not extension_list:
        return
    config = get_db_config(os.getenv('DB_PASSWORD', ''), 'OpDesk')
    try:
        conn = mysql.connector.connect(**config)
        cursor = conn.cursor()
        for ext in extension_list:
            ext = str(ext).strip()
            if not ext:
                continue
            name = (name_map or {}).get(ext) or ext
            cursor.execute("INSERT INTO agents (extension, name) VALUES (%s, %s) ON DUPLICATE KEY UPDATE name = VALUES(name)", (ext, name))
        conn.commit()
        cursor.close()
        conn.close()
    except Error as e:
        log.warning(f"⚠️  Database error sync_agents_from_extensions: {e}")


def sync_queues_from_list(queue_names: list) -> None:
    """Ensure OpDesk queues table has entries for given queue names (from Asterisk)."""
    if not queue_names:
        return
    config = get_db_config(os.getenv('DB_PASSWORD', ''), 'OpDesk')
    try:
        conn = mysql.connector.connect(**config)
        cursor = conn.cursor()
        for qname in queue_names:
            qname = (qname or '').strip()
            if not qname:
                continue
            cursor.execute("INSERT INTO queues (queue_name) VALUES (%s) ON DUPLICATE KEY UPDATE queue_name = queue_name", (qname,))
        conn.commit()
        cursor.close()
        conn.close()
    except Error as e:
        log.warning(f"⚠️  Database error sync_queues_from_list: {e}")
