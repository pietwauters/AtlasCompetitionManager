-- Migration 006: Add tournaments table and link competitions to tournaments

CREATE TABLE IF NOT EXISTS tournaments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    city TEXT NOT NULL,
    country TEXT NOT NULL, -- NOC code
    date_start DATE,
    date_end DATE,
    organizer TEXT,
    description TEXT,
    level TEXT, -- FIE, Zone, National, Local
    status TEXT NOT NULL DEFAULT 'open', -- open, closed, finished
    archived BOOLEAN NOT NULL DEFAULT 0
);

-- Add tournament_id and date to competitions (already present, skip if error)
-- ALTER TABLE competitions ADD COLUMN tournament_id INTEGER REFERENCES tournaments(id);
-- ALTER TABLE competitions ADD COLUMN date DATE;
