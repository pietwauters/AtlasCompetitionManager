-- Migration 022 — Format parameters
-- Stores operator-supplied parameters for parametric competition formats
-- (e.g. advancement percentage for pool-de format).
ALTER TABLE competitions ADD COLUMN format_params TEXT;
