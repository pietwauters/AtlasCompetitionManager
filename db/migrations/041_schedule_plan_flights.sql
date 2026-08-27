-- "Never use more pistes than needed to stay within a maximum number of
-- flights" — a director thinks in terms of "how many rounds of bouts am I
-- willing to run", not "how many pistes should I assign"; the piste count
-- for a stage/DE-round becomes *derived* from this cap (ceil(work / cap))
-- instead of a number picked directly. Plan-wide default per phase type,
-- overridable per stage; NULL everywhere (the default for every existing
-- row) falls all the way back to today's fixed pistes_assigned behavior —
-- fully backward-compatible.

ALTER TABLE schedule_plans ADD COLUMN default_max_flights_pool INTEGER;
ALTER TABLE schedule_plans ADD COLUMN default_max_flights_de   INTEGER;

ALTER TABLE schedule_plan_stages ADD COLUMN max_flights INTEGER;
