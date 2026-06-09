-- =============================================================================
-- Migration 016 — Team competition support
-- =============================================================================

ALTER TABLE competitions ADD COLUMN is_team INTEGER NOT NULL DEFAULT 0;

-- A team entered in a team competition.
CREATE TABLE teams (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  competition_id INTEGER NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
  name           TEXT    NOT NULL,
  club_id        INTEGER REFERENCES clubs(id) ON DELETE SET NULL,
  seed           INTEGER,
  status         TEXT    NOT NULL DEFAULT 'active',
  final_rank     INTEGER,
  UNIQUE(competition_id, name)
);

-- Competition-level roster. Each member is a competitor in this competition.
-- role: 'regular' (one of the 3 active fencers) or 'reserve' (the 4th).
-- Position numbers are match-specific — see team_match_orders.
CREATE TABLE team_members (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id       INTEGER NOT NULL REFERENCES teams(id)       ON DELETE CASCADE,
  competitor_id INTEGER NOT NULL REFERENCES competitors(id) ON DELETE RESTRICT,
  role          TEXT    NOT NULL DEFAULT 'regular',
  UNIQUE(team_id, competitor_id)
);

-- A match between two teams within a phase.
-- left_team_id / right_team_id are bracket slots set at tableau creation.
-- draw_winner_team_id = Team A (positions 1–3); the other team = Team B (positions 4–6).
-- draw_method: 'auto' (CMS random) or 'manual' (physical draw entered by director).
CREATE TABLE team_matches (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  phase_id             INTEGER NOT NULL REFERENCES phases(id) ON DELETE CASCADE,
  left_team_id         INTEGER REFERENCES teams(id) ON DELETE RESTRICT,
  right_team_id        INTEGER REFERENCES teams(id) ON DELETE RESTRICT,
  draw_winner_team_id  INTEGER REFERENCES teams(id) ON DELETE RESTRICT,
  draw_method          TEXT,
  left_score           INTEGER,
  right_score          INTEGER,
  winner_team_id       INTEGER REFERENCES teams(id) ON DELETE RESTRICT,
  status               TEXT    NOT NULL DEFAULT 'pending',
  match_order          INTEGER NOT NULL DEFAULT 0,
  de_round             INTEGER,
  tableau_position     INTEGER,
  winner_next_match_id INTEGER REFERENCES team_matches(id),
  winner_next_side     TEXT    CHECK (winner_next_side IN ('left','right')),
  loser_next_match_id  INTEGER REFERENCES team_matches(id),
  loser_next_side      TEXT    CHECK (loser_next_side IN ('left','right')),
  place_rank           INTEGER
);

-- Per-match fencer order submitted by each captain after the draw.
-- Team A (draw winner): positions 1, 2, 3.
-- Team B (draw loser):  positions 4, 5, 6.
CREATE TABLE team_match_orders (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  team_match_id INTEGER NOT NULL REFERENCES team_matches(id) ON DELETE CASCADE,
  team_id       INTEGER NOT NULL REFERENCES teams(id)        ON DELETE RESTRICT,
  competitor_id INTEGER NOT NULL REFERENCES competitors(id)  ON DELETE RESTRICT,
  position      INTEGER NOT NULL,
  UNIQUE(team_match_id, team_id, position),
  UNIQUE(team_match_id, competitor_id)
);

-- Individual relay within a team match.
-- Touches are deltas (scored in this relay only); cumulative is computed on read.
-- The actual competitor for each relay position is resolved at runtime from
-- team_match_orders + any active substitution.
CREATE TABLE relays (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  team_match_id INTEGER NOT NULL REFERENCES team_matches(id) ON DELETE CASCADE,
  relay_number  INTEGER NOT NULL,
  left_touches  INTEGER,
  right_touches INTEGER,
  target        INTEGER NOT NULL,
  time_expired  INTEGER NOT NULL DEFAULT 0,
  status        TEXT    NOT NULL DEFAULT 'pending',
  UNIQUE(team_match_id, relay_number)
);

-- Undo support for relay scoring.
CREATE TABLE relay_history (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  relay_id      INTEGER NOT NULL REFERENCES relays(id) ON DELETE CASCADE,
  left_touches  INTEGER,
  right_touches INTEGER,
  time_expired  INTEGER,
  status        TEXT,
  changed_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- In-match substitution: reserve replaces a regular fencer from a given relay onward.
-- UNIQUE enforces max 1 substitution per team per match.
CREATE TABLE team_match_substitutions (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  team_match_id            INTEGER NOT NULL REFERENCES team_matches(id) ON DELETE CASCADE,
  team_id                  INTEGER NOT NULL REFERENCES teams(id)        ON DELETE RESTRICT,
  position_replaced        INTEGER NOT NULL,
  original_competitor_id   INTEGER NOT NULL REFERENCES competitors(id)  ON DELETE RESTRICT,
  substitute_competitor_id INTEGER NOT NULL REFERENCES competitors(id)  ON DELETE RESTRICT,
  effective_from_relay     INTEGER NOT NULL,
  UNIQUE(team_match_id, team_id)
);

CREATE INDEX idx_teams_comp              ON teams(competition_id);
CREATE INDEX idx_team_members_team       ON team_members(team_id);
CREATE INDEX idx_team_matches_phase      ON team_matches(phase_id);
CREATE INDEX idx_team_match_orders_match ON team_match_orders(team_match_id);
CREATE INDEX idx_relays_match            ON relays(team_match_id, relay_number);
