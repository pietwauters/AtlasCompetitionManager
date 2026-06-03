'use strict';
const db     = require('../db');
const Club   = require('./clubs');
const Person = require('./people');
const Fencer = require('./fencers');
const Csv    = require('./csv');

// Expected CSV columns (first_name and last_name are required; all others optional):
//   first_name, last_name, date_of_birth, gender, nationality,
//   club, licence, weapons, handedness, ranking
//
// Conflict detection (determines update vs. create):
//   1. If licence is provided → match on licence
//   2. Otherwise             → match on first_name + last_name + date_of_birth

function parseWeaponsFromCsv(raw) {
  if (!raw || !raw.trim()) return null;
  return raw.split(',').map(w => w.trim()).filter(Boolean);
}

function importRow(row) {
  let club_id = null;
  if (row.club && row.club.trim()) {
    club_id = Club.findOrCreate(row.club.trim()).id;
  }

  const personData = {
    first_name:    row.first_name?.trim()    || null,
    last_name:     row.last_name?.trim()     || null,
    date_of_birth: row.date_of_birth?.trim() || null,
    gender:        row.gender?.trim()        || null,
    nationality:   row.nationality?.trim()   || null,
    club_id,
  };

  const fencerData = {
    licence:    row.licence?.trim()    || null,
    weapons:    parseWeaponsFromCsv(row.weapons),
    handedness: row.handedness?.trim() || null,
    ranking:    row.ranking ? parseInt(row.ranking, 10) || null : null,
    points:     row.points  ? parseInt(row.points,  10) || null : null,
  };

  // --- Try to find existing record ---

  // Match by licence (most reliable)
  if (fencerData.licence) {
    const existing = Fencer.findByLicence(fencerData.licence);
    if (existing) {
      Person.update(existing.id, personData);
      Fencer.update(existing.fencer_id, fencerData);
      return 'updated';
    }
  }

  // Match by name + date of birth
  const byName = db.prepare(`
    SELECT id FROM people
    WHERE first_name = ? COLLATE NOCASE
      AND last_name  = ? COLLATE NOCASE
      AND (date_of_birth = ? OR (date_of_birth IS NULL AND ? IS NULL))
  `).get(personData.first_name, personData.last_name, personData.date_of_birth, personData.date_of_birth);

  if (byName) {
    Person.update(byName.id, personData);
    const existingFencer = Fencer.findByPersonId(byName.id);
    if (existingFencer) Fencer.update(existingFencer.fencer_id, fencerData);
    else                Fencer.create(byName.id, fencerData);
    return 'updated';
  }

  // Create new person + fencer profile
  const person = Person.create(personData);
  Fencer.create(person.id, fencerData);
  return 'created';
}

const PersonImport = {
  // Parse CSV text and import all rows. Returns a summary.
  fromCsv(csvText) {
    const rows = Csv.parse(csvText);
    const result = { created: 0, updated: 0, errors: [] };
    if (!rows.length) return result;

    const run = db.transaction(() => {
      rows.forEach((row, i) => {
        if (!row.first_name || !row.last_name) {
          result.errors.push({ line: i + 2, error: 'first_name and last_name are required' });
          return;
        }
        try {
          const action = importRow(row);
          result[action]++;
        } catch (e) {
          result.errors.push({ line: i + 2, error: e.message });
        }
      });
    });

    run();
    return result;
  },
};

module.exports = PersonImport;
