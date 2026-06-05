-- Replace de_range slot type with semantic DE slot fields.
-- de_round + bout_start + bout_end → bracket + tableau + partition

-- SQLite does not support DROP COLUMN or ALTER COLUMN, so we recreate the table.

CREATE TABLE pipeline_slots_new (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  strip_id         INTEGER NOT NULL REFERENCES strips(id)   ON DELETE CASCADE,
  slot_order       INTEGER NOT NULL,
  type             TEXT    NOT NULL CHECK (type IN ('pool', 'de')),
  pool_id          INTEGER REFERENCES pools(id)             ON DELETE CASCADE,
  phase_id         INTEGER REFERENCES phases(id)            ON DELETE CASCADE,
  -- DE-specific: which portion of the phase this slot covers
  bracket          TEXT    CHECK (bracket IN ('main', 'repechage', 'placement')),
  tableau          INTEGER, -- table size: 128, 64, 32, 16, 8, 4, 2
  partition        TEXT    NOT NULL DEFAULT 'full',
  --   'full'        = entire tableau round
  --   'A' / 'B'    = left / right half
  --   'A1'/'A2'/'B1'/'B2' = quarters
  --   'A1a'…       = eighths (letters, skipping I to avoid confusion with 1)
  scheduled_start  TEXT,
  minutes_per_bout INTEGER,
  referee_id       INTEGER REFERENCES referees(id)          ON DELETE SET NULL,
  status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'done')),
  UNIQUE (strip_id, slot_order)
);

INSERT INTO pipeline_slots_new
  (id, strip_id, slot_order, type, pool_id, phase_id,
   bracket, tableau, partition,
   scheduled_start, minutes_per_bout, referee_id, status)
SELECT
  id, strip_id, slot_order,
  CASE WHEN type = 'de_range' THEN 'de' ELSE type END,
  pool_id, phase_id,
  CASE WHEN type = 'de_range' THEN 'main' ELSE NULL END,
  NULL,   -- tableau not recoverable from de_round without phase context; reset as needed
  'full',
  scheduled_start, minutes_per_bout, referee_id, status
FROM pipeline_slots;

DROP TABLE pipeline_slots;
ALTER TABLE pipeline_slots_new RENAME TO pipeline_slots;
