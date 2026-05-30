-- Migration: Create phases table
-- Date: 2026-04-28

CREATE TABLE IF NOT EXISTS phases (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  competition_id INTEGER NOT NULL REFERENCES Competitions(id) ON DELETE CASCADE,
  phase_order    INTEGER NOT NULL,
  type           TEXT    NOT NULL,
  rule_doc       TEXT    NOT NULL,
  status         TEXT    NOT NULL DEFAULT 'pending',
  createdAt      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updatedAt      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
