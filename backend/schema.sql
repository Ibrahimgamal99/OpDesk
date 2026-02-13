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

