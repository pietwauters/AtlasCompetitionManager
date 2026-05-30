// Backfill competitors table for all competition_fencers
// Run with: node backfill_competitors.js

const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, 'data', 'atlas.db');
const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const competitionFencers = db.prepare(`
  SELECT cf.*, f.initial_seed, f.weapons, f.licence, f.handedness, f.final_rank, f.personId
  FROM competition_fencers cf
  JOIN fencers f ON f.id = cf.fencerId
`).all();

const insertCompetitor = db.prepare(`
  INSERT INTO competitors (
    competition_id, name, first_name, last_name, date_of_birth, gender, weapons, licence, handedness, club, nationality, initial_seed, status, final_rank
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const getPerson = db.prepare(`SELECT * FROM people WHERE id = ?`);

let inserted = 0;
for (const cf of competitionFencers) {
  const person = cf.personId ? getPerson.get(cf.personId) : null;
  const name = person ? `${person.firstName || ''} ${person.lastName || ''}`.trim() : `Fencer ${cf.fencerId}`;
  insertCompetitor.run(
    cf.competitionId,
    name,
    person ? person.firstName : null,
    person ? person.lastName : null,
    person ? person.birthdate : null,
    person ? person.gender : null,
    cf.weapons,
    cf.licence,
    cf.handedness,
    null, // club
    person ? person.nationality : null,
    cf.initial_seed,
    cf.status,
    cf.final_rank
  );
  inserted++;
}

console.log(`Inserted ${inserted} competitors.`);