-- Migration 009: Add tournament_id and date to competitions

ALTER TABLE competitions ADD COLUMN tournament_id INTEGER REFERENCES tournaments(id);
ALTER TABLE competitions ADD COLUMN date DATE;
