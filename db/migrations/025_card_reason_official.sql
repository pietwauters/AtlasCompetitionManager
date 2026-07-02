-- Attribute each card reason to the specific official who made the call
-- (referee, second referee, or an assessor) — not just who's assigned to
-- the bout in general. Both columns are nullable: older annotations, or
-- ones recorded when only a single referee is assigned, carry no
-- attribution.
ALTER TABLE card_reasons ADD COLUMN official_referee_id INTEGER REFERENCES referees(id) ON DELETE SET NULL;
ALTER TABLE card_reasons ADD COLUMN official_role TEXT;
