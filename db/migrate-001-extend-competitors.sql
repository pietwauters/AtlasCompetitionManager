-- Migration 001: Extend competitors table with full fencer profile fields
-- Run via: node db/migrate.js
-- Safe to run multiple times (duplicate column errors are silently ignored).
ALTER TABLE competitors ADD COLUMN first_name TEXT;
ALTER TABLE competitors ADD COLUMN last_name TEXT;
ALTER TABLE competitors ADD COLUMN date_of_birth TEXT;
ALTER TABLE competitors ADD COLUMN gender TEXT;
ALTER TABLE competitors ADD COLUMN weapons TEXT;
ALTER TABLE competitors ADD COLUMN licence TEXT;
ALTER TABLE competitors ADD COLUMN handedness TEXT;
ALTER TABLE competitors ADD COLUMN national_ranking INTEGER;
