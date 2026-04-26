-- Migration: Add state and network_state columns to strips
-- Date: 2026-04-24
ALTER TABLE strips ADD COLUMN state TEXT NOT NULL DEFAULT 'idle';
ALTER TABLE strips ADD COLUMN network_state TEXT NOT NULL DEFAULT 'offline';
