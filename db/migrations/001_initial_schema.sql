-- =============================================================================
-- Migration 001 — Initial schema
-- Atlas Competition Manager
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Reference / lookup tables
-- ---------------------------------------------------------------------------

CREATE TABLE nocs (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  code    TEXT    NOT NULL UNIQUE,   -- 3-letter IOC code, e.g. BEL
  country TEXT    NOT NULL
);

CREATE TABLE clubs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT    NOT NULL,
  short_name TEXT,
  country    TEXT    NOT NULL DEFAULT ''
);

-- Age categories are federation-specific (U17 in BEL ≠ U17 in FRA).
-- Eligibility: competition_year - birth_year must fall within [min_age, max_age].
-- Null bound means no limit in that direction (e.g. Senior has no max_age).
CREATE TABLE age_categories (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  code       TEXT    NOT NULL,   -- U13 | U15 | U17 | U20 | Senior | Veteran | ...
  label      TEXT    NOT NULL,   -- human-readable, shown in UI
  min_age    INTEGER,            -- inclusive lower bound on (comp_year - birth_year)
  max_age    INTEGER,            -- inclusive upper bound on (comp_year - birth_year)
  federation TEXT,               -- BEL | FRA | FIE | null = universal
  notes      TEXT
);

-- ---------------------------------------------------------------------------
-- People and sport-specific profiles
-- ---------------------------------------------------------------------------

CREATE TABLE people (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  first_name    TEXT    NOT NULL,
  last_name     TEXT    NOT NULL,
  date_of_birth TEXT,            -- ISO-8601: YYYY-MM-DD
  gender        TEXT,            -- M | F | X
  nationality   TEXT    REFERENCES nocs(code) ON UPDATE CASCADE,
  club_id       INTEGER REFERENCES clubs(id) ON DELETE SET NULL
);

-- One fencer profile per person. Deleted when the person is deleted.
CREATE TABLE fencers (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id  INTEGER NOT NULL UNIQUE REFERENCES people(id) ON DELETE CASCADE,
  licence    TEXT,
  weapons    TEXT,               -- JSON array: ["foil","epee"]
  handedness TEXT,               -- R | L
  ranking    INTEGER
);

-- One referee profile per person. Deleted when the person is deleted.
CREATE TABLE referees (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id INTEGER NOT NULL UNIQUE REFERENCES people(id) ON DELETE CASCADE,
  licence   TEXT,
  level     TEXT
);

-- ---------------------------------------------------------------------------
-- System tables
-- ---------------------------------------------------------------------------

CREATE TABLE users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT    NOT NULL UNIQUE,
  password_hash TEXT    NOT NULL,
  role          TEXT    NOT NULL DEFAULT 'viewer',  -- superadmin | admin | referee | viewer
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE strips (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT    NOT NULL UNIQUE,
  strip_number  INTEGER NOT NULL UNIQUE,
  status        TEXT    NOT NULL DEFAULT 'idle',    -- idle | assigned | maintenance
  network_state TEXT    NOT NULL DEFAULT 'offline'  -- online | offline
);

-- ---------------------------------------------------------------------------
-- Events
-- ---------------------------------------------------------------------------

CREATE TABLE tournaments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL,
  city        TEXT,
  country     TEXT,
  date_start  TEXT,              -- ISO-8601
  date_end    TEXT,
  organizer   TEXT,
  description TEXT,
  level       TEXT,
  status      TEXT    NOT NULL DEFAULT 'open',  -- open | closed | archived
  archived    INTEGER NOT NULL DEFAULT 0        -- boolean
);

CREATE TABLE competitions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  tournament_id INTEGER REFERENCES tournaments(id) ON DELETE SET NULL,
  name          TEXT    NOT NULL,
  weapon        TEXT    NOT NULL,   -- foil | epee | sabre
  gender        TEXT    NOT NULL,   -- M | F | X (X = mixed/open)
  date          TEXT,               -- ISO-8601; used for age category eligibility
  status        TEXT    NOT NULL DEFAULT 'draft',  -- draft | active | finished
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- A competition can cover multiple age categories (e.g. U17 + U20 competing together).
CREATE TABLE competition_age_categories (
  competition_id  INTEGER NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
  age_category_id INTEGER NOT NULL REFERENCES age_categories(id) ON DELETE CASCADE,
  PRIMARY KEY (competition_id, age_category_id)
);

-- Phases must be defined before competitors because competitors.eliminated_after
-- references phases(id).
CREATE TABLE phases (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  competition_id INTEGER NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
  phase_order    INTEGER NOT NULL,
  type           TEXT    NOT NULL,   -- pool | de
  rule_doc       TEXT    NOT NULL,   -- filename in rules/, e.g. "pool-standard.json"
  status         TEXT    NOT NULL DEFAULT 'pending'  -- pending | active | finished
);

-- A competitor is a fencer entered in a specific competition.
CREATE TABLE competitors (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  competition_id   INTEGER NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
  fencer_id        INTEGER NOT NULL REFERENCES fencers(id)      ON DELETE RESTRICT,
  initial_seed     INTEGER,
  status           TEXT    NOT NULL DEFAULT 'active',
  -- active | withdrawn | dns | eliminated | finished
  final_rank       INTEGER,
  eliminated_after INTEGER REFERENCES phases(id) ON DELETE SET NULL,
  UNIQUE (competition_id, fencer_id)
);

-- Rankings are the output of a closed phase. Written once; never recomputed.
CREATE TABLE rankings (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  phase_id         INTEGER NOT NULL REFERENCES phases(id)      ON DELETE CASCADE,
  competitor_id    INTEGER NOT NULL REFERENCES competitors(id) ON DELETE CASCADE,
  position         INTEGER NOT NULL,
  victories        INTEGER NOT NULL DEFAULT 0,
  matches          INTEGER NOT NULL DEFAULT 0,
  indicator        INTEGER NOT NULL DEFAULT 0,  -- touches_scored - touches_received
  touches_scored   INTEGER NOT NULL DEFAULT 0,
  touches_received INTEGER NOT NULL DEFAULT 0,
  advanced         INTEGER NOT NULL DEFAULT 0,  -- 1 = advances to next phase
  UNIQUE (phase_id, competitor_id)
);

CREATE TABLE pools (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  phase_id    INTEGER NOT NULL REFERENCES phases(id)    ON DELETE CASCADE,
  pool_number INTEGER NOT NULL,
  strip_id    INTEGER REFERENCES strips(id)             ON DELETE SET NULL,
  referee_id  INTEGER REFERENCES referees(id)           ON DELETE SET NULL,
  status      TEXT    NOT NULL DEFAULT 'pending'  -- pending | active | finished
);

CREATE TABLE pool_competitors (
  pool_id       INTEGER NOT NULL REFERENCES pools(id)       ON DELETE CASCADE,
  competitor_id INTEGER NOT NULL REFERENCES competitors(id) ON DELETE CASCADE,
  PRIMARY KEY (pool_id, competitor_id)
);

-- pool_id is null for DE bouts.
-- de_round and tableau_position are null for pool bouts.
-- strip_id on bouts is the effective assignment; pools.strip_id is the default
-- applied to all bouts in a pool when the pool is assigned a strip.
CREATE TABLE bouts (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  phase_id         INTEGER NOT NULL REFERENCES phases(id)      ON DELETE CASCADE,
  pool_id          INTEGER REFERENCES pools(id)                ON DELETE CASCADE,
  left_id          INTEGER NOT NULL REFERENCES competitors(id) ON DELETE RESTRICT,
  right_id         INTEGER NOT NULL REFERENCES competitors(id) ON DELETE RESTRICT,
  left_score       INTEGER,
  right_score      INTEGER,
  winner_id        INTEGER REFERENCES competitors(id)          ON DELETE RESTRICT,
  status           TEXT    NOT NULL DEFAULT 'pending',  -- pending | active | finished
  strip_id         INTEGER REFERENCES strips(id)              ON DELETE SET NULL,
  referee_id       INTEGER REFERENCES referees(id)            ON DELETE SET NULL,
  bout_order       INTEGER NOT NULL DEFAULT 0,
  de_round         INTEGER,    -- DE only: round number (1 = first round)
  tableau_position INTEGER     -- DE only: bracket slot
);

-- Snapshot of bout state before each score edit. Enables undo.
CREATE TABLE bout_history (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  bout_id     INTEGER NOT NULL REFERENCES bouts(id) ON DELETE CASCADE,
  left_score  INTEGER,
  right_score INTEGER,
  winner_id   INTEGER,
  status      TEXT,
  changed_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------------------
-- Indexes (most frequent query patterns)
-- ---------------------------------------------------------------------------

CREATE INDEX idx_people_name        ON people(last_name, first_name);
CREATE INDEX idx_competitors_comp   ON competitors(competition_id);
CREATE INDEX idx_competitors_fencer ON competitors(fencer_id);
CREATE INDEX idx_phases_comp        ON phases(competition_id, phase_order);
CREATE INDEX idx_pools_phase        ON pools(phase_id);
CREATE INDEX idx_pool_comp_pool     ON pool_competitors(pool_id);
CREATE INDEX idx_pool_comp_comp     ON pool_competitors(competitor_id);
CREATE INDEX idx_bouts_phase        ON bouts(phase_id, bout_order);
CREATE INDEX idx_bouts_pool         ON bouts(pool_id);
CREATE INDEX idx_rankings_phase     ON rankings(phase_id, position);
CREATE INDEX idx_bout_history_bout  ON bout_history(bout_id, changed_at DESC);
