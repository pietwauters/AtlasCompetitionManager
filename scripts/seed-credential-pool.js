'use strict';
// Run from the project root: node scripts/seed-credential-pool.js
//
// Idempotent first-time seeding of the scoresheet MQTT credential pool — skips if
// any credentials already exist. Shared by install.sh and update.sh so both stay
// in sync. For adding more credentials to an already-seeded pool, use
// scripts/top-up-credential-pool.js instead (that one is not idempotent by design).
require('../db/migrator').migrate();
const Pairing = require('../services/pairing');

const stats = Pairing.poolStats();
if (stats.total > 0) {
  console.log('Credential pool already provisioned, skipping.');
  process.exit(0);
}

const created = Pairing.createPoolBatch(10);
console.log(`Created ${created.length} scoresheet MQTT credential(s) in Atlas's own database.`);
console.log('Run scripts/sync-mosquitto-scoresheet-acl.sh to push them to Mosquitto.');
