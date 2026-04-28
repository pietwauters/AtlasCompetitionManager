-- Migration: Add missing columns to competitions table for Sequelize compatibility (fixed for SQLite)
-- Date: 2026-04-28

ALTER TABLE competitions ADD COLUMN weapon TEXT;
ALTER TABLE competitions ADD COLUMN gender TEXT;
ALTER TABLE competitions ADD COLUMN status TEXT DEFAULT 'draft';
ALTER TABLE competitions ADD COLUMN created_at DATETIME;

-- Set created_at for existing rows to current timestamp
UPDATE competitions SET created_at = datetime('now') WHERE created_at IS NULL;
