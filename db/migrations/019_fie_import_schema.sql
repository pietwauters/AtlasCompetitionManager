-- =============================================================================
-- Migration 019 — FIE XML import schema
--
-- Key changes:
--   1. people     — add fie_id, picture_url
--   2. fencers    — drop licence/ranking/points; add fie_statut
--   3. referees   — drop licence
--   4. coaches    — new profile table (pattern: same as fencers/referees)
--   5. licences   — new, replaces fencers.licence + referees.licence
--   6. fencer_rankings — new, replaces fencers.ranking/points; multi-issuer
--   7. competitors — major restructure: self-contained person snapshot + optional
--                    person_id link; removes fencer_id dependency
--   8. competitions — add fie_id, seeding context columns
--   9. tournaments  — add fie_season, organizing_federation, championship
--  10. nocs         — add AIN neutral-athlete codes
-- =============================================================================

-- ── 1. people ────────────────────────────────────────────────────────────────

ALTER TABLE people ADD COLUMN fie_id      INTEGER;
ALTER TABLE people ADD COLUMN picture_url TEXT;

CREATE UNIQUE INDEX ux_people_fie_id ON people(fie_id) WHERE fie_id IS NOT NULL;

-- ── 2. fencers ───────────────────────────────────────────────────────────────
-- licence/ranking/points were the only per-weapon or per-issuer data.
-- All three move to specialised tables below.

ALTER TABLE fencers DROP COLUMN licence;
ALTER TABLE fencers DROP COLUMN ranking;
ALTER TABLE fencers DROP COLUMN points;
ALTER TABLE fencers ADD COLUMN fie_statut TEXT;

-- ── 3. referees ──────────────────────────────────────────────────────────────

ALTER TABLE referees DROP COLUMN licence;

-- ── 4. coaches ───────────────────────────────────────────────────────────────

CREATE TABLE coaches (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id INTEGER NOT NULL UNIQUE REFERENCES people(id) ON DELETE CASCADE,
  fedid     TEXT    -- FIE federation code they coach for (may differ from nationality)
);

-- ── 5. licences ──────────────────────────────────────────────────────────────
-- One row per (person, issuer). issuer examples: FIE, EFC, CPA, BEL, …
-- issuer_type: international | confederation | national | regional | club

CREATE TABLE licences (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id   INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  issuer      TEXT    NOT NULL,
  issuer_type TEXT    NOT NULL,
  number      TEXT    NOT NULL,
  UNIQUE (person_id, issuer)
);

CREATE INDEX idx_licences_person ON licences(person_id);
CREATE INDEX idx_licences_number ON licences(number);

-- ── 6. fencer_rankings ───────────────────────────────────────────────────────
-- Multi-issuer, per-weapon, per-category ranking snapshots.
-- position NULL = unranked (replaces the legacy sentinel 9999).

CREATE TABLE fencer_rankings (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  issuer    TEXT    NOT NULL,   -- FIE | EFC | CPA | BEL | …
  weapon    TEXT    NOT NULL,   -- foil | epee | sabre
  category  TEXT,               -- Senior | U20 | U17 | null = open/all
  position  INTEGER,            -- rank position (lower = better); NULL = unranked
  points    REAL,               -- ranking points (decimal)
  season    TEXT,               -- e.g. "2025/2026"
  as_of     TEXT                -- YYYY-MM-DD snapshot date
);

CREATE INDEX idx_fencer_rankings_person ON fencer_rankings(person_id);
CREATE UNIQUE INDEX ux_fencer_rankings
  ON fencer_rankings(person_id, issuer, weapon,
                     COALESCE(category, ''), COALESCE(season, ''));

-- ── 7. competitors — restructure ─────────────────────────────────────────────
--
-- Competitors are now self-contained: person data is stored directly on the row
-- (snapshot at enrolment time). An optional person_id links back to a DB roster
-- entry in Mode 2 (database-driven), but is NULL in Mode 1 (FIE XML / file-based).
--
-- Uniqueness:
--   Mode 2 (person_id set): one person per competition
--   Mode 1 (fie_id set):    one FIE person per competition
--
-- We use partial unique indexes so SQLite ignores the NULL rows.

PRAGMA foreign_keys = OFF;

CREATE TABLE competitors_new (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  competition_id    INTEGER NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
  person_id         INTEGER          REFERENCES people(id)       ON DELETE SET NULL,
  -- person snapshot (populated from XML in Mode 1, copied from people in Mode 2)
  last_name         TEXT,
  first_name        TEXT,
  date_of_birth     TEXT,
  gender            TEXT,
  nationality       TEXT,
  fie_id            INTEGER,
  handedness        TEXT,
  fie_licence       TEXT,
  -- seeding context (the ranking data that drove the initial seed assignment)
  initial_seed      INTEGER,
  seeding_points    REAL,
  seeding_position  INTEGER,
  seeding_issuer    TEXT,
  -- lifecycle
  status            TEXT    NOT NULL DEFAULT 'active',
  checked_in        INTEGER NOT NULL DEFAULT 0,
  final_rank        INTEGER,
  eliminated_after  INTEGER REFERENCES phases(id) ON DELETE SET NULL
);

INSERT INTO competitors_new (
  id, competition_id, person_id,
  last_name, first_name, date_of_birth, gender, nationality,
  handedness, initial_seed, status, checked_in, final_rank, eliminated_after
)
SELECT
  c.id, c.competition_id, p.id,
  p.last_name, p.first_name, p.date_of_birth, p.gender, p.nationality,
  f.handedness, c.initial_seed, c.status,
  COALESCE(c.checked_in, 0), c.final_rank, c.eliminated_after
FROM competitors c
JOIN fencers f ON f.id = c.fencer_id
JOIN people  p ON p.id = f.person_id;

DROP TABLE competitors;
ALTER TABLE competitors_new RENAME TO competitors;

CREATE INDEX idx_competitors_comp   ON competitors(competition_id);
CREATE INDEX idx_competitors_person ON competitors(person_id);
CREATE UNIQUE INDEX ux_competitors_comp_person
  ON competitors(competition_id, person_id) WHERE person_id IS NOT NULL;
CREATE UNIQUE INDEX ux_competitors_comp_fie
  ON competitors(competition_id, fie_id)    WHERE fie_id    IS NOT NULL;

PRAGMA foreign_keys = ON;

-- ── 8. competitions ──────────────────────────────────────────────────────────

ALTER TABLE competitions ADD COLUMN fie_id           INTEGER;
ALTER TABLE competitions ADD COLUMN seeding_issuer   TEXT;
ALTER TABLE competitions ADD COLUMN seeding_category TEXT;

CREATE UNIQUE INDEX ux_competitions_fie_id
  ON competitions(fie_id) WHERE fie_id IS NOT NULL;

-- ── 9. tournaments ───────────────────────────────────────────────────────────

ALTER TABLE tournaments ADD COLUMN fie_season             TEXT;
ALTER TABLE tournaments ADD COLUMN organizing_federation  TEXT;
ALTER TABLE tournaments ADD COLUMN championship           TEXT;

-- ── 10. nocs — AIN neutral-athlete codes ─────────────────────────────────────
-- _AIN and AIN_ both appear in FIE exports for athletes competing under the
-- Individual Neutral Athlete status. Two distinct codes; exact semantics TBD.

INSERT OR IGNORE INTO nocs (code, country)
  VALUES ('_AIN', 'Individual Neutral Athlete');
INSERT OR IGNORE INTO nocs (code, country)
  VALUES ('AIN_', 'Individual Neutral Athlete (AIN)');
