-- Migration 010: Add strip_number and connection_status to strips

ALTER TABLE strips ADD COLUMN strip_number INTEGER UNIQUE;
ALTER TABLE strips ADD COLUMN connection_status TEXT DEFAULT 'offline';
CREATE UNIQUE INDEX IF NOT EXISTS idx_strips_strip_number ON strips(strip_number);
