-- Fencer's 1-based position within their pool (FIE serpentine slot order).
-- NULL for rows created before this migration; those still sort correctly by initial_seed.
ALTER TABLE pool_competitors ADD COLUMN pool_slot INTEGER;
