import os
import mysql.connector
from mysql.connector import Error
from db_manager import get_db_config
import logging

log = logging.getLogger(__name__)

def get_extension_secret_from_db(extension):
    """Get extension secret from the database."""
    config = get_db_config(os.getenv('DB_PASSWORD', ''),os.getenv('DB_NAME', 'asterisk'))

    try:
        conn = mysql.connector.connect(**config)
        cursor = conn.cursor(dictionary=True)

        try:
            cursor.execute("SELECT data FROM sip WHERE id = %s and keyword = 'secret'", (extension,))
            secret = cursor.fetchall()
            secret = secret[0]['data']
        except Error as e:
            log.debug(f"Could not get extension secret from database: {e}")

        cursor.close()
        conn.close()

    except Error as e:
        log.warning(f"⚠️  Database error getting extension secret: {e}")

    return secret
if __name__ == "__main__":
    print(get_extension_secret_from_db('120'))