-- Multi-strip pool distribution support

-- Setting: whether dynamic bout reordering is enabled globally
INSERT OR IGNORE INTO settings (key, value) VALUES ('opp2_dynamic_reorder', '0');

-- Setting: minimum rest between bouts for same fencer, in seconds (default 180 = 3 min)
INSERT OR IGNORE INTO settings (key, value) VALUES ('opp2_min_rest_seconds', '180');

-- Zero-rest warnings recorded at distribution time, per pool.
-- Cleared and rebuilt whenever strip assignment changes.
CREATE TABLE IF NOT EXISTS pool_rest_flags (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  pool_id       INTEGER NOT NULL REFERENCES pools(id) ON DELETE CASCADE,
  fencer_pos    INTEGER NOT NULL,  -- 1-based position index within the pool
  prev_bout_id  INTEGER REFERENCES bouts(id) ON DELETE CASCADE,
  next_bout_id  INTEGER REFERENCES bouts(id) ON DELETE CASCADE,
  flagged_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Per-pool setting: dynamic reordering enabled (overrides global setting)
ALTER TABLE pools ADD COLUMN dynamic_reorder INTEGER NOT NULL DEFAULT 0;

-- Store how many strips this pool is distributed across (0 = not yet distributed)
ALTER TABLE pools ADD COLUMN strip_count INTEGER NOT NULL DEFAULT 0;
