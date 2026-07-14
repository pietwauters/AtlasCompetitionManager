'use strict';
// Run from the project root: node scripts/top-up-credential-pool.js [count=10]
//
// Atlas-DB side only (docs/security-provisioning-discussion.md §4.5) — generates new
// unique-per-device MQTT credentials and stores them in mqtt_credentials, unassigned.
// Does NOT touch Mosquitto. Run scripts/sync-mosquitto-scoresheet-acl.sh afterward to
// push the new credentials out to the broker.
require('../db/migrator').migrate();
const Pairing = require('../services/pairing');

const count = Number(process.argv[2]) || 10;
const created = Pairing.createPoolBatch(count);
const stats = Pairing.poolStats();

console.log(`Added ${created.length} credential(s) to the pool:`);
created.forEach((username) => console.log(`  ${username}`));
console.log('');
console.log(`Pool now: ${stats.total} total, ${stats.free} free, ${stats.assigned} assigned, ${stats.revoked} revoked.`);
console.log('');
console.log('Next: run scripts/sync-mosquitto-scoresheet-acl.sh on the broker host to');
console.log('push these new credentials to Mosquitto.');
