-- Add team_match slot type to pipeline, and position tracking to relays.

-- SQLite does not support ALTER COLUMN or adding CHECK constraints; recreate pipeline_slots.
CREATE TABLE pipeline_slots_new (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  strip_id         INTEGER NOT NULL REFERENCES strips(id)         ON DELETE CASCADE,
  slot_order       INTEGER NOT NULL,
  type             TEXT    NOT NULL CHECK (type IN ('pool', 'de', 'team_match')),
  pool_id          INTEGER REFERENCES pools(id)                   ON DELETE CASCADE,
  phase_id         INTEGER REFERENCES phases(id)                  ON DELETE CASCADE,
  team_match_id    INTEGER REFERENCES team_matches(id)            ON DELETE SET NULL,
  bracket          TEXT    CHECK (bracket IN ('main', 'repechage', 'placement')),
  tableau          INTEGER,
  partition        TEXT    NOT NULL DEFAULT 'full',
  scheduled_start  TEXT,
  minutes_per_bout INTEGER,
  referee_id       INTEGER REFERENCES referees(id)                ON DELETE SET NULL,
  status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'done')),
  UNIQUE (strip_id, slot_order)
);

INSERT INTO pipeline_slots_new
  (id, strip_id, slot_order, type, pool_id, phase_id, team_match_id,
   bracket, tableau, partition,
   scheduled_start, minutes_per_bout, referee_id, status)
SELECT
  id, strip_id, slot_order, type, pool_id, phase_id, NULL,
  bracket, tableau, partition,
  scheduled_start, minutes_per_bout, referee_id, status
FROM pipeline_slots;

DROP TABLE pipeline_slots;
ALTER TABLE pipeline_slots_new RENAME TO pipeline_slots;

-- Position tracking on relays, needed for OPP2 fencer resolution.
ALTER TABLE relays ADD COLUMN left_position  INTEGER;
ALTER TABLE relays ADD COLUMN right_position INTEGER;
