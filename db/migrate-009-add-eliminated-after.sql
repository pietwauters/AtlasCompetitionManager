-- Migration: Add eliminated_after column to competitors
-- Date: 2026-04-24
ALTER TABLE competitors ADD COLUMN eliminated_after INTEGER REFERENCES phases(id);
