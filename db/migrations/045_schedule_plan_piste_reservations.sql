-- Competition-exclusive piste reservations (2026-08-28 discussion): a shared
-- pool of pistes (e.g. 8 colored/video pistes) is normally open to any
-- eligible competition's DE round, but a director sometimes wants to split
-- that pool between two concurrently-running competitions once their
-- brackets shrink past a certain point, so neither one starves the other of
-- pistes and both reach their later rounds at a similar pace. Plan-scoped
-- (not a permanent strips property) since which competitions need splitting
-- is a per-tournament fact, not a physical trait of the piste. DE-only —
-- pools always want maximum piste availability, no narrowing there.
-- from_tableau_size is nullable: NULL means the reservation is active from
-- the very start; otherwise it only kicks in once a round's tableau shrinks
-- to that size or below — set per-strip individually (2026-08-28: "yes
-- individually, especially for smaller local competitions"), not plan-wide.
-- A strip can only be reserved for one competition at a time within a plan.
CREATE TABLE schedule_plan_piste_reservations (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  schedule_plan_id   INTEGER NOT NULL REFERENCES schedule_plans(id) ON DELETE CASCADE,
  strip_id           INTEGER NOT NULL REFERENCES strips(id) ON DELETE CASCADE,
  competition_id     INTEGER NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
  from_tableau_size  INTEGER,
  UNIQUE (schedule_plan_id, strip_id)
);
