-- Competition day check-in flag.
-- 0 = not yet seen; 1 = fencer confirmed present at the venue.
-- Separate from competitors.status which tracks competition lifecycle.
ALTER TABLE competitors ADD COLUMN checked_in INTEGER NOT NULL DEFAULT 0;
