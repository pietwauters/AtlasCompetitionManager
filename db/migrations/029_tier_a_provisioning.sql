-- Tier A (certificate-based) provisioning, docs/level2.md §30.5. Complements 028's
-- Tier B (username/password) pool with the certificate flow for embedded/native
-- components (the real scoring apparatus firmware) that can present a TLS client
-- certificate at connection time. See docs/security-provisioning-discussion.md §4.4.

-- Operator-issued, short-lived, single-use tickets — same shape as the superseded
-- Tier B pairing_tickets table (028), scoped by role since a Tier A ticket grants
-- exactly one publisher role (never "software" — the CMS is the provisioning
-- authority, not something provisioned).
CREATE TABLE tier_a_tickets (
  id          INTEGER PRIMARY KEY,
  code        TEXT    NOT NULL,
  role        TEXT    NOT NULL CHECK(role IN ('apparatus', 'scoresheet', 'remote', 'var')),
  device_label TEXT,
  created_by  INTEGER NOT NULL REFERENCES users(id),
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  expires_at  TEXT    NOT NULL,
  redeemed_at TEXT
);

-- One row per issued certificate. `serial` is the certificate's serial number (hex,
-- as assigned by openssl) — the join key against data/tls/ca-db/index.txt, which is
-- the actual source of truth for CRL generation (openssl ca -gencrl reads the index,
-- not this table); this table is Atlas's own operator-facing record of the same facts.
CREATE TABLE tier_a_certificates (
  id           INTEGER PRIMARY KEY,
  serial       TEXT    NOT NULL UNIQUE,
  device_id    TEXT    NOT NULL,
  role         TEXT    NOT NULL CHECK(role IN ('apparatus', 'scoresheet', 'remote', 'var')),
  device_label TEXT,
  cert_pem     TEXT    NOT NULL,
  issued_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  revoked_at   TEXT
);
