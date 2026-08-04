-- Migration 037 — Correct a mistake made in migration 036.
--
-- 036 treated competitions.status='finished' as legacy/vestigial data left over
-- from before migration 018 collapsed the old draft/pending model, and folded it
-- into 'archived'. That was wrong: 'finished' is a real, currently-used state —
-- it's the "closed" competition written by competition-detail.html's
-- "Close competition" button (see commit 53f2e47, 2026-08-03) and read back by
-- its "Reopen competition" button and several `x-show` guards on that page.
-- 036 only affected one row (competition id 8, "Test Teams"), which this
-- migration restores.

UPDATE competitions SET status = 'finished' WHERE id = 8 AND status = 'archived';
