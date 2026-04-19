-- OpDesk Database Schema
-- This file contains the database schema for the Asterisk Operator Panel
--
-- MariaDB 5.5 / MySQL 5.5 compatibility notes (Sangoma 7 / CentOS 7):
--   1. VARCHAR(255) PRIMARY KEY with utf8mb4 exceeds the 767-byte InnoDB key limit
--      (255 chars × 4 bytes = 1020 bytes). Fixed by reducing to VARCHAR(191).
--   2. DATETIME DEFAULT CURRENT_TIMESTAMP is not supported before MySQL 5.6 /
--      MariaDB 10.0. Fixed by using TIMESTAMP for auto-populated columns.
--   3. SET GLOBAL event_scheduler requires SUPER privilege. Wrapped in a comment
--      with instructions to set it in my.cnf instead.

-- Create OpDesk database if it doesn't exist
CREATE DATABASE IF NOT EXISTS OpDesk CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Use OpDesk database
USE OpDesk;

-- Settings table for storing application configuration
-- FIX: VARCHAR(191) instead of VARCHAR(255) to stay within 767-byte InnoDB key
--      limit when using utf8mb4 (191 × 4 = 764 bytes < 767 bytes).
CREATE TABLE IF NOT EXISTS OpDesk_settings (
    setting_key VARCHAR(191) PRIMARY KEY,
    setting_value TEXT,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- =============================================================================
-- Authentication & Authorization
-- =============================================================================

-- User table (login by username or extension)
-- FIX: created_at / last_login_at changed from DATETIME to TIMESTAMP so that
--      DEFAULT CURRENT_TIMESTAMP works on MariaDB 5.5 / MySQL 5.5.
CREATE TABLE IF NOT EXISTS users (
    id INT PRIMARY KEY AUTO_INCREMENT,
    username VARCHAR(100) UNIQUE NOT NULL,
    extension VARCHAR(20) UNIQUE NULL,
    extension_secret VARCHAR(255),
    password_hash VARCHAR(255),
    name VARCHAR(255),
    webrtc ENUM('yes', 'no') DEFAULT 'no',
    role ENUM('admin', 'supervisor','agent') NOT NULL,
    is_active TINYINT(1) DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_login_at TIMESTAMP NULL DEFAULT NULL,

    INDEX idx_username (username),
    INDEX idx_extension (extension),
    INDEX idx_active (is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Call notifications: one row per call hangup for an extension (created in AMI _ev_Hangup).
-- UI can mark as read or archived.
-- FIX: event_time changed from DATETIME to TIMESTAMP for MariaDB 5.5 compatibility.
CREATE TABLE IF NOT EXISTS call_notifications (
    id INT PRIMARY KEY AUTO_INCREMENT,
    extension VARCHAR(20) NOT NULL,
    caller_from VARCHAR(50) NULL,
    queue VARCHAR(100) NULL,
    status_flag ENUM('new', 'read', 'archived') DEFAULT 'new',
    reason VARCHAR(255) NULL,
    event_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    call_id VARCHAR(255) NULL,
    INDEX idx_extension (extension),
    INDEX idx_status (status_flag),
    INDEX idx_event_time (event_time),
    INDEX idx_caller_from (caller_from)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Delete read call_notifications older than 7 days (runs daily via MySQL event scheduler).
-- FIX: SET GLOBAL event_scheduler requires SUPER privilege which the OpDesk DB
--      user does not have. Enable it system-wide instead by adding the following
--      line to /etc/my.cnf under [mysqld]:
--          event_scheduler = ON
--      Then restart MariaDB: systemctl restart mariadb
-- SET GLOBAL event_scheduler = ON;

DROP EVENT IF EXISTS evt_cleanup_read_call_notifications;
CREATE EVENT IF NOT EXISTS evt_cleanup_read_call_notifications
ON SCHEDULE EVERY 1 DAY
STARTS CURRENT_TIMESTAMP
DO
  DELETE FROM call_notifications
  WHERE status_flag = 'read'
    AND event_time < DATE_SUB(NOW(), INTERVAL 7 DAY);

-- Default admin user (password is bcrypt hash; use INSERT IGNORE so existing DB is not broken)
-- Monitor modes are stored in user_monitor_modes (admin gets all by backfill).
INSERT IGNORE INTO users (username, password_hash, name, role) VALUES
('admin', '$2b$12$6sibCF.6VJMs0jSrxr47U.zH4n6Ehma7lKHhbv2qwPsg7Yan89RTS', 'Admin', 'admin');

-- Agents table
CREATE TABLE IF NOT EXISTS agents (
    extension VARCHAR(20) PRIMARY KEY,
    name VARCHAR(100),
    INDEX idx_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Queues table
CREATE TABLE IF NOT EXISTS queues (
    extension VARCHAR(20) PRIMARY KEY,
    queue_name VARCHAR(100) UNIQUE NOT NULL,
    INDEX idx_queue_name (queue_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Groups table
-- FIX: created_at changed from DATETIME to TIMESTAMP for MariaDB 5.5 compatibility.
CREATE TABLE IF NOT EXISTS groups (
    id INT PRIMARY KEY AUTO_INCREMENT,
    name VARCHAR(100) UNIQUE NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    INDEX idx_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Junction: groups <-> agents
CREATE TABLE IF NOT EXISTS group_agents (
    group_id INT,
    agent_ext VARCHAR(20),
    PRIMARY KEY (group_id, agent_ext),
    FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE,
    FOREIGN KEY (agent_ext) REFERENCES agents(extension) ON DELETE CASCADE,
    INDEX idx_agent (agent_ext)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Junction: groups <-> queues (uses queues.extension like group_agents uses agents.extension)
CREATE TABLE IF NOT EXISTS group_queues (
    group_id INT,
    queue_extension VARCHAR(20),
    PRIMARY KEY (group_id, queue_extension),
    FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE,
    FOREIGN KEY (queue_extension) REFERENCES queues(extension) ON DELETE CASCADE,
    INDEX idx_queue (queue_extension)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- User monitor modes: multiple modes per user (listen, whisper, barge).
-- (Legacy: if your users table still has monitor_mode column, you can drop it: ALTER TABLE users DROP COLUMN monitor_mode;)
CREATE TABLE IF NOT EXISTS user_monitor_modes (
    user_id INT NOT NULL,
    mode VARCHAR(20) NOT NULL,
    PRIMARY KEY (user_id, mode),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    INDEX idx_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Junction: users <-> groups (optionally override monitor_mode per group)
CREATE TABLE IF NOT EXISTS user_groups (
    user_id INT,
    group_id INT,
    -- NULL = use user's default monitor_mode; otherwise overrides for this group. Values must match user_monitor_modes: listen, whisper, barge.
    monitor_mode ENUM('listen', 'whisper', 'barge') NULL DEFAULT NULL,
    PRIMARY KEY (user_id, group_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE,
    INDEX idx_group (group_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- =============================================================================
-- Analytics Module
-- =============================================================================

-- Per-queue SLA threshold configuration.
-- If a queue has no row here, the backend falls back to OpDesk_settings 'SLA_DEFAULT_SECS'.
-- FIX: FOREIGN KEY omitted intentionally — queues table is populated lazily from FreePBX;
--      a FK would block saving SLA settings before the queue extension appears in OpDesk.queues.
CREATE TABLE IF NOT EXISTS analytics_sla_settings (
    queue_extension  VARCHAR(20) PRIMARY KEY,
    threshold_secs   SMALLINT UNSIGNED NOT NULL DEFAULT 20,
    updated_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Global FCR and short-abandon configuration (singleton row, id=1).
-- INSERT IGNORE ensures only one row is ever created.
-- FIX: DATETIME → TIMESTAMP for MariaDB 5.5 compatibility.
CREATE TABLE IF NOT EXISTS analytics_fcr_settings (
    id                  TINYINT PRIMARY KEY DEFAULT 1,
    window_days         TINYINT UNSIGNED NOT NULL DEFAULT 7,
    short_abandon_secs  SMALLINT UNSIGNED NOT NULL DEFAULT 5,
    updated_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
INSERT IGNORE INTO analytics_fcr_settings (id, window_days, short_abandon_secs)
VALUES (1, 7, 5);

-- Pre-aggregated hourly metrics per queue (populated by Python background task every 15 min).
-- UNIQUE KEY on (hour_bucket, queue_extension) allows INSERT ... ON DUPLICATE KEY UPDATE.
-- FIX: hour_bucket is DATETIME (not TIMESTAMP) because timestamps beyond 2038 are valid here.
CREATE TABLE IF NOT EXISTS analytics_hourly (
    id              INT PRIMARY KEY AUTO_INCREMENT,
    hour_bucket     DATETIME NOT NULL,
    queue_extension VARCHAR(20) NOT NULL,
    total_calls     MEDIUMINT UNSIGNED DEFAULT 0,
    answered_calls  MEDIUMINT UNSIGNED DEFAULT 0,
    abandoned_calls MEDIUMINT UNSIGNED DEFAULT 0,
    short_abandoned MEDIUMINT UNSIGNED DEFAULT 0,
    sum_wait_secs   INT UNSIGNED DEFAULT 0,
    sum_billsec     INT UNSIGNED DEFAULT 0,
    sla_met_calls   MEDIUMINT UNSIGNED DEFAULT 0,
    computed_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_hour_queue (hour_bucket, queue_extension),
    INDEX idx_hour (hour_bucket),
    INDEX idx_queue (queue_extension)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Pre-aggregated daily metrics per queue.
-- unique_callers / fcr_callbacks support FCR computation without a full CDR scan.
CREATE TABLE IF NOT EXISTS analytics_daily (
    id              INT PRIMARY KEY AUTO_INCREMENT,
    day_bucket      DATE NOT NULL,
    queue_extension VARCHAR(20) NOT NULL,
    total_calls     MEDIUMINT UNSIGNED DEFAULT 0,
    answered_calls  MEDIUMINT UNSIGNED DEFAULT 0,
    abandoned_calls MEDIUMINT UNSIGNED DEFAULT 0,
    short_abandoned MEDIUMINT UNSIGNED DEFAULT 0,
    sum_wait_secs   INT UNSIGNED DEFAULT 0,
    sum_billsec     INT UNSIGNED DEFAULT 0,
    sla_met_calls   MEDIUMINT UNSIGNED DEFAULT 0,
    unique_callers  MEDIUMINT UNSIGNED DEFAULT 0,
    fcr_callbacks   MEDIUMINT UNSIGNED DEFAULT 0,
    computed_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_day_queue (day_bucket, queue_extension),
    INDEX idx_day (day_bucket),
    INDEX idx_queue (queue_extension)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Pre-aggregated daily metrics per agent (and optionally per queue).
-- Empty-string queue_extension = across all queues for that agent.
CREATE TABLE IF NOT EXISTS analytics_agent_daily (
    id              INT PRIMARY KEY AUTO_INCREMENT,
    day_bucket      DATE NOT NULL,
    agent_extension VARCHAR(20) NOT NULL,
    queue_extension VARCHAR(20) NOT NULL DEFAULT '',
    answered_calls  MEDIUMINT UNSIGNED DEFAULT 0,
    sum_billsec     INT UNSIGNED DEFAULT 0,
    sla_met_calls   MEDIUMINT UNSIGNED DEFAULT 0,
    computed_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_day_agent_queue (day_bucket, agent_extension, queue_extension),
    INDEX idx_day (day_bucket),
    INDEX idx_agent (agent_extension)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Default analytics settings
INSERT IGNORE INTO OpDesk_settings (setting_key, setting_value) VALUES
('SLA_DEFAULT_SECS', '20'),
('ANALYTICS_ENABLED', 'true');
