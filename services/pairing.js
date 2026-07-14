'use strict';
const crypto = require('crypto');
const db     = require('../db');

const stmtInsertCredential = db.prepare(`
  INSERT INTO mqtt_credentials (username, password) VALUES (@username, @password)
`);
const stmtFindById = db.prepare('SELECT * FROM mqtt_credentials WHERE id = ?');
const stmtAssignNext = db.prepare(`
  UPDATE mqtt_credentials
  SET device_label = @deviceLabel, assigned_at = datetime('now')
  WHERE id = (
    SELECT id FROM mqtt_credentials
    WHERE assigned_at IS NULL AND revoked_at IS NULL
    ORDER BY id LIMIT 1
  )
  RETURNING *
`);
const stmtList = db.prepare(`
  SELECT id, username, device_label, created_at, assigned_at, revoked_at
  FROM mqtt_credentials ORDER BY assigned_at IS NULL, assigned_at DESC, id DESC
`);
const stmtRevoke = db.prepare(`
  UPDATE mqtt_credentials SET revoked_at = datetime('now') WHERE id = ?
`);
const stmtPoolStats = db.prepare(`
  SELECT
    COUNT(*) AS total,
    SUM(CASE WHEN assigned_at IS NULL AND revoked_at IS NULL THEN 1 ELSE 0 END) AS free,
    SUM(CASE WHEN assigned_at IS NOT NULL AND revoked_at IS NULL THEN 1 ELSE 0 END) AS assigned,
    SUM(CASE WHEN revoked_at IS NOT NULL THEN 1 ELSE 0 END) AS revoked
  FROM mqtt_credentials
`);

function randomUsername() {
  return `escoresheet_${crypto.randomBytes(4).toString('hex')}`;
}

function randomPassword() {
  return crypto.randomBytes(24).toString('hex');
}

const Pairing = {
  // Broker-side batch generation (scripts/top-up-credential-pool.js). Atlas-DB only —
  // pushing these out to Mosquitto is a separate, sudo-gated step
  // (scripts/sync-mosquitto-scoresheet-acl.sh).
  createPoolBatch(count) {
    const created = [];
    const insertBatch = db.transaction((n) => {
      for (let i = 0; i < n; i++) {
        const username = randomUsername();
        const password = randomPassword();
        stmtInsertCredential.run({ username, password });
        created.push(username);
      }
    });
    insertBatch(count);
    return created;
  },

  // Operator side — no network round-trip to the device at all (§4.5 of
  // docs/security-provisioning-discussion.md): picking a free pooled credential and
  // labelling it *is* pairing. Returns null if the pool is exhausted.
  assignCredential(deviceLabel) {
    return stmtAssignNext.get({ deviceLabel: deviceLabel || null }) || null;
  },

  listCredentials() {
    return stmtList.all();
  },

  // Re-display an already-assigned, non-revoked credential's secret (e.g. re-pairing a
  // device that lost its local storage) without burning a new pool slot.
  revealCredential(id) {
    const row = stmtFindById.get(id);
    if (!row || row.revoked_at || !row.assigned_at) return null;
    return row;
  },

  revokeCredential(id) {
    stmtRevoke.run(id);
    return stmtFindById.get(id);
  },

  poolStats() {
    const row = stmtPoolStats.get();
    return {
      total: row.total || 0,
      free: row.free || 0,
      assigned: row.assigned || 0,
      revoked: row.revoked || 0,
    };
  },
};

module.exports = Pairing;
