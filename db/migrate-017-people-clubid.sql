-- Migration: Add club_id to people, remove club string, and create clubs table if not exists
-- Run via: sqlite3 data/atlas.db < db/migrate-017-people-clubid.sql

-- 1. Create clubs table if not exists
CREATE TABLE IF NOT EXISTS clubs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  city TEXT,
  country TEXT
);

-- 2. Add club_id to people (nullable for migration)
ALTER TABLE people ADD COLUMN club_id INTEGER REFERENCES clubs(id);

-- 3. (Optional) Remove old club string column from people (SQLite does not support DROP COLUMN directly)
-- To fully remove, you must recreate the table. For now, keep both for migration.
-- -- Manual migration steps required to drop the old column if desired.

-- 4. (Optional) Backfill club_id from club string if needed (manual step)
-- UPDATE people SET club_id = (SELECT id FROM clubs WHERE clubs.name = people.club) WHERE club IS NOT NULL;

-- 5. (Optional) Set club_id NOT NULL if you want to enforce it after migration
-- ALTER TABLE people ALTER COLUMN club_id SET NOT NULL;
