-- Add bracket type to bouts, enabling placement (bronze, all-places-fenced)
-- and repechage bouts to coexist in the same phase as main-bracket bouts.
-- Default 'main' leaves all existing bouts unchanged.

ALTER TABLE bouts ADD COLUMN bracket TEXT NOT NULL DEFAULT 'main'
  CHECK (bracket IN ('main', 'repechage', 'placement'));
