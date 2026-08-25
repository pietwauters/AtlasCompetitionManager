-- Adds a 'virtual' pipeline_slots type — a placeholder entry a director can add
-- to a strip's queue for a competition + format stage that has no real
-- pool/phase yet (services/pipelineVirtualSlots.js fills it in automatically
-- once the real phase is created). SQLite can't ALTER a CHECK constraint, so
-- this rebuilds the table exactly as migrations 012/017 already did, carrying
-- every existing column forward unchanged and appending four new nullable
-- virtual_* columns.
--
-- Verified safe against the live DB's current inbound FKs
-- (pipeline_slot_officials.slot_id, pipeline_slots.conflict_paired_slot_id
-- self-reference, schedule_plan_slots.pipeline_slot_id) before writing this:
-- SQLite does not enforce inbound-FK integrity at DROP TABLE time, only at
-- row-level insert/update, and id is preserved 1:1 below, so no dangling
-- reference is created.

CREATE TABLE pipeline_slots_new (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  strip_id                 INTEGER NOT NULL REFERENCES strips(id)         ON DELETE CASCADE,
  slot_order               INTEGER NOT NULL,
  type                     TEXT    NOT NULL CHECK (type IN ('pool', 'de', 'team_match', 'virtual')),
  pool_id                  INTEGER REFERENCES pools(id)                   ON DELETE CASCADE,
  phase_id                 INTEGER REFERENCES phases(id)                  ON DELETE CASCADE,
  team_match_id            INTEGER REFERENCES team_matches(id)            ON DELETE SET NULL,
  bracket                  TEXT    CHECK (bracket IN ('main', 'repechage', 'placement')),
  tableau                  INTEGER,
  partition                TEXT    NOT NULL DEFAULT 'full',
  scheduled_start          TEXT,
  minutes_per_bout         INTEGER,
  referee_id               INTEGER REFERENCES referees(id)                ON DELETE SET NULL,
  status                   TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'done')),
  de_round                 INTEGER,
  conflict_referee_id      INTEGER REFERENCES referees(id)                ON DELETE SET NULL,
  conflict_original_start  TEXT,
  conflict_paired_slot_id  INTEGER REFERENCES pipeline_slots(id)          ON DELETE SET NULL,
  -- Only meaningful when type = 'virtual'; NULL for every other type. Not
  -- reused as a general "which competition" column for real slots — that
  -- stays derived via pool/phase/team_match, on purpose (see
  -- services/pipelineRosters.js's kiosk-exclusion note in
  -- services/pipelineSlots.js's enrichment query).
  virtual_competition_id   INTEGER REFERENCES competitions(id)            ON DELETE CASCADE,
  virtual_format_stage_id  TEXT,
  virtual_phase_type       TEXT CHECK (virtual_phase_type IN ('pool', 'de')),
  virtual_label            TEXT,
  UNIQUE (strip_id, slot_order)
);

INSERT INTO pipeline_slots_new
  (id, strip_id, slot_order, type, pool_id, phase_id, team_match_id,
   bracket, tableau, partition,
   scheduled_start, minutes_per_bout, referee_id, status,
   de_round, conflict_referee_id, conflict_original_start, conflict_paired_slot_id)
SELECT
  id, strip_id, slot_order, type, pool_id, phase_id, team_match_id,
  bracket, tableau, partition,
  scheduled_start, minutes_per_bout, referee_id, status,
  de_round, conflict_referee_id, conflict_original_start, conflict_paired_slot_id
FROM pipeline_slots;

DROP TABLE pipeline_slots;
ALTER TABLE pipeline_slots_new RENAME TO pipeline_slots;
