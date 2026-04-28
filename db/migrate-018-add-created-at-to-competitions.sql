-- Migration: Add only created_at column to competitions table (if missing)
-- Date: 2026-04-28

ALTER TABLE competitions ADD COLUMN created_at DATETIME;
UPDATE competitions SET created_at = datetime('now') WHERE created_at IS NULL;
