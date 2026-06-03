-- Users and authentication
-- Replaces the earlier ad-hoc users table (wrong schema, no data to preserve).
-- Roles: admin | director | assistant | referee
-- Referees must be linked to a people record (person_id NOT NULL).
-- Directors and Admins may optionally link to a people record.

DROP TABLE IF EXISTS users;

CREATE TABLE users (
  id               INTEGER PRIMARY KEY,
  person_id        INTEGER REFERENCES people(id) ON DELETE SET NULL,
  role             TEXT    NOT NULL CHECK(role IN ('admin','director','assistant','referee')),
  username         TEXT    NOT NULL UNIQUE,
  user_token       TEXT    NOT NULL UNIQUE,  -- opaque token encoded in QR code
  pin_hash         TEXT,                     -- bcrypt hash; NULL until first set
  force_pin_change INTEGER NOT NULL DEFAULT 1,
  created_at       TEXT    NOT NULL DEFAULT (datetime('now')),
  last_login_at    TEXT
);

-- Personalised read-only view token (fencer / coach self-service)
-- SQLite does not allow UNIQUE on ALTER TABLE ADD COLUMN; use a partial index instead.
ALTER TABLE people ADD COLUMN view_token TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS people_view_token ON people(view_token) WHERE view_token IS NOT NULL;

-- Session store (ephemeral — not migrated between installs)
CREATE TABLE IF NOT EXISTS sessions (
  sid        TEXT    PRIMARY KEY,
  sess       TEXT    NOT NULL,
  expired_at INTEGER NOT NULL  -- Unix timestamp
);
CREATE INDEX IF NOT EXISTS sessions_expired_at ON sessions(expired_at);

-- Corrections made by Assistants that require Director/Admin review
CREATE TABLE IF NOT EXISTS flagged_corrections (
  id           INTEGER PRIMARY KEY,
  person_id    INTEGER NOT NULL REFERENCES people(id)  ON DELETE CASCADE,
  changed_by   INTEGER NOT NULL REFERENCES users(id),
  field        TEXT    NOT NULL,
  old_value    TEXT,
  new_value    TEXT,
  changed_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  reviewed_by  INTEGER REFERENCES users(id),
  reviewed_at  TEXT,
  status       TEXT    NOT NULL DEFAULT 'pending'
                       CHECK(status IN ('pending','acknowledged','reverted'))
);
