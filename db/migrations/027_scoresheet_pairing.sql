-- Standalone e-scoresheet PWA pairing (docs/e-scoresheet-standalone-design.md §4).
-- An operator-issued, short-lived, single-use ticket exchanged for a bearer
-- token a paired device then holds indefinitely (until revoked).

CREATE TABLE pairing_tickets (
  id          INTEGER PRIMARY KEY,
  code        TEXT    NOT NULL,
  created_by  INTEGER NOT NULL REFERENCES users(id),
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  expires_at  TEXT    NOT NULL,
  redeemed_at TEXT
);

CREATE TABLE paired_devices (
  id           INTEGER PRIMARY KEY,
  device_id    TEXT    NOT NULL UNIQUE,
  device_label TEXT,
  token_hash   TEXT    NOT NULL,
  paired_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  revoked_at   TEXT
);
