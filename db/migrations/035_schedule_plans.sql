-- Tournament schedule planner (Phase 1 — estimation/what-if tool). Lets a
-- director lay out an estimated piste/time schedule and get an early read on
-- referee sufficiency before real competitors/phases exist. Deliberately
-- decoupled from pipeline_slots/phases/pools — a plan's stages/slots are
-- estimates, not live bout-routing state. phase_id/pipeline_slot_id are
-- nullable forward-compat links for a later (not-yet-designed) pass that
-- lets the plan gradually reconcile with real competition-day data; nothing
-- populates them yet.

CREATE TABLE schedule_plans (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  tournament_id           INTEGER NOT NULL UNIQUE REFERENCES tournaments(id) ON DELETE CASCADE,
  day_start               TEXT NOT NULL DEFAULT '08:00',
  abstract_piste_count    INTEGER NOT NULL DEFAULT 0,
  abstract_referee_count  INTEGER NOT NULL DEFAULT 0,
  created_at              TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at              TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One row per stage of a competition within the plan. For a format-driven
-- competition, format_stage_id matches format.stages[].id (see
-- services/formats.js) and rows are (re)created by
-- Schedule.syncStagesFromFormat; for a non-format competition, format_stage_id
-- is NULL and the director adds/edits stages by hand.
CREATE TABLE schedule_plan_stages (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  schedule_plan_id   INTEGER NOT NULL REFERENCES schedule_plans(id) ON DELETE CASCADE,
  competition_id     INTEGER NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
  format_stage_id    TEXT,
  label              TEXT NOT NULL,
  stage_order        INTEGER NOT NULL,
  depends_on         TEXT,
  phase_type         TEXT NOT NULL CHECK (phase_type IN ('pool','de')),
  rule_doc           TEXT NOT NULL,     -- filename in rules/ — from format.stages[].rule when format-driven,
                                         -- else director-picked (defaults to pool-standard.json/de-standard.json)
  estimated_n        INTEGER NOT NULL DEFAULT 0,
  pistes_assigned    INTEGER NOT NULL DEFAULT 1,
  computed_json       TEXT,
  phase_id            INTEGER REFERENCES phases(id) ON DELETE SET NULL,
  UNIQUE (schedule_plan_id, competition_id, stage_order)
);
CREATE INDEX idx_schedule_plan_stages_plan ON schedule_plan_stages(schedule_plan_id);

-- The solver's (or a manual edit's) layout output. One row per
-- (stage, piste) — a stage assigned pistes_assigned = 3 produces 3 rows, all
-- sharing the same scheduled_start/scheduled_end, one per occupied piste.
CREATE TABLE schedule_plan_slots (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  schedule_plan_stage_id   INTEGER NOT NULL REFERENCES schedule_plan_stages(id) ON DELETE CASCADE,
  strip_id                 INTEGER REFERENCES strips(id) ON DELETE SET NULL,
  abstract_piste_index     INTEGER,
  scheduled_start          TEXT NOT NULL,
  scheduled_end            TEXT NOT NULL,
  pipeline_slot_id         INTEGER REFERENCES pipeline_slots(id) ON DELETE SET NULL,
  CHECK ((strip_id IS NULL) <> (abstract_piste_index IS NULL))
);
CREATE INDEX idx_schedule_plan_slots_stage ON schedule_plan_slots(schedule_plan_stage_id);
