-- Explicit routing pointers on bouts, enabling all-places-fenced and repechage
-- brackets without arithmetic-based next-round derivation.
-- NULL = terminal (no further routing needed).
-- place_rank: for terminal placement bouts only — the first place being contested
--   (winner gets place_rank, loser gets place_rank+1).

ALTER TABLE bouts ADD COLUMN winner_next_bout_id INTEGER REFERENCES bouts(id);
ALTER TABLE bouts ADD COLUMN winner_next_side     TEXT CHECK (winner_next_side IN ('left','right'));
ALTER TABLE bouts ADD COLUMN loser_next_bout_id  INTEGER REFERENCES bouts(id);
ALTER TABLE bouts ADD COLUMN loser_next_side      TEXT CHECK (loser_next_side IN ('left','right'));
ALTER TABLE bouts ADD COLUMN place_rank          INTEGER;
