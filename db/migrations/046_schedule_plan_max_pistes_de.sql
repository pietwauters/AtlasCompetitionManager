-- Referee-driven hard cap on simultaneous DE piste usage (2026-08-28
-- discussion): once opportunistic piste-widening (migration-less,
-- 2026-08-28 solver change) lets a round grab every free/eligible piste,
-- the real limiting resource stops being pistes and becomes referees — a
-- round can't actually run on more pistes than there are qualified
-- referees to staff them, regardless of how many pistes are physically
-- free. DE only (pools already have a separate referee-shortfall analysis
-- in schedulePlanReferees.js). Plan-wide default, per-stage override —
-- same pattern as default_max_flights_de/schedule_plan_stages.max_flights.
-- NULL everywhere (the default) means no cap, fully backward-compatible.
ALTER TABLE schedule_plans ADD COLUMN default_max_pistes_de INTEGER;
ALTER TABLE schedule_plan_stages ADD COLUMN max_pistes INTEGER;
