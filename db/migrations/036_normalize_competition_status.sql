-- Migration 036 — Normalize competition.status to the two states the app
-- actually implements: active | archived.
--
-- The column comment in 001_initial_schema.sql still says "draft | active |
-- finished", a 3-state model migration 018 already collapsed for the common
-- path (competitions.create() has defaulted new rows to 'active' since
-- then). Two gaps survived that collapse:
--   - services/fieImport.js still hardcoded 'draft' on every FIE-imported
--     competition (fixed alongside this migration).
--   - a handful of rows already sitting at 'draft'/'finished' from before
--     018, which this migration sweeps up the same way 018 did.
-- 'finished' maps to 'archived' (the only terminal/hidden state the rest of
-- the app understands — see Competition.archive()), not 'active'.

UPDATE competitions SET status = 'active'   WHERE status = 'draft';
UPDATE competitions SET status = 'archived' WHERE status = 'finished';
