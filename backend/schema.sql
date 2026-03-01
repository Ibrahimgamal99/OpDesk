-- OpDesk Database Schema
-- This file contains the database schema for the Asterisk Operator Panel

-- Create OpDesk database if it doesn't exist
CREATE DATABASE IF NOT EXISTS OpDesk CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Use OpDesk database
USE OpDesk;

-- Settings table for storing application configuration
CREATE TABLE IF NOT EXISTS OpDesk_settings (
    setting_key VARCHAR(255) PRIMARY KEY,
    setting_value TEXT,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- =============================================================================
-- Authentication & Authorization
-- =============================================================================

-- User table (login by username or extension)
CREATE TABLE users (
    id INT PRIMARY KEY AUTO_INCREMENT,
    username VARCHAR(100) UNIQUE NOT NULL,
    extension VARCHAR(20) UNIQUE NULL,
    extension_secret VARCHAR(255),
    password_hash VARCHAR(255),
    name VARCHAR(255),
    webrtc ENUM('yes', 'no') DEFAULT 'no',
    role ENUM('admin', 'supervisor','agent') NOT NULL,
    is_active TINYINT(1) DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_login_at DATETIME NULL DEFAULT NULL,

    INDEX idx_username (username),
    INDEX idx_extension (extension),
    INDEX idx_active (is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Call notifications: one row per call hangup for an extension (created in AMI _ev_Hangup).
-- UI can mark as read or archived.
CREATE TABLE IF NOT EXISTS call_notifications (
    id INT PRIMARY KEY AUTO_INCREMENT,
    extension VARCHAR(20) NOT NULL,
    caller_from VARCHAR(50) NULL,
    queue VARCHAR(100) NULL,
    status_flag ENUM('new', 'read', 'archived') DEFAULT 'new',
    reason VARCHAR(255) NULL,
    event_time DATETIME DEFAULT CURRENT_TIMESTAMP,
    call_id VARCHAR(255) NULL,
    INDEX idx_extension (extension),
    INDEX idx_status (status_flag),
    INDEX idx_event_time (event_time),
    INDEX idx_caller_from (caller_from)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Delete read call_notifications older than 7 days (runs daily via MySQL event scheduler).
-- Privilege: user needs EVENT on this database; SET GLOBAL requires SUPER (or set event_scheduler=ON in my.cnf).
SET GLOBAL event_scheduler = ON;

DROP EVENT IF EXISTS evt_cleanup_read_call_notifications;
CREATE EVENT evt_cleanup_read_call_notifications
ON SCHEDULE EVERY 1 DAY
STARTS CURRENT_TIMESTAMP
DO
  DELETE FROM call_notifications
  WHERE status_flag = 'read'
    AND event_time < DATE_SUB(NOW(), INTERVAL 7 DAY);

-- Default admin user (password is bcrypt hash; use INSERT IGNORE so existing DB is not broken)
-- Monitor modes are stored in user_monitor_modes (admin gets all by backfill).
INSERT IGNORE INTO users (username, password_hash, name, role) VALUES
('admin', '$2b$12$iAHttCYzFV2H4oZEiTiNe.2eQSQDgcKWMf4ghLmieuoect13ISWju', 'Admin', 'admin');

-- Agents table
CREATE TABLE agents (
    extension VARCHAR(20) PRIMARY KEY,
    name VARCHAR(100),
    INDEX idx_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Queues table
CREATE TABLE queues (
    extension VARCHAR(20) PRIMARY KEY,
    queue_name VARCHAR(100) UNIQUE NOT NULL,
    INDEX idx_queue_name (queue_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Groups table
CREATE TABLE groups (
    id INT PRIMARY KEY AUTO_INCREMENT,
    name VARCHAR(100) UNIQUE NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,

    INDEX idx_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Junction: groups <-> agents
CREATE TABLE group_agents (
    group_id INT,
    agent_ext VARCHAR(20),
    PRIMARY KEY (group_id, agent_ext),
    FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE,
    FOREIGN KEY (agent_ext) REFERENCES agents(extension) ON DELETE CASCADE,
    INDEX idx_agent (agent_ext)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Junction: groups <-> queues (uses queues.extension like group_agents uses agents.extension)
CREATE TABLE group_queues (
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
CREATE TABLE user_groups (
    user_id INT,
    group_id INT,
    -- NULL = use user's default monitor_mode; otherwise overrides for this group. Values must match user_monitor_modes: listen, whisper, barge.
    monitor_mode ENUM('listen', 'whisper', 'barge') NULL DEFAULT NULL,
    PRIMARY KEY (user_id, group_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE,
    INDEX idx_group (group_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

