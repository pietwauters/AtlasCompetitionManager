-- ---------------------------------------------------------------------------
-- NOCs (National Olympic Committees / country codes)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS nocs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  country TEXT NOT NULL
);
-- ---------------------------------------------------------------------------
-- Tournaments (master table for multi-competition events)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tournaments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  city TEXT,
  country TEXT,
  date_start DATE,
  date_end DATE,
  organizer TEXT,
  description TEXT,
  level TEXT,
  status TEXT DEFAULT 'open',
  archived BOOLEAN DEFAULT 0
);
-- ---------------------------------------------------------------------------
-- People (master table for all persons: fencers, referees, etc.)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS people (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  first_name TEXT,
  last_name TEXT,
  date_of_birth TEXT, -- ISO-8601: YYYY-MM-DD
  gender TEXT,        -- M | F | X
  nationality TEXT,   -- 3-letter NOC code
  club TEXT
);
-- AtlasCompetitionManager — SQLite schema
-- Run via: sqlite3 data/atlas.db < db/schema.sql
-- This file is the single source of truth for the database structure.
-- Add new tables here and document the migration date/reason above each block.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- Users (admin / referee / viewer roles)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  username   TEXT    NOT NULL UNIQUE,
  password   TEXT    NOT NULL,       -- bcrypt hash
  role       TEXT    NOT NULL DEFAULT 'viewer',  -- superadmin | admin | referee | viewer
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------------------
-- Shared resources
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS strips (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT    NOT NULL UNIQUE,   -- e.g. "Piste 001", "Podium"
  status     TEXT    NOT NULL DEFAULT 'idle',  -- idle | assigned | maintenance
  state      TEXT    NOT NULL DEFAULT 'idle',  -- idle | busy | ...
  network_state TEXT NOT NULL DEFAULT 'offline'  -- connected | offline
);

CREATE TABLE IF NOT EXISTS referees (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT    NOT NULL,
  licence    TEXT,
  status     TEXT    NOT NULL DEFAULT 'available'  -- available | assigned | absent
);

-- ---------------------------------------------------------------------------
-- Competitions
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS competitions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT    NOT NULL,
  weapon     TEXT    NOT NULL,   -- foil | epee | sabre
  gender     TEXT    NOT NULL,   -- M | F | X
  status     TEXT    NOT NULL DEFAULT 'draft',  -- draft | active | finished
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS competitors (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  competition_id   INTEGER NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
  -- Legacy single-string name (kept for backward compat with bulk import).
  -- If first_name / last_name are set they are canonical; name is the fallback.
  name             TEXT    NOT NULL,
  first_name       TEXT,
  last_name        TEXT,
  date_of_birth    TEXT,             -- ISO-8601: YYYY-MM-DD
  gender           TEXT,             -- M | F
  weapons          TEXT,             -- JSON array: '["foil","epee"]'
  licence          TEXT,             -- national or FIE licence number
  handedness       TEXT,             -- R | L
  national_ranking INTEGER,
  club             TEXT,
  nationality      TEXT,             -- 3-letter NOC code
  initial_seed     INTEGER,
  status           TEXT    NOT NULL DEFAULT 'active',  -- active | withdrawn | dns
  final_rank       INTEGER  -- final ranking after elimination or competition end
);

-- ---------------------------------------------------------------------------
-- Fencers (master list, not per competition)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS fencers (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id        INTEGER REFERENCES people(id),
  ranking          INTEGER,
  status           TEXT DEFAULT 'active',
  initial_seed     INTEGER,
  weapons          TEXT,
  licence          TEXT,
  handedness       TEXT,
  final_rank       INTEGER
);

-- ---------------------------------------------------------------------------
-- Phases (pool round, DE, etc.)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS phases (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  competition_id INTEGER NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
  phase_order    INTEGER NOT NULL,   -- 1 = first phase, 2 = second, ...
  type           TEXT    NOT NULL,   -- pool | de | combined
  rule_doc       TEXT    NOT NULL,   -- filename in rules/ dir, e.g. "pool-standard.json"
  status         TEXT    NOT NULL DEFAULT 'pending'  -- pending | active | finished
);

-- ---------------------------------------------------------------------------
-- Rankings (output of each phase)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rankings (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  phase_id       INTEGER NOT NULL REFERENCES phases(id) ON DELETE CASCADE,
  competitor_id  INTEGER NOT NULL REFERENCES competitors(id) ON DELETE CASCADE,
  position       INTEGER NOT NULL,
  victories      INTEGER NOT NULL DEFAULT 0,
  indicator      INTEGER NOT NULL DEFAULT 0,
  touches_scored INTEGER NOT NULL DEFAULT 0,
  touches_received INTEGER NOT NULL DEFAULT 0,
  advanced       INTEGER NOT NULL DEFAULT 0  -- 1 = advances to next phase
);

-- ---------------------------------------------------------------------------
-- Pools
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pools (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  phase_id   INTEGER NOT NULL REFERENCES phases(id) ON DELETE CASCADE,
  pool_number INTEGER NOT NULL,
  strip_id   INTEGER REFERENCES strips(id),
  referee_id INTEGER REFERENCES referees(id),
  status     TEXT    NOT NULL DEFAULT 'pending'  -- pending | active | finished
);

CREATE TABLE IF NOT EXISTS pool_competitors (
  pool_id       INTEGER NOT NULL REFERENCES pools(id) ON DELETE CASCADE,
  competitor_id INTEGER NOT NULL REFERENCES competitors(id) ON DELETE CASCADE,
  PRIMARY KEY (pool_id, competitor_id)
);

-- ---------------------------------------------------------------------------
-- Competition Fencers (per competition, links fencers to competitions)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS competition_fencers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  competition_id INTEGER NOT NULL,
  fencer_id INTEGER NOT NULL,
  seed INTEGER,
  status TEXT DEFAULT 'registered',
  state TEXT,
  final_rank INTEGER,
  created_at DATETIME NOT NULL DEFAULT (datetime('now')),
  updated_at DATETIME NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (competition_id) REFERENCES competitions(id) ON DELETE CASCADE,
  FOREIGN KEY (fencer_id) REFERENCES fencers(id) ON DELETE CASCADE
);

-- ---------------------------------------------------------------------------
-- Bouts
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bouts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  pool_id       INTEGER REFERENCES pools(id),
  phase_id      INTEGER NOT NULL REFERENCES phases(id) ON DELETE CASCADE,
  left_id       INTEGER NOT NULL REFERENCES competitors(id),
  right_id      INTEGER NOT NULL REFERENCES competitors(id),
  left_score    INTEGER,
  right_score   INTEGER,
  winner_id     INTEGER REFERENCES competitors(id),
  status        TEXT    NOT NULL DEFAULT 'pending',  -- pending | active | finished
  strip_id      INTEGER REFERENCES strips(id),
  referee_id    INTEGER REFERENCES referees(id)
);
