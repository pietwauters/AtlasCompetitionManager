-- Per-round scheduling overrides (2026-08-28 discussion): a director may
-- need a specific round/phase to start at a fixed clock time (broadcast,
-- VIP guests, a different venue for the final) and/or need extra buffer
-- after a specific round/phase beyond the automatic fencer-rest calculation
-- (room changes, results verification, ceremony setup). Keyed by
-- (schedule_plan_stage_id, tableau_size) — tableau_size is the real DE
-- round selector (T4, T8, ...), stable across re-estimation even if the
-- overall bracket size later shifts; 0 is the sentinel for "the stage's own
-- single unit" (a pool phase, which never explodes into rounds the way a
-- DE stage does). Either column may be set independently; both NULL is a
-- no-op row (harmless, not worth guarding against).
CREATE TABLE schedule_plan_round_overrides (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  schedule_plan_stage_id  INTEGER NOT NULL REFERENCES schedule_plan_stages(id) ON DELETE CASCADE,
  tableau_size            INTEGER NOT NULL DEFAULT 0,
  fixed_start             TEXT,
  buffer_after_minutes    INTEGER,
  UNIQUE (schedule_plan_stage_id, tableau_size)
);
