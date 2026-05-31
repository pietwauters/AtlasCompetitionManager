-- Make left_id and right_id nullable in bouts to support DE placeholder slots.
-- Pre-created future-round DE bouts need empty sides until competitors advance.

PRAGMA foreign_keys = OFF;

CREATE TABLE bouts_new (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  phase_id         INTEGER NOT NULL REFERENCES phases(id)      ON DELETE CASCADE,
  pool_id          INTEGER REFERENCES pools(id)                ON DELETE CASCADE,
  left_id          INTEGER          REFERENCES competitors(id) ON DELETE RESTRICT,
  right_id         INTEGER          REFERENCES competitors(id) ON DELETE RESTRICT,
  left_score       INTEGER,
  right_score      INTEGER,
  winner_id        INTEGER          REFERENCES competitors(id) ON DELETE RESTRICT,
  status           TEXT    NOT NULL DEFAULT 'pending',
  strip_id         INTEGER REFERENCES strips(id)               ON DELETE SET NULL,
  referee_id       INTEGER REFERENCES referees(id)             ON DELETE SET NULL,
  bout_order       INTEGER NOT NULL DEFAULT 0,
  de_round         INTEGER,
  tableau_position INTEGER
);

INSERT INTO bouts_new SELECT * FROM bouts;
DROP TABLE bouts;
ALTER TABLE bouts_new RENAME TO bouts;

CREATE INDEX idx_bouts_phase ON bouts (phase_id, bout_order);
CREATE INDEX idx_bouts_pool  ON bouts (pool_id);
CREATE INDEX idx_bouts_de    ON bouts (phase_id, de_round, tableau_position);

PRAGMA foreign_keys = ON;
