'use strict';
// reset_database.js
// Drops the Atlas database and recreates an empty schema via migrations.
//
// !! WARNING: ALL DATA IS PERMANENTLY DELETED. This cannot be undone. !!
//
// Usage:
//   node scripts/reset_database.js
//
// You will be asked to type a confirmation phrase before anything is deleted.

const fs       = require('fs');
const path     = require('path');
const readline = require('readline');

const DB_PATH = path.join(__dirname, '..', 'data', 'atlas.db');
const REQUIRED_PHRASE = 'DELETE ALL ATLAS DATA';

// ---------------------------------------------------------------------------
// Check the DB file exists at all
// ---------------------------------------------------------------------------
if (!fs.existsSync(DB_PATH)) {
  console.log('No database found at', DB_PATH);
  console.log('Nothing to do.');
  process.exit(0);
}

const stats = fs.statSync(DB_PATH);
const sizeMb = (stats.size / 1024 / 1024).toFixed(2);

// ---------------------------------------------------------------------------
// Print the warning banner
// ---------------------------------------------------------------------------
console.log('');
console.log('╔══════════════════════════════════════════════════════════╗');
console.log('║                  !! DANGER ZONE !!                       ║');
console.log('╠══════════════════════════════════════════════════════════╣');
console.log('║  You are about to permanently delete the Atlas database. ║');
console.log('║                                                           ║');
console.log('║  This will erase:                                         ║');
console.log('║    • ALL people, fencers, referees and clubs              ║');
console.log('║    • ALL competitions, pools, bouts and results           ║');
console.log('║    • ALL OPP2 settings and pipeline configuration         ║');
console.log('║                                                           ║');
console.log('║  This action CANNOT be undone.                            ║');
console.log('╚══════════════════════════════════════════════════════════╝');
console.log('');
console.log(`  Database file : ${DB_PATH}`);
console.log(`  File size     : ${sizeMb} MB`);
console.log('');

// ---------------------------------------------------------------------------
// Require non-trivial confirmation phrase
// ---------------------------------------------------------------------------
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

rl.question(`  To confirm, type exactly:  ${REQUIRED_PHRASE}\n\n  > `, (answer) => {
  rl.close();

  if (answer.trim() !== REQUIRED_PHRASE) {
    console.log('');
    console.log('  Confirmation phrase did not match. Database NOT deleted.');
    console.log('');
    process.exit(1);
  }

  // -------------------------------------------------------------------------
  // Delete the database file (and WAL/SHM files if present)
  // -------------------------------------------------------------------------
  console.log('');
  console.log('  Confirmed. Deleting database...');

  for (const suffix of ['', '-wal', '-shm']) {
    const f = DB_PATH + suffix;
    if (fs.existsSync(f)) {
      fs.unlinkSync(f);
      console.log(`  Deleted: ${path.basename(f)}`);
    }
  }

  // -------------------------------------------------------------------------
  // Recreate empty schema by running migrations
  // -------------------------------------------------------------------------
  console.log('  Recreating empty schema...');
  try {
    require('../db/migrator').migrate();
    console.log('  Schema ready.');
  } catch (e) {
    console.error('  Migration failed:', e.message);
    process.exit(1);
  }

  console.log('');
  console.log('  ✓ Database reset complete. Atlas is now empty.');
  console.log('');
  console.log('  Next steps:');
  console.log('    Load test data : node scripts/seed_test_population.js');
  console.log('    Start server   : node server.js  (or: pm2 restart atlas)');
  console.log('');
});
