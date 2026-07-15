-- Allow tier_a_certificates.role = 'software' for exactly one purpose: Atlas's own
-- OPP2 client authenticating to the broker with its own Tier A client certificate
-- (services/provisioning.js's issueCmsCertificate), instead of connecting anonymously
-- and relying on the backward-compat anonymous `topic write openpiste/+/software/#`
-- grant — which also means any other anonymous client on the network could otherwise
-- spoof software/* messages the apparatus is spec-required to trust (e.g. software/clock).
--
-- Deliberately does NOT touch tier_a_tickets.role's CHECK constraint, which still
-- excludes 'software' — that's the real invariant (no operator-issued ticket can ever
-- grant an external device the software role). The CMS's own certificate bypasses the
-- ticket flow entirely (Atlas already holds the CA private key), so this migration only
-- needs to let the *record* of that self-issued certificate be stored.
--
-- SQLite has no ALTER TABLE for CHECK constraints — rebuild the table.

CREATE TABLE tier_a_certificates_new (
  id           INTEGER PRIMARY KEY,
  serial       TEXT    NOT NULL UNIQUE,
  device_id    TEXT    NOT NULL,
  role         TEXT    NOT NULL CHECK(role IN ('apparatus', 'scoresheet', 'remote', 'var', 'software')),
  device_label TEXT,
  cert_pem     TEXT    NOT NULL,
  issued_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  revoked_at   TEXT
);

INSERT INTO tier_a_certificates_new
  SELECT id, serial, device_id, role, device_label, cert_pem, issued_at, revoked_at
  FROM tier_a_certificates;

DROP TABLE tier_a_certificates;
ALTER TABLE tier_a_certificates_new RENAME TO tier_a_certificates;
