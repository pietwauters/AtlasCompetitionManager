-- Lets a director declare which pistes are eligible for which kind of work
-- (e.g. "Podium is only for semi-finals/finals", "these colored pistes never
-- host pools"), and let different competitions within one tournament start
-- at different times in the schedule planner (e.g. Sabre starting later than
-- Foil/Epee because it has fewer fencers and shorter bouts). Both were raised
-- together while extending the "Phase 1" schedule-planner tool for more
-- realistic scheduling.
--
-- Defaults preserve today's behavior exactly for every existing strip: fully
-- open to both pools and DE, no round restriction.

ALTER TABLE strips ADD COLUMN pools_allowed  INTEGER NOT NULL DEFAULT 1;
ALTER TABLE strips ADD COLUMN de_allowed     INTEGER NOT NULL DEFAULT 1;
-- Largest DE tableau size (i.e. earliest round) this piste may host, when
-- de_allowed. NULL = no restriction, any round including the first. E.g. a
-- podium piste used only for the semis/final of a straight tableau:
-- max_de_tableau = 4.
ALTER TABLE strips ADD COLUMN max_de_tableau INTEGER;

-- One optional start-time override per (plan, competition) — falls back to
-- schedule_plans.day_start when no row exists for a given competition.
CREATE TABLE schedule_plan_competition_starts (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  schedule_plan_id  INTEGER NOT NULL REFERENCES schedule_plans(id)   ON DELETE CASCADE,
  competition_id    INTEGER NOT NULL REFERENCES competitions(id)     ON DELETE CASCADE,
  day_start         TEXT NOT NULL,
  UNIQUE (schedule_plan_id, competition_id)
);
