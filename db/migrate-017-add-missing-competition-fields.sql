-- Migration: Add missing columns to competitions table for Sequelize compatibility
-- Date: 2026-04-28

ALTER TABLE competitions ADD COLUMN weapon TEXT;
ALTER TABLE competitions ADD COLUMN gender TEXT;
ALTER TABLE competitions ADD COLUMN status TEXT DEFAULT 'draft';
ALTER TABLE competitions ADD COLUMN created_at DATETIME DEFAULT (datetime('now'));
