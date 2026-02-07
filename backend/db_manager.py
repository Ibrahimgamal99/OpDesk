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


def get_db_config():
    """Get database configuration from environment variables."""
    return {
        'host': os.getenv('DB_HOST', 'localhost'),
        'port': int(os.getenv('DB_PORT', '3306')),
        'user': os.getenv('DB_USER', 'root'),
        'password': os.getenv('DB_PASSWORD', ''),
        'database': os.getenv('DB_NAME', 'asterisk')
    }


def get_extensions_from_db() -> list:
    """Get list of extension numbers from the database."""
    config = get_db_config()
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
if __name__ == "__main__":
    extensions = get_extensions_from_db()
    print(extensions)