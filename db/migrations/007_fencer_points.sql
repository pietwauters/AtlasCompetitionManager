-- fencers.ranking convention (documented here; field added in 001):
--   Position on a national or club ranking list. Lower = better (1 = top-ranked).
--   Used by autoSeed() to assign initial competition seeds.
--   Set manually or via CSV import. Has no weapon context — one number per fencer.
--
-- fencers.points: accumulated competition points.
--   More points = higher standing. Intended for future automatic ranking
--   recalculation based on results across multiple competitions.
--   Not used for seeding yet; stored now to be ready for that feature.

ALTER TABLE fencers ADD COLUMN points INTEGER;
