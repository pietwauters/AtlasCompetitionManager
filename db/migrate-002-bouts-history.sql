-- Migration: Add bouts_history table for undo functionality
-- Date: 2026-04-14

CREATE TABLE IF NOT EXISTS bouts_history (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  bout_id       INTEGER NOT NULL REFERENCES bouts(id) ON DELETE CASCADE,
  left_score    INTEGER,
  right_score   INTEGER,
  winner_id     INTEGER,
  status        TEXT,
  changed_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);
