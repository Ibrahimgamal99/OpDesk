#!/usr/bin/env python3
"""
List all Asterisk/FreePBX users from the database.

Configuration (via .env):
    DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME
"""

import logging
import os
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

def get_call_log_from_db(limit: int = None, date: str = None,
                         date_from: str = None, date_to: str = None) -> list:
    """
    Get call log data from the database.
    
    Args:
        limit: Maximum number of records to return (optional)
        date: Filter by exact date in format 'YYYY-MM-DD' (optional, legacy)
        date_from: Filter from this date inclusive, format 'YYYY-MM-DD' (optional)
        date_to: Filter up to this date inclusive, format 'YYYY-MM-DD' (optional)
    
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


def check_database_exists(db_name: str) -> bool:
    """Check if a database exists."""
    config_no_db = get_db_config(os.getenv('DB_PASSWORD'),'AOP').copy()
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
    config_no_db = get_db_config(os.getenv('DB_PASSWORD'),'AOP').copy()
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
                    # Skip USE statement - we'll connect to the database directly after creation
                    if statement.upper().strip().startswith('USE '):
                        continue
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
    """Check if AOP database exists, and if not, create it from schema.sql."""
    # Check if AOP database exists
    if check_database_exists('AOP'):
        log.info("✅ AOP database already exists")
        # Verify table exists, create if missing
        try:
            config = get_db_config(os.getenv('DB_PASSWORD'),'AOP')
            conn = mysql.connector.connect(**config)
            cursor = conn.cursor()
            cursor.execute("SHOW TABLES LIKE 'aop_settings'")
            if not cursor.fetchone():
                log.info("📋 Creating aop_settings table...")
                cursor.execute("""
                    CREATE TABLE IF NOT EXISTS aop_settings (
                        setting_key VARCHAR(255) PRIMARY KEY,
                        setting_value TEXT,
                        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
                    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
                """)
                conn.commit()
                log.info("✅ aop_settings table created")
            cursor.close()
            conn.close()
        except Error as e:
            log.warning(f"⚠️  Error checking/creating table: {e}")
        return True
    
    # Database doesn't exist, create it from schema.sql
    log.info("📋 AOP database not found. Creating from schema.sql...")
    
    # Get path to schema.sql file
    schema_path = os.path.join(os.path.dirname(__file__), 'schema.sql')
    
    if not os.path.exists(schema_path):
        log.error(f"❌ Schema file not found: {schema_path}")
        return False
    
    # Execute schema.sql to create database and tables
    if execute_sql_file(schema_path):
        # After creating database, connect to it and create table
        try:
            config = get_db_config(os.getenv('DB_PASSWORD'),'AOP')
            conn = mysql.connector.connect(**config)
            cursor = conn.cursor()
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS aop_settings (
                    setting_key VARCHAR(255) PRIMARY KEY,
                    setting_value TEXT,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
            """)
            conn.commit()
            cursor.close()
            conn.close()
            log.info("✅ AOP database and tables created successfully from schema.sql")
            return True
        except Error as e:
            log.error(f"❌ Failed to create table after database creation: {e}")
            return False
    else:
        log.error("❌ Failed to create AOP database from schema.sql")
        return False


def get_setting(key: str, default: str = None) -> str:
    """
    Get a setting value from the AOP database.
    
    Args:
        key: Setting key name
        default: Default value if setting doesn't exist
    
    Returns:
        Setting value or default
    """
    config = get_db_config(os.getenv('DB_PASSWORD'),'AOP')
    
    try:
        conn = mysql.connector.connect(**config)
        cursor = conn.cursor(dictionary=True)
        
        cursor.execute("SELECT setting_value FROM aop_settings WHERE setting_key = %s", (key,))
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
    Set a setting value in the AOP database.
    
    Args:
        key: Setting key name
        value: Setting value
    
    Returns:
        True if successful, False otherwise
    """
    config = get_db_config(os.getenv('DB_PASSWORD', ''),'AOP')
    
    try:
        # Ensure database and table exist
        init_settings_table()
        
        conn = mysql.connector.connect(**config)
        cursor = conn.cursor()
        
        cursor.execute("""
            INSERT INTO aop_settings (setting_key, setting_value)
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
    Get all settings from the AOP database.
    
    Returns:
        Dictionary of all settings
    """
    config = get_db_config(os.getenv('DB_PASSWORD', ''),'AOP')
    settings = {}
    
    try:
        conn = mysql.connector.connect(**config)
        cursor = conn.cursor(dictionary=True)
        
        cursor.execute("SELECT setting_key, setting_value FROM aop_settings")
        results = cursor.fetchall()
        
        for row in results:
            settings[row['setting_key']] = row['setting_value']
        
        cursor.close()
        conn.close()
        
    except Error as e:
        log.warning(f"⚠️  Database error getting all settings: {e}")
    
    return settings
