'use strict';
/**
 * Run all migration SQL files in order.
 * Each statement is executed individually; duplicate-column errors are silently
 * ignored so this script is safe to run multiple times.
 *
 * Usage:  node db/migrate.js
 */
const path = require('path');
const fs   = require('fs');
const db   = require('./db');

const migrationsDir = __dirname;
const files = fs.readdirSync(migrationsDir)
  .filter(f => /^migrate-\d+.*\.sql$/.test(f))
  .sort();

for (const file of files) {
  const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
  // Split on lines so inline comments don't bleed into the next statement
  const stmts = sql
    .split('\n')
    .map(l => l.replace(/--.*$/, '').trim())   // strip inline comments
    .join(' ')
    .split(';')
    .map(s => s.trim())
    .filter(Boolean);

  let applied = 0, skipped = 0;
  for (const stmt of stmts) {
    try {
      db.prepare(stmt).run();
      applied++;
    } catch (e) {
      if (e.message.includes('duplicate column')) skipped++;
      else throw e;
    }
  }
  console.log(`${file}: applied=${applied} skipped=${skipped}`);
}

console.log('All migrations done.');
