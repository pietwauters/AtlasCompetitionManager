-- OPP2 broker configuration and pipeline scheduling

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT INTO settings (key, value) VALUES ('opp2_broker_url', 'mqtt://openpiste.local:1883');
INSERT INTO settings (key, value) VALUES ('opp2_enabled',    '0');

-- Each strip has an ordered list of work items (pipeline slots).
-- type 'pool'     → pool_id references a specific pool
-- type 'de_range' → phase_id + de_round + bout_start/end (1-based, tableau order)
CREATE TABLE pipeline_slots (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  strip_id        INTEGER NOT NULL REFERENCES strips(id)   ON DELETE CASCADE,
  slot_order      INTEGER NOT NULL,
  type            TEXT    NOT NULL CHECK (type IN ('pool','de_range')),
  pool_id         INTEGER REFERENCES pools(id)             ON DELETE CASCADE,
  phase_id        INTEGER REFERENCES phases(id)            ON DELETE CASCADE,
  de_round        INTEGER,
  bout_start      INTEGER,  -- 1-based index within the round's tableau order
  bout_end        INTEGER,  -- inclusive
  scheduled_start TEXT,     -- HH:MM, optional
  minutes_per_bout INTEGER, -- null = fall back to bout_duration_standards
  referee_id      INTEGER REFERENCES referees(id)          ON DELETE SET NULL,
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','done')),
  UNIQUE (strip_id, slot_order)
);

-- Future: default bout durations by weapon and phase type.
-- Populated when standard durations are established.
CREATE TABLE bout_duration_standards (
  weapon          TEXT NOT NULL CHECK (weapon IN ('F','E','S')),
  phase_type      TEXT NOT NULL CHECK (phase_type IN ('pool','de')),
  minutes_per_bout INTEGER NOT NULL,
  PRIMARY KEY (weapon, phase_type)
);
