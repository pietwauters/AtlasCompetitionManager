-- Migration 018 — Collapse draft/pending into active
-- Competitions were created as 'draft' and required an explicit activate step.
-- Phases were created as 'pending' and required an explicit activate step.
-- Both steps are now automatic: new records start as 'active'.
-- This migration brings existing data in line.

UPDATE competitions SET status = 'active' WHERE status = 'draft';
UPDATE phases        SET status = 'active' WHERE status = 'pending';
UPDATE pools         SET status = 'active' WHERE status = 'pending';
