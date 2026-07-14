-- Supersedes 027's shared-credential/ticket-redeem model per the converged Tier B
-- design in docs/security-provisioning-discussion.md §4.5: unique-per-device MQTT
-- credentials, pre-generated in a batch, assigned by an operator action alone (no
-- network round-trip), delivered out-of-band via QR/manual entry. Neither table from
-- 027 has ever held real competition data, so they're dropped rather than migrated.

DROP TABLE paired_devices;
DROP TABLE pairing_tickets;

CREATE TABLE mqtt_credentials (
  id           INTEGER PRIMARY KEY,
  username     TEXT    NOT NULL UNIQUE,
  password     TEXT    NOT NULL,
  device_label TEXT,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  assigned_at  TEXT,
  revoked_at   TEXT
);
