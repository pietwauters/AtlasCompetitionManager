-- Application layer enforces case-insensitive uniqueness via findByName (COLLATE NOCASE).
-- This index blocks exact-case duplicates at the DB level as a secondary guard.
CREATE UNIQUE INDEX IF NOT EXISTS idx_clubs_name ON clubs (name);
