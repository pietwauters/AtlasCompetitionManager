-- migrate-005-strips-name-nullable.sql
-- Migration: Make strips.name nullable and not unique
-- Date: 2026-04-21

-- SQLite does not support DROP UNIQUE or DROP NOT NULL directly.
-- We must recreate the table.

PRAGMA foreign_keys=off;

CREATE TABLE IF NOT EXISTS new_strips (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  strip_number INTEGER,
  name TEXT,
  status TEXT NOT NULL DEFAULT 'idle'
);

INSERT INTO new_strips (id, strip_number, name, status)
  SELECT id, strip_number, name, status FROM strips;

DROP TABLE strips;
ALTER TABLE new_strips RENAME TO strips;

CREATE UNIQUE INDEX IF NOT EXISTS idx_strips_strip_number ON strips(strip_number);

PRAGMA foreign_keys=on;
