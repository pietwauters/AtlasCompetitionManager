-- migrate-004-strips-number.sql
ALTER TABLE strips ADD COLUMN strip_number INTEGER;
ALTER TABLE strips ADD COLUMN strip_number INTEGER UNIQUE;
-- Make name nullable (SQLite does not support DROP NOT NULL directly; workaround is required for existing data)
-- For new installs, update schema.sql manually.
CREATE UNIQUE INDEX IF NOT EXISTS idx_strips_strip_number ON strips(strip_number);

-- If you want to enforce NOT NULL/NULL changes, you must recreate the table. For now, we allow name to be NULL in code.

-- Existing rows: set strip_number to id for uniqueness
UPDATE strips SET strip_number = id WHERE strip_number IS NULL;
