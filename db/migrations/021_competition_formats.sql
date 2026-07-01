-- =============================================================================
-- Migration 021 — Competition formats
-- Adds support for predefined multi-phase competition formats (e.g. Grand Prix).
-- format_id on competitions: references a JSON file in formats/
-- format_cohort on competitors: cohort assigned by the format engine
--   (initial_exempt | pool_exempt | de_survivors | null)
-- format_stage on phases: which stage in the format this phase implements
-- =============================================================================

ALTER TABLE competitions ADD COLUMN format_id TEXT;
ALTER TABLE competitors  ADD COLUMN format_cohort TEXT;
ALTER TABLE phases        ADD COLUMN format_stage  TEXT;
